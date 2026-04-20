# CLAUDE.md — Command-X Phone Extension

## What This Is

A SillyTavern third-party extension (v0.10.0) that adds a smartphone UI overlay to RP chats. Five apps: **Command-X** (neural commands + unified messaging), **Profiles** (NPC intel cards), **Quests** (persistent story tracker), **OpenClaw** (bridge console), and **Settings**. Messages flow through the RP — the extension injects system prompts so the LLM wraps phone replies in `[sms]` tags, which get extracted for the phone UI.

## File Layout

```
command-x/
├── index.js          # All extension logic (~3.8k lines)
├── style.css         # All styling (~750 lines)
├── manifest.json     # ST extension manifest (v0.10.0)
├── settings.html     # ST settings panel (checkboxes + number inputs)
├── README.md         # User-facing docs
├── LICENSE           # MIT
├── .gitignore
├── docs/             # In-repo docs
│   └── code-review-plan.md
├── test/             # Node --test unit tests
│   └── helpers.test.mjs  # 63 assertions for pure helpers
├── .github/          # GitHub config
└── st-docs/          # Local copy of SillyTavern docs (reference only)
```

This is a **single-file JS architecture**. All logic lives in `index.js`. Don't split it — ST loads one JS entry point per extension.

## Core Architecture

### Prompt Injection (the key pattern)

The extension does NOT parse unstructured LLM output. Instead:

1. **`setExtensionPrompt()`** injects system instructions telling the LLM to use specific tags
2. LLM generates with those tags in its output
3. Extension extracts tagged content via regex

Three injection keys:
- **`command-x-sms`** (depth 1) — Injected when user sends a phone message. Tells LLM to wrap reply in `[sms from="Name" to="user"]...[/sms]`. Cleared after reply received.
- **`command-x-contacts`** (depth 2) — Persistent injection (throttled by `contactsInjectEveryN`). Asks LLM to include `[status][...JSON...][/status]` NPC state at end of each response.
- **`command-x-quests`** (depth 2) — Persistent injection (throttled by `questsInjectEveryN`). Asks LLM to include `[quests][...JSON...][/quests]` quest state updates.

### Event Flow

```
USER SENDS TEXT:
  sendPhoneMessage() → injectSmsPrompt() → sendToChat() → ST sends to LLM

LLM RESPONDS:
  MESSAGE_RECEIVED →
    1. applyInjectionThrottle() — manage per-turn prompt injection cadence
    2. extractSmsBlocks() — parse [sms] tags FIRST
    3. Route each block to correct contact by from/to attributes
    4. extractContacts() — parse [status] tags SECOND
    5. extractQuests() — parse [quests] tags THIRD
    6. mergeNpcs() + upsertQuestsFromLlm() + rebuildPhone() if panel visible

  CHARACTER_MESSAGE_RENDERED →
    1. hideSmsTagsInDom() — replace [sms] with 📱 indicator
    2. hideContactsTagsInDom() — strip [status] entirely
    3. hideQuestTagsInDom() — strip [quests] entirely
    4. styleCommandsInMessage() — color {{COMMAND}} syntax

  MESSAGE_DELETED / MESSAGE_SWIPED →
    removeMessagesForMesId() — clean up phone messages tied to that ST message
```

**CRITICAL: `[sms]` extraction MUST run before `[contacts]`/`[status]` processing.** The contacts handler calls `rebuildPhone()` which resets UI state. If it runs first, `awaitingReply` gets cleared and SMS capture fails. This was a real bug — don't reorder these.

### State Variables

```javascript
// --- Module-level ---
settings            // {enabled, styleCommands, showLockscreen, panelOpen, batchMode,
                    //  autoDetectNpcs, manualHybridPrivateTexts, openclawMode,
                    //  contactsInjectEveryN, questsInjectEveryN}
phoneContainer      // HTMLElement | null — wrapper div injected into body
clockIntervalId     // setInterval ID — cleared in destroyPanel() + wirePhone()
commandMode         // null | 'COMMAND' | 'BELIEVE' | 'FORGET' | 'COMPEL'
neuralMode          // boolean — toggled via ⚡ button in chat header
profileEditorState  // {mode:'new'|'edit', draft, oldName} | null
questEditorState    // {mode:'new'|'edit', draft, oldId} | null
privatePollInFlight // boolean — prevents overlapping quiet-prompt polls
questEnrichmentInFlight // boolean — prevents overlapping quest AI fills
composeQueue        // [{contactName, text, displayText, isNeural, cmdType}]
_turnCounter        // increments on MESSAGE_RECEIVED; drives throttle
_historyContactNamesCache // { chatId, names } — invalidated on write
_lastMsgTsCache     // Map<`${chatId}::${name}` → timestamp>

// --- Interaction-level (set in wirePhone / event handlers) ---
currentApp          // 'cmdx' | 'profiles' | 'quests' | 'openclaw' | 'phone-settings' | null
currentContactName  // Name of the contact whose chat is open
awaitingReply       // true after sending, false when [sms] received or timeout
typingTimeout       // setTimeout ID for the 30s awaitingReply cleanup
```

