# Architecture

One TypeScript engine serves every client over stdio MCP. Skills carry the writing/review behavior; `get_workflow` exposes the same instructions to clients without skill support. Native fetch handles official LinkedIn requests.

`oauth.ts`, `keychain.ts`, `renewal.ts`, and `linkedin.ts` own account access. `publisher.ts` and `media.ts` validate immutable drafts, upload snapshots, poll processing, gate identities and formats, and persist receipts. The public project uses its own credential service and data directory; it does not migrate a personal installation implicitly.

`store.ts` stores JSON records in SQLite with WAL, full synchronous writes, schema version checks and PID-owned locks. A dead process lock can be reclaimed. A live or unknown owner blocks the action. Published/uncertain draft state survives process exit; reclaiming a lock never resets it. Databases from newer schema versions are rejected. Version 1 has no destructive schema migrations.

`workspace.ts` handles consent, deduplicated samples, profile evidence, approved edits, idea records and identity isolation. The host LLM performs analysis; no background model account is configured. `decks.ts` snapshots images and creates versioned sources; Chromium renders offline HTML into selectable-text PDFs and PNGs. The vendored MIT PptxGenJS runtime produces editable text/shapes in PPTX. Charts are deterministic source-driven graphics, not image-generation output.

`scheduler.ts` records exact approved digests and times. The optional OS worker launches independent local ticks. Each job has an ownership lock; a final deadline guard runs again immediately before the network submission, after token renewal. Interrupted jobs require attention; expired minutes are skipped. The dashboard provides local result notifications.

The local HTTP dashboard is ephemeral, cookie authenticated, and has no publish endpoint. Publishing remains an explicit MCP operation or a previously approved scheduled job. It presents ideas, drafts, exports, voice settings, account scope/expiry information, and job receipts.

Distribution scripts use an allowlist and install lockfile-pinned production dependencies. Platform artifacts contain a Node executable, native modules, Chromium, fonts, a CycloneDX dependency inventory, and upstream license files. ffprobe is a separately installed prerequisite. Runtime data never belongs in the distributed plugin folder.
