import { Fault, type Connection } from "./model.js";
import type { Store } from "./store.js";
import type { Vault } from "./keychain.js";
import type { Fetch } from "./linkedin.js";
/** Renew only tokens LinkedIn actually issued; never invent or slide expiry. */
export async function renewableConnection(
  store: Store,
  vault: Vault,
  fetcher: Fetch,
  id: string,
): Promise<Connection> {
  let c = await store.read<Connection>("connections", id);
  if (!c)
    throw new Fault(
      "NOT_CONNECTED",
      "Connect this account before uploading or publishing.",
    );
  if (c.revoked)
    throw new Fault(
      "RECONNECT_REQUIRED",
      "LinkedIn revoked this connection. Reconnect the account.",
    );
  if (c.expiresAt > Date.now() + 24 * 3600_000) return c;
  const secret = await vault.get(id);
  if (
    !secret?.refreshToken ||
    !secret.refreshExpiresAt ||
    secret.refreshExpiresAt <= Date.now() + 60_000 ||
    (c.refreshRetryAt && c.refreshRetryAt > Date.now())
  )
    return store.connection(id);
  return store.lock("renew-" + id, async () => {
    c = await store.read<Connection>("connections", id);
    if (!c || c.revoked)
      throw new Fault("RECONNECT_REQUIRED", "Reconnect the account.");
    if (c.expiresAt > Date.now() + 24 * 3600_000) return c;
    const current = await vault.get(id);
    if (
      !current?.refreshToken ||
      !current.refreshExpiresAt ||
      current.refreshExpiresAt <= Date.now() + 60_000
    )
      return store.connection(id);
    try {
      const r = await fetcher("https://www.linkedin.com/oauth/v2/accessToken", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: current.refreshToken,
          client_id: current.clientId,
          client_secret: current.clientSecret,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      if (!r.ok) {
        await r.body?.cancel();
        if (r.status === 400 || r.status === 401) {
          await vault.set(id, {
            ...current,
            refreshToken: undefined,
            refreshExpiresAt: undefined,
          });
          await store.write("connections", id, {
            ...c,
            refreshSupported: false,
            refreshExpiresAt: undefined,
            renewalNotice:
              "Refresh access expired or was rejected. Reauthorize before the current access token expires.",
          });
          return store.connection(id);
        }
        throw new Fault(
          "RENEWAL_FAILED",
          "LinkedIn token renewal is temporarily unavailable.",
        );
      }
      const token = (await r.json()) as any;
      if (
        typeof token.access_token !== "string" ||
        !Number.isFinite(token.expires_in) ||
        token.expires_in <= 0
      )
        throw new Fault(
          "RENEWAL_FAILED",
          "LinkedIn returned an invalid renewed token.",
        );
      const checked = await fetcher(
        "https://www.linkedin.com/oauth/v2/introspectToken",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: current.clientId,
            client_secret: current.clientSecret,
            token: token.access_token,
          }),
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!checked.ok) {
        await checked.body?.cancel();
        throw new Fault(
          "RENEWAL_FAILED",
          "LinkedIn could not verify renewed access.",
        );
      }
      const info = (await checked.json()) as any;
      if (info.active !== true || typeof info.scope !== "string")
        throw new Fault(
          "RENEWAL_FAILED",
          "LinkedIn could not verify renewed access.",
        );
      const refreshExpiresAt = Math.min(
        current.refreshExpiresAt,
        Number.isFinite(token.refresh_token_expires_in) &&
          token.refresh_token_expires_in > 0
          ? Date.now() + token.refresh_token_expires_in * 1000
          : current.refreshExpiresAt,
      );
      const expiresAt = Math.min(
        Date.now() + token.expires_in * 1000,
        refreshExpiresAt,
        Number.isFinite(info.expires_at) ? info.expires_at * 1000 : Infinity,
      );
      if (expiresAt <= Date.now() + 60_000)
        throw new Fault(
          "RECONNECT_REQUIRED",
          "The renewal window ended. Reauthorize the account.",
        );
      await vault.set(id, {
        ...current,
        accessToken: token.access_token,
        refreshToken:
          typeof token.refresh_token === "string"
            ? token.refresh_token
            : current.refreshToken,
        refreshExpiresAt,
      });
      const renewed: Connection = {
        ...c,
        expiresAt,
        scopes: info.scope.split(/[ ,]+/).filter(Boolean),
        refreshExpiresAt,
        refreshSupported: true,
        lastRenewedAt: Date.now(),
        refreshRetryAt: undefined,
        renewalNotice: undefined,
      };
      await store.write("connections", id, renewed);
      return renewed;
    } catch (e) {
      // A transient renewal failure does not discard still-valid access, and does
      // not cause publishing to be resent. Retry renewal on a later tool call.
      const latest = await store.read<Connection>("connections", id);
      if (latest)
        await store.write("connections", id, {
          ...latest,
          refreshRetryAt: Date.now() + 5 * 60_000,
          renewalNotice:
            "Automatic renewal failed; retry in five minutes or reconnect if access expires.",
        });
      if (c.expiresAt > Date.now() + 60_000) return c;
      throw new Fault(
        "RECONNECT_REQUIRED",
        "Access expired and automatic renewal failed. Reconnect the account.",
      );
    }
  });
}
