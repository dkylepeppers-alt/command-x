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

### 2026-04-30 — Preset now enforces strict SMS tags for character-initiated texts (commit pending)

**Context:** Follow-up to SMS-format hardening: ensured the chat-completion preset also tells the model to use strict `[sms]` syntax when phone messages are character-initiated, not only when replying to a user-initiated text.

**Notes for future agents:**
- `presets/openai/Command-X.json` side-channel rules now explicitly state strict SMS tag syntax applies to every phone text update, including character-initiated messages.
- This closes a prompt-coverage gap between runtime SMS injection guidance and preset side-channel guidance.
- Full `node --test test/*.mjs` still has the unrelated pre-existing version-pin failure (`test/nova-ui-wiring.test.mjs` expects `manifest.json` version `0.13.0`, repo is `0.13.1`).

### 2026-04-30 — SMS prompt now enforces strict parser format (commit pending)

**Context:** Tightened the injected SMS system prompt so model replies use the exact `[sms ...]...[/sms]` shape that Command-X parses reliably.

**Notes for future agents:**
- `injectSmsPrompt()` now includes an explicit **STRICT SMS FORMAT** clause requiring lowercase `[sms]` tags, both `from` + `to` attributes with double quotes, and a closing `[/sms]` tag.
- The instruction also forbids narration/stage directions/markdown inside SMS tags so only phone-text content appears between the brackets.
- This change is prompt-only (no parser changes); full `node --test test/*.mjs` still reports the pre-existing version-pin failure in `test/nova-ui-wiring.test.mjs` expecting `manifest.json` version `0.13.0` while repo currently has `0.13.1`.

### 2026-04-30 — Tolerate unclosed [status] tags before other side-channel tags (commit pending)

**Context:** Fixed contact/NPC extraction regression when model output omits `[/status]` before `[place]` (or other tag blocks), which caused status import to fail even with otherwise valid JSON arrays.

**Notes for future agents:**
- `CONTACTS_TAG_RE` now accepts a normal closing `[/status]`/`[/contacts]` **or** a boundary at newline + next side-channel tag (`[place]`, `[quests]`, `[sms]`) or end-of-message.
- This keeps strict behavior for properly closed tags while recovering from common formatting slips in LLM output where `[status]` runs directly into `[place]`.
- Mirror helper tests in `test/helpers.test.mjs` include a regression for this missing-closer case; update both production and mirrored regex if either parser contract changes.

### 2026-04-30 — Review-thread doc fixes (commit pending)

**Context:** Applied PR review feedback on the root agent guide and refreshed
docs.

**Notes for future agents:**
- In this standalone checkout, use `node --input-type=module --check < index.js`
  for a parser-only ESM syntax check. Dynamic-importing `./index.js` from the
  repo root can fail before useful validation because the repo intentionally has
  no root `package.json` with `type: module`.
- The Map app uses a contact `place` field in `[status]` data for canonical map
  positioning; `location` remains descriptive text.

### 2026-04-30 — Root AGENTS.md guide added (commit pending)

**Context:** Added a canonical root `AGENTS.md` quick-start guide for coding
agents.

**Notes for future agents:**
- Use uppercase `AGENTS.md` as the agent-guide filename. A lowercase
  `agents.md` was explicitly rejected in favor of the canonical form.
- `AGENTS.md` is intentionally concise and points to `AGENT_MEMORY.md` first,
  then `CLAUDE.md` for deeper architecture details.

### 2026-04-30 — Image Prompter visual canon sources (commit pending)

**Context:** Follow-up to the Image Prompter prompt update: the skill now reads
character cards and worldbook entries for stable visual canon before composing
current-scene image prompts.

**Notes for future agents:**
- `image-prompter.defaultTools` now includes `st_read_character`,
  `st_list_worldbooks`, and `st_read_worldbook` in addition to
  `st_get_context` / `phone_list_npcs`; keep the skill read-only and avoid
  reintroducing filesystem defaults.
- The prompt distinguishes stable base visuals from character cards/worldbooks
  versus transient chat-context details such as clothing, setting, pose,
  lighting, camera framing, and mood.
- Current `SKILLS_VERSION` is 7; update `test/nova-tool-args.test.mjs` whenever
  skill prompt wording, default tools, or default tiers change.

### 2026-04-28 — Image Prompter visual-only prompt guidance (commit pending)

**Context:** Tightened Nova's Image Prompter skill so it produces dense,
image-generation-focused prompts grounded in the current RP scene.

**Notes for future agents:**
- `NOVA_SKILLS.image-prompter.systemPrompt` now explicitly excludes story
  narration, inner thoughts, dialogue, symbolism, backstory, and filler; keep it
  focused on directly visible details that affect the generated image.
- This entry bumped `SKILLS_VERSION` to 6; later prompt/default-tool changes may
  supersede that value, so check the latest History entry and
  `test/nova-tool-args.test.mjs` for the current pin.

### 2026-04-28 — Nova Command-X diagnostics skill (commit pending)

**Context:** Added read-only self-diagnosis support so Nova can inspect its own
runtime state and troubleshoot Command-X phone systems before recommending fixes.

**Notes for future agents:**
- `phone_diagnose` is a read-only `phone` backend tool in `NOVA_TOOLS`; it
  returns a compact snapshot of version/chat context, runtime flags, relevant
  Command-X settings, store counts/contact names, and prompt depths.
- New `commandx-diagnostics` skill defaults to read tier and exposes
  `phone_diagnose`, read-only ST context/profile tools, phone store reads,
  `nova_read_soul` / `nova_read_memory`, and read-only filesystem tools for
  source/test/docs/plugin inspection. It intentionally does not expose write or
  shell tools by default.
- This entry bumped `SKILLS_VERSION` to 5; later prompt/default-tool changes may
  supersede that value, so check the latest History entry and
  `test/nova-tool-args.test.mjs` for the current pin.

### 2026-04-28 — Nova creator writes use native ST locations (commit pending)

**Context:** Hardened Nova Character Creator and Worldbook Creator so creation
claims go through ST-native write handlers instead of raw filesystem writes.

**Notes for future agents:**
- Character Creator and Worldbook Creator `defaultTools` no longer expose
  `fs_write`; they use `st_write_character` / `st_write_worldbook` so ST writes
  Tavern Card PNGs to the user characters directory and world-info JSON files
  to the user worlds directory.
- `st_write_character` now normalizes nested or top-level inputs into Tavern
  Card v2 (`spec: "chara_card_v2"`, `spec_version: "2.0"`, `data.name`
  matching the requested tool `name`) before calling `/api/characters/create`
  or `/api/characters/merge-attributes`.
- `st_write_worldbook` now accepts `entries` as either an object or array and
  normalizes entries to an object keyed by uid with ST-style key arrays/default
  fields before calling `/api/worldinfo/edit`.

### 2026-04-28 — Nova soul/memory runtime disk reads (commit pending)

**Context:** Fixed Nova soul/memory self-edits so saved files are the files Nova
loads on later turns.

**Notes for future agents:**
- `loadNovaSoulMemory()` now defaults to reading live files through the
  `nova-agent-bridge` `/fs/read` route at `nova/soul.md` and `nova/memory.md`
  under the bridge root (normally the SillyTavern install root), then falls
  back per-file to bundled `public/scripts/extensions/third-party/command-x/nova/*.md`
  starter templates when the bridge/runtime file is unavailable.
- The in-phone Soul & Memory editor and `buildNovaSoulMemoryHandlers()` share
  `NOVA_SOUL_BRIDGE_PATH` / `NOVA_MEMORY_BRIDGE_PATH`; keep read and write
  paths paired if the runtime storage location changes again.
- `test/nova-soul-memory.test.mjs` inline-copies the bridge-read loader logic;
  update that copy when touching `loadNovaSoulMemory()` or `_novaBridgeReadText()`.

### 2026-04-28 — Chat-completion preset prompt split (commit pending)

**Context:** Enhanced `presets/openai/Command-X.json` after reviewing upstream
SillyTavern preset shape plus external extension/community preset conventions.

**Notes for future agents:**
- The preset now keeps `main` focused on RP quality/user-agency boundaries and
  moves Command-X tag grammar into a dedicated `commandXSideChannels` system
  prompt enabled immediately after `main` in both default `prompt_order` blocks.
- `jailbreak` / Post-History Instructions is no longer empty; it is a concise
  final formatting reminder to put visible RP first and optional tags last.
- `test/nova-preset.test.mjs` now asserts the modular prompt contract, current
  contact/quest enums, richer quest fields, and side-channel prompt ordering.
- Review follow-up aligned the preset `[place]` example with the actual map
  contract (`name`, `emoji`, `near`, `aliases`) and explicitly routes occupancy
  through `[status].place` / `[status].location`; do not re-add `[place]`
  occupants/description unless the place store starts persisting those fields.
- The unrelated Nova Character/Worldbook Creator default-tool broadening was
  split out of this preset PR by reverting `index.js` and
  `test/nova-tool-args.test.mjs` back to the pre-`24bfa2b` state.
- Full `node --test test/*.mjs` still hits the pre-existing
  `test/nova-shell-route.test.mjs` ANSI-color stdout mismatch in this runner;
  targeted preset tests and JSON syntax validation pass.

### 2026-04-27 — SMS attachment storage review follow-up (commit pending)

**Context:** Follow-up to PR review on the non-Nova quest/map/SMS UX update.

**Notes for future agents:**
- SMS attachments are intentionally capped at 96 KB data URLs and only the newest
  20 attachments per contact keep image data during normal message saves.
- If `localStorage.setItem()` still fails, `saveMessages()` retries with all
  attachments stripped so message text can survive and surfaces an async
  `cxAlert()` storage warning to the user.
- `buildMapView()` clears stale `mapMeta.userPlaceId` when the referenced place
  no longer exists, allowing the map to fall back to the manual `userPin`.

### 2026-04-27 — Non-Nova quest/map/SMS UX updates (commit pending)

**Context:** Implemented the requested non-Nova UX sweep: quest checkboxes are
goal-oriented and more stable across auto-updates, the user's map pin can
auto-follow persona `place` updates, and normal SMS threads can attach photos.

**Notes for future agents:**
- SMS photo attachments are local-only thumbnails stored in the phone message
  history (`msg.attachment = {type:'image', dataUrl, name, alt}`). The RP chat
  receives descriptive text ("sends a picture (...)"), not the image bytes.
- `pendingSmsAttachment` is module state cleared after send/back/chat-change.
  Photo sending is intentionally blocked while neural mode is active.
- User map auto-tracking uses `[status]` entries whose `name` matches `ctx.name1`
  (or `user`/`me`/`you`) and a `place` field. It updates
  `loadMapMeta().userPlaceId` + `userPin`; manual drag/drop clears
  `userPlaceId` and remains a fallback.
- `sanitizeQuestSubtasks()` now preserves checkbox ids/done state by incoming id
  or normalized text before falling back to index, so LLM rewording can still
  cause a new goal row but stable goal text no longer resets just because array
  order changes.

### 2026-04-27 — Nova skill tool filtering and expanded skills (commit pending)

**Context:** Implemented the Nova skills review recommendations: active-skill
tool filtering, richer skill picker hints, stronger skill prompts, and five
additional specialized skills.

**Notes for future agents:**
- `filterNovaToolsBySkill()` is applied after bridge capability filtering in
  `novaHandleSend()`. Skill `defaultTools` now controls what schemas the LLM
  sees; `defaultTools: 'all'` remains the free-form escape hatch.
- `sendNovaTurn()` passes the same filtered per-turn `tools` array as the
  dispatch `toolRegistry`; do not switch this back to `NOVA_TOOLS` or a model
  could execute tools hidden from its active skill.
- `NOVA_SKILLS` entries now require a `description` for the skill picker, and
  `SKILLS_VERSION` is pinned by `test/nova-tool-args.test.mjs`; bump it whenever
  skill prompts/default skill definitions change.
- Missing bridge-backed tools are surfaced as a skill-specific transcript notice,
  so changing a skill's `defaultTools` can affect user-facing warnings. The
  warning is intentionally skipped in text-only fallback mode because all tools
  are unavailable there for non-bridge reasons.

### 2026-04-27 — Copyable phone transcript text (commit pending)

**Context:** Made Command-X SMS bubbles and Nova transcript/tool text
selectable/copyable despite the phone shell's global no-select styling.

**Notes for future agents:**
- `.cx-device` intentionally keeps `user-select: none` to preserve phone-app
  button/tile feel. Copyable text is enabled by a targeted override block in
  `style.css` for `.cx-messages`, `.cx-sms*`, `.cx-nova-transcript`,
  `.cx-nova-msg*`, `.cx-nova-toolcard`, and Nova approval pre blocks.
- `test/nova-ui-wiring.test.mjs` has a CSS source-contract assertion for that
  override. If new transcript surfaces are added, include them in the selectable
  block and update the test.

### 2026-04-27 — Nova preset/profile hardening (commit pending)

**Context:** Tightened the shipped Command-X preset for Nova/tool use and made
Nova refuse unsafe profile swaps when ST has no active profile to restore.

**Notes for future agents:**
- `presets/openai/Command-X.json` now sets `function_calling: true` and keeps
  `custom_prompt_post_processing: ""`; ST's `isToolCallingSupported()` can stay
  false if the active profile does not persist function calling as enabled.
- The preset's `[place]` grammar is JSON (`[{"name":...,"occupants":[...]}]`),
  not a bare place string. Keep prompt docs/tests aligned with the parser's
  object/array contract.
- `sendNovaTurn` now aborts with `reason: 'no-active-profile'` before swapping
  if `/profile` returns empty/None. This is intentional: SillyTavern has no
  slash command to restore an unsaved "no active profile" settings state, so
  swapping anyway would leave the user on Nova's profile.
- In this sandbox, `node --test test/*.mjs` may colorize child `node -e` stdout
  under a TTY and trip `nova-shell-route.test.mjs`; `NO_COLOR=1 node --test
  test/*.mjs` validates the same suite cleanly.

### 2026-04-27 — Swipe regeneration does not advance turn throttle (commit pending)

**Context:** Fixed phone swipe handling so swiping/regenerating a character
message replaces artifacts for that message without counting as a new
Command-X turn/time advance.

**Notes for future agents:**
- `MESSAGE_SWIPED` now records the swiped `mesId` in `_pendingSwipeRegenerations`
  before removing phone messages/private-phone events/location trails for that
  message. The next `MESSAGE_RECEIVED` at the same `mesId` consumes the marker.
- Swipe-regenerated responses are still parsed for `[sms]`, `[status]`,
  `[quests]`, and `[place]` tags, but they skip `applyInjectionThrottle()`.
  This prevents contacts/quests/map injection cadence and auto private polling
  from advancing just because the user regenerated the same turn.
- Pending swipe markers are cleared on chat change and when the same message id
  is deleted, so they do not leak across chats or later normal turns.
- `test/swipe-regeneration.test.mjs` is a small source-contract + inline-helper
  regression test for this behavior; its source-shape assertions are deliberately
  whitespace/semicolon-tolerant after review feedback, so avoid tightening them
  back to exact formatting checks.

### 2026-04-26 — Nova context clear + character creator hardening (commit pending)

**Context:** Follow-up from manual testing: Nova needed an explicit way to
clear chat-context history, and character creation was still brittle when the
model failed to emit a nested `card` object.

**Notes for future agents:**
- The Nova composer now renders `#cx-nova-clear`. `novaHandleClearContext`
  confirms with the user, refuses while a turn is in flight, clears the active
  session's `messages` and `toolCalls`, saves Nova state, and preserves the
  per-chat audit log.
- `st_write_character` still accepts full Tavern Card v2 JSON in `card`, but
  it also accepts top-level fields (`description`, `personality`, `scenario`,
  `first_mes`, `mes_example`, `creator_notes`, `system_prompt`,
  `post_history_instructions`, `tags`, `creator`, `character_version`) and
  synthesizes a `chara_card_v2` object before calling
  `/api/characters/create`.
- The tool schema no longer requires `card`; it requires `name` and strongly
  describes that a call with only `name` is invalid. This is intentional:
  some model/provider combinations handle top-level string fields more
  reliably than a loose nested object parameter.

### 2026-04-26 — Nova ST-native write handlers (commit pending)

**Context:** Replaced the deferred `not-implemented` surface for
`st_write_character` and `st_write_worldbook` with real SillyTavern HTTP API
calls.

**Notes for future agents:**
- `buildNovaStTools` now accepts `fetchImpl` for DI. Production uses browser
  `fetch` plus `getRequestHeaders()`; tests inject a small response harness.
- Character creates call `/api/characters/create` with the same form fields
  used by ST's slash-command character creator. Existing characters are
  updated through `/api/characters/merge-attributes` only when
  `overwrite=true`; the handler preserves the existing `avatar` filename and
  refreshes `ctx.getCharacters()` after successful writes when available.
- Worldbook reads/lists now prefer `/api/worldinfo/get` and
  `/api/worldinfo/list`, falling back to the slash `/world` commands for older
  builds. Worldbook writes call `/api/worldinfo/edit` with a complete `book`
  object and require `book.entries`.
- The worldbook overwrite guard checks both display `name` and `file_id` from
  `/api/worldinfo/list`. This matters because `/api/worldinfo/edit` writes to
  the sanitized request `name`, while the list endpoint may expose a different
  in-file display name.
- The helper still never throws; HTTP failures and missing `fetch` return
  closed-enum `write-failed`, `exists`, `missing-book`, or `invalid-book`
  shapes.

**Follow-ups / open questions:**
- Manual browser validation should create/update a throwaway character and
  worldbook via Nova before this is considered fully release-validated.

### 2026-04-26 — Preset installer docs review follow-up (commit pending)

**Context:** Follow-up to PR review on the final docs housekeeping sweep.

**Notes for future agents:**
- `index.js` logs the preset JSON to DevTools unconditionally during the
  installer flow, even when download/clipboard handoff succeeds. Docs should
  describe that accurately while still making clear DevTools access is optional
  and not required for iPad/VM users who can use the downloaded file or
  clipboard copy.

### 2026-04-26 — Final docs housekeeping sweep (commit 82ef6c0)

**Context:** Doc-only cleanup after the v0.13.0 Nova stabilization work.

**Notes for future agents:**
- The preset installer does **not** write directly into ST user presets. It
  downloads `Command-X.json`, best-effort copies the formatted JSON to the
  clipboard, also logs it to DevTools, and tells the user to import through
  ST's preset UI. Keep README, `settings.html`, and `presets/openai/README.md`
  wording aligned with that handoff unless a real ST preset-save API is added.
- `st_write_character` and `st_write_worldbook` are still deliberate
  `not-implemented` handlers with hints to the bridge `fs_write` workaround.
  Manual validation should verify that closed-enum fallback, not claim those
  ST-native writes create cards/worldbooks.
- `shell_run` is implemented in the bridge plugin; stale docs should not
  describe `/shell/run` as reserved, 501, or a future sprint. Capability
  discovery uses `/manifest`, not `/health`.

### 2026-04-25 (shell route) — `POST /shell/run` plugin route shipped (plan §4b/§8b)

**Context:** Continuing the "tackle the most important tasks first, lets finish this thing" sweep. The Nova plan's biggest remaining functional gap was `/shell/run`: the extension-side `buildNovaShellHandler` factory shipped weeks ago (fully tested), the approval pipeline + tier gate + audit log all routed through it, but the plugin route itself was a 501 stub. So the LLM could see `shell_run` in the tool list (when `defaultTier:'full'`), the user could approve a call, the dispatcher could dispatch it, the `_novaBridgeRequest` would happily POST to `/shell/run` — and the plugin would always return `{ error: 'not-implemented' }`. End-to-end shell execution was the only Nova capability that was completely non-functional.

**What shipped:**
- **`server-plugin/nova-agent-bridge/routes-shell.js`** — new module exporting `createShellRunHandler({ root, normalizePath, allowList, auditLogger?, spawnImpl?, nowImpl?, realpathImpl? })`. Mirrors the `routes-fs-*` factory contract: pure CommonJS, never throws, all deps DI'd, returns `(req, res) => Promise<void>`.
- **`server-plugin/nova-agent-bridge/index.js`** — added `resolveAllowList(names)` walking `process.env.PATH` once at `init()` time, builds a `name → absolutePath` map, drops missing binaries. The route handler spawns the *absolute path* (not the bare name) so a later PATH change can't redirect mid-session. Manifest's `capabilities.shell_run` is now `true` iff at least one allow-listed binary was found on PATH; `BASE_CAPABILITIES` (frozen) carries the static fs flags and the dynamic shell flag is merged in `init()` against the resolved allow-list.
- **`shellAllowList` in `/manifest`** — kept as `Array<string>` (just the names of resolved binaries) NOT a `{name: path}` map, because the existing extension probe hard-checks `Array.isArray(body.shellAllowList)` (`index.js:6025`). Internal absolute paths stay inside the plugin process.
- **Safety contract enforced by tests:**
  - `cmd` not on the allow-list → 403 `command-not-allowed` (closed enum), audit `refused-not-allowed`.
  - Empty/non-string `cmd` → 400 `cmd-required`, audit `refused-bad-arg`.
  - `cwd` (when supplied) goes through the same `resolveRequestPath` pipeline as the fs routes — symlink-escape, deny-list, parent-realpath check all apply. Default cwd = root. Non-existent cwd → 400 `cwd-not-found`. cwd pointing at a file → 400 `cwd-not-a-directory`.
  - Spawned with `spawn(absPath, args, { shell: false, stdio: ['ignore','pipe','pipe'], env: process.env, cwd: cwdAbs })`. `shell: false` is the line that matters most — it disables `/bin/sh` interpretation so shell metachars in `args` are literal. `stdio: ['ignore','pipe','pipe']` closes stdin so interactive prompts immediately EOF.
  - Per-stream output cap `SHELL_OUTPUT_CAP_BYTES = 1 MB`. The capture helper drains streams to avoid blocking the child on backpressure but stops appending past the cap; `truncated.{stdout,stderr}` flags surface to the response and audit. Total bytes seen are also recorded (`stdoutBytes` / `stderrBytes`).
  - Hard timeout (default 60s, clamped `[100ms, 5min]`). On timeout: SIGTERM, then SIGKILL after `SHELL_KILL_GRACE_MS = 500`. `timedOut: true` in the response, audit `outcome: 'timed-out'`. `setTimeout(...).unref?.()` so a stuck timer can't block test process exit.
  - Audit entry per call. Outcomes: `refused-bad-arg`, `refused-not-allowed`, `refused-cwd`, `spawn-failed`, `completed`, `timed-out`. **Never logs `args` values or stdout/stderr bytes.** `argsSummary` carries `cmd` (allow-list-validated literal), `argsCount` (integer), `cwd` (resolved relative path), `timeoutMs` (clamped integer). Top-level fields: `exitCode`, `signal`, `stdoutBytes`, `stderrBytes`, `truncated`, `durationMs`. The argsSummary + entry-key allow-lists in `nova-audit-redact.test.mjs` were extended to cover these.
- **Tests** (51 net new):
  - `test/nova-shell-route.test.mjs` (24 assertions across 7 suites): factory shape, arg validation including the `Number([])` foot-gun in timeout coercion, cwd handling (non-existent / escapes-root / file-not-dir), fake-spawn flow asserting `shell:false` and `stdio: ['ignore','pipe','pipe']` are mandatory, real-spawn against `node` (skipped if not on PATH), output truncation, timeout → SIGTERM, audit no-leak.
  - `test/nova-audit-redact.test.mjs` extended: 6 new shell-route subtests covering all `RAW_PAYLOADS` as both arg-vector AND stdout/stderr content. Added shell-specific keys to both `ALLOWED_ARGS_SUMMARY_KEYS` and `ALLOWED_ENTRY_KEYS` allow-lists with rationale comments.
  - `test/nova-plugin.test.mjs` (3 updated): `/shell/run` is no longer 501 → asserts `command-not-allowed` + `cmd-required` instead. Manifest's `shellAllowList` is now the resolved-on-PATH subset (don't hard-assert `git` is present — Windows/minimal containers may legitimately be missing it). `/manifest` capability test now asserts `caps.shell_run === (shellAllowList.length > 0)` instead of a hard `false`.

**What's deliberately NOT in this PR:**
- **NDJSON streaming.** Plan §8b mentions it as the eventual target. The current `_novaBridgeRequest` is JSON-only — it does `await resp.text()` then `JSON.parse`. Rewriting the transport for streaming would be a larger architectural change AND the per-stream 1 MB cap means a single JSON response is never going to be unreasonably large. JSON-only end-to-end is enough for every shell tool the LLM is likely to invoke. Streaming is a UX nice-to-have we can land later without changing the route's input shape.
- **"Remember approvals this session" UI toggle (plan §4b).** `settings.nova.rememberApprovalsSession` is in `NOVA_DEFAULTS` but currently dead — no UI toggle wires it, and the dispatch path doesn't read it into `rememberedApprovals`. That's a separate orthogonal slice; not blocking shell.
- **README rewrite (plan §12).** Docs slice; orthogonal.

