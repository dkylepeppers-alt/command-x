# Command-X Phone

A SillyTavern third-party extension that puts a fully functional smartphone in your RP. Text characters, send neural commands, track NPC intel, and manage persistent quests — all from an iMessage-style phone UI that lives alongside your chat.

Messages flow through the RP naturally. The extension uses prompt injection so the LLM includes phone replies in `[sms]...[/sms]` tags, which get extracted and rendered as chat bubbles on the phone. No regex hacks on unstructured output — the LLM is told what structure to use *before* it generates.

## Features

### 📱 Phone UI
- **Realistic phone shell** — Notch, bezel, status bar, home indicator
- **Lock screen → Home screen → Apps** — Navigate like a real phone
- **Six apps:** Command-X (neural messaging), Profiles (contact intel), Quests (persistent story goals), Map (contact location tracking), Nova (agentic assistant, in development), Settings

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
- **Zoom and pan** — Scroll-wheel / pinch / double-click to zoom (1×–5×), drag to pan; the control overlay (＋ − ⟲) stays available, and the live percentage indicator appears while zooming and briefly after zoom changes
- **Interactive pins** — Tap empty map to add a place, drag pins to reposition, tap a contact pin to open their chat, tap "📍 You" to drop your own position marker
- **Movement trails** — Optional dashed trails show each contact's last few locations so you can see where they've been
- **Auto-registration** — The LLM can register new places and move contacts between them via `[status]` tags; manual edits are preserved

**Uploading your own map background:**
1. Open the phone, tap the **🧭 Map** app, then tap **Upload Image** in the header. Tap the **ℹ️** button next to it at any time to see this guidance in the app.
2. Pick any PNG, JPG, GIF, or WebP image. Raw files over **8 MB are rejected**. Accepted images are stored as JPEG to keep chat storage small; if an image is wider than **1024 px** on the long edge, it is also automatically downscaled first.
3. Prefer a roughly **square (1:1)** image — the map surface is a square frame and wider/taller images are cropped to "cover" it, so content near the edges may be trimmed.
4. After uploading, tap any empty spot on the map to drop a place pin, drag pins to fine-tune, and use zoom/pan to work with dense areas. Pin coordinates are anchored to the image, so they stay correct at any zoom level.
5. To revert, tap **Use Schematic**. The uploaded image is removed but your place pins are kept.
6. Map images are stored locally per ST chat (`localStorage`) and are **never uploaded to the LLM** or any server.


### 🔍 Profiles App (Contact Intel)
- **Character state tracking** — The LLM reports present-character status via `[status]` tags (mood, location, relationship, inner monologue)
- **Intel cards** — The active character and relevant contacts get profile cards with their current state
- **Auto-detection** — NPCs appear automatically as the story introduces them
- **Persistent** — NPC data survives page refreshes (localStorage-backed)

### ✴︎ Nova App (Agentic Assistant)
- **Tool-calling agent inside the phone** — Nova talks to your LLM through a dedicated chat-completion connection profile and runs **approval-gated tool calls** against the SillyTavern frontend, your install directory, and (optionally) a sandboxed shell
- **Three permission tiers** — `read` (read-only tools), `write` (adds file/character/worldbook writes, every destructive call needs approval), and `full` (also enables the shell allow-list). Configure the default in Settings → NOVA
- **Approval modal with diff preview** — Every write or shell call opens a modal showing the tool, the parsed arguments, and (for `fs_write`) a unified diff against the current file. Click Approve to execute, Cancel to deny
- **Skills** — A skill pack (Character Creator, Worldbook Creator, Image Prompter, free-form helper, STscript & Regex) shapes Nova's system prompt for the task at hand
- **Soul + memory** — Nova reads `nova/soul.md` (persona) and `nova/memory.md` (running notes) on every turn and can edit them through the same approval gate via the `nova_write_soul`, `nova_append_memory`, and `nova_overwrite_memory` tools
- **Audit log** — Executed bridge requests append a JSONL line to `<root>/data/_nova-audit.jsonl` (preferred) or `<root>/_nova-audit.jsonl` (fallback) on the server side, including bridge-side refusals/errors. The in-phone Settings → 📜 audit-log viewer (client side) also records approval outcomes such as user approvals/denials before dispatch. Raw `content` / `data` / `payload` is **never** logged
- **Companion server plugin** — `server-plugin/nova-agent-bridge/` exposes scoped `/fs/*` and `/shell/run` routes. Without the plugin, only ST-API tools are available; a yellow banner in the transcript explains what's filtered.

