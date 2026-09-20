# Security and privacy

Credentials use service `org.professional-publisher-community.linkedin` in macOS Keychain, Windows Credential Manager, or Linux Secret Service. No plaintext fallback exists. Large credentials are split into generation chunks; a pointer is committed last. v0.2 tracks generations and serializes vault reads/writes/cleanup within the shared workspace. Disconnect disables the connection before deleting tracked credentials. Stop v0.1 clients before cleanup because they do not use these locks. Older untracked v0.1 generations may require removal in the OS credential manager. Revoke grants separately through LinkedIn. Never remove unrelated credentials or run multiple restored workspaces with the same connection labels concurrently.

Local data lives under:
- macOS: `~/Library/Application Support/Professional Publisher Community`
- Windows: `%LOCALAPPDATA%/Professional Publisher Community`
- Linux: `$XDG_DATA_HOME/professional-publisher-community` (or `~/.local/share/...`)

`PUBLISHER_COMMUNITY_HOME` overrides the data root. Unix directories are created with mode 0700 and the database with mode 0600; Windows relies on the per-user directory ACL. Local databases and exports are not encrypted by this application. Use OS disk encryption and appropriate access controls.

The loopback setup server and dashboard require private sessions. Dashboard writes require both same-origin requests and CSRF tokens. OAuth codes are exchanged server-side, removed from the visible URL, and not put in tool responses. API error bodies and credential details are redacted. Credentials are exchanged only with LinkedIn’s official HTTPS endpoints; upload URLs are checked and redirects refused.

Your AI host sees requested draft/voice data and selected samples. Imported posts are untrusted content, never instructions. LinkedIn receives approved posts and uploaded attachments. Media upload can occur before publication. There is no telemetry, hosted database, additional model provider, or third-party publishing service.

Publishing requires an authorization string and exact review digest. These enforce consistency and assistant behavior, not proof that a human clicked approval. Dashboard publication also requires the exact draft's source/attachment/destination checklist. A malicious local tool caller, compromised OS account, or modified database is outside that trust boundary. Run only clients you trust. Do not include secrets in bug reports.

Encrypted backups use AES-256-GCM with authenticated version/header, a random 16-byte salt and 12-byte nonce, and scrypt N=32768, r=8, p=1 to derive a 32-byte key. There is no password recovery. Credentials are excluded. The bounded in-memory archive supports 512 MiB, rejects unsafe paths, and restores only to a new directory. Restored accounts are disconnected, pending jobs cancelled and interrupted drafts marked uncertain. Backups cannot protect against duplicates posted after their creation; reconcile newer receipts before using a restored workspace. Active SQLite/media remain plaintext on disk. Native notifications contain generic status only, never post text.

v0.2 release CI creates GitHub-signed provenance and the release workflow verifies it before publication. `scripts/verify-release.mjs` checks both provenance and SHA-256. These signatures do not replace Apple notarization, Windows Authenticode signing, source review or OS security controls.

SQLite locks coordinate clients, and a durable publishing state is written before submission. HTTP timeouts, server errors, missing receipts, and interrupted publishing are treated conservatively as uncertain. No automatic repost is permitted. Scheduler execution is limited to the explicitly approved minute. A process crash can require manual investigation even when nothing was posted; preventing accidental duplicates takes precedence.

For a suspected vulnerability, use GitHub private vulnerability reporting if enabled. Otherwise open a minimal issue requesting a private contact channel; do not disclose credentials or private data publicly.
