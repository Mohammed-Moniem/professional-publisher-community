import { z } from "zod";
import { Store, hash } from "./store.js";
import { Fault, authorUrn } from "./model.js";
import type { Sample } from "./workspace.js";
export const ruleSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  instruction: z.string().min(1).max(1000),
  kind: z.enum(["prefer", "avoid"]),
  origin: z.enum(["observed", "manual"]),
  enabled: z.boolean(),
  evidenceIds: z.array(z.string()).max(200),
});
export const studioSchema = z.object({
  rules: z.array(ruleSchema).max(50),
  expectedVersion: z.number().int().min(0),
});
export const comparisonSchema = z.object({
  brief: z.string().min(1).max(3000),
  generic: z.string().max(3000),
  current: z.string().max(3000),
  revised: z.string().max(3000),
  preferred: z.enum(["generic", "current", "revised", "none"]),
  feedback: z.string().max(3000),
});
export class VoiceStudio {
  constructor(public store: Store) {}
  private async samples(identity: string) {
    return (await this.store.list<Sample>("samples")).filter(
      (s) =>
        s.identity === identity &&
        !s.truncated &&
        ["original", "commentary"].includes(s.authorship),
    );
  }
  private heldOut(s: Sample) {
    return parseInt(s.id.slice(-2), 16) % 5 === 0 && !s.approved;
  }
  async inspect(raw: string) {
    const identity = authorUrn.parse(raw),
      samples = await this.samples(identity);
    const profile = await this.store.read<any>("voice_studio", hash(identity));
    return {
      identity,
      version: profile?.version || 0,
      frozen:
        profile?.frozen ||
        (await this.store.read<any>("voices", hash(identity)))?.frozen ||
        false,
      rules: (profile?.rules || []).map((r: any) => {
        const evidence = samples.filter(
          (s) => r.evidenceIds.includes(s.id) && !this.heldOut(s),
        );
        return {
          ...r,
          evidence,
          supportingSamples: evidence.length,
          basis:
            r.origin === "manual"
              ? "User preference"
              : evidence.length < 5
                ? "Limited evidence"
                : "Supported by at least five samples",
        };
      }),
      trainingSamples: samples.filter((s) => !this.heldOut(s)),
      heldOutSampleCount: samples.filter((s) => this.heldOut(s)).length,
      comparisons: (await this.store.list<any>("voice_comparisons")).filter(
        (v) => v.identity === identity,
      ),
      notice:
        "Evidence counts are not accuracy scores. Held-out samples are reserved for evaluation; do not train rules on them.",
    };
  }
  async save(raw: string, input: z.infer<typeof studioSchema>) {
    const identity = authorUrn.parse(raw),
      value = studioSchema.parse(input);
    return this.store.lock("voice-" + hash(identity), async () => {
      const old = await this.store.read<any>("voice_studio", hash(identity));
      const legacy = await this.store.read<any>("voices", hash(identity));
      if (legacy?.frozen || old?.frozen)
        throw new Fault(
          "VOICE_FROZEN",
          "Unfreeze this voice before changing its rules.",
        );
      if ((old?.version || 0) !== value.expectedVersion)
        throw new Fault(
          "VOICE_CHANGED",
          "Reload the latest voice rules before saving.",
        );
      if (new Set(value.rules.map((r) => r.id)).size !== value.rules.length)
        throw new Fault("DUPLICATE_RULE", "Each rule needs a unique ID.");
      const allowed = (await this.samples(identity)).filter(
        (s) => !this.heldOut(s),
      );
      for (const r of value.rules) {
        r.evidenceIds = [...new Set(r.evidenceIds)];
        if (
          (r.origin === "observed" && !r.evidenceIds.length) ||
          r.evidenceIds.some((id) => !allowed.some((s) => s.id === id))
        )
          throw new Fault(
            "INVALID_EVIDENCE",
            "Use eligible training samples belonging to this identity. Manual preferences may have no samples.",
          );
      }
      const result = {
        identity,
        rules: value.rules,
        version: value.expectedVersion + 1,
        at: Date.now(),
      };
      if (old)
        await this.store.write(
          "studio_versions",
          hash([identity, old.version]),
          old,
        );
      await this.store.write("voice_studio", hash(identity), result);
      return result;
    });
  }
  async compare(identity: string, raw: z.infer<typeof comparisonSchema>) {
    authorUrn.parse(identity);
    const comparison = comparisonSchema.parse(raw);
    const profile = await this.store.read<any>("voice_studio", hash(identity));
    const id = hash([identity, profile?.version || 0, comparison]);
    const value = {
      ...comparison,
      id,
      identity,
      version: profile?.version || 0,
      at: Date.now(),
    };
    await this.store.write("voice_comparisons", id, value);
    return value;
  }
  async evaluation(identity: string) {
    authorUrn.parse(identity);
    return {
      samples: (await this.samples(identity)).filter((s) => this.heldOut(s)),
      instruction:
        "Compare saved rules against these held-out examples. Report disagreements and counts; do not invent an accuracy percentage or use these samples to save rules.",
    };
  }
}
