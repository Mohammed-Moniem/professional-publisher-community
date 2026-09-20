import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OAuth } from "../src/oauth.js";
import { Store } from "../src/store.js";
import type { Vault, Credentials } from "../src/keychain.js";
class MemoryVault implements Vault {
  values = new Map<string, Credentials>();
  async get(id: string) {
    return this.values.get(id);
  }
  async set(id: string, v: Credentials) {
    this.values.set(id, v);
  }
  async delete(id: string) {
    this.values.delete(id);
  }
}
const port = 53683,
  base = `http://127.0.0.1:${port}`;
async function setup(t: any, fetcher: typeof fetch) {
  const root = await mkdtemp(join(tmpdir(), "oauth-test-"));
  const store = new Store(root);
  const vault = new MemoryVault();
  const oauth = new OAuth(store, vault, fetcher, port);
  t.after(async () => {
    await oauth.close();
    await rm(root, { recursive: true, force: true });
  });
  const start = await oauth.start("test", "personal");
  return { store, vault, oauth, start };
}
async function submit(start: any, origin = base) {
  const csrf = new URL(start.setupUrl).searchParams.get("session")!;
  return fetch(base + "/connect", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: origin,
    },
    body: new URLSearchParams({
      csrf,
      clientId: "test-client",
      clientSecret: "DO-NOT-LEAK-SECRET",
    }),
    redirect: "manual",
  });
}
test("disconnect tombstone blocks an in-flight OAuth callback from restoring access", async (t) => {
  const f = await setup(t, async (u) => {
    if (String(u).endsWith("accessToken"))
      return Response.json({ access_token: "synthetic", expires_in: 3600 });
    if (String(u).endsWith("introspectToken"))
      return Response.json({
        active: true,
        scope: "openid,profile,w_member_social",
        expires_at: Date.now() / 1000 + 3600,
      });
    await f.store.write("disconnections", "test", { at: Date.now() });
    return Response.json({ sub: "synthetic", name: "Synthetic" });
  });
  const redirect = await submit(f.start),
    auth = new URL(redirect.headers.get("location")!);
  const callback = await fetch(
    base +
      "/callback?" +
      new URLSearchParams({
        state: auth.searchParams.get("state")!,
        code: "fixture",
      }),
  );
  assert.equal(callback.status, 400);
  assert.equal(await f.store.read("connections", "test"), undefined);
  assert.equal(await f.vault.get("test"), undefined);
});
test("OAuth setup validates origin/state, introspects scopes and stores secrets only in vault", async (t) => {
  let calls = 0;
  const f = await setup(t, async (u, i) => {
    calls++;
    if (String(u).endsWith("accessToken")) {
      assert.equal(
        new URLSearchParams(i?.body as any).get("client_secret"),
        "DO-NOT-LEAK-SECRET",
      );
      return Response.json({
        access_token: "DO-NOT-LEAK-TOKEN",
        expires_in: 3600,
      });
    }
    if (String(u).endsWith("introspectToken"))
      return Response.json({
        active: true,
        scope: "openid,profile,w_member_social",
        expires_at: Date.now() / 1000 + 3600,
      });
    return Response.json({ sub: "member-id", name: "Member" });
  });
  const pageResponse = await fetch(f.start.setupUrl);
  assert.equal(pageResponse.headers.get("referrer-policy"), "same-origin");
  assert.match(
    pageResponse.headers.get("content-security-policy")!,
    /form-action 'self' https:\/\/www.linkedin.com/,
  );
  const page = await pageResponse.text();
  assert.match(page, /Client secret/);
  assert.doesNotMatch(page, /DO-NOT-LEAK/);
  assert.equal((await submit(f.start, "https://evil.example")).status, 400);
  assert.equal(calls, 0);
  const redirect = await submit(f.start);
  assert.equal(redirect.status, 303);
  const auth = new URL(redirect.headers.get("location")!);
  assert.equal(auth.origin, "https://www.linkedin.com");
  assert.equal(auth.searchParams.get("redirect_uri"), base + "/callback");
  assert.equal(
    (await fetch(base + "/callback?state=wrong&code=test")).status,
    400,
  );
  assert.equal(calls, 0);
  const callback = await fetch(
    base +
      "/callback?" +
      new URLSearchParams({
        state: auth.searchParams.get("state")!,
        code: "test",
      }),
  );
  assert.equal(callback.status, 200);
  assert.equal(new URL(callback.url).pathname, "/connected");
  assert.equal(new URL(callback.url).search, "");
  assert.match(await callback.text(), /Connected/);
  const c = await f.store.connection("test");
  assert.equal(c.member, "urn:li:person:member-id");
  assert.deepEqual(c.scopes, ["openid", "profile", "w_member_social"]);
  assert.equal((await f.vault.get("test"))?.accessToken, "DO-NOT-LEAK-TOKEN");
  assert.doesNotMatch(
    JSON.stringify(await f.store.read("connections", "test")),
    /DO-NOT-LEAK/,
  );
  assert.equal(
    (
      await fetch(
        base +
          "/callback?" +
          new URLSearchParams({
            state: auth.searchParams.get("state")!,
            code: "test",
          }),
      )
    ).status,
    400,
  );
});
test("OAuth denial leaves no connected account and echoes no provider description", async (t) => {
  const f = await setup(t, async () => {
    throw new Error("must not call");
  });
  const redirect = await submit(f.start);
  const state = new URL(redirect.headers.get("location")!).searchParams.get(
    "state",
  )!;
  const res = await fetch(
    base +
      "/callback?" +
      new URLSearchParams({
        state,
        error: "access_denied",
        error_description: "SECRET_PROVIDER_VALUE",
      }),
  );
  assert.equal(res.status, 400);
  assert.doesNotMatch(await res.text(), /SECRET_PROVIDER_VALUE/);
  assert.equal(await f.store.read("connections", "test"), undefined);
});
test("OAuth bad token response is sanitized and does not activate account", async (t) => {
  const f = await setup(
    t,
    async () => new Response("DO-NOT-LEAK-SECRET", { status: 401 }),
  );
  const redirect = await submit(f.start);
  const state = new URL(redirect.headers.get("location")!).searchParams.get(
    "state",
  )!;
  const res = await fetch(
    base + "/callback?" + new URLSearchParams({ state, code: "x" }),
  );
  assert.equal(res.status, 400);
  assert.doesNotMatch(await res.text(), /DO-NOT-LEAK/);
  assert.equal(await f.store.read("connections", "test"), undefined);
});
test("unverified introspection is rejected even if OAuth returned a token", async (t) => {
  const f = await setup(t, async (u) =>
    String(u).endsWith("accessToken")
      ? Response.json({ access_token: "secret", expires_in: 3600 })
      : Response.json({ active: false }),
  );
  const redirect = await submit(f.start);
  const state = new URL(redirect.headers.get("location")!).searchParams.get(
    "state",
  )!;
  const res = await fetch(
    base + "/callback?" + new URLSearchParams({ state, code: "x" }),
  );
  assert.equal(res.status, 400);
  assert.equal(await f.store.read("connections", "test"), undefined);
});

test("renewal reuses Keychain credentials without exposing them or accepting replacements", async (t) => {
  const f = await setup(t, async () => {
    throw new Error("unexpected API call");
  });
  await f.oauth.close();
  await f.store.write("connections", "test", { mode: "personal" });
  await f.vault.set("test", {
    clientId: "saved-client",
    clientSecret: "SAVED-SECRET",
  });
  const start = await f.oauth.start("test", "personal");
  const page = await (await fetch(start.setupUrl)).text();
  assert.match(page, /Renew connection/);
  assert.doesNotMatch(page, /SAVED-SECRET|saved-client|name="clientSecret"/);
  assert.equal((await submit(start, "https://evil.example")).status, 400);
  const response = await submit(start);
  assert.equal(response.status, 303);
  assert.equal(
    new URL(response.headers.get("location")!).searchParams.get("client_id"),
    "saved-client",
  );
  assert.equal(
    (await f.vault.get("pending-test"))?.clientSecret,
    "SAVED-SECRET",
  );
  assert.equal((await f.vault.get("test"))?.clientSecret, "SAVED-SECRET");
  assert.equal((await submit(start)).status, 400);
});
