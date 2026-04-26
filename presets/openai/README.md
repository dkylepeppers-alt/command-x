# Command-X Chat Completion Preset

`Command-X.json` is a Chat Completion preset tuned for Command-X roleplay and the
**Nova** agent. It matches SillyTavern's upstream
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
| `wi_format` | `{0}` | Raw WI inserts, no wrapper framing — matches upstream default. |
| `scenario_format` / `personality_format` | `{{scenario}}` / `{{personality}}` | Bare template expansions — matches upstream default so community cards render identically. |

## Schema parity with upstream

The preset matches the full field set of SillyTavern's upstream
`default/content/presets/openai/Default.json` (sampling params, all provider
model fields, every marker prompt, both `prompt_order` entries for
`character_id: 100000` single-character default and `100001` group/global
default, plus `seed`, `n`, `use_sysprompt`, `assistant_prefill`,
`squash_system_messages`, `continue_prefill`, `continue_postfix`,
`media_inlining`, `show_external_models`, `max_context_unlocked`,
`reverse_proxy`, `proxy_password`, `bias_preset_selected`). Only the Command-X
tuning knobs (temperature, penalties, context/tokens, `names_behavior`) and the
Main Prompt body diverge from upstream.

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

### Option A — Install from the Command-X extension

Open the SillyTavern extensions panel for **Command-X Phone**, scroll to
**✴︎ Nova Agent**, and click **Install Command-X chat-completion preset**.
Because ST does not expose a stable documented preset-save API for third-party
extensions, the button uses a best-effort handoff instead of silently writing
into your presets: it downloads `Command-X.json`, copies the formatted JSON to
your clipboard when the browser allows it, logs the JSON to DevTools as a final
fallback, and shows the same import instructions as **Option B**.

### Option B — Import manually

1. In SillyTavern, open **AI Response Configuration**.
2. Set **API** to "Chat Completion".
3. Under **Chat Completion presets**, click the import (📂) icon.
4. Pick this file (`presets/openai/Command-X.json`).
5. Choose it from the presets dropdown.

## Cloning for other providers

The preset already ships placeholder model IDs for every provider ST supports
(`claude_model`, `google_model`, `vertexai_model`, `openrouter_model`,
`ai21_model`, `mistralai_model`, `chutes_model`, `electronhub_model`,
`custom_model`). To switch providers, just copy the file and change
`chat_completion_source`:

```bash
cp Command-X.json Command-X-claude.json
```

Then edit the copy:

- **Claude / Anthropic**: `chat_completion_source` → `"claude"`. Override
  `claude_model` if you want something other than the shipped default.
- **Gemini (AI Studio)**: `chat_completion_source` → `"makersuite"`. Tune
  `google_model`.
- **Gemini (Vertex AI)**: `chat_completion_source` → `"vertexai"`. Tune
  `vertexai_model`.
- **OpenRouter**: `chat_completion_source` → `"openrouter"`. Tune
  `openrouter_model` (e.g. `anthropic/claude-3.5-sonnet`,
  `openai/gpt-4o-mini`).
- **Mistral / AI21 / Chutes / ElectronHub / Custom**: set
  `chat_completion_source` to the matching source and override the provider's
  `*_model` field.

All other fields (`temperature`, `top_p`, `prompts[]`, `prompt_order[]`,
sampling params) carry over unchanged. The Main Prompt is provider-agnostic.

## Nova compatibility

Nova layers its skill-specific system prompt and tool-use contract **on top of**
this preset's Main Prompt at request build time — the preset itself stays a
clean RP preset and is safe to use from any other Command-X utility profile.
