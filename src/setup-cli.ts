import { Store } from "./store.js";
import { Keychain } from "./keychain.js";
import { OAuth } from "./oauth.js";
import { publicError } from "./model.js";
const mode = process.argv[2] ?? "personal";
if (mode !== "personal" && mode !== "company")
  throw new Error("Use personal or company.");
const oauth = new OAuth(new Store(), new Keychain());
try {
  const session = await oauth.start(mode, mode);
  console.log(JSON.stringify(session, null, 2));
} catch (e) {
  console.error(JSON.stringify(publicError(e)));
  process.exitCode = 1;
}
process.on("SIGINT", () => void oauth.close());
process.on("SIGTERM", () => void oauth.close());
