import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import { Store, hash } from "../src/store.js";
import { Workspace } from "../src/workspace.js";
import { Decks, deckSchema } from "../src/decks.js";
import { Scheduler } from "../src/scheduler.js";
import { Dashboard } from "../src/dashboard.js";
import { Publisher } from "../src/publisher.js";
import { LinkedIn } from "../src/linkedin.js";
const identity = "urn:li:person:synthetic";
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "community-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  await store.init();
  return {
    root,
    store,
    workspace: new Workspace(store),
    decks: new Decks(store),
  };
}
test("consent, identity isolation, evidence, freeze and reset", async (t) => {
  const f = await fixture(t);
  const sample = {
    text: "I built a small prototype. Here is what changed.",
    source: "synthetic",
    authorship: "original" as const,
    truncated: false,
  };
  await assert.rejects(f.workspace.ingest(identity, [sample]), {
    code: "STYLE_CONSENT_REQUIRED",
  });
  await f.workspace.consent(identity, true);
  await f.workspace.ingest(identity, [
    sample,
    sample,
    { ...sample, text: "Someone else wrote this.", authorship: "reshare" },
  ]);
  assert.equal((await f.workspace.status(identity)).samples, 2);
  assert.equal((await f.workspace.samples(identity)).length, 1);
  assert.equal((await f.workspace.samples("urn:li:person:other")).length, 0);
  const profile = {
    summary: "Short first-person observations",
    tone: ["plain"],
    patterns: ["Concrete changes"],
    avoid: ["Invented metrics"],
    examples: [],
    evidenceIds: [hash([identity, sample.text])],
  };
  await assert.rejects(
    f.workspace.saveVoice(identity, { ...profile, evidenceIds: ["invented"] }),
    { code: "INVALID_EVIDENCE" },
  );
  assert.equal(
    (await f.workspace.saveVoice(identity, profile)).provisional,
    true,
  );
  await f.workspace.controlVoice(identity, "freeze");
  await assert.rejects(f.workspace.saveVoice(identity, profile), {
    code: "VOICE_FROZEN",
  });
  await f.workspace.controlVoice(identity, "unfreeze");
  assert.equal((await f.workspace.saveVoice(identity, profile)).version, 2);
  await f.workspace.controlVoice(identity, "reset");
  assert.equal((await f.workspace.status(identity)).samples, 0);
  assert.equal((await f.store.list("voice_versions")).length, 0);
});
test("archive imports only Shares.csv and treats rows as unknown authorship", async (t) => {
  const f = await fixture(t);
  await f.workspace.consent(identity, true);
  const zip = new JSZip();
  zip.file(
    "Shares.csv",
    'Date,ShareCommentary,ShareLink\n2026-01-01,"A synthetic post, with a comma",https://example.com/post\n',
  );
  zip.file("Messages.csv", "PRIVATE-MESSAGES-MUST-NOT-IMPORT");
  const path = join(f.root, "archive.zip");
  await writeFile(path, await zip.generateAsync({ type: "nodebuffer" }));
  await f.workspace.importFile(identity, path);
  const rows = await f.workspace.samples(identity);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].authorship, "unknown");
  assert.doesNotMatch(
    JSON.stringify(await f.store.list("samples")),
    /PRIVATE-MESSAGES/,
  );
  await f.workspace.importFile(identity, path);
  assert.equal((await f.workspace.status(identity)).samples, 1);
});
test("approved draft learning does not publish and requires matching digest", async (t) => {
  const f = await fixture(t);
  const p = new Publisher(f.store, {} as any);
  const d = await p.prepare({
    connectionId: "personal",
    author: identity,
    text: "Reviewed synthetic writing",
    attachments: [],
  });
  await f.workspace.consent(identity, true);
  await assert.rejects(f.workspace.approveDraft(d.id, "wrong", "Approved"), {
    code: "DRAFT_CHANGED",
  });
  assert.equal(
    (
      await f.workspace.approveDraft(
        d.id,
        d.reviewDigest,
        "I approve this text",
      )
    ).voiceUpdatePending,
    true,
  );
  assert.equal((await f.store.draft(d.id)).state, "draft");
  assert.equal((await f.workspace.samples(identity))[0].approved, true);
});
test("SQLite shared state, ownership locks, backup and downgrade rejection", async (t) => {
  const f = await fixture(t);
  const second = new Store(f.root);
  await f.store.write("ideas", "test", { value: 1 });
  assert.deepEqual(await second.read("ideas", "test"), { value: 1 });
  await f.store.lock("test", async () => {
    await assert.rejects(
      second.lock("test", async () => true),
      { code: "BUSY" },
    );
  });
  assert.equal(await second.lock("test", async () => 42), 42);
  assert.ok((await readFile(await f.store.backup())).length > 0);
  const db = f.store.database();
  db.exec("PRAGMA user_version=99");
  db.close();
  await assert.rejects(f.store.init(), { code: "NEWER_DATABASE" });
});
async function scheduledFixture(t: any) {
  const f = await fixture(t);
  let now = Date.UTC(2030, 0, 1, 12, 0);
  let calls = 0;
  await f.store.write("connections", "personal", {
    id: "personal",
    mode: "personal",
    member: identity,
    name: "Synthetic",
    scopes: ["w_member_social"],
    expiresAt: Date.now() + 3600000,
    connectedAt: Date.now(),
  });
  const api = new LinkedIn(
    f.store,
    {
      get: async () => ({
        clientId: "test",
        clientSecret: "test",
        accessToken: "test",
      }),
      set: async () => {},
    },
    async () => {
      calls++;
      return new Response("", {
        status: 201,
        headers: { "x-restli-id": "urn:li:share:123" },
      });
    },
  );
  const publisher = new Publisher(f.store, api);
  const d = await publisher.prepare({
    connectionId: "personal",
    author: identity,
    text: "Synthetic schedule fixture",
    attachments: [],
  });
  const scheduler = new Scheduler(f.store, publisher, () => now);
  const input = {
    draftId: d.id,
    reviewDigest: d.reviewDigest,
    authorization: "Schedule this exact fixture",
    at: "2030-01-01T12:01:00Z",
    timeZone: "UTC",
  };
  return {
    ...f,
    publisher,
    scheduler,
    input,
    setNow: (v: number) => (now = v),
    calls: () => calls,
  };
}
test("schedule runs once, deduplicates, and records receipt", async (t) => {
  const f = await scheduledFixture(t);
  const j = await f.scheduler.schedule(f.input);
  assert.equal((await f.scheduler.schedule(f.input)).id, j.id);
  assert.equal((await f.scheduler.tick()).length, 0);
  f.setNow(Date.UTC(2030, 0, 1, 12, 1, 5));
  assert.equal((await f.scheduler.tick())[0].state, "published");
  await f.scheduler.tick();
  assert.equal(f.calls(), 1);
});
test("missed, cancelled and interrupted schedules never submit", async (t) => {
  for (const state of ["missed", "cancelled", "running"]) {
    const f = await scheduledFixture(t);
    const j = await f.scheduler.schedule(f.input);
    if (state === "cancelled") await f.scheduler.cancel(j.id);
    if (state === "running")
      await f.store.write("schedules", j.id, { ...j, state: "running" });
    f.setNow(Date.UTC(2030, 0, 1, 12, 2));
    await f.scheduler.tick();
    assert.equal(f.calls(), 0);
    assert.equal(
      (await f.store.read<any>("schedules", j.id)).state,
      state === "running" ? "needs_attention" : state,
    );
  }
});
test("upload delay cannot publish after the approved minute", async (t) => {
  const f = await scheduledFixture(t);
  const original = f.publisher.upload.bind(f.publisher);
  f.publisher.upload = async (id) => {
    const r = await original(id);
    f.setNow(Date.UTC(2030, 0, 1, 12, 2));
    return r;
  };
  await f.scheduler.schedule(f.input);
  f.setNow(Date.UTC(2030, 0, 1, 12, 1));
  assert.equal((await f.scheduler.tick())[0].state, "missed");
  assert.equal(f.calls(), 0);
});
test("dashboard requires private session, same-origin mutation and rejects traversal", async (t) => {
  const f = await fixture(t);
  const dash = new Dashboard(f.store, f.workspace, f.decks, {} as any);
  t.after(() => dash.close());
  const { url } = await dash.start();
  const base = new URL(url).origin;
  assert.equal((await fetch(base + "/state")).status, 403);
  const boot = await fetch(url, { redirect: "manual" });
  assert.equal(boot.status, 303);
  const cookie = boot.headers.get("set-cookie")!.split(";")[0];
  const headers = { cookie };
  assert.equal((await fetch(base + "/state", { headers })).status, 200);
  assert.equal(
    (await fetch(base + "/idea", { method: "POST", headers, body: "{}" }))
      .status,
    400,
  );
  assert.equal(
    (await fetch(base + "/asset?deck=../../etc&name=source.json", { headers }))
      .status,
    400,
  );
  const token = new URL(url).searchParams.get("session")!;
  const r = await fetch(base + "/idea", {
    method: "POST",
    headers: { ...headers, origin: base, "x-publisher-csrf": token },
    body: JSON.stringify({
      idea: { title: "<script>not executable</script>", notes: "Synthetic" },
    }),
  });
  assert.equal(r.status, 200);
  assert.equal(
    (await f.store.list<any>("ideas"))[0].title,
    "<script>not executable</script>",
  );
});
test("real deck exports PDF, editable PPTX, PNGs, Unicode and immutable revisions", async (t) => {
  const f = await fixture(t);
  const input = deckSchema.parse({
    identity,
    title: "Synthetic launch notes",
    theme: "technical",
    slides: [
      {
        layout: "cover",
        title: "Build something useful.",
        body: "Start small. Learn from the result.",
      },
      {
        layout: "explanation",
        title: "مرحبا بالعالم",
        body: "A Unicode rendering check.",
      },
      {
        layout: "chart",
        title: "Synthetic comparison",
        body: "Example data only.",
        chart: [
          { label: "Before", value: 3 },
          { label: "After", value: 7 },
        ],
        source: "Synthetic fixture, not research.",
      },
    ],
  });
  const d = await f.decks.create(input);
  const out = await f.decks.render(d.id);
  assert.equal(out.slides.length, 3);
  const pdf = await PDFDocument.load(await readFile(out.pdf));
  assert.equal(pdf.getPageCount(), 3);
  const pptx = await JSZip.loadAsync(await readFile(out.pptx));
  assert.match(
    await pptx.file("ppt/slides/slide1.xml")!.async("string"),
    /Build something useful/,
  );
  const v2 = await f.decks.revise(d.id, 1, {
    ...input.slides[0],
    title: "A revised opening.",
  });
  assert.equal(v2.version, 2);
  assert.equal(
    (await f.store.read<any>("decks", d.id)).slides[0].title,
    "Build something useful.",
  );
  const overflow = await f.decks.create(
    deckSchema.parse({
      identity,
      title: "Overflow",
      slides: [{ title: "Test", body: "A very long sentence. ".repeat(100) }],
    }),
  );
  await assert.rejects(f.decks.render(overflow.id), { code: "TEXT_OVERFLOW" });
});

test('dashboard embedded script is syntactically valid JavaScript',async()=>{
 const {dashboardHTML}=await import('../src/dashboard-ui.js');const {Script}=await import('node:vm');const script=dashboardHTML('synthetic-token').match(/<script>([\s\S]*?)<\/script>/)![1];assert.doesNotThrow(()=>new Script(script));
});
