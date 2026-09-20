import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Store } from "./store.js";
const exec = promisify(execFile);
export class Notifications {
  constructor(
    public store: Store,
    private run = exec,
  ) {}
  async configure(enabled: boolean) {
    await this.store.write("settings", "notifications", { enabled });
    return {
      enabled,
      notice:
        "Your OS may require notification permission. Delivery failures remain visible in the dashboard.",
    };
  }
  async deliver(id: string) {
    if (!(await this.store.read<any>("settings", "notifications"))?.enabled)
      return;
    await this.store.lock("notification-" + id, async () => {
      const n = await this.store.read<any>("notifications", id);
      if (!n || n.nativeAttemptAt) return;
      n.nativeAttemptAt = Date.now();
      n.nativeStatus = "attempted";
      await this.store.write("notifications", id, n);
      // Fixed vocabulary: no post text, personal names or provider errors on a lock screen.
      const state = [
        "published",
        "missed",
        "needs_attention",
        "uncertain",
      ].includes(n.state)
        ? n.state.replaceAll("_", " ")
        : "updated";
      const message =
        "Scheduled post " + state + ". Open your local publishing dashboard.";
      try {
        if (process.platform === "darwin")
          await this.run(
            "osascript",
            [
              "-e",
              `display notification "${message}" with title "Professional Publisher"`,
            ],
            { timeout: 10000 },
          );
        else if (process.platform === "linux")
          await this.run(
            "notify-send",
            [
              "--app-name=Professional Publisher",
              "Professional Publisher",
              message,
            ],
            { timeout: 10000 },
          );
        else if (process.platform === "win32") {
          const script = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null; $doc = New-Object Windows.Data.Xml.Dom.XmlDocument; $doc.LoadXml('<toast><visual><binding template="ToastGeneric"><text>Professional Publisher</text><text>${message}</text></binding></visual></toast>'); $toast = [Windows.UI.Notifications.ToastNotification]::new($doc); [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Microsoft.Windows.PowerShell') .Show($toast)`;
          await this.run(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-EncodedCommand",
              Buffer.from(
                script.replace(") .Show", ").Show"),
                "utf16le",
              ).toString("base64"),
            ],
            { timeout: 10000 },
          );
        } else throw Error();
        n.nativeStatus = "submitted_to_os";
      } catch {
        n.nativeStatus = "unavailable";
      }
      await this.store.write("notifications", id, n);
    });
  }
}
