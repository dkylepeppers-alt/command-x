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
