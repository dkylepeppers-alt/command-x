# Manual Validation — Command-X v0.13.0

> **Standalone, self-contained release-gate checklist.** Run through every box
> before tagging a release. This file is the **single source of truth** —
> `docs/nova-agent-plan.md` §14 points here.
>
> Items are intentionally written so you can walk through them top-to-bottom in
> a CLI (`less docs/MANUAL_VALIDATION.md`, or `glow docs/MANUAL_VALIDATION.md`
> if you have it) without flipping between files. Every UI label, button id,
> file path, and console string is quoted verbatim from the v0.13.0 source.
>
> **Permanent `[ ]` checklist.** Never agent-ticked — these are *user*
> acceptance steps, not unit tests. Re-run on every release.

---

## 0. Preconditions

Before the phone or Nova will work at all:

- [ ] **SillyTavern 1.12.6 or newer** is installed and running. (Nova relies on
  `ConnectionManagerRequestService`, `isToolCallingSupported()`, and Connection
  Profiles, all 1.12.6.)
- [ ] **Connection Profiles** extension is enabled (built-in, on by default —
  verify under **Extensions** that it is not disabled).
- [ ] At least one **chat-completion connection profile** exists pointing at a
  source that supports tool calling (OpenAI / Claude / Gemini / OpenRouter).
- [ ] This repo is checked out at
  `SillyTavern/public/scripts/extensions/third-party/command-x/`.
- [ ] `manifest.json` reports `"version": "0.13.0"`.

Optional (only required for the bridge-plugin sections below):

- [ ] `enableServerPlugins: true` is set in the SillyTavern install's root
  `config.yaml`. **Without this line, ST will not load *any* server plugin —
  the bridge will be silently ignored.**

---

## A. Load + sanity

- [ ] In SillyTavern, **Extensions → Command-X Phone** is enabled.
- [ ] Hard-refresh the ST page (Ctrl+Shift+R) and open the browser DevTools
  console. The console logs **`[command-x] v0.13.0 Loaded OK`** with no red
  errors above or below it.
- [ ] Click the **📱** button in the extensions menu. The phone opens to the
  lock screen (or home, depending on your "Lock Screen on Open" setting).
- [ ] On the home grid, **Nova** appears as a tile (✴︎ icon). **OpenClaw is no
  longer present** — the legacy app was retired in v0.13.0.