### Named Constants

```javascript
VERSION              // '0.10.0' — single-sourced
AWAIT_TIMEOUT_MS     // 30_000 — awaitingReply auto-clear timeout
CLOCK_INTERVAL_MS    // 30_000 — clock display refresh interval
MESSAGE_HISTORY_CAP  // 200 — max messages stored per contact
QUEST_HISTORY_CAP    // 150 — max quests stored
TOAST_DURATION_MS    // 4_000 — toast auto-dismiss
MAX_AVATAR_FILE_BYTES // 8MB — safeDataUrlFromFile input size cap
CONTACT_GRADIENTS    // string[] — avatar background gradient palette
CONTACT_EMOJIS       // string[] — default avatar emoji pool
```

### Storage (localStorage)

All keyed per SillyTavern chat ID:
- **`cx-msgs-{chatId}-{contactName}`** — Message history array (capped at `MESSAGE_HISTORY_CAP`)
- **`cx-npcs-{chatId}`** — NPC store array (capped at 50)
- **`cx-unread-{chatId}-{contactName}`** — Unread count integer
- **`cx-quests-{chatId}`** — Quest store array (capped at `QUEST_HISTORY_CAP`)

Messages store `mesId` (the ST message index) so they can be cleaned up on swipe/regen.

### Contact Sources

Contacts come from two places, merged in `getContactsFromContext()`:
1. **ST characters** — From `getContext().characters` (1:1 chat) or group members
2. **Stored NPCs** — From localStorage, populated by `[status]` tag parsing

The user's own persona name is filtered out. Contacts are sorted by most recent message using `_lastMsgTsCache`.

## Private Polling

`pollPrivateMessages()` fires a "quiet prompt" via `ctx.generateQuietPrompt()` asking the LLM — **out-of-band** (no ST chat message) — whether any contacts would send texts right now. If the LLM responds with `[sms]` blocks, they are routed into the phone exactly like a normal reply. Useful for "inbox checks" that don't pollute the chat log.

Flow:
1. `#cx-check-private` button click → `pollPrivateMessages()`
2. Builds a `quietPrompt` describing all known contacts
3. Calls `generateQuietPrompt({ quietPrompt, jsonSchema })` — ST background generation
4. Parses the response with `extractSmsBlocks()` and routes matched blocks

Requires ST build that exposes `generateQuietPrompt`. Gated by `settings.manualHybridPrivateTexts`.

## OpenClaw Operate Mode

OpenClaw is a bridge to a local `openclaw-bridge` ST server plugin. Three modes:
- **observe** — Read-only context inspection
- **assist** — Advice / planning over the current chat
- **operate** — OpenClaw proposes `slash.run` actions; the user approves/rejects each before local execution

Operate flow (`settings.openclawMode === 'operate'`):
1. User sends context to OpenClaw via the OpenClaw app
2. `sendToOpenClaw()` POSTs to `/api/plugins/openclaw-bridge/operate`
3. Response contains an `actions[]` array of proposed slash commands
4. `applyOpenClawResponse()` renders each action as an approval card
5. On approve: card calls `executeApprovedAction()` which runs the slash via ST `/run`
6. On reject: action is discarded, no side effects

## SillyTavern APIs Used

```javascript
// From st-context.js
getContext()                    // characters, chat, chatId, groupId, name1, name2, etc.
getContext().saveSettingsDebounced()
getContext().generateQuietPrompt({ quietPrompt, jsonSchema })  // background LLM call

// From script.js
setExtensionPrompt(key, value, position, depth, scan, role)
extension_prompt_types.IN_CHAT  // position = 1 (in-chat injection)
extension_prompt_types.NONE     // position to clear
extension_prompt_roles.SYSTEM   // inject as system message

// Events (from getContext().eventSource)
event_types.MESSAGE_RECEIVED            // LLM response ready (before render)
event_types.CHARACTER_MESSAGE_RENDERED  // DOM rendered for character message
event_types.USER_MESSAGE_RENDERED       // DOM rendered for user message
event_types.CHAT_CHANGED               // New chat opened
event_types.MESSAGE_DELETED             // Message deleted
event_types.MESSAGE_SWIPED             // Message swiped/regenerated
```

