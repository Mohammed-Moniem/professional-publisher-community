# First run: from a clone to a reviewed draft

This walkthrough is for someone who has just cloned the repository and asks Codex to set it up. All names, messages, and status examples below are **fictional illustrations**, not screenshots or captured output from an actual user. Private session URLs and credentials are deliberately omitted.

## 1. Let Codex prepare the local software

Open the cloned folder in Codex and paste the [README setup prompt](../README.md#set-it-up-with-codex). Keep the clone in a stable location.

Codex checks prerequisites, runs the commands in [SETUP.md](../SETUP.md), and registers the plugin. Installing dependencies and building the project does not connect a LinkedIn account. Chromium is needed for slide rendering; ffprobe is needed for video validation. Neither a model API key nor a paid publishing intermediary is required by this plugin.

A useful **fictional assistant report** looks like this; the assistant must use your actual check results:

> Local build: passed. Slide renderer: available. Plugin registration: complete.
>
> LinkedIn: not connected yet. Publishing: not tested. Scheduling: not enabled.
>
> Start a new task in this project so Codex can load the plugin, then ask me to connect your personal profile.

The runtime's `doctor` command checks local prerequisites. `check_capabilities` checks account readiness. A healthy runtime with no connected accounts is a normal first-run result.

If you have used this plugin before, Codex should inspect the existing installation and connection before starting another. It must not overwrite another marketplace source, delete data, or add a second copy of the same MCP server just to make setup appear successful.

## 2. Load the tools in a new task

Start a new task in the same project and paste:

```text
Use Professional Publisher Community. Read get_workflow and check_capabilities.
Show me whether the local tools and my LinkedIn connection are ready.
If disconnected, start personal-profile setup. Do not publish anything.
```

The assistant should call the tools, rather than merely quote the README. The first release exposes 32 tools. The ability to call `get_workflow` and `check_capabilities` is more useful evidence than a claimed tool count alone.

If tools are unavailable, see [troubleshooting](#when-a-step-does-not-work). Repeatedly reconnecting LinkedIn will not fix a missing MCP server.

## 3. Open the local setup form

Codex calls `connect_account` in personal mode and gives you a private browser link. Open the actual link returned by your running server. Do not construct a link from a screenshot or documentation example. It expires after 15 minutes; ask Codex to cancel and restart setup if it expires.

The form shows the account-connection label, instructions, callback address, requested permissions, and client-ID/client-secret fields. The [README wireframe](../README.md#what-setup-looks-like) illustrates it without exposing a real browser session.

**The form is local; authorization happens on LinkedIn.** The app credentials go to the OS credential store and LinkedIn, not into the conversation. Keep this Codex task and its setup server running until authorization finishes.

## 4. Prepare your own LinkedIn developer app

Open [LinkedIn developer apps](https://www.linkedin.com/developers/apps). Use your own account and accurate app details. LinkedIn can require a company-page association or verification when creating an app. A personal brand is not automatically a verified organization; if you cannot satisfy a requirement, tell Codex what LinkedIn requests and keep that step pending.

| In LinkedIn's developer portal | Your action | Expected checkpoint |
|---|---|---|
| App creation and verification | Supply your own app and page details; complete the checks LinkedIn requires | An app you are authorized to configure |
| Products | Request **Share on LinkedIn** and **Sign In with LinkedIn using OpenID Connect** | Access granted before attempting OAuth with those scopes |
| Auth / redirect URLs | Register the exact callback displayed by the local setup form | For the default runtime: `http://127.0.0.1:53692/callback` |
| App credentials | Enter your own client ID and secret directly into the local form | No credential pasted into chat or a repository file |

LinkedIn documents [Share on LinkedIn and its publishing permission](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin) and [OpenID Connect setup](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2). Portal wording and review requirements may change. Follow the live portal and official instructions, not a fictional screenshot.

Leave member-history access off unless your app has actually been approved for it. A request for `r_member_social` does not grant that permission, and an unavailable scope can prevent authorization. Company publishing is a separate setup path with [Community Management access requirements](https://learn.microsoft.com/en-us/linkedin/marketing/community-management-app-review); personal publishing need not wait for company approval.

## 5. Authorize and verify the destination

Choose **Connect through LinkedIn** in the local form. Review the LinkedIn account and permission request yourself, authorize if appropriate, then return to Codex. Do not paste the callback address or authorization code into chat.

Ask:

```text
Check my connection and list the available publishing identities. Tell me
which account is selected, which permissions were granted, whether refresh
access was granted, and which posting formats remain untested or restricted.
Do not create a test post.
```

A **fictional, assistant-written readiness report** might be:

```text
Account: Alex Example — personal profile
Connection: authorized
Permissions: openid, profile, w_member_social
Text publishing: permission present; live publication not tested
Company pages: not configured
History API: unavailable; CSV import is an alternative
Automatic refresh: not granted; browser reconnection will be needed
Scheduling: not enabled
```

Your report can differ. Check the actual destination before drafting. A successful login is not proof that every media format is available. Refresh only works when LinkedIn grants a usable refresh token; neither Codex nor this plugin can make access permanent.

## 6. Try a local draft first

```text
Draft a short introduction about [my topic] for [the identity we just checked].
Use only facts I provide. Save it locally and show the exact caption,
destination, visibility and attachments. Do not upload or publish it.
```

A **fictional preview**:

```text
Destination: Alex Example — personal profile
Visibility: Public if you later publish
Caption: I'm exploring a simpler way to share what I build.
Attachments: None
State: Local draft — not published
Draft ID and review digest: supplied by the tool, omitted from this example
```

Make edits until you are happy. Only an explicit instruction to publish the reviewed draft authorizes publication. Setup, “looks good,” and approval to learn your writing style are not interchangeable with a publishing instruction. No live test post is needed to finish the local setup walkthrough.

## 7. Add your voice or slides when you are ready

**Voice is optional.** Ask to enable learning, then choose a Shares.csv export, pasted samples, or another supported source. Codex should explain how your current AI host processes the selected samples before importing them. It should distinguish originals from reshares, report incomplete coverage, and ground the profile in your samples. Do not copy a maintainer's profile as your own.

```text
I want to set up my writing voice. Explain the available import options
and how my current AI host will process the samples before importing anything.
```

For slides:

```text
Create a six-slide LinkedIn document about [topic] using [my supplied facts].
Use my voice profile if available. Render the PDF, editable PowerPoint and
PNG previews. Inspect every slide and show me the caption and destination.
Keep everything local for review.
```

You can draft without historical-post access. Scheduling remains off unless you explicitly request installation of the local worker and approve an exact draft and time.

## When a step does not work

| What you see | Next step |
|---|---|
| `npm ci` cannot find a lockfile | Run it inside the cloned folder containing `package.json` and `package-lock.json`. |
| Node version is below 24, or `node` is unavailable | Ask Codex to guide installation of Node.js 24+ for your OS, then rerun the checks. |
| `codex` command is unavailable | Have Codex check the available CLI or use the manual MCP configuration path in SETUP.md. Do not claim plugin registration succeeded. |
| Plugin tools are absent | Start a new task, inspect plugin registration and generated paths, and check that the clone has not moved. Avoid duplicate manual/plugin registrations. |
| `RENDERER_UNAVAILABLE` or missing Chromium libraries | Run the documented Chromium installation; Linux may need `--with-deps`. Text drafts can still be prepared. |
| ffprobe is missing | Install a current FFmpeg distribution before preparing video. This does not block a text draft. |
| `CALLBACK_PORT_BUSY` | Finish or cancel the other setup session. Do not kill an unrelated process or change the callback without updating the app registration. |
| Setup link expires or access is denied | Ask Codex to cancel the old session and create a fresh private setup link. |
| LinkedIn rejects OAuth | Check product approval, requested scopes, your app credentials, and the exact redirect URL. Do not send the secret to Codex. |
| Credential store is unavailable | Unlock the OS store. Linux needs a running Secret Service session; there is no plaintext fallback. |
| Connection works but history/company access is unavailable | Treat this as a capability/approval limit. Use an allowed history import or complete the separate company-access process. |

## Contributing setup examples

Use fictional wireframes, diagrams, or text examples like those above. Clearly label them as illustrative. Do not commit captures of real accounts, browser profiles, tabs, bookmarks, email addresses, page IDs, OAuth session URLs, authorization codes, app credentials, private posts, or local data directories. Blurring one secret does not make an entire screenshot safe.

Running `scripts/install.mjs` rewrites the tracked `.mcp.json` with machine-specific paths. Before contributing, inspect that diff and exclude the generated version from your commit; keep the portable repository configuration. The generated `client-config/` directory is already ignored. Do not blindly stage every local setup file.

Run `node scripts/public-check.mjs` and review the actual diff before pushing. The scan is a useful check, not a guarantee that an arbitrary screenshot or file contains no private information.

## What was actually exercised

For this guide, a separate clone of the public repository was installed and built on macOS. Its generated configuration launched a real MCP subprocess with 32 discoverable tools, returned a disconnected account state, served the local setup form, cancelled that session, and created a synthetic local draft. An isolated data directory was used. No account credentials were supplied, no LinkedIn authorization was submitted, and no media or posts were uploaded.

This is a fresh-clone runtime walkthrough on an existing development computer, not a claim that a pristine OS, every client UI, or a real LinkedIn account was connected during this test. The release's cross-platform checks and remaining live-account limits are recorded in [VALIDATION.md](VALIDATION.md).
