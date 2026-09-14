import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { Store } from "../src/store.js";
import { LinkedIn } from "../src/linkedin.js";
import { Publisher, postBody } from "../src/publisher.js";
import { Media, validateUploadUrl } from "../src/media.js";
import {
  Fault,
  escapeText,
  type Connection,
  type Draft,
} from "../src/model.js";
import type { Vault, Credentials } from "../src/keychain.js";
export class MemoryVault implements Vault {
  values = new Map<string, Credentials>();
  async get(id: string) {
    return this.values.get(id);
  }
  async set(id: string, v: Credentials) {
    this.values.set(id, v);
  }
}
const who = "urn:li:person:test123";
async function fixture(
  t: any,
  handler: (u: string, i: RequestInit) => Promise<Response> | Response = () =>
    new Response("", {
      status: 201,
      headers: { "x-restli-id": "urn:li:share:123" },
    }),
) {
  const root = await mkdtemp(join(tmpdir(), "publisher-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  await store.init();
  const connection: Connection = {
    id: "personal",
    mode: "personal",
    scopes: ["w_member_social"],
    expiresAt: Date.now() + 3600_000,
    member: who,
    name: "Test member",
    connectedAt: Date.now(),
  };
  await store.write("connections", "personal", connection);
  const vault = new MemoryVault();
  await vault.set("personal", {
    clientId: "test-id",
    clientSecret: "test-secret",
    accessToken: "SECRET-DO-NOT-LOG",
  });
  const calls: { u: string; i: RequestInit }[] = [];
  const api = new LinkedIn(store, vault, async (u, i) => {
    calls.push({ u: String(u), i: i ?? {} });
    return handler(String(u), i ?? {});
  });
  const publisher = new Publisher(store, api);
  return { root, store, vault, api, publisher, calls, connection };
}
const input = {
  connectionId: "personal",
  author: who,
  text: "A real draft (with punctuation) #Build",
  attachments: [],
};
test("publish receipt is persisted, text escaped, repeated calls never repost", async (t) => {
  const f = await fixture(t);
  const d = await f.publisher.prepare(input);
  assert.equal(d.visibility, "PUBLIC");
  assert.equal(d.text, input.text);
  const result = await f.publisher.publish(
    d.id,
    d.reviewDigest,
    "Publish this reviewed draft to my profile.",
  );
  assert.equal(result.state, "published");
  assert.equal(
    result.result?.url,
    "https://www.linkedin.com/feed/update/urn:li:share:123/",
  );
  assert.equal(
    (await f.publisher.publish(d.id, d.reviewDigest, "Publish")).state,
    "published",
  );
  assert.equal(f.calls.length, 1);
  assert.equal(
    JSON.parse(f.calls[0].i.body as string).commentary,
    "A real draft \\(with punctuation\\) #Build",
  );
  assert.equal((await f.publisher.prepare(input)).id, d.id);
  assert.equal(
    (await f.publisher.capabilities()).connections[0].identities[0].formats.text
      .status,
    "live_verified",
  );
});
test("no network on drafting, missing authorization, wrong digest or wrong author", async (t) => {
  const f = await fixture(t);
  const d = await f.publisher.prepare(input);
  assert.equal(f.calls.length, 0);
  await assert.rejects(() => f.publisher.publish(d.id, d.reviewDigest, ""), {
    code: "AUTHORIZATION_REQUIRED",
  });
  await assert.rejects(() => f.publisher.publish(d.id, "bad", "Publish"), {
    code: "REVIEW_CHANGED",
  });
  const other = await f.publisher.prepare({
    ...input,
    author: "urn:li:person:someoneelse",
  });
  await assert.rejects(
    () => f.publisher.publish(other.id, other.reviewDigest, "Publish"),
    { code: "AUTHOR_NOT_AUTHORIZED" },
  );
  assert.equal(f.calls.length, 0);
});
test("timeouts are uncertain and block retry and identical preparation", async (t) => {
  const f = await fixture(t, () => {
    throw new Error("network SECRET-DO-NOT-LOG");
  });
  const d = await f.publisher.prepare(input);
  const result = await f.publisher.publish(d.id, d.reviewDigest, "Publish");
  assert.equal(result.state, "uncertain");
  assert.doesNotMatch(JSON.stringify(result), /SECRET-DO-NOT-LOG/);
  await assert.rejects(
    () => f.publisher.publish(d.id, d.reviewDigest, "Publish again"),
    { code: "DRAFT_LOCKED" },
  );
  assert.equal((await f.publisher.prepare(input)).state, "uncertain");
  assert.equal(f.calls.length, 1);
});
for (const status of [500, 502, 408, 409])
  test(`HTTP ${status} is conservatively uncertain`, async (t) => {
    const f = await fixture(
      t,
      () => new Response("secret provider body", { status }),
    );
    const d = await f.publisher.prepare(input);
    assert.equal(
      (await f.publisher.publish(d.id, d.reviewDigest, "Publish")).state,
      "uncertain",
    );
  });
test("missing receipt is uncertain even for successful HTTP", async (t) => {
  const f = await fixture(t, () => new Response("", { status: 201 }));
  const d = await f.publisher.prepare(input);
  assert.equal(
    (await f.publisher.publish(d.id, d.reviewDigest, "Publish")).state,
    "uncertain",
  );
});
test("interrupted durable publishing record cannot be replayed", async (t) => {
  const f = await fixture(t);
  const d = await f.publisher.prepare(input);
  await f.store.write("drafts", d.id, {
    ...(await f.store.draft(d.id)),
    state: "publishing",
  });
  await assert.rejects(
    () => f.publisher.publish(d.id, d.reviewDigest, "Publish"),
    { code: "DRAFT_LOCKED" },
  );
  assert.equal((await f.store.draft(d.id)).state, "uncertain");
  assert.equal(f.calls.length, 0);
});
test("concurrent publishers cannot create two posts", async (t) => {
  let release!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  const f = await fixture(t, async () => {
    await wait;
    return new Response("", {
      status: 201,
      headers: { "x-restli-id": "urn:li:share:1" },
    });
  });
  const d = await f.publisher.prepare(input);
  const first = f.publisher.publish(d.id, d.reviewDigest, "Publish");
  while (!f.calls.length) await new Promise((r) => setTimeout(r, 5));
  await assert.rejects(
    () => f.publisher.publish(d.id, d.reviewDigest, "Publish"),
    { code: "BUSY" },
  );
  release();
  await first;
  assert.equal(f.calls.length, 1);
});
test("expired access fails before the network", async (t) => {
  const f = await fixture(t);
  await f.store.write("connections", "personal", {
    ...f.connection,
    expiresAt: 0,
  });
  const d = await f.publisher.prepare(input);
  await assert.rejects(
    () => f.publisher.publish(d.id, d.reviewDigest, "Publish"),
    { code: "RECONNECT_REQUIRED" },
  );
  assert.equal(f.calls.length, 0);
});
test("401 marks connection revoked without leaking provider body", async (t) => {
  const f = await fixture(
    t,
    () => new Response("SECRET-DO-NOT-LOG", { status: 401 }),
  );
  const d = await f.publisher.prepare(input);
  const result = await f.publisher.publish(d.id, d.reviewDigest, "Publish");
  assert.equal(result.state, "rejected");
  assert.equal(result.error?.code, "RECONNECT_REQUIRED");
  assert.equal(
    (await f.store.read<Connection>("connections", "personal"))?.revoked,
    true,
  );
  assert.doesNotMatch(JSON.stringify(result), /SECRET-DO-NOT-LOG/);
});
test("403 records per-format restriction", async (t) => {
  const f = await fixture(t, () => new Response("restricted", { status: 403 }));
  const d = await f.publisher.prepare(input);
  assert.equal(
    (await f.publisher.publish(d.id, d.reviewDigest, "Publish")).state,
    "rejected",
  );
  await assert.rejects(
    () => f.publisher.publish(d.id, d.reviewDigest, "Publish"),
    { code: "FORMAT_RESTRICTED" },
  );
  assert.equal(
    (await f.publisher.capabilities()).connections[0].identities[0].formats.text
      .status,
    "restricted",
  );
});
test("429 exposes delay but does not silently retry", async (t) => {
  const f = await fixture(
    t,
    () => new Response("", { status: 429, headers: { "retry-after": "60" } }),
  );
  const d = await f.publisher.prepare(input);
  const result = await f.publisher.publish(d.id, d.reviewDigest, "Publish");
  assert.equal(result.state, "rejected");
  assert.equal(result.error?.code, "RATE_LIMITED");
  assert.equal(f.calls.length, 1);
});
test("company page roles filter revoked, analyst and sponsored-only roles", async (t) => {
  const f = await fixture(t, () =>
    Response.json({
      elements: [
        {
          organization: "urn:li:organization:1",
          state: "APPROVED",
          role: "ADMINISTRATOR",
        },
        {
          organizationTarget: "urn:li:organization:2",
          state: "APPROVED",
          role: "CONTENT_ADMINISTRATOR",
        },
        {
          organization: "urn:li:organization:3",
          state: "APPROVED",
          role: "ANALYST",
        },
        {
          organization: "urn:li:organization:4",
          state: "REVOKED",
          role: "ADMINISTRATOR",
        },
        {
          organization: "urn:li:organization:5",
          state: "APPROVED",
          role: "DIRECT_SPONSORED_CONTENT_POSTER",
        },
      ],
    }),
  );
  await f.store.write("connections", "personal", {
    ...f.connection,
    mode: "company",
    scopes: ["r_organization_admin", "w_organization_social"],
  });
  assert.deepEqual(
    (await f.api.identities("personal")).map((i) => i.author),
    ["urn:li:organization:1", "urn:li:organization:2"],
  );
  await assert.rejects(
    () => f.api.assertAuthor("personal", "urn:li:organization:3"),
    { code: "AUTHOR_NOT_AUTHORIZED" },
  );
});
test("PDF, single and multi-image validation and immutable media snapshots", async (t) => {
  const f = await fixture(t);
  const png = join(f.root, "one.png");
  await sharp({
    create: { width: 16, height: 12, channels: 3, background: "red" },
  })
    .png()
    .toFile(png);
  const a = { path: png, title: "A chart", altText: "A red test rectangle" };
  const d = await f.publisher.prepare({ ...input, attachments: [a] });
  assert.equal(d.format, "image");
  assert.equal(d.attachments[0].metadata.width, 16);
  await writeFile(png, "changed original");
  assert.notEqual(
    await readFile(
      (await f.store.draft(d.id)).attachments[0].storedPath,
      "utf8",
    ),
    "changed original",
  );
  const pdf = await PDFDocument.create();
  pdf.addPage();
  const path = join(f.root, "slides.pdf");
  await writeFile(path, await pdf.save());
  assert.equal(
    (
      await f.publisher.prepare({
        ...input,
        attachments: [{ path, title: "Slides" }],
      })
    ).format,
    "document",
  );
  const big = await PDFDocument.create();
  for (let i = 0; i < 301; i++) big.addPage();
  await writeFile(path, await big.save());
  await assert.rejects(
    () =>
      f.publisher.prepare({
        ...input,
        attachments: [{ path, title: "Too many" }],
      }),
    { code: "DOCUMENT_PAGE_LIMIT" },
  );
  await assert.rejects(
    () => f.publisher.prepare({ ...input, attachments: [a] }),
    { code: "INVALID_IMAGE" },
  );
});
test("link cards use explicit metadata and do not scrape URLs", async (t) => {
  const f = await fixture(t);
  const d = await f.publisher.prepare({
    ...input,
    link: {
      url: "https://example.com/project",
      title: "Project",
      description: "Description",
    },
  });
  const body = postBody(await f.store.draft(d.id));
  assert.deepEqual(body.content, {
    article: {
      source: "https://example.com/project",
      title: "Project",
      description: "Description",
    },
  });
  assert.equal(f.calls.length, 0);
  await assert.rejects(
    () =>
      f.publisher.prepare({
        ...input,
        link: { url: "file:///tmp/private", title: "Invalid" },
      }),
    { code: "INVALID_LINK" },
  );
});
test("upload rejects untrusted domains and redirects", () => {
  for (const url of [
    "http://api.linkedin.com/upload",
    "https://linkedin.com.evil.test/a",
    "https://localhost/a",
    "https://user:pass@api.linkedin.com/a",
    "https://api.linkedin.com:444/a",
  ])
    assert.throws(() => validateUploadUrl(url), { code: "INVALID_UPLOAD_URL" });
  assert.equal(
    validateUploadUrl("https://www.linkedin.com/dms-upload/a").hostname,
    "www.linkedin.com",
  );
});
test("image upload waits for processing and uses legacy personal status read", async (t) => {
  let ready = false;
  const f = await fixture(t, (u, i) => {
    if (u.includes("initializeUpload"))
      return Response.json({
        value: {
          image: "urn:li:image:abc",
          uploadUrl: "https://www.linkedin.com/upload",
        },
      });
    if (i.method === "PUT") return new Response("");
    if (u.includes("/images/"))
      return Response.json({ status: ready ? "AVAILABLE" : "PROCESSING" });
    return new Response("", {
      status: 201,
      headers: { "x-restli-id": "urn:li:share:123" },
    });
  });
  const path = join(f.root, "image.png");
  await sharp({
    create: { width: 10, height: 10, channels: 3, background: "blue" },
  })
    .png()
    .toFile(path);
  const d = await f.publisher.prepare({
    ...input,
    attachments: [{ path, title: "Image" }],
  });
  assert.equal((await f.publisher.upload(d.id)).mediaReady, false);
  await assert.rejects(
    () => f.publisher.publish(d.id, d.reviewDigest, "Publish"),
    { code: "MEDIA_NOT_READY" },
  );
  ready = true;
  assert.equal((await f.publisher.upload(d.id)).mediaReady, true);
  assert.equal(f.calls.filter((c) => c.i.method === "PUT").length, 1);
  assert.equal(
    (f.calls.find((c) => c.u.includes("/images/"))!.i.headers as any)[
      "LinkedIn-Version"
    ],
    undefined,
  );
  assert.equal(
    (f.calls.find((c) => c.i.method === "PUT")!.i.headers as any).Authorization,
    undefined,
  );
  assert.equal(
    (await f.publisher.publish(d.id, d.reviewDigest, "Publish")).state,
    "published",
  );
});
test("failed processing blocks publication", async (t) => {
  const f = await fixture(t, () =>
    Response.json({ status: "PROCESSING_FAILED" }),
  );
  const media = new Media(f.api);
  await assert.rejects(
    () =>
      media.ready("personal", who, {
        asset: "urn:li:document:abc",
        kind: "document",
      } as any),
    { code: "MEDIA_PROCESSING_FAILED" },
  );
});
test("reserved little-text syntax cannot create mentions", () => {
  assert.equal(
    escapeText("@[Name](urn:li:person:1) * _ ~ #tag"),
    "\\@\\[Name\\]\\(urn:li:person:1\\) \\* \\_ \\~ #tag",
  );
});

test("multi-image post body preserves image order and alt text", async (t) => {
  const f = await fixture(t);
  const path = join(f.root, "one.png");
  const second = join(f.root, "two.png");
  await sharp({
    create: { width: 12, height: 8, channels: 3, background: "green" },
  })
    .png()
    .toFile(path);
  await sharp({
    create: { width: 12, height: 8, channels: 3, background: "orange" },
  })
    .png()
    .toFile(second);
  const d = await f.publisher.prepare({
    ...input,
    attachments: [
      { path, title: "First", altText: "Green" },
      { path: second, title: "Second", altText: "Orange" },
    ],
  });
  assert.equal(d.format, "multiImage");
  const stored = await f.store.draft(d.id);
  stored.attachments[0].asset = "urn:li:image:first";
  stored.attachments[1].asset = "urn:li:image:second";
  assert.deepEqual(postBody(stored).content, {
    multiImage: {
      images: [
        { id: "urn:li:image:first", altText: "Green" },
        { id: "urn:li:image:second", altText: "Orange" },
      ],
    },
  });
});

test("missing publishing scope is blocked and reported as missing permission", async (t) => {
  const f = await fixture(t);
  await f.store.write("connections", "personal", {
    ...f.connection,
    scopes: ["openid", "profile"],
  });
  const d = await f.publisher.prepare(input);
  await assert.rejects(
    () => f.publisher.publish(d.id, d.reviewDigest, "Publish"),
    { code: "MISSING_PUBLISH_SCOPE" },
  );
  assert.equal(
    (await f.publisher.capabilities()).connections[0].identities[0].formats.text
      .status,
    "missing_permission",
  );
  assert.equal(f.calls.length, 0);
});

test("incomplete lock ownership is never reclaimed", async (t) => {
  const f = await fixture(t);
  const db = f.store.database();
  db.prepare("INSERT INTO locks VALUES (?,?,?)").run(
    "incomplete",
    0,
    "incomplete",
  );
  db.close();
  await assert.rejects(
    f.store.lock("incomplete", async () => true),
    /Another process/,
  );
});
