import { AsyncEntry } from "@napi-rs/keyring";
import { randomUUID } from "node:crypto";
import { Fault } from "./model.js";
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
}
export const SERVICE = "org.professional-publisher-community.linkedin";
// Generation chunks keep each Windows credential under its native size limit.
// The pointer is committed last, preserving working credentials on partial failure.
export class Keychain implements Vault {
  private entry(account: string) {
    return new AsyncEntry(SERVICE, account, {
      linux: { store: "secret-service" },
    });
  }
  async get(account: string): Promise<Credentials | undefined> {
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
    try {
      const encoded = Buffer.from(JSON.stringify(value)).toString("base64");
      if (encoded.length > 100000) throw Error();
      const generation = randomUUID();
      const count = Math.ceil(encoded.length / 1000);
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
}
