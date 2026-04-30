# AGENTS.md — Command-X Phone

Quick-start instructions for coding agents working in this repository. Read
`AGENT_MEMORY.md` first for prior-session context, then use `CLAUDE.md` for the
full architecture reference.

## Project snapshot

- SillyTavern third-party extension, currently v0.13.0.
- Vanilla browser JavaScript, CSS, and HTML loaded directly by SillyTavern.
- No bundler, no `package.json`, and no build step.
- Main frontend files:
  - `index.js` — extension logic and Nova frontend.
  - `style.css` — phone shell and app styling.
  - `settings.html` — SillyTavern settings fragment.
  - `manifest.json` — extension metadata; keep its version aligned with
    `VERSION` in `index.js`.
- Companion plugin:
  - `server-plugin/nova-agent-bridge/` — CommonJS SillyTavern server plugin for
    Nova filesystem and allow-listed shell routes.
- Tests:
  - `test/*.mjs` — Node `--test` suites for helpers, Nova tools/state,
    approval flow, plugin helpers, diffs, and related behavior.

Do not modify `st-docs/`; it is a read-only reference copy of SillyTavern docs.

## Required workflow

1. Read `AGENT_MEMORY.md` before planning or editing.
2. Inspect only the files relevant to the request.
3. Make the smallest complete change that satisfies the task.
4. Preserve existing raw-extension runtime assumptions: no bundling, no new
   dependencies unless explicitly necessary.
5. At the end of a PR, append useful future-agent context to `AGENT_MEMORY.md`.

## Validation

For code changes, run the relevant existing tests:

```bash
node --test test/*.mjs
```

For targeted work, a narrower test is often enough during iteration:

```bash
node --test test/helpers.test.mjs
node --test test/nova-tool-dispatch.test.mjs
```

To syntax-check `index.js` as an ES module without a full SillyTavern runtime:

```bash
node --input-type=module --check < index.js
```

This checks parser-level JavaScript syntax in the standalone extension checkout
without resolving SillyTavern runtime imports.

Documentation-only changes do not require the full Node suite unless they alter
tested examples or behavior. Prefer targeted `rg` checks for stale names, paths,
and tool references.

## Architecture reminders

- The phone flow is prompt-injection driven: `setExtensionPrompt()` requests
  structured tags, then `index.js` extracts `[sms]`, `[status]`, `[quests]`, and
  `[place]` blocks.
- In `MESSAGE_RECEIVED`, keep SMS extraction before status, quest, and place
  processing. Store merges can rebuild the phone UI and clobber transient reply
  state if this order changes.
- Regex constants with global flags share `.lastIndex`; reset before reuse.
- `rebuildPhone()` replaces DOM nodes. Treat saved element references as stale
  after any rebuild.
- Use `cxAlert()` / `cxConfirm()` / in-phone modals. Do not introduce native
  `alert()` or `confirm()`.
- localStorage keys are per chat through `chatKey()`. Keep new persistent state
  aligned with existing key style and storage caps.
- Event listeners are wired through `wireEventListeners()` and removed through
  `unwireEventListeners()`. Keep listener lifecycle symmetric.
- CSS classes and DOM IDs use the `cx-` prefix. Reuse CSS variables on
  `.cx-device`.

## Nova reminders

- Nova is shipped functionality, not a placeholder or in-development app.
- Connection-profile swapping, transcript state, soul/memory, approval gating,
  and the tool registry live in `index.js`.
- Bridge-backed filesystem and shell tools depend on
  `server-plugin/nova-agent-bridge/`; without the plugin, Nova should degrade to
  ST/API and phone-local tools.
- The server plugin is not sandboxed. Its shell route is allow-listed,
  no-shell-spawned, timeout-limited, approval-gated by the frontend, and audited.
- Current soul/memory write tools include `nova_write_soul`,
  `nova_append_memory`, and `nova_overwrite_memory`.
- Prefer ST-native write tools for ST data: `st_write_character` for Tavern
  cards and `st_write_worldbook` for worldbooks.

## Documentation pitfalls

- Do not call Nova "in development"; it shipped in v0.13.0.
- Do not reintroduce OpenClaw except in explicit legacy-migration notes.
- Do not describe bridge audit logs as recording user-denied approvals. Those
  are in the client-side in-phone audit log; server-side JSONL records bridge
  requests that reach the plugin.
- Do not claim this repo has CI, an npm build, or runtime npm dependencies.
