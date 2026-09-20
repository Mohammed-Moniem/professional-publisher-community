import { Store, hash } from "./store.js";
import { Fault, connectionId, authorUrn, type Connection } from "./model.js";
import type { Vault } from "./keychain.js";
import { Workspace } from "./workspace.js";

export class Accounts {
  constructor(
    public store: Store,
    public vault: Vault,
  ) {}
  async disconnect(raw: string) {
    const id = connectionId.parse(raw);
    return this.store.lock("renew-" + id, async () => {
      const c = await this.store.read<Connection>("connections", id);
      // A durable tombstone blocks a concurrent/previous OAuth callback from reconnecting.
      await this.store.write("disconnections", id, { at: Date.now() });
      if (c)
        await this.store.write("connections", id, {
          ...c,
          revoked: true,
          expiresAt: 0,
          refreshSupported: false,
        });
      for (const job of await this.store.list<any>("schedules")) {
        const draft = await this.store.read<any>("drafts", job.draftId);
        if (draft?.connectionId !== id || job.state !== "scheduled") continue;
        await this.store.lock("schedule-" + job.id, async () => {
          const current = await this.store.read<any>("schedules", job.id);
          if (current?.state === "scheduled")
            await this.store.write("schedules", job.id, {
              ...current,
              state: "cancelled",
            });
        });
      }
      if (!this.vault.delete)
        throw new Fault(
          "VAULT_DELETE_UNAVAILABLE",
          "Account disabled; credential deletion is unavailable in this vault.",
        );
      await this.vault.delete(id);
      await this.vault.delete("pending-" + id);
      return {
        disconnected: true,
        credentialsRemoved: true,
        notice:
          "Already submitted requests cannot be recalled. Remove the app in LinkedIn settings as well to revoke access at LinkedIn.",
      };
    });
  }
  async clearVoice(raw: string) {
    const identity = authorUrn.parse(raw);
    await new Workspace(this.store).controlVoice(identity, "reset");
    await this.store.remove("brands", hash(identity));
    return {
      cleared: true,
      retained:
        "Drafts, assets and publishing receipts remain to prevent duplicate posts. Use encrypted backup for export.",
    };
  }
  async cleanup(id: string) {
    connectionId.parse(id);
    if (!this.vault.cleanup)
      throw new Fault(
        "VAULT_CLEANUP_UNAVAILABLE",
        "Credential cleanup is unavailable.",
      );
    return {
      removedGenerations: await this.vault.cleanup(id),
      notice:
        "Only generations tracked by v0.2 and the current v0.1 generation can be removed automatically.",
    };
  }
}
