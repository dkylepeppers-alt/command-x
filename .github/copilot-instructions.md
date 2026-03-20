# Copilot Instructions — Command-X Phone

## What This Project Is

Command-X is a **SillyTavern (ST) third-party browser extension** that renders a realistic smartphone UI overlay with two messaging apps:

- **Command-X** — A "neural command" messaging app (mind control / neural link theme) with four command modes: Command, Believe, Forget, Compel.
- **Messages** — A standard iMessage-style texting app.

Users send messages through the phone UI. The extension injects system prompts so the LLM wraps its phone replies in `[sms]…[/sms]` tags, which the extension extracts and renders as chat bubbles. NPCs in the scene are reported via `[contacts]…[/contacts]` tags and appear as textable contacts alongside ST characters.

**Version:** 0.7  
**Authors:** Kyle & Bucky  
**License:** MIT

---

## Architecture Overview

### Core Flow

```
User types in phone UI
  → sendPhoneMessage() formats text + injects system prompt via setExtensionPrompt()
  → Text sent to ST chat as RP narration ("*texts Sarah on phone:* ...")
  → LLM responds with narration + [sms]reply[/sms] + optional [contacts][...][/contacts]
  → MESSAGE_RECEIVED handler extracts [sms] content → renders as received bubble
  → CHARACTER_MESSAGE_RENDERED handler hides [sms]/[contacts] tags in ST chat DOM
```

### Key Architectural Patterns

1. **Prompt injection** — Uses `setExtensionPrompt()` to inject system-level instructions at specific depths in the chat context. Two injection keys: `command-x-sms` (per-message, cleared after reply) and `command-x-contacts` (persistent while extension is enabled).

2. **Tag parsing** — The LLM is instructed to wrap replies in `[sms]…[/sms]` and report NPCs in `[contacts][{"name":"...","emoji":"...","status":"..."}][/contacts]`. The extension parses these with regex.

3. **localStorage message store** — Phone messages are stored per chat+contact in localStorage under keys like `cx-msgs-{chatId}-{contactName}`. NPC contacts stored under `cx-npcs-{chatId}`. Both are independent from ST's chat history.

4. **Command mode drawer** — Four neural command types with a toggle UI. When active, messages are wrapped in `{{TYPE}} {{content}}` syntax for the RP and get special prompt injection describing the command's effect.

5. **DOM manipulation** — The phone UI is built entirely from HTML template literals, injected into the DOM, and wired with event listeners. No framework — pure vanilla JS + DOM APIs.

---

## Key Files

| File | Purpose |
|---|---|
| `index.js` | All extension logic: ST API integration, prompt injection, tag parsing, phone UI construction, event handling, localStorage persistence, settings management. Single-file architecture (~600 lines). |
| `style.css` | Complete phone UI styling: device shell, lock/home/app screens, iMessage-style bubbles, command drawer, typing indicator, NPC badges, ST chat tag styling. Uses CSS custom properties extensively. |
| `manifest.json` | ST extension manifest. Declares `js`, `css`, `loading_order`, metadata. |
| `settings.html` | ST extension settings panel HTML. Three checkboxes: enabled, style commands, show lockscreen. Uses ST's `inline-drawer` pattern. |
| `README.md` | User-facing documentation with installation, usage, and feature descriptions. |
| `st-docs/` | **Reference material only** — SillyTavern extension development docs. Do not modify. |

---

## SillyTavern Extension APIs Used

### Imports

```js
// Context access — chat state, characters, groups, settings, event system
import { getContext } from '../../../st-context.js';

// Prompt injection + constants
import {
    setExtensionPrompt,
    extension_prompt_types,  // IN_CHAT, NONE, etc.
    extension_prompt_roles,  // SYSTEM, USER, etc.
} from '../../../../script.js';
```

### Important API Details

- **`getContext()`** — Returns the live ST context object. Key properties used:
  - `ctx.chatId` / `ctx.groupId` — Current chat identifier
  - `ctx.characterId` — Index into `ctx.characters[]`
  - `ctx.characters` — Array of all loaded characters
  - `ctx.groups` — Group chat definitions with `.members` (avatar arrays)
  - `ctx.chat` — Array of message objects (`{ mes, is_user, is_system, name }`)
  - `ctx.extensionSettings[EXT]` — Per-extension persistent settings
  - `ctx.saveSettingsDebounced()` — Save settings (debounced)
  - `ctx.eventSource` — EventEmitter for ST events
  - `ctx.event_types` — Event type constants

