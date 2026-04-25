# CLAUDE.md — Command-X Phone Extension

> **Before starting any work, read [`AGENT_MEMORY.md`](AGENT_MEMORY.md) at the repo root.** It is the append-only shared memory for agents working on this repo. Update it at the end of every pull request with anything a future agent would want to know.

## What This Is

A SillyTavern third-party extension (v0.13.0) that adds a smartphone UI overlay to RP chats. Six apps: **Command-X** (neural commands + unified messaging), **Profiles** (NPC intel cards), **Quests** (persistent story tracker), **Map** (contact location tracking), **Nova** (agentic assistant — approval-gated tool calls via a companion server plugin; still in active development, see `docs/nova-agent-plan.md`), and **Settings**. Messages flow through the RP — the extension injects system prompts so the LLM wraps phone replies in `[sms]` tags, which get extracted for the phone UI.

## File Layout

```
command-x/
├── index.js          # All extension logic (~7.9k lines)
├── style.css         # All styling (~1.5k lines)
├── manifest.json     # ST extension manifest (v0.13.0)
├── settings.html     # ST settings panel (toggles, number inputs, Nova config)
├── README.md         # User-facing docs
├── LICENSE           # MIT
├── .gitignore
├── docs/             # In-repo design / review notes
│   ├── code-review-plan.md              # Historical v0.10.0 code review checklist
│   ├── nova-agent-plan.md               # Live Nova implementation plan
│   ├── private-phone-hybrid-plan.md     # Historical (shipped)
│   ├── quest-tracker-plan.md            # Historical (shipped)
│   ├── quest-tracker-interactive-plan.md# Historical (shipped)
│   └── quest-tracker-interactive-spec.md
├── nova/             # Starter soul.md / memory.md loaded by Nova on fresh chats
├── presets/          # OpenAI-shaped connection presets shipped for Nova
├── server-plugin/
│   └── nova-agent-bridge/   # Companion ST server plugin for Nova (fs/shell routes)
├── test/             # Node --test suites
│   ├── helpers.test.mjs              # Pure phone helpers
│   └── nova-*.test.mjs               # Nova agent (state, tools, dispatch, approval modal, plugin, diff, …)
├── .github/          # GitHub config
└── st-docs/          # Local copy of SillyTavern docs (reference only)
```

This is a **single-file JS architecture** on the frontend. All extension logic lives in `index.js`. Don't split it — ST loads one JS entry point per extension. The Nova server plugin under `server-plugin/nova-agent-bridge/` is a separate Node module loaded by SillyTavern's plugin system.

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
    1. extractSmsBlocks() — parse [sms] tags FIRST
    2. Route each block to correct contact by from/to attributes
    3. extractContacts() — parse [status] tags SECOND
    4. extractQuests() — parse [quests] tags THIRD
    5. extractPlaces() — parse [place] tags FOURTH (Map app)
    6. mergeNpcs() + mergeQuests() + mergePlaces() + rebuildPhone() if panel visible
    7. applyInjectionThrottle() — manage per-turn prompt injection cadence

  CHARACTER_MESSAGE_RENDERED →
    1. hideSmsTagsInDom() — replace [sms] with 📱 indicator
    2. hideContactsTagsInDom() — strip [status] entirely
    3. hideQuestTagsInDom() — strip [quests] entirely
    4. hidePlaceTagsInDom() — strip [place] entirely
    5. styleCommandsInMessage() — color {{COMMAND}} syntax

  MESSAGE_DELETED / MESSAGE_SWIPED →
    removeMessagesForMesId() — clean up phone messages tied to that ST message
