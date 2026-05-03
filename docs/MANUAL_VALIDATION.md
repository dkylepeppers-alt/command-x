# Manual Validation — Command-X v0.13.2

> **Standalone, self-contained release-gate checklist.** Run through every box
> before tagging a release. This file is the **single source of truth** —
> `docs/nova-agent-plan.md` §14 points here.
>
> Items are intentionally written so a **Codex CLI** session can walk through
> them top-to-bottom (`less docs/MANUAL_VALIDATION.md`, or
> `glow docs/MANUAL_VALIDATION.md` if available) while you keep a live
> SillyTavern browser open for the UI clicks. Every UI label, button id, file
> path, and console string is quoted verbatim from the v0.13.2 source.
>
> **Permanent `[ ]` checklist.** Never agent-ticked — these are *user*
> acceptance steps, not unit tests. Re-run on every release.

---

## How to run this with Codex CLI

Use Codex CLI as the terminal/operator assistant and keep one browser tab open
to the live SillyTavern instance. Codex can run shell checks, inspect files,
probe HTTP routes, and remind you which exact UI label to click; you perform
browser-only actions unless your Codex environment has an attached browser.

Recommended setup from the extension checkout:

```bash
export ST_ROOT="$HOME/SillyTavern"
export CX_DIR="$ST_ROOT/public/scripts/extensions/third-party/command-x"
cd "$CX_DIR"
```

If your clone lives elsewhere, set `CX_DIR` to that absolute path instead. For
bridge-plugin sections, `ST_ROOT` must be the SillyTavern install root that is
actually running.

Reusable Codex CLI prompt:

```text
Follow docs/MANUAL_VALIDATION.md for Command-X. Treat unchecked boxes as user
acceptance checks, not edits. Run the terminal commands and HTTP probes you can
run from this checkout, ask me to do browser-only SillyTavern clicks, and record
pass/fail notes phase by phase. Do not change source files unless a step fails
and I explicitly ask for a fix.
```

Notation used below:

- **Codex CLI:** terminal command or file/HTTP inspection Codex can run.
- **User/browser:** click/type/observe in the live SillyTavern UI.
- **Codex CLI + user:** Codex can prepare/check the file operation; you restart
  or operate the live SillyTavern process/browser as needed.
- **Both:** coordinate the terminal output with what the browser shows.

---

## 0. Preconditions

Before the phone or Nova will work at all:

- [ ] **User/browser:** **SillyTavern 1.12.6 or newer** is installed and running.
  (Nova relies on
  `ConnectionManagerRequestService`, `isToolCallingSupported()`, and Connection
  Profiles, all 1.12.6.)
- [ ] **User/browser:** **Connection Profiles** extension is enabled (built-in,
  on by default — verify under **Extensions** that it is not disabled).
- [ ] **User/browser:** At least one **chat-completion connection profile**
  exists pointing at a source that supports tool calling (OpenAI / Claude /
  Gemini / OpenRouter).
- [ ] **Codex CLI:** This repo is checked out at
  `SillyTavern/public/scripts/extensions/third-party/command-x/`, or `CX_DIR`
  is set to the checkout path you are validating.
- [ ] **Codex CLI:** `manifest.json` reports `"version": "0.13.2"`:
  `node -p "require('./manifest.json').version"`.

Optional (only required for the bridge-plugin sections below):

