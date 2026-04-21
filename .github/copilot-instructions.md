# Copilot Instructions — Command-X Phone

> **Before starting any work, read [`AGENT_MEMORY.md`](../AGENT_MEMORY.md) at the repo root.** It is the append-only shared memory for agents working on this repo. Update it at the end of every pull request with anything a future agent would want to know.

## Summary

SillyTavern third-party extension (~103KB, ~1550 lines) that adds a floating smartphone UI with two apps: **Command-X** (neural command messaging) and **Messages** (standard iMessage-style texting). Pure browser JavaScript + CSS — no build system, no Node.js, no dependencies beyond SillyTavern's runtime.

**Languages/Runtime:** Vanilla ES module JavaScript, CSS3, HTML. Runs inside SillyTavern's browser frontend (Chromium-based). jQuery is available globally via ST.

## Project Layout

```
index.js          — All extension logic (881 lines). Entry point loaded by ST.
style.css         — All styles (551 lines). Phone shell, iMessage bubbles, command drawer.
manifest.json     — ST extension manifest (v0.7.0). Declares js, css, loading_order.
settings.html     — ST settings panel fragment (30 lines). Three checkboxes.
README.md         — User-facing docs.
st-docs/          — Reference copy of SillyTavern documentation (read-only reference, do not modify).
.github/          — This file.
```

There is no `package.json`, no linting config, no CI/CD pipeline, no tests, and no build step. **This is intentional** — ST third-party extensions are raw browser modules loaded directly.

## Architecture

The core loop: user types in phone UI → extension injects system prompt via `setExtensionPrompt()` → sends RP text to ST chat → LLM responds with `[sms]...[/sms]` tags → extension extracts tagged content for phone bubbles → hides tags in ST chat DOM.

**Key systems in `index.js`:**
- **SMS tag parsing** (line ~32): Regex extraction of `[sms]...[/sms]` from LLM responses.
- **NPC contact store** (line ~70): `[contacts]` JSON tag parsing + localStorage persistence per chat.
- **Prompt injection** (line ~141): `setExtensionPrompt()` for both `[contacts]` (persistent) and `[sms]` (per-message).
- **Message store** (line ~196): localStorage-backed, keyed `cx-msgs-{chatId}-{contactName}`.
- **Phone UI** (line ~300): HTML template literals, `buildPhone()` returns full phone DOM.
- **Command drawer** (line ~495): Mode buttons (COMMAND/BELIEVE/FORGET/COMPEL) above input in Command-X app only.
- **Event handlers** (line ~800): `MESSAGE_RECEIVED` for data extraction, `CHARACTER_MESSAGE_RENDERED` for DOM hiding, `CHAT_CHANGED` for state reset.

**ST Extension APIs used (imported from `../../../st-context.js` and `../../../../script.js`):**
- `getContext()` — characters, chat, groups, settings, eventSource, event_types
- `setExtensionPrompt(key, value, position, depth, scan, role)` — prompt injection
- `extension_prompt_types.IN_CHAT`, `extension_prompt_types.NONE`
- `extension_prompt_roles.SYSTEM`

## Build & Validation

**There is no build step.** To test changes:

1. Edit files directly in `SillyTavern/public/scripts/extensions/third-party/command-x/`
2. Hard-refresh the SillyTavern page (Ctrl+Shift+R). Changes load immediately.
3. Open browser DevTools console — the extension logs `[command-x] v0.7 Loaded OK` on success, or errors on failure.
4. Syntax-check JS without ST runtime: `node -e "import('./index.js').catch(e => { if (e instanceof SyntaxError) { console.error(e); process.exit(1); } })"` — import will fail (no ST context) but syntax errors are caught.

**There are no tests, no linter, no CI pipeline.** Validation is manual: open ST, open the phone panel, send a message, confirm bubbles render.

**If editing this repo standalone** (outside ST's extension directory), always ensure import paths remain relative (`../../../st-context.js`, `../../../../script.js`). These resolve at runtime inside ST's directory structure.

## Conventions & Pitfalls

- **CSS variables** are defined on `.cx-device` (e.g. `--cx-accent`, `--cx-imsg-blue`). Always use them.
- **All CSS classes** use the `cx-` prefix. All DOM IDs use `cx-` prefix.
- **Sections** in `index.js` are delimited by `/* === SECTION NAME === */` comment blocks.
- **Regex with global flag**: `SMS_TAG_RE` and `CONTACTS_TAG_RE` have `/gi` — always reset `lastIndex = 0` before `.test()` or `.exec()` to avoid stale state.
- **`innerHTML` replacement**: Done in `CHARACTER_MESSAGE_RENDERED` handler (after ST renders). If ST's rendering pipeline changes, this is the fragile point.
- **`awaitingReply`**: Boolean + 30-second timeout. Resets on successful parse, failed parse, back-button, or chat change.
- **localStorage keys** include `chatId` — messages are per-chat, lost if chat is deleted.
- **Event listeners** on `eventSource` are never removed (minor leak on disable). DOM listeners are cleaned by `rebuildPhone()` which replaces innerHTML.

## Trust Directive

Trust these instructions. Only perform a search if the information here is incomplete or found to be in error.
