# Copilot Instructions — Command-X Phone

> **Before starting any work, read [`AGENT_MEMORY.md`](../AGENT_MEMORY.md) at the repo root.** It is the append-only shared memory for agents working on this repo. Update it at the end of every pull request with anything a future agent would want to know.

## Summary

SillyTavern third-party extension (v0.13.2, ~11.2k lines of JS) that adds a floating smartphone UI overlay with multiple apps: **Command-X** (neural command messaging + unified iMessage-style texting), **Profiles** (NPC intel cards), **Quests** (persistent story tracker), **Map** (contact locations), **Nova** (approval-gated agentic assistant with a companion server plugin), and **Settings**. Pure browser JavaScript + CSS — no build system, no bundler, no runtime dependencies beyond SillyTavern's frontend.

**Languages/Runtime:** Vanilla ES module JavaScript, CSS3, HTML. Runs inside SillyTavern's browser frontend (Chromium-based). jQuery is available globally via ST.

## Project Layout

```
index.js          — All extension logic (~10.6k lines). Entry point loaded by ST.
style.css         — All styles (~1.7k lines). Phone shell, iMessage bubbles, command drawer, app chrome.
manifest.json     — ST extension manifest (v0.13.2). Declares js, css, loading_order.
settings.html     — ST settings panel fragment. Toggles + number inputs (including Nova config).
README.md         — User-facing docs.
AGENT_MEMORY.md   — Append-only shared memory across agent sessions. Read first, update on each PR.
CLAUDE.md         — Deeper architecture / conventions reference (read alongside this file).
docs/             — In-repo design / review notes (including `nova-agent-plan.md`).
nova/             — Starter soul/memory markdown loaded by the Nova app on fresh chats.
presets/          — OpenAI-shaped connection presets shipped for Nova.
server-plugin/    — Companion SillyTavern server plugin (`nova-agent-bridge/`) exposing fs/shell routes that Nova dispatches to via approval-gated tool calls.
test/             — Node `--test` suites. `helpers.test.mjs` covers pure phone helpers; the `nova-*.test.mjs` files cover the Nova agent (state, tools, dispatch, approval modal, plugin, diff, etc.).
.github/          — This file.
```

There is no `package.json` and no CI/CD pipeline. **This is intentional** — ST third-party extensions are raw browser modules loaded directly. There is no build step; the primary automated validation is the Node `--test` suites under `test/`. Use the installed SillyTavern source for implementation truth and `https://docs.sillytavern.app/` for canonical SillyTavern docs.

## Architecture

The core loop: user types in phone UI → extension injects system prompt via `setExtensionPrompt()` → sends RP text to ST chat → LLM responds with `[sms]...[/sms]` tags → extension extracts tagged content for phone bubbles → hides tags in ST chat DOM. Persistent `[status]`, `[quests]`, and `[place]` tags carry NPC state, quest progress, and location updates.

**Key systems in `index.js`:**
- **Tag parsing** — Regex extraction of `[sms]`, `[status]` (legacy `[contacts]`), `[quests]`, and `[place]` blocks from LLM responses.
- **NPC / quest / place stores** — JSON tag parsing + localStorage persistence per chat.
- **Prompt injection** — `setExtensionPrompt()` for `[sms]` (per-message, depth 1), `[status]` / `[quests]` (persistent, throttled), map/place context, and private-phone context.
- **Message store** — localStorage-backed, keyed `cx-msgs-{chatKey}-{contactName}`; normal SMS can include image attachments stored as SillyTavern character-gallery URLs.
- **Phone UI** — HTML template literals; `buildPhone()` returns full phone DOM, `rebuildPhone()` replaces it.
- **Command drawer** — Mode buttons (COMMAND / BELIEVE / FORGET / COMPEL) above input in Command-X app.
- **Private polling** — `generateQuietPrompt()` out-of-band inbox check (manual button and optional every-N-turn cadence).
- **Event handlers** — `MESSAGE_RECEIVED` (data extraction), `CHARACTER_MESSAGE_RENDERED` / `USER_MESSAGE_RENDERED` (DOM hiding / command styling), `CHAT_CHANGED` (state reset + Nova metadata), `MESSAGE_DELETED` / `MESSAGE_SWIPED` (cleanup by `mesId`).