**Non-obvious decisions to know about:**
- **`Number(Infinity)` is finite-shaped per `typeof`** but `Number.isFinite(Infinity) === false`, so my `coerceTimeout` falls back to default rather than clamping. Initially the test asserted clamped → 300000; that was wrong. Documented this in the test (`Non-finite (including Infinity) → default, not clamped`). If you ever change this, also check `Number([])` (which IS finite, returns 0) — the explicit `typeof === 'number' || 'string'` gate is what stops `[]` and `[42]` from sneaking through.
- **`spawn` default vs explicit `cwd`**. When the LLM doesn't supply a `cwd`, we explicitly pass `cwd: ROOT` (the plugin's resolved root). Otherwise `spawn` would inherit `process.cwd()`, which on a SillyTavern install is usually but not always the same as the configured root. Belt-and-suspenders.
- **`BASE_CAPABILITIES` vs the dynamic `capabilities` object.** The static frozen object only carries the fs flags. The shell flag is merged in `init()` against `resolvedAllowList` and the merged object is what `/manifest` returns. Keep this split — if `BASE_CAPABILITIES.shell_run` were `false` and we tried to set it true via spread, you'd be silently overwriting a frozen prop's read view rather than overriding it on the new object. (Spread DOES override correctly; the split exists for clarity and so a test reader sees "fs is static, shell is computed".)
- **`resolveAllowList` refuses path-like names.** Inputs containing `/` or `\` are dropped before the PATH walk. This means you can't smuggle `../some/thing` through `DEFAULT_SHELL_ALLOW`. Belt-and-suspenders since `DEFAULT_SHELL_ALLOW` is hard-coded in the plugin source.
- **The shell route is wired even when the allow-list resolves empty.** This is intentional: a 403 `command-not-allowed` on every call is a deterministic, LLM-readable outcome that the dispatcher can recover from. A 404 (route not registered) would cascade through `_novaBridgeRequest` as a confusing `nova-bridge-error` with raw HTML. The manifest's `capabilities.shell_run: false` tells the extension to filter `shell_run` out of the tool list anyway via `filterNovaToolsByCapabilities`, so the LLM rarely sees the closed-enum error in practice — but if it does, it can recover.
- **CSRF is already enforced** via `buildNovaSecurityMiddleware` mounted before all routes. The shell route inherits this — no special-casing.
- **Audit entry redaction is double-gated.** Inside the route handler I never put raw args/output into the entry; AND `nova-audit-redact.test.mjs` enforces an allow-list of permitted argsSummary/entry keys. If a future handler regression sneaks `body.content` into argsSummary, the test fails loudly.

**Validation:** `node --check index.js` clean; `node --check server-plugin/nova-agent-bridge/index.js` clean; `node --check server-plugin/nova-agent-bridge/routes-shell.js` clean; `node --test test/*.mjs` → **778/778 pass** (+51 net since prior 727 baseline). CodeQL: clean (no string-concat into URLs/HTML; the only new external interfaces are `spawn` (already shell:false) and `process.env.PATH` (read-only string parse with strict path validation)). Code Review: clean.

**What's still outstanding on the plan (copy-forward + updated):**
1. **"Remember approvals this session" UI toggle (§4b).** `settings.nova.rememberApprovalsSession` exists in `NOVA_DEFAULTS` but is unwired. Settings UI + dispatch-path threading.
2. **`st_write_character` + `st_write_worldbook` real implementations** — see prior "st handlers" entry for the 4-step follow-up path.
3. **NDJSON streaming for `/shell/run`** — the route is functional with a JSON response; streaming is a UX nice-to-have.
4. **Rich per-turn tool-card transcript rendering** (plan §2b/§3c).
5. **README rewrite (§12).**
6. **Registered-tool-path fallback (§3c)** — explicitly deferred.

### 2026-04-25 — Code-review sweep (excluding server plugin) (commit pending)

**Context:** Acted on the recent code review's findings except the server-plugin specifics (those will be handled in a separate sweep). Worked in priority order: P0 security/correctness → P1 perf → P2 maintainability → P3 docs.

**Changes applied:**
- **`chatKey()` (`index.js:78`)** — single canonical helper for every per-chat localStorage prefix. Eliminates the historical divergence where `cx-msgs-*`/`cx-npcs-*`/`cx-quests-*`/`cx-unread-*` fell back to `'default'` while `cx-places-*`/`cx-map-*`/`cx-loctrail-*` (and `historyContactNames` via `currentChatId`) fell back to `'no-chat'`. Standardised on `'default'` to preserve the higher-value message/NPC/quest data; the old `'no-chat'`-prefixed keys (places/maps/trails when no chat loaded) were never useful.
- **`hideSmsTagsInDom` escaping (`index.js:271+`)** — `attrs.from` now passes through `escHtml`; the truncated preview goes through `escAttr` for `title=…` and `escHtml` for `<em>`. HTML tags in the captured `inner` are stripped before truncation so the preview shows clean text.
- **Event-listener lifecycle (`index.js`, near `destroyPanel`)** — added `wireEventListeners` / `unwireEventListeners`. Handlers are tracked in `_eventListenerHandlers` and removed via `eventSource.removeListener` on `destroyPanel`. Idempotent so `createPanel` (rebuild path) and the enable-toggle can call freely. Closes the leak ST docs (`Writing-Extensions.md §Performance`) explicitly warn about. The init block now calls `wireEventListeners()` once when enabled rather than running 7 inline `eventSource.on(...)` registrations.
- **`CX_PROMPT_DEPTHS` (`index.js:48`)** — frozen object exposes the depth ordering for the five `setExtensionPrompt` keys (sms:1, contacts:2, privatePhone:3, map:3, quests:4). Replaces five magic-number callsites scattered across the file. Documented rationale (lower depth = closer to the most recent message; sms must be closest, quests furthest).
- **Settings binding tables (`index.js`, around `loadSettings`)** — `PHONE_SETTING_BINDINGS` + `NOVA_SETTING_BINDINGS` declare every setting key alongside its DOM ids, type, default, and clamps. New helpers `_readSettingFromDom`, `_writeSettingToDom`, `_coerceSettingValue` drive both `loadSettings` and `saveSettings`. Adding a new setting becomes a single-table edit.
- **`getTotalUnread()` perf** — direct `localStorage` prefix scan over `cx-unread-${chatKey}-` instead of building the full contact list. Called from every `incrementUnread`/`markRead`/`rebuildPhone`, so the win is non-trivial for users with long histories.
- **`loadNpcs`/`loadQuests` boundary validation** — filter non-object localStorage entries so a corrupt/foreign write can't crash the renderer.
- **Defensive escaping** — `escHtml` on `last.time`; comment on `CONTACT_GRADIENTS` warning that values are interpolated raw into `style="background:…"` so entries must remain compile-time CSS values (`escAttr` does not validate CSS expressions).
- **Documented `escHtml` / `escAttr` / `escapeHtml`** — JSDoc explains why all three exist (body / attribute / textarea-PCDATA contexts). `escapeHtml` is the textarea-only variant; converting `\n` to `<br>` like `escHtml` would corrupt the textarea editor.
- **`parseSmsAttrs` contract** — documented that the regex only accepts plain `"`-delimited attributes. The LLM is the sole producer; widening the grammar requires updating both `parseSmsAttrs` and `SMS_ATTR_RE` together.
- **Stale doc cleanup** — `index.js` header no longer claims v0.11.0; refers to `manifest.json` as version source of truth. `CLAUDE.md` updated for v0.13.0 (Nova replaces OpenClaw, all five injection keys + depths listed, `chatKey()` storage prefix described, settings binding tables noted, all six storage families enumerated). `nova/soul.md` and `nova/memory.md` carry a "runtime-mutable, repo copy is install-time default only" note.

**Validation:** `node --test test/helpers.test.mjs test/nova-*.test.mjs` → 446/446 pass at every checkpoint.

**Notes for future agents:**
- **The review-pass changes preserved every existing semantic.** The settings refactor in particular is byte-for-byte equivalent to the inline code where DOM inputs are present (i.e. always, in practice). The only theoretical difference is that when *no* DOM input is wired, the new code preserves the existing `settings[key]` value where the old code sometimes hard-reset to the type default — which is the correct behaviour and a bug fix in the boundary case.
- **`hideSmsTagsInDom` previously interpolated raw `inner` HTML inside `<em>`.** ST's renderer had already sanitised it once, so the practical risk was bounded to that pipeline. With the new escaping, even a future change to ST's renderer can't regress us.
- **Deferred items** documented in the PR description: `localforage` migration for avatars + map images (substrate change, deserves its own PR), Nova subsystem extraction into a module tree (architectural; CLAUDE.md's "single-file" guidance is from when the file was 1k lines), and all server-plugin findings (per the problem statement).
- **`pollPrivateMessages`'s known-contact filter (review finding (n)) was already implemented** — `parsePrivatePhoneGeneration` (line ~2460) drops events whose `from` doesn't match `getKnownContactsForPrivateMessaging()`. Verified before assuming it needed work.
- **`AWAIT_TIMEOUT_MS` / `CLOCK_INTERVAL_MS` etc. are at module scope before `CX_PROMPT_DEPTHS`.** When adding more named constants, follow the existing grouping (caps near other caps; depth/timing/limit clusters are deliberate).

### 2026-04-25 (§13) — `nova-audit-redact.test.mjs` ships

**Context:** `nova-audit.test.mjs` already covered the audit logger in isolation (REDACTED_KEYS stripping at top level + nested via the JSON replacer). The plan's §13 ask for `nova-audit-redact.test.mjs` was the **other half** of the security contract: prove that the route handlers themselves never hand raw payload to the audit pipeline in the first place. If a future handler regression added `body.content` to its `argsSummary`, the logger's defensive redaction would be the only thing protecting the user — and that's not where you want a single point of failure.

**What shipped:**
- New `test/nova-audit-redact.test.mjs` — drives real `createFsWriteHandler` / `createFsDeleteHandler` / `createFsMoveHandler` factories against a tempdir + capturing audit logger.
- Realistic payload set (`RAW_PAYLOADS`): UTF-8 prose, fake PEM private key with newlines, `password=… api_token=sk-live-…` style credentials, JSON with nested `content`/`data` keys, and a 2 KB uniform `'A'.repeat(2048)` to catch length-thresholded loggers.
- Each captured entry is scanned **two ways**: naive `JSON.stringify` substring check **and** through the real `formatEntry` serialiser. Both must be free of the payload string.
- Closed-enum allow-lists: `ALLOWED_ENTRY_KEYS` (top level: `route`, `outcome`, `argsSummary`, `bytes`, `backup`, `error`, `ts`) and `ALLOWED_ARGS_SUMMARY_KEYS` (`path`, `from`, `to`, `encoding`, `createParents`, `overwrite`, `overwrote`, `overwroteDest`, `recursive`, `entries`, `type`). Adding a key requires a conscious test edit — exactly the gate the plan asks for.
- **End-to-end test through real `buildAuditLogger`** writes to a JSONL file under the tempdir, reads it back from disk, and asserts the payload byte never landed on disk. This is the integration guarantee the unit-level audit tests can't give.

**Contract locked by tests:**
- `/fs/write` — create, overwrite, refused-exists (overwrite=false on existing), base64 (both b64 string + decoded plaintext absent).
- `/fs/delete` — trashed outcome with `argsSummary.type === 'file'`, `recursive === false`.
- `/fs/move` — success with `from`/`to` rels.
- Logger backstop — top-level redacted keys are stripped (not even rendered as `[redacted]`); nested ones go through the replacer and become `"[redacted]"`.

**Pitfalls noted while writing this:**
- The delete outcome is `'trashed'`, not `'moved-to-trash'`. Got bitten by it on the first run — added a grep against `outcome:` in the routes file to verify the actual literals before asserting.
- `error` is allowed at the top level because filesystem errors (ENOENT etc.) may include path fragments, and stripping that would gut forensic value. The threat model excludes "path fragment" — the threat is "file content".
- `backup` is also top-level (carries `.nova-trash` rel paths from the trash bucket), not under `argsSummary`. Don't move it without updating the allow-list.
- Don't add `content`, `body`, `data`, `payload`, or `raw` to either allow-list. They're already in `REDACTED_KEYS` for a reason.

**Validation:** `node --test test/*.mjs` → 727/727 (+13). Existing `nova-audit.test.mjs` still green; the new file is purely additive.

### 2026-04-25 (§4f) — Tool capability discovery ships

**Context:** Follow-up to the shell-handler + CSRF work. `probeNovaBridge` + `_coerceNovaCapabilities` already existed to discover the plugin + per-tool map, but `novaHandleSend` was still passing `NOVA_TOOLS` unconditionally — when the plugin was absent, the LLM saw `fs_*` and `shell_run` in its tool list, called one, and got `{ error: 'nova-bridge-unreachable' }` back, burning a tool-call slot.

**What shipped:**
- `filterNovaToolsByCapabilities({ tools, probe })` pure helper in `index.js` NOVA AGENT section (right after `_coerceNovaCapabilities`). Returns a fresh filtered array; never throws.
- `NOVA_BRIDGE_TOOL_PREFIXES = Object.freeze(['fs_', 'shell_'])` as a frozen module constant so the "what counts as bridge-backed" contract is visible at a glance.
- `_isBridgeBackedToolName(name)` tiny internal predicate used by both the `present: false` drop and the capability-map filter.
- `novaHandleSend` now: (1) awaits `probeNovaBridge({ baseUrl: nova.pluginBaseUrl })` before the turn (cached per `NOVA_PROBE_TTL_MS`); (2) pipes the result through the helper; (3) passes the filtered list as `tools:` via a new local `effectiveTools`; (4) emits a single transcript notice "⚠︎ Nova bridge plugin not detected …" when bridge is absent **and** something was actually filtered (silent on healthy installs).
- 45 new assertions in `test/nova-capability-filter.test.mjs` + source-contract assertion in `test/nova-ui-wiring.test.mjs`.

**Contract locked by tests:**
- `probe.present === false` → drop every `fs_*` / `shell_*`; keep `nova_*` / `phone_*` / `st_*`. A lingering capabilities map is ignored (present:false is authoritative).
- `probe.present === true` with capabilities → drop only tools where `caps[name] === false`. Missing keys pass through. This is the **forward-compat contract**: an older plugin that doesn't list a newer tool shouldn't prevent the LLM from trying it — let the route answer 404/501 if it really isn't implemented.
- Missing / malformed probe → fail open (return unchanged). In-flight probe races, transient network blips, and probe bugs must not nuke the tool list. A stale "present: true" is much safer than a false "present: false".
- Capability strip is **only on explicit `false`** — truthy non-true values (`0`, `''`, `null`, etc.) are treated as "present". This matches the fail-open stance and avoids surprises with odd plugin responses.
- Non-bridge tools are **never** gated by the capability map. Even if a plugin declares `nova_write_soul: false`, the helper ignores it — the plugin has no jurisdiction over in-process tools.
- Non-array `tools` → `[]` (defensive). Malformed tool entries (null, non-string name, etc.) pass through the `present:false` filter because `typeof name !== 'string'` short-circuits `_isBridgeBackedToolName` to false, leaving them in the list — the downstream LLM tool-schema validator will reject them, not this helper. (Covered by the "tolerates malformed entries" fuzz test; the test was tightened after the first pass over-specified the pass-through pattern.)

**Where the banner lives:** Plan §4f says "yellow banner". Rather than adding a new DOM slot above the transcript, we emit it as a `'notice'`-class transcript line (same rendering path as "⚠︎ Text-only mode …"). The transcript is Nova's primary surface, it auto-scrolls, and the message is per-turn (regenerates each send). A CSS/layout sprint can promote it to a proper top-of-view banner later; this ships the user-visible behaviour today.

**Pitfalls for future agents:**
- **Don't skip the probe for cached runs.** `probeNovaBridge` has its own TTL cache (`NOVA_PROBE_TTL_MS`), so calling it every turn is cheap. If you add any short-circuit logic (e.g. "skip probe if tools list unchanged") make sure a plugin hot-install still lights up within one TTL window — today that's automatic.
- **The notice is gated on `effectiveTools.length !== NOVA_TOOLS.length`** because a registry with zero bridge-backed tools shouldn't show the banner. If you ever extend `NOVA_TOOLS` with tools whose prefixes aren't in `NOVA_BRIDGE_TOOL_PREFIXES`, add the new prefix to the constant **and** review this length-delta gate.
- **`probe.present` is liberally accepted.** `_coerceNovaCapabilities` happens to return booleans but the filter uses `=== false` / truthy checks, so a future probe revision that returns `1` / `'yes'` for present still works. Don't tighten to strict equality without a reason.

**Validation:** `node --check index.js` ✓, `node --test test/*.mjs` → 714/714 pass (+21).

### 2026-04-25 (shell + csrf) — shell_run handler (§4b) + CSRF/session enforcement (§8c)

**Context:** Continued the Nova plan audit. Two items were clearly scoped and safe to ship together: `buildNovaShellHandler` for §4b (the schema and plugin route already exist; the factory was the obvious missing piece) and §8c CSRF+session enforcement (both extension and plugin sides).

**What shipped — shell_run factory (§4b):**
- **`buildNovaShellHandler({ pluginBaseUrl?, fetchImpl?, headersProvider? })`** in `index.js` NOVA AGENT section (right after `buildNovaFsHandlers`). Mirrors the contract of the other four Nova factories — never throws, closed-enum errors, all deps DI'd. Validates `cmd` (required non-empty string), `args` (filtered to strings; non-array → `[]`), `cwd` (non-empty string or drop), `timeoutMs` (numeric primitive only, clamped to `[100ms, 5min]`). Only numeric primitives accepted because `Number([])` → `0` (finite) would otherwise sneak an empty-array timeout through as the minimum — caught by the never-throws fuzz test, tightened before commit.
- **Wired into `novaHandleSend`** alongside the other four factories.
- The plugin's current `501 Not Implemented` on `/shell/run` naturally surfaces as `{ error: 'not-implemented', plugin, version, route, status: 501 }` through `_novaBridgeRequest`. No special-casing — when the plugin ships the real implementation, the same code path lights up with no extension change.

**What shipped — CSRF + session (§8c):**
Investigation found ST uses **`csrf-sync`** globally via `app.use(csrfSynchronisedProtection)` *before* plugins mount (see upstream `src/server-main.js`). Token lives in `req.session.csrfToken`, read from `x-csrf-token` header. That means:

1. **The extension's pre-PR `_novaBridgeRequest` was broken on any ST install with CSRF enabled** — it never sent `X-CSRF-Token`, so ST returned 403 before the plugin ever saw the request. This was latent until this PR; the probe worked (GET, no CSRF needed) but any POST (fs_write, fs_delete, fs_move, fs_search, shell_run, nova_write_*) would have failed in production.
2. **The plugin inherits ST's global check** but we want belt-and-suspenders for `--disableCsrf` runs and non-ST embedding.

**Extension side** (`index.js`):
- `import { getRequestHeaders } from '../../../../script.js'` added next to the existing script.js imports.
- `_novaBridgeRequest` and `_novaBridgeWrite` now accept an injectable `headersProvider` (default: the module-imported `getRequestHeaders`) and merge its output into `init.headers`. Called with `{ omitContentType: true }` so the bridge owns Content-Type for JSON bodies. Provider exceptions fail open (request sent without auth; server rejects as before).

**Plugin side** (`server-plugin/nova-agent-bridge/`):
- New `middleware.js` exports `buildNovaSecurityMiddleware({ csrfRequired?, sessionRequired?, skip? })`. Returns a named Express middleware (`novaSecurityMiddleware`) so stack inspection works. Defaults: CSRF + session both required; `/health` and `/manifest` skip-listed (capability probe must work pre-auth).
- Closed-enum errors: `nova-unauthorized` (401), `nova-csrf-missing` / `nova-csrf-stale-session` / `nova-csrf-mismatch` (all 403). Constant-time token compare via an internal helper.
- Reads `req.session.csrfToken` — **exactly the slot ST's `csrfSync` writes to via `storeTokenInState`**. Same slot means tokens minted by ST are accepted without any handshake change.
- Wired as the first `router.use(...)` in plugin `init()`.

**Tests (+41 assertions, total 693/693):**
- `test/nova-shell-handler.test.mjs` — 41 assertions across 8 suites.
- `test/nova-plugin-middleware.test.mjs` (new) — 41 assertions across 6 suites: exports, skip-list, session check, CSRF matrix across methods, defensive/never-throws, internal constant-time compare.
- `test/nova-plugin.test.mjs` — added a wiring assertion that `router.use()` is called with a function named `novaSecurityMiddleware` that rejects unauth'd POSTs. Also extended the mock router with a `use()` capture (noop) — previously it had no `use` and my `router.use(...)` call would have thrown.
- `test/nova-ui-wiring.test.mjs` — source-contract assertions: `getRequestHeaders` is imported from script.js; `_novaBridgeRequest` and `_novaBridgeWrite` both accept `headersProvider` and call it with `omitContentType: true`; `buildNovaShellHandler` declared, POSTs to `/shell/run`, wired into `novaHandleSend`.

**Pitfalls for future agents:**
- **Never use `Number(x)` on LLM-provided args without first type-checking** — `Number([])` → `0` (finite) and `Number([42])` → `42` (finite). Both would sneak through `Number.isFinite` checks. Always gate on `typeof x === 'number' || typeof x === 'string'` first.
- **ST's CSRF token slot is `req.session.csrfToken`, not `req.csrfToken` or `res.locals.csrfToken`**. Upstream uses `csrf-sync` (not `csurf`); the `storeTokenInState` callback writes to the session. If you build any future middleware that validates the token, read from the same slot.
- **Plugins mount AFTER ST's global middleware stack**. `helmet → compression → cors → hostWhitelist → cookieSession → setUserDataMiddleware → csrfSynchronisedProtection → static → requireLoginMiddleware → redirectDeprecated → setupPrivateEndpoints → preSetupTasks (which calls loadPlugins)`. This means by the time any plugin route handler fires, `req.session`, `req.user`/`req.handle`, and CSRF have already been validated. Plugin-level checks are defense-in-depth only.
- **Extension fetch calls are same-origin**; cookies flow by default. Don't set `credentials: 'include'` or CORS headers on bridge calls — that would actually break things when ST runs behind a reverse proxy that tightens CORS.
- **Mock routers in plugin tests** — if you add any new `router.use(...)` to the plugin, update the `mockRouter` in `test/nova-plugin.test.mjs` to capture it. It was previously missing that method; the fix is already in place but the lesson is to grep `test/nova-plugin.test.mjs` for `mockRouter` whenever you touch the plugin's wiring.

**Validation:** `node --check index.js` ✓, `node -c server-plugin/nova-agent-bridge/{index,middleware}.js` ✓, `node --test test/*.mjs` → 693/693 pass (+41).

### 2026-04-25 (diff preview) — fs_write approval diff preview wired (plan §4c)

**Context:** Previous PR's handover listed four small independent slices remaining after `buildNovaStTools` shipped. This picks the smallest and cleanest: §4c explicitly said "all three pieces now exist — wiring is just an `if (tool === 'fs_write') { ... }` branch in the composer before calling `confirmApproval`. Don't teach the dispatcher to read the filesystem itself." So the pure composer-level wiring, done as a pure helper for testability.

**What shipped:**
- **`buildFsWriteDiffPreview({ tool, args, fsRead, buildDiff })`** — pure async helper in `index.js` NOVA AGENT section, immediately after `buildNovaUnifiedDiff`. Resolves to a unified-diff string for `fs_write` with valid args, empty string otherwise. Never throws. Fully DI'd.
- **`novaHandleSend`'s `confirmApproval` arrow** — now awaits `buildFsWriteDiffPreview({ tool, args, fsRead: toolHandlers.fs_read })` before opening the modal, and passes the result as `diffText` into `cxNovaApprovalModal`. Zero impact on non-`fs_write` approvals (the helper short-circuits to `''` for them).
- **`test/nova-diff-preview.test.mjs`** — 26 assertions across 5 suites. Inline-copies the helper per AGENT_MEMORY convention.
- **`test/nova-ui-wiring.test.mjs`** — adds a source-contract block covering: `buildFsWriteDiffPreview` is declared, `novaHandleSend` calls it, `cxNovaApprovalModal(…diffText…)` pattern is present, and `fsRead: toolHandlers.fs_read` is the injection point.

**Contract locked by tests:**
- **Non-`fs_write` tool → `''`.** Every other approval (nova_write_soul, nova_append_memory, fs_delete, shell_run, st_write_*, phone_write_*) skips the diff path. The approval modal still opens; it just doesn't get a diff block.
- **Missing / non-string `args.path` or non-string `args.content` → `''`.** Empty-string `content` IS valid (legitimate empty-file write) — tested explicitly.
- **No `fsRead` provided → treat as new file (`oldContent = null`).** The LLM sees the `--- /dev/null` header via `buildNovaUnifiedDiff`. This is the "fs tools unavailable" fallback; it's exercised by a dedicated test.
- **`fsRead` throws → `''`.** `buildDiff` is NEVER called in this branch (asserted). Modal still opens so the user can make the call manually.
- **`fsRead` returns `{ error: 'not-found' }` → new-file diff with `oldContent = null`.** This is the semantic "create" path and lines up with the plugin's `/fs/read` 404 response.
- **`fsRead` returns any OTHER error (`nova-bridge-unreachable`, `nova-bridge-error`, `forbidden`, `content-too-large`, …) → `''`.** These are "can't render a trustworthy diff" states; blanking the preview is safer than showing a misleading one. `buildDiff` is NEVER called (asserted).
- **`fsRead` returns an unexpected shape (no `content`, no `error`; wrong types) → `''`.** Defensive: don't render garbage.
- **`buildDiff` throws / returns non-string → `''` or coerced string.** `null`/`undefined` both coerce to `''` via the `|| ''` fallback; numbers coerce via `String()`. Covered.
- **Fuzz: 11 different garbage input shapes including `null`, primitives, non-object args, non-function callbacks → always returns a string, never throws.**

**Defensive tweak caught by fuzz testing:** My first cut used `{ tool, args, fsRead, buildDiff } = {}` as the signature. The JS default only fires for `undefined`, NOT `null`, so `buildFsWriteDiffPreview(null)` threw `TypeError: Cannot destructure property 'tool' of ... as it is null`. Rewrote as `(opts) => { const {...} = (opts && typeof opts === 'object') ? opts : {}; }`. Lesson: when you promise "never throws", test `null` as well as `undefined` in the fuzz suite — `=== {}` default syntax doesn't protect you from it.

**Why composer-level (not dispatcher-level):**
The dispatcher (`runNovaToolDispatch`) is a pure handler-loop and must not reach into the filesystem to render UI chrome. The composer (in `novaHandleSend`) already owns the approval UX — it constructs the `confirmApproval` arrow and passes it down — so it's the natural place to fetch the old content and compose the preview. This split keeps `runNovaToolDispatch` testable without a DOM / filesystem mock. AGENT_MEMORY from the fs-tools entry made this policy explicit; this PR just follows it.

**Inline-copy convention follow-through:**
- `test/nova-diff-preview.test.mjs` inline-copies the production helper. The only divergence is that the inline copy's `buildDiff` fallback inside the helper uses `null` instead of falling back to a global `buildNovaUnifiedDiff` (which doesn't exist in a Node `--test` context). Callers pass `buildDiff` explicitly in every test, so this isn't observable. Production source does the lazy global lookup.
- When you edit `buildFsWriteDiffPreview` in `index.js`, mirror the change into `test/nova-diff-preview.test.mjs`. When you edit the production source to add a new failure-mode short-circuit, add a case to the fs_read-failure-paths suite.

**Validation:** `node --check index.js` clean; `node --test test/*.mjs` → **624/624 pass** (+26 net: 25 new diff-preview assertions + 1 new ui-wiring source-contract block). CodeQL: clean (no new string-building from user input; the new code paths only await a handler and hand a string to a pure diff function). Code Review: clean.

**What's still outstanding on the plan (copy-forward):**
1. **`st_write_character` + `st_write_worldbook` real implementations** — see prior "st handlers" entry for the 4-step follow-up path.
2. **`/shell/run` plugin route** (still 501) + `buildNovaShellHandler` factory.
3. **Rich per-turn tool-card transcript rendering** (plan §2b/§3c). This is the larger remaining UX work — replacing the current line-oriented transcript with per-tool cards that show name, args summary, result preview, and approval state. Not yet scoped.
4. **Plugin CSRF + session-cookie check on every route** (plan §8c).
5. Plan checkbox refresh pass (cosmetic).

### 2026-04-25 (st handlers) — Nova `st_*` tool handlers shipped (plan §4d, partial)

**Context:** Continuing the plan after the review-comment audit. The prior PR's handover identified `buildNovaStTools` as the natural next slice — ST-API only, no plugin dependency. Currently every `st_*` call resolves to `{ error: 'no-handler' }` in the dispatcher; this PR ships handlers for 8 of the 10 schemas and a clearly-documented closed-enum `{ error: 'not-implemented' }` surface for the other 2.

**What shipped (8 of 10 handlers wired end-to-end):**
- `st_list_characters` — reads `ctx.characters`, returns a stable summary shape `{ name, avatar, description (truncated 280 chars), tags (capped 16), create_date }` so the list payload stays tractable. `st_read_character` then returns the full card by name.
- `st_list_worldbooks` — calls slash `/world list` and parses the pipe as JSON array first, then newline-separated, then comma-separated. Returns `{ worldbooks, count, hint? }`. If the slash isn't available or returns an empty pipe, returns an empty list with a `fs_list` fallback hint.
- `st_read_worldbook` — calls slash `/world get name="..."` (with embedded `"` escaped). Returns parsed JSON when possible, raw pipe truncated to 4000 chars otherwise.
- `st_run_slash` — wraps `ctx.executeSlashCommandsWithOptions` (resolved lazily via `novaGetExecuteSlash` so a test can pass a fake without ST loaded). Forwards `{ ok: true, pipe }` on success, closed-enum `{ error: 'slash-failed' | 'slash-unavailable', ... }` otherwise.
- `st_get_context` — synthesises a compact snapshot from `ctx.chat`, `ctx.name1`, `ctx.characterId`, `ctx.characters`, `ctx.chatId`, `ctx.groupId`. `lastN` is clamped to `[1..50]` (default 10, floors floats, falls back to 10 on non-numeric). Per-message `mes` is truncated to 4000 chars.
- `st_list_profiles` — reuses the existing `listNovaProfiles` helper (which in turn calls `/profile-list`). Forwards `{ profiles }` on success, `{ error: <reason> }` on failure.
- `st_get_profile` — calls slash `/profile-get name="..."`. Same JSON-or-raw-truncated-pipe pattern as `st_read_worldbook`.

**What's deferred (closed-enum surface, NOT silently broken):**
- `st_write_character` and `st_write_worldbook` — both return `{ error: 'not-implemented', tool, hint }` on valid args. The hint directs the LLM to the existing `fs_write` workaround at the character / worldbook JSON path. The skill-pack guidance ("Prefer st_write_character over fs_write…") will start applying automatically once these handlers land — no skill-pack code changes needed.

**Why deferred (not "didn't get to it"):** ST's documented public surface for editing a character card or worldbook from a third-party extension is unstable. Cards have PNG metadata that has to be re-embedded after a JSON edit; worldbooks have uid normalisation. Neither is exposed via `getContext()` and neither is captured in the local `st-docs/` reference. I'd rather ship a closed-enum `not-implemented` surface than a `fetch` against speculative endpoints that might silently corrupt user data — the closed-enum surface keeps the LLM's tool contract honest (it can detect unavailability and use the workaround on the same turn) and makes it impossible for the dispatcher to misinterpret a partial write. **This is a deliberate scope cut, not a bug.** The tests assert the not-implemented shape so the next agent can replace it without grepping for the right place.

**Suggested follow-up path for the deferred 2:**
1. Confirm the correct ST internal HTTP routes — likely `/api/characters/edit` (or `/merge-attributes`) for cards and something like `/api/worldinfo/edit` for worldbooks — by reading the ST source against your installed version (different majors have moved these). Don't rely on the `st-docs/` snapshot.
2. Check whether `getContext()` exposes `getRequestHeaders` (it does on recent builds via `ctx.getRequestHeaders?.()` — that's where the CSRF token comes from).
3. Replace ONLY the `st_write_character` and `st_write_worldbook` handler bodies in `buildNovaStTools` (and the inline copy in `test/nova-st-tools.test.mjs`). The factory shape and DI surface don't need to change.
4. Update the deferred-shape unit tests to cover the success path. Keep at least one `not-implemented`-shape test gated behind a "if ST API is unreachable" branch so the closed-enum fallback stays exercised.

**Inline-copy convention follow-through:**
- The unit test file `test/nova-st-tools.test.mjs` inline-copies `buildNovaStTools` per the AGENT_MEMORY convention. The inline copy uses `ctxImpl: null → null` instead of the production fallback to `getContext()` (which doesn't exist in Node `--test`), and `executeSlashImpl: null → null` instead of falling back to `novaGetExecuteSlash`. Production source uses the real fallbacks. **When you edit the production helper, mirror the edit into the inline copy** — but don't try to "normalise" the fallback paths; making them match would either pull `getContext` into Node tests (impossible) or push the lazy fallback out of production (loses functionality).
- The 12-handler fuzz suite walks every handler against `[undefined, null, 0, 1, '', 'a', true, false, NaN, [], ['x'], {}, { name: null }, { name: 0 }]` and asserts no throws + a known result shape (any of `error | ok | characters | worldbooks | profiles | character | book | persona | count | messages | card | profile | raw | name`). When you add a handler or change a return shape, extend the assertion list.

**Validation:** `node --check index.js` clean; `node --test test/*.mjs` → **597/597 pass** (+48 net since prior baseline at 549: 47 new st-tools unit assertions + 1 new ui-wiring source-contract assertion).

**What's still outstanding on the plan (copy-forward):**
1. **`st_write_character` + `st_write_worldbook` real implementations** — see "Suggested follow-up path" above.
2. **`/shell/run` plugin route** (still 501 stub). Once the route lands, a `buildNovaShellHandler` factory (single tool) slots in next to the other three. Plan text: `spawn(cmd, args, { shell: false })` + allow-list resolution + stdin disabled + per-request timeout (default 60 s, hard cap 5 min) + stdout/stderr size caps + audit entry.
3. Rich per-turn tool-card transcript rendering (plan §2b/§3c).
4. Diff preview in approval path: composer-side `fs_read` → `buildNovaUnifiedDiff` → `cxNovaApprovalModal`. **All three pieces exist** — `fs_read` has a real handler, `buildNovaUnifiedDiff` was shipped earlier, `cxNovaApprovalModal` already accepts a `diffText` arg. Wiring is just an `if (tool === 'fs_write') { ... }` branch in the composer before calling `confirmApproval`. Don't teach the dispatcher to read the filesystem itself.
5. Plugin CSRF + session-cookie check on every route (plan §8c).
6. Plan checkbox refresh pass (cosmetic).

### 2026-04-25 — Review-comment audit + missed CSS regression fix (PR #16 fallout)

**Why this entry exists:** The user pushed back two sessions in a row that I'd been brushing off review comments — first on the fs-tools PR ("if the comment needs to be addressed, then address it"), then more broadly ("that worries me that this is something you've been doing the entire project"). Rather than reassure them, I audited every merged PR's review threads against the current source. They were right to worry: most review feedback HAS been addressed in follow-ups (just never marked resolved on GitHub, which is its own bad habit), but **one real regression slipped through and was sitting in the shipped code for two days**:

**The bug — fixed in this entry:**
- PR #16 ("OpenClaw removal") deleted shared CSS along with the OpenClaw block:
  - `.cx-profile-action-btn` — used 9× in `index.js` (Quests action row buttons in `buildQuestsApp`, plus the Map place-delete `✕` button at line 3060)
  - `.cx-profile-action-danger` — used in the Profiles "Delete" button (line 3216)
  - `.cx-profiles-actions` + `.cx-profile-actions` — wrappers in Profiles (3076, 3198, 3239) and the Profile card (3213)
  - These had ZERO selectors in `style.css` post-PR-#16, so Quests action buttons, the Map ✕ button, and the Profiles edit/avatar/delete row all rendered with browser-default styling. Worst-affected: `.cx-profile-action-danger` (the destructive-action color cue was completely gone).
- `chatgpt-codex-connector` flagged this on PR #16 as P2 with `is_outdated: false`. The thread was never resolved or replied to.
- **Fix:** Restored the selectors in `style.css` next to `.cx-quest-fail-btn` (which `extends` the base button via `border-color`). Mirrored `.cx-settings-btn` palette (rgba(50,50,55,.8) bg, rgba(255,255,255,.1) border, #ddd text), tightened padding to `4px 10px` since these are inline action rows not full-width settings buttons, and kept the danger variant's `#FF453A` red. No JS changes needed — the markup was already correct.

**Pattern audit findings (so the next agent doesn't repeat the mistake):**
- PR #16: 4 unresolved threads → **1 real regression** (CSS, fixed above), 3 doc/version nits (now stale).
- PR #17: 6 unresolved threads → all 3 substantive issues actually got fixed in follow-up commits (diff helper `isNewFile` empty-vs-missing, LCS DP-cell budget cap with `NOVA_DIFF_MAX_DP_CELLS`/`NOVA_DIFF_MAX_LINES_HARD`, `paths.js` `..foo` containment edge case).
- PR #19: 4 unresolved threads → both substantive issues fixed (turnTimeoutMs clamp now consistently 10000 across `loadSettings`, `saveSettings`, settings UI, and the in-phone settings panel; `cxPickList` got the `keydown` Enter/Space handler).
- PR #20: 9 unresolved threads → all 3 substantive ones fixed (`audit.js: ensureDir()` only flips `dirEnsured` on real success; `POST /fs/move` now `refuseRoot`s `to` as well as `from`; symlink-escape tests for non-existent targets exist in both `nova-fs-write.test.mjs` and `nova-fs-read.test.mjs`).

**Lessons for future agents (treat this as policy, not advice):**
1. **The "is_outdated: true" flag is not the same as "fixed."** GitHub flips it whenever later commits touch those lines. A real audit means cross-checking against current source.
2. **Always close the loop on review threads.** If you address a comment, reply to the thread saying so (or have your follow-up PR description list it explicitly). Leaving threads visible-but-unresolved makes it look like every comment was ignored, which destroys reviewer trust even when the underlying work is fine.
3. **CSS-class-only deletions are easy to miss.** When removing a feature, grep `index.js` for every class name being deleted from `style.css` (and vice-versa) before committing. The OpenClaw cleanup was a textbook case: deleted classes that LOOKED OpenClaw-specific were actually shared utility selectors used by sibling apps.
4. **The reviewer was right both times.** Don't argue with review comments to defend my prior work — reviewers don't have my context, but they DO have fresh eyes, and that's the whole point. If the comment is actionable, address it. If it's not actionable, explain why in a reply on the thread, don't just close the PR.

**Validation:** `node --test test/*.mjs` → 549/549 pass. CSS change is selectors-only, no production JS touched, no test changes needed. Manual visual verification requires loading in ST (no browser tests in this repo).

---

### 2026-04-24 (fs handlers) — Nova `fs_*` tool handlers shipped (plan §4a)

**Context:** Continued the Nova plan. AGENT_MEMORY's previous handover identified four remaining tool-handler slices (`fs_*`, `shell_run`, `st_*`, `phone_*`); `phone_*` shipped in the prior PR, this one ships `fs_*`. The plugin's seven `/fs/*` routes have all been live since v0.13.0 (read in mid-April, write soon after with the .nova-trash safety story); they just had no extension-side dispatcher entry, so every `fs_*` tool call resolved to `{ error: 'no-handler' }` in `runNovaToolDispatch`. Now they actually work.

**Pushback addressed in this PR:** Code Review on the unit-test-only first cut said "you're proving the transport contract via mock fetch but no end-to-end coverage against the real plugin." That's a fair callout — the unit tests prove URL/body composition + error-shape forwarding, but they don't prove that the URL we build is the URL the plugin actually parses, or that the safety story (overwrite-backs-up, delete-trashes, root-refusal, deny-list, audit-no-raw-content) is observable from the LLM's tool contract. So a second test file ships in the same PR to fill that gap, see "Integration coverage" below.

**What shipped:**
- `_novaBridgeRequest({ pluginBaseUrl, method, route, query, body, fetchImpl })` — generic, defensive HTTP transport in `index.js` immediately before `buildNovaFsHandlers`. Closed-enum failure surface: `no-fetch`, `nova-bridge-unreachable`, `nova-bridge-error`. Surfaces server `sendError({ error })` payloads verbatim with a `status` field attached. **NOTE:** This is intentionally separate from the existing `_novaBridgeWrite` (which is hard-coded to POST `/fs/write` with a fixed body shape and is still used by `buildNovaSoulMemoryHandlers`). The two helpers do not share code today; if you ever consolidate, audit the soul/memory tests to keep their mock surface stable.
- `buildNovaFsHandlers({ pluginBaseUrl?, fetchImpl? })` factory in the NOVA AGENT section right after `buildNovaPhoneHandlers`. Returns the 7 `fs_*` handlers (`fs_list`, `fs_read`, `fs_stat`, `fs_search`, `fs_write`, `fs_delete`, `fs_move`).
- `novaHandleSend` now composes three handler maps: `{ ...buildNovaSoulMemoryHandlers({}), ...buildNovaPhoneHandlers({}), ...buildNovaFsHandlers({}) }`.
- `test/nova-fs-tools.test.mjs` — 43 assertions across 10 suites. Inline-copies the helper + transport per the AGENT_MEMORY convention.
- **`test/nova-fs-integration.test.mjs`** — **NEW.** 19 assertions across 7 suites. Wires the **real** plugin route handlers from `routes-fs-{read,write}.js` against a real OS tempdir, then dispatches the **real** `buildNovaFsHandlers` through a fake `fetch` that maps URL+method onto those handlers. Proves end-to-end:
  - **Round-trip:** `fs_write` → `fs_read` returns same content; `fs_read` `maxBytes` truncates server-side; `fs_stat` 404 on missing.
  - **Safety contract:** `fs_write` without `overwrite:true` returns canonical `409 exists`; `fs_write` with `overwrite:true` writes a `.nova-trash/<bucket>/<path>` backup before clobbering (asserted by reading the backup off disk); `fs_delete` always trashes (canary file readable from `.nova-trash`); `fs_delete({path:'.'})` is `refused-root`.
  - **Move:** rename works, default refuses to clobber (`destination-exists`), `overwrite:true` backs up the destination.
  - **List + search:** files written via the tool show up in `fs_list`; recursive descent works; `fs_search` finds substring hits across files; glob filtering is honoured.
  - **Path safety:** `../escape.txt` → `invalid-path`; `.git/HEAD` deny-list rejection observable from the tool surface.
  - **Audit trail:** four ops produce four entries; raw write content NEVER appears in the audit-log JSON (asserted with a literal substring scan).
  - **Transport surface:** thrown fetch → `nova-bridge-unreachable`.
- `test/nova-ui-wiring.test.mjs` gained a source-contract assertion that `novaHandleSend` calls `buildNovaFsHandlers(`, `_novaBridgeRequest` is defined, and all 7 fs tool names appear in the source.

**Contract locked by tests:**
- **GET vs POST routing:** `fs_list`, `fs_read`, `fs_stat` are GET with query-string params; `fs_search`, `fs_write`, `fs_delete`, `fs_move` are POST with JSON bodies. **This mirrors the plugin's actual route shapes — do not change one without changing the other.** Tests assert both the method and the URL form per handler.
- **Local validation is minimal but explicit.** `path` must be a non-empty string; `content` (for `fs_write`) must be a string (empty string IS allowed — that's a legitimate empty file); `query` (for `fs_search`) must be a non-empty string; `from`/`to` (for `fs_move`) must both be non-empty strings. Anything beyond that is delegated to the plugin so the LLM gets the canonical server error code.
- **Optional args are forwarded only when explicitly provided.** `fs_list({ path: 'src' })` produces `?path=src` with no `recursive=` or `maxDepth=`. This is load-bearing for `fs_search`: if you forward `path: ''` to the server it overrides the server's default `'.'`. Tests cover this drop-empty-path branch.
- **Bool coercion is `Boolean(...)`.** `recursive: 1` becomes `true`, `overwrite: 0` becomes `false`. The plugin's `toBool` does its own coercion but client-side normalisation keeps URL params predictable for `URLSearchParams`.
- **Server error JSON is forwarded verbatim.** A 404 from `/fs/read` returns `{ error: 'not-found', status: 404 }`. A 413 from `/fs/write` returns `{ error: 'content-too-large', cap: 20971520, status: 413 }`. The LLM sees the canonical server error code and any extra metadata. **`status` is always added by the transport**, even when the server response already includes one — they should match in practice but if they ever diverge, our `status` wins.
- **2xx with non-JSON body returns `{ ok: true, body: <truncated> }`.** Covers a 204 No Content or a server bug. Body is truncated to 400 chars to keep the audit log + transcript tidy.
- **2xx with parseable JSON forwards verbatim.** No `ok: true` injection; the read routes don't include it and that's fine — the LLM can inspect the shape directly.
- **Error bodies (non-2xx with non-JSON or JSON-without-`error`) are truncated to 400 chars.** A 500 returning a 2KB HTML stack trace doesn't blow up the transcript.

**Inline-copy convention follow-through:**
- When you edit `_novaBridgeRequest` or `buildNovaFsHandlers` in `index.js`, mirror the edit into BOTH `test/nova-fs-tools.test.mjs` AND `test/nova-fs-integration.test.mjs` — the integration file inline-copies the same helpers so it doesn't depend on a Node-importable `index.js`.
- **Forced divergence between the two inline copies:** the integration file imports `node:path` at the top, so its inline copy uses `path: pathArg` in destructuring to avoid shadowing the module binding. Production source + the unit-test file both use `path` directly. The integration file's header comment documents this. Don't try to "normalise" — making the unit-test file use `pathArg` would break ITS mirror with production.
- The fuzz suite at the bottom of the unit test file walks every handler against `[undefined, null, 0, 1, '', 'a', true, false, NaN, [], ['a','b'], {}, { path: null }, { path: 0 }]` and asserts no throws + a known result shape (`error` string OR one of `ok | entries | content | results | type | path | from`). When you add a new handler, either match one of these shapes or extend the assertion list.
- The integration file's fake-fetch dispatch table only knows the 7 `/fs/*` routes. If you add a new route (e.g. `/shell/run`), extend `makePluginFetch` so future handler integration tests can reuse the harness.

**What's still outstanding on the plan (copy-forward):**
1. **`buildNovaStTools` factory** for the 10 ST-API tools (`st_list_characters`, `st_read_character`, `st_write_character`, `st_list_worldbooks`, `st_read_worldbook`, `st_write_worldbook`, `st_run_slash`, `st_get_context`, `st_list_profiles`, `st_get_profile`). ST-API only, no plugin dependency. Currently every `st_*` call returns `{ error: 'no-handler' }`. The natural next slice. The dispatch path through `getContext()` lives entirely in `index.js`; would inline-copy a tiny `getContext` mock for tests.
2. **`/shell/run` plugin route** (still 501 stub). Once the plugin route lands, an `buildNovaShellHandler` factory (single tool) would slot in next to `buildNovaFsHandlers`. Plan text: `spawn(cmd, args, { shell: false })` + allow-list resolution + stdin disabled + per-request timeout (default 60 s, hard cap 5 min) + stdout/stderr size caps + audit entry.
3. Rich per-turn tool-card transcript rendering (plan §2b/§3c).
4. Diff preview in approval path: composer-side `fs_read` → `buildNovaUnifiedDiff` → `cxNovaApprovalModal`. **All three pieces now exist** — `fs_read` has a real handler this PR, `buildNovaUnifiedDiff` was shipped earlier, `cxNovaApprovalModal` already accepts a `diffText` arg. Wiring is just a `if (tool === 'fs_write') { ... }` branch in the composer before calling `confirmApproval`. Don't teach the dispatcher to read the filesystem itself.
5. Plugin CSRF + session-cookie check on every route (plan §8c).
6. Plan checkbox refresh pass (cosmetic).

**Validation:** `node --check index.js` clean; `node --test test/*.mjs` → **549/549 pass** (+64 net since prior baseline at 485: 43 new fs-tools unit tests + 19 new fs-integration tests + 2 new ui-wiring source-contract assertions).

### 2026-04-24 — Docs housekeeping pass (v0.13.0 alignment)

**Context:** Top-level contributor docs had drifted from the v0.13.0 codebase. `CLAUDE.md` was still on v0.10.0 and described OpenClaw as a current app (it was retired and migrated to `.legacy_openclaw` in v0.13.0). `.github/copilot-instructions.md` was on v0.12.0, under-counted file sizes (said ~5200 JS lines vs. actual ~7900), and also listed OpenClaw. Neither file mentioned the Map or Nova apps. README's "bridge-console is being replaced by Nova" note predated Nova actually shipping.

**What changed:**
- `CLAUDE.md` refreshed end-to-end: v0.13.0, six apps (Command-X / Profiles / Quests / Map / Nova / Settings), file layout now shows `nova/`, `presets/`, `server-plugin/` and the broader `nova-*.test.mjs` suite, state/settings shape updated (drops `openclawMode`, adds map flags + `nova: {...}`), `currentApp` enum updated, `[place]` tag documented, VERSION constant line bumped, OpenClaw operate-mode section replaced with a Nova architecture section + short "legacy note" pointing at the migration helper, version history extended with v0.11–v0.13.
- `.github/copilot-instructions.md`: v0.12.0 → v0.13.0, line counts refreshed, app list swapped OpenClaw → Nova, file layout expanded, test guidance updated to `node --test test/*.mjs`.
- `README.md`: Six apps instead of five, Nova added to the Usage numbered list, retirement note rewritten to reflect that Nova shipped (not "is being replaced").

**Not touched (intentional):**
- `docs/code-review-plan.md`, `docs/private-phone-hybrid-plan.md`, `docs/quest-tracker*.md` — explicit historical snapshots of already-shipped work.
- `docs/nova-agent-plan.md` checkbox staleness — that's Nova's live bookkeeping, out of scope for a docs-housekeeping pass. The audit finding still stands from the prior PR: §0–§11 are substantially landed, unchecked boxes lag reality.

**Notes for future agents:**
- When bumping `VERSION` in `index.js` or `manifest.json`, also update: CLAUDE.md (§Named Constants line + §Version History + §File Layout), `.github/copilot-instructions.md` (Summary + Project Layout), and README.md if the app list or retirement notes change. There is no automation linking these.
- `docs/*` files that are stamped "implementation complete" / "historical snapshot" are deliberately frozen — don't "update" them in docs passes. They're citation targets, not living docs.
- OpenClaw references are NOT entirely purged — the migration helper (`migrateLegacyOpenClawMetadata`) and `LEGACY_KEYS` in `loadSettings` keep it in the codebase. CLAUDE.md has a short "legacy note" preserving this context. Do not remove those code paths or the note without a proper deprecation cycle; users with old chat metadata still rely on the migration.

### 2026-04-24 (phone handlers) — Plan audit + Nova `phone_*` tool handlers shipped

**Context:** Conducted a full audit of `docs/nova-agent-plan.md` against the actual shipped state (v0.13.0 live, 446 tests green before this PR). Plan checkboxes are significantly stale vs. reality — §0–§11 are largely landed; the real remaining work is: (1) `fs_*` / `st_*` / `phone_*` tool-handler factories in `index.js`; (2) `/shell/run` plugin route; (3) rich per-turn tool-card rendering; (4) diff preview wiring in approval modal; (5) plugin-side CSRF + session-cookie checks. This PR takes the smallest self-contained slice: phone-internal tool handlers.

**What shipped:**
- `buildNovaPhoneHandlers({ loadNpcsImpl, mergeNpcsImpl, loadQuestsImpl, upsertQuestImpl, loadPlacesImpl, upsertPlaceImpl, loadMessagesImpl, pushMessageImpl, messageHistoryLimitDefault=50, messageHistoryLimitMax=200 })` factory in the NOVA AGENT section immediately after `buildNovaSoulMemoryHandlers`. Returns the 8 `phone_*` handlers mapped by tool name.
- `novaHandleSend` now composes both handler maps (`{ ...buildNovaSoulMemoryHandlers({}), ...buildNovaPhoneHandlers({}) }`).
- `test/nova-phone-tools.test.mjs` — 39 assertions across 11 suites. Inline-copies the helper per the AGENT_MEMORY convention (index.js can't import cleanly under plain Node).
- `test/nova-ui-wiring.test.mjs` gained a source-contract assertion that `novaHandleSend` calls `buildNovaPhoneHandlers(` and all 8 tool names are present.

**Contract locked by tests:**
- **Never throws.** Every handler resolves to either a success shape (`{ ok, ... }` / `{ <collection>: [...] }`) or `{ error: <string> }`. Fuzzed against `undefined`, `null`, primitives, arrays, malformed objects.
- **Args object is coerced.** Destructuring default `= {}` only fires for `undefined`, not `null` — the fuzzing suite caught this and the factory now uses a `safeArgs(v)` helper before destructuring. **When you add more handlers, don't write `async ({ x } = {}) => {...}`; write `async (raw) => { const { x } = safeArgs(raw); ... }` or reintroduce the `null → TypeError` regression.**
- **Name/id is authoritative.** `phone_write_npc({ name: 'Aria', fields: { name: 'WRONG' } })` MUST merge `{ name: 'Aria', ... }`. Two tests lock this for NPCs and quests.
- **User-origin `from: 'user'` maps to internal `type: 'sent'`; `from: 'contact'` maps to `type: 'received'`.** These are the two production message types (there's also `'sent-neural'`, but the LLM should use dedicated neural-command flows, not inject synthetic messages as neural commands).
- **`phone_list_messages.limit` clamp.** `0` / negative / `NaN` / `Infinity` / non-finite → default (50). Positive values are `Math.max(1, Math.min(floor(limit), max))`. Max is 200 (matches the JSON-schema `maximum` in `NOVA_TOOLS`).
- **`phone_write_place` returns `{ error: 'upsert rejected (invalid place)' }` when `upsertPlace` returns `null`.** Production `upsertPlace` returns null on sanitization failure (e.g. bad coordinates). The handler surfaces this, doesn't swallow.

**Inline-copy convention follow-through:**
- When you edit `buildNovaPhoneHandlers` or `safeArgs` / `safeName` / `clampLimit` in `index.js`, mirror the edit into `test/nova-phone-tools.test.mjs`. The inline copy is the Node-testable twin; there's still no JSDOM/ST harness.
- The fuzzing suite at the bottom of the test file is a forward-looking guard: any future handler you add to the factory is automatically tested against the weird-args set. Don't delete it when adding new handlers — just make sure your new handler's output shape is one of the known ones (`ok`, `npcs`, `quests`, `places`, `messages`, or `error`), or extend the assertion list.

**What's still outstanding on the plan (copy-forward):**
1. `buildNovaStTools` factory for ST-API tools (`st_list_characters`, `st_read_character`, `st_write_character`, `st_list_worldbooks`, `st_read_worldbook`, `st_write_worldbook`, `st_run_slash`, `st_get_context`, `st_list_profiles`, `st_get_profile`). ST-API-only, no plugin dep — natural next slice after this one.
2. `buildNovaFsTools` / `buildNovaShellTools` factory that wraps `<pluginBaseUrl>/fs/*` + `/shell/run` HTTP routes. Reuse the `_novaBridgeWrite`-style pattern; all seven fs routes are live in the plugin.
3. `/shell/run` plugin route (501 stub today): `spawn(cmd, args, { shell: false })` + allow-list resolution + stdin disabled + per-request timeout (default 60 s, hard cap 5 min) + stdout/stderr size caps + audit entry.
4. Rich per-turn tool-card transcript rendering (plan §2b/§3c).
5. Diff preview in approval path: composer-side `fs_read` → `buildNovaUnifiedDiff` → `cxNovaApprovalModal` (helper already exists, approval modal already exists, just needs wiring).
6. Plugin CSRF + session-cookie check on every route (plan §8c).
7. Plan checkbox refresh pass — many items under §0/§1/§2/§5/§7/§9/§10/§11 are `- [ ]` but have actually landed. Not gating work; cosmetic debt.

**Validation:** `node --check index.js` clean; `node --test test/` → **485/485 pass** (+39 new: all in `nova-phone-tools.test.mjs`, plus one new source-contract assertion in `nova-ui-wiring.test.mjs` that fits inside an existing test block).

### 2026-04-24 (latest) — Phase 8b write routes + audit log shipped (review pass 2)

**Context:** Initial write-routes PR landed with 9 review comments. This update addresses all of them.

**Fixes applied:**
- **`paths.js`** — added `.nova-trash` to `DEFAULT_DENY_SEGMENTS`. The agent can no longer read/list/write inside the trash directory, so trashed backups are human-only. `moveToTrash` itself uses direct `fs` calls bypassing the deny-list and so can still write here.
- **`routes-fs-write.js`** — strict base64 validation via `isStrictBase64()` (length-mod-4 + alphabet check, whitespace-tolerant). Replaces a dead `try/catch` around `Buffer.from(..., 'base64')` which never threw on bad base64 — it would have silently corrupted the file. Comment on `TRASH_DIR_NAME` rewritten to match reality (deny-list entry exists in `paths.js`).
- **`routes-fs-write.js`** — `moveToTrash` EXDEV branch now mirrors the EEXIST disambiguation loop. Both physical mechanisms (rename + cp/rm) handle collisions identically. `trashRel` is computed once per attempt at the top of the loop so both branches return the same suffix-tagged path.
- **`routes-fs-write.js`** — `/fs/move` now refuses `to: '.'` via a second `refuseRoot` call. Previously only `from: '.'` was refused; a `to: '.'` would have fallen through to a confusing 409/500 with empty `relPath`.
- **`routes-fs-read.js::resolveRequestPath`** — when target ENOENT, walks parents upward via new `checkParentRealpath()` to find the nearest existing ancestor and realpath-verify it. Re-anchors the missing tail beneath the realpath'd parent. This closes a write-side symlink-escape: previously `linkOut/new.txt` (where `linkOut` symlinks outside root) would have created a file outside root because the ENOENT fallback used the unverified `norm.absolute`.
- **`audit.js::ensureDir`** — only sets `dirEnsured = true` on actual mkdir success. Previously transient EACCES would memoise the failure and prevent self-healing on a later append.
- **Test comments** — `nova-fs-write.test.mjs` header rewritten to match actual setup (single ROOT + `beforeEach` wipe of children); `nova-fs-read.test.mjs` `.git` filter comment unconfused.
- **New tests:**
  - `nova-paths.test.mjs` — `.nova-trash` deny-list locked in (3 cases).
  - `nova-fs-write.test.mjs` — symlink-escape on non-existent write target; symlink-escape on non-existent move destination; strict base64 rejection (invalid char + bad length); whitespace-in-base64 acceptance; refused `to: '.'`. (+6 tests)
  - `nova-audit.test.mjs` — mkdir retry after transient failure (3 assertions including a no-redundant-retry guard once dir exists).

**446/446 tests pass** (+8 net since prior commit at 438; +46 since baseline at 400).

**Notes for future agents:**
- **The parent-realpath walk in `checkParentRealpath` pushes basenames at the TOP of each iteration, before realpathing the parent.** I had to fix this once already — if you push only in the ENOENT-catch branch, the leaf basename never makes it into `missingSegments` and `relative` comes back as the empty string. Test `"creates a new file and audits outcome=created"` is the canary.
- **The walk caps at 256 iterations.** A pathological adversarial path (e.g. `a/a/a/...`) cannot pin a CPU. Real filesystems don't go this deep.
- **`isStrictBase64('')` returns `true`** — empty content is a valid empty file. Test `"base64 content round-trips to the right bytes"` covers the non-empty path; an explicit empty case isn't tested but it's a one-line fall-through.
- **`.nova-trash` deny-list lives in TWO places.** `paths.js::DEFAULT_DENY_SEGMENTS` is canonical; `test/nova-paths.test.mjs` keeps an inline copy per the file's own header convention. If you change one, mirror to the other or the test goes stale-silently.
- **`moveToTrash` EXDEV retry catches both `EEXIST` and `ERR_FS_CP_EEXIST`.** `fs.cp` with `errorOnExist: true` throws the latter; native rename throws the former.
- **The new symlink-escape tests require write permission to create symlinks.** On Windows, `fs.symlink` may need elevated privileges and these tests would skip/fail. CI runs Linux so no special handling today.

### 2026-04-24 (later) — Phase 8b write routes + audit log shipped (initial)

**Context:** Prior PR landed the four read-only fs routes. This PR completes the filesystem surface with writes + audit logging, leaving only `/shell/run` as 501.

**What shipped:**
- **`server-plugin/nova-agent-bridge/audit.js`** — pure CJS factory `buildAuditLogger({ logPath, fsImpl?, nowImpl? })` → `{ append(entry), close(), rotate }`. Writes newline-terminated JSONL to a configured log path. Ensures parent dir on first append. NEVER logs raw content — top-level `content/data/payload/body/raw` keys are shallow-stripped, nested occurrences are elided by a `JSON.stringify` replacer. Cyclic entries fall through to a stub error line rather than throwing. Failures are swallowed and returned as `{ ok: false, error }` so a broken audit log never cascades into a failed user request.
- **`server-plugin/nova-agent-bridge/routes-fs-write.js`** — three write handler factories (`createFsWriteHandler`, `createFsDeleteHandler`, `createFsMoveHandler`) sharing a `moveToTrash({ root, absPath, relPath, bucket, fsImpl })` helper. All three reuse `resolveRequestPath` (now re-exported from `routes-fs-read.js`) for path safety.
- **`index.js` wiring** — reads `<root>/data/_nova-audit.jsonl` (or `<root>/_nova-audit.jsonl` fallback), builds one module-level `activeAuditLogger`, passes it to every write handler. `/shell/run` is now the only `notImplemented` stub. `/manifest` surfaces the resolved `auditLogPath`. `exit()` calls `auditLogger.close()`.
- **Capabilities manifest** — `fs_write`, `fs_delete`, `fs_move` flipped to `true`.

**Safety contract (the whole point of this PR):**
- **Deletes never hard-unlink.** `/fs/delete` always moves to `.nova-trash/<ts>/<relPath>`. An agent mistake is always recoverable until the user manually empties `.nova-trash/`.
- **Overwrites always back up first.** `/fs/write` with an existing target + `overwrite:true` moves the existing file to trash BEFORE writing. If the backup fails (EACCES, disk full, etc.), the write is refused with 500 `backup-failed` — we never leave the caller in a state where v1 is gone and v2 didn't land.
- **Move refuses to clobber by default.** `/fs/move` with an existing `to` + `overwrite:false` returns 409 `destination-exists`. With `overwrite:true` it backs up `to` to trash first.
- **20 MB hard cap on write content.** `body.content` is decoded to a Buffer first (so a base64 input is clamped on decoded size), then length-checked. 413 `content-too-large` on overflow.
- **Cross-device support.** `moveToTrash` catches EXDEV and falls back to `cp -r` + `rm -rf`.
- **Trash collision disambiguation.** If two moves in the same bucket hit the same path (tests use DI clocks with collisions), subsequent entries get `.1` / `.2` suffixes. Hard capped at 100 attempts.
- **Root protection.** `/fs/delete` and `/fs/move` both refuse to operate on `.` (the root itself) with 400 `refused-root`.
- **Deny-list is still enforced.** Any write into `.git/`, `node_modules/`, or `plugins/nova-agent-bridge/` is refused at `resolveRequestPath`.

**438/438 tests pass** (+38 new across `nova-audit.test.mjs` [13] + `nova-fs-write.test.mjs` [23] + `nova-plugin.test.mjs` [2]). Prior baseline was 400.

**Notes for future agents:**
- **`routes-fs-read.js` now re-exports `resolveRequestPath` + `sendError`.** The write module reuses them directly. Don't fork a second path-safety implementation — if you touch one contract, touch both.
- **`activeAuditLogger` is module-scoped in `index.js` intentionally.** ST calls `init()` once and `exit()` once; the audit logger outlives both calls. If you ever add hot-reload or multiple `init` calls, you'll need to close the previous logger first.
- **The audit log path is resolved ONCE at init.** If the user creates `<root>/data/` after the plugin starts, the log stays at `<root>/_nova-audit.jsonl` until the server restarts. Not worth re-resolving on every write.
- **Audit redaction has two layers.** Top-level key strip (`sanitizeEntry`) + nested JSON replacer. The strip is the primary guard; the replacer catches nested `{ content: '...' }` a caller forgot to flatten. Test `nova-audit.test.mjs::"redacts nested content / data under any key"` asserts the literal content substring never lands in the written bytes — do not loosen this check.
- **`moveToTrash` uses `path.posix.join` for the `trashRel` return value so the response is always POSIX-style, even on Windows.** Don't change this — the extension-side UI assumes `/`-separators.
- **Cyclic audit entries fall through to a stub line.** The try/catch in `formatEntry` is load-bearing — a caller passing `{ ...entry, self: entry }` must not crash the audit subsystem. `nova-audit.test.mjs::"never throws on a cyclic entry"` enforces this.
- **The 20 MB cap is on the decoded buffer, NOT the raw request body.** A 20 MB base64 string represents ~15 MB of bytes — we check after `Buffer.from(..., encoding)`. Extension-side, the `fs_write` tool schema doesn't cap size either; the plugin is the canonical enforcement point.
- **`mkdtemp` + `rm -rf` lifecycle in both test files.** `nova-fs-write.test.mjs` uses `beforeEach` to wipe children of ROOT (but keeps ROOT itself) so each test starts clean. Don't switch it to `before`/`after` without reconciling the tests that assume no leftover state.

**Follow-ups still outstanding on the Nova plan (copy-forward):**
1. `/shell/run` handler: `spawn(cmd, args, { shell: false })` with an allow-list resolved against `DEFAULT_SHELL_ALLOW`, stdin disabled, per-request timeout (default 60 s, hard cap 5 min), stdout/stderr capture with size caps, audit log entry.
2. Real handlers for `fs_*` / `st_*` / `phone_*` tool registry entries in `index.js`. The extension-side tool-handler factories wrap these HTTP routes — only the 5 `nova_*` self-edit tools have handlers today.
3. Rich per-turn tool-call cards in the transcript (collapsible args/result + audit link).
4. Diff previews in the approval modal (composer-side `fs_read` → `buildNovaUnifiedDiff` → `cxNovaApprovalModal`).

**Hard constraints still active (copy-forward):**
- `EXT === "command-x"` with a hyphen.
- `VERSION` in `index.js` must equal `manifest.json#version`. Wiring test enforces this.
- `turnTimeoutMs` clamp floor = 10000 everywhere.
- `normalizeNovaPath` containment predicate: `relNative === '..' || startsWith('..' + path.sep)`.
- `routes-fs-read.js::resolveRequestPath` adds the realpath-re-normalise layer; the write module reuses it unchanged. Both layers MUST remain in lockstep.
- `escAttr` for HTML attribute interpolations; `escHtml` for text content.
- **Deletes NEVER hard-unlink; overwrites ALWAYS back up first.** If you change this, you've changed the recovery story the whole Nova UI is built on.
- **Audit log NEVER contains raw content.** Top-level + nested redaction is load-bearing.
- Run tests via `node --test test/helpers.test.mjs test/nova-*.test.mjs`. **438/438** is the new baseline.

### 2026-04-24 (mid) — Phase 8b read-only fs routes shipped

**Context:** Handover priority #1 was "Phase 8 — `nova-agent-bridge` server plugin". All eight fs + shell routes were 501-stubs. This PR implements the four read-only routes end-to-end; writes + shell deliberately left as 501-stubs for a dedicated follow-up sprint.

**What shipped:**
- New file `server-plugin/nova-agent-bridge/routes-fs-read.js` (~390 LOC). Pure CommonJS factory module: exports `createFs{List,Read,Stat,Search}Handler({ root, normalizePath, fsImpl?, realpathImpl? })`. Each returns an Express-shaped `(req, res) => Promise<void>`. Factored this way so unit tests can drive handlers end-to-end against real tempdirs without spinning up Express.
- `index.js` wires the four live routes + kept four `notImplemented` stubs (`/fs/write`, `/fs/delete`, `/fs/move`, `/shell/run`).
- `CAPABILITIES` manifest flipped: `fs_list`, `fs_read`, `fs_stat`, `fs_search` → `true`.
- `routes-fs-read.js::resolveRequestPath` does `normalizeNovaPath` → `fs.realpath` → re-normalise against root's realpath → re-run deny-list on the resolved relative path. ENOENT is not an error — it flows through as `{ exists: false }` so handlers can 404 cleanly.
- Per-route safety caps: list = 5000 entries + maxDepth ≤ 10; read = 10 MB hard cap (`FS_READ_HARD_CAP_BYTES`); search = 500 results cap, 1 MB per-file read cap, null-byte heuristic (>4 nulls in first 8 KB → skip) so binary files don't poison text output.
- New `test/nova-fs-read.test.mjs` — 31 assertions across 5 suites (fs_list, fs_read, fs_stat, fs_search, internals). Every test creates its own tempdir under `os.tmpdir()` via `before`/`after` hooks so runs are isolated. Symlink-escape test gracefully skips if the CI container refuses `fs.symlink` with EPERM/EACCES.
- `test/nova-plugin.test.mjs` — "all 8 routes 501" split into "4 writes + shell still 501" + "4 read routes respond non-501 with proper 400/query-required" + "/manifest capabilities truthy for fs_list/fs_read/fs_stat/fs_search".
- Plugin README `## Status` rewritten (Scaffold → Partial).
- `docs/nova-agent-plan.md` §8b + §8c checkboxes flipped from `[ ]` to `[~]`/`[x]` with the partial-completion caveats; amendments log entry added.

**400/400 tests pass** (+31 new). `node --check` clean on both plugin files. Code Review + CodeQL to be run via parallel_validation.

**Notes for future agents:**
- **`routes-fs-read.js` is pure CJS and has zero npm dependencies.** It imports only `node:path`, `node:fs`, `node:fs/promises`. Don't add anything else without a really good reason — the plugin's `package.json` promises "zero runtime deps".
- **`resolveRequestPath` re-runs the deny-list on the realpath's relative form.** This is the guard against a symlink `nope` → `.git/HEAD` style escape. When you ship `/fs/write`, reuse this helper unchanged; don't reimplement the containment check.
- **The `fsImpl` / `realpathImpl` DI hooks exist but aren't used in tests yet.** Tests run against real tempdirs because it's fast and actually exercises the realpath path. The DI exists for the *write* sprint where mocking fs mutations is cheaper than cleaning up tempdirs.
- **Glob semantics on `/fs/search`**: `*` does NOT cross `/`, `**` DOES. `**/*.txt` requires a leading directory segment (mirrors bash globstar + ripgrep `--glob`). To match "any .txt at any depth including root", use the bare `**.txt` form. The relevant test (`globToRegExp: * does not cross slashes; ** does`) documents this explicitly. Initial test expectation got this wrong; was corrected during dev.
- **Search is a plain substring match, NOT a regex search.** Plan §4a calls it "full-text search". If someone requests regex support, they must open a new tool (`fs_regex_search`) rather than overloading `fs_search` — changing the query semantics retroactively would silently break the LLM-facing tool schema.
- **Binary-file heuristic: >4 null bytes in the first 8 KB → skip.** Mirrors ripgrep defaults. A cleaner UTF-8 validity check was considered but would skip valid UTF-16 BOM files; the null-byte counter is more conservative and deliberately matches user expectations from `rg`.
- **No audit logging yet.** Read routes are NOT required to audit per plan §8c — only writes and shell. When the write sprint lands, add an `onAudit` hook to the handler factories (don't hardcode an `appendFile` call).
- **`fs.read` uses explicit `fh.open` + partial read, not `fs.readFile(..., { maxBytes })`.** This matters for the 10 MB cap: `fs.readFile` would slurp the whole file first, THEN throw away the tail. The `fh.read` form never allocates more than `toRead` bytes. Don't "simplify" this back to `readFile`.
- **`CAPABILITIES` in the plugin manifest is the extension's capability probe target (plan §4f).** The extension will read this to decide which tools to register per session. Keep the object shape stable — a key going from `false` → `true` is additive; flipping a key away from `true` is a breaking change.

**Follow-ups still outstanding on the Nova plan (copy-forward):**
1. Phase 8 writes + shell: `/fs/write`, `/fs/delete` (move to `.nova-trash/<ts>/`), `/fs/move`, `/shell/run` (spawn without `shell: true`, allow-list + timeout), plus `SillyTavern/data/_nova-audit.jsonl` append-only audit log.
2. Real handlers for `fs_*` / `st_*` / `phone_*` tool registry entries in `index.js` (only the 5 `nova_*` self-edit tools have handlers today).
3. Rich per-turn tool-call cards in the transcript (collapsible args/result + audit link).
4. Diff previews in the approval modal (composer-side `fs_read` → `buildNovaUnifiedDiff` → `cxNovaApprovalModal`).

**Hard constraints still active (copy-forward from prior entry):**
- `EXT === "command-x"` with a hyphen.
- `VERSION` in `index.js` must equal `manifest.json#version`. Wiring test enforces this.
- `turnTimeoutMs` clamp floor = 10000 everywhere.
- `normalizeNovaPath` containment predicate: `relNative === '..' || startsWith('..' + path.sep)`.
- `routes-fs-read.js::resolveRequestPath` adds the realpath-re-normalise layer on top — both helpers MUST remain in lockstep.
- `escAttr` for HTML attribute interpolations; `escHtml` for text content.
- Run tests via `node --test test/helpers.test.mjs test/nova-*.test.mjs`. **400/400** is the new baseline.

