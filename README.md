# Command-X Phone

A SillyTavern third-party extension that puts a fully functional smartphone in your RP. Text characters, send neural commands, track NPC intel, and manage persistent quests — all from an iMessage-style phone UI that lives alongside your chat.

Messages flow through the RP naturally. The extension uses prompt injection so the LLM includes phone replies in `[sms]...[/sms]` tags, which get extracted and rendered as chat bubbles on the phone. No regex hacks on unstructured output — the LLM is told what structure to use *before* it generates.

## Features

### 📱 Phone UI
- **Realistic phone shell** — Notch, bezel, status bar, home indicator
- **Lock screen → Home screen → Apps** — Navigate like a real phone
- **Five apps:** Command-X (neural messaging), Profiles (contact intel), Quests (persistent story goals), OpenClaw (bridge console), Settings

### 💬 Messaging
- **iMessage-style chat bubbles** — Sent (blue), received (dark gray), neural commands (pink/purple glow)
- **Multi-target texting** — Send messages to multiple contacts in a single turn (batch mode)
- **Compose queue** — Queue up texts to different people, then flush them all at once
- **Typing indicator** — Bouncing dots while waiting for a reply (30s safety timeout)
- **`[sms from="Name" to="user"]` routing** — Messages land in the right contact's chat, even NPCs
- **Swipe/regen handling** — When you regenerate a response in ST, old phone messages for that message ID are removed and replaced with the new content

### ⚡ Neural Commands (Command-X App)
- **Subliminal by design** — Targets are unaware commands were sent; they respond naturally under influence
- **Command mode drawer** — Four modes with one-tap activation:

  | Mode | Effect |
  |------|--------|
  | **⚡ Command** | Target feels compelled to obey |
  | **💚 Believe** | Target genuinely believes the stated thing |
  | **💜 Forget** | Target's memory fades |
  | **🔶 Compel** | Target feels an overwhelming urge |

- **Neural toggle (⚡)** — Switch between normal texting and neural mode from the chat header
- No syntax to remember — tap a mode, type naturally, the extension handles the prompt formatting


### 🗺️ Quests App
- **Persistent per-chat quest tracker** — Stores active, completed, and failed quests separately for each ST chat
- **Automatic `[quests]` extraction** — The model can create/update quests from structured tags in story replies
- **Manual add/edit controls** — Create quests yourself or pin field edits so later auto-syncs do not stomp them
- **Quick complete/fail actions** — Resolve quests directly from the phone UI
- **Narrative influence injection** — Active quests are summarized back into prompt context so unresolved goals can shape future scenes naturally

### 🧭 Map App
- **Visual location tracker** — Shows a smartphone-style map with pins for every place in the story plus one pin per known contact at their current location
- **Schematic or custom background** — Uses a built-in dark grid by default, or upload any image (city plan, floor plan, fantasy map, screenshot) as the backdrop
- **Zoom and pan** — Scroll-wheel / pinch / double-click to zoom (1×–5×), drag to pan; a control overlay (＋ − ⟲) and live percentage indicator are always available
- **Interactive pins** — Tap empty map to add a place, drag pins to reposition, tap a contact pin to open their chat, tap "📍 You" to drop your own position marker
- **Movement trails** — Optional dashed trails show each contact's last few locations so you can see where they've been
- **Auto-registration** — The LLM can register new places and move contacts between them via `[status]` tags; manual edits are preserved

**Uploading your own map background:**
1. Open the phone, tap the **🧭 Map** app, then tap **Upload Image** in the header. Tap the **ℹ️** button next to it at any time to see this guidance in the app.
2. Pick any PNG, JPG, GIF, or WebP image. Raw files over **8 MB are rejected**. If an accepted image is wider than **1024 px** on the long edge, it is automatically downscaled and re-encoded as JPEG to keep chat storage small.
3. Prefer a roughly **square (1:1)** image — the map surface is a square frame and wider/taller images are cropped to "cover" it, so content near the edges may be trimmed.
4. After uploading, tap any empty spot on the map to drop a place pin, drag pins to fine-tune, and use zoom/pan to work with dense areas. Pin coordinates are anchored to the image, so they stay correct at any zoom level.
5. To revert, tap **Use Schematic**. The uploaded image is removed but your place pins are kept.
6. Map images are stored locally per ST chat (`localStorage`) and are **never uploaded to the LLM** or any server.


### 🦞 OpenClaw App
- **Native bridge console** — Uses the existing `openclaw-bridge` backend from inside the Command-X phone UI
- **Per-chat session controls** — Health, session inspect, reset, and send actions stay scoped to the current ST chat
- **Context-aware prompts** — One tap inserts recent SillyTavern context before sending to OpenClaw
- **Operate action loop (phase 1)** — OpenClaw can propose `slash.run` actions, which are then approved/rejected locally in Command-X before execution
- **Local slash fallback** — Run SillyTavern slash commands locally from the same operator surface

### 🔍 Profiles App (Contact Intel)
- **Character state tracking** — The LLM reports present-character status via `[status]` tags (mood, location, relationship, inner monologue)
- **Intel cards** — The active character and relevant contacts get profile cards with their current state
- **Auto-detection** — NPCs appear automatically as the story introduces them
- **Persistent** — NPC data survives page refreshes (localStorage-backed)

### 🔔 Notifications
- **Unread badges** — Contact rows and the phone toggle button show unread counts
- **Toast notifications** — Banner slides in when a text arrives while you're not viewing that chat. Tap to jump directly to the conversation.

