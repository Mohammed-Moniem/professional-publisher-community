import { z } from "zod";
import { Publisher } from "./publisher.js";
import { Fault, draftInput, type DraftInput } from "./model.js";
export const checksSchema = z.object({
  sources: z.array(z.string().max(2000)).max(30),
  factsChecked: z.boolean(),
  attachmentsChecked: z.boolean(),
  destinationChecked: z.boolean(),
});
export class Review {
  constructor(public publisher: Publisher) {}
  async revise(id: string, digest: string, raw: DraftInput) {
    const parent = await this.publisher.store.draft(id);
    if (parent.digest !== digest)
      throw new Fault("DRAFT_CHANGED", "Review the current draft first.");
    if (["publishing", "uncertain"].includes(parent.state))
      throw new Fault(
        "DRAFT_LOCKED",
        "Resolve this uncertain submission before creating a revision. Do not evade duplicate prevention.",
      );
    const existingIds = new Set(
      (await this.publisher.store.list<any>("drafts")).map((d) => d.id),
    );
    const result = await this.publisher.prepare(draftInput.parse(raw));
    if (
      result.id !== id &&
      !existingIds.has(result.id) &&
      !(await this.publisher.store.read("draft_revisions", result.id))
    )
      await this.publisher.store.write("draft_revisions", result.id, {
        id: result.id,
        parentId: id,
        at: Date.now(),
      });
    return result;
  }
  async check(id: string, digest: string, raw: z.infer<typeof checksSchema>) {
    const d = await this.publisher.store.draft(id);
    if (d.digest !== digest)
      throw new Fault("DRAFT_CHANGED", "Review the exact draft first.");
    const value = { ...checksSchema.parse(raw), id, digest, at: Date.now() };
    await this.publisher.store.write("review_checks", id, value);
    return value;
  }
  async publish(id: string, digest: string, authorization: string) {
    const checks = await this.publisher.store.read<any>("review_checks", id);
    if (
      checks?.digest !== digest ||
      !checks.factsChecked ||
      !checks.attachmentsChecked ||
      !checks.destinationChecked
    )
      throw new Fault(
        "REVIEW_REQUIRED",
        "Check facts, attachments and destination for this exact draft before publishing from the dashboard.",
      );
    if (!authorization.trim())
      throw new Fault(
        "APPROVAL_REQUIRED",
        "Explicit publication approval is required.",
      );
    const d = await this.publisher.store.draft(id);
    if (d.digest !== digest)
      throw new Fault("DRAFT_CHANGED", "Review the exact draft first.");
    if (d.state === "published") return this.publisher.inspect(id);
    const upload = await this.publisher.upload(id);
    if (!upload.mediaReady) return upload;
    return this.publisher.publish(id, digest, authorization);
  }
}