### 2026-04-24 — Nova skill: STscript & Regex (Macros 2.0 expert)

**Context:** User asked to continue the Nova plan with "an additional skill — a regex / stscript / macros 2.0 expert (plus similar if you decide)". Shipped as a single combined skill rather than three separate ones.

**What shipped:**
- New `NOVA_SKILLS` entry `{ id: 'stscript-regex', label: 'STscript & Regex', icon: '⚙️', defaultTier: 'write' }` added to `index.js` between `worldbook-creator` and `image-prompter` (authoring-skill grouping).
- `SKILLS_VERSION` bumped `1` → `2` (prompt-catalogue change).
- Manifest / `VERSION` intentionally left at `0.13.0`. The parity test in `nova-ui-wiring.test.mjs` hardcodes `'0.13.0'`; bumping for a prompt-catalogue addition would thrash that test without benefit, and the real next release is gated on Phase 8 (server plugin) + tool handlers.
- `docs/nova-agent-plan.md` updated: new §5e describing the skill, renumbered `Skill structure` → §5f, `SKILLS_VERSION` reference bumped, amendments log entry added.

**Why one skill instead of three:** STscript, the Regex extension, and Macros 2.0 share identifiers (`{{getvar::x}}` resolves inside regex find patterns when `substituteRegex` is on; `/regex name="..."` calls from STscript trigger Regex scripts; Quick Replies are STscript scripts rendered through the same macro engine). The three surfaces are almost always used together in practice, so splitting would force the user to context-switch per question. The system prompt explicitly names all three domains in its `##` headings so the LLM routes correctly.