### ⚙️ Settings App (In-Phone Config)
- **Batch Send Mode** — Toggle compose queue for multi-target texting
- **Style Commands in Chat** — Toggle `{{COMMAND}}` syntax coloring in ST chat
- **Auto-Detect NPCs** — Toggle `[status]` injection (save tokens when not needed)
- **Clear All NPC Data** — Wipe stored NPCs for current chat
- **Lock Screen on Open** — Start on lock screen when opening the phone

### Other
- **Contact list sorted by recency** — Most recent conversations float to the top
- **ST character avatars** — Characters with thumbnails show their avatar; NPCs get emoji fallback
- **User persona filtered from contacts** — Your own name doesn't appear in the contact list
- **Per-chat message history** — Each chat×contact pair has its own message log (localStorage, capped at 200)
- **`{{COMMAND}}` syntax styling** — Command tags in the main ST chat get colored inline indicators

## Installation

### From URL (recommended)
1. In SillyTavern, go to **Extensions → Install Extension**
2. Paste: `https://github.com/dkylepeppers-alt/command-x`
3. Click Install, refresh the page

### Manual
```bash
cd ~/SillyTavern/public/scripts/extensions/third-party/
git clone https://github.com/dkylepeppers-alt/command-x.git
```
Refresh SillyTavern.

### OpenClaw app dependency
The in-phone **OpenClaw** app requires the local `openclaw-bridge` SillyTavern server plugin/backend to be present and enabled. The Command-X repo contains the native phone UI for that bridge, but not the bridge backend itself.

## Usage

1. Enable in **Extensions → Command-X Phone**
2. Click the 📱 button in the extensions menu to open the phone
3. Tap a contact to chat
4. **Messages app** — Normal texting
5. **Command-X app** — Neural commands (use the drawer buttons or the ⚡ toggle)
6. **OpenClaw app** — Operator bridge tools for the current chat
   - **Observe** = read-only context inspection
   - **Assist** = advice/planning over current chat context
   - **Operate** = propose local `slash.run` actions for approval, then execute them locally if approved
7. **Profiles app** — View NPC intel cards
8. **Settings app** — Configure everything in-phone

### How It Works

```
You type in phone UI
        ↓
Extension sends RP text to ST chat
(e.g., *texts Sarah:* "hey")
        ↓
Injects system prompt via setExtensionPrompt()
telling LLM to use [sms from="Sarah" to="user"]...[/sms]
        ↓
LLM responds with narration + [sms] tags + [status] tags
        ↓
Extension extracts [sms] → phone bubbles
Extension extracts [status] → NPC profile data
Extension extracts [quests] → quest tracker updates
ST chat shows narration with subtle 📱 indicators
```

### Private Polling

The **Check Messages** button in the Command-X app fires a background LLM prompt asking *"would any of your contacts text you right now?"* — completely out of band (no ST chat message is created). If the LLM decides a contact would message you, it responds with `[sms]` blocks that land directly in the phone's inbox.

Requirements:
- A SillyTavern build that exposes `generateQuietPrompt()` (v1.12.10+)
- **Private hybrid texts** enabled in the in-phone Settings app

### OpenClaw Operate Mode

The OpenClaw app connects to an optional `openclaw-bridge` backend plugin and offers three escalating modes:

| Mode | What it does |
|------|-------------|
| **Observe** | Sends the current ST chat context to OpenClaw for read-only analysis |
| **Assist** | OpenClaw responds with advice, plans, or narrative suggestions (streamed into the console) |
| **Operate** | OpenClaw proposes a list of SillyTavern slash commands (`/echo`, `/setvar`, etc.); you see each proposed action as an **Approve / Reject** card before anything runs |

The operate approval loop ensures no side-effects happen without user confirmation. Each approved action is executed locally via SillyTavern's slash-command runner.

The **OpenClaw** app requires the `openclaw-bridge` server plugin. The Command-X repo ships the phone UI only; the backend is a separate component.

### Tag Reference

| Tag | Purpose | Example |
|-----|---------|---------|
| `[sms from="Name" to="user"]...[/sms]` | Phone text content | `[sms from="Sarah" to="user"]omw![/sms]` |
| `[status][...JSON...][/status]` | present-character state data | `[status][{"name":"Sarah","emoji":"👩","mood":"😊 happy","location":"café","thoughts":"I really hope he asks me to stay a little longer."}][/status]` |
| `[quests][...JSON...][/quests]` | quest/task state updates | `[quests][{"title":"Meet Sarah at the diner","objective":"Get there before 8 PM","status":"active","priority":"high"}][/quests]` |

Tags are injected by the extension automatically — you don't need to type them.

## Architecture

- **Prompt injection** (`setExtensionPrompt`) for both `[sms]` replies and `[status]` NPC data — no downstream parsing of unstructured RP output
- **`MESSAGE_RECEIVED`** event handler extracts `[sms]` blocks first, then processes `[status]` (order matters — `[status]` processing triggers UI rebuild)
- **`CHARACTER_MESSAGE_RENDERED`** hides tags in the ST chat DOM
- **`MESSAGE_DELETED` / `MESSAGE_SWIPED`** handles regeneration cleanup
- **localStorage** for message history, NPC store, unread counts (all keyed per chat ID)

## Compatibility

Works with any chat completion API via OpenRouter or direct providers. The tag instructions are model-agnostic — tested with Claude, GPT-4, and others.

## Acknowledgements

The prompt injection architecture (`setExtensionPrompt` → structured tags → extract) was inspired by patterns in [RPG Companion](https://github.com/SpicyMarinara/rpg-companion-sillytavern) by **Spicy Marinara**. RPG Companion's approach to LLM-generated structured data (tracker JSON, character state, thought reporting) was a key reference during development — particularly the insight that *telling the LLM what structure you need before generation* beats trying to parse unstructured RP output after the fact.


## License

MIT
