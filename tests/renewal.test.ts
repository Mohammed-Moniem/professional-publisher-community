import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { renewableConnection } from "../src/renewal.js";
import type { Vault, Credentials } from "../src/keychain.js";
import type { Connection } from "../src/model.js";
class MemoryVault implements Vault {
  values = new Map<string, Credentials>();
  async get(id: string) {
    return this.values.get(id);
  }
  async set(id: string, v: Credentials) {
    this.values.set(id, v);
  }
}
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "renewal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const vault = new MemoryVault();
  const c: Connection = {
    id: "test",
    mode: "personal",
    name: "Test",
    member: "urn:li:person:test",
    scopes: ["w_member_social"],
    expiresAt: Date.now() + 3600_000,
    connectedAt: Date.now(),
    refreshSupported: true,
    refreshExpiresAt: Date.now() + 10 * 86400_000,
  };
  await store.write("connections", "test", c);
  await vault.set("test", {
    clientId: "id",
    clientSecret: "SECRET",
    accessToken: "ACCESS",
    refreshToken: "REFRESH",
    refreshExpiresAt: c.refreshExpiresAt,
  });
  return { store, vault, c };
}
test("renewal uses granted refresh token and never extends the original refresh deadline", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const renewed = await renewableConnection(
    f.store,
    f.vault,
    async (u, i) => {
      calls++;
      if (String(u).endsWith("accessToken")) {
        assert.equal(
          new URLSearchParams(i?.body as any).get("grant_type"),
          "refresh_token",
        );
        return Response.json({
          access_token: "NEW-ACCESS",
          expires_in: 60 * 86400,
          refresh_token: "NEW-REFRESH",
          refresh_token_expires_in: 365 * 86400,
        });
      }
      return Response.json({
        active: true,
        scope: "w_member_social",
        expires_at: Date.now() / 1000 + 60 * 86400,
      });
    },
    "test",
  );
  assert.equal(calls, 2);
  assert.equal(renewed.refreshExpiresAt, f.c.refreshExpiresAt);
  assert.equal(renewed.expiresAt, f.c.refreshExpiresAt);
  assert.equal((await f.vault.get("test"))?.accessToken, "NEW-ACCESS");
  assert.doesNotMatch(
    JSON.stringify(await f.store.read("connections", "test")),
    /NEW-ACCESS|NEW-REFRESH|SECRET/,
  );
});
test("no refresh grant means no invented renewal or changed expiry", async (t) => {
  const f = await fixture(t);
  await f.vault.set("test", {
    clientId: "id",
    clientSecret: "secret",
    accessToken: "token",
  });
  const c = await renewableConnection(
    f.store,
    f.vault,
    async () => {
      throw new Error("No request allowed");
    },
    "test",
  );
  assert.equal(c.expiresAt, f.c.expiresAt);
});
test("expired refresh token does not slide forward", async (t) => {
  const f = await fixture(t);
  await f.vault.set("test", {
    ...(await f.vault.get("test"))!,
    refreshExpiresAt: Date.now() - 1,
  });
  await f.store.write("connections", "test", { ...f.c, expiresAt: 0 });
  await assert.rejects(
    () =>
      renewableConnection(
        f.store,
        f.vault,
        async () => {
          throw new Error("No request");
        },
        "test",
      ),
    { code: "RECONNECT_REQUIRED" },
  );
});
test("transient renewal failure preserves valid access and delays retry", async (t) => {
  const f = await fixture(t);
  const c = await renewableConnection(
    f.store,
    f.vault,
    async () => {
      throw new Error("PRIVATE");
    },
    "test",
  );
  assert.equal(c.expiresAt, f.c.expiresAt);
  const saved = await f.store.read<Connection>("connections", "test");
  assert.ok(saved!.refreshRetryAt! > Date.now());
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE/);
});
test("invalid refresh grant is disabled without discarding unexpired access", async (t) => {
  const f = await fixture(t);
  const c = await renewableConnection(
    f.store,
    f.vault,
    async () => new Response("secret", { status: 400 }),
    "test",
  );
  assert.equal(c.expiresAt, f.c.expiresAt);
  assert.equal((await f.vault.get("test"))?.refreshToken, undefined);
  assert.equal(c.refreshSupported, false);
});
test("revoked connection never silently refreshes", async (t) => {
  const f = await fixture(t);
  await f.store.write("connections", "test", { ...f.c, revoked: true });
  await assert.rejects(
    () =>
      renewableConnection(
        f.store,
        f.vault,
        async () => {
          throw new Error("No request");
        },
        "test",
      ),
    { code: "RECONNECT_REQUIRED" },
  );
});
