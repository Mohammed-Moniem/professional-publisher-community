import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  mkdir,
  cp,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { Store, hash } from "../src/store.js";
import { connectionId } from "../src/model.js";
import { Keychain, type Credentials } from "../src/keychain.js";
import { LinkedIn } from "../src/linkedin.js";
import { Publisher } from "../src/publisher.js";
import { Workspace } from "../src/workspace.js";
import { VoiceStudio, ruleSchema } from "../src/voice-studio.js";
import { Accounts } from "../src/accounts.js";
import { Review } from "../src/review.js";
import { Scheduler } from "../src/scheduler.js";
import { Notifications } from "../src/notifications.js";
import { exportBackup, restoreBackup } from "../src/backups.js";
import { Dashboard } from "../src/dashboard.js";
import { Decks } from "../src/decks.js";
const identity = "urn:li:person:synthetic";
test("account labels cannot collide with pending OAuth credential entries", () => {
  assert.equal(connectionId.safeParse("pending-personal").success, false);
  assert.equal(connectionId.safeParse("personal").success, true);
});
const input = {
  connectionId: "personal",
  author: identity,
  text: "Synthetic original draft.",
  attachments: [],
};
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "publisher-v2-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "workspace"));
  await store.init();
  const secrets = new Map<string, Credentials>([
    [
      "personal",
      {
        clientId: "synthetic",
        clientSecret: "synthetic",
        accessToken: "synthetic",
      },
    ],
  ]);
  const vault = {
    get: async (id: string) => secrets.get(id),
    set: async (id: string, value: Credentials) => {
      secrets.set(id, value);
    },
    delete: async (id: string) => {
      secrets.delete(id);
    },
  };
  let posts = 0;
  const api = new LinkedIn(store, vault, async (_url, options) => {
    assert.equal(options?.method, "POST");
    posts++;
    return new Response(null, {
      status: 201,
      headers: { "x-restli-id": "urn:li:share:123" },
    });
  });
  const publisher = new Publisher(store, api),
    workspace = new Workspace(store),
    studio = new VoiceStudio(store),
    scheduler = new Scheduler(store, publisher);
  await store.write("connections", "personal", {
    id: "personal",
    name: "Synthetic Author",
    member: identity,
    mode: "personal",
    scopes: ["w_member_social"],
    expiresAt: Date.now() + 10 * 86400000,
    connectedAt: 1,
  });
  return {
    root,
    store,
    secrets,
    vault,
    api,
    publisher,
    workspace,
    studio,
    scheduler,
    posts: () => posts,
  };
}
test("revision preserves original, changes digest, separates learning and publication, blocks uncertain edits", async (t) => {
  const f = await fixture(t),
    review = new Review(f.publisher),
    d = await f.publisher.prepare(input);
  await f.workspace.approveDraft(d.id, d.digest, "Approve learning");
  await assert.rejects(review.publish(d.id, d.digest, "publish"), {
    code: "REVIEW_REQUIRED",
  });
  const next = await review.revise(d.id, d.digest, {
    ...input,
    text: "A revised synthetic draft.",
  });
  assert.notEqual(next.digest, d.digest);
  assert.equal((await review.revise(next.id, next.digest, input)).id, d.id);
  assert.equal(await f.store.read("draft_revisions", d.id), undefined);
  assert.equal((await f.store.draft(d.id)).text, input.text);
  await assert.rejects(
    review.check(next.id, d.digest, {
      sources: [],
      factsChecked: true,
      attachmentsChecked: true,
      destinationChecked: true,
    }),
    { code: "DRAFT_CHANGED" },
  );
  await review.check(next.id, next.digest, {
    sources: [],
    factsChecked: true,
    attachmentsChecked: true,
    destinationChecked: true,
  });
  await assert.rejects(review.publish(next.id, next.digest, ""), {
    code: "APPROVAL_REQUIRED",
  });
  assert.equal(
    (await review.publish(next.id, next.digest, "User asked to publish")).state,
    "published",
  );
  await review.publish(next.id, next.digest, "Repeat same instruction");
  assert.equal(f.posts(), 1);
  await f.store.write("drafts", d.id, {
    ...(await f.store.draft(d.id)),
    state: "uncertain",
  });
  await assert.rejects(
    review.revise(d.id, d.digest, { ...input, text: "Bypass guard" }),
    { code: "DRAFT_LOCKED" },
  );
});
test("disconnect cancels pending jobs and removes credentials while retaining duplicate guards", async (t) => {
  const f = await fixture(t),
    draft = await f.publisher.prepare(input),
    at = new Date(
      Math.ceil(Date.now() / 60000) * 60000 + 3600000,
    ).toISOString();
  const job = await f.scheduler.schedule({
    draftId: draft.id,
    reviewDigest: draft.digest,
    authorization: "Schedule this",
    at,
    timeZone: "UTC",
  });
  await new Accounts(f.store, f.vault).disconnect("personal");
  assert.equal(f.secrets.size, 0);
  assert.equal(
    (await f.store.read<any>("schedules", job.id)).state,
    "cancelled",
  );
  await assert.rejects(f.publisher.publish(draft.id, draft.digest, "Publish"), {
    code: "RECONNECT_REQUIRED",
  });
  assert.equal((await f.store.draft(draft.id)).digest, draft.digest);
  assert.equal(f.posts(), 0);
});
test("credential generations are tracked and cleanup/deletion is serialized", async (t) => {
  const f = await fixture(t),
    vault = new Keychain(f.store),
    entries = new Map<string, string>();
  (vault as any).entry = (id: string) => ({
    getPassword: async () => entries.get(id),
    setPassword: async (v: string) => {
      entries.set(id, v);
    },
    deleteCredential: async () => entries.delete(id),
  });
  const value = { clientId: "fixture", clientSecret: "x".repeat(6000) };
  await vault.set("test", value);
  await vault.set("test", { ...value, accessToken: "new" });
  assert.equal((await vault.get("test"))?.accessToken, "new");
  assert.equal(await vault.cleanup("test"), 1);
  assert.equal((await vault.get("test"))?.clientSecret.length, 6000);
  await vault.delete("test");
  assert.equal(entries.size, 0);
  assert.equal(await vault.get("test"), undefined);
});
test("voice rules validate identity evidence, hold out samples, use exact versions and reset all studio data", async (t) => {
  const f = await fixture(t);
  await f.workspace.consent(identity, true);
  await f.workspace.ingest(
    identity,
    Array.from({ length: 30 }, (_, n) => ({
      text: "Synthetic writing example " + n,
      source: "fixture",
      authorship: "original",
      truncated: false,
    })),
  );
  const context = await f.studio.inspect(identity);
  assert.ok(context.trainingSamples.length);
  assert.ok(context.heldOutSampleCount);
  const source = context.trainingSamples[0],
    rule = ruleSchema.parse({
      id: "short",
      instruction: "Use short openings",
      kind: "prefer",
      origin: "observed",
      enabled: true,
      evidenceIds: [source.id, source.id],
    });
  await f.studio.save(identity, { expectedVersion: 0, rules: [rule] });
  assert.equal(
    (await f.studio.inspect(identity)).rules[0].supportingSamples,
    1,
  );
  await assert.rejects(
    f.studio.save(identity, { expectedVersion: 0, rules: [] }),
    { code: "VOICE_CHANGED" },
  );
  await assert.rejects(
    f.studio.save("urn:li:person:other", { expectedVersion: 0, rules: [rule] }),
    { code: "INVALID_EVIDENCE" },
  );
  const held = (await f.studio.evaluation(identity)).samples[0];
  await assert.rejects(
    f.studio.save(identity, {
      expectedVersion: 1,
      rules: [{ ...rule, evidenceIds: [held.id] }],
    }),
    { code: "INVALID_EVIDENCE" },
  );
  await f.studio.save(identity, {
    expectedVersion: 1,
    rules: [{ ...rule, origin: "manual", evidenceIds: [], enabled: false }],
  });
  await f.workspace.controlVoice(identity, "freeze");
  await assert.rejects(
    f.studio.save(identity, { expectedVersion: 2, rules: [] }),
    { code: "VOICE_FROZEN" },
  );
  await f.workspace.controlVoice(identity, "unfreeze");
  await f.studio.compare(identity, {
    brief: "Example",
    generic: "A",
    current: "B",
    revised: "C",
    preferred: "none",
    feedback: "",
  });
  await f.workspace.controlVoice(identity, "reset");
  assert.equal((await f.studio.inspect(identity)).rules.length, 0);
  assert.equal((await f.studio.inspect(identity)).comparisons.length, 0);
});
test("encrypted full backup restores files but disables credentials, schedules and approvals; tampering and overwrite fail", async (t) => {
  const f = await fixture(t),
    d = await f.publisher.prepare(input),
    pass = "synthetic backup passphrase";
  const asset = join(f.store.root, "media", "synthetic.txt");
  await writeFile(asset, "Private synthetic media");
  await f.store.write("ideas", "sample", {
    id: "sample",
    path: asset,
    text: "Private synthetic idea",
  });
  await f.store.write("drafts", d.id, {
    ...(await f.store.draft(d.id)),
    state: "publishing",
  });
  await f.store.write("schedules", "fixture", {
    id: "fixture",
    state: "scheduled",
    draftId: d.id,
    authorization: "old",
  });
  await f.store.write("approvals", d.id, { digest: d.digest });
  const backup = join(f.root, "backup.ppcenc");
  await exportBackup(f.store, backup, pass);
  const bytes = await readFile(backup);
  assert.ok(!bytes.includes(Buffer.from("Private synthetic idea")));
  await assert.rejects(
    restoreBackup(backup, join(f.root, "wrong"), "wrong password value"),
    { code: "BACKUP_AUTH_FAILED" },
  );
  const corrupt = Buffer.from(bytes);
  corrupt[corrupt.length - 20] ^= 1;
  await writeFile(join(f.root, "bad.ppcenc"), corrupt);
  await assert.rejects(
    restoreBackup(join(f.root, "bad.ppcenc"), join(f.root, "bad"), pass),
    { code: "BACKUP_AUTH_FAILED" },
  );
  await assert.rejects(restoreBackup(backup, f.store.root, pass), {
    code: "RESTORE_TARGET_EXISTS",
  });
  const target = join(f.root, "restored");
  await restoreBackup(backup, target, pass);
  const restored = new Store(target);
  assert.equal(
    await readFile(join(target, "media", "synthetic.txt"), "utf8"),
    "Private synthetic media",
  );
  assert.equal(
    (await restored.read<any>("ideas", "sample")).path,
    join(target, "media", "synthetic.txt"),
  );
  assert.equal(
    (await restored.read<any>("connections", "personal")).revoked,
    true,
  );
  assert.equal((await restored.draft(d.id)).state, "uncertain");
  assert.equal(
    (await restored.read<any>("schedules", "fixture")).state,
    "cancelled",
  );
  assert.deepEqual(await restored.list("approvals"), []);
  assert.equal(
    (await f.store.read<any>("connections", "personal")).revoked,
    undefined,
  );
});
test("rescheduling rejects wrong digest, DST mismatch and running jobs without changing the prior approval", async (t) => {
  const f = await fixture(t),
    d = await f.publisher.prepare(input);
  const raw = {
      draftId: d.id,
      reviewDigest: d.digest,
      at: "2035-01-01T12:00:00Z",
      timeZone: "UTC",
      authorization: "First time",
    },
    job = await f.scheduler.schedule(raw);
  await assert.rejects(
    f.scheduler.reschedule(job.id, { ...raw, at: "2035-01-02T12:00:00+04:00" }),
    { code: "TIMEZONE_OFFSET_MISMATCH" },
  );
  assert.equal((await f.store.read<any>("schedules", job.id)).at, raw.at);
  await assert.rejects(
    f.scheduler.reschedule(job.id, { ...raw, reviewDigest: "a".repeat(64) }),
    { code: "DRAFT_CHANGED" },
  );
  const next = await f.scheduler.reschedule(job.id, {
    ...raw,
    at: "2035-01-02T12:00:00Z",
    authorization: "Approved new time",
  });
  assert.equal(next.id, job.id);
  await f.store.write("schedules", job.id, { ...next, state: "running" });
  await assert.rejects(f.scheduler.reschedule(job.id, raw), {
    code: "CANNOT_RESCHEDULE",
  });
});
test("native notifications are opt in, generic and at most once; OS failure stays visible", async (t) => {
  const f = await fixture(t),
    calls: any[] = [],
    notifier = new Notifications(f.store, (async (...args: any[]) => {
      calls.push(args);
      throw Error("OS disabled");
    }) as any);
  await f.store.write("notifications", "example", {
    id: "example",
    state: "uncertain",
    message: "PRIVATE CONTENT",
  });
  await notifier.deliver("example");
  assert.equal(calls.length, 0);
  await notifier.configure(true);
  await notifier.deliver("example");
  await notifier.deliver("example");
  assert.equal(calls.length, 1);
  assert.ok(!JSON.stringify(calls).includes("PRIVATE CONTENT"));
  assert.equal(
    (await f.store.read<any>("notifications", "example")).nativeStatus,
    "unavailable",
  );
});
test("one-command packaged configuration setup restores portable manifest and makes no account changes", async (t) => {
  const f = await fixture(t),
    root = join(f.root, "bundle");
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "runtime"));
  await cp(resolve("scripts/setup.mjs"), join(root, "scripts/setup.mjs"));
  await writeFile(
    join(root, "runtime", process.platform === "win32" ? "node.exe" : "node"),
    "fixture",
  );
  await writeFile(
    join(root, "scripts/launch.mjs"),
    "if(process.argv[2]!=='doctor')throw Error('Unexpected action');console.log('synthetic doctor');",
  );
  await writeFile(
    join(root, "scripts/install.mjs"),
    "import{writeFileSync}from'node:fs';writeFileSync('.mcp.json','temporary machine configuration');",
  );
  await writeFile(join(root, ".mcp.json"), "portable fixture");
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      join(root, "scripts/setup.mjs"),
      "setup",
      "--client",
      "config",
      "--yes",
      "--skip-connect",
    ],
    { cwd: root },
  );
  assert.match(stdout, /Software setup complete/);
  assert.equal(
    await readFile(join(root, ".mcp.json"), "utf8"),
    "portable fixture",
  );
});
test("browser review edits an immutable draft, blocks unsaved publication, and saves manual voice preferences", async (t) => {
  const f = await fixture(t);
  const d = await f.publisher.prepare({
    ...input,
    link: {
      url: "https://example.com/story",
      title: "Synthetic article",
      description: "Preserve this description.",
    },
  });
  const dashboard = new Dashboard(
    f.store,
    f.workspace,
    new Decks(f.store),
    f.scheduler,
  );
  t.after(() => dashboard.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto((await dashboard.start()).url);
  await page.getByRole("button", { name: "Drafts", exact: true }).click();
  await page
    .getByLabel("Caption", { exact: true })
    .fill("A revised example from the browser.");
  assert.equal(
    await page
      .getByRole("button", { name: "Publish this exact post publicly" })
      .isDisabled(),
    true,
  );
  await page.getByRole("button", { name: "Save new revision" }).click();
  await page.getByText("Previous version", { exact: true }).waitFor();
  assert.equal((await f.store.draft(d.id)).text, input.text);
  assert.equal((await f.store.list("drafts")).length, 2);
  assert.equal(
    (await f.store.list<any>("drafts"))[1].link.description,
    "Preserve this description.",
  );
  assert.equal(f.posts(), 0);
  await page.getByRole("button", { name: "Voice Studio", exact: true }).click();
  await page.getByLabel("Identity URN").fill(identity);
  await page.getByRole("button", { name: "Load voice", exact: true }).click();
  await page.getByRole("button", { name: "Add manual preference" }).click();
  await page
    .getByLabel("Writing instruction")
    .fill("Avoid rhetorical questions.");
  await page
    .getByRole("button", { name: "Save voice rules", exact: true })
    .click();
  await page.getByText(/Version 1 ·/).waitFor();
  assert.equal((await f.studio.inspect(identity)).rules[0].origin, "manual");
  await page.getByRole("button", { name: "Accounts", exact: true }).click();
  await page.getByText("Encrypted backup", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
});