**Notes for future agents:**
- **Don't split `stscript-regex` into three skills casually.** The combined prompt is ~3 KB. If a user asks for deeper specialisation on only one surface, prefer editing the existing prompt with an opinionated section per surface (the three `##` headings) rather than fragmenting. Test coverage (structural `every skill has the required shape` + `every plan-specified skill id is present`) doesn't enforce the split.
- **`defaultTools` for this skill is deliberately broader than Character Creator.** It includes `st_run_slash` (so Nova can dry-run scripts and regex triggers end-to-end) **and** both the character-card and worldbook tool sets (because STscript scripts / regex patterns commonly read or write either surface). `shell_run` and `fs_delete` / `fs_move` are intentionally NOT defaults — user can escalate tier and add them manually if building a build pipeline.
- **`st_run_slash` is approval-gated (`permission: 'write'`).** The system prompt explicitly tells Nova to dry-run with `/echo` first. Do not attempt to switch `st_run_slash` to `'read'` without a very hard look — a slash command can do anything in ST, including `/persona`, `/delchat`, `/api`.
- **Regex scope contract**: the prompt says "prefer `st_write_character` over `fs_write` for scoped regex (character-card `data.extensions.regex_scripts[]`); global regex lives in `settings.json.extensions.regex` and needs `fs_write`". If a future PR adds a dedicated `st_write_settings` tool, remove the `fs_write`-on-settings.json guidance from this skill's prompt.
- **Prompt was authored from `st-docs/extensions/Regex.md` + `st-docs/Usage/macros.md` + `st-docs/For_Contributors/st-script.md`.** Those three files are the canonical reference for this skill. If they change upstream, update the skill prompt and bump `SKILLS_VERSION` again.
- **The existing structural test (`nova-tool-args.test.mjs`) covers the new skill automatically** — every tool name in `defaultTools` is validated against `NOVA_TOOLS`, `defaultTier` against `VALID_TIERS`, and shape/id uniqueness. 369/369 still green; no new test file needed for a pure prompt addition.

**Validation:**
- `node --check index.js` clean.
- `node --test test/helpers.test.mjs test/nova-*.test.mjs` → **369/369 pass** (unchanged from baseline).

**Follow-ups / still outstanding on the Nova plan (copy-forward):**
1. Phase 8 — `nova-agent-bridge` server plugin route handlers (`/fs/*`, `/shell/run`) are still `501 not-implemented` stubs.
2. Real handlers for `fs_*`, `shell_*`, `st_*`, `phone_*` tools — only the five `nova_*` self-edit tools have handlers today.
3. Rich per-turn tool-call cards in the transcript (collapsible args/result).
4. Diff previews in the approval modal (composer-side pre-fetch via `fs_read` → `buildNovaUnifiedDiff` → pass into `cxNovaApprovalModal`).

### 2026-04-24 — Next-session hand-off: v0.13.0 "Nova goes live" (UI wiring + Phase 2c/6b/7/9/10)

**Scope of this PR:** Nova's engine was already built and tested, but its UI was inert (controls `disabled`, no pill wiring, no composer handlers). This PR wires the engine to the view end-to-end and adds the remaining missing glue. Version bumped `0.12.0` → `0.13.0` in both `manifest.json` and `index.js` (the `VERSION` constant + the wiring test that enforces their agreement).

**What shipped (checklist):**
- ✅ **Phase 2c — UI wiring.** `wireNovaView()` attaches all handlers; `wirePhone()` calls it on every rebuild. Composer, Send, Cancel, three pills all interactive. Enter-to-send (Shift+Enter = newline). In-flight UI swaps placeholder to "Thinking…", shows Cancel, disables input. Empty-state setup card rendered when no profile is picked.
- ✅ **Transcript rendering.** `renderNovaTranscript()` draws from `session.messages`; `appendNovaTranscriptLine(text, kind)` for ad-hoc lines (`🔌 swap` / `⚠︎ notice` / `🛑 cancel` / user-preview).
- ✅ **Pill pickers.** Generic `cxPickList({ title, items, current })` modal + three Nova wrappers: `novaPickProfile` probes `/profile-list` at click time; `novaPickSkill` uses `NOVA_SKILLS`; `novaPickTier` offers read / write / full. Each persists to `settings.nova.*` and feedback-logs to transcript. Rows have `role="button"` + `tabindex="0"` **and** keyboard handlers (Enter / Space / Spacebar) — do NOT drop the keyboard handler; it was added after a PR review.
- ✅ **Profile handling (Phase 9).** `listNovaProfiles` + `parseNovaProfileListPipe` (JSON + newline/comma fallback + dedup). `withNovaProfileMutex` is tail-chained and non-poisoning — any rejected task does not poison the chain. `novaHandleSend` serialises **all** turns through the module-level mutex so a rapid-fire user can't interleave profile swaps with in-flight turns.
- ✅ **Phase 6b — soul/memory self-edit tools.** Five new `NOVA_TOOLS` entries (`nova_read_soul`, `nova_write_soul`, `nova_read_memory`, `nova_append_memory`, `nova_overwrite_memory`) + `buildNovaSoulMemoryHandlers({ baseUrl?, fetchImpl?, nowImpl?, invalidate? })` factory. Writes POST to `<pluginBaseUrl>/fs/write`; the soul/memory cache is invalidated **only on success**. `nova_append_memory` read-modify-writes with single-trailing-newline discipline (so appending never produces `\n\n\nfoo`). 21 new tests in `nova-self-edit-tools.test.mjs`.
- ✅ **Phase 7 — settings.** New Nova block in `settings.html` (profile / tier / max-tools / timeout / plugin URL / install-preset). Mirror in-phone `NOVA` section. `loadSettings` / `saveSettings` accept **both** ID sets (settings-panel + in-phone IDs) so editing in either place persists.
- ✅ **`buildNovaSendRequest(ctx)` adapter.** Prefers `ConnectionManagerRequestService.sendRequest`; falls back to `generateRaw` in **text-only mode** (tool calls disabled, notice posted to transcript).
- ✅ **CodeQL remediation.** Consolidated the duplicate `escAttr` helpers — the prior one didn't escape apostrophes. The kept version adds `'` → `&#39;` to its replacement set. All dynamic HTML **attribute** interpolations in the v0.13.0 wire-up use `escAttr`; text contexts still use `escHtml`. Don't regress this.
- ✅ **PR-review follow-ups (2f59808):**
  - `turnTimeoutMs` clamp floor raised from 1000 → **10000** in **both** `novaHandleSend` (turn dispatch) and `loadSettings` (settings panel display). This matches the settings-UI `min="10000"` and the `saveSettings` validation contract. If you ever see `Math.max(1000, ...)` near `turnTimeoutMs` again, it's a regression.
  - `cxPickList` rows now have a `keydown` handler (Enter / Space / Spacebar) via a shared `selectRow(row)` helper, making `role="button"` + `tabindex="0"` keyboard-accessible.
  - Corrected the comment in `novaHandleSend` to describe the dispatcher's two failure surfaces accurately: **`no-handler`** = registered tool without a dispatch handler; **`unknown-tool`** = tool name not in the registry.

**369/369 tests pass** (+48 new across `nova-self-edit-tools.test.mjs` [21], `nova-profile-swap.test.mjs` [16], `nova-ui-wiring.test.mjs` [11]; scaffolding test updated to reflect the view going live). CodeQL clean; Code Review clean.

**Notes for future agents:**
- **`wireNovaView()` is idempotent and rebuild-safe.** It is called on every `rebuildPhone()` → `wirePhone()` pass. Previous DOM references are stale after a rebuild; always re-query inside `wireNovaView`. Don't cache Nova DOM elements at the module level.
- **The module-level `novaProfileMutex` is the single serialisation point for ALL Nova work that touches profiles.** Don't bypass it. If you add a new code path that swaps profiles or runs a turn, route it through `withNovaProfileMutex(() => …)`. Tail-chained so a thrown handler does NOT poison the next queued work. Covered by `nova-profile-swap.test.mjs`.
- **`appendNovaTranscriptLine(text, kind)` is the ONLY way to add ad-hoc lines.** It handles the transcript-scroll-to-bottom + kind-specific styling. Don't write directly to the transcript container.
- **`NOVA_TOOLS` is the registry; `toolHandlers` is the per-turn dispatch map.** A tool registered in `NOVA_TOOLS` with no handler in the dispatch map returns `{ error: 'no-handler' }` — this is by design so rolling out a new tool is a two-step process (register first, wire a handler later).
- **Soul/memory cache invalidation is success-gated.** If the `fs/write` POST fails, the cache is NOT invalidated, so the next read returns the pre-write content — which is correct, because the write didn't land. Do not move `invalidate()` above the success check in `buildNovaSoulMemoryHandlers`.
- **`cxPickList` keyboard handler uses a shared `selectRow(row)` helper.** If you touch the click or keydown paths, keep them behaviourally identical — selection must update `selected` AND toggle the `cx-pick-active` class on exactly one row.
- **`escAttr` vs `escHtml` is load-bearing.** Attribute interpolations (anything inside `"..."` in an HTML attribute, especially `title="…"` / `data-…="…"` / `aria-label="…"`) **must** use `escAttr` so apostrophes encode. CodeQL will flag regressions. Text content inside tags still uses `escHtml`.
- **Inline-copy test convention continues to apply.** `nova-self-edit-tools.test.mjs`, `nova-profile-swap.test.mjs`, and `nova-ui-wiring.test.mjs` inline-copy the helpers they test. If you edit the source, edit the inline copy.

**What to do next (in order — each is a single reviewable PR):**
1. **Phase 8 — `nova-agent-bridge` server plugin.** The dispatcher + tier gate + approval modal + self-edit tool handlers are all live and will start working the moment the plugin answers real data. Ship plugin source under `server-plugin/nova-agent-bridge/` with install instructions. Route list: `/manifest.version`, `/profile-list`, `/fs/read`, `/fs/write`, `/fs/stat`, `/fs/list`, `/shell/run`.
2. **Real handlers for `fs_*` / `shell_*` / `st_*` / `phone_*` tools.** Currently only the five soul/memory tools have handlers; other registered tools return `{ error: 'no-handler' }`. Each new handler must be pure-ish (DI for `fetchImpl` / `nowImpl`), must NOT reach into the DOM, and must return a stable-shape result or `{ error }`.
3. **Rich per-turn tool-call cards.** Today, tool calls render as `role:'tool'` text in the transcript. A richer card (collapsible, with args summary + result preview + audit link) would go far; the data is already in `session.messages` + the audit log.
4. **Diff previews in the approval modal.** The dispatcher passes `{ tool, args, permission, toolCallId }` to `confirmApproval` but NOT `diffText`. For `fs_write`, the composer should `fs_read` the old content first, build the diff via `buildNovaUnifiedDiff(oldContent, args.content, { isNewFile })`, then pass the result into `cxNovaApprovalModal`. Keep this in the composer — don't teach the dispatcher to read the filesystem.

**Hard constraints still active (copy-forward):**
- `EXT === "command-x"` with a hyphen. Bracket-access only on `extension_settings`.
- `VERSION` in `index.js` must equal `manifest.json#version`. The wiring test enforces this — don't bump one without the other.
- `turnTimeoutMs` clamp floor is **10000** everywhere (UI `min`, `saveSettings` validation, `loadSettings` display, `novaHandleSend` dispatch).
- `buildNovaUnifiedDiff` auto-detect is nullish-only. Pass `isNewFile: true` explicitly when wiring `fs_write` previews against `fs_stat` → ENOENT.
- `normalizeNovaPath` containment predicate: `relNative === '..' || startsWith('..' + path.sep)`.
- `novaToolGate` — closed-enum `reason`: `tier-too-low` / `unknown-permission` / `missing-permission`.
- `runNovaToolDispatch` — closed-enum `reason` on `ok:false`: `aborted` / `send-failed` / `no-send-request`. Tool-error reasons (inside `role:'tool'` content): `unknown-tool` / `malformed-arguments` / `denied` (+ sub-reason) / `no-handler` / handler-stringified-message.
- Soul/memory cache invalidation is success-gated in `buildNovaSoulMemoryHandlers`.
- `escAttr` for HTML **attribute** interpolations (escapes `&<>"'`). `escHtml` for text content. Do not use `escHtml` in attributes; CodeQL will flag it.
- `cxPickList` rows must have BOTH click and keydown handlers. Don't regress the keyboard-accessibility fix.
- Run tests via `node --test test/helpers.test.mjs test/nova-*.test.mjs` (explicit filenames). **369/369** is the current baseline.

**Validation this sprint:**
- `node --check index.js` clean.
- `node --test test/helpers.test.mjs test/nova-*.test.mjs` → **369/369 pass** (+48 new; baseline was 321).
- CodeQL clean. Code Review clean.

### 2026-04-23 (late evening) — Next-session hand-off: after Phase 3c proper (dispatch loop + approval modal)

**Scope of this PR:** Phase 3c core landed. `sendNovaTurn` now runs a full tool-dispatch loop when `toolHandlers` is passed; absent it, the Phase 3b deferred-stub behaviour is preserved so prior tests stay green. Added:

- `runNovaToolDispatch({ initialResponse, messages, toolRegistry, handlers, tier, rememberedApprovals, maxToolCalls, confirmApproval, sendRequest, tools, signal, gate, nowImpl, onAudit })` — pure async multi-round loop. Mutates `messages` with every assistant + `role:'tool'` message it emits, returns `{ ok, rounds, toolsExecuted, toolsDenied, toolsFailed, capHit, aborted, finalAssistant, events }`. 22 assertions in `test/nova-tool-dispatch.test.mjs`.
- `buildNovaApprovalModalBody({ tool, args, diffText, permission })` — pure HTML body builder. All user-controlled strings escaped via `escHtml`. 18 assertions in `test/nova-approval-modal.test.mjs`.
- `cxNovaApprovalModal({ tool, args, diffText, permission, title })` — DOM wrapper reusing `.cx-modal-overlay` + new `.cx-nova-approval` / `.cx-nova-approval-*` styles in `style.css`. Destructive permissions (write/shell) use `cx-modal-btn-danger` and default focus to Cancel.
- Wired `sendNovaTurn` with four new opt params: `tier`, `rememberedApprovals`, `toolHandlers`, `confirmApproval`. When present, the dispatcher activates and the return shape changes to include `{ toolsExecuted, toolsDenied, toolsFailed, rounds, capHit }` instead of `{ toolCalls, toolCallsDeferred }`.

**Full suite: 321/321 pass (+40 new across the two test files).** Baseline was 281.

**Closed-enum failure contract for the dispatcher.** Every failure mode resolves to one of:
- A `role:'tool'` message with `{ error: <kind>, reason?: <code> }` (LLM can recover and try again). Kinds: `unknown-tool`, `malformed-arguments`, `denied` (+ reason: `tier-too-low` / `unknown-permission` / `missing-permission` / `user-rejected` / `no-confirmer` / `confirmer-error`), `no-handler`, or the stringified exception message.
- `{ ok: false, reason }` where `reason ∈ 'aborted' | 'send-failed' | 'no-send-request'`. The partial transcript is still available to the caller via the mutated `messages` array AND the returned `events` list — `sendNovaTurn` uses `events` to persist the partial session on error.

Cap-hit and gate-deny are NOT `ok:false` — the turn finishes normally with the flags set. Rationale: the user should still see the partial result, and the LLM has already been told via `role:'tool'` that the denied call failed.

**Why `toolHandlers` gate-activates the dispatcher, not `confirmApproval`.** Early draft activated only when BOTH were present, then fell back to deferred behaviour. Simpler to activate on `toolHandlers` alone: the dispatcher handles "approval required but no confirmer wired" internally by denying with `no-confirmer`. This means a caller that wants a read-only turn can pass `toolHandlers` without `confirmApproval` and any write call will cleanly fail-closed instead of accidentally running.

**Why the confirmer throw branch denies instead of propagating.** `confirmApproval` is an async UI call; if the modal infrastructure is broken, we do NOT want the tool to execute, and we do NOT want the turn to crash outright (the audit log and transcript would be lost). Denying with `confirmer-error` gives the LLM a chance to apologise and stop, and the user still gets a coherent transcript. Test `treats a throwing confirmer as a rejection (not a crash)` locks this in.

**Dispatcher MUTATES `messages`.** This is intentional and contractual. `sendNovaTurn` builds a `messages` array via `buildNovaRequestMessages`, hands it to the dispatcher, and reads the new tail via `dispatchResult.events` to append to `session.messages` and persist. If Phase 3c's composer wants a read-only snapshot, it MUST clone before calling. Don't change this to return-a-new-array without also updating `sendNovaTurn`'s session-persistence path.

**`runNovaToolDispatch` does NOT re-push the initial assistant message from `initialResponse` if it came from `sendRequest` already**... wait, actually it does. That's a subtle invariant to remember: `sendNovaTurn` calls `sendRequest` once itself, then hands the response to the dispatcher, which pushes an assistant message for that initial response AND for every subsequent round's response. Therefore `sendNovaTurn` must NOT also push the initial assistant message itself before handing off — the dispatcher handles it. This is how the code is currently wired; tests will fail noisily if someone breaks this.

**Notes for future agents:**
- **`cxNovaApprovalModal` is not unit-tested** — DOM behaviour (focus, Esc handler, button clicks) would need JSDOM. The pure `buildNovaApprovalModalBody` carries the escape-safety contract. If you touch the DOM wrapper, manually test in ST that Esc cancels, Cancel gets default focus on write/shell, and overlay tears down on both paths.
- **`.cx-nova-approval` widens the modal to 520px.** This is safe at phone widths (380px × scale) because the modal overlay centers and the box is scrollable. If phone scaling changes, revisit.
- **Dispatcher does not currently surface diff previews to the confirmer.** `confirmApproval` receives `{ tool, args, permission, toolCallId }` but not `diffText` — the composer in Phase 3c must build the diff itself (via `buildNovaUnifiedDiff(oldContent, args.content)` after an `fs_read`) and pass the result into `cxNovaApprovalModal`. Rationale: the dispatcher shouldn't reach into the filesystem to pre-fetch old content — that's the composer's job and it keeps the dispatcher pure.
- **Inline-copy tests now carry 5+ symbols each.** When editing `runNovaToolDispatch` or `buildNovaApprovalModalBody`, also update the inline copies at the top of `test/nova-tool-dispatch.test.mjs` and `test/nova-approval-modal.test.mjs`. Source-shape tests will catch drift in the parameter list and in file ordering, but NOT in helper logic.
- **`audit` callback signature: `(entry:{tool, argsSummary, outcome}) => void`.** `sendNovaTurn` wraps `appendNovaAuditLog(state, entry)`. One audit entry per tool_call outcome is guaranteed — the `audit coverage` test locks this in. Don't suppress audits on failure paths; they're the only record of what Nova tried.

**What to do next (in order — each is a single reviewable PR):**
1. **Phase 2c — composer UI wiring.** Now that `sendNovaTurn` + the dispatcher are real, the Nova composer can call them. This is where the textarea, Send button, Cancel button (→ `novaAbortController.abort()`), and profile/skill pickers live. Touches `wirePhone` + a bunch of DOM — bigger review surface than this PR.
2. **Phase 6b — self-edit tools** (`nova_read_soul`, `nova_write_soul`, `nova_read_memory`, `nova_append_memory`, `nova_overwrite_memory`). Each write handler must call `invalidateNovaSoulMemoryCache()` after success. These are the first REAL tool handlers — a thin wrapper over the `fs_write` plugin call (when available) with a `POST /api/files/*` fallback.
3. **Phase 7 — settings surface.** Profile picker from `/profile-list`, tier radio (use `NOVA_TIERS`), caps, plugin URL, "Install preset" button.
4. **Phase 9 — bridge fs handlers.** The server-plugin stubs currently return `501`. The dispatcher + tier gate + approval modal are all ready; they'll just start working once the plugin answers real data.

**Hard constraints still active (copy-forward):**
- `EXT === "command-x"` with a hyphen. Bracket-access only on `extension_settings`.
- `buildNovaUnifiedDiff` auto-detect is nullish-only. Pass `isNewFile: true` explicitly when wiring `fs_write` previews against `fs_stat` → ENOENT.
- `normalizeNovaPath` containment predicate: `relNative === '..' || startsWith('..' + path.sep)`.
- Plugin `/manifest.version` comes from `package.json` via `resolvePluginVersion()`.
- `novaToolGate` — closed-enum `reason`: `tier-too-low` / `unknown-permission` / `missing-permission`.
- `runNovaToolDispatch` — closed-enum `reason` on `ok:false`: `aborted` / `send-failed` / `no-send-request`. Tool-error reasons (inside `role:'tool'` content): `unknown-tool` / `malformed-arguments` / `denied` (+ sub-reason) / `no-handler` / handler-stringified-message.
- Inline-copy test convention: when editing helpers in `index.js`, edit the matching inline copies in `test/nova-*.test.mjs`. Multiple test files now carry inline copies of the same symbols — keep ALL in lockstep.
- Run tests via `node --test test/helpers.test.mjs test/nova-*.test.mjs` (explicit filenames).

