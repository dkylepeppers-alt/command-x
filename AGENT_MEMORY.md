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