- [ ] **Codex CLI:** `enableServerPlugins: true` is set in the SillyTavern
  install's root `config.yaml` (`grep -n 'enableServerPlugins: true'
  "$ST_ROOT/config.yaml"`). **Without this line, ST will not load *any* server
  plugin — the bridge will be silently ignored.**

---

## A. Load + sanity

- [ ] **User/browser:** In SillyTavern, **Extensions → Command-X Phone** is enabled.
- [ ] **User/browser:** Hard-refresh the ST page (Ctrl+Shift+R) and open the
  browser DevTools console. The console logs
  **`[command-x] v0.13.2 Loaded OK`** with no red errors above or below it.
- [ ] **User/browser:** Click the **📱** button in the extensions menu. The phone
  opens to the lock screen (or home, depending on your "Lock Screen on Open"
  setting).
- [ ] **User/browser:** On the home grid, **Nova** appears as a tile (✴︎ icon).
  **OpenClaw is no longer present** — the legacy app was retired in v0.13.0.
- [ ] **User/browser:** Tap the Nova tile. The view opens to an empty transcript
  with a **"Pick a connection profile"** placeholder card (it will say no
  profile is configured if you haven't set one yet).
- [ ] **User/browser:** Tap the Nova **skill pill** and verify the picker lists
  **Plain helper**, **Character Creator**, **Worldbook Creator**,
  **STscript & Regex**, **Image Prompter**, **Quest Designer**,
  **NPC / Contact Manager**, **Map / Location Designer**, **Lore Auditor**,
  **Prompt Doctor**, and **Command-X Diagnostics**.
- [ ] **User/browser:** Tap **Settings (⚙)**. The in-phone Settings app shows a
  **NOVA** section with: Connection profile, Default permission tier, Max tool
  calls per turn, Turn timeout, Bridge plugin base URL, Remember approvals (this
  session) toggle, **📝 Edit Soul & Memory** button, **📜 View audit log**
  button.

---

## B. Chat-completion preset

- [ ] **User/browser:** Open the ST extensions panel for Command-X Phone, scroll
  to **✴︎ Nova Agent**, and click **Install Command-X chat-completion preset**.
- [ ] **User/browser:** In ST's **Chat Completion → Presets** dropdown, the preset
  **`Command-X`** appears. (Field-by-field rationale lives in
  `presets/openai/README.md`.)
- [ ] **User/browser:** Apply this preset to a connection profile (create one
  named e.g. `Command-X` if you don't already have a tool-calling profile).
- [ ] **User/browser:** In the phone, **Settings → NOVA → Connection profile**,
  type the name of that profile. The value persists after closing and reopening
  Settings.

---

## C. Read-only Nova turn (ST-API only — no bridge needed)

- [ ] **User/browser:** In **Settings → NOVA → Default permission tier**, choose
  **read**.
- [ ] **User/browser:** Open the **Nova** app and send the message
  **"List my characters."**
- [ ] **User/browser:** The transcript shows a tool-call card for
  **`st_list_characters`** (read-only — *no* approval modal). The assistant
  follows up with a summary paragraph naming a few characters from your ST
  install.
- [ ] **User/browser:** If your connection-profile source does not support tool
  calling, the transcript shows a yellow **`⚠︎ Text-only mode`** notice instead
  and tool calls are disabled for that turn (this is the documented fallback,
  not a failure — it just means you need a tool-calling source for the rest of
  this doc).

---

## D. Write-tier turn — Character Creator fallback surface

- [ ] **User/browser:** In **Settings → NOVA**, raise **Default permission tier**
  to **write**.
- [ ] **User/browser:** In the Nova app, tap the **skill pill** and choose
  **Character Creator**.
- [ ] **User/browser:** Send: **"Create Aria, a witty cyberpunk hacker."**
- [ ] **User/browser:** Nova proposes **`st_write_character`** (the canonical
  ST-native write path). The **approval modal** opens showing the parsed args;
  click **Approve**.
- [ ] **User/browser:** The tool result reports a successful ST-native create
  through `/api/characters/create`; refresh the character list if needed and
  verify **Aria** appears without using the filesystem bridge workaround.
- [ ] **Both:** If Nova detects an existing **Aria**, it should read the card
  and ask before overwriting rather than silently replacing it.

---

## E. Worldbook Creator

- [ ] **User/browser:** Switch the active skill to **Worldbook Creator**.
- [ ] **User/browser:** Send:
  **"Build a small worldbook with three entries about the city of Pacifica."**
- [ ] **User/browser:** Nova proposes **`st_write_worldbook`** with three
  entries; approve.
- [ ] **User/browser:** The tool result reports a successful ST-native worldbook
  write through `/api/worldinfo/edit`.
- [ ] **Both:** Open ST's **World Info / Lorebook** UI and verify the Pacifica
  worldbook loads with the expected entries, activation keys, and content.

---

## F. Image Prompter

- [ ] **User/browser:** Switch the active skill to **Image Prompter**.
- [ ] **User/browser:** Send mid-RP:
  **"Make a prompt pair for a stormy lighthouse at dusk."**
- [ ] **User/browser:** The transcript renders structured **positive** and
  **negative** prompts (not free-form prose). Both are usable as-is in any
  image-gen integration.

---

## G. Soul / Memory editor

- [ ] **User/browser:** **Settings → NOVA → 📝 Edit Soul & Memory** opens an
  in-phone modal with two tabs: `soul.md` and `memory.md`. The default content
  matches the starter docs in `nova/soul.md` / `nova/memory.md` on first run for
  the current chat.
- [ ] **User/browser:** Edit `soul.md` (e.g. add the line
  *"Sign every reply with 'cheers'."*) and save.
- [ ] **User/browser:** Send a fresh Nova turn. The reply incorporates the
  change (e.g. ends with "cheers").
- [ ] **User/browser:** Send a Nova turn that asks Nova to update its own
  memory. Nova proposes **`nova_append_memory`** or **`nova_overwrite_memory`**
  → approval modal with diff preview → approve. The change is reflected on the
  next turn.

---

## H. Bridge plugin — install + filesystem

> Skip this whole section if you don't intend to use the bridge plugin.
> Without it, Nova still works but only with the ST-API tool subset.

- [ ] **Codex CLI:** Verify `enableServerPlugins: true` is set in the
  SillyTavern install's root `config.yaml` (see Preconditions).
- [ ] **Codex CLI + user:** Copy or symlink
  **`server-plugin/nova-agent-bridge/`** into
  `SillyTavern/plugins/nova-agent-bridge/`, then restart SillyTavern.
- [ ] **Codex CLI:** On the SillyTavern startup log, you see:
  `[nova-agent-bridge] loaded — root=/path/to/your/root audit=… shell=…`
- [ ] **Codex CLI:** Probe the manifest route:
  `curl http://localhost:8000/api/plugins/nova-agent-bridge/manifest` returns
  a JSON object with `version`, `root`, `auditLogPath`, and a
  `capabilities` block where every `fs_*` key is `true`.
