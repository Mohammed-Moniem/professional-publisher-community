import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Store } from "./store.js";
import { publicError, Fault } from "./model.js";
import type { Workspace } from "./workspace.js";
import type { Decks } from "./decks.js";
import type { Scheduler } from "./scheduler.js";
import { dashboardHTML } from "./dashboard-ui.js";
import { Review } from "./review.js";
import { Accounts } from "./accounts.js";
import { Keychain } from "./keychain.js";
import { VoiceStudio } from "./voice-studio.js";
import { OAuth } from "./oauth.js";
import { exportBackup, restoreBackup } from "./backups.js";
import { draftInput } from "./model.js";
export class Dashboard {
  private server?: Server;
  private token = randomBytes(32).toString("hex");
  private base = "";
  private review: Review;
  private accounts: Accounts;
  private studio: VoiceStudio;
  private oauth: OAuth;
  constructor(
    private store: Store,
    private workspace: Workspace,
    private decks: Decks,
    private scheduler: Scheduler,
  ) {
    this.review = new Review(scheduler.publisher);
    this.accounts = new Accounts(store, scheduler.publisher.api.vault);
    this.studio = new VoiceStudio(store);
    this.oauth = new OAuth(store, scheduler.publisher.api.vault);
  }
  async start() {
    if (this.server) return { url: this.base + "/?session=" + this.token };
    await this.store.init();
    this.server = createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url || "/", this.base);
        if (req.headers.host !== new URL(this.base).host)
          throw new Fault("INVALID_HOST", "Invalid local host.");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Referrer-Policy", "same-origin");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader(
          "Content-Security-Policy",
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        );
        const hasCookie = req.headers.cookie
          ?.split(";")
          .some((c) => c.trim() === `publisher_session=${this.token}`);
        if (
          url.pathname === "/" &&
          url.searchParams.get("session") === this.token
        ) {
          res.setHeader(
            "Set-Cookie",
            `publisher_session=${this.token}; HttpOnly; SameSite=Strict; Path=/`,
          );
          res.writeHead(303, { Location: "/" });
          res.end();
          return;
        }
        if (!hasCookie) {
          res.writeHead(403);
          res.end("Open a fresh dashboard link from your AI client.");
          return;
        }
        if (req.method === "GET" && url.pathname === "/") {
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(dashboardHTML(this.token));
          return;
        }
        if (req.method === "GET" && url.pathname === "/state") {
          const data: any = {};
          for (const group of [
            "connections",
            "ideas",
            "drafts",
            "decks",
            "voices",
            "schedules",
            "notifications",
            "preferences",
            "draft_revisions",
            "review_checks",
            "settings",
          ])
            data[group] = await this.store.list(group);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(data));
          return;
        }
        if (req.method === "GET" && url.pathname === "/voice-context") {
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify(
              await this.studio.inspect(url.searchParams.get("identity") || ""),
            ),
          );
          return;
        }
        if (req.method === "GET" && url.pathname === "/attachment") {
          const draft = await this.store.draft(
            url.searchParams.get("draft") || "",
          );
          const index = Number(url.searchParams.get("index"));
          const a =
            Number.isInteger(index) && index >= 0
              ? draft.attachments[index]
              : undefined;
          if (!a) throw new Fault("INVALID_ASSET", "Attachment not found.");
          const { realpath } = await import("node:fs/promises");
          const { relative, isAbsolute } = await import("node:path");
          const path = await realpath(a.storedPath),
            rel = relative(
              await realpath(join(this.store.root, "media")),
              path,
            );
          if (rel.startsWith("..") || isAbsolute(rel))
            throw new Fault(
              "INVALID_ASSET",
              "Attachment is outside the private media directory.",
            );
          res.setHeader("Content-Type", a.mime);
          res.end(await readFile(path));
          return;
        }
        if (req.method === "GET" && url.pathname === "/asset") {
          const id = url.searchParams.get("deck") || "",
            name = url.searchParams.get("name") || "";
          if (
            !/^[a-f0-9-]{36}$/.test(id) ||
            !/^(?:slide-\d{2}\.png|contact-sheet\.png|deck\.(?:pdf|pptx)|source\.json)$/.test(
              name,
            )
          )
            throw new Fault("INVALID_ASSET", "Invalid deck export.");
          if (!(await this.store.read("decks", id))) throw Error();
          res.setHeader(
            "Content-Type",
            name.endsWith(".png")
              ? "image/png"
              : name.endsWith(".pdf")
                ? "application/pdf"
                : "application/octet-stream",
          );
          res.end(await readFile(join(this.store.root, "decks", id, name)));
          return;
        }
        if (
          req.method !== "POST" ||
          req.headers.origin !== this.base ||
          req.headers["x-publisher-csrf"] !== this.token
        )
          throw new Fault("INVALID_REQUEST", "Invalid local request.");
        let body = "";
        for await (const part of req) {
          body += part;
          if (body.length > 36_000_000)
            throw new Fault("IMPORT_TOO_LARGE", "Upload a CSV under 25 MB.");
        }
        const a = JSON.parse(body);
        let output: any;
        if (url.pathname === "/revise")
          output = await this.review.revise(
            a.id,
            a.digest,
            draftInput.parse(a.draft),
          );
        else if (url.pathname === "/review")
          output = await this.review.check(a.id, a.digest, a.checks);
        else if (url.pathname === "/publish")
          output = await this.review.publish(
            a.id,
            a.digest,
            String(a.authorization || ""),
          );
        else if (url.pathname === "/approve-learning")
          output = await this.workspace.approveDraft(
            a.id,
            a.digest,
            String(a.authorization || ""),
          );
        else if (url.pathname === "/disconnect")
          output = await this.accounts.disconnect(a.id);
        else if (url.pathname === "/cleanup-credentials")
          output = await this.accounts.cleanup(a.id);
        else if (url.pathname === "/clear-voice")
          output = await this.accounts.clearVoice(a.identity);
        else if (url.pathname === "/connect") {
          const result = await this.oauth.start(
            a.id,
            a.mode === "company" ? "company" : "personal",
          );
          output = { ...result, url: result.setupUrl };
        } else if (url.pathname === "/capabilities")
          output = await this.scheduler.publisher.capabilities();
        else if (url.pathname === "/voice-rules")
          output = await this.studio.save(a.identity, a.profile);
        else if (url.pathname === "/voice-comparison")
          output = await this.studio.compare(a.identity, a.comparison);
        else if (url.pathname === "/reschedule")
          output = await this.scheduler.reschedule(a.id, a.schedule);
        else if (url.pathname === "/notifications")
          output = await this.scheduler.notifications.configure(
            a.enabled === true,
          );
        else if (url.pathname === "/backup")
          output = await exportBackup(
            this.store,
            join(this.store.root, "backups", Date.now() + ".ppcenc"),
            String(a.passphrase || ""),
          );
        else if (url.pathname === "/restore")
          output = await restoreBackup(
            String(a.path),
            String(a.target),
            String(a.passphrase || ""),
          );
        else if (url.pathname === "/consent")
          output = await this.workspace.consent(
            String(a.identity),
            a.enabled === true,
          );
        else if (url.pathname === "/voice")
          output = await this.workspace.controlVoice(
            String(a.identity),
            a.action,
          );
        else if (url.pathname === "/idea")
          output = await this.workspace.idea(a.idea);
        else if (url.pathname === "/brand")
          output = await this.decks.brand(String(a.identity), a.brand);
        else if (url.pathname === "/cancel")
          output = await this.scheduler.cancel(String(a.id));
        else if (url.pathname === "/import") {
          const path = join(
            this.store.root,
            "import-" + randomBytes(8).toString("hex") + ".csv",
          );
          try {
            await writeFile(path, String(a.csv), { mode: 0o600 });
            output = await this.workspace.importFile(String(a.identity), path);
          } finally {
            await unlink(path).catch(() => {});
          }
        } else throw new Fault("UNKNOWN_ACTION", "Unsupported action.");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(output));
      })().catch((e) => {
        if (!res.headersSent)
          res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify(publicError(e)));
      });
    });
    await new Promise<void>((resolve) =>
      this.server!.listen(0, "127.0.0.1", resolve),
    );
    const port = (this.server.address() as any).port;
    this.base = `http://127.0.0.1:${port}`;
    return { url: this.base + "/?session=" + this.token };
  }
  async close() {
    await this.oauth.close();
    await new Promise<void>((r) =>
      this.server ? this.server.close(() => r()) : r(),
    );
    this.server = undefined;
  }
}
