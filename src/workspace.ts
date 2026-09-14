import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { parse } from "csv-parse/sync";
import JSZip from "jszip";
import { z } from "zod";
import { Store, hash } from "./store.js";
import { Fault, type Connection } from "./model.js";
import type { LinkedIn } from "./linkedin.js";
export const sampleSchema = z.object({
  text: z.string().min(1).max(30000),
  source: z.string().max(2000),
  date: z.string().optional(),
  authorship: z
    .enum(["original", "commentary", "reshare", "unknown"])
    .default("unknown"),
  truncated: z.boolean().default(false),
});
export type Sample = z.infer<typeof sampleSchema> & {
  id: string;
  identity: string;
  approved?: boolean;
};
export const voiceSchema = z.object({
  summary: z.string().min(1).max(3000),
  tone: z.array(z.string().max(500)).max(20),
  patterns: z.array(z.string().max(1000)).max(30),
  avoid: z.array(z.string().max(500)).max(30),
  examples: z.array(z.string().max(2000)).max(10),
  evidenceIds: z.array(z.string()).min(1).max(200),
});
export const ideaSchema = z.object({
  title: z.string().min(1).max(200),
  notes: z.string().max(10000).default(""),
  topics: z.array(z.string()).max(20).default([]),
  audience: z.string().max(500).default(""),
  sources: z.array(z.string().max(2000)).max(30).default([]),
  date: z.string().optional(),
});
export class Workspace {
  constructor(
    public store: Store,
    public api?: LinkedIn,
  ) {}
  async consent(identity: string, enabled: boolean) {
    await this.store.write("preferences", hash(identity), {
      identity,
      learning: enabled,
      at: Date.now(),
    });
    return {
      learning: enabled,
      notice:
        "Selected writing samples are processed by your current AI host under its data policies. No additional AI service is used.",
    };
  }
  async ingest(identity: string, items: z.infer<typeof sampleSchema>[]) {
    const pref = await this.store.read<any>("preferences", hash(identity));
    if (!pref?.learning)
      throw new Fault(
        "STYLE_CONSENT_REQUIRED",
        "Ask the user to opt in before processing samples with their current AI host.",
      );
    if (items.length > 1000)
      throw new Fault(
        "IMPORT_TOO_LARGE",
        "Import up to 1000 samples per batch.",
      );
    let added = 0;
    for (const raw of items) {
      const item = sampleSchema.parse(raw),
        id = hash([identity, item.text.trim()]);
      if (!(await this.store.read("samples", id))) {
        await this.store.write("samples", id, {
          ...item,
          id,
          identity,
          importedAt: Date.now(),
        });
        added++;
      }
    }
    return this.status(identity, { added });
  }
  async status(identity: string, extra = {}) {
    const items = (await this.store.list<Sample>("samples")).filter(
      (s) => s.identity === identity,
    );
    const voice = await this.store.read<any>("voices", hash(identity));
    return {
      identity,
      samples: items.length,
      excludedReshares: items.filter((s) => s.authorship === "reshare").length,
      truncated: items.filter((s) => s.truncated).length,
      voice: voice || null,
      coverage:
        "Imported/observed samples only; not a complete account archive unless verified at source.",
      ...extra,
    };
  }
  async samples(identity: string, offset = 0) {
    return (await this.store.list<Sample>("samples"))
      .filter((s) => s.identity === identity && s.authorship !== "reshare")
      .slice(offset, offset + 20);
  }
  async importFile(identity: string, path: string) {
    if ((await stat(path)).size > 50_000_000)
      throw new Fault(
        "IMPORT_TOO_LARGE",
        "Use a Shares CSV or archive under 50 MB.",
      );
    let csv = await readFile(path);
    if (extname(path).toLowerCase() === ".zip") {
      const zip = await JSZip.loadAsync(csv);
      const files = Object.values(zip.files).filter(
        (f) => /(^|\/)shares\.csv$/i.test(f.name) && !f.dir,
      );
      if (files.length !== 1)
        throw new Fault(
          "SHARES_FILE_REQUIRED",
          "Archive must contain exactly one Shares.csv. No other account files will be imported.",
        );
      const stream = files[0].nodeStream();
      const parts: Buffer[] = [];
      let size = 0;
      await new Promise<void>((resolve, reject) => {
        stream.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 25_000_000) {
            stream.pause();
            reject(
              new Fault(
                "IMPORT_TOO_LARGE",
                "Expanded Shares.csv exceeds 25 MB.",
              ),
            );
          } else parts.push(Buffer.from(chunk));
        });
        stream.on("end", resolve);
        stream.on("error", reject);
      });
      csv = Buffer.concat(parts);
    }
    const rows = parse(csv, {
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
      max_record_size: 100000,
    }) as string[][];
    const head = rows.shift()?.map((x) => x.toLowerCase().trim()) || [];
    const textIndex = head.findIndex((x) =>
      [
        "sharecommentary",
        "share commentary",
        "commentary",
        "text",
        "content",
      ].includes(x),
    );
    if (textIndex < 0)
      throw new Fault(
        "CSV_COLUMNS",
        "No commentary/text column found. Export Shares.csv or supply text samples.",
      );
    const dateIndex = head.indexOf("date"),
      urlIndex = head.findIndex((x) =>
        ["sharelink", "share link", "url"].includes(x),
      );
    let added = 0;
    const items = rows
      .filter((r) => r[textIndex]?.trim())
      .map((r) => ({
        text: r[textIndex],
        source:
          urlIndex >= 0
            ? r[urlIndex] || "LinkedIn Shares.csv"
            : "LinkedIn Shares.csv",
        date: dateIndex >= 0 ? r[dateIndex] : undefined,
        authorship: "unknown" as const,
        truncated: false,
      }));
    for (let i = 0; i < items.length; i += 1000) {
      const r = await this.ingest(identity, items.slice(i, i + 1000));
      added += (r as any).added;
    }
    return this.status(identity, {
      added,
      notice:
        "Authorship of archive rows requires review; reshares must not be treated as original writing.",
    });
  }
  async classify(
    identity: string,
    id: string,
    authorship: Sample["authorship"],
  ) {
    const sample = await this.store.read<Sample>("samples", id);
    if (!sample || sample.identity !== identity)
      throw new Fault(
        "SAMPLE_NOT_FOUND",
        "Sample does not belong to this identity.",
      );
    await this.store.write("samples", id, { ...sample, authorship });
    return { id, authorship };
  }
  async historyAccess(connectionId: string) {
    const c = await this.store.read<Connection>("connections", connectionId);
    if (!c) throw new Fault("NOT_CONNECTED", "Connect this account first.");
    return {
      connectionId,
      canRead: c.scopes.includes("r_member_social"),
      next: c.scopes.includes("r_member_social")
        ? "Import permitted member history"
        : "Import Shares.csv, paste samples, or ask the host to review visible posts with its browser tools.",
    };
  }
  async sync(connectionId: string) {
    if (!this.api) throw Error();
    const c = await this.api.connection(connectionId);
    if (!c.member || !c.scopes.includes("r_member_social"))
      throw new Fault(
        "READ_PERMISSION_MISSING",
        "LinkedIn has not granted member history access. Use an export or optional host browser review.",
      );
    const pref = await this.store.read<any>("preferences", hash(c.member));
    if (!pref?.learning)
      throw new Fault(
        "STYLE_CONSENT_REQUIRED",
        "Opt in to style learning first.",
      );
    let start = 0,
      added = 0;
    for (let page = 0; page < 1000; page++) {
      const r = await this.api.json(
        connectionId,
        "/rest/posts?" +
          new URLSearchParams({
            q: "author",
            author: c.member,
            start: String(start),
            count: "100",
            sortBy: "LAST_MODIFIED",
          }),
      );
      const elements = r.elements;
      if (!Array.isArray(elements))
        throw new Fault("INVALID_RESPONSE", "Unexpected history response.");
      const samples = elements
        .filter(
          (p: any) =>
            p.author === c.member &&
            typeof p.commentary === "string" &&
            p.commentary.trim(),
        )
        .map((p: any) => ({
          text: p.commentary,
          source: p.id || "LinkedIn API",
          date: p.createdAt ? new Date(p.createdAt).toISOString() : undefined,
          authorship: p.reshareContext
            ? ("commentary" as const)
            : ("original" as const),
          truncated: false,
        }));
      const outcome = await this.ingest(c.member, samples);
      added += (outcome as any).added;
      start += elements.length;
      if (elements.length < 100)
        return this.status(c.member, {
          added,
          coverage: "API author pagination exhausted at import time.",
        });
    }
    return this.status(c.member, {
      added,
      coverage: "Safety page limit reached; import is incomplete.",
    });
  }
  async saveVoice(identity: string, profile: z.infer<typeof voiceSchema>) {
    return this.store.lock("voice-" + hash(identity), async () => {
      const pref = await this.store.read<any>("preferences", hash(identity));
      if (!pref?.learning)
        throw new Fault("STYLE_CONSENT_REQUIRED", "Voice learning is off.");
      const old = await this.store.read<any>("voices", hash(identity));
      if (old?.frozen)
        throw new Fault(
          "VOICE_FROZEN",
          "Unfreeze the voice before updating it.",
        );
      const v = voiceSchema.parse(profile);
      const all = (await this.store.list<Sample>("samples")).filter(
        (s) =>
          s.identity === identity && s.authorship !== "reshare" && !s.truncated,
      );
      if (v.evidenceIds.some((id) => !all.some((s) => s.id === id)))
        throw new Fault(
          "INVALID_EVIDENCE",
          "Every voice source must refer to an imported sample for this identity.",
        );
      const value = {
        ...v,
        identity,
        version: (old?.version || 0) + 1,
        provisional:
          all.filter((s) => s.authorship === "original" || s.approved).length <
          5,
        updatedAt: Date.now(),
        frozen: false,
      };
      if (old)
        await this.store.write(
          "voice_versions",
          hash([identity, old.version]),
          old,
        );
      await this.store.write("voices", hash(identity), value);
      return value;
    });
  }
  async controlVoice(
    identity: string,
    action: "freeze" | "unfreeze" | "reset" | "export",
  ) {
    return this.store.lock("voice-" + hash(identity), async () => {
      const key = hash(identity),
        v = await this.store.read<any>("voices", key);
      if (action === "reset") {
        await this.store.remove("voices", key);
        for (const s of await this.store.list<Sample>("samples"))
          if (s.identity === identity) await this.store.remove("samples", s.id);
        for (const old of await this.store.list<any>("voice_versions"))
          if (old.identity === identity)
            await this.store.remove(
              "voice_versions",
              hash([identity, old.version]),
            );
        await this.consent(identity, false);
        return { reset: true };
      }
      if (!v) throw new Fault("NO_VOICE", "No saved voice profile.");
      if (action !== "export") {
        v.frozen = action === "freeze";
        await this.store.write("voices", key, v);
      }
      return v;
    });
  }
  async approveDraft(id: string, digest: string, authorization: string) {
    if (!authorization.trim())
      throw new Fault(
        "APPROVAL_REQUIRED",
        "Record the user instruction approving this draft.",
      );
    const d = await this.store.draft(id);
    if (d.digest !== digest)
      throw new Fault("DRAFT_CHANGED", "Review this exact draft first.");
    await this.store.write("approvals", id, {
      draftId: id,
      digest,
      authorization,
      at: Date.now(),
    });
    const pref = await this.store.read<any>("preferences", hash(d.author));
    const voice = await this.store.read<any>("voices", hash(d.author));
    if (pref?.learning && !voice?.frozen && d.text.trim()) {
      await this.ingest(d.author, [
        {
          text: d.text,
          source: "approved-draft:" + id,
          authorship: "original",
          truncated: false,
        },
      ]);
      const sampleId = hash([d.author, d.text.trim()]);
      const s = await this.store.read<Sample>("samples", sampleId);
      await this.store.write("samples", sampleId, { ...s, approved: true });
      return {
        approved: true,
        voiceUpdatePending: true,
        instruction:
          "Analyze approved edits with existing source samples and update the voice profile. Approval is not publication permission.",
      };
    }
    return { approved: true, voiceUpdatePending: false };
  }
  async idea(input: z.infer<typeof ideaSchema>, id = randomUUID()) {
    const value = { ...ideaSchema.parse(input), id, updatedAt: Date.now() };
    await this.store.write("ideas", id, value);
    return value;
  }
}
