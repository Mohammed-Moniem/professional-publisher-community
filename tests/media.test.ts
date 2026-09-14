import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Media, fileHash } from "../src/media.js";
import type { Attachment } from "../src/model.js";
test("multipart video uploads exact ordered ranges and finalizes with returned ETags", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "video-parts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "clip.mp4");
  await writeFile(path, Buffer.from("abcdefghij"));
  const a: Attachment = {
    path,
    storedPath: path,
    title: "Clip",
    hash: await fileHash(path),
    size: 10,
    kind: "video",
    mime: "video/mp4",
    metadata: { durationSeconds: 5 },
  };
  const uploads: string[] = [];
  let finalized: any;
  const api: any = {
    vault: { get: async () => ({ accessToken: "SECRET" }) },
    json: async () => ({
      value: {
        video: "urn:li:video:123",
        uploadToken: "token",
        uploadInstructions: [
          {
            uploadUrl: "https://www.linkedin.com/part1",
            firstByte: 0,
            lastByte: 3,
          },
          {
            uploadUrl: "https://www.linkedin.com/part2",
            firstByte: 4,
            lastByte: 9,
          },
        ],
      },
    }),
    fetcher: async (u: any, i: any) => {
      assert.equal(i.headers.Authorization, undefined);
      let data = "";
      for await (const chunk of i.body) data += chunk.toString();
      uploads.push(data);
      return new Response("", { headers: { etag: "etag" + uploads.length } });
    },
    request: async (_c: any, _p: any, _m: any, body: any) => {
      finalized = body;
      return new Response("");
    },
  };
  assert.equal(
    await new Media(api).upload("test", "urn:li:person:123", a),
    "urn:li:video:123",
  );
  assert.deepEqual(uploads, ["abcd", "efghij"]);
  assert.deepEqual(finalized, {
    finalizeUploadRequest: {
      video: "urn:li:video:123",
      uploadToken: "token",
      uploadedPartIds: ["etag1", "etag2"],
    },
  });
});
test("media mutation after review is rejected before network", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "media-change-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "file");
  await writeFile(path, "original");
  const hash = await fileHash(path);
  await writeFile(path, "changed");
  await assert.rejects(
    () =>
      new Media({} as any).upload("test", "urn:li:person:123", {
        storedPath: path,
        hash,
      } as any),
    { code: "ATTACHMENT_CHANGED" },
  );
});

test("real MP4 metadata validation accepts a valid clip and rejects a short clip", async (t) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { Store } = await import("../src/store.js");
  const { snapshot } = await import("../src/media.js");
  const exec = promisify(execFile);
  const root = await mkdtemp(join(tmpdir(), "real-video-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "state"));
  const path = join(root, "clip.mp4");
  await exec(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x240:rate=24",
      "-t",
      "4",
      "-c:v",
      "mpeg4",
      "-q:v",
      "2",
      "-y",
      path,
    ],
    { timeout: 30_000 },
  );
  const a = await snapshot(store, { path, title: "Test clip" });
  assert.equal(a.kind, "video");
  assert.equal(a.metadata.durationSeconds, 4);
  await exec(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=640x480:rate=24",
      "-t",
      "1",
      "-c:v",
      "mpeg4",
      "-q:v",
      "1",
      "-y",
      path,
    ],
    { timeout: 30_000 },
  );
  await assert.rejects(() => snapshot(store, { path, title: "Too short" }), {
    code: "VIDEO_DURATION",
  });
});