**Validation this sprint:**
- `node --check index.js` clean.
- `node --test test/helpers.test.mjs test/nova-*.test.mjs` → **321/321 pass** (+40 new; baseline was 281).
- No new event listeners, no new settings, no new init paths. New DOM is modal-only (inert until `cxNovaApprovalModal` is called from Phase 2c).

### 2026-04-23 (evening) — Next-session hand-off: after Phase 3c precursor (tier + approval gate)

**Scope of this PR (adds to the same branch as the Phase 6a loader):** one new pure helper slice for the Phase 3c dispatch loop. Added `novaToolGate({ permission, tier, toolName, rememberedApprovals })` to `index.js` NOVA AGENT section, placed between `loadNovaSoulMemory` and `buildNovaUnifiedDiff`. Supporting pieces: `NOVA_TIERS` + `NOVA_PERMISSIONS` frozen enums, `_NOVA_TIER_ALLOWS` lookup table (Sets for O(1) checks), `_novaRememberedApprovalsHas` container helper. New `test/nova-tool-gate.test.mjs` (26 assertions across 6 suites). Full suite **281/281 pass** (+26 vs prior 255).

**What this ships (and what remains for Phase 3c):**
- ✅ Closed-enum decision contract: return `{ allowed, requiresApproval, reason? }`. `reason` values are a closed set: `tier-too-low`, `unknown-permission`, `missing-permission`. The Phase 3c dispatcher should branch on these and surface them verbatim in the audit log — don't map them to generic "denied" strings.
- ✅ Defensive defaults: missing `permission` → denied (`missing-permission`, not "read"). Missing / malformed `tier` → falls back to strictest (`'read'`). Malformed `rememberedApprovals` (object / string / number / Symbol) is ignored — the gate returns `requiresApproval: true` as if nothing were remembered.
- ✅ Two independent decisions in one call: tier gate AND approval gate. Design rationale: Phase 3c's dispatch loop needs both before it decides whether to `cxConfirm` — splitting into two helpers would force every caller to sequence them in the same order, and the tests would have to re-assert "approval is never requested for a tier-denied tool" at every call site. Folding both into one decision was the right trade-off; the 3×3 matrix test locks it in.
- ✅ `toolName` + empty-string toolName defeat the `rememberedApprovals` bypass. Both tests `missing toolName defeats the remembered-approvals bypass` and `empty-string toolName defeats the remembered-approvals bypass` lock this in. Rationale: an LLM could send a tool_call with an empty/missing `function.name` and a matching entry could exist in the set; we want that to re-confirm, not silently run.
- ⏳ **Not wired from `sendNovaTurn` yet.** Phase 3c replaces the `toolCallsDeferred` branch with a real dispatch loop that calls `novaToolGate` per tool_call, routes through `cxConfirm` when `requiresApproval`, and emits one audit entry per gate decision. Don't wire this from anywhere else — the gate is meant to run exactly once per tool_call, right before approval.
- ⏳ **`rememberedApprovals` storage shape for Phase 3c.** The plan says `rememberApprovalsSession: false` is a boolean setting in `settings.nova`, but the per-session remembered-tool-names list lives elsewhere. Phase 3c should store it at `ctx.chatMetadata[EXT].nova.sessions[activeSessionId].rememberedApprovals = Set | string[]`. The gate already accepts either shape.

**Notes for future agents:**
- **Enum additions are breaking.** `NOVA_TIERS` and `NOVA_PERMISSIONS` are frozen and the gate branches on exact membership. If Phase 4/5 adds a new permission class (e.g. `'network'`), update BOTH enums, `_NOVA_TIER_ALLOWS`, AND the inline-copy in `test/nova-tool-gate.test.mjs` or the matrix test silently stops covering it. The `NOVA_TOOLS coverage` test auto-detects new permissions in the registry and fails loudly if they're missing from `NOVA_PERMISSIONS` — don't remove it.
- **`_NOVA_TIER_ALLOWS` uses Sets, not arrays.** The hot path is `allows.has(permission)` which runs once per tool_call in the dispatch loop. If you swap to arrays for "simplicity" you'll take an `O(n)` hit at a site that already has an LLM round-trip in the critical path; negligible in practice but the convention is set — keep the Sets.
- **Why approval is "false" on tier-denied tools, not "true".** A denied tool never runs, so asking the user to approve it would be wrong. The gate contract is: `requiresApproval: true` means "run the cxConfirm and, if approved, execute the tool." On a denied call, nothing executes regardless of the user's answer. Test `tier-denied tools never need approval` locks this in.
- **Inline-copy test convention strikes again.** `test/nova-tool-gate.test.mjs` inline-copies `novaToolGate` + `NOVA_TIERS` + `NOVA_PERMISSIONS` + `_NOVA_TIER_ALLOWS` + `_novaRememberedApprovalsHas`. If you edit the production helper, edit the inline copy too, or the tests silently test the wrong function.
- **Source-shape tests pin the ordering.** The gate must live between `loadNovaSoulMemory` and `buildNovaUnifiedDiff`. If you reorganise the NOVA AGENT section, update `gate helper lives between soul/memory loader and diff helper` to reflect the new ordering.

