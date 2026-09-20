import {
  randomBytes,
  scrypt,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import {
  readFile,
  writeFile,
  readdir,
  lstat,
  mkdir,
  rename,
  rm,
  access,
} from "node:fs/promises";
import { join, resolve, dirname, isAbsolute } from "node:path";
import JSZip from "jszip";
import { Store } from "./store.js";
import { Fault } from "./model.js";

const MAGIC = Buffer.from("PPCBACK2");
const LIMIT = 512 * 1024 * 1024;
const derive = (password: string, salt: Buffer) =>
  new Promise<Buffer>((ok, fail) =>
    scrypt(
      password,
      salt,
      32,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (e, key) => (e ? fail(e) : ok(key)),
    ),
  );
function passwordCheck(password: string) {
  if (password.length < 12 || password.length > 1024)
    throw new Fault(
      "WEAK_PASSPHRASE",
      "Use a backup passphrase of 12–1024 characters. Keep it outside chat.",
    );
}
// Versioned, authenticated envelope. No credential store values enter this module.
export async function exportBackup(
  store: Store,
  destination: string,
  password: string,
) {
  passwordCheck(password);
  return store.lock("backup", async () => {
    const db = store.database();
    let records;
    try {
      records = db
        .prepare(
          "SELECT collection,id,value FROM records ORDER BY collection,id",
        )
        .all();
    } finally {
      db.close();
    }
    const zip = new JSZip();
    let size = 0;
    zip.file(
      "records.json",
      JSON.stringify({ version: 2, root: store.root, records }),
    );
    async function add(dir: string) {
      for (const name of await readdir(join(store.root, dir))) {
        const rel = dir + "/" + name,
          path = join(store.root, rel),
          info = await lstat(path);
        if (info.isSymbolicLink())
          throw new Fault(
            "UNSAFE_BACKUP_FILE",
            "Backup refuses symbolic links.",
          );
        if (info.isDirectory()) await add(rel);
        else if (info.isFile()) {
          size += info.size;
          if (size > LIMIT)
            throw new Fault(
              "BACKUP_TOO_LARGE",
              "This backup format supports up to 512 MiB of local assets.",
            );
          zip.file(rel, await readFile(path));
        }
      }
    }
    await add("media");
    await add("decks");
    const plain = await zip.generateAsync({
      type: "nodebuffer",
      compression: "STORE",
    });
    if (plain.length > LIMIT)
      throw new Fault("BACKUP_TOO_LARGE", "Backup exceeds 512 MiB.");
    const salt = randomBytes(16),
      iv = randomBytes(12),
      key = await derive(password, salt);
    const header = Buffer.concat([MAGIC, salt, iv]);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(header);
    try {
      const output = Buffer.concat([
        header,
        cipher.update(plain),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      await writeFile(resolve(destination), output, {
        flag: "wx",
        mode: 0o600,
      });
    } finally {
      key.fill(0);
      plain.fill(0);
    }
    return {
      path: resolve(destination),
      format: 2,
      credentialsIncluded: false,
      bytes: size,
    };
  });
}

export async function restoreBackup(
  source: string,
  target: string,
  password: string,
) {
  passwordCheck(password);
  if (!isAbsolute(source) || !isAbsolute(target))
    throw new Fault(
      "ABSOLUTE_PATH_REQUIRED",
      "Use absolute backup and target paths.",
    );
  target = resolve(target);
  if ((await lstat(source)).size > LIMIT + 52)
    throw new Fault("BACKUP_TOO_LARGE", "Backup exceeds 512 MiB.");
  const bytes = await readFile(source);
  if (bytes.length < 52 || !bytes.subarray(0, 8).equals(MAGIC))
    throw new Fault("INVALID_BACKUP", "Unsupported backup format.");
  const key = await derive(password, bytes.subarray(8, 24));
  let plain: Buffer;
  try {
    const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(24, 36));
    cipher.setAAD(bytes.subarray(0, 36));
    cipher.setAuthTag(bytes.subarray(-16));
    plain = Buffer.concat([
      cipher.update(bytes.subarray(36, -16)),
      cipher.final(),
    ]);
  } catch {
    throw new Fault(
      "BACKUP_AUTH_FAILED",
      "Incorrect passphrase or damaged backup. Nothing was restored.",
    );
  } finally {
    key.fill(0);
  }
  // Restore exclusively to a NEW directory; never replace live duplicate-prevention records.
  try {
    await access(target);
    throw new Fault(
      "RESTORE_TARGET_EXISTS",
      "Choose a new directory. Existing workspaces cannot be overwritten.",
    );
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  const stage = target + ".restore-" + randomBytes(8).toString("hex");
  try {
    const zip = await JSZip.loadAsync(plain);
    let declaredSize = 0;
    for (const file of Object.values(zip.files)) {
      const size = (file as any)._data?.uncompressedSize || 0;
      declaredSize += size;
      if (declaredSize > LIMIT || Object.keys(zip.files).length > 100000)
        throw new Fault(
          "BACKUP_TOO_LARGE",
          "Expanded backup exceeds format limits.",
        );
    }
    const manifestFile = zip.file("records.json");
    if (!manifestFile)
      throw new Fault("INVALID_BACKUP", "Missing backup manifest.");
    const manifest = JSON.parse(await manifestFile.async("string"));
    if (
      manifest.version !== 2 ||
      typeof manifest.root !== "string" ||
      !Array.isArray(manifest.records)
    )
      throw new Fault("INVALID_BACKUP", "Invalid backup manifest.");
    const store = new Store(stage);
    await store.init();
    let total = 0;
    for (const file of Object.values(zip.files)) {
      if (file.dir || file.name === "records.json") continue;
      const original = (file as any).unsafeOriginalName || file.name;
      if (
        original !== file.name ||
        !/^(media|decks)\//.test(file.name) ||
        file.name.includes("\\") ||
        file.name
          .split("/")
          .some((p) => p === ".." || p === "." || p.includes(":"))
      )
        throw new Fault("INVALID_BACKUP", "Unsafe backup path.");
      const data = await file.async("nodebuffer");
      total += data.length;
      if (total > LIMIT)
        throw new Fault("BACKUP_TOO_LARGE", "Expanded backup exceeds 512 MiB.");
      const path = join(stage, file.name);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, data, { flag: "wx", mode: 0o600 });
    }
    const pathFields = new Set([
      "path",
      "storedPath",
      "imagePath",
      "logoPath",
      "pdf",
      "pptx",
      "source",
      "html",
      "contactSheet",
      "slides",
    ]);
    function relocate(value: any, field = ""): any {
      if (typeof value === "string") {
        if (!pathFields.has(field)) return value;
        const normalized = value.replaceAll("\\", "/"),
          old = manifest.root.replaceAll("\\", "/").replace(/\/$/, "");
        for (const folder of ["media", "decks"])
          if (normalized.startsWith(old + "/" + folder + "/")) {
            const suffix = normalized.slice(old.length + 1);
            if (suffix.split("/").includes(".."))
              throw new Fault("INVALID_BACKUP", "Unsafe stored path.");
            return join(target, suffix);
          }
        return value;
      }
      if (Array.isArray(value)) return value.map((v) => relocate(v, field));
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value).map(([k, v]) => [k, relocate(v, k)]),
        );
      return value;
    }
    for (const file of Object.values(zip.files)) {
      if (/^decks\/[a-f0-9-]{36}\/source\.json$/.test(file.name)) {
        const path = join(stage, file.name);
        await writeFile(
          path,
          JSON.stringify(
            relocate(JSON.parse(await readFile(path, "utf8"))),
            null,
            2,
          ),
          { mode: 0o600 },
        );
      }
    }
    for (const row of manifest.records) {
      if (
        ["settings", "approvals", "review_checks", "notifications"].includes(
          row.collection,
        )
      )
        continue;
      let value = relocate(JSON.parse(row.value));
      if (row.collection === "connections")
        value = {
          ...value,
          revoked: true,
          expiresAt: 0,
          refreshSupported: false,
          renewalNotice: "Restored workspace: reconnect this account.",
        };
      if (
        row.collection === "schedules" &&
        ["scheduled", "running"].includes(value.state)
      )
        value = {
          ...value,
          state: "cancelled",
          authorization: "",
          restored: true,
        };
      if (row.collection === "drafts") {
        if (value.state === "publishing") value.state = "uncertain";
        if (value.state !== "published")
          value.attachments = value.attachments.map((a: any) => ({
            ...a,
            asset: undefined,
            uploadState: undefined,
          }));
      }
      await store.write(row.collection, row.id, value);
    }
    // Stage beside the new workspace and activate with a same-filesystem rename.
    // Never merge imported state into a live workspace or roll back its receipts.
    try {
      await access(target);
      throw new Fault(
        "RESTORE_TARGET_EXISTS",
        "Target appeared during restore; choose another directory.",
      );
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    await rename(stage, target);
    return {
      path: target,
      reconnectRequired: true,
      schedulesReactivated: false,
      notice:
        "Use PUBLISHER_COMMUNITY_HOME to open the restored workspace. Old backups may omit newer posts; reconcile those before publishing.",
    };
  } finally {
    plain.fill(0);
    await rm(stage, { recursive: true, force: true });
  }
}
