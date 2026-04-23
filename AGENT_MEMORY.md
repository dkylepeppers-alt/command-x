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
