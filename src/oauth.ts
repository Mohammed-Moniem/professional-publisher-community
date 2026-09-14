import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  connectionId as idSchema,
  Fault,
  publicError,
  type Connection,
} from "./model.js";
import type { Store } from "./store.js";
import type { Vault } from "./keychain.js";
import type { Fetch } from "./linkedin.js";
export const PORT = 53692;
export const redirectUri = `http://127.0.0.1:${PORT}/callback`;
function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function html(s: string) {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}
export class OAuth {
  private server?: Server;
  private timer?: NodeJS.Timeout;
  private pending?: {
    id: string;
    mode: "personal" | "company";
    state: string;
    csrf: string;
    expires: number;
    started: boolean;
    consumed: boolean;
    completedName?: string;
    reuseCredentials?: boolean;
    readHistory: boolean;
  };
  constructor(
    private store: Store,
    private vault: Vault,
    private fetcher: Fetch = fetch,
    private port = PORT,
  ) {}
  async start(id: string, mode: "personal" | "company", readHistory = false) {
    idSchema.parse(id);
    if (this.pending && this.pending.expires > Date.now())
      throw new Fault(
        "CONNECT_IN_PROGRESS",
        "Finish or cancel the existing account connection first.",
      );
    await this.close();
    const existing = await this.store.read<Connection>("connections", id);
    const reuseCredentials =
      existing?.mode === mode && !!(await this.vault.get(id))?.clientSecret;
    this.pending = {
      reuseCredentials,
      readHistory:
        readHistory || !!existing?.scopes?.includes("r_member_social"),
      id,
      mode,
      state: randomBytes(32).toString("hex"),
      csrf: randomBytes(32).toString("hex"),
      expires: Date.now() + 15 * 60_000,
      started: false,
      consumed: false,
    };
    this.server = createServer((req, res) => {
      void this.route(req, res).catch((e) => {
        if (!res.headersSent)
          this.respond(
            res,
            400,
            `<h1>Connection needs attention</h1><p>${html(publicError(e).message)}</p><p>Return to Codex, cancel this connection, and start again after correcting setup.</p>`,
          );
        else res.end();
      });
    });
    this.server.requestTimeout = 30_000;
    this.server.headersTimeout = 10_000;
    try {
      await new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject);
        this.server!.listen(this.port, "127.0.0.1", () => resolve());
      });
    } catch {
      await this.close();
      throw new Fault(
        "CALLBACK_PORT_BUSY",
        `Local port ${this.port} is in use. Finish another connection or stop its setup server.`,
      );
    }
    this.timer = setTimeout(() => void this.close(), 15 * 60_000);
    this.timer.unref();
    return {
      connectionId: id,
      mode,
      setupUrl: `http://127.0.0.1:${this.port}/setup?session=${this.pending.csrf}`,
      redirectUri: `http://127.0.0.1:${this.port}/callback`,
      expiresInMinutes: 15,
      instructions: reuseCredentials
        ? "Open setupUrl in your signed-in LinkedIn browser and choose Renew connection. App credentials are reused securely from OS credential store. Before expiry LinkedIn may skip consent; login or authorization can still be required."
        : "Open setupUrl in your browser. Enter app credentials only in that local form, never in chat. Add the exact redirect URI to your LinkedIn developer app. The form then connects your account through LinkedIn.",
    };
  }
  async close() {
    if (this.timer) clearTimeout(this.timer);
    const server = this.server;
    this.server = undefined;
    this.pending = undefined;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }
  private respond(res: ServerResponse, status: number, body: string) {
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://www.linkedin.com; frame-ancestors 'none'",
    });
    res.end(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Professional Publisher setup</title><style>body{font:17px system-ui;background:#f6f5f1;color:#17272a;max-width:700px;margin:60px auto;padding:24px;line-height:1.6}h1{line-height:1.15}label{display:block;margin-top:20px}input{display:block;width:95%;padding:12px;font:inherit;border:1px solid #829493;border-radius:6px}button{margin-top:24px;padding:12px 24px;background:#17695e;color:white;border:0;border-radius:6px;font:inherit}code{overflow-wrap:anywhere}a{color:#17695e}</style><body>${body}</body></html>`,
    );
  }
  private async route(req: IncomingMessage, res: ServerResponse) {
    const base = `http://127.0.0.1:${this.port}`;
    if (req.headers.host !== `127.0.0.1:${this.port}`) {
      this.respond(res, 403, "Invalid host.");
      return;
    }
    const p = this.pending;
    if (!p || p.expires < Date.now()) {
      this.respond(
        res,
        410,
        "This setup link expired. Start account connection from Codex again.",
      );
      return;
    }
    const url = new URL(req.url ?? "/", base);
    if (
      req.method === "GET" &&
      url.pathname === "/connected" &&
      p.completedName
    ) {
      this.respond(
        res,
        200,
        `<h1>Connected</h1><p>${html(p.completedName)} is connected. Return to Codex and ask to check publishing capabilities.</p><p>No post has been published.</p>`,
      );
      setTimeout(() => void this.close(), 250).unref();
      return;
    }
    if (req.method === "GET" && url.pathname === "/setup") {
      if (!equal(url.searchParams.get("session") ?? "", p.csrf)) {
        this.respond(res, 403, "Invalid setup session.");
        return;
      }
      if (p.reuseCredentials) {
        this.respond(
          res,
          200,
          `<h1>Renew LinkedIn connection</h1><p>Connection: <strong>${html(p.id)}</strong>. Your saved app credentials stay in OS credential store. Nothing will be posted.</p><p>Use the browser where you are signed into LinkedIn. Before your access expires, LinkedIn may renew without another consent screen. Login or authorization may still be required.</p><form action="/connect" method="post"><input type="hidden" name="csrf" value="${p.csrf}"><p>Requested permissions: <code>${this.scopes(p.mode, p.readHistory).join(" ")}</code></p><button type="submit">Renew connection</button></form>`,
        );
        return;
      }
      this.respond(
        res,
        200,
        `<p>PROFESSIONAL PUBLISHER · LOCAL SETUP</p><h1>Connect ${p.mode === "personal" ? "your LinkedIn profile" : "your company pages"}</h1><p>Connection: <strong>${html(p.id)}</strong>. Credentials go directly to your OS credential store and LinkedIn.</p><ol><li>Open <a href="https://www.linkedin.com/developers/apps" target="_blank" rel="noreferrer">LinkedIn developer apps</a> and create your app, associating the required company page.</li><li>${p.mode === "personal" ? "Enable Share on LinkedIn and Sign In with LinkedIn using OpenID Connect." : "Use a separate app for Community Management. Request access and complete organization verification before connecting. This requires LinkedIn approval."}</li><li>In the app’s Auth tab, register this exact redirect URL:<br><code>${base}/callback</code></li></ol><form action="/connect" method="post"><input type="hidden" name="csrf" value="${p.csrf}"><label>Client ID<input name="clientId" required maxlength="200" autocomplete="off"></label><label>Client secret<input name="clientSecret" type="password" required maxlength="1000" autocomplete="off"></label><p>Requested permissions: <code>${this.scopes(p.mode, p.readHistory).join(" ")}</code></p><button type="submit">Connect through LinkedIn</button></form><p>Nothing will be posted during setup. Return to your AI client after authorization. Ask it to check history access and set up your writing voice with your consent.</p>`,
      );
      return;
    }
    if (req.method === "POST" && url.pathname === "/connect") {
      if (
        req.headers.origin !== base ||
        !req.headers["content-type"]?.startsWith(
          "application/x-www-form-urlencoded",
        )
      )
        throw new Fault(
          "INVALID_ORIGIN",
          "Setup form must be submitted from this local page.",
        );
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 8192)
          throw new Fault("FORM_TOO_LARGE", "Setup form is too large.");
      }
      const f = new URLSearchParams(body);
      if (!equal(f.get("csrf") ?? "", p.csrf) || p.started)
        throw new Fault(
          "INVALID_SESSION",
          "Invalid or already used setup session.",
        );
      const saved = p.reuseCredentials ? await this.vault.get(p.id) : undefined;
      const clientId = p.reuseCredentials
          ? saved?.clientId
          : f.get("clientId")?.trim(),
        clientSecret = p.reuseCredentials
          ? saved?.clientSecret
          : f.get("clientSecret")?.trim();
      if (
        !clientId ||
        !clientSecret ||
        !/^[A-Za-z0-9_-]{1,200}$/.test(clientId) ||
        clientSecret.length > 1000
      )
        throw new Fault(
          "INVALID_CREDENTIALS",
          "Enter valid app credentials in the local form.",
        );
      // Save pending app credentials separately so failed reconnection cannot invalidate a working account.
      await this.vault.set("pending-" + p.id, { clientId, clientSecret });
      p.started = true;
      const auth = new URL("https://www.linkedin.com/oauth/v2/authorization");
      auth.search = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: base + "/callback",
        state: p.state,
        scope: this.scopes(p.mode, p.readHistory).join(" "),
      }).toString();
      res.writeHead(303, {
        Location: auth.toString(),
        "Cache-Control": "no-store",
        "Referrer-Policy": "same-origin",
      });
      res.end();
      return;
    }
    if (req.method === "GET" && url.pathname === "/callback") {
      if (
        !p.started ||
        p.consumed ||
        !equal(url.searchParams.get("state") ?? "", p.state)
      )
        throw new Fault(
          "OAUTH_STATE_MISMATCH",
          "Authorization state did not match. Start a new connection.",
        );
      p.consumed = true;
      if (url.searchParams.has("error"))
        throw new Fault(
          "OAUTH_DENIED",
          "LinkedIn authorization was declined or unavailable.",
        );
      const code = url.searchParams.get("code");
      if (!code || code.length > 4096)
        throw new Fault(
          "OAUTH_CODE_MISSING",
          "LinkedIn did not return an authorization code.",
        );
      const app = await this.vault.get("pending-" + p.id);
      if (!app)
        throw new Fault(
          "KEYCHAIN_UNAVAILABLE",
          "The app credentials are missing.",
        );
      const token = await this.oauthJson("accessToken", {
        grant_type: "authorization_code",
        code,
        redirect_uri: base + "/callback",
        client_id: app.clientId,
        client_secret: app.clientSecret,
      });
      if (
        typeof token.access_token !== "string" ||
        !Number.isFinite(token.expires_in) ||
        token.expires_in <= 0
      )
        throw new Fault(
          "INVALID_TOKEN",
          "LinkedIn did not return a usable access token.",
        );
      const introspected = await this.oauthJson("introspectToken", {
        client_id: app.clientId,
        client_secret: app.clientSecret,
        token: token.access_token,
      });
      if (
        introspected.active !== true ||
        typeof introspected.scope !== "string"
      )
        throw new Fault(
          "TOKEN_NOT_ACTIVE",
          "LinkedIn could not verify active access and its granted permissions.",
        );
      const scopes = introspected.scope.split(/[ ,]+/).filter(Boolean);
      let member: string | undefined;
      let name = p.id;
      if (p.mode === "personal") {
        const r = await this.fetcher("https://api.linkedin.com/v2/userinfo", {
          headers: { Authorization: "Bearer " + token.access_token },
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        });
        if (!r.ok) {
          await r.body?.cancel();
          throw new Fault(
            "PROFILE_UNAVAILABLE",
            "Enable Sign In with LinkedIn using OpenID Connect and reconnect.",
          );
        }
        const info = (await r.json()) as any;
        if (typeof info.sub !== "string" || !/^[A-Za-z0-9_-]+$/.test(info.sub))
          throw new Fault(
            "PROFILE_UNAVAILABLE",
            "LinkedIn did not return a member identity.",
          );
        member = "urn:li:person:" + info.sub;
        name = typeof info.name === "string" ? info.name : p.id;
      }
      const refreshExpiresAt =
        typeof token.refresh_token === "string" &&
        Number.isFinite(token.refresh_token_expires_in) &&
        token.refresh_token_expires_in > 0
          ? Date.now() + token.refresh_token_expires_in * 1000
          : undefined;
      const connection: Connection = {
        id: p.id,
        mode: p.mode,
        scopes,
        member,
        name,
        connectedAt: Date.now(),
        refreshSupported: refreshExpiresAt !== undefined,
        refreshExpiresAt,
        expiresAt: Math.min(
          Date.now() + token.expires_in * 1000,
          typeof introspected.expires_at === "number"
            ? introspected.expires_at * 1000
            : Infinity,
        ),
      };
      await this.vault.set(p.id, {
        ...app,
        accessToken: token.access_token,
        ...(refreshExpiresAt
          ? { refreshToken: token.refresh_token, refreshExpiresAt }
          : {}),
      });
      await this.store.write("connections", p.id, connection);
      p.completedName = name;
      // Keep authorization codes out of the final visible URL and subsequent
      // browser snapshots. The code has already been exchanged server-side.
      res.writeHead(303, {
        Location: "/connected",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      });
      res.end();
      return;
    }
    this.respond(res, 404, "Not found.");
  }
  private scopes(mode: "personal" | "company", readHistory = false) {
    return mode === "personal"
      ? [
          "openid",
          "profile",
          "w_member_social",
          ...(readHistory ? ["r_member_social"] : []),
        ]
      : ["r_organization_admin", "w_organization_social"];
  }
  private async oauthJson(
    endpoint: string,
    body: Record<string, string>,
  ): Promise<any> {
    let r: Response;
    try {
      r = await this.fetcher("https://www.linkedin.com/oauth/v2/" + endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Fault(
        "OAUTH_NETWORK",
        "LinkedIn authorization could not complete. Start a new connection.",
      );
    }
    if (!r.ok) {
      await r.body?.cancel();
      throw new Fault(
        "OAUTH_FAILED",
        "LinkedIn rejected authorization. Check client credentials, redirect URL, and approved app products.",
      );
    }
    try {
      return await r.json();
    } catch {
      throw new Fault(
        "OAUTH_FAILED",
        "LinkedIn returned an invalid authorization response.",
      );
    }
  }
}
