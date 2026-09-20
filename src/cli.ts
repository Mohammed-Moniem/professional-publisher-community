#!/usr/bin/env node
import { Store } from "./store.js";
import { Keychain } from "./keychain.js";
import { LinkedIn, API_VERSION } from "./linkedin.js";
import { Publisher } from "./publisher.js";
import { Workspace } from "./workspace.js";
import { Decks } from "./decks.js";
import { Scheduler } from "./scheduler.js";
import { Dashboard } from "./dashboard.js";
import { OAuth } from "./oauth.js";
import { publicError, Fault } from "./model.js";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { exportBackup, restoreBackup } from "./backups.js";
import { Accounts } from "./accounts.js";
import { emitKeypressEvents } from "node:readline";
async function passphrase() {
  if (!process.stdin.isTTY)
    throw new Fault(
      "TERMINAL_REQUIRED",
      "Use an interactive terminal or the private dashboard to enter a backup passphrase. Never put it in chat or command arguments.",
    );
  process.stdout.write("Backup passphrase (hidden): ");
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const done = () => {
      process.stdin.off("keypress", keypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const keypress = (text: string, key: any) => {
      if (key.ctrl && key.name === "c") {
        done();
        reject(new Fault("CANCELLED", "Backup cancelled."));
      } else if (key.name === "return") {
        done();
        resolve(value);
      } else if (key.name === "backspace")
        value = Array.from(value).slice(0, -1).join("");
      else if (text && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(text))
        value += text;
    };
    process.stdin.on("keypress", keypress);
  });
}
const exec = promisify(execFile),
  store = new Store(),
  api = new LinkedIn(store, new Keychain()),
  publisher = new Publisher(store, api),
  workspace = new Workspace(store, api),
  decks = new Decks(store),
  scheduler = new Scheduler(store, publisher);
