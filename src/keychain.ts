import { AsyncEntry } from "@napi-rs/keyring";
import { randomUUID } from "node:crypto";
import { Fault } from "./model.js";
import { Store } from "./store.js";
export type Credentials = {
  clientId: string;
  clientSecret: string;
  accessToken?: string;
  refreshToken?: string;
  refreshExpiresAt?: number;
};
export interface Vault {
  get(account: string): Promise<Credentials | undefined>;
  set(account: string, value: Credentials): Promise<void>;
  delete?(account: string): Promise<void>;
  cleanup?(account: string): Promise<number>;
}
export const SERVICE = "org.professional-publisher-community.linkedin";
// Generation chunks keep each Windows credential under its native size limit.
// The pointer is committed last, preserving working credentials on partial failure.
export class Keychain implements Vault {
  constructor(private store = new Store()) {}
  private entry(account: string) {
    return new AsyncEntry(SERVICE, account, {
      linux: { store: "secret-service" },
    });
  }
  async get(account: string): Promise<Credentials | undefined> {
    return this.store.lock("vault-" + account, () => this.read(account));
  }
  private async read(account: string): Promise<Credentials | undefined> {
    try {
      const pointer = await this.entry(account).getPassword();
      if (!pointer) return undefined;
      const { generation, count } = JSON.parse(pointer);
      if (
        !/^[a-f0-9-]{36}$/.test(generation) ||
        !Number.isInteger(count) ||
        count < 1 ||
        count > 100
      )
        throw Error();
      let encoded = "";
      for (let n = 0; n < count; n++) {
        const chunk = await this.entry(
          `${account}:${generation}:${n}`,
        ).getPassword();
        if (!chunk) throw Error();
        encoded += chunk;
      }
      return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    } catch {
      throw new Fault(
        "KEYCHAIN_UNAVAILABLE",
        "Unlock your OS credential store. Linux requires a running Secret Service session. No plaintext fallback is used.",
      );
    }
  }
  async set(account: string, value: Credentials) {
    return this.store.lock("vault-" + account, () => this.save(account, value));
  }
  private async save(account: string, value: Credentials) {
    try {
      const encoded = Buffer.from(JSON.stringify(value)).toString("base64");
      if (encoded.length > 100000) throw Error();
      const generation = randomUUID();
      const count = Math.ceil(encoded.length / 1000);
      const previous = await this.entry(account).getPassword();
      const history = JSON.parse(
        (await this.entry(account + ":generations").getPassword()) || "[]",
      );
      if (previous) history.push(JSON.parse(previous));
      history.push({ generation, count });
      // Track chunks before writing them so failed/partial saves can be cleaned too.
      await this.entry(account + ":generations").setPassword(
        JSON.stringify([
          ...new Map(history.map((g: any) => [g.generation, g])).values(),
        ]),
      );
      for (let n = 0; n < count; n++)
        await this.entry(`${account}:${generation}:${n}`).setPassword(
          encoded.slice(n * 1000, (n + 1) * 1000),
        );
      await this.entry(account).setPassword(
        JSON.stringify({ generation, count }),
      ); // Retain old generations so concurrent readers cannot observe deleted chunks.
    } catch {
      throw new Fault(
        "KEYCHAIN_UNAVAILABLE",
        "Could not save credentials in the OS credential store. Unlock it and retry.",
      );
    }
  }
  async cleanup(account: string) {
    return this.store.lock("vault-" + account, () =>
      this.prune(account, false),
    );
  }
  async delete(account: string) {
    await this.store.lock("vault-" + account, async () => {
      await this.prune(account, true);
    });
  }
  private async prune(account: string, all: boolean) {
    try {
      const current = JSON.parse(
        (await this.entry(account).getPassword()) || "null",
      );
      const history = JSON.parse(
        (await this.entry(account + ":generations").getPassword()) || "[]",
      );
      if (current) history.push(current);
      let removed = 0;
      // Delete pointer first: failed cleanup cannot leave usable forgotten credentials.
      if (all) await this.entry(account).deleteCredential();
      for (const g of new Map<string, any>(
        history.map((g: any) => [g.generation, g]),
      ).values()) {
        if (
          !/^[a-f0-9-]{36}$/.test(g.generation) ||
          !Number.isInteger(g.count) ||
          g.count < 1 ||
          g.count > 100
        )
          throw Error();
        if (!all && g.generation === current?.generation) continue;
        for (let n = 0; n < g.count; n++)
          await this.entry(
            `${account}:${g.generation}:${n}`,
          ).deleteCredential();
        removed++;
      }
      if (all) await this.entry(account + ":generations").deleteCredential();
      else
        await this.entry(account + ":generations").setPassword(
          JSON.stringify(current ? [current] : []),
        );
      return removed;
    } catch {
      throw new Fault(
        "KEYCHAIN_UNAVAILABLE",
        "Credential cleanup did not finish. Unlock your credential store and retry. The account remains disconnected.",
      );
    }
  }
}
