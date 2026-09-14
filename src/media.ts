import {
  open,
  readFile,
  copyFile,
  rename,
  unlink,
  chmod,
  stat,
} from "node:fs/promises";
import { createReadStream, constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp, { type Metadata } from "sharp";
import { PDFDocument } from "pdf-lib";
import { Fault, type Attachment, type DraftInput } from "./model.js";
import { httpFault, type LinkedIn } from "./linkedin.js";
import type { Store } from "./store.js";
const exec = promisify(execFile);
export async function fileHash(path: string) {
  const h = createHash("sha256");
  for await (const part of createReadStream(path)) h.update(part);
  return h.digest("hex");
}
export async function snapshot(
  store: Store,
  input: DraftInput["attachments"][number],
): Promise<Attachment> {
  await store.init();
  const f = await open(input.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const tmp = join(store.root, "media", randomUUID());
  try {
    const s = await f.stat();
    if (!s.isFile() || s.size === 0 || s.size > 500_000_000)
      throw new Fault(
        "INVALID_ATTACHMENT",
        "Attachment must be a nonempty regular file no larger than 500 MB.",
      );
    // Copy from the open descriptor: replacing the source path cannot change the snapshot.
    const dest = await open(tmp, "wx", 0o600);
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      let copied = 0;
      for (;;) {
        const { bytesRead } = await f.read(buffer);
        if (!bytesRead) break;
        copied += bytesRead;
        if (copied > 500_000_000)
          throw new Fault(
            "INVALID_ATTACHMENT",
            "Attachment grew beyond the size limit.",
          );
        await dest.write(buffer.subarray(0, bytesRead));
      }
      await dest.sync();
    } finally {
      await dest.close();
    }
    const size = (await stat(tmp)).size;
    const head = await open(tmp, "r");
    const signature = Buffer.alloc(16);
    try {
      await head.read(signature, 0, 16, 0);
    } finally {
      await head.close();
    }
    let kind: Attachment["kind"],
      mime: string,
      metadata: Attachment["metadata"];
    if (signature.subarray(0, 5).toString() === "%PDF-") {
      kind = "document";
      mime = "application/pdf";
      if (size > 100_000_000)
        throw new Fault("DOCUMENT_TOO_LARGE", "PDFs must be at most 100 MB.");
      let pdf: PDFDocument;
      try {
        pdf = await PDFDocument.load(await readFile(tmp));
      } catch {
        throw new Fault("INVALID_PDF", "PDF must be valid and unencrypted.");
      }
      const pages = pdf.getPageCount();
      if (pages < 1 || pages > 300)
        throw new Fault(
          "DOCUMENT_PAGE_LIMIT",
          "PDFs must contain 1–300 pages.",
        );
      metadata = { pages };
    } else if (signature.subarray(4, 8).toString() === "ftyp") {
      kind = "video";
      mime = "video/mp4";
      if (size < 75_000)
        throw new Fault("VIDEO_TOO_SMALL", "Videos must be at least 75 KB.");
      let info: any;
      try {
        const r = await exec(
          "ffprobe",
          [
            "-v",
            "error",
            "-protocol_whitelist",
            "file",
            "-show_entries",
            "format=duration,format_name:stream=codec_type",
            "-of",
            "json",
            tmp,
          ],
          { timeout: 30_000, maxBuffer: 1_000_000 },
        );
        info = JSON.parse(r.stdout);
      } catch {
        throw new Fault(
          "VIDEO_PROBE_FAILED",
          "A valid MP4 and local ffprobe are required to validate duration.",
        );
      }
      const duration = Number(info.format?.duration);
      if (
        !info.streams?.some((x: any) => x.codec_type === "video") ||
        !Number.isFinite(duration) ||
        duration < 3 ||
        duration > 1800
      )
        throw new Fault(
          "VIDEO_DURATION",
          "MP4 videos must contain a video track and last 3 seconds to 30 minutes.",
        );
      metadata = { durationSeconds: duration };
    } else {
      kind = "image";
      let m: Metadata;
      try {
        m = await sharp(tmp, {
          animated: true,
          limitInputPixels: 36_152_319,
        }).metadata();
      } catch {
        throw new Fault(
          "INVALID_IMAGE",
          "Images must be valid JPG, PNG, or GIF files.",
        );
      }
      if (!["jpeg", "png", "gif"].includes(m.format) || !m.width || !m.height)
        throw new Fault("INVALID_IMAGE", "Images must be JPG, PNG, or GIF.");
      const height = m.pageHeight ?? m.height;
      if (m.width * height >= 36_152_320 || (m.pages ?? 1) > 250)
        throw new Fault(
          "IMAGE_LIMIT",
          "Images must have fewer than 36,152,320 pixels and GIFs at most 250 frames.",
        );
      if (size > 20_000_000)
        throw new Fault(
          "IMAGE_SIZE_LIMIT",
          "This plugin accepts images up to 20 MB.",
        );
      mime = "image/" + (m.format === "jpeg" ? "jpeg" : m.format);
      metadata = { width: m.width, height, frames: m.pages ?? 1 };
    }
    const hash = await fileHash(tmp);
    const storedPath = join(store.root, "media", hash);
    await rename(tmp, storedPath);
    await chmod(storedPath, 0o600);
    return { ...input, kind, mime, metadata, size, hash, storedPath };
  } finally {
    await f.close();
    await unlink(tmp).catch(() => {});
  }
}
export function validateUploadUrl(raw: string) {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Fault(
      "INVALID_UPLOAD_URL",
      "LinkedIn returned an invalid upload URL.",
    );
  }
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.port ||
    !["linkedin.com", "licdn.com"].some(
      (d) => u.hostname === d || u.hostname.endsWith("." + d),
    )
  )
    throw new Fault(
      "INVALID_UPLOAD_URL",
      "Upload destination is outside LinkedIn’s allowed HTTPS domains.",
    );
  return u;
}
export class Media {
  constructor(public api: LinkedIn) {}
  async upload(
    connectionId: string,
    owner: string,
    a: Attachment,
  ): Promise<string> {
    if ((await fileHash(a.storedPath)) !== a.hash)
      throw new Fault(
        "ATTACHMENT_CHANGED",
        "The local media snapshot changed. Prepare and review a new draft.",
      );
    const resource =
      a.kind === "image"
        ? "images"
        : a.kind === "video"
          ? "videos"
          : "documents";
    const init = await this.api.json(
      connectionId,
      `/rest/${resource}?action=initializeUpload`,
      "POST",
      {
        initializeUploadRequest: {
          owner,
          ...(a.kind === "video"
            ? {
                fileSizeBytes: a.size,
                uploadCaptions: false,
                uploadThumbnail: false,
              }
            : {}),
        },
      },
    );
    const v = init.value;
    const asset = v?.[a.kind];
    if (typeof asset !== "string" || !asset.startsWith(`urn:li:${a.kind}:`))
      throw new Fault(
        "INVALID_RESPONSE",
        "LinkedIn did not return a valid media identifier.",
      );
    if (a.kind === "video") {
      if (
        !Array.isArray(v.uploadInstructions) ||
        v.uploadInstructions.length === 0
      )
        throw new Fault(
          "INVALID_RESPONSE",
          "LinkedIn did not return video upload parts.",
        );
      let next = 0;
      const ids: string[] = [];
      for (const part of v.uploadInstructions) {
        if (
          part.firstByte !== next ||
          !Number.isSafeInteger(part.lastByte) ||
          part.lastByte < next ||
          part.lastByte >= a.size
        )
          throw new Fault(
            "INVALID_RESPONSE",
            "LinkedIn returned invalid video part boundaries.",
          );
        next = part.lastByte + 1;
        const r = await this.put(
          part.uploadUrl,
          a,
          part.firstByte,
          part.lastByte,
          connectionId,
        );
        const etag = r.headers.get("etag");
        if (!etag)
          throw new Fault(
            "MISSING_UPLOAD_ETAG",
            "Video part response has no ETag; publication is blocked.",
          );
        ids.push(etag);
      }
      if (next !== a.size)
        throw new Fault(
          "INCOMPLETE_UPLOAD",
          "LinkedIn video parts do not cover the entire file.",
        );
      await this.api.request(
        connectionId,
        "/rest/videos?action=finalizeUpload",
        "POST",
        {
          finalizeUploadRequest: {
            video: asset,
            uploadToken: v.uploadToken ?? "",
            uploadedPartIds: ids,
          },
        },
      );
    } else await this.put(v.uploadUrl, a, 0, a.size - 1, connectionId);
    return asset;
  }
  async put(
    raw: string,
    a: Attachment,
    start: number,
    end: number,
    connectionId: string,
  ) {
    const u = validateUploadUrl(raw);
    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(end - start + 1),
    };
    // Signed URLs carry their own authorization. Bearer is only sent to the API origin.
    if (u.hostname === "api.linkedin.com") {
      const s = await this.api.vault.get(connectionId);
      if (!s?.accessToken)
        throw new Fault("RECONNECT_REQUIRED", "Reconnect before uploading.");
      headers.Authorization = "Bearer " + s.accessToken;
    }
    const stream = createReadStream(a.storedPath, { start, end });
    try {
      const r = await this.api.fetcher(u, {
        method: "PUT",
        headers,
        body: stream as any,
        duplex: "half",
        redirect: "error",
        signal: AbortSignal.timeout(120_000),
      } as any);
      if (!r.ok) {
        await r.body?.cancel();
        throw httpFault(r.status);
      }
      await r.body?.cancel();
      return r;
    } catch (e) {
      if (e instanceof Fault) throw e;
      throw new Fault(
        "UPLOAD_FAILED",
        "Media upload failed. The draft has not been published.",
      );
    } finally {
      stream.destroy();
    }
  }
  async ready(connectionId: string, owner: string, a: Attachment) {
    if (!a.asset) return false;
    const resource =
      a.kind === "image"
        ? "images"
        : a.kind === "video"
          ? "videos"
          : "documents"; // Official Images docs allow legacy GET for member write-only tokens.
    const versioned = !(
      a.kind === "image" && owner.startsWith("urn:li:person:")
    );
    const r = await this.api.json(
      connectionId,
      `/rest/${resource}/${encodeURIComponent(a.asset)}`,
      "GET",
      undefined,
      versioned,
    );
    if (r.status === "AVAILABLE") return true;
    if (r.status === "PROCESSING_FAILED")
      throw new Fault(
        "MEDIA_PROCESSING_FAILED",
        "LinkedIn could not process an attachment. Prepare a new draft with corrected media.",
      );
    return false;
  }
}
