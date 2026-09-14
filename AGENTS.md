# Working in this repository

## When the user asks you to set up the plugin

Read README.md, SETUP.md, and docs/ONBOARDING.md. Follow the README's guided first-run flow and use actual tool/command results for each checkpoint. Do not perform setup merely because this repository was opened.

- Check the OS, Node.js 24+, npm, Git and available client before installing anything. Run commands from this repository's root.
- Install dependencies with the lockfile, build, prepare the renderer, generate client configuration, and inspect existing plugin/server registrations before adding this plugin. Preserve other registrations, existing accounts, and user data. Do not silently rebind an existing marketplace to another clone.
- Explain the new-task boundary for Codex tool discovery. After tools load, read get_workflow and check_capabilities. Distinguish local software readiness, OAuth connection, granted permissions, and live publishing verification.
- Guide the user through their own developer-app setup. Credentials belong only in the local setup form and OS credential store. Never ask for secrets in chat or put them in source/config files. Do not invent business details or claim that installation grants LinkedIn approval.
- Setup does not authorize posting, media upload, history import or worker installation. Obtain the user's actual intent for those separate actions. Never use a live post as an automatic installation test.
- Finish with verified results and specific outstanding user/account steps. Examples in the onboarding guide are fictional; never present them as observed results.

## Public repository hygiene

Use native fetch. Do not add axios; it is a banned dependency. Do not commit local data, credentials, private voice profiles, session links or captures of real user environments. scripts/install.mjs rewrites .mcp.json with local paths; review and exclude that generated diff from public commits. Use synthetic, clearly labelled onboarding examples and run scripts/public-check.mjs before publication.