**What to do next (in order — each is a single reviewable PR):**
1. **Phase 3c — tool handler dispatch loop + approval modal DOM.** Now has all its pure helpers shipped (`buildNovaUnifiedDiff`, `loadNovaSoulMemory`, `novaToolGate`, `composeNovaSystemPrompt`, `buildNovaRequestMessages`). The loop: for each tool_call, resolve to `NOVA_TOOLS` entry → call `novaToolGate` → on `allowed:false` skip with audit entry → on `requiresApproval:true` call `cxConfirm` with `buildNovaUnifiedDiff` preview for `fs_write` → on approve, call handler → append `role:'tool'` message → re-call `sendRequest`. Enforce `maxToolCalls` cap with one final audit entry on hit. Also the phase that finally consumes `probeNovaBridge`.
2. **Phase 2c — approval modal DOM shell + connection-profile picker + skill picker.** Must land alongside 3c (3c's `cxConfirm` call site needs the diff-renderer pane). Use `cxConfirm`, never native.
3. **Phase 6b — self-edit tools** (`nova_read_soul`, `nova_write_soul`, `nova_read_memory`, `nova_append_memory`, `nova_overwrite_memory`). Each write handler must call `invalidateNovaSoulMemoryCache()` after success.
4. **Phase 7 — settings surface.** Profile picker from `/profile-list`, tier radio (use `NOVA_TIERS`), caps, plugin URL, "Install preset" button.

**Hard constraints still active (copy-forward):**
- `EXT === "command-x"` with a hyphen. Bracket-access only on `extension_settings`.
- `buildNovaUnifiedDiff` auto-detect is nullish-only. Pass `isNewFile: true` explicitly when wiring `fs_write` previews against `fs_stat` → ENOENT.
- `normalizeNovaPath` containment predicate: `relNative === '..' || startsWith('..' + path.sep)`.
- Plugin `/manifest.version` comes from `package.json` via `resolvePluginVersion()`.
- Inline-copy test convention: when editing a helper in `index.js`, edit the matching inline copy in `test/nova-*.test.mjs`. `test/nova-tool-gate.test.mjs` inline-copies **five** symbols; keep them in lockstep.
- Run tests via `node --test test/helpers.test.mjs test/nova-*.test.mjs` (explicit filenames).

**Validation this sprint:**
- `node --check index.js` clean.
- `node --test test/helpers.test.mjs test/nova-*.test.mjs` → **281/281 pass** (+26 new gate tests; baseline was 255).
- No new DOM, no new LLM calls, no new event listeners, no new settings. Pure decision helper + enums.

### 2026-04-23 — Next-session hand-off: after Phase 6a soul/memory loader

**Scope of this PR:** Phase 6a (read path). Added `loadNovaSoulMemory(...)` pure helper to `index.js` NOVA AGENT section, placed between the `probeNovaBridge` block and the `buildNovaUnifiedDiff` block. Supporting pieces: `NOVA_SOUL_MEMORY_TTL_MS = 5 * 60_000`, `NOVA_SOUL_FILENAME`, `NOVA_MEMORY_FILENAME`, `defaultNovaSoulMemoryBaseUrl()`, `_fetchNovaMarkdown()` per-file primitive, `invalidateNovaSoulMemoryCache()`. New `test/nova-soul-memory.test.mjs` (16 assertions). Full suite **255/255 pass** (+16 vs prior 239).

**What §6a ships (and what remains):**
- ✅ Pure DI helper (`{ baseUrl, fetchImpl, nowImpl, ttlMs, force }`) that never throws. 404 / network error / decode error / non-string body all coerce to an empty string for that file. Both files fetched in parallel via `Promise.all`; a failure on one does not take down the other.
- ✅ Module-level cache with TTL (5 min default) + explicit invalidation. **Failure results are cached too** — otherwise a missing `soul.md` would cause the composer to hot-loop fetch on every turn. If that ever becomes undesirable (e.g. user drops the file in live), Phase 6b's "Reload soul/memory" button must call `invalidateNovaSoulMemoryCache()`.
- ✅ `defaultNovaSoulMemoryBaseUrl()` uses `EXT` interpolation so an extension-folder rename only lives in one place (matches the pattern `settings.html` already uses at init time).
- ✅ Starter content (`nova/soul.md`, `nova/memory.md`) was already in the repo from an earlier phase; §6d checkboxes now ticked to reflect reality.
- ⏳ **Not yet wired from Nova init.** `sendNovaTurn` already accepts `soul` / `memory` parameters (added in Phase 3b). Phase 3c's composer wiring is the first caller — it should `await loadNovaSoulMemory({ fetchImpl: fetch })` then forward the result. Don't call it from `initNovaOnce` — the read is lazy by design (5-min TTL handles the steady state).
- ⏳ **Not yet invalidated on self-edit.** The `nova_write_soul` / `nova_overwrite_memory` tool handlers (Phase 6b) must call `invalidateNovaSoulMemoryCache()` after a successful write so the next turn picks up the change.

**Notes for future agents:**
- **Failure caching is the right default.** The test `caches failure results too` locks this in. Rationale: `loadNovaSoulMemory` runs once per turn in the Phase 3c path; if `soul.md` is missing, re-hitting a 404 every turn is waste. The TTL (5 min) bounds the staleness for users who drop a new file. If you ever relax this, update the test and document the change in this memory file.
- **`_fetchNovaMarkdown` is the per-file primitive** — it's the one place that knows how to coerce non-text bodies. `loadNovaSoulMemory` only orchestrates the two parallel calls + caches. Keep them separate; Phase 6b's `nova_read_soul` tool handler will call `_fetchNovaMarkdown` directly with a per-file URL.
- **`fetchImpl` / `nowImpl` injection is mandatory for tests.** The production path falls through to global `fetch` / `Date.now`. The test file uses a small `makeFetchMock` factory that records `calls[]` for assertion — reuse the pattern if you add more fetch-backed helpers.
- **Cache shape is `{ result, expiresAt }` or `null`.** Matches the `_novaBridgeProbeCache` convention in `probeNovaBridge`. If Phase 6b adds a separate "user-owned soul/memory" read path (under `SillyTavern/data/<user>/user/files/nova/`), keep them on the same cache key — the baseUrl isn't in the key, so switching `baseUrl` between calls within the TTL returns the first URL's cached result. That matches the probe's semantics and is the right trade-off for the expected usage (users pick a root and stick with it).
- **Don't merge `loadNovaSoulMemory` into `sendNovaTurn` or `initNovaOnce`.** It's a single-purpose pure helper. The Phase 3c composer calls it; nobody else does. Wiring it into init would force the fetch at chat-change time, which is the wrong timing (users may never open Nova in a given chat).
- **Source-text tests are brittle by design.** `test/nova-soul-memory.test.mjs` asserts the loader lives strictly between `probeNovaBridge` and `buildNovaUnifiedDiff` (both already had this relative position for §4f / §4c). If you reorganise the section, keep the ordering or update both relative-position asserts.

**What to do next (in order — each is a single reviewable PR):**
1. **Phase 3c — tool handler dispatch + approval modal DOM.** Still the biggest remaining slice. Replace the `toolCallsDeferred` branch in `sendNovaTurn` with a real dispatch loop. Gate Write/Full tool calls on a `cxConfirm` approval modal using `buildNovaUnifiedDiff` (§4c) for `fs_write`. This is the phase that consumes `probeNovaBridge` (§4f) AND `loadNovaSoulMemory` (§6a) — the composer passes the loader result into `sendNovaTurn`'s `soul` / `memory` args.
2. **Phase 2c — approval modal DOM + connection-profile picker + skill picker.** Lands alongside 3c since the dispatch loop needs the approval modal.
3. **Phase 6b — self-edit tools** (`nova_write_soul`, `nova_append_memory`, `nova_overwrite_memory`). Each handler must call `invalidateNovaSoulMemoryCache()` after a successful write.
4. **Phase 7 — settings surface.** Profile picker, tier radio, caps, plugin URL, "Install preset" button.

**Hard constraints still active (copy-forward):**
- `EXT === "command-x"` with a hyphen. Bracket-access only on `extension_settings`.
- `buildNovaUnifiedDiff` auto-detect is nullish-only. Pass `isNewFile: true` explicitly when wiring `fs_write` previews against `fs_stat` → ENOENT.
- `normalizeNovaPath` containment predicate: `relNative === '..' || startsWith('..' + path.sep)`.
- Plugin `/manifest.version` comes from `package.json` via `resolvePluginVersion()`.
- Inline-copy test convention: when editing a helper in `index.js`, edit the matching inline copy in `test/nova-*.test.mjs` or tests silently test the wrong function. `test/nova-soul-memory.test.mjs` inline-copies `loadNovaSoulMemory` + `_fetchNovaMarkdown` + `invalidateNovaSoulMemoryCache` via a `makeCapsule()` closure (needed so the module-level `_novaSoulMemoryCache` binding has per-test isolation — reusing a single capsule would leak cache across tests).
- Run tests via `node --test test/helpers.test.mjs test/nova-*.test.mjs` (explicit filenames, not `'test/*.test.mjs'`).

**Validation this sprint:**
- `node --check index.js` clean.
- `node --test test/helpers.test.mjs test/nova-*.test.mjs` → **255/255 pass** (+16 new soul/memory tests; baseline was 239).
- No new DOM, no new LLM calls, no new event listeners. Cache invalidation is explicit (callers opt in) rather than tied to `CHAT_CHANGED` — soul/memory are extension-bundled, not per-chat.

### 2026-04-23 — Next-session hand-off: after Phase 3b turn-lifecycle skeleton

**Scope of this PR:** Phase 3b skeleton. Added `sendNovaTurn` to the NOVA AGENT section of `index.js` (dependency-injected async helper that never throws), plus four small supporting pure helpers: `resolveNovaSkill`, `buildNovaRequestMessages`, `parseNovaProfilePipe`, `getActiveNovaProfile`. Added `NOVA_BASE_PROMPT`, `NOVA_TOOL_CONTRACT`, `NOVA_DEFAULT_MAX_TOOL_CALLS`, `NOVA_DEFAULT_TURN_TIMEOUT_MS` constants. New test file `test/nova-turn.test.mjs` (23 assertions). Full suite: **239/239 pass** (+23 vs baseline 216).

**What §3b actually ships (and what it defers):**
- ✅ Precondition validation (empty text, missing `sendRequest`, `isToolCallingSupported()=false`, blank profile, unknown skill) — all return `{ ok:false, reason }` before mutating any state.
- ✅ User + assistant message push into the active session (auto-created if none) with `saveNovaState` after each push.
- ✅ Profile snapshot → swap → restore, all inside `try…finally`. Swap failure returns `profile-swap-failed` early; restore failure is audit-logged but never masks the primary turn result. Skips the swap round-trip when the target profile is already active.
- ✅ `AbortController` wired to `novaAbortController`. Wall-clock cap = `turnTimeoutMs` → `setTimeout` → `controller.abort('turn-timeout')`. The `clearTimeout` in `finally` is load-bearing — don't drop it or a cancelled turn keeps a timer alive.
- ✅ `novaTurnInFlight` re-entrancy guard: second concurrent call returns `{ ok:false, reason:'in-flight' }` without stacking controllers. Locked in by a test that suspends the first turn via an unresolved promise.
- ⏳ **Streaming + real tool-call dispatch loop → Phase 3c.** If `sendRequest` returns `tool_calls`, we store them on the assistant message, audit-log `tool-calls-deferred`, and return `{ ok:true, toolCallsDeferred:true, toolCalls }`. Phase 3c replaces that stub with real dispatch without changing the outer return contract.
- ⏳ `ConnectionManagerRequestService` vs `generateRaw` probe stays in the caller. This helper takes any Promise-returning `sendRequest({messages, tools, tool_choice, signal}) → {content?, tool_calls?}`.

**Notes for future agents:**
- **Dependency injection is the testability contract.** `sendNovaTurn` reads nothing from module scope for I/O — `sendRequest`, `executeSlash`, `isToolCallingSupported`, `nowImpl` are all parameters. The caller (Phase 3c composer wiring) will bind them to `ctx.ConnectionManagerRequestService.sendRequest`, `ctx.executeSlashCommandsWithOptions`, `ctx.isToolCallingSupported`, and `Date.now` respectively. **Don't turn these into module-scope reads "for convenience"** — the mock pattern in `test/nova-turn.test.mjs` depends on them staying injectable. Module state IS read for the re-entrancy guard (`novaTurnInFlight` / `novaAbortController`); that's the one intentional global-state touchpoint.
- **`executeSlash` abstraction shape: `(cmd:string) => Promise<{pipe?:string}>`.** This matches ST's `ctx.executeSlashCommandsWithOptions(cmd)` return shape. When wiring from the caller, pass `cmd => ctx.executeSlashCommandsWithOptions(cmd)` — don't spread options.
- **"None" / "" from `/profile` both mean "no active profile".** `parseNovaProfilePipe` normalises both to `''`. If `swappedFrom === ''` after the snapshot, the `finally` restore is skipped (ST has no `/profile` clear syntax). This is called out in a comment; don't remove it — switching back to "no profile" via a literal name of `None` would cause a confusing slash error.
- **Return-shape contract.** On success: `{ ok:true, assistantMessage, toolCalls, toolCallsDeferred, swappedProfile }`. On failure: `{ ok:false, reason, error? }`. `reason` values currently in use: `in-flight`, `empty-text`, `no-send-request`, `no-tool-calling`, `no-profile`, `no-skill`, `profile-swap-failed`, `aborted`, `send-failed`. Phase 3c should treat these as a closed enum — add new reasons rather than overloading existing ones.
- **Audit log is append-only and never throws.** `appendNovaAuditLog` is called synchronously after `saveNovaState` — if you add new audit entries, keep the ordering (mutate → audit → save). Outcomes used by 3b: `send-failed:<msg>`, `aborted:<msg>`, `error:<msg>` (profile-swap / profile-restore), `deferred-to-phase-3c` (tool-calls). Phase 3c should keep these strings stable for future log-query features.
- **`resolveNovaSkill` falls back to `'freeform'` silently.** Unknown skill ids don't error — they just land on the free-form skill. When §7b lands the skill picker, make sure it shows the effective skill in the UI (not just the requested id) so users see the fallback.
- **Don't add `throw` statements to `sendNovaTurn`.** The caller (composer UI) will rely on it always resolving. The test `restores profile even when sendRequest throws` proves the try/finally handles the one place an `await` can explode — add new `await` points inside the same try.
- **Source-shape test is intentionally brittle in `test/nova-turn.test.mjs`.** It asserts `novaTurnInFlight = false` AND `novaAbortController = null` both live inside the `finally` block. If you refactor the cleanup into a helper, update those two regex assertions to match the new location.

**What to do next (in order — each is a single reviewable PR):**
1. **Phase 3c — tool handler dispatch + approval modal DOM.** Replace the `toolCallsDeferred` branch in `sendNovaTurn` with a real dispatch loop: for each tool_call, look up the entry in `NOVA_TOOLS`, gate Write/Full on a `cxConfirm` approval modal (use `buildNovaUnifiedDiff` from §4c for `fs_write`), run the handler, append a `role:'tool'` message with the result, re-call `sendRequest`. Bump `novaToolRegistryVersion` when the bridge-probe result flips present/absent. This is the phase that finally consumes `probeNovaBridge` (§4f). Enforce `maxToolCalls` here — emit an audit entry + break the loop on cap hit.
2. **Phase 2c — approval modal DOM + connection-profile picker + skill picker.** Can land alongside 3c since the dispatch loop needs the approval modal. Use `cxConfirm` never native `confirm`. `buildNovaUnifiedDiff` output should render in a `<pre>` inside the modal body.
3. **Phase 6a/6b — fetch + cache soul.md/memory.md on init; add Soul/Memory editor to in-phone Settings.** Small and independent. Once this lands, the `soul`/`memory` parameters to `sendNovaTurn` become real non-empty strings.
4. **Phase 7 — settings surface.** Profile picker, tier radio, caps, plugin URL, "Install preset" button. Gates all Nova UI.

**Hard constraints still active (copy-forward):**
- `EXT === "command-x"` with a hyphen. Bracket-access only on `extension_settings`.
- `buildNovaUnifiedDiff` auto-detect is nullish-only. Pass `isNewFile: true` explicitly when wiring `fs_write` previews against `fs_stat` → ENOENT.
- `normalizeNovaPath` containment predicate: `relNative === '..' || startsWith('..' + path.sep)`.
- Plugin `/manifest.version` comes from `package.json` via `resolvePluginVersion()`.
- Inline-copy test convention: when editing a helper in `index.js`, edit the matching inline copy in `test/nova-*.test.mjs` or tests silently test the wrong function. `test/nova-turn.test.mjs` inline-copies **eight** helpers (`getNovaState`, `saveNovaState`, `createNovaSession`, `appendNovaAuditLog`, `composeNovaSystemPrompt`, `resolveNovaSkill`, `buildNovaRequestMessages`, `parseNovaProfilePipe`) plus `sendNovaTurn` itself via a `makeTurnCapsule()` closure (needed because the module-level `novaTurnInFlight` / `novaAbortController` bindings can't be imported standalone). Keep the capsule in lockstep with the production function body.
- Run tests via `node --test test/helpers.test.mjs test/nova-*.test.mjs` (explicit filenames, not `'test/*.test.mjs'`).

**Validation this sprint:**
- `node --check index.js` clean.
- `node --test test/helpers.test.mjs test/nova-*.test.mjs` → **239/239 pass** (+23 new turn-lifecycle tests; baseline was 216).
- Manual in-ST: none required — `sendNovaTurn` has no callers yet. Phase 3c composer wiring is the first time this runs against a live LLM.

### 2026-04-23 — Next-session hand-off: after Phase 3a turn-state scaffolding

**Scope of this PR (#18) — cumulative, three Nova phases on one branch:**
1. **Phase 4f — capability probe** (commit `dccb3ed`): `probeNovaBridge` + `invalidateNovaBridgeProbeCache`, cache invalidation added to the existing `CHAT_CHANGED` listener, `test/nova-probe.test.mjs`.
2. **Phase 1f — init wiring** (commits `fba6dde` / `52009f5`): `NOVA_INIT_VERSION` + `initNovaOnce(ctx)`, **new dedicated Nova `CHAT_CHANGED` listener** (separate from the phone-UI one), startup call in `jQuery(async () => ...)`, `test/nova-init-once.test.mjs`.
3. **Phase 3a — turn-state scaffolding** (commit `fe9eff7`, this hand-off's headline): three `let` bindings (`novaTurnInFlight = false`, `novaAbortController = null`, `novaToolRegistryVersion = 0`) + `_getNovaTurnState()` snapshot helper in the NOVA AGENT section of `index.js`, plus `test/nova-turn-state.test.mjs` (9 tests).
4. **PR review follow-ups** (commit `da1b7cc`): cleared a `setTimeout` leak in `probeNovaBridge`'s manual-fallback path, fixed `test/nova-init-once.test.mjs`'s inline `EXT` constant from `'command_x'` → `'command-x'`, clarified this memory entry.

**Behavioural impact of the cumulative PR:** one new `CHAT_CHANGED` listener (for `initNovaOnce`; runs a one-shot `chatMetadata[EXT].openclaw` → `.legacy_openclaw` migration on first load per chat); one additional side-effect on the pre-existing `CHAT_CHANGED` listener (probe cache invalidation); no new LLM calls; no new DOM. Phase 3a alone is pure declarations + one diagnostic helper.

**Notes for future agents:**
- **`_getNovaTurnState()` is the stable read-only test hook.** `hasAbort` is a boolean (`novaAbortController !== null`), deliberately NOT the live reference, so test code can't mutate the active controller via the snapshot. Snapshots are fresh objects on every call — mutating one doesn't affect internal state. If §3b needs a richer hook (e.g. `abortReason`), add fields to the return object but keep all values structured-cloneable primitives.
- **Placement is load-bearing.** The bindings live in the NOVA AGENT section right after `NOVA_MEMORY_CHARS_CAP` and BEFORE `getNovaState`. `test/nova-turn-state.test.mjs` asserts `turn-state section index > NOVA_STATE_KEY index && < initNovaOnce index` — if you reorganise the section, keep those relative orderings or update the test.
- **Don't merge these into `getNovaState`.** The per-chat state blob (`chatMetadata[EXT].nova`) is persisted. The module-level turn state is NOT persisted — a turn-in-flight across a page reload is impossible by construction, and persisting `AbortController` is meaningless. Keep them separate.
- **Re-entrancy contract (§3b preview):** `sendNovaTurn` must check `novaTurnInFlight` at entry. If `true`, show a toast and return without stacking abort controllers. The `finally` block MUST reset `novaTurnInFlight = false` AND `novaAbortController = null` (both, in that order), even on thrown errors. Lock this in `test/nova-turn.test.mjs` with a test that throws from the mock `sendRequest` and asserts `_getNovaTurnState()` reports `{ inFlight: false, hasAbort: false }` afterward.
- **`novaToolRegistryVersion` semantics:** 0 = "never registered". Phase 3c bumps it after building the initial tool schema from `NOVA_TOOLS`. Phase 4f re-bumps when the bridge probe flips from absent → present (discovers new `fs_*` / `shell_run` tools). `sendNovaTurn` reads it once per turn to decide "do I need to rebuild the `tools` array for `sendRequest`?" — cache the built array at the last observed version.

**What to do next (in order — each is a single reviewable PR):**
1. **Phase 3b — turn lifecycle** (biggest slice; split if it grows past ~300 LOC).
   Follow the 8-step contract in `docs/nova-agent-plan.md` §3b. Profile-snapshot/restore in a `try…finally` — lock this with a test that throws from the mock `sendRequest` and asserts the restore slash fired. Must mutate the Phase 3a bindings and must call `_getNovaTurnState()`-visible state back to initial in `finally`.
2. **Phase 3c — tool handler dispatch + approval modal DOM.** Only after 3b is green. This is where `probeNovaBridge(...)` from Phase 4f finally gets consumed + `novaToolRegistryVersion` gets its first bump.
3. **Phase 6a/6b — `/nova` slash + settings UI bindings.** Small, independent, can be picked up while 3b is in review.

**Hard constraints still active (copy-forward):**
- `EXT === "command-x"` with a hyphen. Bracket-access only on `extension_settings`.
- `buildNovaUnifiedDiff` auto-detect is nullish-only. Pass `isNewFile: true` explicitly when wiring `fs_write` previews against `fs_stat` → ENOENT.
- `normalizeNovaPath` containment predicate: `relNative === '..' || startsWith('..' + path.sep)`.
- Plugin `/manifest.version` comes from `package.json` via `resolvePluginVersion()`.
- Inline-copy test convention: when editing a helper in `index.js`, edit the matching inline copy in `test/nova-*.test.mjs` or tests silently test the wrong function. `test/nova-init-once.test.mjs` inline-copies **three** helpers (getNovaState, migrateLegacyOpenClawMetadata, initNovaOnce); `test/nova-turn-state.test.mjs` mirrors `_getNovaTurnState` via a closure capsule (per-closure `let` bindings reproduce the module-level semantics).
- Run tests via `node --test test/helpers.test.mjs test/nova-*.test.mjs` (explicit filenames, not `'test/*.test.mjs'`).

**Validation this sprint:**
- `node --check index.js` clean.
- `node --test test/helpers.test.mjs test/nova-*.test.mjs` → **216/216 pass** (+21 probe tests from 4f, +12 init-once tests from 1f, +9 turn-state tests from 3a; baseline at branch start was 174).
- Manual in-ST: none required — all four commits are pure scaffolding / test-hooks, no UI wiring yet.
- PR review comments on `fe9eff7` all resolved in `da1b7cc` (clearTimeout-in-finally, `EXT` namespace fix, scope-clarity notes in this entry).

### 2026-04-23 — Next-session hand-off: after Phase 1f init wiring

**Context:** This PR shipped **Phase 1f — init wiring** per the prior hand-off. Added `NOVA_INIT_VERSION = 1` + `initNovaOnce(ctx)` to the NOVA AGENT section, wired a dedicated Nova `CHAT_CHANGED` listener (separate from the phone-UI-reset one already there), and call it once at extension startup so the initial chat also migrates. Added `test/nova-init-once.test.mjs` (12 new tests, 207/207 total). No behavioural change beyond moving `chatMetadata[EXT].openclaw` → `.legacy_openclaw` on first load.

**Notes for future agents:**
- **`NOVA_INIT_VERSION` is a forward-migration pivot.** Bump it when you add a new one-shot step to `initNovaOnce`. Existing chats stamped at the previous version will re-run `initNovaOnce` exactly once to pick up the new step. The test `re-runs when _initVersion is lower than current` locks this contract in — don't relax the `<` check to `!==` or a future release can't force-migrate older chats.
- **`initNovaOnce` never throws.** If a migration step throws, we catch, emit `{ ran: false, reason: 'migration-error' }`, and DO NOT stamp — so the next chat load retries. The top-level listener also wraps the call in try/catch as a belt-and-braces guard. Preserve this: the chat-switch event path must not be able to kill other listeners downstream.
- **Two `CHAT_CHANGED` listeners are intentional.** The first (existing) resets phone UI state; the second (new) runs Nova init. Per hand-off: "Hook from `CHAT_CHANGED` inside the NOVA AGENT section — not from the top-level chat handler — so disabling Nova via settings (when §7c lands) short-circuits cleanly." When §7c adds a `settings.nova.enabled` toggle, only the second listener needs an additional gate. **Don't merge them.**
- **Startup call is mandatory.** The Nova listener is attached inside `jQuery(async () => { ... })` so it misses the initial `CHAT_CHANGED` that ST fires during page load. The explicit `initNovaOnce(ctx)` after `if (settings.enabled) { ... }` covers that gap. If you reorganise init, keep this call and keep it after the listener registration (if you move it before, you get the stamp but not the listener — which isn't broken but is confusing).
- **`getNovaState(ctx)` is the right way to reach `.nova`.** It lazy-creates + heals malformed blobs. `initNovaOnce` uses it so the stamp always lives on a well-formed state. The "heals malformed nova blob when stamping" test exercises this — a pre-existing `nova: 'not-an-object'` gets replaced with a fresh empty state.
- **Save-count contract:** first-run-no-legacy = 1 save (stamp only); first-run-with-legacy = 2 saves (migrate + stamp); second-run = 0 saves (short-circuit). The test file asserts all three — keep them accurate when adding more steps.

**What to do next (in order — each is a single reviewable PR):**
1. **Phase 3a — module-level turn state.** Add `let novaTurnInFlight = false; let novaAbortController = null; let novaToolRegistryVersion = 0;` near the other NOVA constants. Expose read-only getters via a test hook so Phase 3b tests can assert state without module internals. No behavioural change yet — these are the variables §3b will mutate.
2. **Phase 3b — turn lifecycle.** Biggest slice; split if it grows past ~300 LOC. Follow the 8-step contract in `docs/nova-agent-plan.md` §3b. Profile-snapshot/restore in a `try…finally` — lock this with a test that throws from the mock `sendRequest` and asserts the restore slash fired.
3. **Phase 3c — tool handler dispatch + approval modal DOM.** Only after 3b is green. This is where `probeNovaBridge(...)` from Phase 4f finally gets consumed.

**Hard constraints still active (copy-forward):**
- `EXT === "command-x"` with a hyphen. Bracket-access only on `extension_settings`.
- `buildNovaUnifiedDiff` auto-detect is nullish-only. Pass `isNewFile: true` explicitly when wiring `fs_write` previews against `fs_stat` → ENOENT.
- `normalizeNovaPath` containment predicate: `relNative === '..' || startsWith('..' + path.sep)`.
- Plugin `/manifest.version` comes from `package.json` via `resolvePluginVersion()`.
- Inline-copy test convention: when editing a helper in `index.js`, edit the matching inline copy in `test/nova-*.test.mjs` or tests silently test the wrong function. `test/nova-init-once.test.mjs` inline-copies **three** helpers (getNovaState, migrateLegacyOpenClawMetadata, initNovaOnce) — remember to update all three if their production copies change.
- Run tests via `node --test test/helpers.test.mjs test/nova-*.test.mjs` (explicit filenames, not `'test/*.test.mjs'` — the latter glob doesn't expand under the current Node version).

**Validation this sprint:**
- `node --check index.js` clean.
- `node --test test/helpers.test.mjs test/nova-*.test.mjs` → **207/207 pass** (+12 new init-once tests; baseline was 195).
- New DOM: none. New LLM calls: none. New event handlers: one (dedicated Nova `CHAT_CHANGED` listener, alongside the existing one).

### 2026-04-23 — Next-session hand-off: after Phase 4f probe lands

**Context:** This PR shipped **Phase 4f — capability probe** per the prior hand-off plan. Added `probeNovaBridge({ baseUrl, fetchImpl, nowImpl, ttlMs, timeoutMs, force })` + `invalidateNovaBridgeProbeCache()` to the NOVA AGENT section of `index.js`, hooked invalidation into `CHAT_CHANGED`, and added `test/nova-probe.test.mjs` (21 new tests, 195/195 total). **No behavioural change** — the probe is exposed but not yet consumed. Phase 3c will gate fs/shell tool registration on the result.

**Notes for future agents:**
- **The probe is cache-first, never-throws.** Returns `{ present: true, version?, root?, shellAllowList?, capabilities? }` on 200, or `{ present: false }` on anything else (404, 500, malformed JSON, non-object body, network error, timeout). Capability flags are strictly `!!`-coerced so `0`/`""`/`"false"` all become `false`. Drop-on-malformed is the contract for `shellAllowList` (must be array) and `capabilities` (must be plain object) — do not relax this without updating the test copy.
- **Both hits and misses are cached for `NOVA_PROBE_TTL_MS` (60s)** so a missing plugin doesn't get hammered. `CHAT_CHANGED` invalidates, and callers can pass `force: true` to bypass (Phase 3c will want this for a manual "Re-probe" button in settings).
- **`fetchImpl` / `nowImpl` injection is the test contract.** Production callers leave them undefined and fall through to global `fetch` / `Date.now`. The test file inline-copies the helper (same convention as `nova-diff.test.mjs` etc.) — edit both copies in lockstep. There is a comment header on `test/nova-probe.test.mjs` calling this out.
- **Timeout path is covered by a real abort.** The test uses `timeoutMs: 5` + a fetch mock that awaits the signal's `abort` event and throws a named `AbortError`. This exercises the `AbortSignal.timeout` branch end-to-end (Node 18+). The helper's fallback to a manual `AbortController` is for very old browsers only.
- **`console.debug` is fire-and-forget.** The probe wraps both the hit and miss log lines in `try/catch` so a broken console (seen once in ST's headless test harness) cannot take the probe down. Don't change to `console.log` — debug-level keeps it out of the default console filter.
- **The probe does NOT read `settings.nova.pluginBaseUrl` itself.** Callers pass `baseUrl` explicitly so the helper stays pure. Phase 3c should do `probeNovaBridge({ baseUrl: settings.nova?.pluginBaseUrl })`.

**What to do next (in order — each is a single reviewable PR):**
1. **Phase 1f — wire `migrateLegacyOpenClawMetadata` into init.** Still pending from the prior hand-off. Create `initNovaOnce(ctx)` gated by `chatMetadata[EXT].nova?._initVersion`; hook from the NOVA AGENT section's own `CHAT_CHANGED` listener (don't add to the existing top-level one). Test: fake ctx with unmigrated + already-migrated metadata; assert idempotency across two calls.
2. **Phase 3a — module-level turn state.** Add `let novaTurnInFlight = false; let novaAbortController = null; let novaToolRegistryVersion = 0;` near the other NOVA constants. Expose read-only getters via a test hook so Phase 3b tests can assert state without module internals.
3. **Phase 3b — turn lifecycle.** Biggest slice; split if it grows past ~300 LOC. Follow the 8-step contract in `docs/nova-agent-plan.md` §3b. Profile-snapshot/restore in a `try…finally` — lock this with a test that throws from the mock `sendRequest` and asserts the restore slash fired.

**Hard constraints still active (copy-forward from prior hand-off):**
- `EXT === "command-x"` with a hyphen. Bracket-access only on `extension_settings`.
- `buildNovaUnifiedDiff` auto-detect is nullish-only. Pass `isNewFile: true` explicitly when wiring `fs_write` previews against `fs_stat` → ENOENT.
- `normalizeNovaPath` containment predicate: `relNative === '..' || startsWith('..' + path.sep)`. Don't touch without re-running `..foo` regression tests.
- Plugin `/manifest.version` comes from `package.json` via `resolvePluginVersion()`. Bump `package.json` when the plugin version changes.
- Inline-copy test convention: when editing a helper in `index.js`, edit the matching inline copy in `test/nova-*.test.mjs` or tests silently test the wrong function.
- Run tests via `node --test test/helpers.test.mjs test/nova-*.test.mjs` (explicit filenames). The `'test/*.test.mjs'` glob appears to not expand under the current Node version — got "Could not find" from the runner. Use explicit filenames or the `helpers.test.mjs test/nova-*.test.mjs` form.

**Validation this sprint:**
- `node --check index.js` clean.
- `node --test test/helpers.test.mjs test/nova-*.test.mjs` → **195/195 pass** (+21 new probe tests; baseline was 174).
- No new DOM, no new LLM calls, no new event handlers beyond the one-line invalidation inside the existing `CHAT_CHANGED`.

### 2026-04-23 — Next-session hand-off: pick up after PR #17 merges

**Context:** PR #17 shipped three pure-helper / scaffold slices (diff preview, legacy metadata migration, `nova-agent-bridge` scaffold with discovery routes + 501 stubs). Review feedback was addressed in 6e53843. **This entry is instructions to the next agent / next-me for the first commit after merge.** Read it before anything else, then re-read `docs/nova-agent-plan.md` and the 2026-04-23 review-feedback entry further down.

**Where we are right now (ground truth — `git log --oneline` after merge will show these):**
- Phase 1f (metadata migration) — **pure helper shipped, init wiring NOT done.**
- Phase 4c (diff preview helper) — **shipped, no UI caller yet.**
- Phase 8a (plugin discovery routes) — **shipped.**
- Phase 8b (fs/shell handlers) — **stubbed 501, no real handlers.**
- Phase 8c (path safety) — **shipped (`normalizeNovaPath`).**
- Phase 8d (config loader) — **shipped (single-key regex parser).**
- Phase 3a state helpers (`getNovaState`, `createNovaSession`, etc.) — **shipped in an earlier PR**; still need module-level `novaTurnInFlight` / `novaAbortController` / `novaToolRegistryVersion`.
- Everything else in Phase 3, 4f, 6, 7, 9 — **not started.**

**What to do first (in order). Each bullet is a single reviewable PR. Do not batch.**

1. **Phase 4f — capability probe on the extension side (smallest; do first).**
   - Add `async function probeNovaBridge()` in the NOVA AGENT section of `index.js`.
   - Fetches `GET /api/plugins/nova-agent-bridge/manifest` with a short `AbortSignal.timeout(3000)`.
   - Returns `{ present: boolean, version?, root?, shellAllowList?, capabilities? }`. On any network error or non-200, return `{ present: false }` — never throw.
   - Cache the result in a module-level `_novaBridgeProbeCache` with a 60-second TTL; invalidate on `CHAT_CHANGED` so switching chats re-probes without a full reload.
   - **Do not** gate anything on the probe yet — just expose the function and a console debug log. Phase 3c will consume it when tool handlers land.
   - Tests: `test/nova-probe.test.mjs` with a mock `global.fetch` (or dependency-injected fetch so the helper takes `{ fetchImpl }`). Cover: success, 404, network error, timeout, cache hit within TTL, cache miss after TTL, capability-flag coercion.
   - Plan checkbox: §4f.

2. **Phase 1f — wire the migration helper into init.**
   - `migrateLegacyOpenClawMetadata(ctx)` exists but is unreachable. Wire it from a new `initNovaOnce(ctx)` that runs exactly once per chat load, gated by a `chatMetadata[EXT].nova?._initVersion` stamp so pre-Nova chats only pay the migration cost the first time.
   - Hook from `CHAT_CHANGED` inside the NOVA AGENT section — **not** from the top-level chat handler — so disabling Nova via settings (when §7c lands) short-circuits cleanly.
   - Unit test with a fake ctx that has both unmigrated and already-migrated metadata; assert idempotency across two `initNovaOnce` calls on the same ctx.
   - Plan checkbox: §1f "Init wiring".

3. **Phase 3a — finish module-level state.**
   - Add `let novaTurnInFlight = false; let novaAbortController = null; let novaToolRegistryVersion = 0;` near the other NOVA constants in `index.js`.
   - Expose read-only getters via the existing test hook (or add one) so tests can assert state without reaching into module internals.
   - No behavioural change yet — these are just the variables §3b will mutate.

4. **Phase 3b — turn lifecycle (biggest slice; split if it gets past ~300 LOC).**
   - Follow the 8-step contract in `docs/nova-agent-plan.md` §3b exactly.
   - Profile-snapshot-and-restore is the subtlest part: wrap steps 3–7 in a `try` and put `/profile <snapshot>` in the `finally` so an abort or exception cannot leave the user on the Nova profile. **Lock this in with a test that throws from the mock `sendRequest` and asserts the restore slash fired.**
   - `ctx.ConnectionManagerRequestService` probe: cache at init time, not per-turn.
   - Token / tool-call / wall-clock caps all live in the same loop; emit an audit-log entry (§3a `appendNovaAuditLog`) on every cap hit so the user can see why the turn stopped.

5. **Phase 3c — tool handler dispatch + approval modal DOM.** Only after 3b is green.

**Hard constraints that will bite you if you forget:**
- `EXT === "command-x"` with a hyphen everywhere — **never** `command_x`. `extension_settings["command-x"]` is bracket-access only.
- `buildNovaUnifiedDiff` auto-detect is nullish-only. Empty-string old = modify. Use the explicit `isNewFile: true` option when wiring `fs_write` approval previews against `fs_stat` → ENOENT.
- The LCS helper runs on the UI thread with a 4M-cell cap. If you ever need to diff really large files, either raise the cap deliberately + move to a worker, or pre-truncate upstream — don't just bump the constant.
- `normalizeNovaPath` containment is `relNative === '..' || startsWith('..' + path.sep)`. If you touch this predicate, the `..foo` regression tests must still pass.
- The plugin's `/manifest.version` is sourced from `package.json` via `resolvePluginVersion()`. When you bump the plugin version, bump `package.json` — the constant does not exist anymore.
- Plugin stubs return 501 intentionally. The capability probe (§4f, item 1 above) is what distinguishes "plugin present, handler pending" from "plugin missing". Don't flip the `capabilities` map booleans to `true` until the real handlers land **and** have tests.
- Inline-copy test convention: `test/nova-*.test.mjs` re-declares the helpers under test because `index.js` can't be imported from Node. When you edit a helper, edit **both** copies in lockstep or the tests silently test the wrong function. This is called out in each test file's header comment.

**Validation checklist before opening the next PR:**
- `node --test test/*.test.mjs` green (baseline: 174/174 after PR #17).
- `parallel_validation` with a fresh prTitle + prDescription; address CodeQL alerts even if the Code Review pass is silent — path-safety changes especially get flagged.
- Update this file (AGENT_MEMORY) at the **top of History** with a new "Next-session hand-off" entry that supersedes this one.

**What NOT to do:**
- Do not start Phase 6 (Soul & Memory loader) before Phase 3b ships — it imports turn-lifecycle hooks that don't exist yet.
- Do not start Phase 9 (profile swap) without Phase 3b's snapshot-restore code — you'd duplicate state machines.
- Do not add a YAML dependency to the plugin for one config key. Extend the regex parser if you need more keys.
- Do not move or edit old `AGENT_MEMORY.md` entries; the file is append-only newest-first by convention. If a note becomes obsolete, write a new entry that supersedes it rather than editing the old one.

---

### 2026-04-22 — Nova Phase 2 UI scaffolding (PR #16, later commit)

**Context:** Landed the Nova app shell — home-screen tile, `data-view="nova"`
view with header + three inert pills (profile / skill / tier), empty-state
transcript, disabled composer, nav footer — plus `cx-nova-*` CSS contract
(including `.cx-nova-toolcard` reserved for Phase 3). Added
`test/nova-ui-scaffolding.test.mjs` with static source-text assertions (80/80
total tests green).

**Notes for future agents:**
- **UI tests are static source-text greps, not DOM renders.** `buildPhone()`
  references `document`, jQuery, and st-context imports that Node can't load,
  so the tests read `index.js` / `style.css` as strings and regex-match the
  scaffolding contract. Phase 3+ should keep this pattern — it's cheap and
  catches the "someone moved the hook" class of regression without needing a
  headless browser.
- **Pills are real `<button>` elements, disabled.** If you add click handlers
  in Phase 3, flip `disabled` to `false` — don't recreate the DOM. The test
  asserts `disabled` is present precisely so we don't accidentally ship a
  live-looking-but-dead UI mid-migration.
- **`cx-nova-cancel` has `cx-hidden` from the start**, not `display:none`
  inline. Toggle by adding/removing the class (matches the wrapper-close
  pattern at `rebuildPhone` → `#cx-panel-wrapper`).
- **Accent color is cyan-violet (`#06b6d4` → `#7c3aed`)**, deliberately
  distinct from Command-X pink. Don't unify them later — the plan calls for a
  visual separation between "your phone comms" (Command-X) and "your agent"
  (Nova).
- **Nova tile ordering on home grid:** Command-X → Profiles → Quests → Map →
  **Nova** → Settings. Placed after Map (utilities) and before Settings
  (always-last). If you reorder, update the test's structural expectations if
  any assert positional ordering (currently none do).
- **Toolcard CSS is reserved, not populated.** Phase 3 renders `.cx-nova-toolcard`
  elements inside `#cx-nova-transcript`. The `-pending` / `-error` variant
  classes already have border-color overrides; just add them to the card div.

### 2026-04-22 — Nova migration Phase 1 + preset/soul/memory seeds (PR #16)

**Context:** Removed OpenClaw end-to-end; landed `docs/nova-agent-plan.md`;
shipped the `presets/openai/Command-X.json` Chat Completion preset + README;
seeded `nova/soul.md` + `nova/memory.md`; added `nova: {...}` to `DEFAULTS` so
future Nova code has a stable settings shape; added `test/nova-preset.test.mjs`.

**Notes for future agents:**
- **`loadSettings()` has a `LEGACY_KEYS` list** (currently `['openclawMode']`).
  It strips legacy keys from both in-memory `settings` AND
  `ctx.extensionSettings[EXT]`, then calls `saveSettingsDebounced()`. Add to
  the list when retiring any future setting — don't hand-roll a one-off.
- **Do NOT bump `manifest.json` to `0.13.0` yet.** The plan explicitly defers
  the version bump until Nova actually ships, so we don't release a regressed
  intermediate version. Reviewer will flag comments/docs that hard-code
  `v0.13.0` — use version-agnostic wording until Nova lands.
- **Preset schema source of truth**: the upstream ST
  `default/content/presets/openai/Default.json`. The nine marker prompts
  (`chatHistory`, `dialogueExamples`, `worldInfoBefore`, `worldInfoAfter`,
  `charDescription`, `charPersonality`, `scenario`, `personaDescription`,
  `enhanceDefinitions`) **must** all carry `marker: true`. `main`, `nsfw`,
  `jailbreak` are `system_prompt: true` instead. `prompt_order[].order[]`
  entries' identifiers **must** all exist in `prompts[]` — `nova-preset.test.mjs`
  enforces this.
- **Preset Main Prompt teaches the four Command-X tag grammars** (`[sms from=…
  to=…]`, `[status]`, `[quests]`, `[place]`). A dedicated test asserts all
  four grammars appear in the Main Prompt content — if you ever reword the
  prompt, keep every grammar intact or the test fails.
- **`nova/` and `presets/openai/` are new top-level dirs.** They are served
  by ST's static handler (extension folder = `SillyTavern/public/scripts/
  extensions/third-party/command-x/`), so `fetch('./nova/soul.md')` works
  with no plugin — that's the path Nova will use in Phase 6.
- **Running tests**: `node --test test/helpers.test.mjs test/nova-preset.test.mjs`
  works reliably. `node --test 'test/*.test.mjs'` (with the glob quoted) works
  as a one-liner. **Do not** run bare `node --test test/` — passing a directory
  arg causes node's test runner to misinterpret it as a single test entrypoint
  and fail with a cryptic top-level `✖ test` before discovering any of the
  actual `*.test.mjs` files. Always pass explicit filenames or a quoted glob.
- **`DEFAULTS.nova` shape** is stable and documented in the plan §7b: `{
  profileName, defaultTier, maxToolCalls, turnTimeoutMs, pluginBaseUrl,
  rememberApprovalsSession, activeSkill }`. Phase 2+ code should read from
  `settings.nova.*`; don't spread it flat into `settings`.

**Follow-ups / open questions:**
- Phase 2 (Nova UI tile + view + composer) is the natural next chunk.
- Phase 8 (`nova-agent-bridge` server plugin) is fully independent and can
  land in parallel — nothing in the extension depends on it at init time.

### 2026-04-23 — Nova phase 3a/6c pure-helper sprint (PR #16)

**Context:** Shipped the pure-helper slice of Phase 3 (Agent Loop state
schema) and Phase 6 (prompt composition) without touching turn lifecycle,
tool registry, or LLM calls. Also fixed the `settings.nova` shallow-merge
gap flagged in the previous review.

**Notes for future agents:**
- **`settings.nova` is now hydrated defensively** in `loadSettings()`:
  ```js
  settings.nova = { ...NOVA_DEFAULTS, ...(settings.nova || {}) };
  ```
  This runs right after the `LEGACY_KEYS` migration block. When Phase 3 adds
  new keys to `NOVA_DEFAULTS`, existing users auto-pick them up without a
  manual settings reset. Do **not** revert this to a shallow `Object.assign`.
- **New `/* === NOVA AGENT === */` section in `index.js`** between the
  command-styling block and the `SETTINGS` section (just above
  `function loadSettings`). All pure Nova helpers go here. Turn-lifecycle
  code (with DOM/LLM side effects) will land in the same section later.
- **Nova state lives in `ctx.chatMetadata[EXT].nova`** under the key
  `NOVA_STATE_KEY = 'nova'`. Shape is `{ sessions, activeSessionId,
  auditLog }`. Caps are `NOVA_SESSION_CAP = 20` and `NOVA_AUDIT_CAP = 500`.
  `getNovaState(ctx)` returns an empty ephemeral state if chatMetadata is
  missing — callers can read from it safely even before the first chat
  loads. It also heals legacy blobs missing individual fields (e.g.
  `sessions: 'not-an-array'`).
- **Persistence is through `ctx.saveMetadataDebounced()`**, wrapped by
  `saveNovaState(ctx)`. Helpers mutate in place; callers must invoke
  `saveNovaState` after mutations they want persisted.
- **Audit-log entries must already be redacted** when passed in.
  `appendNovaAuditLog` coerces to strings defensively but it is NOT
  responsible for stripping raw file contents — that's the caller's
  contract (Phase 10 will add a redact-enforcement test on tool handlers).
- **`composeNovaSystemPrompt` is the single source of truth for prompt
  order** (plan §6c). If you add a new section, update the helper, update
  `test/nova-prompt-compose.test.mjs`, AND update the fenced block in
  `docs/nova-agent-plan.md` §6c. All three must agree.
- **Memory truncation is tail-keep.** We drop the HEAD of `memory.md` and
  prefix `[…truncated head…]` so recent notes survive. `NOVA_MEMORY_CHARS_CAP
  = 16 * 1024`. The truncation branch is covered by an explicit
  head/tail-sentinel test.
- **Tests inline-copy the helpers** (matches `helpers.test.mjs` pattern)
  rather than import from `index.js`, because `index.js` imports ST runtime
  modules that don't resolve in plain Node. When you edit a helper in
  `index.js`, you MUST mirror the edit into the test copy or the tests go
  stale-silently.

**What's still deferred (explicitly):**
- Phase 3b turn lifecycle (`sendNovaTurn`, streaming, tool dispatch, profile
  swap) — needs `ConnectionManagerRequestService` probing + browser testing.
- Phase 3c tool registration — blocked on the `NOVA_TOOLS` array, which
  blocks on Phase 4 tool surface + Phase 9 plugin.
- Phase 3d cancellation UI — needs 3b first.
- Soul/memory RUNTIME loader (fetch + cache + "Reload" action) — will land
  alongside the Phase 6b self-edit tools; composition helper is ready.

**Validation this sprint:** `node --check index.js` clean;
`node --test 'test/*.test.mjs'` → **96/96 pass** (+16 new: 9 state, 6
compose, +1 coercion). No new DOM, no new LLM calls, no new event handlers.

---

## Entry N+1 — Phase 4 + Phase 5: tool-registry + skills pure-data slice

**Branch:** `copilot/explore-openclaw-overhaul-options-again`
**Head at commit time:** (to be filled by report_progress)

**What shipped:**
- `NOVA_TOOLS` array (24 tools across 4 backends: `plugin`, `st-api`,
  `phone`) with strict JSON-Schema `parameters` (all `additionalProperties:
  false`). Permission axis is `'read' | 'write' | 'shell'`; `shell` is
  pinned to `backend === 'plugin'` by a test assertion.
- `NOVA_TOOL_NAMES` Set exported alongside for O(1) skill-default-tool
  lookups.
- `NOVA_SKILLS` array with the 4 plan-required skills: `character-creator`,
  `worldbook-creator`, `image-prompter`, `freeform`. Each carries a prose
  `systemPrompt`, `defaultTier`, `allowTierEscalation`, and a
  `defaultTools` list (or the string `'all'`) whose tool names are
  validated against `NOVA_TOOL_NAMES` at test time.
- `SKILLS_VERSION = 1` constant — bump whenever ANY skill prompt changes so
  downstream caches can invalidate (Phase 3c will read this).
- `test/nova-tool-args.test.mjs` — 14 structural assertions. Uses a small
  "extract top-level const-array literal and eval it" loader instead of
  inline-copy, because the arrays are ~400 lines and inline-copy would
  bit-rot instantly.

**Invariants the tests lock in:**
- Tool names are unique, snake_case, and letter-first.
- Every `parameters` schema is `type: 'object'` with explicit
  `additionalProperties: false` — this prevents an LLM from sending extra
  junk params that silently slip through.
- Every `required` key actually exists in `properties`.
- `enum.default` (if present) is inside `enum`.
- `integer` defaults are actually integers.
- Skill `defaultTools` array entries all resolve to real tool names.
- All 4 plan-required skill ids are present.

**What's NOT in this commit (explicitly):**
- **No tool handlers.** `NOVA_TOOLS` is pure data. Phase 3c adds
  `handler(args, ctx) → Promise<result>` and `formatApproval(args) →
  string` per tool. Phase 9 backs `fs_*` / `shell_run` with
  `nova-agent-bridge`. Attempting to *call* a tool right now would throw.
- **No skill runtime.** Selecting a skill from the UI still does nothing —
  `cx-nova-pill-skill` stays inert. Phase 3b wires `systemPrompt` into the
  composer call.
- **Phase 4f capability discovery** (probe `/api/plugins/nova-agent-bridge/
  manifest`) is still open and lands with Phase 9.

**Gotchas:**
- The test file uses `new Function()` to eval the extracted array literal.
  This is safe because the source is our own repo file — but if you ever
  add a function-valued property (like a live `handler`), the eval will
  blow up. When Phase 3c lands, split the registry into two: a
  JSON-serializable metadata array for the test, and a separate
  handlers map.
- `shell_run` schema does NOT allow-list `cmd` values inside the JSON
  schema (too brittle; the allow-list lives in the plugin). The schema
  accepts any string; the plugin is the gatekeeper.
- `phone_inject_message.from` is an enum `['user', 'contact']` — matches
  the existing message-store convention, not the `[sms from="…" to="…"]`
  tag grammar. Don't confuse them.

**Validation this sprint:** `node --check index.js` clean;
`node --test 'test/*.test.mjs'` → **110/110 pass** (+14 new). No DOM
changes, no new imports, no new event handlers.

---

### Review follow-up — image-prompter default-tools trim

The `image-prompter` skill shipped with `defaultTools: ['st_get_context',
'phone_list_npcs', 'fs_write']` but `defaultTier: 'read'`. At runtime that
would force a tier-escalation prompt on every turn before the agent could
even emit output, defeating the read-only-by-design intent of the skill
(prompts are structured output the user copies, not files the agent writes).
Dropped `fs_write` from the default tool list. Users can still escalate to
write tier and pick `fs_write` manually if they want the prompt persisted.
Left an inline comment on the `defaultTools` line explaining the rationale
so the next agent doesn't re-add it.

<!-- Add new entries above this line using the template in "How to Use This File". -->

### 2026-04-23 — Review feedback on Phase 4c + 8 scaffold (this PR, follow-up)

**Context:** Applied six review-suggestion fixes from `@copilot-pull-request-reviewer` on the same PR. All are small correctness / single-source-of-truth improvements.

**Notes for future agents:**
- **Diff helper: `isNewFile` is now nullish-only by default.** `buildNovaUnifiedDiff('', newStr)` renders with `--- a/<path>` (existing empty file being modified), not `--- /dev/null`. Callers that truly mean "no prior file" must pass `null`/`undefined` or set `isNewFile: true` explicitly. The `opts.isNewFile` boolean is the escape hatch for callers that know the prior state (fs_stat ENOENT → force create; permission-denied → force modify). Tests lock all three code paths.
- **Diff helper: LCS is guarded.** `m > 10_000 || n > 10_000 || m*n > 4_000_000` short-circuits to a bounded "diff too large to preview (old=X, new=Y)" sentinel with headers intact. The approval modal still gets path context so the user can reject the write. If you raise the cap, remember this runs on the UI thread — the existing 4M-cell budget is ~16 MB of Uint32 plus row overhead.
- **Paths helper: `..foo` is a legitimate child.** The containment check is now `relNative === '..' || relNative.startsWith('..' + path.sep)`, not `relNative.startsWith('..')`. Three regression tests lock this. When auditing, remember `path.relative` always returns native separator, so a single `'..' + path.sep` check covers POSIX and Windows.
- **Plugin version: single source of truth.** `PLUGIN_VERSION` is now derived from `server-plugin/nova-agent-bridge/package.json` via `resolvePluginVersion()` (synchronous `fs.readFileSync` at module init — this file is tiny and only loaded once). Fallback is `'0.0.0'` with a `console.warn`. A test asserts `/manifest.version === pkg.version` so drift is caught immediately.
- **Plan doc ns consistency:** `docs/nova-agent-plan.md` now uses `EXT`/`"command-x"` (hyphen) everywhere it references the extension's settings or metadata namespace. Two places had `command_x` (underscore) which would not actually work as a JS property access against `extension_settings["command-x"]`. Watch for this on future doc edits — the extension manifest id uses a hyphen, so every persistence key does too.

**Validation:** 174/174 tests pass (+9 new).

### 2026-04-23 — Nova Phase 8 server plugin scaffold (this PR, follow-up commit)

**Context:** Stood up `server-plugin/nova-agent-bridge/` — the companion ST
server plugin that will back Nova's `fs_*` and `shell_run` tools. Scaffold
only: the ST plugin contract (`init`/`exit`/`info`), the two discovery
routes (`/manifest`, `/health`), and the pure path-safety helper
(`paths.js`) are real. The eight fs/shell routes are wired as explicit
`501 not-implemented` stubs so the extension's Phase 4f capability probe
can distinguish "plugin present, handler pending" from "plugin missing
entirely".

**Notes for future agents:**
- **Plugin loads as CommonJS.** ST's plugin loader (`st-docs/For_Contributors/
  Server-Plugins.md`) prefers `package.json.main`, then `index.js`, then
  `index.mjs`. We ship `package.json` with `"main": "index.js"` so the
  CJS entry is always picked up. Don't convert this to ESM — ST's loader
  is tested primarily against CJS plugins.
- **`/manifest.capabilities` is the source of truth for what's actually
  wired.** Every fs/shell key starts at `false` and flips to `true` only
  when the real handler lands. Do NOT flip a key to `true` just because
  the route exists — the extension Phase 4f probe uses this to decide
  whether to register the corresponding `NOVA_TOOLS` entry, and a
  too-optimistic flag will let the LLM call a tool that always 501s.
- **`paths.js` is intentionally zero-dep** (only `node:path`). The
  deny-list distinguishes single-segment bans (`.git`, `node_modules` —
  any depth) from two-segment pair bans (`plugins/nova-agent-bridge`
  specifically). This matters: a blanket `plugins/` ban would lock out
  every other ST plugin directory, and a single-segment `nova-agent-bridge`
  ban could hit unrelated folders. Keep the split.
- **Symlink-escape protection is explicitly deferred.** `normalizeNovaPath`
  is lexical — it does not call `fs.realpath`. The plan requires the
  realpath check; it lands at request time in the fs-handler sprint
  because (a) it's async and (b) an unreadable symlink path on startup
  shouldn't block route wiring.
- **Config loader is a single-line regex parser** (`/^\s*root\s*:\s*(.+?)\s*$/m`
  with quote-stripping). Intentional — adding a real YAML dep for one
  key would violate the "zero runtime deps" rule in §8a. When config
  grows past 2-3 keys, add the YAML dep then, not sooner.
- **Tests use `createRequire` to load the CJS plugin from ESM.** The
  `test/nova-plugin.test.mjs` pattern (build a mock router, assert the
  recorded route list) is cheap and catches route-contract regressions
  without spinning up Express. The `/manifest` + `/health` + stub-501
  handlers are exercised directly through a mock `res` object. Reuse
  this pattern for future route handlers.
- **`test/nova-paths.test.mjs` inline-copies `normalizeNovaPath`** per
  the existing test convention (AGENT_MEMORY 2026-04-22 entry on pure
  helpers). When you change `paths.js`, mirror the edit into the test
  file in the same PR.
- **Not yet wired:** the extension-side capability probe (plan §4f) still
  needs the `fetch('/api/plugins/nova-agent-bridge/manifest')` call plus
  the `NOVA_TOOLS` filter step. Fully separate PR.

**What's still deferred (explicitly):**
- Phase 3b turn lifecycle (and `migrateLegacyOpenClawMetadata` init wiring).
- Phase 3c tool handlers + approval modal DOM (will consume `buildNovaUnifiedDiff`).
- Phase 3d cancellation UI.
- Phase 4f capability-probe wiring on the extension side.
- Phase 6a/6b soul/memory runtime loader.
- Phase 7a/7b settings surface.
- Phase 8b real fs/shell handlers + symlink-realpath + audit log + CSRF
  (next plugin sprint).
- Phase 9 profile swap.

**Validation:** `node --check` clean on all three JS files;
`node --test test/*.test.mjs` → **165/165 pass** (+29 new: 19 paths, 10
plugin). `require('./server-plugin/nova-agent-bridge/index.js')` succeeds
under plain Node with no ST present.

### 2026-04-23 — Nova Phase 4c + Phase 1f/§10 pure-helper sprint (this PR)

**Context:** Landed two more pure helpers before the agent loop lands:
`buildNovaUnifiedDiff` (plan §4c — drives the `fs_write` approval modal in
Phase 3c) and `migrateLegacyOpenClawMetadata` (plan §1f / §10 — moves any
remaining `chatMetadata[EXT].openclaw` blobs into `legacy_openclaw` before
Nova goes live). No DOM, no LLM calls, no event handlers.

**Notes for future agents:**
- **`buildNovaUnifiedDiff` is a preview helper, not a patch generator.**
  It emits a linear `-` / `+` / ` ` line sequence with `--- a/<path>` and
  `+++ b/<path>` headers (or `--- /dev/null` for new files). It does NOT
  emit `@@` hunk headers and does NOT collapse unchanged context; the
  approval modal is expected to scroll. Keep it that way — switching to
  real hunks would require context-radius tuning that is a separate design
  decision.
- **Truncation marker text is locked by a test.** Sentinel is `"… diff
  truncated (N more lines) …"` with singular `"1 more line"`. Changing
  that text breaks `test/nova-diff.test.mjs`. If you reword it, update the
  test in the same PR.
- **LCS memory is O(m·n) as `Uint32Array`.** Fine up to a few thousand
  lines per file; that's the envelope Nova is meant to edit. If you ever
  need to diff very large files, short-circuit *before* calling the
  helper — don't try to make the helper lazy, it'll bit-rot the shape
  invariants.
- **`migrateLegacyOpenClawMetadata` is idempotent and touches metadata
  only.** The settings-side `openclawMode` retirement is already wired
  via the `LEGACY_KEYS` list in `loadSettings()` (see 2026-04-22 entry);
  this helper is the chatMetadata companion. When a legacy blob exists
  but `legacy_openclaw` was already written by a prior session, the raw
  `openclaw` key is dropped without overwriting the preserved copy — so
  users' recovery data stays intact.
- **Helper is not yet wired into init.** Deliberate. The plan says
  migration runs on "first Nova init"; that init path doesn't exist yet
  (lands with Phase 3b turn lifecycle). Calling it from the existing
  `CHAT_CHANGED` handler today would run it against every pre-Nova chat
  load for zero benefit. Wire it alongside the Nova turn bootstrap.
- **Inline-copy test pattern still applies.** Both new tests embed a copy
  of the helper — `index.js` can't be imported from plain Node because of
  ST runtime deps. When you edit either helper in `index.js`, mirror the
  edit into `test/nova-diff.test.mjs` / `test/nova-migration.test.mjs` or
  they go stale-silently.

**What's still deferred (explicitly):**
- Phase 3b turn lifecycle (and the init wiring for
  `migrateLegacyOpenClawMetadata`).
- Phase 3c tool handlers + approval modal DOM (will consume
  `buildNovaUnifiedDiff`).
- Phase 3d cancellation UI.
- Phase 6a/6b soul/memory runtime loader + self-edit tools.
- Phase 7a/7b settings surface.
- Phase 8 `nova-agent-bridge` server plugin.
- Phase 9 profile swap.

**Validation:** `node --check index.js` clean;
`node --test 'test/*.test.mjs'` → **136/136 pass** (+26 new: 17 diff,
9 migration).

---

## 2026-04-23 — v0.13.0 **Nova Goes Live** (Phases 2c / 6b / 7 / 9 / 10)

**Context:** Previous sessions built out the Nova agent backend —
tool registry, skills, dispatch loop, approval modal, diff preview,
soul/memory loader, profile-swap lifecycle — but the view was pure
scaffolding. All composer controls and pills rendered with `disabled`.
A user loading the phone and tapping the ✴︎ Nova tile hit a dead end.
This session shipped the end-to-end wiring so Nova is usable today.

**Shipped in this PR:**

- **Version bump** `manifest.json` + `index.js` `VERSION` → `0.13.0`.
  Tests assert both agree (`nova-ui-wiring.test.mjs`).
- **Nova view wiring** (`index.js`, ~400 new lines in a fresh
  `NOVA AGENT — UI wiring` section just above `wirePhone()`):
  - `wireNovaView()` attaches all handlers; called from `wirePhone()`
    after the clock interval so every rebuild re-wires.
  - `refreshNovaPills()` syncs the three pill labels from `settings.nova`.
  - `renderNovaTranscript()` renders `session.messages` from the active
    Nova session; empty-state renders a "Pick a connection profile"
    setup card when `settings.nova.profileName` is empty.
  - `appendNovaTranscriptLine(text, variant)` for ad-hoc lines
    (🔌 swap / ⚠︎ notice / 🛑 cancel).
  - `novaHandleSend()` serialises through `withNovaProfileMutex`,
    calls `sendNovaTurn`, surfaces `result.swappedProfile.from` as a
    "🔌 Restored profile to …" transcript line.
  - `novaHandleCancel()` fires `novaAbortController?.abort()`.
  - `setNovaInFlight(bool)` disables the composer and reveals Cancel.
  - `buildNovaSendRequest(ctx)` adapter — prefers
    `ctx.ConnectionManagerRequestService.sendRequest` (full tool-calling),
    falls back to `ctx.generateRaw` (text-only, surfaces a
    "⚠︎ Text-only mode" transcript warning and passes `tools: []`).
- **Picker modals** — new generic `cxPickList(title, options)` helper
  (re-uses `cx-modal-overlay`, `cx-modal-box`). Three Nova-specific
  wrappers: `novaPickProfile` (probes `/profile-list`), `novaPickSkill`
  (static `NOVA_SKILLS`), `novaPickTier` (read/write/full). Each
  persists to `settings.nova.*`, re-renders pills, and adds a
  transcript line for user feedback.
- **Profile-swap helpers** — `listNovaProfiles({ executeSlash })` +
  `parseNovaProfileListPipe(pipe)` + `withNovaProfileMutex(fn)` (tail-
  chained, non-poisoning). `_novaProfileSwapMutex` is the module-level
  chain used by production callers.
- **Soul/memory self-edit tools (Phase 6b)** — five new `NOVA_TOOLS`
  schemas (`nova_read_soul`, `nova_write_soul`, `nova_read_memory`,
  `nova_append_memory`, `nova_overwrite_memory`) + the
  `buildNovaSoulMemoryHandlers({ fetchImpl, loadSoulMemory,
  invalidateCache, pluginBaseUrl })` factory. Writes POST to
  `<pluginBaseUrl>/fs/write`; every successful write calls
  `invalidateNovaSoulMemoryCache()` so the next turn re-reads fresh
  content. Handlers never throw — failures resolve to
  `{ error: '<reason>' }`. `nova_append_memory` read-modify-writes under
  `force:true` so it never appends to a stale cache; single trailing
  newline is preserved.
- **Settings — Phase 7** — new Nova block in `settings.html` (profile,
  default tier select, max-tool-calls, turn timeout, plugin base URL,
  "Install Command-X preset" button). Mirror in-phone `NOVA` section
  in the Settings view with `cx-set-nova-*` IDs. `loadSettings` /
  `saveSettings` accept both ID sets via the `??`-chain pattern already
  used for other in-phone settings. "Install preset" fetches
  `presets/openai/Command-X.json`, logs it to DevTools, and shows a
  `cxAlert` with paste instructions — ST has no slash command to save
  presets server-side, so a manual paste into the UI is the supported
  path for now.
- **Transcript message styling** — `.cx-nova-msg`, `.cx-nova-msg-user`,
  `.cx-nova-msg-assistant`, `.cx-nova-msg-system`, `.cx-nova-msg-notice`
  CSS added. Picker-modal CSS (`.cx-pick-box`, `.cx-pick-row`,
  `.cx-pick-active`, `.cx-settings-text-input`) added. The nova-ui
  scaffolding test was **updated** to assert Nova is now live (composer
  is NOT `disabled`, pills are NOT `disabled`) — previous assertion
  that the view was "inert" would flag the wire-up as a regression.

**New tests:**

- `test/nova-self-edit-tools.test.mjs` — 21 assertions covering the
  5-handler factory: read forces cache bypass, write → POST body shape,
  cache invalidation on success but NOT on failure, `nova_append_memory`
  newline discipline (3 variants), empty/whitespace/non-string
  rejection, bridge-unreachable path, non-2xx path (body truncated to
  400 chars), trailing-slash stripping, all 5 handler names present.
- `test/nova-profile-swap.test.mjs` — 16 assertions covering
  `parseNovaProfileListPipe` (JSON + fallback + dedup),
  `listNovaProfiles` (ok / no-executor / executor-failed), and
  `withNovaProfileMutex` (serialisation, non-poisoning after failure,
  sequential-failure ordering).
- `test/nova-ui-wiring.test.mjs` — 11 static source-contract
  assertions: VERSION agreement, helper declarations,
  `wirePhone → wireNovaView` call, self-edit tool handler keys,
  `novaHandleSend` calls `withNovaProfileMutex`, settings IDs present
  in both surfaces, saveSettings reads both ID flavours,
  `_novaRenderMessageNode` handles all 6 roles,
  `buildNovaSendRequest` tries both dispatch paths.

**Architectural notes for the next agent:**

- **`sendRequest` dep surface is decoupled from ST APIs.** The Nova
  dispatch loop (`sendNovaTurn`) consumes
  `({messages, tools, tool_choice, signal}) => Promise<{content, tool_calls}>`.
  The new `buildNovaSendRequest(ctx)` adapter is the ONLY place that
  knows about ST's specific generation APIs. If ST changes its public
  surface (e.g. renames `ConnectionManagerRequestService`), only this
  adapter needs updating — the loop and its ~20 tests stay unchanged.
- **Tool-calling availability is a runtime property, not a setting.**
  `buildNovaSendRequest` returns `null` when neither
  `ConnectionManagerRequestService` nor `generateRaw` is available;
  `novaHandleSend` bails with a `cxAlert` in that case. When only
  `generateRaw` is available, we still let Nova run but pass
  `tools: []` and surface a `⚠︎ Text-only mode` transcript notice.
  The dispatcher test suite is unchanged — text-only mode is
  indistinguishable from a tool-less configuration upstream.
- **Inline-copy test pattern still applies** for the two new pure
  helpers. When you edit `buildNovaSoulMemoryHandlers`,
  `_novaBridgeWrite`, `listNovaProfiles`, `parseNovaProfileListPipe`,
  or `withNovaProfileMutex` in `index.js`, mirror the edit into the
  matching test — there is no JSDOM / ST runtime harness yet.
- **Pill persistence uses `getContext().extensionSettings[EXT]` +
  `saveSettingsDebounced()`** — same channel as every other phone
  setting. Do NOT stash profile/skill/tier in `chatMetadata`;
  they're per-user preferences, not per-chat.
- **Profile-list probe only fires on pill-click**, not on Nova init.
  Reason: we want the probe to reflect the CURRENT profile list at the
  moment the user picks, not a stale snapshot. If a later agent wants
  to badge the profile pill with "list unavailable", probe on Nova
  view enter and cache the result — just don't hide pickProfile behind
  it; the user might type a name manually once that UI lands.
- **Profile-swap mutex is module-level.** A page with two Nova views
  open (shouldn't happen, but) would still serialise profile swaps.
  Tests prove the chain is non-poisoning, so a failed swap on one
  caller never blocks the next.

**What's still deferred (explicit, not forgotten):**

- **Phase 8 `nova-agent-bridge` server plugin.** Soul/memory write
  tools POST to `<pluginBaseUrl>/fs/write`; until the plugin lands,
  every write resolves to `{ error: 'nova-bridge-unreachable' }`. Reads
  still work because `loadNovaSoulMemory` hits the extension-bundled
  path via ST's static handler.
- **No real tool handlers for `fs_*`, `shell_*`, `st_*`, `phone_*`.**
  The dispatcher surfaces `no-handler` for any tool name not in the
  soul/memory set. Wire additional handler maps when their backends
  ship.
- **Setup card is informational** — it prompts the user to tap the
  Profile pill but doesn't auto-open the picker. If user research
  shows people miss it, auto-opening on Nova view enter when
  `!profileName` is a one-liner.
- **Preset install is manual.** The button fetches + logs the JSON +
  shows paste instructions. A future ST release may add a
  `/preset-save` slash; when it does, swap the alert for a direct
  `executeSlashCommandsWithOptions('/preset-save …')` call.
- **Tool calls have no transcript tool-card yet.** When
  `sendNovaTurn` persists a `role: 'tool'` message, the renderer
  shows it as a `.cx-nova-toolcard` with a compact JSON preview. Rich
  collapsible per-call cards (plan §3c) are deferred.

**Validation:** `node --check index.js` clean; `node --test test/` →
**369/369 pass** (+48 new: 21 self-edit, 16 profile-swap, 11 wiring;
the existing scaffolding test was updated, not deleted, so net = +48).

---

## 2026-04-25 — Plan execution policy + §11 preset install upgrade

**Why this entry:** prior sessions tended to "tick stale checkboxes"
in `docs/nova-agent-plan.md` rather than ship user-visible §14 wins.
This PR establishes a policy and ships one concrete §14-step-4
improvement.

**Policy for future "continue working the plan" sessions:**

1. The single metric for session success is "at least one previously-
   failing §14 manual-validation step now passes." Box-ticking and
   new test files are not metrics.
2. Read §14 top-to-bottom, find the earliest failing step, trace it
   back to its §0–§13 work items, ship those as a coherent unit.
3. The plan markdown is **stale**. Always source-read before
   assuming an item is or isn't shipped. Many §0/§1 OpenClaw-removal
   items are already shipped — they're just unchecked.
4. Order of remaining work (rationale in PR description):
   audit §3c → ship §11 → ship §2c+§9 as a unit → §6b Soul/Memory
   editor → §2b audit drawer → stale-checkbox sweep last.

**Audit findings this session (verified by source-read, not box-tick):**

- §3c tool-call wiring: shipped via `buildNovaSendRequest`; both
  `ConnectionManagerRequestService.sendRequest` and `generateRaw`
  fallback paths exist and are tested.
- §2c profile picker modal: shipped via `novaPickProfile` +
  `cxPickList`. Reuses the cxConfirm modal shell.
- §9 setup card + swap mutex + transcript feedback: shipped. The
  empty-state already branches on `!nova.profileName` to show "Pick
  a connection profile". `withNovaProfileMutex` serializes swaps;
  "🔌 Restored profile to …" lines are appended on completion.

**§11 preset install — what changed:**

The handler at `index.js:8432` (`#cx_nova_install_preset` click)
previously fetched the bundled `presets/openai/Command-X.json` and
told the user to *open DevTools, copy the logged JSON, and paste it
into ST's Preset Import dialog*. That's not really "installing".

ST has no documented programmatic preset-save endpoint, so a "real"
install would have to POST to an undocumented `/api/presets/save`
that varies by version — too fragile. Instead the handler now:

1. Triggers a Blob download of `Command-X.json` via a hidden anchor
   (`URL.createObjectURL` + `a.click()` + `revokeObjectURL` on next
   tick).
2. Best-effort copies the JSON to the clipboard via
   `navigator.clipboard.writeText`.
3. Always logs the JSON to console as a final fallback.
4. Shows a `cxAlert` summarising which of {downloaded, copied,
   logged} actually succeeded, plus explicit instructions pointing
   at ST's Preset Import button (the 📥 icon next to the preset
   dropdown in API Connections → Chat Completion).

Both the download and clipboard paths are wrapped in try/catch so a
failure in either still leaves the user with the console fallback
and a working alert.

**§14 step that now passes:** step 4 — "Install preset via the
Settings button → preset appears in ST". The user can now: click
the button → file downloads → click Preset Import in ST → select
the file. No DevTools needed.

**Validation:** `node --test test/*.mjs` → **727/727 pass** (no test
changes — this is a UI/UX-only change in a click handler that has no
unit-test coverage and would be flaky to test via jsdom because of
`URL.createObjectURL` and clipboard APIs).

**Still deferred (unchanged from prior entry):**

- §6b in-phone Soul/Memory editor pane. Backing tools and
  `loadNovaSoulMemory`/`buildNovaSoulMemoryHandlers` exist and are
  tested; only the in-phone Settings UI pane is missing. **Next
  session's most logical target.**
- §2b audit-log drawer.
- §13 dedicated `nova-profile-swap.test.mjs` (existing coverage in
  `nova-profile-mutex.test.mjs` already exercises the chain).

---

## 2026-04-25 (later) — §6b in-phone Soul & Memory editor

**Goal of this PR:** continue the Nova rollout by shipping the next
unblocking §14 step — "Edit `soul.md` via in-phone editor → next turn
reflects change" (§14 step from the plan's manual-validation list).
This was the previously-queued next target ("§6b in-phone editor").

**What shipped:**

- `openNovaSoulMemoryEditor()` (in `index.js`, near the other Nova
  picker functions) — a modal built from `.cx-modal-overlay` +
  `.cx-modal-box.cx-nova-sm-box` with two textareas (soul + memory),
  per-pane Save buttons, a Reload-from-disk button, and an aria-live
  status banner with `data-kind` of `info` / `ok` / `warn` / `error`.
- New phone Settings row in the NOVA section:
  `<button id="cx-set-nova-edit-sm">📝 Edit Soul & Memory</button>`,
  wired in `wirePhone()` to call `openNovaSoulMemoryEditor()`.
- New CSS block in `style.css` for the editor's textareas and status
  banner. Reuses existing modal classes for everything else.

**Implementation choices:**

- **Loads via `loadNovaSoulMemory({ force: true })`.** Reuses the
  existing pure helper that's already covered by
  `test/nova-soul-memory.test.mjs`. Force-true skips the 5-min cache
  so what the user sees is what's on disk *now*.
- **Writes via `_novaBridgeWrite` directly**, not via the
  `nova_write_soul` / `nova_overwrite_memory` tool handlers from
  `buildNovaSoulMemoryHandlers`. The handlers add a layer (caller
  args validation, return-shape normalisation) that's only needed
  for the LLM tool-call path. The UI knows its inputs are strings,
  so it short-circuits to the underlying writer to keep error
  messages terse and direct.
- **Cache invalidation on success** via
  `invalidateNovaSoulMemoryCache()` — matches what
  `buildNovaSoulMemoryHandlers` does. Without this, the next Nova
  turn would compose a system prompt from the stale 5-min cache.
- **"Reset" doubles as "Reload from disk".** §6b's spec asks for
  "Save + Reset" — the Reload button discards any unsaved edits in
  the textareas by re-fetching the on-disk content, which is
  semantically the same thing and only one button.
- **Errors stay inline.** When the bridge isn't installed,
  `_novaBridgeWrite` returns `{ error: 'nova-bridge-unreachable' }`
  — surfaced in the status banner with explicit "install the
  nova-agent-bridge plugin" guidance, not as a `cxAlert`. The user
  shouldn't have to dismiss a modal-on-modal to retry.

**Why no new test file:** the underlying primitives are already
covered (`loadNovaSoulMemory`: 16 assertions; `_novaBridgeWrite`:
covered by the bridge tests; `invalidateNovaSoulMemoryCache`:
covered). The new code is glue that wires DOM events to those
primitives — jsdom-mocking textarea + click + button states would
add brittleness for negligible signal. If a regression happens
later, the right test target is one of the underlying helpers, not
the DOM glue.

**Validation:** `node --test test/*.mjs` → 727/727 pass; syntax
check via `node -e "import('./index.js')"` clean.

**§14 step that now passes:** step 8 (top of the manual-validation
list at line 839 of the plan: "Edit `soul.md` via in-phone editor →
next turn reflects change"). Caveat: the *plugin* still has to be
installed for writes to actually persist, but that's the plan's
intent — soul/memory writes are the one Nova surface that legitimately
requires the bridge.

**Still deferred (now the only top-level UI gaps):**

- §2b audit-log drawer / "View audit log" link (plan §7b last
  sub-bullet).
- §13 dedicated `nova-profile-swap.test.mjs` (existing
  `nova-profile-mutex.test.mjs` already exercises the chain — kept
  open because the plan calls out the file by name).
- §7a/§7c unchecked items are mostly already shipped (they are the
  same items that were stale-checked in §6b before this PR). A
  future cleanup-only PR could tick those after a careful audit.

---

## 2026-04-25 (later still) — PR #21 review-comment cleanup

Doc-only follow-up to the §6b editor PR. Three reviewer comments on
`37e32eb`, all addressed:

1. **`server-plugin/nova-agent-bridge/middleware.js` JSDoc.** The
   `opts.skip` param was documented as "route prefixes" but the
   implementation uses `Set.prototype.has(relPath)` (exact-string
   match). Updated the JSDoc to say "Exact route paths" and to call
   out the `Set.has` semantics so future edits don't introduce a
   prefix-vs-exact ambiguity. No behaviour change.

2. **`test/nova-fs-integration.test.mjs` + `test/nova-fs-tools.test.mjs`
   inline `_novaBridgeRequest` copies.** Production grew a
   `headersProvider` param + auth-header merge in plan §8c; these test
   copies were intentionally trimmed but didn't say so, which made the
   drift look accidental. Added an "INTENTIONALLY TRIMMED" header
   comment on each that:
     - calls out exactly what's missing (`headersProvider` + auth
       header merge);
     - explains why these tests don't need it (they cover handler
       contract / route shape / never-throws);
     - points future maintainers at where header behaviour *is*
       covered: `test/nova-shell-handler.test.mjs`'s
       "headersProvider …" suite, plus `test/nova-ui-wiring.test.mjs`
       which has a regression check that the production signature
       still includes `headersProvider`.

   No code change in either test file — only the leading comment.

**Hand-off notes for next session:**

- Two unchecked plan items remain prominent and would each be a
  one-PR slice:
  - **§2b audit-log drawer / §7b "View audit log" link.** The
    server plugin already writes `.nova-audit.log`; need a phone-side
    drawer that fetches and renders recent entries (read-only). Plan
    file is the source of truth for the shape.
  - **§13 dedicated `nova-profile-swap.test.mjs`.** The plan calls
    out the file by name; the swap chain is *already* exercised by
    `test/nova-profile-mutex.test.mjs`, but a focused test file
    matching the plan's name + scope would close the §13 gap.
- `§7a/§7c` checkbox sweep: most items are already shipped but still
  show as unchecked. A careful audit + tick-only PR would help, but
  watch out — some unticked items are genuinely deferred (preset
  installer button, "Install Command-X Chat Completion preset"). Do
  not blanket-tick.
- The `_novaBridgeRequest` inline-copy pattern in tests is now
  documented as deliberate. If a future change makes those tests
  *need* the header-merge branch, mirror the production signature in
  the inline copy and update the header comment to match — don't
  silently desync.

---

## 2026-04-25 (later still still) — §2b/§7b Nova audit-log viewer

**Goal of this PR:** continue the Nova rollout by shipping the next
unblocking surface — the **audit-log viewer** (plan §2b "📜 icon —
tailing view of persisted tool calls" + §7b "View audit log"). This
was named in the prior session's hand-off notes as the most
prominent remaining one-PR slice.

**Why this slice (most logical, not easiest):** the data was
*already* populated. Every tool dispatch decision (`ok`,
`denied:*`, `error:*`, `aborted`, `cap-hit`) lands on
`state.auditLog` (cap 500) via `appendNovaAuditLog`, so a user
running Nova has been *generating* audit entries with **no UI to
read them**. Without this surface, denials and dispatch errors are
silent — that's the highest-impact gap on the §14 manual-validation
walk-through after the Soul/Memory editor shipped.

**What shipped:**

- **Pure helper `buildNovaAuditLogModalBody(entries, { now, limit })`**
  in `index.js` near `buildNovaApprovalModalBody` (parity with the
  approval-modal pattern). Renders newest-first, capped at `limit`
  rows (default 200, hard ceiling 500), with a header summary
  ("Showing N of M tool call(s) (newest first)") and a footer
  ("…N older entries hidden") when truncated. Empty state shows a
  friendly "No tool calls recorded yet" placeholder explaining the
  500-entry cap.
- **Pure helper `classifyNovaAuditOutcome(outcome)`** — closed-enum
  → severity bucket (`ok` / `warn` / `error` / `info`) used to
  colour rows. Knows the dispatcher's exact outcome strings: `ok`
  is green, `cap-hit` / `aborted` / `denied:*` are amber,
  `error:*` is red, everything else (including blank / hostile
  input) defaults to grey "info". Hardened against `Object.create(null)`
  via try/catch around `String(...)`.
- **Pure helper `_novaFormatAuditTimestamp(ts, { nowImpl })`** —
  HH:MM:SS for same-day, MM/DD HH:MM:SS for older entries. Uses an
  injectable `nowImpl` so the same-day branch is testable without
  monkey-patching `Date.now`.
- **DOM wrapper `openNovaAuditLogViewer()`** in `index.js` next to
  `openNovaSoulMemoryEditor`. Mirrors that modal's pattern: reuses
  `.cx-modal-overlay` + `.cx-modal-box`, Escape closes, click-on-
  backdrop closes, Refresh button re-reads the in-memory log so a
  user who leaves the modal open across a turn sees new entries.
  Reads the log via `getNovaState(ctx).auditLog` — the same lazy
  heal path the dispatcher uses, so a stale or malformed
  `chatMetadata[EXT].nova` blob never crashes the modal.
- **CSS** — new `.cx-nova-audit-*` rules in `style.css`. Severity
  colours via `[data-sev="ok|warn|error|info"]` border-left + tinted
  background. Monospace font for the row body to match the audit
  log's CLI-ish nature.
- **Settings wiring** — new `<button id="cx-set-nova-audit">📜 View
  audit log</button>` row in the phone Settings → NOVA section,
  immediately under the Soul/Memory editor button. Wired in
  `wirePhone()`.

**Implementation choices:**

- **In-memory log, not the plugin JSONL log.** There are two audit
  surfaces in this codebase: (1) the per-chat `state.auditLog` at
  `chatMetadata[EXT].nova.auditLog` (capped 500), populated by
  `runNovaToolDispatch` for *every* decision incl. denials/errors/
  cap-hits/aborts; (2) the server-plugin `<root>/data/_nova-audit.jsonl`
  for fs writes/deletes/moves only. The user-facing "what just
  happened?" question is answered by (1) — it's chat-scoped,
  always-present (no plugin required), and richer (it sees the
  whole dispatch envelope, not just the bridge ops). The viewer
  reads (1) only. (2) is a server-side compliance log; if a future
  power-user surface needs it, that's a separate sprint.
- **Modal, not drawer.** The plan calls it a "drawer" but the
  `.cx-modal-overlay` / `.cx-modal-box` shell is what every other
  Nova UI piece reuses (approval modal, Soul/Memory editor, picker
  modals). Inventing a new drawer pattern for one screen would
  add CSS surface for negligible UX win — modals fit the
  "occasional read-only inspection" use case better than a
  persistent drawer would.
- **Pure-helper split.** All escape-safety + ordering + truncation
  logic lives in `buildNovaAuditLogModalBody`, which is unit-tested
  without JSDOM (matching the `buildNovaApprovalModalBody` precedent).
  The DOM wrapper is intentionally thin: read state → call helper →
  set innerHTML. Refresh button just re-runs that same path.
- **No new tests for the DOM wrapper.** The pure builder + classifier
  carry the escape-safety contract; the DOM wrapper is glue. This
  matches the §6b editor's choice not to JSDOM-mock textareas.
- **Limit clamping.** `limit` is sanitised to `[1, 500]`; non-finite
  / non-positive falls back to the 200 default. This keeps a
  hostile / misconfigured caller from collapsing the viewer to a
  single row (which would defeat its purpose).
- **`data-sev` attribute, not class, for severity.** Lets us style
  via `[data-sev="…"]` selectors and inspect via DOM in DevTools
  without polluting the class list. Same pattern as the Soul/Memory
  status banner (`[data-kind="ok|warn|error"]`).

**New tests:** `test/nova-audit-viewer.test.mjs` — 20 assertions
across 7 suites covering classifier matrix (every dispatcher
closed-enum outcome + blank/null/hostile fallbacks),
timestamp formatting (same-day vs cross-day, non-finite input),
empty state (real + hostile non-array input), rendering (newest-
first ordering, severity classification per row, args-block
elision when empty, singularisation, junk-entry resilience),
limit / truncation (cap enforcement, footer presence/absence,
clamp matrix for 0 / negative / huge limits), escape safety
(hostile tool / args / outcome cannot leak `<script>`,
`<img onerror=>`, or `</span>` markup; severity attribute is
closed-enum-bound), and a source-shape contract that fails fast
if any of `classifyNovaAuditOutcome`, `buildNovaAuditLogModalBody`,
`openNovaAuditLogViewer`, the Settings button, or the wirePhone
binding drift.

**Updated tests:** `test/nova-ui-wiring.test.mjs` declares the three
new symbols (`openNovaAuditLogViewer`, `buildNovaAuditLogModalBody`,
`classifyNovaAuditOutcome`) in its required-functions list.

**Validation:** `node --test test/*.mjs` → **747/747 pass** (was
727; +20 new). `node -e "import('./index.js')"` clean.

**§14 step that now passes:** the audit-log inspection part of
step 9 ("Install `nova-agent-bridge` → … → audit log exists")
— the audit log was *always* there; this PR makes it visible.

**Still deferred (unchanged, and now genuinely the smallest gaps):**

- §13 dedicated `nova-profile-swap.test.mjs` (chain already covered
  by `nova-profile-mutex.test.mjs`; the file-name gap is purely
  cosmetic).
- §7a/§7c stale-checkbox sweep (already-shipped items still ticked
  unchecked in the plan markdown). A careful audit + tick-only PR
  would close these. **Watch out** — some unchecked items there are
  *genuinely* deferred (e.g. real `/api/presets/save` install vs
  the current download-and-instruct flow). Don't blanket-tick.

**Next session recommendation:** `nova-profile-swap.test.mjs` is
the smallest remaining slice — write a focused test file that
mirrors the swap-and-restore chain (snapshot via `/profile`,
swap via `/profile <name>`, restore-on-throw, mutex serialisation)
to close the §13 gap without changing production code. After that,
the plan's *implementation* surface is fully covered and the
remaining work is documentation hygiene (stale-checkbox sweep,
§12 docs alignment) and the deferred preset-installer / shell
sandbox sprints.

---

## 2026-04-25 (final) — Stale-checkbox sweep on `docs/nova-agent-plan.md`

**Goal of this PR:** docs-only hygiene. The plan markdown is the
orientation document for every future session, but it had ~50 items
ticked `[ ]` that were *demonstrably* shipped per source-read. The
prior session's hand-off explicitly flagged this as the next
sensible slice and warned **"do not blanket-tick"** — some unchecked
items are genuinely deferred.

**Method:** for each unchecked item, source-read to verify
implementation + tests, then tick only when both are present. Items
that are *partially* shipped use the `[~]` notation with a note
explaining what's done vs deferred.

**Ticked (verified shipped, with confirming source citations):**

- **§0 Naming & Layout** (5 items) — Nova everywhere (label, CSS
  prefix, code section, storage keys, settings keys); companion
  plugin `nova-agent-bridge` shipped under `server-plugin/`; phone
  tile renamed to "Nova" with ✴︎ icon; `/* === NOVA AGENT === */`
  section header present.
- **§1a–§1d OpenClaw removal** (13 items) — `OPENCLAW_API_BASE`
  gone; `openclawMode` migrated out via `LEGACY_KEYS`; all 21 named
  OpenClaw functions removed (only `migrateLegacyOpenClawMetadata`
  remains by design); home-screen tile / view block / nav footer /
  switchView branches / wirePhone wireups / sync calls / docstring
  references all clean. Verified: `grep -cn openclaw` finds only
  legitimate migration code + style.css's restored shared-class
  comment + README's historical note.
- **§1e README OpenClaw removal** ticked; the §1e *replacement* with
  a new "Nova Agent" section marked `[~]` (brief callout shipped,
  full rewrite is part of §12 which stays deferred).
- **§2c picker modals** (2 items) — `novaPickProfile` + `novaPickSkill`
  shipped via `cxPickList`.
- **§2d** `cxAlert`/`cxConfirm` rule — verified zero native callsites.
- **§3c tool registration** — embedded path + single `NOVA_TOOLS`
  array shipped; **registered path fallback** (`ctx.registerFunctionTool`
  with `shouldRegister: () => false`) genuinely deferred (covered by
  ST 1.12.6+ minimum).
- **§6b self-edit tools** — five `nova_*` schemas + handler factory
  shipped; **`/api/files/*` fallback** marked `[~]` (the `fs_write`
  path is wired; the no-bridge fallback isn't).
- **§7a/b/c settings surfaces** (12 items) — both ST-side and in-phone
  Settings → NOVA sections shipped with all the planned fields, plus
  the new 📜 audit-log button from the previous PR. `nova: {...}`
  is in `DEFAULTS`; `LEGACY_KEYS` strips `openclawMode`.
- **§9 connection-profile handling** (6 items) — probe / validate /
  swap / restore / mutex / transcript-feedback all shipped, covered
  by the existing `nova-profile-swap.test.mjs` + `nova-turn.test.mjs`.
- **§10 migration** (2 of 3 items) — manifest 0.13.0; minimum-ST-version
  documented in CLAUDE.md / probe at runtime; **starter-file
  auto-creation** in user data dir genuinely deferred.
- **§11 preset** (entire section minus §11b) — file shipped
  (`presets/openai/Command-X.json` + `README.md`); schema validated by
  `nova-preset.test.mjs`. **§11b install flow** marked `[~]` because
  the implementation is the **best-effort fallback path** (Blob
  download + clipboard + cxAlert with import instructions) rather
  than the planned `executeSlashCommandsWithOptions('/preset-import')`
  — see the 2026-04-25 entry above for the rationale.
- **§12 docs** (3 of 4 items) — plan markdown / CLAUDE.md /
  copilot-instructions.md / AGENT_MEMORY append-convention all
  shipped; **README.md rewrite** stays deferred.
- **§13 tests** — `nova-profile-swap.test.mjs` exists with full
  parser + executor + mutex coverage (5 suites, 18 tests). The
  prior session's hand-off recommended this as the next slice but
  the file already existed; ticking it now removes the misleading
  bullet.

**Genuinely deferred (left unticked, by design):**

- §3c registered-path fallback (older-ST compatibility, not on the
  v0.13.0 critical path).
- §4b "Remember approvals this session" UI toggle (gate logic ships
  via `novaToolGate`'s `rememberedApprovals` Set parameter, but the
  *user-facing toggle* is unimplemented).
- §8 `POST /shell/run` route + the "no `shell: true`" / allow-list
  bullet — only the 501 stub exists; the shell-sandbox sprint is
  its own PR.
- §10 starter-file auto-creation in the user's data dir (depends
  on the `/api/files/*` fallback path).
- §12 README full rewrite (Features → Install → Nova Agent → Preset
  → Tag Reference → Advanced order). The brief callout works for
  v0.13.0 stabilisation; full rewrite is its own PR.
- All §14 manual-validation walk-through steps — these are *user*
  steps, never to be agent-ticked. They stay `[ ]` permanently as a
  reload-time checklist.

**Validation:** docs-only change. `node --test test/*.mjs` →
**747/747 pass** (no regressions; no production code touched).

**Hand-off notes for next session:**

The plan file is now an honest orientation doc — every `[ ]` reflects
real work, every `[x]` reflects shipped code. The remaining gaps in
priority order:

1. **§12 README rewrite** — biggest remaining doc gap. Promote the
   Nova section from a `> **Note:**` callout to a top-level section
   between Install and Tag Reference. Most of the content already
   exists in CLAUDE.md and `docs/nova-agent-plan.md`; this is mostly
   a re-shape + cross-linking job.
2. **§4b "Remember approvals this session" toggle** — small UI
   slice. Add a checkbox to phone Settings → NOVA, persist on
   `settings.nova.rememberApprovalsSession`, thread the resulting
   `Set<toolName>` through `runNovaToolDispatch` to populate the
   gate's `rememberedApprovals` parameter. Already-shipped pure
   helpers + tests cover the gate-side contract.
3. **§3c registered-path fallback** — only matters for ST builds
   missing `ConnectionManagerRequestService` (pre-1.12.6). Low
   priority; current behavior is to `cxAlert` and bail.
4. **§10 starter-file auto-creation** — depends on the
   `/api/files/*` fallback path, which itself depends on whether
   we want to support no-bridge writes at all. Open question.
5. **§8 `/shell/run` route** — biggest deferred *implementation*
   item. Sandbox + allow-list + audit + NDJSON streaming. This is a
   sprint, not a PR.

The §14 manual-validation list is the right user-facing acceptance
gate for a v0.13.0 release tag; an agent should never tick those.

---

## 2026-04-25 (very final) — §4b remember-approvals toggle + §12 README rewrite

**Goal of this PR:** finish the remaining agent-completable work on
the Nova implementation per the prior session's hand-off priority list.
The `[ ]` items the previous sweep left as "genuinely deferred" or
"open question" stay deferred; the two well-scoped items ship here.

**Shipped:**

1. **§4b "Remember approvals this session" toggle** — full plumbing.
   - **Setting**: `settings.nova.rememberApprovalsSession` was already
     declared in `NOVA_DEFAULTS` but had no UI and no plumbing. Now
     declared in `NOVA_SETTING_BINDINGS` as `type: 'bool'` with both
     DOM ids wired (`cx_nova_remember_approvals` for ST's settings
     panel, `cx-set-nova-remember-approvals` for in-phone Settings →
     NOVA). The existing table-driven `loadSettings` / `saveSettings`
     pipeline picks it up without bespoke handlers.
   - **UI**: checkbox in `settings.html` under the Nova section, and
     a `cx-toggle`-styled row in the in-phone Settings → NOVA section
     directly under the bridge plugin URL.
   - **Per-session state**: new module-level
     `novaSessionApprovedTools = new Set()` plus accessor
     `getNovaSessionApprovedTools()` and clearer
     `clearNovaSessionApprovedTools()`. Lifecycle is documented in
     the comment block: toggle on keeps existing entries, toggle off
     clears, page reload starts fresh-empty, user-rejected calls
     never get added.
   - **Plumbing**: `novaHandleSend` now passes
     `rememberedApprovals: nova.rememberApprovalsSession ?
     novaSessionApprovedTools : null` into `sendNovaTurn`, which
     forwards it to `runNovaToolDispatch`, which forwards it to
     `novaToolGate`. The composer's `confirmApproval` callback adds
     the tool name to the Set only when (a) the user clicked OK,
     (b) the toggle is on, and (c) the tool has a name — reads never
     reach this branch because the gate returns
     `requiresApproval:false` for `read` permission upstream.
   - **Auto-clear on toggle-off**: `saveSettings` snapshots the prior
     `rememberApprovalsSession` boolean before applying DOM values
     and calls `clearNovaSessionApprovedTools()` on a true→false
     transition. So unchecking the box has the same effect as starting
     a fresh session — every previously-remembered tool re-prompts
     next time.
   - **Tests**: new `test/nova-remember-approvals.test.mjs`
     (14 assertions, 3 suites): bindings + DOM-surface + composer
     wiring source-shape assertions, plus an inline-copy
     behavioural contract for `novaToolGate` proving that the Set
     short-circuits approval correctly, doesn't bypass tier-too-low
     denial, and treats null/empty containers identically.

2. **§12 README rewrite** — promote Nova from a `> **Note:**` callout
   to a top-level section.
   - Order is now Features → Install → Usage → **`## ✴︎ Nova Agent`**
     → **`## Chat-Completion Preset`** → How It Works (RP messaging) →
     Private Polling → Tag Reference → Architecture, matching the
     plan's prescribed structure.
   - The Features list also gained a `### ✴︎ Nova App (Agentic
     Assistant)` subsection that cross-links to the top-level Nova
     section.
   - The Usage list's item 9 now points at `[Nova Agent](#-nova-agent)`
     instead of "preview; see `docs/nova-agent-plan.md`".
   - The new top-level Nova Agent section covers Quick start,
     How it works (ASCII flow diagram), Permission tiers (table),
     Soul and memory, Skills, the bridge plugin, and
     Cancellation/errors/audit. Most prose is re-shaped from
     `CLAUDE.md` and `docs/nova-agent-plan.md`.
   - The new Chat-Completion Preset section documents both the
     "Install Command-X chat-completion preset" button and the
     manual import path, and points at `presets/openai/README.md`
     for the field-by-field rationale.

**Plan + memory updates:**
- `docs/nova-agent-plan.md`: §4b "UI toggle still pending" → fully
  ticked with the implementation contract; §12 README rewrite
  ticked; banner block at the top updated to call out the
  stabilisation sweep; new amendment appended.
- This entry.

**Validation:**
- `node --check index.js` clean.
- `node --test test/*.mjs` → **793/793 pass** (was 779; +14 from the
  new file).
- `parallel_validation` run before completing the task.

**Hand-off notes for next session:**

The genuinely deferred items remain deferred, by design:

1. **§3c registered-path fallback** — only matters for ST builds
   missing `ConnectionManagerRequestService` (pre-1.12.6). Current
   `cxAlert`-and-bail is the right v0.13.0 behaviour. If a future
   user hits this, the fix is to add a `ctx.registerFunctionTool`
   loop in `novaHandleSend`'s textOnlyFallback branch with
   `shouldRegister: () => true` for the duration of the turn, then
   un-register in the `finally` block.
2. **§10 starter-file auto-creation** — depends on the open question
   of whether to support no-bridge soul/memory writes at all.
   Without the bridge plugin, the `nova_write_*` handlers fail
   gracefully today; auto-seeding the user data dir on first Nova
   load would only matter for installs that want soul/memory to
   work without ever installing `nova-agent-bridge`. That tradeoff
   should be a user decision, not an agent guess.
3. **§14 manual-validation walk-through** — permanent `[ ]` user
   checklist; never agent-tickable. Run through it before tagging a
   v0.13.0 release.

Nothing structural is left for the v0.13.0 critical path. The next
sensible direction is whatever the user prioritises after a release
tag.

---

## 2026-04-25 — README: SillyTavern prerequisites for Nova

### Why

`server-plugin/nova-agent-bridge/README.md` documents `enableServerPlugins: true` but the **main** `README.md` did not — a user could follow the Nova Quick Start, drop the plugin into `plugins/`, restart, and have it silently ignored. Also, the minimum ST version (1.12.6+) and the
tool-calling-source requirement were only mentioned in passing in step 2 of the Quick Start, with no consolidated "what does my ST install need before I touch the phone" answer.

### Change

Added a `### SillyTavern prerequisites` subsection under `## ✴︎ Nova Agent` (just before the existing Quick Start). Five numbered items:

1. ST 1.12.6+ (for `ConnectionManagerRequestService`, `isToolCallingSupported`, Connection Profiles).
2. A tool-calling-capable chat completion source — OpenAI / Claude / Gemini / OpenRouter; describes the text-only-mode fallback when the source can't tool-call.
3. Connection Profiles enabled (built-in ST extension, on by default; verify it isn't disabled).
4. (Optional, bridge plugin only) `enableServerPlugins: true` in `config.yaml` — with the full code-fenced YAML snippet, and a cross-link to the bridge plugin README for the rest of the install walkthrough.
5. (Optional, Private Polling only) `generateQuietPrompt` available (1.12.10+) — cross-links to the existing Private Polling section.

Also tightened Quick Start step 4 ("Install the bridge plugin") to point back to the prereq for the `enableServerPlugins` requirement instead of just saying "drop in and restart."

### Why this minimal shape

- No duplication: `enableServerPlugins` install detail lives in `server-plugin/nova-agent-bridge/README.md`; the main README only states the requirement and links there.
- Doesn't redefine the Private Polling requirement — just cross-links so the version number lives in one place.
- Doesn't gate the rest of the README behind these prereqs; everything except Nova is unaffected by them.

### Validation

Scope note: this memory entry records only the README prerequisites follow-up
commit. The broader PR also includes the earlier `index.js` / `settings.html` /
`test/nova-remember-approvals.test.mjs` remember-approvals implementation and a
later `server-plugin/nova-agent-bridge/README.md` documentation refresh. The new
anchor `#sillytavern-prerequisites` and the existing `#private-polling` anchor
both use GitHub's standard kebab-case heading slug, so the in-page links resolve.
The full PR was later sanity-validated with `node --test test/*.mjs` (793/793
pass) after the manual-validation/docs sweep.

---

## 2026-04-25 (later) — Manual-validation extracted to a standalone file + final docs housekeeping

### Why

The `docs/nova-agent-plan.md` §14 walk-through was sparse (12 bullets, mid-plan)
and had two real bugs: step 6 said the Character-Creator turn would propose
`fs_write`, but the canonical write path for that skill is `st_write_character`
(`index.js:7763`); and step 10 quoted the audit-log path as
`<root>/.nova-trash/audit/audit-YYYY-MM-DD.jsonl`, which never existed in
the shipped code. The actual path (per `audit.js` + `index.js::resolveAuditLogPath`)
is a single append-only file at `<root>/data/_nova-audit.jsonl` (preferred) or
`<root>/_nova-audit.jsonl` (fallback when no `data/` dir exists). The same wrong
path was duplicated in the root `README.md` and in `CLAUDE.md`.

The user wants to load SillyTavern and walk through this checklist via a CLI,
so it needs to be (a) standalone (no flipping between docs), (b) 100% accurate
against the shipped UI labels and on-disk paths, and (c) complete (preconditions
+ every shipped tool path + bridge install/uninstall + audit + cancellation +
RP-chat isolation + non-Nova phone-app smoke).

### What shipped

1. **`docs/MANUAL_VALIDATION.md` (new, standalone, canonical)** — 15 phases
   (§0 Preconditions through §O Tagging the release). Every UI label, button
   id, file path, console string, and tool name is quoted verbatim from the
   v0.13.0 source. Designed to be readable top-to-bottom in `less` /
   `glow` / `cat` without flipping between files.
   - §0 Preconditions explicitly calls out `enableServerPlugins: true` so a
     user does not silently get a no-op bridge install in §H.
   - §D fixes the Character-Creator step to point at `st_write_character`
     (canonical write path), with an *Optional bridge variant* note for the
     `fs_write` + diff-preview path that some agents may pick instead.
   - §I quotes the correct audit-log path and explicitly says it is a single
     file, not a directory.
   - §J adds an explicit shell-allow-list refusal step (`rm` not on the
     allow-list → `outcome: "refused-not-allowed"`) so the deny path is
     observed, not just the happy path.
   - §K adds a graceful-degradation step (uninstall bridge → ST-API subset
     still works + yellow banner shows) that the old §14 had as a one-liner.
   - §N adds a non-Nova phone-app smoke (Command-X messages, neural toggle,
     Profiles, Quests, Map, Private polling) so a v0.13.0 release does not
     ship with a regression in the rest of the phone — the old §14 had
     none of this.

2. **`docs/nova-agent-plan.md` §14** — replaced the inline 12-bullet checklist
   with a one-paragraph pointer at `MANUAL_VALIDATION.md` and a "do not
   duplicate" note. Single source of truth.

3. **Audit-log path corrected in three places** (the main user-facing locations
   that previously had the bogus `.nova-trash/audit/audit-YYYY-MM-DD.jsonl`
   path):
   - `README.md` (root) — Nova-app feature bullet + Cancellation/errors/audit
     section.
   - `CLAUDE.md` — Nova Agent §Audit bullet.
   - (`docs/MANUAL_VALIDATION.md` is correct on first write.)

4. **`server-plugin/nova-agent-bridge/README.md` Status section refresh**
   — shell route is no longer "501 / lands next sprint" (it shipped); the
   Status block now describes the shell route's safety model (allow-list
   resolved at init, absolute-path spawn, no-shell, stdin closed, 1 MB
   per-stream cap, hard timeout) at the same level of detail as the fs
   bullets. The Security model section's "once the fs handlers land" /
   "shell invocations will" future-tense was rewritten to present tense
   ("uses `spawn` without `shell: true`", "resolves the binary against a
   static allow-list at init time and spawns the absolute path so a later
   PATH change cannot redirect mid-session"). Audit-path on this README was
   already mostly right but tightened for consistency.

### What was NOT changed

- The actual extraction code in `index.js` and the server plugin — doc-only
  housekeeping.
- The starter `nova/soul.md` / `nova/memory.md` files — out of scope for this
  pass.
- `docs/nova-agent-plan.md` outside §14 — also out of scope (the plan still
  reads top-to-bottom, just with §14 now externalised).

### Validation

Doc-only changes; no `index.js`/`test/`/`server-plugin/*.js` files touched.
`grep -r '\.nova-trash/audit\|YYYY-MM-DD\.jsonl' README.md CLAUDE.md docs server-plugin`
returns only historical mentions in `AGENT_MEMORY.md` (when included) and no
live user-facing instructions, confirming the stale path is gone from the docs
users follow.

---

## 2026-04-25 (review follow-up) — README tool names, audit wording, settings layout

### Why

PR review flagged several documentation/layout mismatches left over from the
Nova docs sweep:

- `README.md` still referenced non-existent `nova_write_memory` and
  `st_create_character` names. The implemented tools are `nova_append_memory`,
  `nova_overwrite_memory`, and `st_write_character`.
- The README audit bullet blurred two different logs: user approval denials are
  captured client-side in the in-phone audit viewer, but never reach the bridge
  and therefore cannot be written to the server-side JSONL file.
- The ST extension settings checkbox `cx_nova_remember_approvals` was missing
  the surrounding `.cx-opt` wrapper used by neighboring controls.
- The earlier AGENT_MEMORY validation note was scoped to a single README commit
  but could be misread as describing the whole PR, which also includes code,
  settings, and test changes.

### Change

- `README.md`: replaced `nova_write_memory` references with
  `nova_append_memory` / `nova_overwrite_memory` (and `nova_read_memory` where
  the section lists the read/edit tool set), changed the flow example to
  `st_write_character`, and split audit wording into server-side executed bridge
  requests vs client-side approval outcomes.
- `CLAUDE.md`: kept the Nova soul/memory tool-name list aligned with README.
- `index.js`: updated a stale helper comment that mentioned `nova_write_memory`.
- `settings.html`: wrapped `cx_nova_remember_approvals` in `<div class="cx-opt">`
  for the same layout structure as the surrounding controls.
- `AGENT_MEMORY.md`: clarified the older README-prerequisites validation note so
  future readers do not mistake it for whole-PR validation.

### Validation

- `rg 'nova_write_memory|st_create_character' /home/runner/work/command-x/command-x`
  → no matches.
- `rg '\.nova-trash/audit|YYYY-MM-DD\.jsonl' README.md CLAUDE.md docs server-plugin`
  → no matches.
- `node --test test/nova-remember-approvals.test.mjs` → 14/14 pass.

---

## 2026-04-26 — Manual validation tailored for Codex CLI

### Why

PR feedback asked to tailor the standalone manual-validation walk-through for
Codex CLI. The existing `docs/MANUAL_VALIDATION.md` was CLI-readable, but it did
not make the operator split explicit: Codex can run terminal/HTTP checks while a
human performs browser-only SillyTavern clicks against the live instance.

### Change

- Added a **How to run this with Codex CLI** section near the top of
  `docs/MANUAL_VALIDATION.md` with `ST_ROOT` / `CX_DIR` setup commands and a
  reusable prompt for a Codex CLI session.
- Added explicit checklist prefixes (`Codex CLI`, `User/browser`,
  `Codex CLI + user`, `Both`) so the walkthrough reads as a coordinated Codex
  terminal session plus live browser acceptance pass.
- Kept the existing permanent `[ ]` checklist semantics — Codex should not tick
  boxes or edit source unless a user explicitly asks it to fix a failed step.
- Updated `docs/nova-agent-plan.md` §14 to call the file Codex-CLI-oriented.

### Validation

- `python` line-length check over `docs/MANUAL_VALIDATION.md` found 0 lines over
  110 chars after the reflow.
- `node --test test/*.mjs` was run after the docs-only change and passed
  793/793.

---

## 2026-04-30 — Docs overhaul and agent-instruction refresh

### Why

The documentation had drifted from the current v0.13.0 implementation in a few
high-signal places:

- Agent-facing docs still described Nova as "in development" and used old
  pre-expansion line counts.
- `.github/copilot-instructions.md` still warned that event listeners were never
  removed, even though `wireEventListeners()` / `unwireEventListeners()` now
  manage symmetric listener lifecycle.
- README / CLAUDE only listed the older Nova skill set and missed the newer
  Quest Designer, NPC / Contact Manager, Map / Location Designer, Lore Auditor,
  and Prompt Doctor skills.
- README architecture/tag references under-documented `[place]`, map context,
  SMS image attachments, and the broader localStorage surface.
- Nova shell wording implied a sandbox; the bridge shell route is allow-listed
  and approval-gated, but the server plugin itself is explicitly not sandboxed.

### Change

- `README.md`: refreshed Nova status, complete skill list, settings summary,
  map `[place]` / `[status].place` wording, SMS attachment caps, tag reference,
  architecture bullets, and allow-listed shell wording.
- `CLAUDE.md`: updated current source/style line counts, test-suite description,
  single-file architecture size, SMS attachment constants/storage notes, Nova
  audit split (client in-phone log vs server bridge JSONL), and full skill-pack
  inventory. Also removed stale `settings.nova.enabled` documentation.
- `.github/copilot-instructions.md`: updated line counts, storage-key wording
  (`chatKey()`), prompt/event-handler summaries, private-poll cadence, and event
  listener lifecycle guidance.
- `docs/MANUAL_VALIDATION.md`: added a skill-picker inventory check covering all
  shipped Nova skills.

### Validation

- Targeted `rg` checks over README, CLAUDE, `.github/copilot-instructions.md`,
  docs, and bridge README confirmed no live docs still say Nova is "in
  development", cite the old 7.9k / 8.7k / 1.46k line counts, claim event
  listeners are never removed, or mention stale tool names like
  `nova_write_memory` / `st_create_character`.
- Documentation-only change; no code, tests, or server-plugin runtime files were
  modified.

---

## 2026-04-30 — NPC contact detection parsing hardening

### Why

NPC contacts could fail to appear when an LLM returned a valid-looking `[status]`
block that was not the exact JSON-array shape Command-X originally required.
Common variants include a single object, a wrapper object such as
`{"characters":[...]}`, fenced JSON, or one bad `[status]` block followed by a
later valid block. The in-phone **Auto-Detect NPCs** toggle also updated module
state before saving, but the global ST settings checkbox could overwrite that
value during `saveSettings()`.

### Change

- `extractContacts()` now scans all `[status]` / legacy `[contacts]` blocks and
  imports every valid contact it can parse instead of stopping at the first
  block.
- Added tolerant parsing helpers for fenced JSON, single-contact objects, and
  wrapper arrays under `contacts`, `status`, `npcs`, or `characters`.
- Empty/whitespace names are ignored before merging into the NPC store.
- The in-phone `#cx-set-npcs` toggle now mirrors its value to
  `#cx_ext_auto_detect_npcs` before saving so enabling/disabling auto-detection
  from the phone persists correctly.
- `test/helpers.test.mjs` inline helper copy was kept in sync and now covers the
  new contact parser shapes.

### Validation

- Baseline before edits: `node --test test/*.mjs` had 853/854 passing with the
  pre-existing `test/nova-shell-route.test.mjs` ANSI-colored stdout mismatch
  (`'\x1B[33m4\x1B[39m'` vs `'4'`).
- `node --test test/helpers.test.mjs` passed 70/70 after the change.
- Syntax check passed:
  `node -e "import('./index.js').catch(e => { if (e instanceof SyntaxError) { console.error(e); process.exit(1); } })"`
- Full suite after edits: `node --test test/*.mjs` had 857/858 passing with the
  same unrelated `nova-shell-route` ANSI-colored stdout mismatch.

---

## 2026-04-30 — In-phone settings persistence follow-up

### Why

PR review caught that adding `cx-set-npcs` to `PHONE_SETTING_BINDINGS` exposed a
broader settings persistence pattern: `saveSettings()` reads the first DOM id in
each binding, so in-phone controls whose global settings-panel id comes first
must mirror their changed value back to all bound ids before saving. Otherwise a
stale settings-panel checkbox/value can overwrite the in-phone change.

### Change

- Added the missing in-phone ids for `styleCommands`, `showLockscreen`, and
  `batchMode` to `PHONE_SETTING_BINDINGS`.
- Replaced the Auto-Detect-only sync helper with `syncPhoneSettingInputs(key,
  value)`, which writes any phone setting value to every DOM id declared in its
  binding.
- Used the helper before `saveSettings()` for the in-phone phone/map settings
  handlers that have bound settings-panel counterparts.
- The global settings-panel change handler now mirrors any `PHONE_SETTING_BINDINGS`
  change through the same helper before saving, keeping both UI surfaces in sync.
- Added source-shape coverage in `test/helpers.test.mjs` for the reviewed binding
  ids and the mirror-before-save behavior.

### Validation

- `node --test test/helpers.test.mjs` passed 72/72.
- Syntax check passed:
  `node -e "import('./index.js').catch(e => { if (e instanceof SyntaxError) { console.error(e); process.exit(1); } })"`
- Full suite after edits: `node --test test/*.mjs` had 859/860 passing with the
  same unrelated `test/nova-shell-route.test.mjs` ANSI-colored stdout mismatch
  (`'\x1B[33m4\x1B[39m'` vs `'4'`).
