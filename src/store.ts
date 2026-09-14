import { mkdirSync, chmodSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Fault, type Draft, type Connection, type Evidence } from "./model.js";
export const defaultHome =
  process.platform === "darwin"
    ? join(
        homedir(),
        "Library",
        "Application Support",
        "Professional Publisher Community",
      )
    : process.platform === "win32"
      ? join(
          process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
          "Professional Publisher Community",
        )
      : join(
          process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
          "professional-publisher-community",
        );
export class Store {
  root: string;
  constructor(root = process.env.PUBLISHER_COMMUNITY_HOME || defaultHome) {
    this.root = resolve(root);
  }
  database() {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    for (const dir of ["media", "decks", "backups"])
      mkdirSync(join(this.root, dir), { recursive: true, mode: 0o700 });
    const path = join(this.root, "publisher.sqlite");
    const db = new DatabaseSync(path);
    if (process.platform !== "win32") chmodSync(path, 0o600);
    db.exec(
      "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
    );
    const version = Number(
      (db.prepare("PRAGMA user_version").get() as any).user_version,
    );
    if (version > 1) {
      db.close();
      throw new Fault(
        "NEWER_DATABASE",
        "Install a newer version; this database must not be downgraded.",
      );
    }
    if (version === 0) {
      db.exec(
        "BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(collection,id)); CREATE TABLE IF NOT EXISTS locks (key TEXT PRIMARY KEY, pid INTEGER NOT NULL, token TEXT NOT NULL); PRAGMA user_version=1; COMMIT;",
      );
    }
    return db;
  }
  async init() {
    const db = this.database();
    db.close();
  }
  private valid(group: string, id?: string) {
    if (
      !/^[a-z][a-z0-9_-]*$/.test(group) ||
      (id !== undefined && !/^[A-Za-z0-9_-]+$/.test(id))
    )
      throw new Fault("INVALID_ID", "Invalid local identifier.");
  }
  async read<T>(group: string, id: string): Promise<T | undefined> {
    this.valid(group, id);
    const db = this.database();
    try {
      const r = db
        .prepare("SELECT value FROM records WHERE collection=? AND id=?")
        .get(group, id) as any;
      return r ? JSON.parse(r.value) : undefined;
    } finally {
      db.close();
    }
  }
  async write(group: string, id: string, value: unknown) {
    this.valid(group, id);
    const db = this.database();
    try {
      db.prepare(
        "INSERT INTO records VALUES (?,?,?) ON CONFLICT(collection,id) DO UPDATE SET value=excluded.value",
      ).run(group, id, JSON.stringify(value));
    } finally {
      db.close();
    }
  }
  async remove(group: string, id: string) {
    this.valid(group, id);
    const db = this.database();
    try {
      db.prepare("DELETE FROM records WHERE collection=? AND id=?").run(
        group,
        id,
      );
    } finally {
      db.close();
    }
  }
  async list<T>(group: string): Promise<T[]> {
    this.valid(group);
    const db = this.database();
    try {
      return db
        .prepare("SELECT value FROM records WHERE collection=? ORDER BY rowid")
        .all(group)
        .map((r: any) => JSON.parse(r.value));
    } finally {
      db.close();
    }
  }
  async backup() {
    const db = this.database();
    const path = join(this.root, "backups", Date.now() + ".sqlite");
    try {
      db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
      return path;
    } finally {
      db.close();
    }
  }
  async draft(id: string) {
    const d = await this.read<Draft>("drafts", id);
    if (!d) throw new Fault("DRAFT_NOT_FOUND", "Draft not found.");
    return d;
  }
  async connection(id: string) {
    const c = await this.read<Connection>("connections", id);
    if (!c)
      throw new Fault(
        "NOT_CONNECTED",
        "Connect this account before uploading or publishing.",
      );
    if (c.revoked || c.expiresAt <= Date.now() + 60000)
      throw new Fault(
        "RECONNECT_REQUIRED",
        "LinkedIn access expired or was revoked. Reconnect this account.",
      );
    return c;
  }
  async evidence(e: Evidence) {
    await this.write("evidence", hash([e.connectionId, e.author, e.format]), e);
  }
  async lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const db = this.database(),
      token = randomUUID();
    try {
      db.exec("BEGIN IMMEDIATE");
      const old = db
        .prepare("SELECT pid FROM locks WHERE key=?")
        .get(key) as any;
      if (old) {
        let dead = false;
        if (Number.isSafeInteger(old.pid) && old.pid > 0) {
          try {
            process.kill(old.pid, 0);
          } catch (e) {
            dead = (e as NodeJS.ErrnoException).code === "ESRCH";
          }
        }
        if (!dead)
          throw new Fault(
            "BUSY",
            "Another process owns this operation. Inspect its result before retrying.",
          );
        db.prepare("DELETE FROM locks WHERE key=?").run(key);
      }
      db.prepare("INSERT INTO locks VALUES(?,?,?)").run(
        key,
        process.pid,
        token,
      );
      db.exec("COMMIT");
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      db.close();
      throw e;
    }
    db.close();
    try {
      return await fn();
    } finally {
      const release = this.database();
      try {
        release
          .prepare("DELETE FROM locks WHERE key=? AND token=?")
          .run(key, token);
      } finally {
        release.close();
      }
    }
  }
}
export function hash(value: unknown) {
  return createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
}