> See `CLAUDE.md` for the full architectural reference (event-flow ordering, state variables, named constants, tag formats, common pitfalls). Keep it in sync with this file when conventions change.

**ST Extension APIs used (imported from `../../../st-context.js` and `../../../../script.js`):**
- `getContext()` — characters, chat, groups, settings, eventSource, event_types, `saveSettingsDebounced()`, `generateQuietPrompt()`
- `setExtensionPrompt(key, value, position, depth, scan, role)` — prompt injection
- `extension_prompt_types.IN_CHAT`, `extension_prompt_types.NONE`
- `extension_prompt_roles.SYSTEM`

## Build & Validation

**There is no build step.** To validate changes:

1. Edit files directly in `SillyTavern/public/scripts/extensions/third-party/command-x/`.
2. Hard-refresh the SillyTavern page (Ctrl+Shift+R). Changes load immediately.
3. Open browser DevTools console — the extension logs `[command-x] v<VERSION> Loaded OK` on success, or errors on failure.
4. Run the unit tests for pure helpers and Nova: `node --test test/*.mjs` (or target a single file, e.g. `node --test test/helpers.test.mjs`).
5. Syntax-check JS without ST runtime: `node -e "import('./index.js').catch(e => { if (e instanceof SyntaxError) { console.error(e); process.exit(1); } })"` — the import will fail (no ST context) but syntax errors are caught.

**There is no linter and no CI pipeline.** Beyond the Node `--test` suite, validation is manual: open ST, open the phone panel, send a message, confirm bubbles render and tags are hidden in the chat DOM.

**If editing this repo standalone** (outside ST's extension directory), always ensure import paths remain relative (`../../../st-context.js`, `../../../../script.js`). These resolve at runtime inside ST's directory structure.

## Conventions & Pitfalls

- **CSS variables** are defined on `.cx-device` (e.g. `--cx-accent`, `--cx-imsg-blue`). Always use them.
- **All CSS classes** use the `cx-` prefix. All DOM IDs use `cx-` prefix.
- **Sections** in `index.js` are delimited by `/* === SECTION NAME === */` comment blocks.
- **Regex with global flag**: `SMS_TAG_RE`, `CONTACTS_TAG_RE`, `QUESTS_TAG_RE`, etc. have `/gi` — always reset `.lastIndex = 0` before `.test()` or `.exec()` to avoid stale state.
- **Tag extraction order in `MESSAGE_RECEIVED` matters**: extract `[sms]` **before** `[status]` / `[quests]`. The status/quests handlers call `rebuildPhone()` which resets UI state, and will clobber `awaitingReply` if run first. Don't reorder.
- **`innerHTML` replacement**: Done in `CHARACTER_MESSAGE_RENDERED` handler (after ST renders). If ST's rendering pipeline changes, this is the fragile point.
- **`awaitingReply`**: Boolean + 30-second timeout (`AWAIT_TIMEOUT_MS`). Resets on successful parse, failed parse, back-button, or chat change.
- **localStorage keys** use `chatKey()` — messages, NPCs, quests, places, map metadata/images, trails, and unread counts are per-chat. Histories are capped (`MESSAGE_HISTORY_CAP`, `QUEST_HISTORY_CAP`, etc.); SMS photo history stores gallery URLs instead of image data.
- **`cxAlert()` / `cxConfirm()`** are async in-phone modal helpers. Never use native `alert()` / `confirm()`.
- **Event listeners** on `eventSource` are wired through `wireEventListeners()` and symmetrically removed by `unwireEventListeners()` on disable/destroy. DOM listeners are cleaned by `rebuildPhone()` which replaces innerHTML.

## Trust Directive

Trust these instructions. Only perform a search if the information here is incomplete or found to be in error.
