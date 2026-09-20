# Validation and release status

This is a community preview, not a claim that every LinkedIn permission has been approved.

Automated coverage includes OAuth denial/state/origin failures, verified scope introspection, credential redaction, granted/expired refresh tokens, revoked accounts, incorrect company roles, immutable media, multipart video, PDF limits, failed media processing, 401/403/429 responses, uncertain responses, duplicate submission, stdio tool discovery, consent, archive filtering, voice isolation/freeze/reset, approval digests, SQLite ownership, scheduling windows, dashboard CSRF, and real PDF/PPTX/PNG rendering with Arabic.

Tests use synthetic content, a memory vault, and mocked LinkedIn responses. The renderer and MCP subprocess tests run real local code. They do not verify a real LinkedIn post. A separate macOS Keychain check successfully wrote and read a synthetic chunked credential and removed the test entries. CI runs macOS, Windows and Linux; consult the workflow result for the exact commit and platform outcome.

Live personal/company publishing for each format, organization approval, member-history access, actual refresh grants, Desktop UI installation, Windows Credential Manager and Linux Secret Service integration remain host/account dependent. No test creates a LinkedIn post. Native scheduling service installation is opt-in and is not exercised by CI.

The v0.2 calendar supports monthly viewing and drag-to-review rescheduling; a move requires explicit approval of the new time. Learning requires the current AI host to read evidence and save an updated profile; it is not an autonomous background model service. Browser history collection uses the host’s available browser tools and cannot guarantee access to every historical post. Imported archive coverage is reported rather than invented.

PDF and PNG rendering are the publication reference. PowerPoint exports retain editable objects, but exact line wrapping can differ by application and installed fonts. Latin/Arabic are bundled; other scripts are not guaranteed. Overflow is rejected rather than silently clipping or shrinking slide text.

v0.2 adds GitHub-signed build provenance and verification in release promotion. OS bundles remain platform-specific and do not have publisher Apple Developer ID notarization or Windows Authenticode signatures. Source installation remains supported when a desktop client rejects an unsigned extension. Linux requires a desktop Secret Service for credentials and Chromium system dependencies for rendering. `ffprobe` must be installed for video validation.

Prior v0.1 acceptance: Codex plugin installation succeeded with 32 tools; the dashboard and official MCPB 0.3 schema were checked. v0.2 exposes 43 tools and adds automated browser revision/voice editing, encrypted backup round trips/tamper rejection, safe restore, credential-generation cleanup, disconnect, reschedule and native-notification adapter tests. Native notification delivery remains dependent on OS permissions and desktop session; mocked adapter tests do not prove a user saw a notification. Check the CI run for the released commit before relying on cross-platform status.