- [ ] **User/browser:** In the phone, the Nova transcript no longer shows the yellow
  *"bridge not detected"* banner.
- [ ] **User/browser:** Send:
  **"List the files in my SillyTavern install root."** Nova calls
  **`fs_list`** (read-tier — no approval) and the result enumerates real
  entries from your install directory.

---

## I. Bridge plugin — write + audit log

- [ ] **User/browser:** Tier is **write** (or **full**). Send:
  **"Create a file `notes.md` in my install root containing the line
  `hello from nova`."**
- [ ] **User/browser:** Nova proposes **`fs_write`**. The approval modal renders
  a **unified diff** (`+ hello from nova` against an empty baseline). Approve.
- [ ] **Codex CLI:** On disk, `notes.md` exists in the resolved root and
  contains exactly `hello from nova`
  (`test "$(cat "$ST_ROOT/notes.md")" = "hello from nova"`).
- [ ] **User/browser:** Ask Nova to **delete** that file. Nova proposes
  **`fs_delete`**; approve.
- [ ] **Codex CLI:** On disk, `notes.md` no longer exists at the original path
  **but a copy is preserved under `<root>/.nova-trash/<timestamp>/notes.md`** —
  deletes never hard-unlink (`find "$ST_ROOT/.nova-trash" -name notes.md
  -print`).
- [ ] **Codex CLI:** Inspect the audit log on disk. The path is
  **`<root>/data/_nova-audit.jsonl`** (preferred) **or
  `<root>/_nova-audit.jsonl`** (fallback when no `data/` directory exists). It
  is a single append-only JSONL file (not a directory).
  Recent lines include entries for `fs_write` and `fs_delete` with `outcome`,
  `argsSummary`, `bytes`, and **no raw `content` / `data` / `payload` /
  `body` / `raw` keys** at any nesting level.
- [ ] **User/browser:** In the phone, **Settings → NOVA → 📜 View audit log**
  opens the in-phone audit-log viewer and shows the same calls (per-chat,
  in-memory copy capped at `NOVA_AUDIT_CAP`).

---

## J. Bridge plugin — shell allow-list

- [ ] **User/browser:** Tier is **full**. Send:
  **"Run `git status` in my install root."**
- [ ] **User/browser:** Nova proposes **`shell_run`** with `cmd: "git"`,
  `args: ["status"]`. The approval modal opens; approve.
- [ ] **User/browser:** The transcript shows the captured stdout (and stderr, if
  any), an `exitCode`, and a `durationMs`. If the command produced more than
  1 MB on either stream, the response also reports
  `truncated: { stdout: true }` / `truncated: { stderr: true }`.
- [ ] **Codex CLI:** A new audit-log line appears for the `shell_run` call with
  `argsSummary.cmd: "git"` and `argsCount: 1`. The actual argument *values*
  are NOT logged (same redaction as `fs_write`).
- [ ] **User/browser:** Send: **"Run `rm -rf /` in my install root."** Nova
  proposes `shell_run`. Approve. The bridge **refuses** with `outcome:
  "refused-not-allowed"` because `rm` is not on the allow-list (default:
  `node`, `npm`, `git`, `python`, `python3`, `grep`, `rg`, `ls`, `cat`,
  `head`, `tail`, `wc`, `find`).

---

## K. Bridge uninstall — graceful degradation

