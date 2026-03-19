# Command-X Phone

A SillyTavern third-party extension that adds a persistent smartphone UI with two apps:

- **Command-X** — A neural command messaging app (mind control / neural link theme)
- **Messages** — A standard iMessage-style texting app

The phone lets you text characters directly from a phone interface. Messages flow through the RP — the extension injects system prompts so the LLM includes phone replies in `[sms]...[/sms]` tags, which the extension extracts and renders as chat bubbles on the phone screen.

## Features

- **Floating phone panel** — Fullscreen overlay with a realistic phone shell (notch, bezel, home indicator)
- **Lock screen → Home screen → Apps** — Navigate like a real phone
- **iMessage-style chat bubbles** — Sent (blue), received (gray), neural commands (pink/purple gradient)
- **Command Mode Drawer** — Four neural command types (Command, Believe, Forget, Compel) with one-tap activation. No syntax to remember — just tap a mode and type naturally.
- **NPC Contacts** — The LLM automatically reports NPCs in the scene via `[contacts]` tags. They appear alongside ST characters in your contact list and are fully textable.
- **Prompt injection architecture** — Uses `setExtensionPrompt()` for clean upstream injection rather than trying to parse unstructured RP output
- **Per-chat message history** — Stored in localStorage, persists across page refreshes
- **`{{COMMAND}}` syntax styling** — Command tags in the main ST chat get colored inline styling
- **Typing indicator** — Bouncing dots while waiting for a reply, with 30-second safety timeout

## Installation

### From URL (recommended)
1. In SillyTavern, go to **Extensions** → **Install Extension**
2. Enter this repo URL: `https://github.com/dkylepeppers-alt/command-x`
3. Click Install, then refresh the page

### Manual
1. Clone this repo into your SillyTavern third-party extensions folder:
   ```bash
   cd ~/SillyTavern/public/scripts/extensions/third-party/
   git clone https://github.com/dkylepeppers-alt/command-x.git
   ```
2. Refresh SillyTavern

## Usage

1. Enable the extension in **Extensions** → **Command-X Phone** → check "Show phone panel"
2. Click the 📱 button in the extensions menu (or the phone icon) to open the phone
3. Tap a contact to open a chat
4. **Messages app**: Type normally for casual texting
5. **Command-X app**: Use the command drawer buttons to select a neural command mode, then type your command naturally

### Command Types

| Mode | Effect | Color |
|------|--------|-------|
| **Command** | Target feels compelled to obey | Red |
| **Believe** | Target genuinely believes the stated thing | Green |
| **Forget** | Target's memory of the specified thing fades | Purple |
| **Compel** | Target feels an overwhelming urge toward the behavior | Amber |

### How it works

1. You type a message in the phone UI
2. The extension sends it as RP text to the ST chat (e.g., `*texts Sarah on phone:* "hey"`)
3. Simultaneously injects a system prompt telling the LLM to wrap the reply in `[sms]` tags
4. The LLM responds with narration + `[sms]reply text[/sms]`
5. The extension extracts the tagged content for the phone, and replaces it with a subtle 📱 indicator in the main chat

## Settings

- **Show phone panel** — Toggle the phone on/off
- **Style {{COMMAND}} syntax in chat** — Color-code command tags in the main ST chat
- **Start on lock screen** — Show the lock screen when the phone opens

## Compatibility

Works with any chat completion API via OpenRouter or direct providers. The `[sms]` and `[contacts]` tag instructions are model-agnostic — tested with Claude, GPT, and others.

## Authors

Kyle & Bucky

## License

MIT
