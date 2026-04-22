# Command-X Chat Completion Preset

`Command-X.json` is a Chat Completion preset tuned for Command-X roleplay and for
the upcoming **Nova** agent. It matches SillyTavern's upstream
`default/content/presets/openai/Default.json` schema so it imports cleanly into
the **AI Response Configuration → Chat Completion presets** panel.

## What it's tuned for

| Field | Value | Why |
| --- | --- | --- |
| `chat_completion_source` | `openai` | Portable baseline. Swap to any Chat-Completion provider — see "Cloning for other providers" below. |
| `openai_model` | `gpt-4o-mini` | Cheap, fast, tool-call-capable. Override per profile. |
| `temperature` | `0.85` | Warm enough for RP prose, not so hot that tag payloads drift. |
| `top_p` | `1` | Let temperature do the work; `top_p` clamps become redundant. |
| `frequency_penalty` / `presence_penalty` | `0.1` | Mild anti-repetition; stays out of the tag grammar's way. |
| `openai_max_context` | `32768` | Comfortable for ongoing RPs with world-info + phone state. |
| `openai_max_tokens` | `800` | Keeps replies beat-sized; phone bubbles stay short. |
| `stream_openai` | `true` | Visible typing + early cancel. |
| `names_behavior` | `2` (completion names) | Preserves `{{char}}` / `{{user}}` attribution across turns. |
| `wi_format` | `{0}` | Raw WI inserts, no wrapper framing. |
| `scenario_format` / `personality_format` | Default bracketed framings. | Matches upstream conventions so community cards render identically. |

## Main Prompt

The Main Prompt teaches the model Command-X's tag grammar:

- `[sms from="Name" to="user"]…[/sms]` — phone texts
- `[status][{ … }][/status]` — NPC contact cards
- `[quests][{ … }][/quests]` — quest tracker updates
- `[place]…[/place]` — current location

It explicitly tells the model: **emit tags only when warranted, never narrate
them, never markdown-fence them, never explain them.** Multiple `[sms]` blocks
per reply are allowed (different senders / beats).

## Marker prompts

All upstream markers (`chatHistory`, `worldInfoBefore`, `worldInfoAfter`,
`dialogueExamples`, `charDescription`, `charPersonality`, `scenario`,
`personaDescription`, `enhanceDefinitions`) are present with
`prompt_order` defaults matching SillyTavern's own ordering. `Auxiliary Prompt`
(`nsfw`) and `Post-History Instructions` (`jailbreak`) are preserved but empty —
add project-specific text per profile rather than shipping it here.

## Installing

### Option A — Install from the Command-X extension *(planned, not yet shipped)*

A future Nova rollout (plan §11b) adds an **"Install Command-X Chat
Completion preset"** button to the Command-X settings panel that will call
`ctx.executeSlashCommandsWithOptions('/preset-import …')` — or fall back to
`POST /api/presets/save` — and select the preset automatically. Until that
button ships, use **Option B** below.

### Option B — Import manually

1. In SillyTavern, open **AI Response Configuration**.
2. Set **API** to "Chat Completion".
3. Under **Chat Completion presets**, click the import (📂) icon.
4. Pick this file (`presets/openai/Command-X.json`).
5. Choose it from the presets dropdown.

## Cloning for other providers

The only fields that are truly OpenAI-specific are
`chat_completion_source` and the `*_model` fields. To clone:

```bash
cp Command-X.json Command-X-claude.json
```

Then edit the copy:

- **Claude / Anthropic**: set `chat_completion_source` to `"claude"`; set
  `claude_model` (e.g. `claude-3-5-sonnet-latest`). Leave `openai_max_context`
  as the context window.
- **Gemini**: `chat_completion_source` → `"makersuite"`; set `google_model`
  (e.g. `gemini-1.5-pro-latest`).
- **OpenRouter**: `chat_completion_source` → `"openrouter"`; set
  `openrouter_model` (e.g. `anthropic/claude-3.5-sonnet`,
  `openai/gpt-4o-mini`, etc.).

All other fields (`temperature`, `top_p`, `prompts[]`, `prompt_order[]`)
carry over unchanged. The preset's Main Prompt is provider-agnostic.

## Nova compatibility

Nova layers its skill-specific system prompt and tool-use contract **on top of**
this preset's Main Prompt at request build time — the preset itself stays a
clean RP preset and is safe to use from any other Command-X utility profile.
