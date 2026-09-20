import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Store } from "./store.js";
import { Publisher } from "./publisher.js";
import { Fault, publicError } from "./model.js";
import { Notifications } from "./notifications.js";
export const scheduleSchema = z.object({
  draftId: z.string().uuid(),
  reviewDigest: z.string().regex(/^[a-f0-9]{64}$/),
  authorization: z.string().min(1).max(2000),
  at: z.string().datetime({ offset: true }),
  timeZone: z.string().min(1),
});
export type Job = z.infer<typeof scheduleSchema> & {
  id: string;
  dueAt: number;
  state:
    | "scheduled"
    | "running"
    | "published"
    | "missed"
    | "needs_attention"
    | "cancelled"
    | "uncertain";
  createdAt: number;
  error?: unknown;
  result?: unknown;
};
export class Scheduler {
  constructor(
    public store: Store,
    public publisher: Publisher,
    public now = () => Date.now(),
    public notifications = new Notifications(store),
  ) {}
  async reschedule(id: string, raw: z.infer<typeof scheduleSchema>) {
    const input = scheduleSchema.parse(raw);
    // The common validator performs all time-zone and exact-draft checks.
    const dueAt = await this.validate(input);
    return this.store.lock("schedule-" + id, async () => {
      const job = await this.store.read<Job>("schedules", id);
      if (!job || job.state !== "scheduled" || job.draftId !== input.draftId)
        throw new Fault(
          "CANNOT_RESCHEDULE",
          "Only a pending schedule for the same reviewed draft can be moved.",
        );
      const next = { ...job, ...input, dueAt, rescheduledAt: this.now() };
      await this.store.write("schedules", id, next);
      return next;
    });
  }
  async schedule(raw: z.infer<typeof scheduleSchema>) {
    const input = scheduleSchema.parse(raw);
    const dueAt = await this.validate(input);
    const d = await this.store.draft(input.draftId);
    return this.store.lock("schedule-draft-" + d.id, async () => {
      const existing = (await this.store.list<Job>("schedules")).find(
        (j) =>
          j.draftId === d.id &&
          ["scheduled", "running", "uncertain"].includes(j.state),
      );
      if (existing) {
        if (
          existing.dueAt === dueAt &&
          existing.reviewDigest === input.reviewDigest
        )
          return existing;
        throw new Fault(
          "ALREADY_SCHEDULED",
          "Cancel or explicitly reschedule the existing job.",
        );
      }
      const job: Job = {
        ...input,
        id: randomUUID(),
        dueAt,
        state: "scheduled",
        createdAt: this.now(),
      };
      await this.store.write("schedules", job.id, job);
      return job;
    });
  }
  private async validate(input: z.infer<typeof scheduleSchema>) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: input.timeZone }).format();
    } catch {
      throw new Fault("INVALID_TIMEZONE", "Use an IANA time zone.");
    }
    const dueAt = Date.parse(input.at);
    const zoneOffset =
      new Intl.DateTimeFormat("en", {
        timeZone: input.timeZone,
        timeZoneName: "longOffset",
      })
        .formatToParts(new Date(dueAt))
        .find((p) => p.type === "timeZoneName")!
        .value.replace("GMT", "") || "+00:00";
    const supplied = input.at.endsWith("Z") ? "+00:00" : input.at.slice(-6);
    if (zoneOffset !== supplied)
      throw new Fault(
        "TIMEZONE_OFFSET_MISMATCH",
        "The UTC offset does not match this IANA time zone on the selected date. Resolve the local time and review it again.",
      );

    if (dueAt <= this.now())
      throw new Fault(
        "PAST_SCHEDULE",
        "Choose a future time with an explicit UTC offset.",
      );
    if (dueAt % 60000 !== 0)
      throw new Fault(
        "MINUTE_PRECISION",
        "Schedule at a whole minute, with seconds set to zero.",
      );
    const d = await this.store.draft(input.draftId);
    if (d.digest !== input.reviewDigest)
      throw new Fault("DRAFT_CHANGED", "Review the current draft.");
    if (!["draft", "rejected"].includes(d.state))
      throw new Fault(
        "UNSAFE_DRAFT",
        "Published or uncertain drafts cannot be scheduled.",
      );
    return dueAt;
  }
  async cancel(id: string) {
    return this.store.lock("schedule-" + id, async () => {
      const job = await this.store.read<Job>("schedules", id);
      if (!job) throw new Fault("SCHEDULE_NOT_FOUND", "Schedule not found.");
      if (["published", "running", "uncertain"].includes(job.state))
        throw new Fault(
          "CANNOT_CANCEL",
          "Publication may have started. Inspect the draft receipt.",
        );
      job.state = "cancelled";
      await this.store.write("schedules", id, job);
      return job;
    });
  }
  async tick() {
    const outcomes = [];
    for (const snapshot of await this.store.list<Job>("schedules")) {
      if (
        !["scheduled", "running"].includes(snapshot.state) ||
        snapshot.dueAt > this.now()
      )
        continue;
      try {
        const outcome = await this.store.lock(
          "schedule-" + snapshot.id,
          async () => {
            const job = (await this.store.read<Job>("schedules", snapshot.id))!;
            if (!["scheduled", "running"].includes(job.state)) return job;
            const draft = await this.store.draft(job.draftId);
            if (draft.state === "published") {
              job.state = "published";
              job.result = draft.result;
            } else if (["publishing", "uncertain"].includes(draft.state)) {
              job.state = "uncertain";
            } else if (job.state === "running") {
              job.state = "needs_attention";
              job.error = {
                code: "INTERRUPTED",
                message:
                  "Worker interrupted. Explicitly reschedule; no automatic retry.",
              };
            } else if (this.now() >= job.dueAt + 60000) {
              job.state = "missed";
            } else {
              job.state = "running";
              await this.store.write("schedules", job.id, job);
              try {
                await this.publisher.upload(job.draftId);
                const result = await this.publisher.publish(
                  job.draftId,
                  job.reviewDigest,
                  job.authorization,
                  () => {
                    if (this.now() >= job.dueAt + 60000)
                      throw new Fault(
                        "SCHEDULE_MISSED",
                        "Approved minute has elapsed. Reschedule explicitly.",
                      );
                  },
                );
                job.state =
                  result.error?.code === "SCHEDULE_MISSED"
                    ? "missed"
                    : result.state === "published"
                      ? "published"
                      : result.state === "uncertain"
                        ? "uncertain"
                        : "needs_attention";
                job.result = result.result;
                job.error = result.error;
              } catch (e) {
                job.error = publicError(e);
                job.state =
                  e instanceof Fault && e.code === "SCHEDULE_MISSED"
                    ? "missed"
                    : "needs_attention";
              }
            }
            await this.store.write("schedules", job.id, job);
            await this.store.write("notifications", job.id, {
              id: job.id,
              state: job.state,
              at: this.now(),
              message: `Scheduled post ${job.state}.`,
              error: job.error,
            });
            return job;
          },
        );
        outcomes.push(outcome);
        await this.notifications.deliver(snapshot.id);
      } catch (e) {
        if (!(e instanceof Fault && e.code === "BUSY")) throw e;
      }
    }
    return outcomes;
  }
}