- [ ] **Codex CLI + user:** Stop SillyTavern, remove (or rename) the
  `SillyTavern/plugins/nova-agent-bridge/` directory, and restart.
- [ ] **User/browser:** Open the Nova app. The transcript header shows the
  **yellow "bridge not detected"** banner explaining that filesystem and
  shell tools are unavailable for this session.
- [ ] **User/browser:** Send a read-only ST-API turn (e.g.
  *"What characters do I have?"*). Nova still answers correctly using
  `st_list_characters` — only the `fs_*` and `shell_run` tools are filtered.
- [ ] **Codex CLI + user:** Reinstall the bridge before continuing the rest of
  this checklist.

---

## L. Cancellation + profile restoration

- [ ] **User/browser:** In SillyTavern, run **`/profile`** in the ST chat input
  and note the current connection profile name (e.g. `My Default Profile`).
- [ ] **User/browser:** In the Nova app, send a long-running prompt (e.g.
  *"Walk me through every character in detail, one at a time."*).
- [ ] **User/browser:** Mid-turn, click the **Cancel** button on the active Nova
  turn.
- [ ] **User/browser:** The transcript shows the turn aborted (red cancel
  marker), the live LLM request is interrupted (no partial-completion runaway),
  and **the profile mutex restores your previous profile**.
- [ ] **User/browser:** Run **`/profile`** again in the ST chat input. The
  reported profile is the same as before the Nova turn started — not the Nova
  profile.

---

## M. RP-chat isolation

- [ ] **User/browser:** Send a Nova turn so the transcript has at least one
  assistant message.
- [ ] **User/browser:** In the underlying ST chat, **swipe** the most recent
  assistant message (regen). The Nova transcript is **untouched** — Nova state
  lives in `ctx.chatMetadata[EXT].nova`, not the ST chat array.
- [ ] **User/browser:** Send a phone text via the **Command-X** app, get an
  `[sms]` reply, then swipe the corresponding ST chat message. Phone messages
  tied to that ST message id are removed and replaced when the new generation
  arrives. The Nova transcript is still untouched.

---

## N. Phone-app smoke (non-Nova features still working)

> v0.13.0 was a Nova-heavy release; spot-check the rest of the phone has not
> regressed.

- [ ] **User/browser: Command-X / Messages** — open a contact, send a normal
  text, get an `[sms]` reply, confirm the bubble renders and the `[sms]` tag is
  hidden in the underlying ST chat (replaced by the 📱 indicator).
- [ ] **User/browser: Neural toggle (⚡)** — switch to neural mode, send a
  `COMMAND` (e.g. *"forget my name"*). The reply renders with the pink/purple
  glow and the target reacts in-character without acknowledging the command was
  sent.
- [ ] **User/browser: Profiles** — at least one NPC card renders with
  mood/location/thoughts pulled from the most recent `[status]` tag.
- [ ] **User/browser: Quests** — open the Quests app; create a quest manually;
  ask the LLM to update it via narrative; the auto-update preserves your
  manually pinned fields.
- [ ] **User/browser: Map** — open the Map app; default schematic background
  loads; tap an empty area to drop a place pin; tap a contact pin to open their
  chat.
  Optionally upload an image background (≤8 MB, PNG/JPG/GIF/WebP) and confirm
  pins stay anchored across zoom levels (1×–5×).
- [ ] **User/browser: Private polling** — *(only if your ST build exposes
  `generateQuietPrompt`, 1.12.10+)* — enable **Private hybrid texts** in
  in-phone Settings, click **Check Messages** in Command-X. Either an `[sms]`
  block lands in the inbox or no reply is delivered (both are valid — it is
  the LLM's call whether anyone would text you right now).

---

## O. Tagging the release

- [ ] **Both:** Every box above is checked.
- [ ] **Codex CLI:** `node --test test/*.mjs` is green (the automated suite is
  not part of this manual checklist but should be green on the same commit).
- [ ] **Codex CLI:** `manifest.json` `version` matches the tag you are about to
  cut (`node -p "require('./manifest.json').version"`).
- [ ] **Codex CLI:** `AGENT_MEMORY.md` has an entry for the release sweep.

When all of the above are true, tag and push.

---

## Notes on this file

- Update this checklist whenever a step's wording stops matching the shipping
  UI or stops reflecting reality on disk. The file is canonical; do **not**
  duplicate the steps inline in the plan.
- Permission tiers, tool names, button labels, and file paths quoted above
  are pinned to v0.13.2 source. If you bump `manifest.json#version`, refresh
  the version string in §0 and §A.