- [ ] Tap the Nova tile. The view opens to an empty transcript with a
  **"Pick a connection profile"** placeholder card (it will say no profile is
  configured if you haven't set one yet).
- [ ] Tap **Settings (⚙)**. The in-phone Settings app shows a **NOVA** section
  with: Connection profile, Default permission tier, Max tool calls per turn,
  Turn timeout, Bridge plugin base URL, Remember approvals (this session)
  toggle, **📝 Edit Soul & Memory** button, **📜 View audit log** button.

---

## B. Chat-completion preset

- [ ] Open the ST extensions panel for Command-X Phone, scroll to **✴︎ Nova
  Agent**, and click **Install Command-X chat-completion preset**.
- [ ] In ST's **Chat Completion → Presets** dropdown, the preset
  **`Command-X`** appears. (Field-by-field rationale lives in
  `presets/openai/README.md`.)
- [ ] Apply this preset to a connection profile (create one named e.g.
  `Command-X` if you don't already have a tool-calling profile).
- [ ] In the phone, **Settings → NOVA → Connection profile**, type the name
  of that profile. The value persists after closing and reopening Settings.

---

## C. Read-only Nova turn (ST-API only — no bridge needed)

- [ ] In **Settings → NOVA → Default permission tier**, choose **read**.
- [ ] Open the **Nova** app and send the message **"List my characters."**
- [ ] The transcript shows a tool-call card for **`st_list_characters`**
  (read-only — *no* approval modal). The assistant follows up with a summary
  paragraph naming a few characters from your ST install.
- [ ] If your connection-profile source does not support tool calling, the
  transcript shows a yellow **`⚠︎ Text-only mode`** notice instead and tool
  calls are disabled for that turn (this is the documented fallback, not a
  failure — it just means you need a tool-calling source for the rest of this
  doc).

---

## D. Write-tier turn — Character Creator (no bridge)

- [ ] In **Settings → NOVA**, raise **Default permission tier** to **write**.
- [ ] In the Nova app, tap the **skill pill** and choose **Character
  Creator**.
- [ ] Send: **"Create Aria, a witty cyberpunk hacker."**
- [ ] Nova proposes **`st_write_character`** (the canonical write path —
  goes through ST's character API, not the filesystem). The **approval modal**
  opens showing the parsed args; click **Approve**.
- [ ] After the turn ends, **Aria** appears in your ST character list (refresh
  the character panel if needed).
- [ ] *(Optional bridge variant)* If the bridge is installed and tier is
  **write**, Nova may instead choose **`fs_write`** to drop the JSON onto
  disk. In that case the approval modal additionally renders a **unified diff
  preview** of the proposed file content. Approve → file written → re-read by
  Nova on the next turn.

---

## E. Worldbook Creator

- [ ] Switch the active skill to **Worldbook Creator**.
- [ ] Send: **"Build a small worldbook with three entries about the city of
  Pacifica."**
- [ ] Nova proposes **`st_write_worldbook`** with three entries; approve.
- [ ] Open ST's **World Info / Lorebook** UI. The new worldbook loads cleanly,
  all three entries are present, each entry's `keys` / `content` / `comment`
  fields are populated, and the schema validates (no red error toasts).

---

## F. Image Prompter

- [ ] Switch the active skill to **Image Prompter**.
- [ ] Send mid-RP: **"Make a prompt pair for a stormy lighthouse at dusk."**
- [ ] The transcript renders structured **positive** and **negative** prompts
  (not free-form prose). Both are usable as-is in any image-gen integration.

---

## G. Soul / Memory editor

- [ ] **Settings → NOVA → 📝 Edit Soul & Memory** opens an in-phone modal
  with two tabs: `soul.md` and `memory.md`. The default content matches the
  starter docs in `nova/soul.md` / `nova/memory.md` on first run for the
  current chat.
- [ ] Edit `soul.md` (e.g. add the line *"Sign every reply with 'cheers'."*)
  and save.
- [ ] Send a fresh Nova turn. The reply incorporates the change (e.g. ends
  with "cheers").
- [ ] Send a Nova turn that asks Nova to update its own memory. Nova proposes
  **`nova_append_memory`** or **`nova_overwrite_memory`** → approval modal
  with diff preview → approve. The change is reflected on the next turn.

---

## H. Bridge plugin — install + filesystem

> Skip this whole section if you don't intend to use the bridge plugin.
> Without it, Nova still works but only with the ST-API tool subset.

- [ ] Verify `enableServerPlugins: true` is set in the SillyTavern install's
  root `config.yaml` (see Preconditions).
- [ ] Copy or symlink **`server-plugin/nova-agent-bridge/`** into
  `SillyTavern/plugins/nova-agent-bridge/` and restart SillyTavern.
- [ ] On the SillyTavern startup log, you see:
  `[nova-agent-bridge] loaded — root=/path/to/your/root audit=… shell=…`
- [ ] Probe the manifest route:
  `curl http://localhost:8000/api/plugins/nova-agent-bridge/manifest` returns
  a JSON object with `version`, `root`, `auditLogPath`, and a
  `capabilities` block where every `fs_*` key is `true`.
- [ ] In the phone, the Nova transcript no longer shows the yellow
  *"bridge not detected"* banner.
- [ ] Send: **"List the files in my SillyTavern install root."** Nova calls
  **`fs_list`** (read-tier — no approval) and the result enumerates real
  entries from your install directory.

---

## I. Bridge plugin — write + audit log

- [ ] Tier is **write** (or **full**). Send:
  **"Create a file `notes.md` in my install root containing the line
  `hello from nova`."**
- [ ] Nova proposes **`fs_write`**. The approval modal renders a **unified
  diff** ( `+ hello from nova` against an empty baseline). Approve.
- [ ] On disk, `notes.md` exists in the resolved root and contains exactly
  `hello from nova`.
- [ ] Ask Nova to **delete** that file. Nova proposes **`fs_delete`**;
  approve.
- [ ] On disk, `notes.md` no longer exists at the original path **but a copy
  is preserved under `<root>/.nova-trash/<timestamp>/notes.md`** — deletes
  never hard-unlink.
- [ ] Inspect the audit log on disk. The path is **`<root>/data/_nova-audit.jsonl`**
  (preferred) **or `<root>/_nova-audit.jsonl`** (fallback when no `data/`
  directory exists). It is a single append-only JSONL file (not a directory).
  Recent lines include entries for `fs_write` and `fs_delete` with `outcome`,
  `argsSummary`, `bytes`, and **no raw `content` / `data` / `payload` /
  `body` / `raw` keys** at any nesting level.
- [ ] In the phone, **Settings → NOVA → 📜 View audit log** opens the
  in-phone audit-log viewer and shows the same calls (per-chat, in-memory copy
  capped at `NOVA_AUDIT_CAP`).

---

## J. Bridge plugin — shell allow-list

- [ ] Tier is **full**. Send: **"Run `git status` in my install root."**
- [ ] Nova proposes **`shell_run`** with `cmd: "git"`, `args: ["status"]`.
  The approval modal opens; approve.
- [ ] The transcript shows the captured stdout (and stderr, if any), an
  `exitCode`, and a `durationMs`. If the command produced more than 1 MB on
  either stream, the response also reports `truncated: { stdout: true }` /
  `truncated: { stderr: true }`.
- [ ] A new audit-log line appears for the `shell_run` call with
  `argsSummary.cmd: "git"` and `argsCount: 1`. The actual argument *values*
  are NOT logged (same redaction as `fs_write`).
- [ ] Send: **"Run `rm -rf /` in my install root."** Nova proposes
  `shell_run`. Approve. The bridge **refuses** with `outcome:
  "refused-not-allowed"` because `rm` is not on the allow-list (default:
  `node`, `npm`, `git`, `python`, `python3`, `grep`, `rg`, `ls`, `cat`,
  `head`, `tail`, `wc`, `find`).

---

## K. Bridge uninstall — graceful degradation

- [ ] Stop SillyTavern, remove (or rename) the
  `SillyTavern/plugins/nova-agent-bridge/` directory, and restart.
- [ ] Open the Nova app. The transcript header shows the
  **yellow "bridge not detected"** banner explaining that filesystem and
  shell tools are unavailable for this session.
- [ ] Send a read-only ST-API turn (e.g. *"What characters do I have?"*).
  Nova still answers correctly using `st_list_characters` — only the
  `fs_*` and `shell_run` tools are filtered.
- [ ] Reinstall the bridge before continuing the rest of this checklist.

---

## L. Cancellation + profile restoration

- [ ] In SillyTavern, run **`/profile`** in the ST chat input and note the
  current connection profile name (e.g. `My Default Profile`).
- [ ] In the Nova app, send a long-running prompt (e.g. *"Walk me through
  every character in detail, one at a time."*).
- [ ] Mid-turn, click the **Cancel** button on the active Nova turn.
- [ ] The transcript shows the turn aborted (red cancel marker), the live
  LLM request is interrupted (no partial-completion runaway), and **the
  profile mutex restores your previous profile**.
- [ ] Run **`/profile`** again in the ST chat input. The reported profile is
  the same as before the Nova turn started — not the Nova profile.

---

## M. RP-chat isolation

- [ ] Send a Nova turn so the transcript has at least one assistant message.
- [ ] In the underlying ST chat, **swipe** the most recent assistant message
  (regen). The Nova transcript is **untouched** — Nova state lives in
  `ctx.chatMetadata[EXT].nova`, not the ST chat array.
- [ ] Send a phone text via the **Command-X** app, get an `[sms]` reply, then
  swipe the corresponding ST chat message. Phone messages tied to that ST
  message id are removed and replaced when the new generation arrives. The
  Nova transcript is still untouched.

---

## N. Phone-app smoke (non-Nova features still working)

> v0.13.0 was a Nova-heavy release; spot-check the rest of the phone has not
> regressed.

- [ ] **Command-X / Messages** — open a contact, send a normal text, get an
  `[sms]` reply, confirm the bubble renders and the `[sms]` tag is hidden in
  the underlying ST chat (replaced by the 📱 indicator).
- [ ] **Neural toggle (⚡)** — switch to neural mode, send a `COMMAND` (e.g.
  *"forget my name"*). The reply renders with the pink/purple glow and the
  target reacts in-character without acknowledging the command was sent.
- [ ] **Profiles** — at least one NPC card renders with mood/location/thoughts
  pulled from the most recent `[status]` tag.
- [ ] **Quests** — open the Quests app; create a quest manually; ask the LLM
  to update it via narrative; the auto-update preserves your manually pinned
  fields.
- [ ] **Map** — open the Map app; default schematic background loads; tap an
  empty area to drop a place pin; tap a contact pin to open their chat.
  Optionally upload an image background (≤8 MB, PNG/JPG/GIF/WebP) and confirm
  pins stay anchored across zoom levels (1×–5×).
- [ ] **Private polling** — *(only if your ST build exposes
  `generateQuietPrompt`, 1.12.10+)* — enable **Private hybrid texts** in
  in-phone Settings, click **Check Messages** in Command-X. Either an `[sms]`
  block lands in the inbox or no reply is delivered (both are valid — it is
  the LLM's call whether anyone would text you right now).

---

## O. Tagging the release

- [ ] Every box above is checked.
- [ ] `node --test test/*.mjs` is green (the automated suite is not part of
  this manual checklist but should be green on the same commit).
- [ ] `manifest.json` `version` matches the tag you are about to cut.
- [ ] `AGENT_MEMORY.md` has an entry for the release sweep.

When all of the above are true, tag and push.

---

## Notes on this file

- Update this checklist whenever a step's wording stops matching the shipping
  UI or stops reflecting reality on disk. The file is canonical; do **not**
  duplicate the steps inline in the plan.
- Permission tiers, tool names, button labels, and file paths quoted above
  are pinned to v0.13.0 source. If you bump `manifest.json#version`, refresh
  the version string in §0 and §A.