## Tag Formats

### SMS (phone text content)
```
[sms from="Sarah" to="user"]hey are you coming?[/sms]
```
- `from` = sender name (matched to contacts)
- `to` = "user" for texts directed at the player's phone
- Texts between NPCs (to≠"user") are ignored by the phone
- Multiple `[sms]` blocks per message are supported (multi-target replies)

### Status (NPC state data)
```
[status][{"name":"Sarah","emoji":"👩","status":"online","mood":"😊 happy","location":"café","relationship":"friendly","thoughts":"wondering about dinner"}][/status]
```
Also accepts legacy `[contacts]...[/contacts]` tag.

### Quests
```
[quests][{"id":"q1","title":"Meet Sarah","status":"active","priority":"high","objective":"Arrive before 8pm"}][/quests]
```
Also accepts `{"quests":[...]}` wrapper format.

## Common Pitfalls

1. **Don't reorder SMS vs contacts extraction in MESSAGE_RECEIVED.** SMS first, always.
2. **`rebuildPhone()` destroys and recreates the entire phone DOM.** After calling it, all previous element references are stale. Call `wirePhone()` after rebuild. If a chat was open, `openChat()` is called to restore state.
3. **`openChat()` resets `awaitingReply` to false.** The `rebuildPhone` → `openChat` path preserves reply state via the `preserveReply` parameter (true when called from rebuild, false when user navigates manually).
4. **Regex objects with /g flag share state.** Always reset `.lastIndex = 0` before using `SMS_TAG_RE`, `CONTACTS_TAG_RE`, etc., or they'll skip matches.
5. **The compose queue only activates when `settings.batchMode` is true.** Otherwise messages send immediately.
6. **`sendToChat()` triggers ST's send button click.** It writes to `#send_textarea` and clicks `#send_but`. This is a DOM interaction, not an API call. The in-phone `#cx-send` button is disabled during send and re-enabled in `clearTypingIndicator()`.
7. **`injectSmsPrompt()` always takes an array.** The legacy single-arg path was removed in v0.10.0. Always pass `[{ name, isNeural, cmdType }]`.
8. **`cxAlert()` and `cxConfirm()` are async.** They return Promises and must be awaited. Never use native `alert()` or `confirm()`.

## Testing

Run the pure-helper unit tests with:
```
node --test test/helpers.test.mjs
```

Manual integration testing (no automated browser tests):
1. Load in SillyTavern with any character
2. Open the phone, send a text, verify [sms] tag appears in the response and gets captured
3. Test with a group chat to verify multi-contact and NPC flows
4. Swipe a response and verify old phone messages are replaced
5. Check the Profiles app for [status] data
6. Toggle batch mode in Settings and verify compose queue works
7. Click "Check Messages" in the private-poll section with a character loaded

## Style Notes

- CSS uses `cx-` prefix for all classes and IDs
- Dark theme (matches ST's dark UI)
- iMessage-inspired bubble styling with CSS tails
- Neural command bubbles use pink-purple gradient with glow
- Toast notifications slide in from top-right; pause on hover, dismiss on Esc
- Settings app uses iOS-style toggle switches
- In-phone modals (`cxAlert`/`cxConfirm`) use `.cx-modal-overlay` / `.cx-modal-box`
- Interactive `<div>` controls carry `role="button"` / `tabindex="0"` / `aria-label`
- Toggle buttons carry `aria-pressed` (updated on state change)

## Version History

- **v0.6** — Core phone UI + `[sms]` tag injection/extraction
- **v0.7** — NPC contacts via `[contacts]` tags, command mode drawer
- **v0.8** — Unified Messages + Command-X, subliminal neural commands, user persona filter, neural toggle, `[sms from/to]` routing, swipe/regen handling
- **v0.9** — Compose queue (batch mode), notification badges, `[status]` tag (replaces `[contacts]`), Profiles app, Settings app, toast notifications, recency sort, ST character avatars, dead app cleanup
- **v0.10.0** — Quests app, OpenClaw app, `[quests]` tag, private polling, quest enrichment via `generateQuietPrompt`, per-chat metadata persistence, comprehensive code review (security escaping, CSP-safe avatar fallback, clock-leak fix, event-gate on `settings.enabled`, `MESSAGE_DELETED` mesId fix, `[sms]` routing tightened, caches, upload size cap, throttled injections, unit tests, accessibility, `cxAlert`/`cxConfirm`, toast improvements, send-button guard)
