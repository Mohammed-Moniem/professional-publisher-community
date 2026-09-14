import { randomUUID } from "node:crypto";
import { Store, hash } from "./store.js";
import { LinkedIn } from "./linkedin.js";
import { Media, snapshot, fileHash } from "./media.js";
import {
  draftInput,
  escapeText,
  formats,
  Fault,
  publicError,
  type Draft,
  type DraftInput,
  type Format,
  type Connection,
  type Evidence,
  type Attachment,
} from "./model.js";
export class Publisher {
  constructor(
    public store: Store,
    public api: LinkedIn,
    public media = new Media(api),
  ) {}
  async prepare(raw: DraftInput) {
    const input = draftInput.parse(raw);
    if (!input.text.trim() && !input.attachments.length && !input.link)
      throw new Fault("EMPTY_POST", "Add text, a link, or an attachment.");
    if (
      input.link &&
      !["https:", "http:"].includes(new URL(input.link.url).protocol)
    )
      throw new Fault("INVALID_LINK", "Post links must use HTTP or HTTPS.");
    if (input.link && input.attachments.length)
      throw new Fault(
        "MIXED_FORMATS",
        "A link card and media attachments cannot share one post. Put the link in the text instead.",
      );
    const attachments: Attachment[] = [];
    for (const a of input.attachments)
      attachments.push(await snapshot(this.store, a));
    const kinds = new Set(attachments.map((a) => a.kind));
    if (
      kinds.size > 1 ||
      (attachments.length > 1 && attachments[0].kind !== "image")
    )
      throw new Fault(
        "MIXED_FORMATS",
        "Use up to 20 images, one video, or one PDF per post.",
      );
    const format: Format = input.link
      ? "link"
      : attachments.length > 1
        ? "multiImage"
        : (attachments[0]?.kind ?? "text");
    const digest = hash({
      connectionId: input.connectionId,
      author: input.author,
      text: input.text,
      link: input.link,
      attachments: attachments.map((a) => ({
        hash: a.hash,
        title: a.title,
        altText: a.altText,
      })),
    });
    // Identical preparation returns the original, including uncertain/published outcomes.
    return this.store.lock("prepare-" + digest, async () => {
      const existing = (await this.store.list<Draft>("drafts")).find(
        (d) => d.digest === digest,
      );
      if (existing) return this.preview(existing);
      const d: Draft = {
        ...input,
        attachments,
        format,
        digest,
        id: randomUUID(),
        createdAt: Date.now(),
        state: "draft",
      };
      await this.store.write("drafts", d.id, d);
      return this.preview(d);
    });
  }
  preview(d: Draft) {
    return {
      ...d,
      attachments: d.attachments.map(({ storedPath, ...a }) => ({
        ...a,
        previewPath: storedPath,
      })),
      reviewDigest: d.digest,
      visibility: "PUBLIC",
      notice:
        "Preview is the exact intended content, not a rendering from LinkedIn. @names are plain text. Publishing requires an explicit user instruction for this draft and destination.",
    };
  }
  async inspect(id: string) {
    return this.preview(await this.store.draft(id));
  }
  async capabilities() {
    const connections = await this.store.list<Connection>("connections");
    const evidence = await this.store.list<Evidence>("evidence");
    const result = [];
    for (const saved of connections) {
      let c = saved;
      let ready = !c.revoked && c.expiresAt > Date.now() + 60_000;
      let identities: any[] = [];
      let issue: unknown;
      try {
        c = await this.api.connection(c.id);
        identities = await this.api.identities(c.id);
        ready = !c.revoked && c.expiresAt > Date.now() + 60_000;
      } catch (e) {
        issue = publicError(e);
      }
      result.push({
        ...c,
        connected: ready,
        issue,
        identities: identities.map((i) => ({
          ...i,
          formats: Object.fromEntries(
            formats.map((format) => {
              const e = evidence.find(
                (e) =>
                  e.connectionId === c.id &&
                  e.author === i.author &&
                  e.format === format &&
                  e.at >= c.connectedAt,
              );
              const scope =
                i.kind === "person"
                  ? "w_member_social"
                  : "w_organization_social";
              return [
                format,
                !ready
                  ? { status: "reconnect_required" }
                  : !c.scopes.includes(scope)
                    ? { status: "missing_permission", permission: scope }
                    : e
                      ? {
                          status:
                            e.status === "published"
                              ? "live_verified"
                              : "restricted",
                          at: e.at,
                          reason: e.reason,
                        }
                      : {
                          status: "eligible_unverified",
                          note: "Permission present; this format has not been published successfully with this connection.",
                        },
              ];
            }),
          ),
        })),
      });
    }
    return {
      connections: result,
      configured: connections.length > 0,
      apiVersion: "202608",
      note: "Capabilities are based on granted scopes, current page roles, and observed results. No test posts are created by this check.",
    };
  }
  async guard(d: Draft) {
    await this.api.assertAuthor(d.connectionId, d.author);
    const c = await this.store.connection(d.connectionId);
    const e = await this.store.read<Evidence>(
      "evidence",
      hash([d.connectionId, d.author, d.format]),
    );
    if (e?.status === "restricted" && e.at >= c.connectedAt)
      throw new Fault(
        "FORMAT_RESTRICTED",
        "LinkedIn previously denied this format for this identity. Correct permissions and reconnect before retrying.",
      );
  }
  async recordRestriction(d: Draft, e: unknown) {
    if (e instanceof Fault && e.status === 403)
      await this.store.evidence({
        connectionId: d.connectionId,
        author: d.author,
        format: d.format,
        status: "restricted",
        at: Date.now(),
        reason: e.message,
      });
  }
  async upload(id: string) {
    return this.store.lock(id, async () => {
      const d = await this.store.draft(id);
      this.mutable(d);
      await this.guard(d);
      try {
        let processing = false;
        for (const a of d.attachments) {
          if (!a.asset) {
            a.asset = await this.media.upload(d.connectionId, d.author, a);
            a.uploadState = "PROCESSING";
            await this.store.write("drafts", d.id, d);
          }
          if (await this.media.ready(d.connectionId, d.author, a))
            a.uploadState = "AVAILABLE";
          else processing = true;
          await this.store.write("drafts", d.id, d);
        }
        return {
          ...this.preview(d),
          mediaReady: !processing,
          nextAction: processing
            ? "Media is processing. Call upload_draft again to check existing assets; do not publish yet."
            : "Media is ready. Publish only on explicit user instruction.",
        };
      } catch (e) {
        await this.recordRestriction(d, e);
        throw e;
      }
    });
  }
  private mutable(d: Draft) {
    if (["publishing", "published", "uncertain"].includes(d.state))
      throw new Fault(
        "DRAFT_LOCKED",
        "This draft was submitted or may have been submitted. Inspect the saved result; do not repost.",
      );
  }
  async publish(
    id: string,
    reviewDigest: string,
    authorization: string,
    beforeSubmit?: () => void,
  ) {
    return this.store.lock(id, async () => {
      const d = await this.store.draft(id);
      if (d.digest !== reviewDigest)
        throw new Fault(
          "REVIEW_CHANGED",
          "Review the current draft before publishing.",
        );
      if (!authorization.trim())
        throw new Fault(
          "AUTHORIZATION_REQUIRED",
          "An explicit user instruction to publish this draft is required.",
        );
      if (d.state === "published") return this.preview(d);
      if (d.state === "publishing") {
        d.state = "uncertain";
        d.error = {
          code: "INTERRUPTED_SUBMISSION",
          message:
            "A previous submission was interrupted. Its outcome is unknown; automatic reposting is blocked.",
        };
        await this.store.write("drafts", d.id, d);
      }
      this.mutable(d);
      await this.guard(d);
      try {
        for (const a of d.attachments) {
          if ((await fileHash(a.storedPath)) !== a.hash)
            throw new Fault(
              "ATTACHMENT_CHANGED",
              "Media changed since preview. Prepare a new draft.",
            );
          if (
            !a.asset ||
            !(await this.media.ready(d.connectionId, d.author, a))
          )
            throw new Fault(
              "MEDIA_NOT_READY",
              "Upload attachments and wait until LinkedIn reports AVAILABLE before publishing.",
            );
        }
      } catch (e) {
        await this.recordRestriction(d, e);
        throw e;
      }
      beforeSubmit?.();
      const body = postBody(d);
      d.state = "publishing";
      delete d.error;
      await this.store.write("drafts", d.id, d); // durable before any network side effect
      let response: Response;
      try {
        response = await this.api.request(
          d.connectionId,
          "/rest/posts",
          "POST",
          body,
          true,
          beforeSubmit,
        );
      } catch (e) {
        const f = e instanceof Fault ? e : undefined;
        const rejected =
          f?.code === "SCHEDULE_MISSED" ||
          (f?.status !== undefined &&
            f.status >= 400 &&
            f.status < 500 &&
            ![408, 409].includes(f.status));
        d.state = rejected ? "rejected" : "uncertain";
        d.error = publicError(e);
        await this.store.write("drafts", d.id, d);
        await this.recordRestriction(d, e);
        return this.preview(d);
      }
      const urn = response.headers.get("x-restli-id");
      await response.body?.cancel();
      if (
        response.status !== 201 ||
        !urn ||
        !/^urn:li:(share|ugcPost):\d+$/.test(urn)
      ) {
        d.state = "uncertain";
        d.error = {
          code: "MISSING_POST_RECEIPT",
          message:
            "LinkedIn accepted a request without a usable post receipt. Do not repost.",
        };
        await this.store.write("drafts", d.id, d);
        return this.preview(d);
      }
      d.state = "published";
      d.result = {
        postUrn: urn,
        url: `https://www.linkedin.com/feed/update/${urn}/`,
        publishedAt: Date.now(),
        verified: "api_accepted",
      };
      await this.store.write("drafts", d.id, d);
      await this.store.evidence({
        connectionId: d.connectionId,
        author: d.author,
        format: d.format,
        status: "published",
        at: Date.now(),
      });
      return this.preview(d);
    });
  }
  async history() {
    return (await this.store.list<Draft>("drafts"))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((d) => ({
        id: d.id,
        author: d.author,
        connectionId: d.connectionId,
        format: d.format,
        state: d.state,
        result: d.result,
        error: d.error,
        createdAt: d.createdAt,
      }));
  }
}
export function postBody(d: Draft) {
  let content: unknown;
  if (d.link)
    content = {
      article: {
        source: d.link.url,
        title: d.link.title,
        ...(d.link.description ? { description: d.link.description } : {}),
      },
    };
  else if (d.attachments.length > 1)
    content = {
      multiImage: {
        images: d.attachments.map((a) => ({
          id: a.asset,
          ...(a.altText ? { altText: a.altText } : {}),
        })),
      },
    };
  else if (d.attachments.length) {
    const a = d.attachments[0];
    content = {
      media: {
        id: a.asset,
        title: a.title,
        ...(a.kind === "image" && a.altText ? { altText: a.altText } : {}),
      },
    };
  }
  return {
    author: d.author,
    commentary: escapeText(d.text),
    visibility: "PUBLIC",
    distribution: {
      feedDistribution: "MAIN_FEED",
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
    ...(content ? { content } : {}),
  };
}
