# Agent Memory

> **READ THIS FILE FIRST.** Before starting any work in this repository —
> exploring, planning, coding, reviewing, or opening a pull request — read this
> file top to bottom. It is the canonical, append-only record of context,
> decisions, gotchas, and conventions discovered while working on Command-X.
>
> **UPDATE THIS FILE AT THE END OF EVERY PULL REQUEST.** Before you mark a PR
> ready for review (or push the final commit of a PR), add a new entry under
> [History](#history) capturing anything a future agent would benefit from
> knowing: non-obvious decisions, tricky bugs, architectural discoveries,
> surprising test behavior, undocumented conventions, new pitfalls, or changes
> to the build/test/release workflow.
>
> Treat this file as shared memory across agents and sessions. If you learn
> something that isn't already here and would have saved you time, it belongs
> here.

---

## How to Use This File

### Before starting work
1. Read this entire file. Pay special attention to [Standing Notes](#standing-notes)
   and the most recent entries in [History](#history).
2. Cross-reference anything relevant to your task. If an entry contradicts the
   problem statement, surface it to the user rather than silently overriding.
3. If this file is empty (no History entries yet), that is expected on the
   first PRs — just proceed and add the first entry when you're done.

### Before opening / finalizing a pull request
1. Add a new entry at the **top** of the [History](#history) section using the
   template below. Newest entries first.
2. Only record information that is **useful to a future agent**. Skip trivia,
   skip restating the PR description, skip things already covered in
   `README.md`, `CLAUDE.md`, or `.github/copilot-instructions.md`.
3. If a discovery is broadly applicable (not tied to one PR), also promote it
   into [Standing Notes](#standing-notes) so it is easy to find.
4. Keep entries concise — a few bullets is usually enough. Link to files with
   relative paths and to PRs / commits by number / SHA when helpful.
5. Commit the update to this file as part of the same PR.

### Entry template

```markdown
### YYYY-MM-DD — <short title> (PR #<num> or commit <sha>)

**Context:** one-line summary of what the PR changed or investigated.

**Notes for future agents:**
- Non-obvious fact, decision, or gotcha #1
- Non-obvious fact, decision, or gotcha #2
- …

**Follow-ups / open questions (optional):**
- Anything deferred or worth revisiting
```

---

## Standing Notes

_Long-lived facts that apply to most work in this repo. Promote entries here
from History when they prove broadly useful. Keep this section tight — if it
grows large, consider moving detail into `CLAUDE.md` or `docs/`._

- This repo has **no build step, no linter config, and no CI**. Validation is
  manual (reload SillyTavern, watch console) plus `node --test test/helpers.test.mjs`.
- All extension logic is in a single file: `index.js`. Do not split it.
- See `CLAUDE.md` and `.github/copilot-instructions.md` for the deeper
  architecture / conventions reference — those are the primary technical docs.
  This file is for **learned context** that doesn't belong in either of them.

---

## History

_Newest entries first. Append a new entry here at the end of every PR._

<!-- Add new entries above this line using the template in "How to Use This File". -->

### 2026-04-22 — `copilot/overhaul-openclaw-app` · Overhauled OpenClaw → Overseer agent (v0.13.0)

**What changed:**
- Renamed the `openclaw` app → **`overseer`** everywhere (IDs, CSS classes, element IDs, app id, home icon, navbar label, view name, data-app key). New icon is 👁️.
- Removed the `/api/plugins/openclaw-bridge` HTTP dependency entirely (`OPENCLAW_API_BASE`, `callOpenClawBridge`, `checkOpenClawHealth`, `refreshOpenClawSessionStatus` all gone).
- Overseer now talks to its **own SillyTavern Connection Profile** via `ctx.generateQuietPrompt()` under a new `withOverseerProfile()` helper, which delegates to a shared `runWithConnectionProfile()` helper. `withUtilityProfile()` was refactored to delegate to the same helper, so both share a **single module-wide `connectionProfileQueue`** — they cannot race each other on the global ST profile.
- Added a new `overseer` conversation UI: chat-style user↔agent bubbles, persisted per-chat in `chatMetadata[EXT].overseer.conversation[]` (cap 200).
- Registered native ST function-calling tools via `ctx.registerFunctionTool` with a `shouldRegister` gate (`settings.enabled && settings.overseerToolsEnabled && currentApp === 'overseer'`): `overseer_get_recent_messages`, `overseer_list_contacts`, `overseer_list_quests`, `overseer_list_places`, `overseer_list_characters`, `overseer_run_slash`.
- Kept the `[command-x-operate]` envelope loop (renamed `parseOverseerOperateEnvelope`) as the fallback path for models without native tool calling — still uses Approve/Reject cards and `executeSlashCommandsWithOptions`.
- New settings: `overseerMode`, `overseerConnectionProfile`, `overseerToolsEnabled`. Legacy `openclawMode` is mirrored from `overseerMode` for forward/backward compatibility. Legacy `chatMetadata[EXT].openclaw` auto-migrates to `.overseer` on first read.
- Updated `manifest.json` version `0.12.0` → `0.13.0` and rewrote the description.
- Updated `README.md`, `CLAUDE.md`, `.github/copilot-instructions.md` for the rename + new architecture.
- Added 6 new test cases for `parseOverseerOperateEnvelope` in `test/helpers.test.mjs` (72 tests total, all passing).

**Non-obvious facts / gotchas:**
- `escapeHtml()` was introduced in the new Overseer block; the repo already had distinct `escHtml()` and `escAttr()` helpers around line 3073 used by other renderers. Don't consolidate them — `escapeHtml()` only escapes characters, while `escHtml()` also converts `\n` → `<br>`. The Overseer conversation renderer intentionally does not replace newlines because it relies on CSS `white-space: pre-wrap`.
- Function-calling tools are registered **once per page load** via `registerOverseerTools()`. They are not re-registered on settings change; the `shouldRegister` gate is re-evaluated by ST each turn, so toggling `overseerToolsEnabled` works without a reload.
- `withOverseerProfile()` and `withUtilityProfile()` both delegate to `runWithConnectionProfile()`, which uses a single module-wide serialization queue (`connectionProfileQueue`). This is intentional: both swap the same global ST profile, and separate queues would let them race and restore each other's "previous" profile. Quest enrichment, auto-poll, contact scan, and Overseer turns therefore all serialize against each other when a profile switch is involved.
- `overseerToolsEnabled` **defaults to `false`** (opt-in) because the `overseer_run_slash` tool can execute arbitrary ST slash commands with no approval UI in between. The `shouldRegister` gate compares `=== true` so undefined/missing values never accidentally turn it on.
- The Overseer view's Connection Profile `<select>` exists in **two** places: inline in the ST side panel (`#cx_ext_overseer_profile`) and inside the phone's Overseer app (`#cx-ovr-profile`). Both write to `settings.overseerConnectionProfile` and both are rehydrated in `loadSettings()`.
- Legacy `openclawMode` setting is kept in `DEFAULTS` and mirrored from `overseerMode` in both `loadSettings()` and `saveSettings()`. Safe to remove once users are past v0.13.

**Follow-ups / open questions:**
- **PR-2 (MCP filesystem integration):** Vendor (or require as prerequisite) `bmen25124/SillyTavern-MCP-Client` + `SillyTavern-MCP-Server`, wire `@modelcontextprotocol/server-filesystem` scoped to the ST install, then register `overseer_read_file` / `overseer_write_file` / `overseer_list_directory` tools behind an explicit per-chat allow-list + per-tool policy (`auto`/`confirm`/`deny`) with a destructive-action diff preview. Add an audit log pane that reuses the existing `#cx-ovr-log`.
- Consider exposing `overseer_send_as_system` / `overseer_send_as_user` as write-back tools so the agent can inject messages into the current ST chat (currently it can only read and run slashes).
- Consider a streaming variant of `sendToOverseer()` — `generateQuietPrompt()` is synchronous/awaited here, so long replies show up as a single bubble after the full generation completes.