```

**CRITICAL: `[sms]` extraction MUST run before `[contacts]`/`[status]` processing.** The contacts handler calls `rebuildPhone()` which resets UI state. If it runs first, `awaitingReply` gets cleared and SMS capture fails. This was a real bug — don't reorder these.

### State Variables

```javascript
// --- Module-level ---
settings            // {enabled, styleCommands, showLockscreen, panelOpen, batchMode,
                    //  autoDetectNpcs, manualHybridPrivateTexts,
                    //  contactsInjectEveryN, questsInjectEveryN, autoPrivatePollEveryN,
                    //  trackLocations, autoRegisterPlaces, mapInjectEveryN,
                    //  showLocationTrails, nova: { enabled, profileName, defaultTier,
                    //  maxToolCalls, turnTimeoutMs, pluginBaseUrl,
                    //  rememberApprovalsSession, activeSkill }}
                    // NOTE: legacy `openclawMode` is migrated out on load (see LEGACY_KEYS).
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
currentApp          // 'cmdx' | 'profiles' | 'quests' | 'map' | 'nova' | 'phone-settings' | null
currentContactName  // Name of the contact whose chat is open
awaitingReply       // true after sending, false when [sms] received or timeout
typingTimeout       // setTimeout ID for the 30s awaitingReply cleanup
```

### Named Constants

```javascript
VERSION              // '0.13.0' — single-sourced
AWAIT_TIMEOUT_MS     // 30_000 — awaitingReply auto-clear timeout
CLOCK_INTERVAL_MS    // 30_000 — clock display refresh interval
MESSAGE_HISTORY_CAP  // 200 — max messages stored per contact
QUEST_HISTORY_CAP    // 150 — max quests stored
PLACES_CAP           // 40  — max registered places per chat
LOCATION_TRAIL_CAP   // 50  — max trail entries per contact
TOAST_DURATION_MS    // 4_000 — toast auto-dismiss
MAX_AVATAR_FILE_BYTES // 8MB — safeDataUrlFromFile input size cap
MAX_MAP_IMAGE_WIDTH  // 1024 — max downscaled width for uploaded map image
CONTACT_GRADIENTS    // string[] — avatar background gradient palette
CONTACT_EMOJIS       // string[] — default avatar emoji pool
```

### Storage (localStorage)

All keyed per SillyTavern chat ID:
- **`cx-msgs-{chatId}-{contactName}`** — Message history array (capped at `MESSAGE_HISTORY_CAP`)
- **`cx-npcs-{chatId}`** — NPC store array (capped at 50)
- **`cx-unread-{chatId}-{contactName}`** — Unread count integer
- **`cx-quests-{chatId}`** — Quest store array (capped at `QUEST_HISTORY_CAP`)
- **`cx-places-{chatId}`** — Map place store (capped at `PLACES_CAP`)
- **`cx-map-image-{chatId}`** — Uploaded map background (JPEG data URL, optional)

Nova-specific state lives in `ctx.chatMetadata[EXT].nova` (per-chat transcript, soul/memory pointers, approval history) rather than localStorage.

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

## Nova Agent

Nova is an agentic assistant app (home-screen tile `data-app="nova"`) that talks to the LLM through a dedicated connection profile and runs **approval-gated tool calls** against both the ST frontend and a companion server plugin.

Architecture:
- **Connection profile** — `settings.nova.profileName` selects an ST connection profile; Nova swaps to it for agent turns and restores the previous profile afterwards (serialized by a profile mutex).
- **Tool registry** — Schemas cover `nova_*` (self-edit of soul/memory), `phone_*` (local phone stores), `st_*` (ST API — characters, worldbooks, slash, context, profiles), `fs_*` (filesystem via plugin), and `shell_run` (shell via plugin). Each tool declares a **tier** (`read` / `write` / `shell`); `settings.nova.defaultTier` gates what can run without prompting.
- **Approval modal** — Writes and shell calls open `cxNovaApprovalModal` with an optional unified-diff preview (`buildNovaUnifiedDiff`) before execution.
- **Transcript** — Per-chat, stored under `ctx.chatMetadata[EXT].nova`, replayed into the phone's Nova view.
- **Soul / memory** — Markdown docs under `nova/soul.md` and `nova/memory.md` (seeded on first use, then per-chat editable via the `nova_write_soul` / `nova_write_memory` tools behind the approval gate).
- **Server plugin** — `server-plugin/nova-agent-bridge/` exposes `/fs/*` routes (list, read, stat, search, write, delete, move — with `.nova-trash` safety and audit log) and a reserved `/shell/run` route. The extension probes `/health` on startup to discover plugin capabilities.

Current status and remaining work are tracked in `docs/nova-agent-plan.md`.

> **Legacy note:** A previous "OpenClaw" bridge app was retired in favor of Nova. Any existing `ctx.chatMetadata[EXT].openclaw` blobs are migrated to `.legacy_openclaw` on load (see `migrateLegacyOpenClawMetadata`), and `settings.openclawMode` is stripped by `LEGACY_KEYS` in `loadSettings`. Do not re-introduce OpenClaw references in new code.

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

### Places (Map app)
```
[place][{"name":"Lighthouse Café","emoji":"☕","occupants":["Sarah"]}][/place]
```
Registers places on the Map app and moves contacts between them. Manual user edits are preserved across auto-updates.

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

Run the full suite (pure phone helpers + Nova agent):
```
node --test test/*.mjs
```

Or target a specific file:
```
node --test test/helpers.test.mjs
node --test test/nova-tool-dispatch.test.mjs
```

Manual integration testing (no automated browser tests):
1. Load in SillyTavern with any character
2. Open the phone, send a text, verify [sms] tag appears in the response and gets captured
3. Test with a group chat to verify multi-contact and NPC flows
4. Swipe a response and verify old phone messages are replaced
5. Check the Profiles app for [status] data
6. Toggle batch mode in Settings and verify compose queue works
7. Click "Check Messages" in the private-poll section with a character loaded
8. Open the Map app, upload an image, drop pins, verify zoom/pan and that `[place]` tags register new places
9. Open the Nova app, pick a connection profile, send a turn, approve a write, and verify the transcript + approval modal + diff preview all render correctly

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
- **v0.11** — Map app (visual location tracker with schematic or uploaded background, pins, zoom/pan, movement trails), `[place]` tag, interactive quest tracker upgrade (richer states, urgency, focus, next-action, subtasks, manual overrides preserved across auto-updates), group-chat contact dedupe
- **v0.12** — Nova agent scaffolding: home-screen tile + view, connection-profile swap, per-chat transcript, approval-gated tool calls, tool registry tiers, skill packs, soul/memory markdown self-edit tools, companion `nova-agent-bridge` server plugin (fs routes with `.nova-trash` safety + audit log), plugin capability probe
- **v0.13.0** — OpenClaw app fully retired (legacy metadata migrated to `.legacy_openclaw`, `settings.openclawMode` stripped via `LEGACY_KEYS`); Nova phone-handler factory (`buildNovaPhoneHandlers`) wires `phone_*` tools to the real local stores; expanded Nova test suites