See the [Nova Agent](#-nova-agent) section below for setup.

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

## Usage

1. Enable in **Extensions → Command-X Phone**
2. Click the 📱 button in the extensions menu to open the phone
3. Tap a contact to chat
4. **Messages app** — Normal texting
5. **Command-X app** — Neural commands (use the drawer buttons or the ⚡ toggle)
6. **Profiles app** — View NPC intel cards
7. **Quests app** — Track persistent story goals
8. **Map app** — Track contact locations
9. **Nova app** — Agentic assistant; see the [Nova Agent](#-nova-agent) section
10. **Settings app** — Configure everything in-phone

## ✴︎ Nova Agent

Nova is a tool-calling assistant that lives inside the phone. It talks to your LLM through a dedicated chat-completion connection profile and dispatches **approval-gated tool calls** against the SillyTavern frontend, your install directory, and (optionally) a sandboxed shell — all without polluting your roleplay chat.

### SillyTavern prerequisites

Before configuring Nova in the phone, make sure your SillyTavern install has the following:

1. **SillyTavern 1.12.6 or newer.** Nova relies on `ConnectionManagerRequestService`, `isToolCallingSupported()`, and the built-in Connection Profiles, all of which landed in 1.12.6. Older builds will load the extension but Nova will refuse to dispatch a turn and surface an explanatory alert.
2. **A tool-calling-capable chat completion source.** OpenAI, Anthropic (Claude), Google (Gemini), and OpenRouter all qualify; pick the source on your connection profile and confirm the model you're using supports function/tool calls. Sources without tool-calling support fall back to a text-only mode (the transcript shows a yellow `⚠︎ Text-only mode` notice and tool calls are disabled for that turn).
3. **Connection Profiles enabled.** This is a built-in ST extension and is on by default; verify under **Extensions** that it isn't disabled. Nova uses it to swap to a dedicated profile for each turn and restore your previous one afterwards.
4. **(Optional, bridge plugin only) Server plugins enabled.** If you want filesystem/shell tools, add this line to the `config.yaml` at the root of your SillyTavern install **before** restarting:
   ```yaml
   enableServerPlugins: true
   ```
   Without this, ST will not load any server plugin (including `nova-agent-bridge`) and Nova will run with the ST-API-only tool subset. See [`server-plugin/nova-agent-bridge/README.md`](server-plugin/nova-agent-bridge/README.md) for the full bridge install walkthrough.
5. **(Optional, Private Polling only) `generateQuietPrompt` available.** Shipped in ST 1.12.10+ — see the [Private Polling](#private-polling) section.

### Quick start

1. **Install the chat-completion preset** — Open the ST extensions panel for Command-X Phone, scroll to **✴︎ Nova Agent**, and click **Install Command-X chat-completion preset**. This downloads the bundled `presets/openai/Command-X.json` and also copies the JSON to your clipboard when the browser allows it; import that file through ST's standard Chat Completion preset import button. The preset gives Nova a known-good starting config (`temperature` 0.85, `stream_openai: true`, `names_behavior: 2`, `wi_format` aligned with ST's defaults). Switch the model to whatever provider you use.
2. **Pick a connection profile** — In ST, create a connection profile that points at a chat-completion source supporting tool calling (OpenAI, Claude, Gemini, OpenRouter, etc.) and apply the preset above. Then in the phone, tap **Settings → NOVA → Connection profile** and enter the profile name.
3. **Pick a default tier** — `read` (safe, read-only), `write` (adds file and soul/memory writes, approval-gated; ST-native character/worldbook writes currently fall back to bridge `fs_write` hints), or `full` (also enables shell). Start with `read`.
4. **(Optional) Install the bridge plugin** — Make sure `enableServerPlugins: true` is set in your ST `config.yaml` (see [SillyTavern prerequisites](#sillytavern-prerequisites) above), drop `server-plugin/nova-agent-bridge/` into your SillyTavern `plugins/` directory, and restart ST to enable filesystem and shell tools. Without it, Nova still works but only with ST-API tools (characters, worldbooks, slash commands, etc.).
5. **Open the Nova app** in the phone, type a request, and hit send. Reads run silently; writes and shell calls open an approval modal with a diff preview before executing.

### How it works

```
You type in Nova
        ↓
Nova swaps to your dedicated connection profile (then restores after)
        ↓
System prompt = base + active skill + soul.md + memory.md + tool contract
        ↓
LLM calls back with tool_calls (e.g. `fs_read`, `st_write_character`)
        ↓
Each call → tier check → approval modal (writes/shells) → handler → tool result back to LLM
        ↓
Loop until LLM stops calling tools, hits the per-turn cap, or you cancel
        ↓
Profile is restored; transcript and audit log are persisted per chat
```

### Permission tiers

| Tier | What's allowed | Approval required? |
|------|----------------|--------------------|
| `read` | All `*_read` / `*_list` / `*_stat` / `*_search` tools | No |
| `write` | Read tools + every `*_write` / `*_delete` / `*_move` / soul-and-memory-edit tool. Character/worldbook write schemas are present, but currently return a clear `not-implemented` fallback that points Nova at the bridge `fs_write` workaround. | **Yes**, per call (or once per session if "Remember approvals this session" is on) |
| `full` | Write tools + `shell_run` (only commands on the bridge's allow-list) | **Yes**, per call |

Toggle **Settings → NOVA → Remember approvals (this session)** to skip the modal for tools you've already approved during this browser session. Reloading the page clears the list.

### Soul and memory

`nova/soul.md` and `nova/memory.md` are markdown files that get prepended to every Nova system prompt. The repo ships starter templates; the live runtime copies live under your ST install root and are edited by Nova itself through the `nova_write_soul`, `nova_read_memory`, `nova_append_memory`, and `nova_overwrite_memory` tools (approval-gated, with diff preview). Use **Settings → NOVA → 📝 Edit Soul & Memory** to edit them by hand from inside the phone.

### Skills

Pick the active skill from the Nova app's skill pill. Each skill swaps in a tailored system-prompt fragment:

- **Free-form helper** — General assistant, no specialised contract.
- **Character Creator** — Asks for archetype + traits, returns a complete character JSON, and can use the bridge `fs_write` workaround while the safer ST-native `st_write_character` handler remains deferred.
- **Worldbook Creator** — Returns a structured worldbook payload with entries + keys + comments, using the same `fs_write` workaround when the ST-native `st_write_worldbook` handler reports `not-implemented`.
- **Image Prompter** — Produces structured positive/negative prompt pairs for image-gen integrations.
- **STscript & Regex** — Drafts STscript blocks and regex extension entries with safety notes.

### The `nova-agent-bridge` server plugin

`server-plugin/nova-agent-bridge/` is a zero-runtime-dependency CommonJS plugin that exposes:

- `GET /health` and `GET /manifest` — capability probe (used to filter the tool list)
- `GET /fs/list`, `/fs/read`, `/fs/stat` — read-only filesystem tools, rooted at the ST install dir, with `.git/`, `node_modules/`, and the plugin folder denied
- `POST /fs/search` — content search with binary-skip and per-file caps
- `POST /fs/write`, `/fs/delete`, `/fs/move` — destructive routes that **always route through `.nova-trash/<ts>/<relPath>` first**, never hard-unlink, and append a redacted entry to the audit log
- `POST /shell/run` — single-shot, no-shell `child_process.spawn` against an allow-list resolved at startup, hard timeout (default 60s, max 5min), stdin closed, 1 MB per-stream output cap

Every state-changing route requires the `x-csrf-token` header (the extension provides it automatically) and a valid ST session. Audit entries strip top-level and nested `content` / `data` / `payload` / `body` / `raw` keys via a JSON replacer so user data never leaks into the log. See `server-plugin/nova-agent-bridge/README.md` for installation.

### Cancellation, errors, audit

- **Cancel** — The Nova view's cancel button calls `.abort()` on the live `AbortController`. The dispatcher checks the signal between every tool call and round, the LLM request is interrupted, and the connection profile is restored.
- **Errors** — Tool handler exceptions surface as a `role:'tool'` message containing `{ error: <message> }` so the LLM can recover or apologise. The transcript shows a red card.
- **Audit log** — In-phone: **Settings → NOVA → 📜 View audit log**. Server-side: `<root>/data/_nova-audit.jsonl` (or `<root>/_nova-audit.jsonl` if no `data/` dir).

For the full status / remaining-work list, see [`docs/nova-agent-plan.md`](docs/nova-agent-plan.md).

## Chat-Completion Preset

Command-X ships a chat-completion preset at `presets/openai/Command-X.json` that's tuned for Nova: sensible defaults for `temperature`, `frequency_penalty`, `presence_penalty`, `stream_openai`, `wi_format`, `scenario_format`, and `names_behavior`. The shape is OpenAI-style but provider-agnostic — clone it, change `chat_completion_source` and the corresponding `*_model` field, and you're set up for Claude, Gemini, OpenRouter, etc.

To install:
- **From the extension settings** — Click **Install Command-X chat-completion preset**. This best-effort path downloads `Command-X.json`, copies the JSON to your clipboard when possible, logs it to DevTools as a final fallback, and then shows import instructions.
- **Manually** — Open the file from `presets/openai/Command-X.json`, then in ST go to **Chat Completion → Presets → Import** and select it.

See `presets/openai/README.md` for the full breakdown of which fields are tuned and why.

### How It Works (RP messaging)

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
