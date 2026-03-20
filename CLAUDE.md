# CLAUDE.md — Command-X Phone Extension

## What This Is

A SillyTavern third-party extension (v0.9) that adds a smartphone UI overlay to RP chats. Two messaging apps (Command-X for neural commands, Messages for normal texting), a Profiles app for NPC intel, and a Settings app. Messages flow through the RP — the extension injects system prompts so the LLM wraps phone replies in `[sms]` tags, which get extracted for the phone UI.

## File Layout

```
command-x/
├── index.js          # All extension logic (~1400 lines)
├── style.css         # All styling (~700 lines)
├── manifest.json     # ST extension manifest
├── settings.html     # ST settings panel checkboxes
├── README.md         # User-facing docs
├── LICENSE           # MIT
├── .gitignore
├── .github/          # GitHub config
└── st-docs/          # Local copy of SillyTavern docs (reference only, not part of the extension)
```

This is a **single-file JS architecture**. All logic lives in `index.js`. Don't split it — ST loads one JS entry point per extension.

## Core Architecture

### Prompt Injection (the key pattern)

The extension does NOT parse unstructured LLM output. Instead:

1. **`setExtensionPrompt()`** injects system instructions telling the LLM to use specific tags
2. LLM generates with those tags in its output
3. Extension extracts tagged content via regex

Two injection keys:
- **`command-x-sms`** (depth 1) — Injected when user sends a phone message. Tells LLM to wrap reply in `[sms from="Name" to="user"]...[/sms]`. Cleared after reply received.
- **`command-x-contacts`** (depth 2) — Persistent injection. Asks LLM to include `[status][...JSON...][/status]` with NPC data at end of each response.

### Event Flow

```
USER SENDS TEXT:
  sendPhoneMessage() → injectSmsPrompt() → sendToChat() → ST sends to LLM

LLM RESPONDS:
  MESSAGE_RECEIVED →
    1. extractSmsBlocks() — parse [sms] tags FIRST
    2. Route each block to correct contact by from/to attributes
    3. extractContacts() — parse [status] tags SECOND
    4. mergeNpcs() + rebuildPhone() if panel visible

  CHARACTER_MESSAGE_RENDERED →
    1. hideSmsTagsInDom() — replace [sms] with 📱 indicator
    2. hideContactsTagsInDom() — strip [status] entirely
    3. styleCommandsInMessage() — color {{COMMAND}} syntax

  MESSAGE_DELETED / MESSAGE_SWIPED →
    removeMessagesForMesId() — clean up phone messages tied to that ST message
```

**CRITICAL: `[sms]` extraction MUST run before `[contacts]`/`[status]` processing.** The contacts handler calls `rebuildPhone()` which resets UI state. If it runs first, `awaitingReply` gets cleared and SMS capture fails. This was a real bug — don't reorder these.

### State Variables

```javascript
currentApp          // 'cmdx' | 'messages' | null — which app opened the chat
currentContactName  // Name of the contact whose chat is open
awaitingReply       // true after sending, false when [sms] received or timeout
commandMode         // 'COMMAND' | 'BELIEVE' | 'FORGET' | 'COMPEL' | null
neuralMode          // toggled via ⚡ button in chat header
composeQueue        // [{contactName, text, displayText, isNeural, cmdType}]
settings            // {enabled, styleCommands, showLockscreen, panelOpen, batchMode, autoDetectNpcs}
```

### Storage (localStorage)

All keyed per SillyTavern chat ID:
- **`cx-msgs-{chatId}-{contactName}`** — Message history array (capped at 200)
- **`cx-npcs-{chatId}`** — NPC store array (capped at 50)
- **`cx-unread-{chatId}-{contactName}`** — Unread count integer

Messages store `mesId` (the ST message index) so they can be cleaned up on swipe/regen.

### Contact Sources

Contacts come from two places, merged in `getContactsFromContext()`:
1. **ST characters** — From `getContext().characters` (1:1 chat) or group members
2. **Stored NPCs** — From localStorage, populated by `[status]` tag parsing

The user's own persona name is filtered out. Contacts are sorted by most recent message.

## SillyTavern APIs Used

```javascript
// From st-context.js
getContext()                    // characters, chat, chatId, groupId, name1, name2, etc.
getContext().saveSettingsDebounced()

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

## Common Pitfalls

1. **Don't reorder SMS vs contacts extraction in MESSAGE_RECEIVED.** SMS first, always.
2. **`rebuildPhone()` destroys and recreates the entire phone DOM.** After calling it, all previous element references are stale. Call `wirePhone()` after rebuild. If a chat was open, `openChat()` is called to restore state.
3. **`openChat()` resets `awaitingReply` to false.** The `rebuildPhone` → `openChat` path preserves reply state via the `preserveReply` parameter (true when called from rebuild, false when user navigates manually).
4. **Regex objects with /g flag share state.** Always reset `.lastIndex = 0` before using `SMS_TAG_RE`, `CONTACTS_TAG_RE`, etc., or they'll skip matches.
5. **The compose queue only activates when `settings.batchMode` is true.** Otherwise messages send immediately.
6. **`sendToChat()` triggers ST's send button click.** It writes to `#send_textarea` and clicks `#send_but`. This is a DOM interaction, not an API call.

## Testing

No automated tests. To verify changes:

1. Load in SillyTavern with any character
2. Open the phone, send a text, verify [sms] tag appears in the response and gets captured
3. Test with a group chat to verify multi-contact and NPC flows
4. Swipe a response and verify old phone messages are replaced
5. Check the Profiles app for [status] data
6. Toggle batch mode in Settings and verify compose queue works

## Style Notes

- CSS uses `cx-` prefix for all classes
- Dark theme (matches ST's dark UI)
- iMessage-inspired bubble styling with CSS tails
- Neural command bubbles use pink-purple gradient with glow
- Toast notifications slide in from top-right
- Settings app uses iOS-style toggle switches

## Version History

- **v0.6** — Core phone UI + `[sms]` tag injection/extraction
- **v0.7** — NPC contacts via `[contacts]` tags, command mode drawer
- **v0.8** — Unified Messages + Command-X, subliminal neural commands, user persona filter, neural toggle, `[sms from/to]` routing, swipe/regen handling
- **v0.9** — Compose queue (batch mode), notification badges, `[status]` tag (replaces `[contacts]`), Profiles app, Settings app, toast notifications, recency sort, ST character avatars, dead app cleanup

## What's Next (Planned)

- Token burn frequency control (skip `[status]` injection every N messages to save tokens)
- Manual NPC avatar upload
- Performance optimization for large contact lists