- **`setExtensionPrompt(key, prompt, type, depth, scan, role)`** — Injects or clears a system prompt. To clear: set prompt to `''` and type to `extension_prompt_types.NONE`.

- **Event types used:**
  - `CHARACTER_MESSAGE_RENDERED` — Fires when a character message is rendered in DOM (receives `mesId`)
  - `USER_MESSAGE_RENDERED` — Same for user messages
  - `MESSAGE_RECEIVED` — Fires when a new message arrives (before rendering)
  - `CHAT_CHANGED` — Fires when user switches to a different chat

### Sending Messages

Messages are sent by programmatically setting `#send_textarea` value and clicking `#send_but` — there is no direct API for sending messages in ST extensions.

---

## Code Patterns & Conventions

### Module Structure

The entire extension is a single ESM module (`index.js`). Code is organized with prominent section dividers:

```js
/* ======================================================================
   SECTION NAME
   Description of what this section handles.
   ====================================================================== */
```

Major sections (in order): SMS Tag Parsing → NPC Contact Store → Prompt Injection → Message Store → Context Helpers → Send Message → HTML Builders → Phone Interactivity → Panel Management → Command Styling → Settings → Init.

### HTML Generation

Phone UI is built with **template literal strings** in `buildPhone()` returning a large HTML string. Ternary expressions handle conditional rendering. Contact rows are generated via `contactRowHTML()`. The HTML is set via `innerHTML` on a wrapper div.

### CSS Variable System

The phone shell uses CSS custom properties defined on `.cx-device`:

```css
--cx-accent: #ff0055;     /* Command-X red/pink */
--cx-accent2: #7700ff;    /* Purple */
--cx-green: #00ff88;      /* Online/Believe */
--cx-amber: #ffaa00;      /* Compel */
--cx-text: #e0e0e0;
--cx-muted: #666;
--cx-divider: #1e1e2a;
--cx-imsg-blue: #007AFF;  /* iMessage sent bubble */
--cx-imsg-recv: #2C2C2E;  /* iMessage received bubble */
```

### Naming Convention

- All CSS classes prefixed with `cx-` (e.g., `cx-sms-sent`, `cx-contact-row`, `cx-cmd-drawer`)
- All DOM IDs prefixed with `cx-` (e.g., `cx-phone`, `cx-msg-area`, `cx-send`)
- localStorage keys prefixed with `cx-` (e.g., `cx-msgs-{chatId}-{name}`, `cx-npcs-{chatId}`)
- Extension key constant: `EXT = 'command-x'`

### State Management

Module-level `let` variables track UI state:
- `currentApp` — Which app is open (`'cmdx'` | `'messages'` | `null`)
- `currentContactName` — Active chat contact name
- `awaitingReply` — Whether we're waiting for an `[sms]` response
- `commandMode` — Active command type (`'COMMAND'` | `'BELIEVE'` | `'FORGET'` | `'COMPEL'` | `null`)
- `settings` — Extension settings object (synced to `ctx.extensionSettings`)

### jQuery Usage

ST uses jQuery. This extension uses it minimally:
- `jQuery(async () => { ... })` for init (document ready)
- `$('#extensions_settings2').append(...)` to inject settings HTML
- `$('#cx_enabled, ...').on('change', ...)` for settings checkboxes
- All other DOM work uses vanilla `document.querySelector` / `addEventListener`

---

## How to Test Changes

1. **No build step.** This is a pure browser extension — just JS, CSS, and HTML.
2. Edit files directly in the extension directory.
3. **Hard-refresh** the SillyTavern page (`Ctrl+Shift+R` or clear cache) to reload.
4. The extension loads via ST's extension loader which reads `manifest.json`.
5. Enable the extension in ST's Extensions panel → Command-X Phone → check "Show phone panel".
6. Click the 📱 button in the extensions menu to open the phone overlay.
7. Start or continue a chat with any character to test messaging flow.

### Testing Specific Features

- **SMS flow:** Send a message via phone UI → check ST chat for the formatted RP text → verify LLM response contains `[sms]` tags → verify phone shows received bubble.
- **NPC contacts:** Verify `[contacts]` JSON is parsed from LLM responses and NPCs appear in contact lists with "NPC" badge.
- **Command modes:** Open Command-X → tap a command mode button → verify input placeholder changes → send → verify RP text wraps in `{{TYPE}} {{content}}` syntax.
- **Tag hiding:** After LLM responds, verify `[sms]` and `[contacts]` blocks are replaced/hidden in the ST chat DOM.
- **Settings persistence:** Toggle checkboxes → refresh page → verify they persist.

---

## Important Constraints

