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

<!-- Add new entries above this line using the template in "How to Use This File". -->
