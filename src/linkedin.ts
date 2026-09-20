import { renewableConnection } from "./renewal.js";
import { Fault, type Connection, type Identity } from "./model.js";
import type { Vault } from "./keychain.js";
import type { Store } from "./store.js";
export type Fetch = typeof fetch;
export const API_VERSION = "202608";
export class LinkedIn {
  constructor(
    public store: Store,
    public vault: Vault,
    public fetcher: Fetch = fetch,
  ) {}
  async connection(id: string) {
    return renewableConnection(this.store, this.vault, this.fetcher, id);
  }
  async request(
    connectionId: string,
    path: string,
    method = "GET",
    body?: unknown,
    versioned = true,
    beforeSubmit?: () => void,
  ): Promise<Response> {
    if (!path.startsWith("/rest/") && !path.startsWith("/v2/"))
      throw new Fault("INVALID_ENDPOINT", "Unsupported API path.");
    await this.connection(connectionId);
    const secret = await this.vault.get(connectionId);
    if (!secret?.accessToken)
      throw new Fault(
        "RECONNECT_REQUIRED",
        "Reconnect this account to restore its access token.",
      );
    await this.store.connection(connectionId);
    beforeSubmit?.();
    let response: Response;
    try {
      response = await this.fetcher("https://api.linkedin.com" + path, {
        method,
        headers: {
          Authorization: "Bearer " + secret.accessToken,
          "X-Restli-Protocol-Version": "2.0.0",
          ...(versioned ? { "LinkedIn-Version": API_VERSION } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Fault(
        "NETWORK_UNCERTAIN",
        "LinkedIn did not return a definitive response.",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) {
        const c = await this.store.read<Connection>(
          "connections",
          connectionId,
        );
        if (c)
          await this.store.write("connections", connectionId, {
            ...c,
            revoked: true,
          });
      }
      throw httpFault(
        response.status,
        response.headers.get("retry-after") ?? undefined,
      );
    }
    return response;
  }
  async json(
    connectionId: string,
    path: string,
    method = "GET",
    body?: unknown,
    versioned = true,
  ): Promise<any> {
    const r = await this.request(connectionId, path, method, body, versioned);
    try {
      return await r.json();
    } catch {
      throw new Fault(
        "INVALID_RESPONSE",
        "LinkedIn returned an unexpected response.",
      );
    }
  }
  async identities(connectionId: string): Promise<Identity[]> {
    const c = await this.connection(connectionId);
    if (c.mode === "personal")
      return c.member
        ? [{ connectionId, author: c.member, name: c.name, kind: "person" }]
        : [];
    if (
      !c.scopes.some((s) =>
        ["r_organization_admin", "rw_organization_admin"].includes(s),
      )
    )
      throw new Fault(
        "MISSING_PAGE_DISCOVERY_SCOPE",
        "Company discovery needs r_organization_admin. Enable approved Community Management access and reconnect.",
      );
    const identities = new Map<string, Identity>();
    for (let start = 0; start < 10_000; start += 100) {
      const r = await this.json(
        connectionId,
        `/rest/organizationAcls?q=roleAssignee&state=APPROVED&start=${start}&count=100`,
      );
      if (!Array.isArray(r.elements))
        throw new Fault(
          "INVALID_RESPONSE",
          "LinkedIn did not return page roles.",
        );
      for (const acl of r.elements) {
        const urn = acl.organization ?? acl.organizationTarget;
        if (
          acl.state === "APPROVED" &&
          ["ADMINISTRATOR", "CONTENT_ADMINISTRATOR", "CONTENT_ADMIN"].includes(
            acl.role,
          ) &&
          /^urn:li:organization:\d+$/.test(urn)
        ) {
          identities.set(urn, {
            connectionId,
            author: urn,
            name: `Company page ${urn.split(":").pop()}`,
            kind: "organization",
            role: acl.role,
          });
        }
      }
      if (
        r.elements.length < 100 &&
        !r.paging?.links?.some((x: any) => x.rel === "next")
      )
        return await Promise.all(
          [...identities.values()].map(async (identity) => {
            try {
              const org = await this.json(
                connectionId,
                `/rest/organizations/${identity.author.split(":").pop()}`,
              );
              if (
                typeof org.localizedName === "string" &&
                org.localizedName.trim()
              )
                identity.name = org.localizedName;
            } catch {
              /* Verified URN remains usable when optional display-name access is unavailable. */
            }
            return identity;
          }),
        );
    }
    throw new Fault(
      "PAGE_LIMIT",
      "Page discovery exceeded its bounded pagination limit.",
    );
  }
  async assertAuthor(connectionId: string, author: string) {
    const c = await this.connection(connectionId);
    const scope = author.startsWith("urn:li:person:")
      ? "w_member_social"
      : "w_organization_social";
    if (!c.scopes.includes(scope))
      throw new Fault(
        "MISSING_PUBLISH_SCOPE",
        `This connection lacks ${scope}. Enable the appropriate LinkedIn product and reconnect.`,
      );
    const identities = await this.identities(connectionId);
    if (!identities.some((i) => i.author === author))
      throw new Fault(
        "AUTHOR_NOT_AUTHORIZED",
        "The selected identity does not belong to this connection or lacks an approved organic publishing role.",
      );
    return c;
  }
}
export function httpFault(status: number, retryAfter?: string) {
  const code =
    status === 401
      ? "RECONNECT_REQUIRED"
      : status === 403
        ? "ACCESS_RESTRICTED"
        : status === 429
          ? "RATE_LIMITED"
          : status >= 500
            ? "PROVIDER_UNCERTAIN"
            : "REQUEST_REJECTED";
  const message =
    status === 401
      ? "LinkedIn access expired or was revoked. Reconnect."
      : status === 403
        ? "LinkedIn denied this operation. Check the app product, granted permissions, and page role."
        : status === 429
          ? "LinkedIn rate limit reached. Retry only after the indicated delay."
          : status >= 500
            ? "LinkedIn returned a server error; a publishing outcome may be uncertain."
            : `LinkedIn rejected the request (HTTP ${status}).`;
  return new Fault(code, message, status, retryAfter);
}