1. **No Node.js / no build system.** This runs directly in the browser as loaded by ST's extension system. No webpack, no bundling, no transpilation.
2. **Must use ST's extension API patterns.** Imports come from relative paths to ST's own modules (`../../../st-context.js`, `../../../../script.js`). These paths are dictated by ST's directory structure.
3. **Browser-only APIs.** `localStorage`, `document`, `fetch`, `jQuery` (from ST). No Node.js APIs available.
4. **Single-page app context.** ST is an SPA — the extension lives for the lifetime of the page. State resets on page refresh (except localStorage and ST settings).
5. **Extension isolation is minimal.** The extension shares the global DOM with ST and other extensions. All selectors must be specific (hence the `cx-` prefix convention).
6. **No direct message-send API.** To send a message into the chat, the extension programmatically sets `#send_textarea.value` and clicks `#send_but`. This is the standard pattern for ST extensions.

---

## Common Pitfalls

### 1. Regex `lastIndex` with Global Flag

Both `SMS_TAG_RE` and `CONTACTS_TAG_RE` use the `g` (global) and `i` flags. When using `.test()` or `.exec()` on a global regex, `lastIndex` persists between calls. **Always reset** before use:

```js
SMS_TAG_RE.lastIndex = 0;  // REQUIRED before .test() or .exec()
```

Forgetting this causes intermittent failures where the regex starts matching from the middle of the string. Every function that uses these regexes already resets `lastIndex` — maintain this pattern.

### 2. innerHTML Replacement Timing

`hideSmsTagsInDom()` and `hideContactsTagsInDom()` use `el.innerHTML = el.innerHTML.replace(...)` which **destroys and recreates** all child nodes. This means:
- Event listeners on child elements are lost
- Any references to child DOM nodes become stale
- Must be called after ST has finished rendering the message (hence using `CHARACTER_MESSAGE_RENDERED` event)

### 3. Event Listener Cleanup on Rebuild

`rebuildPhone()` replaces the entire phone DOM via `innerHTML`, then re-runs `wirePhone()`. This means all previous event listeners on phone elements are implicitly cleaned up (old nodes are garbage collected). However, if you add listeners to elements **outside** the phone container (e.g., `document`, `window`), they will leak on rebuild. Currently the extension avoids this correctly.

### 4. localStorage Key Structure

Keys follow the pattern `cx-{type}-{chatId}-{contactName}` for messages and `cx-npcs-{chatId}` for NPC contacts. The `chatId` comes from `getContext().chatId || getContext().groupId || 'default'`. Be aware:
- Contact names with special characters are used as-is in keys (no encoding)
- Message arrays are capped at 200 entries (`msgs.slice(-200)`)
- NPC arrays are capped at 50 entries
- `localStorage` has browser-imposed size limits (~5-10MB typically)

### 5. Context Freshness

`getContext()` returns a live reference, but the data it contains may be stale if called at the wrong time. In the `MESSAGE_RECEIVED` handler, a fresh `getContext()` call is made to get the latest chat state. Always call `getContext()` at the point of use rather than caching it long-term.

### 6. Group Chat Character Matching

In group chats, the `MESSAGE_RECEIVED` handler checks `msg.name === currentContactName` to match the reply to the right contact. This is a simple string comparison — if ST returns a display name that differs from the contact name (e.g., trimming, aliases), the match will fail silently and the `[sms]` content won't be captured for the phone.

### 7. setExtensionPrompt Depth Parameter

The `depth` parameter in `setExtensionPrompt()` controls where in the chat context the prompt appears:
- `depth: 1` — Right before the last message (used for `[sms]` instruction)
- `depth: 2` — Slightly further back (used for persistent `[contacts]` instruction)

Lower depth = closer to the end of context = higher priority for the LLM. If you add new prompts, choose depth carefully to avoid conflicts.

### 8. Phone UI State After Chat Switch

The `CHAT_CHANGED` event resets all phone state (`currentContactName`, `currentApp`, `awaitingReply`, `commandMode`) and rebuilds the phone. If you add new state variables, make sure to reset them in this handler.

---

## File Organization Summary

```
command-x/
├── .github/
│   └── copilot-instructions.md   ← You are here
├── st-docs/                       ← Reference only, do not edit
├── index.js                       ← All extension logic (~600 lines)
├── style.css                      ← All styling (~500 lines)
├── manifest.json                  ← ST extension manifest
├── settings.html                  ← ST settings panel HTML
├── README.md                      ← User documentation
├── LICENSE                        ← MIT
└── .gitignore                     ← node_modules, .DS_Store
```
