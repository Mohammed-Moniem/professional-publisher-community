# Installation and first use

## 1. Install the runtime

Use the source commands in README, or extract the release archive matching your OS and CPU into a stable user-owned directory. Do not run an extracted archive from a temporary download preview. Verify its SHA-256 against the release checksum.

For a bundle, use `runtime/node` (macOS/Linux) or `runtime/node.exe` (Windows) in place of `node` in the commands below. Bundles include Chromium; source installs need `npx playwright install chromium`. Video validation requires a current `ffprobe` on PATH. Run:

```sh
node scripts/install.mjs
node scripts/launch.mjs doctor
```

The installer generates configurations and rewrites only this project’s MCP configuration file with the absolute runtime path. It does not alter your existing client settings. Keep the directory in place. Repeat this step after moving it or upgrading.

## 2. Choose a client

### Codex

From the prepared runtime directory:

```sh
codex plugin marketplace add .
codex plugin add professional-publisher-community@professional-publisher-community
```

Start a new task so the skill and tools are discovered. Alternatively, merge `client-config/codex.toml` into your Codex configuration and load the supplied skill folder separately. Do not register both the plugin and the manual server, which would duplicate the tools.

### Claude Code

From the prepared directory, open Claude Code and run:

```text
/plugin marketplace add .
/plugin install professional-publisher-community@professional-publisher-community
```

Restart the session. For a temporary local development install, use `claude --plugin-dir /absolute/path/to/professional-publisher-community`.

### Claude Desktop

Install the `.mcpb` asset matching your platform and architecture through Desktop’s extension settings. The manifest launches the bundled Node runtime. These are unsigned community bundles; installation is subject to the client’s extension policy.

For a manual installation, merge the named server from `client-config/mcp.json` into Desktop’s local MCP configuration and restart Desktop. Preserve all other servers. Ask the assistant to call `get_workflow` before first use: the MCPB includes the writing workflow but does not assume Desktop supports Claude Code plugin skills.

### Other local MCP clients

Use `client-config/mcp.json`; the transport is stdio. Call `get_workflow`. This local server cannot be connected as a hosted URL in cloud-only clients.

## 3. Connect your own LinkedIn developer app

Ask the assistant to call `connect_account` with a stable connection ID such as `personal`, and mode `personal`. Open the private local setup URL returned by the tool.

1. Create a LinkedIn developer app. LinkedIn may require associating and verifying a company page even for a personal publishing app.
2. Request **Share on LinkedIn** and **Sign In with LinkedIn using OpenID Connect**.
3. Register the exact redirect URL shown by setup: `http://127.0.0.1:53692/callback`.
4. Enter the app client ID and secret only in the local setup form. Never paste them into chat, configuration, or GitHub.
5. Complete LinkedIn authorization, return to the assistant, and run `check_capabilities` and `list_identities`.

For company publishing, use a separate app where LinkedIn requires it, mode `company`, and complete Community Management review and organization verification. Your company role and granted scopes determine available identities. A personal brand is not automatically a registered organization. Do not submit invented business details.

Leave `readHistory` false unless LinkedIn has already approved `r_member_social` for the app. Enabling that flag cannot grant the permission; it may cause OAuth to fail if unavailable. `history_access` tells you which import route is available.

No real post is created by connecting. Format readiness remains unverified until an explicitly authorized live operation succeeds.

## 4. Set up your voice

Opt in before importing writing samples. The assistant can analyze them using your current Codex/Claude session, under that host’s data policies. There is no extra model key.

Use a LinkedIn data export containing **Shares.csv**, a standalone CSV, pasted samples, or optional browser-visible samples. Only the Shares file is imported from ZIP archives; messages and contacts are ignored. Classify originals, commentary, reshares, and truncated posts honestly. Use `classify_sample` for reviewed archive rows. Ask the assistant to paginate through all imported samples, identify the coverage limits, and save a profile with source IDs.

Sparse samples produce a provisional profile. Freeze learning, export the profile, or reset it with `manage_voice`. Approved edits are added only when learning is enabled. Draft approval for learning is separate from publication permission.

## 5. Create and review slides

Provide a brief and source material. The assistant writes slide copy using your voice, saves a source deck, renders it locally, and inspects every PNG. You receive a PDF, editable PPTX, JSON source, HTML, and PNGs. Revise a particular slide by creating a new immutable version. Prepare the final PDF as a document attachment and review its caption and destination.

Supported fonts cover Latin and Arabic. Other scripts may require adding properly licensed fonts. PowerPoint layout depends on fonts installed in the viewing application. The generated PDF and PNGs are the publication reference. Charts require a source note and currently support nonnegative values.

## 6. Publish or schedule

For immediate publication, review exact text, destination and attachments, then explicitly say to publish that draft. The tool returns the post link or a precise failure/uncertainty state. Never resubmit an uncertain draft to guess whether it worked.

Scheduling is optional. Install the worker only when you want unattended execution of explicitly approved jobs:

```sh
node scripts/launch.mjs install-worker
```

Review the exact draft, date, whole-minute time, UTC offset and IANA time zone (for example `Asia/Dubai`). The worker must be installed, the user session available, and the computer awake and online during that minute. Jobs missed because of sleep, offline access, media processing or reauthorization are not published late. Review the dashboard receipt and explicitly reschedule.

Local job results appear in the dashboard’s Calendar; there are no email/push notifications. Windows uses Task Scheduler, macOS launchd, Linux a systemd user timer. The worker captures the installed runtime path; reinstall it after moving/upgrading that runtime. On Windows, scheduling uses the default data directory; do not use a custom `PUBLISHER_COMMUNITY_HOME` for scheduled jobs.

```sh
node scripts/launch.mjs uninstall-worker
node scripts/launch.mjs backup
```

Uninstalling a plugin does not remove credentials, data, or an independently installed worker. Remove the worker first if no longer wanted. `backup` copies SQLite state; back up the media/decks folders separately. Credentials are not included. Keep backups private.

## Renewal

If LinkedIn issued a valid refresh token, renewal happens before API use. It preserves LinkedIn’s original refresh deadline. A worker does not silently renew an account that has been revoked. Without refresh access, reconnect through `connect_account`; the saved app credentials stay in the OS vault and the browser may reuse your LinkedIn login. Reauthorization can still be necessary.
