import { z } from "zod";
export const formats = [
  "text",
  "link",
  "image",
  "multiImage",
  "video",
  "document",
] as const;
export type Format = (typeof formats)[number];
export const connectionId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,39}$/)
  .refine(
    (id) => !id.startsWith("pending-"),
    "The pending- prefix is reserved for temporary OAuth credentials.",
  );
export const authorUrn = z
  .string()
  .regex(/^urn:li:(person:[A-Za-z0-9_-]+|organization:[0-9]+)$/);
export const attachmentInput = z
  .object({
    path: z
      .string()
      .refine(
        (p) => /^(?:\/|[A-Za-z]:[\\\/])/.test(p),
        "Use an absolute local file path",
      ),
    title: z.string().min(1).max(200),
    altText: z.string().max(4086).optional(),
  })
  .strict();
export const draftInput = z
  .object({
    connectionId,
    author: authorUrn,
    text: z.string().max(3000),
    attachments: z.array(attachmentInput).max(20).default([]),
    link: z
      .object({
        url: z.string().url(),
        title: z.string().min(1).max(200),
        description: z.string().max(500).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type DraftInput = z.infer<typeof draftInput>;
export type Attachment = z.infer<typeof attachmentInput> & {
  kind: "image" | "video" | "document";
  mime: string;
  size: number;
  hash: string;
  storedPath: string;
  metadata: Record<string, number | string>;
  asset?: string;
  uploadState?: "PROCESSING" | "AVAILABLE";
};
export type Connection = {
  id: string;
  mode: "personal" | "company";
  scopes: string[];
  expiresAt: number;
  member?: string;
  name: string;
  connectedAt: number;
  revoked?: boolean;
  refreshSupported?: boolean;
  refreshExpiresAt?: number;
  lastRenewedAt?: number;
  refreshRetryAt?: number;
  renewalNotice?: string;
};
export type Identity = {
  connectionId: string;
  author: string;
  name: string;
  kind: "person" | "organization";
  role?: string;
};
export type Draft = Omit<DraftInput, "attachments"> & {
  id: string;
  format: Format;
  attachments: Attachment[];
  digest: string;
  createdAt: number;
  state: "draft" | "publishing" | "published" | "rejected" | "uncertain";
  result?: {
    postUrn: string;
    url: string;
    publishedAt: number;
    verified: "api_accepted";
  };
  error?: { code: string; message: string; retryAfter?: string };
};
export type Evidence = {
  connectionId: string;
  author: string;
  format: Format;
  status: "published" | "restricted";
  at: number;
  reason?: string;
};
export class Fault extends Error {
  constructor(
    public code: string,
    message: string,
    public status?: number,
    public retryAfter?: string,
  ) {
    super(message);
  }
}
export function publicError(e: unknown) {
  if (e instanceof z.ZodError)
    return {
      code: "INVALID_INPUT",
      message:
        "Invalid input fields: " +
        [...new Set(e.issues.map((i) => i.path.join(".") || "request"))].join(
          ", ",
        ),
    };
  return e instanceof Fault
    ? {
        code: e.code,
        message: e.message,
        ...(e.retryAfter ? { retryAfter: e.retryAfter } : {}),
      }
    : {
        code: "INTERNAL_ERROR",
        message:
          "Operation failed locally. No raw credentials or provider response is included. Check setup and retry only if the draft is not uncertain.",
      };
}
export function escapeText(text: string) {
  return text.replace(/[|{}@\[\]()<>\\*_~]/g, "\\$&");
}