const name = "org.professional-publisher-community.worker";
const cli = fileURLToPath(import.meta.url);
const xml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
export async function installWorker(remove = false) {
  if (process.platform === "darwin") {
    const path = join(homedir(), "Library", "LaunchAgents", name + ".plist");
    await mkdir(join(homedir(), "Library", "LaunchAgents"), {
      recursive: true,
    });
    await exec("launchctl", [
      "bootout",
      `gui/${process.getuid!()}`,
      path,
    ]).catch(() => {});
    if (remove) {
      await unlink(path).catch(() => {});
      await store.write("settings", "worker", {
        installed: false,
        at: Date.now(),
      });
      return;
    }
    await writeFile(
      path,
      `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${name}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(cli)}</string><string>tick</string></array><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH || "")}</string><key>PUBLISHER_COMMUNITY_HOME</key><string>${xml(store.root)}</string></dict><key>StartInterval</key><integer>15</integer><key>RunAtLoad</key><true/></dict></plist>`,
      { mode: 0o600 },
    );
    await exec("launchctl", ["bootstrap", `gui/${process.getuid!()}`, path]);
  } else if (process.platform === "win32") {
    if (remove) {
      await exec("schtasks", ["/Delete", "/TN", name, "/F"]);
      await store.write("settings", "worker", {
        installed: false,
        at: Date.now(),
      });
      return;
    }
    const action = `"${process.execPath}" "${cli}" tick`;
    await exec("schtasks", [
      "/Create",
      "/TN",
      name,
      "/TR",
      action,
      "/SC",
      "MINUTE",
      "/MO",
      "1",
      "/F",
    ]);
  } else if (process.platform === "linux") {
    const dir = join(homedir(), ".config", "systemd", "user");
    await mkdir(dir, { recursive: true });
    if (remove) {
      await exec("systemctl", ["--user", "disable", "--now", name + ".timer"]);
      for (const ext of ["timer", "service"])
        await unlink(join(dir, name + "." + ext)).catch(() => {});
    } else {
      const quote = (s: string) =>
        '"' +
        s
          .replaceAll("\\", "\\\\")
          .replaceAll('"', '\\"')
          .replaceAll("%", "%%") +
        '"';
      await writeFile(
        join(dir, name + ".service"),
        `[Unit]\nDescription=Professional Publisher approved jobs\n[Service]\nType=oneshot\nEnvironment=${quote("PUBLISHER_COMMUNITY_HOME=" + store.root)}\nExecStart=${quote(process.execPath)} ${quote(cli)} tick\n`,
      );
      await writeFile(
        join(dir, name + ".timer"),
        `[Unit]\nDescription=Professional Publisher schedule timer\n[Timer]\nOnCalendar=*-*-* *:*:00\nAccuracySec=1s\nPersistent=false\n[Install]\nWantedBy=timers.target\n`,
      );
      await exec("systemctl", ["--user", "daemon-reload"]);
      await exec("systemctl", ["--user", "enable", "--now", name + ".timer"]);
    }
  } else
    throw new Fault(
      "UNSUPPORTED_OS",
      "Worker supports macOS, Windows and Linux.",
    );
  await store.write("settings", "worker", {
    installed: !remove,
    at: Date.now(),
    platform: process.platform,
  });
}
async function main() {
  const command = process.argv[2] || "help";
  if (command === "mcp") {
    await import("./server.js");
    return;
  }
  if (command === "doctor") {
    let probe = false;
    try {
      await exec("ffprobe", ["-version"]);
      probe = true;
    } catch {}
    console.log(
      JSON.stringify(
        {
          version: "0.2.0",
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          dataDirectory: store.root,
          apiVersion: API_VERSION,
          chromium: existsSync(chromium.executablePath()),
          ffprobe: probe,
          credentialStore:
            process.platform === "darwin"
              ? "macOS Keychain"
              : process.platform === "win32"
                ? "Windows Credential Manager"
                : "Linux Secret Service",
          worker: await store.read("settings", "worker"),
          notice:
            "Credential store availability is verified on connection; no secrets read by diagnostics.",
        },
        null,
        2,
      ),
    );
  } else if (command === "dashboard") {
    const dashboard = new Dashboard(store, workspace, decks, scheduler);
    console.log((await dashboard.start()).url);
  } else if (command === "connect") {
    console.log(
      JSON.stringify(
        await new OAuth(store, new Keychain()).start(
          process.argv[3] || "personal",
          process.argv[4] === "company" ? "company" : "personal",
        ),
      ),
    );
  } else if (command === "tick") {
    console.log(JSON.stringify(await scheduler.tick()));
  } else if (command === "worker") {
    await scheduler.tick();
    setInterval(
      () =>
        void scheduler
          .tick()
          .catch((e) => console.error(JSON.stringify(publicError(e)))),
      15000,
    );
  } else if (command === "install-worker" || command === "uninstall-worker") {
    await installWorker(command === "uninstall-worker");
    console.log(
      command === "install-worker"
        ? "Local worker installed. Only explicitly approved jobs can publish."
        : "Worker removed. Drafts and account data retained.",
    );
  } else if (command === "backup") {
    await store.init();
    console.log(
      JSON.stringify(
        await exportBackup(
          store,
          process.argv[3] ||
            join(store.root, "backups", Date.now() + ".ppcenc"),
          await passphrase(),
        ),
      ),
    );
  } else if (command === "restore") {
    console.log(
      JSON.stringify(
        await restoreBackup(
          process.argv[3] || "",
          process.argv[4] || "",
          await passphrase(),
        ),
      ),
    );
  } else if (command === "disconnect") {
    console.log(
      JSON.stringify(
        await new Accounts(store, new Keychain(store)).disconnect(
          process.argv[3] || "",
        ),
      ),
    );
  } else if (command === "notifications") {
    if (!["on", "off"].includes(process.argv[3]))
      throw new Fault("INVALID_INPUT", "Use notifications on|off.");
    console.log(
      JSON.stringify(
        await scheduler.notifications.configure(process.argv[3] === "on"),
      ),
    );
  } else
    console.log(
      "Professional Publisher Community\nCommands: mcp, connect [id] [personal|company], doctor, dashboard, tick, worker, install-worker, uninstall-worker, backup [output], restore <backup> <new-directory>, disconnect <id>, notifications on|off\nBackup passphrases are entered privately. No command publishes content without an approved draft/job.",
    );
}
main().catch((e) => {
  console.error(JSON.stringify(publicError(e)));
  process.exitCode = 1;
});
