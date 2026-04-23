# Nova Agent — Implementation Plan (Revised & Approved)

Status: **Approved** — 2026-04-22. This document is the source of truth for the
Nova Agent work. Update checkboxes as items land and append amendments at the
bottom.

> **v0.13.0 landed (2026-04-23) — Nova is LIVE.** The agent loop
> (Phase 3) is now wired to the view, pills are interactive, three
> picker modals work, profile-list probe (§9) is live, the soul/memory
> self-edit tools (§6b) are registered with handlers, and both
> settings surfaces (§7) are populated. The only remaining gaps for a
> "fully stocked" Nova are the `nova-agent-bridge` server plugin
> (§8) and real handlers for `fs_*` / `shell_*` / `st_*` / `phone_*`
> tools. See AGENT_MEMORY 2026-04-23 for the full delta.

Rewrite target: replace the `openclaw` app with **Nova**, an interactive
tool-calling agent inside the Command-X phone. Nova has full read/write access
to the SillyTavern install directory via a new companion server plugin, ships
with three skills (Character Creator, Worldbook Creator, Image Prompter) plus a
free-form fallback, and is anchored by a `soul.md` + `memory.md` pair that is
always injected into the system prompt.

Out of scope / explicitly rejected by user:
- The `observe`/`assist`/`operate` mode system — **removed entirely**.
- Text-Completion fallback — **not needed**. Nova requires a Chat-Completion
  source that supports tool calling.

---

## 0. Naming & High-Level Layout

- [ ] Adopt **Nova** everywhere (UI label, CSS prefix, code section, storage
  keys, settings keys, system-prompt references).
- [ ] Companion server plugin: **`nova-agent-bridge`** (replaces
  `openclaw-bridge`). Ship plugin source under
  `server-plugin/nova-agent-bridge/` with install instructions.
- [ ] Phone app tile name **"Nova"** with a new icon (✴︎ / 🧠) and a distinct
  accent color separate from the Command-X pink.
- [ ] Code section header in `index.js`: `/* === NOVA AGENT === */`.
- [ ] CSS prefix `cx-nova-*`, DOM IDs `cx-nova-*`, storage keys `cx-nova-*`,
  settings nested under `settings.nova.*`.

---

## 1. Remove OpenClaw (clean-slate deletion)

### 1a. `index.js`
- [ ] Remove `OPENCLAW_API_BASE` constant.
- [ ] Remove `openclawMode` from the `DEFAULTS` object.
- [ ] Remove all `OpenClaw`-named functions (full list: `getOpenClawChatState`,
  `saveOpenClawChatState`, `callOpenClawBridge`, `getOpenClawEls`,
  `setOpenClawStatus`, `appendOpenClawLog`, `parseOpenClawOperateEnvelope`,
  `applyOpenClawResponse`, `formatOpenClawResult`, `renderOpenClawActions`,
  `syncOpenClawView`, `insertContextIntoOpenClawPrompt`, `checkOpenClawHealth`,
  `refreshOpenClawSessionStatus`, `sendToOpenClaw`,
  `sendOpenClawOperateReceipt`, `resetOpenClawSession`,
  `executeOpenClawSlashCommand`, `approveOpenClawAction`,
  `rejectOpenClawAction`, `runOpenClawSlashLocally`, `clearOpenClawPrompt`).
- [ ] Remove the OpenClaw home-screen tile.
- [ ] Remove the OpenClaw view block and its nav footer.
- [ ] Remove the `app === 'openclaw'` branches in `switchView` and in the
  initial-view restore block.
- [ ] Remove all `#cx-ocb-*` event wire-ups in `wirePhone`.
- [ ] Remove `syncOpenClawView()` calls in `rebuildPhone` / init.
- [ ] Remove the openclawMode normalisation + setting-save code.
- [ ] Update the module docstring to drop "OpenClaw bridge controls".

### 1b. `settings.html`
- [ ] Remove the `#cx_ext_openclaw_mode` row.
- [ ] Update phone-panel description text to drop OpenClaw.

### 1c. `style.css`
- [ ] Remove every `.cx-openclaw-*` and `.cx-icon-openclaw` rule.

### 1d. `manifest.json`
- [ ] Rewrite `description` field (drop OpenClaw, add Nova).
- [ ] Bump `version` → `0.13.0`.

### 1e. `README.md`
- [ ] Remove all OpenClaw sections.
- [ ] Replace with a new "Nova Agent" section.

### 1f. Storage / metadata migration
- [x] On Nova init, move `ctx.chatMetadata[EXT].openclaw` →
  `ctx.chatMetadata[EXT].legacy_openclaw` and save metadata. Here `EXT`
  matches the implementation constant `EXT = "command-x"` in `index.js`, so
  this migration targets `ctx.chatMetadata["command-x"]` (not
  `ctx.chatMetadata.command_x`). Do not read it afterwards. Delete
  `settings.openclawMode` if present and persist settings.
  - **Shipped (pure helper):** `migrateLegacyOpenClawMetadata(ctx)` in
    `index.js` NOVA AGENT section. Idempotent, preserves any
    previously-moved `legacy_openclaw` blob under the same `command-x`
    namespace, triggers `saveMetadataDebounced` only when state actually
    changed. Covered by `test/nova-migration.test.mjs` (9 assertions).
    Settings-side migration (`settings.openclawMode`) is already handled by
    the `LEGACY_KEYS` list in `loadSettings()`. Init wiring (calling the
    helper from Nova init / `CHAT_CHANGED`) lands with the Phase 3b turn
    lifecycle sprint.

---

## 2. Nova App — UI Layer

### 2a. Home-screen tile
- [x] Add Nova tile in `buildPhone()` with `data-app="nova"` and new
  emoji/icon.
- [x] Add `'nova'` to every app-list guard (switchView, saved-app restore,
  nav footer label).

### 2b. Nova view DOM
Chat-style agent transcript. Layout (top → bottom):
- [x] **Header bar** — title "Nova"; right pills: profile, skill,
  permission-tier (Read / Write / Full). Each pill opens a chooser modal.
  *(Scaffolding: pills ship as inert `disabled` buttons with stable IDs;
  modal wiring deferred to 2c.)*
- [x] **Transcript pane** `#cx-nova-transcript` — user bubbles, assistant text
  chunks (Markdown), and **tool-call cards** (name, arg summary, full JSON,
  status, duration, result preview, Approve/Reject when pending).
  *(Scaffolding: empty-state panel + `aria-live="polite"` region. Bubble /
  tool-card rendering ships in Phase 3.)*
- [x] **Composer** — textarea, Send, Cancel (while in flight), "+" sheet with
  skill picker, tier selector, "Attach current chat context" toggle,
  "Clear transcript"/"New session".
  *(Scaffolding: textarea + Send (disabled) + Cancel (hidden) only. "+" sheet
  deferred.)*
- [ ] **Audit-log drawer** (via 📜 icon) — tailing view of persisted tool
  calls.
- [x] Back button exits Nova; transcript is persisted.
  *(Nav footer returns to home. Transcript persistence is Phase 3.)*

### 2c. Modals / sheets
- [x] `cxConfirm`-based approval modal for any Write/Full tool call, with
  **diff preview** for file writes and command preview for shell.
  - **Shipped:** `cxNovaApprovalModal({ tool, args, diffText, permission,
    title })` DOM wrapper in `index.js` NOVA AGENT section + pure
    `buildNovaApprovalModalBody(...)` HTML body builder. Reuses the
    `.cx-modal-overlay` / `.cx-modal-box` shell; adds a `.cx-nova-approval`
    modifier that widens the box to fit `<pre>` args + diff blocks. All
    user-controlled strings (tool name, args JSON, diff body) escaped via
    `escHtml`. Destructive perms (write/shell) get the `cx-modal-btn-danger`
    confirm button and default focus to Cancel. Covered by
    `test/nova-approval-modal.test.mjs` (18 assertions covering shape,
    escape-safety for prompt-injection payloads, args serialisation edge
    cases incl. circular refs, and source-shape ordering).
- [ ] Connection-profile picker modal (uses `/profile-list`).
- [ ] Skill picker modal, static list.

### 2d. Rendering rules
- [x] Use `escapeHtml` helper for all text; no `innerHTML` with untrusted data.
  *(Scaffolding renders only static literals — no untrusted data yet. Contract
  established for Phase 3.)*
- [x] `role="button"` / `tabindex="0"` / `aria-label` on interactive divs.
  *(Tile + nav footer comply. Pills are real `<button>` elements.)*
- [ ] Use `cxAlert` / `cxConfirm`, never native `alert` / `confirm`.
- [x] New `.cx-nova-toolcard` class in `style.css`.
  *(Reserved shell + `-pending` / `-error` variants — Phase 3 populates.)*

---

## 3. Nova Agent Loop

### 3a. State
- [x] Per-chat state in `ctx.chatMetadata[EXT].nova`:
  - `sessions: [{ id, skill, tier, profileName, messages, toolCalls, createdAt, updatedAt }]`, cap 20.
  - `activeSessionId`.
  - `auditLog: [{ ts, tool, argsSummary, outcome }]`, cap 500.
  - **Shipped:** `getNovaState`, `saveNovaState`, `createNovaSession`,
    `appendNovaAuditLog` helpers in `index.js` NOVA AGENT section;
    `NOVA_STATE_KEY`, `NOVA_SESSION_CAP=20`, `NOVA_AUDIT_CAP=500` constants;
    covered by `test/nova-state.test.mjs` (9 assertions).
- [x] Module-level: `novaTurnInFlight`, `novaAbortController`,
  `novaToolRegistryVersion`.
  - Shipped in Phase 3a (second slice). `_getNovaTurnState()` snapshot
    helper exposes `{ inFlight, hasAbort, registryVersion }` as the
    stable read-only hook Phase 3b tests assert against. `hasAbort` is a
    boolean (not the live `AbortController` reference) so tests can't
    mutate live state through the hook. Covered by
    `test/nova-turn-state.test.mjs` (9 assertions).

### 3b. Turn lifecycle
- [x] `sendNovaTurn(userText)` — **full loop shipped** (`index.js` NOVA AGENT
  section). Phase 3c wired the tool-dispatch loop behind `toolHandlers` +
  `confirmApproval` DI; absent those the turn falls back to Phase 3b's
  deferred-stub behaviour so prior tests stay green. Covered by
  `test/nova-turn.test.mjs` (23 assertions, backwards-compat) +
  `test/nova-tool-dispatch.test.mjs` (22 assertions for the new loop).
  1. [x] Validate profile is set and (when provided) `isToolCallingSupported()`
     returns true — enforced at function entry. `sendRequest` presence is
     also validated so the helper never calls `undefined()`.
  2. [x] Push user message, persist via `saveNovaState(ctx)`.
  3. [x] **Snapshot** active profile via `/profile`; swap to target via
     `/profile <name>`. Skip swap when already active. Swap failure returns
     `{ ok: false, reason: 'profile-swap-failed' }` without running the LLM.
  4. [x] Build messages: `[system: composeNovaSystemPrompt(...), ...transcript]`
     via `buildNovaRequestMessages`.
  5. [~] Call `sendRequest({ messages, tools, tool_choice: 'auto', signal })`.
     **Streaming + `ConnectionManagerRequestService` vs `generateRaw` probe**
     still live in the caller — the Phase 2c composer wires them. This slice
     takes any Promise-returning `sendRequest` so tests can drive it.
  6. [x] **Dispatch loop shipped (§3c).** When the LLM returns `tool_calls`
     and the caller provided `toolHandlers`, `runNovaToolDispatch` takes
     over: gate → approval → handler → `role:'tool'` message → re-call
     `sendRequest` → repeat until no more tool_calls, cap hit, or abort.
     Every decision emits one audit entry. Streaming is still deferred;
     each round uses a single non-streaming `sendRequest`.
  7. [x] Enforce caps: wall-clock cap via `setTimeout` →
     `controller.abort('turn-timeout')` wired into `novaAbortController`
     (shipped earlier). `maxToolCalls` cap is enforced inside
     `runNovaToolDispatch` with an audit entry (`outcome: 'cap-hit'`).
  8. [x] **Finally** restore original profile (even on error/abort). Clear
     `novaTurnInFlight` and `novaAbortController`. Restore failures are
     audit-logged but don't mask the primary turn result.

### 3c. Tool registration
- [ ] **Embedded path** (default): tools passed inline on `sendRequest`.
- [ ] **Registered path** (fallback): `ctx.registerFunctionTool` with
  `shouldRegister: () => false` default, flipped during the turn.
- [ ] Single `NOVA_TOOLS` array: `{ name, displayName, description,
  parameters, permission: 'read'|'write'|'shell', handler, formatApproval }`.
- [x] **Tier + approval gate (precursor).** Pure helper
  `novaToolGate({ permission, tier, toolName, rememberedApprovals })` in
  `index.js` NOVA AGENT section. Returns `{ allowed, requiresApproval,
  reason? }`. Tier `'read'` allows read-only; `'write'` allows read+write;
  `'full'` allows read+write+shell. Reads never need approval; write/shell
  need approval unless the tool is in `rememberedApprovals` (Set or
  Array). Malformed `tier` defaults to the strictest (`'read'`); unknown
  `permission` denies with reason `unknown-permission`; missing
  `permission` denies with `missing-permission`. `NOVA_TIERS` /
  `NOVA_PERMISSIONS` frozen enums exported for the Phase 7 settings UI.
  Covered by `test/nova-tool-gate.test.mjs` (26 assertions including the
  full 3×3 matrix and a NOVA_TOOLS-registry coverage check).
- [x] **Dispatch loop.** `runNovaToolDispatch` pure async helper in
  `index.js` NOVA AGENT section. Takes `{ initialResponse, messages,
  toolRegistry, handlers, tier, rememberedApprovals, maxToolCalls,
  confirmApproval, sendRequest, tools, signal, gate, nowImpl, onAudit }`
  and mutates `messages` with every assistant + `role:'tool'` message it
  emits. Returns `{ ok, rounds, toolsExecuted, toolsDenied, toolsFailed,
  capHit, aborted, finalAssistant, events }`. Every failure mode
  (unknown-tool / malformed-arguments / tier-too-low / user-rejected /
  no-confirmer / confirmer-error / handler throw / no-handler / abort /
  send-failed) coerces to either a `role:'tool'` error message that lets
  the LLM recover, or an `ok:false` exit with a closed-enum `reason`.
  Covered by `test/nova-tool-dispatch.test.mjs` (22 assertions across
  7 suites).

### 3d. Cancellation and errors
- [x] `AbortController` per turn; wired into `sendNovaTurn` (the module-level
  `novaAbortController` binding holds it while the turn is in flight, and
  a wall-clock `setTimeout` calls `.abort('turn-timeout')` at the
  `turnTimeoutMs` cap). Dispatcher checks `signal.aborted` between every
  tool call and between rounds; returns `{ ok: false, reason: 'aborted' }`
  so the caller can render a "turn cancelled" pill. Cancel button →
  `.abort()` on the live controller lands with the Phase 2c composer UI.
- [x] Handler throws → tool result `{ error }` so the LLM can recover;
  dispatcher pushes a `role:'tool'` message with `{ error: <message> }`
  and emits an audit entry (`outcome: 'error:<message>'`). Red-card
  rendering lands with the Phase 2c toolcard markup.

---

## 4. Tool Surface

**Schema status:** the `NOVA_TOOLS` registry is declared in `index.js`
(pure data, no handlers yet). Schema-shape invariants enforced by
`test/nova-tool-args.test.mjs`. Handlers land with Phase 3c; the plugin
backends land with Phase 9.

### 4a. Filesystem (via `nova-agent-bridge`)
- [x] `fs_list({ path, recursive?, maxDepth? })` — schema shipped.
- [x] `fs_read({ path, encoding?, maxBytes? })` — schema shipped.
- [x] `fs_write({ path, content, encoding?, createParents?, overwrite? })` — schema shipped.
  with `.nova-trash/<ts>/<path>` backup on overwrite.
- [x] `fs_delete({ path, recursive? })` — schema shipped; handler moves to trash.
- [x] `fs_move({ from, to, overwrite? })` — schema shipped.
- [x] `fs_stat({ path })` — schema shipped.
- [x] `fs_search({ query, glob?, path?, maxResults? })` — schema shipped.

Rooted at the **SillyTavern install dir** per user request. Plugin refuses
escape, blocks symlinks out, and denies `.git/**`, `node_modules/**`, and its
own plugin folder by default.

### 4b. Shell (via `nova-agent-bridge`)
- [x] `shell_run({ cmd, args, cwd?, timeoutMs? })` — schema shipped. Allow-list: `node`, `npm`,
  `git`, `python`, `python3`, `grep`, `rg`, `ls`, `cat`, `head`, `tail`, `wc`,
  `find`. User-extensible. Hard timeout default 60 s.
- [ ] Full tier only; per-call approval unless
  "Remember approvals this session" is on — enforced in Phase 3c.

### 4c. Diff preview helper
- [x] For every `fs_write` approval: fetch current file, render unified diff
  vs `content`. New files show raw content. Modal blocks the loop until
  accept/reject.
  - **Shipped (pure helper):** `buildNovaUnifiedDiff(oldContent, newContent,
    { path, maxLines })` in `index.js` NOVA AGENT section. LCS-based line
    diff, `--- /dev/null` header for new files, bounded output with
    "N more lines" truncation sentinel. Covered by `test/nova-diff.test.mjs`
    (17 assertions). Modal wiring lands with Phase 3c.

### 4d. SillyTavern API tools (no plugin)
- [x] `st_list_characters`, `st_read_character`, `st_write_character` — schemas shipped.
- [x] `st_list_worldbooks`, `st_read_worldbook`, `st_write_worldbook` — schemas shipped.
- [x] `st_run_slash({ command })` — schema shipped; handler calls
  `ctx.executeSlashCommandsWithOptions` in Phase 3c.
- [x] `st_get_context()` — schema shipped (last N msgs, character, persona).
- [x] `st_list_profiles`, `st_get_profile` — schemas shipped.

### 4e. Phone-internal tools
- [x] `phone_list_npcs`, `phone_write_npc`, `phone_list_quests`,
  `phone_write_quest`, `phone_list_places`, `phone_write_place`,
  `phone_list_messages`, `phone_inject_message` — schemas shipped.

### 4f. Tool capability discovery
- [ ] Probe `GET /api/plugins/nova-agent-bridge/manifest`. If present,
  register 4a/4b. If 404, register only 4d/4e and show a yellow banner.

---

## 5. Skills System

Skill = named system-prompt pack + default tier + default tool subset. Single
`NOVA_SKILLS` array in `index.js`. **Shipped** — all 4 skills below plus
`SKILLS_VERSION = 1`. Shape + id + tool-reference invariants enforced by
`test/nova-tool-args.test.mjs`.

### 5a. Character Creator
- [x] System prompt: expert on ST character-card schema v2 (all required fields,
  `spec: 'chara_card_v2'` + `spec_version: '2.0'`, write path
  `SillyTavern/data/<user>/characters/<name>.json`, "never overwrite without
  diff" rule).
- [x] Default tools: `st_list_characters` / `st_read_character` /
  `st_write_character` + `fs_list` / `fs_read` / `fs_stat` / `fs_search` /
  `fs_write`.
- [x] Default tier: Write.

### 5b. Worldbook Creator
- [x] System prompt: expert on ST Worldbook (World Info) schema (full entries
  shape, `SillyTavern/data/<user>/worlds/<name>.json`, "prefer
  `st_write_worldbook` over `fs_write`" rule).
- [x] Default tools: `st_list_worldbooks` / `st_read_worldbook` /
  `st_write_worldbook` + `fs_list` / `fs_read` / `fs_stat` / `fs_search` /
  `fs_write`.
- [x] Default tier: Write.

### 5c. Image Prompter
- [x] System prompt: expert for SD/SDXL/Flux/Illustrious. Pulls the current
  ST chat via `st_get_context`, proposes positive + negative prompts tied to
  the current scene, character, outfit, location, lighting, camera. Three
  flavours: Anime (booru tags), Realistic (natural language + cinematic),
  Artistic (style tokens + artist refs). Structured output:
  `{ positive, negative, sampler_hint, steps_hint, cfg_hint, notes }`.
- [x] Default tools: `st_get_context`, `phone_list_npcs`, `fs_write`.
- [x] Default tier: Read-only (escalatable to Write).

### 5d. Free-form ("Plain helper")
- [x] Minimal system prompt. Default tier: Read-only. All tools available
  when elevated (`defaultTools: 'all'`).

### 5e. Skill structure
```
{ id, label, icon, systemPrompt, defaultTier, defaultTools: [names] | 'all',
  allowTierEscalation: true }
```
- [x] `SKILLS_VERSION` constant (currently `1`) — bump when prompts change.

---

## 6. `soul.md` and `memory.md`

Always concatenated into the Nova system prompt regardless of skill.

### 6a. Location
- [x] Default: extension folder —
  `SillyTavern/public/scripts/extensions/third-party/command-x/nova/soul.md`
  and `.../nova/memory.md`. Served by ST's static handler so `fetch('./nova/…')`
  works with no plugin.
  - **Shipped:** `defaultNovaSoulMemoryBaseUrl()` returns
    `/scripts/extensions/third-party/${EXT}/nova` — interpolates `EXT` so
    a rename lives in one place.
- [x] Seed both files in the repo with starter content (see §6d).

### 6b. Load/save
- [x] On Nova init, fetch both files; cache in memory. Cache-bust on explicit
  "Reload soul/memory" and after any self-edit.
  - **Shipped (read path):** `loadNovaSoulMemory({ baseUrl, fetchImpl,
    nowImpl, ttlMs, force })` pure helper in `index.js` NOVA AGENT section.
    Never throws — 404 / network error / non-string body all become an
    empty string for that file. Both files fetched in parallel via
    `Promise.all`. Module-level cache with TTL = 5 min; explicit
    `invalidateNovaSoulMemoryCache()` drops it. Failure results are
    cached too to prevent hot-loop refetching. Covered by
    `test/nova-soul-memory.test.mjs` (16 assertions).
    **Not yet wired from Nova init** — `sendNovaTurn` already accepts
    `soul` / `memory` params; the Phase 3c composer will pass the loader
    result. Also not yet invalidated on `nova_write_soul` — Phase 6b
    self-edit tools land with the Phase 3c handler sprint.
- [ ] Self-edit tools:
  - `nova_read_soul`, `nova_write_soul` (Write).
  - `nova_read_memory`, `nova_append_memory({ note, tags? })`,
    `nova_overwrite_memory({ content })` (Write).
- [ ] Route through `fs_write` when plugin installed; fall back to
  `POST /api/files/*` into `SillyTavern/data/<user>/user/files/nova/`.
- [ ] In-phone Settings: "Soul & Memory" pane with textareas + Save + Reset.

### 6c. Prompt composition order
```
[Nova base system prompt]
[Active skill prompt]
---
# Soul
<soul.md>
---
# Memory
<memory.md truncated to 16 KB>
---
[Tool-use contract: how to call tools, stop conditions, safety]
```
- [x] **Shipped:** `composeNovaSystemPrompt({ basePrompt, skillPrompt, soul,
  memory, toolContract })` helper in `index.js` NOVA AGENT section. Memory
  tail-truncates to `NOVA_MEMORY_CHARS_CAP = 16 KB` with an explicit
  "…truncated" marker. Covered by `test/nova-prompt-compose.test.mjs`
  (6 assertions).

### 6d. Starter content
- [x] `soul.md`: Nova voice/persona — curious, crisp, SillyTavern-native,
  confirms destructive ops, explains intent before acting, references the
  current chat by name. **Shipped:** `nova/soul.md`.
- [x] `memory.md`: empty template with section headers
  ("User preferences", "Project notes", "Recent wins/failures", "Do not do").
  **Shipped:** `nova/memory.md`.

---

## 7. Settings Surface

### 7a. `settings.html` (ST-side)
- [ ] Remove OpenClaw row.
- [ ] Add collapsible **Nova** section:
  - [ ] Profile picker (from `/profile-list`).
  - [ ] Default permission tier radio.
  - [ ] Max tool calls per turn (default 24).
  - [ ] Turn wall-clock timeout s (default 300).
  - [ ] Plugin base URL override (default `/api/plugins/nova-agent-bridge`).
  - [ ] "Open Soul & Memory editor" → phone Settings.
  - [ ] "Install Command-X Chat Completion preset" button (see §11).

### 7b. In-phone Settings additions
- [ ] "Nova" section: same fields as 7a + Soul & Memory editor + "View audit
  log".
- [ ] Persist under `extension_settings["command-x"].nova = { profileName,
  defaultTier, maxToolCalls, turnTimeoutMs, pluginBaseUrl,
  rememberApprovalsSession: false, activeSkill }`.

### 7c. Defaults
- [ ] In `DEFAULTS`, replace `openclawMode` with `nova: {...}`.

---

## 8. `nova-agent-bridge` Server Plugin

### 8a. Layout
- [x] `server-plugin/nova-agent-bridge/index.js` — CJS `init`/`exit`/`info`.
- [x] `server-plugin/nova-agent-bridge/package.json` — zero runtime deps;
  use Node built-ins (`fs/promises`, `path`, `child_process`, `crypto`).
- [x] `server-plugin/nova-agent-bridge/config.example.yaml`.
- [x] `server-plugin/nova-agent-bridge/README.md` — install steps.
- [x] `server-plugin/nova-agent-bridge/paths.js` — pure path-safety helper
  (not in original plan; extracted from §8c for unit testability).

### 8b. Routes (`/api/plugins/nova-agent-bridge/*`)
- [x] `GET /manifest` → `{ id, version, root, shellAllowList, capabilities }`.
  `capabilities` is `{ fs_list, fs_read, fs_write, fs_delete, fs_move,
  fs_stat, fs_search, shell_run }`, each `true|false`. Scaffold ships all
  `false` — extension Phase 4f reads this to decide which tools to
  register.
- [x] `GET /health` → `{ ok: true, id, version }`.
- [ ] `GET /fs/list`, `GET /fs/read`, `POST /fs/write`, `POST /fs/delete`,
  `POST /fs/move`, `GET /fs/stat`, `POST /fs/search` (NDJSON).
  **Routes wired as `501 not-implemented` stubs**; real handlers land in the
  Phase 8b handler sprint (blocked on audit-log infra + CSRF wiring).
- [ ] `POST /shell/run` (NDJSON streaming `stdout`/`stderr`/`exit`).
  **Route wired as `501 not-implemented` stub**; real handler blocked on
  same.

### 8c. Security
- [x] Root = `process.cwd()` by default; override via `config.yaml: root:`.
  (Simple `key: value` parse for now; no YAML dep.)
- [x] Normalise every request path; reject escapes (pure helper in
  `paths.js`; covered by `test/nova-paths.test.mjs`, 19 assertions).
  Reject symlink escapes (`fs.realpath` check) — **pending**, lands with
  the fs handler sprint.
- [x] Deny-list: `.git/**`, `node_modules/**`, `plugins/nova-agent-bridge/**`
  — enforced by `normalizeNovaPath`. Single-segment vs two-segment pair
  distinction avoids locking out unrelated directories that happen to be
  named `plugins`.
- [ ] Max file size read/write: 20 MB.
- [ ] Shell: no `shell: true`; binaries resolved via allow-list at startup.
- [ ] CSRF protection mirroring ST's header check.
- [ ] Require ST session cookie on every route.
- [ ] Audit log: append to `SillyTavern/data/_nova-audit.jsonl` with
  `{ ts, user, route, argsSummary, outcome, bytes }`. Never log `content`.

### 8d. Lifecycle
- [x] `exit()` flushes audit log and releases file handles. (Stub today —
  scaffold has nothing to flush. Shape ready for the audit-log sprint.)

---

## 9. Connection-Profile Handling

- [ ] **Probe**: `/profile-list` on Nova init; cache names.
- [ ] **Validate** `settings.nova.profileName`; show setup card if missing.
- [ ] **Swap**: capture previous profile from `/profile` (no-arg) then
  `/profile <name>`. Skip swap if already active.
- [ ] **Restore** in `finally`.
- [ ] **Race protection**: module-level `profileSwapMutex` Promise chain.
- [ ] **Feedback**: transcript lines "🔌 Switched to …" / "🔌 Restored …".

---

## 10. Migration, Compatibility, Minimum ST Version

- [ ] Bump `manifest.json` → `0.13.0`.
- [ ] Document minimum ST version (1.12.6+: `isToolCallingSupported`,
  `ConnectionManagerRequestService`, Connection Profiles).
- [ ] One-shot migration at first Nova init:
  - Move `chatMetadata[EXT].openclaw` → `.legacy_openclaw`.
  - Drop `settings.openclawMode`.
  - Create `nova/soul.md` + `nova/memory.md` if absent (plugin if available,
    else ST `/api/files/*`).

---

## 11. **Chat Completion Preset** *(added per amendment)*

Ship a preset file the user can import into ST's Chat Completion section and
point their Nova profile (and any other Command-X utility profile) at. Based
on ST's own `default/content/presets/openai/Default.json` schema.

### 11a. File
- [ ] `presets/openai/Command-X.json` in this repo.
- [ ] Uses the real ST preset schema (`chat_completion_source`,
  `openai_model`, `temperature`, `top_p`, `frequency_penalty`,
  `presence_penalty`, `openai_max_context`, `openai_max_tokens`,
  `stream_openai`, `names_behavior`, `send_if_empty`, `impersonation_prompt`,
  `new_chat_prompt`, `new_group_chat_prompt`, `new_example_chat_prompt`,
  `continue_nudge_prompt`, `wi_format`, `scenario_format`,
  `personality_format`, `group_nudge_prompt`, `prompts[]`, `prompt_order[]`,
  …).
- [ ] Configured for roleplay + utility blend:
  - `chat_completion_source: "openai"`, `openai_model` placeholder
    `gpt-4o-mini` (user can override).
  - `temperature: 0.85`, `top_p: 1`, `frequency_penalty: 0.1`,
    `presence_penalty: 0.1`, `openai_max_context: 32768`,
    `openai_max_tokens: 800`, `stream_openai: true`,
    `names_behavior: 2` (completion names).
  - Main Prompt authored for Command-X RP: tells the model to emit
    `[sms from=… to=…]…[/sms]`, `[status]…[/status]`, `[quests]…[/quests]`,
    `[place]…[/place]` tags when relevant, **to never narrate them**, and to
    keep phone bubbles short and texty.
  - Jailbreak / Post-History: empty by default.
  - Preserve all marker prompts (`chatHistory`, `worldInfoBefore`, etc.).
- [ ] Preset doubles as the default for Nova: Nova's system prompt is
  layered *on top of* the preset's Main Prompt; tool-use contract is added at
  request build time by Nova (not baked into the preset).

### 11b. Install flow
- [ ] In-settings button "Install Command-X preset" calls
  `ctx.executeSlashCommandsWithOptions('/preset-import …')` or, if absent,
  uses `POST /api/presets/save` with the preset body (the standard ST API).
- [ ] After install, show toast with the preset's name so the user can pick it
  in the Connection Profile.

### 11c. Research basis
- [ ] Modeled on the upstream ST default preset
  (`SillyTavern/SillyTavern@default/content/presets/openai/Default.json`),
  trimmed for Command-X defaults. Public community presets (e.g. Celia,
  Marinara, Universal Light) reviewed for conventions around `wi_format`,
  `scenario_format`, and `names_behavior`; Command-X preset aligns with the
  "simple, portable, provider-agnostic" end of that spectrum.

### 11d. Docs
- [ ] `presets/openai/README.md` documenting: what each field is tuned for,
  how to import, how to clone for other providers (Claude/Gemini/OpenRouter)
  by changing `chat_completion_source` and corresponding `*_model`.

---

## 12. Documentation Updates

- [ ] `README.md`: rewrite order — Features → Install → Nova Agent → Preset →
  Tag Reference → Advanced.
- [ ] `docs/nova-agent-plan.md` (this file).
- [ ] Update `.github/copilot-instructions.md` and `CLAUDE.md`: drop OpenClaw,
  add Nova sections mirroring the same depth (state vars, event flow,
  pitfalls, constants). Note the `/* === NOVA AGENT === */` code section.
- [ ] Append an entry to `AGENT_MEMORY.md` at the end of the PR.

---

## 13. Tests

All under `test/` using Node `--test`.
- [x] `nova-paths.test.mjs` — path-normalisation helper.
- [x] `nova-tool-args.test.mjs` — JSON-schema validation of each
  `NOVA_TOOLS[].parameters` against sample args.
- [ ] `nova-profile-swap.test.mjs` — mocks `executeSlashCommandsWithOptions`;
  verifies swap/restore on throw and mutex serialisation.
  - **Partially covered by `test/nova-turn.test.mjs`** (profile snapshot +
    swap + restore including the `sendRequest` throws case). A dedicated
    mutex serialisation test lands with Phase 3c when the caller wires the
    module-level controller up to the composer UI.
- [x] `nova-prompt-compose.test.mjs` — soul+memory concatenation, truncation,
  skill ordering.
- [ ] `nova-audit-redact.test.mjs` — audit entries never include raw content.
- [x] `nova-preset.test.mjs` — validates the shipped preset JSON parses,
  contains required top-level fields, has all marker prompts present, and
  `prompt_order` references only defined identifiers.
- [x] `nova-state.test.mjs` — per-chat state helpers (not in original list;
  shipped with Phase 3a).
- [x] `nova-ui-scaffolding.test.mjs` — Phase 2 static source-text assertions.
- [x] `nova-diff.test.mjs` — unified-diff preview (Phase 4c).
- [x] `nova-migration.test.mjs` — legacy OpenClaw chatMetadata migration
  (Phase 1f / §10).
- [x] `nova-plugin.test.mjs` — nova-agent-bridge plugin exports + route
  wiring + /manifest shape (not in original list; shipped with Phase 8a/b
  scaffold).
- [x] `nova-turn.test.mjs` — Phase 3b turn lifecycle: precondition
  validation, happy path (user + assistant push, system-prompt
  composition, signal propagation), profile snapshot/swap/restore
  including `sendRequest`-throws and restore-failure paths,
  re-entrancy guard, deferred-tool-calls placeholder, plus source-shape
  assertions on `index.js` (23 assertions).
- [x] Keep `helpers.test.mjs` green.

---

## 14. Manual Validation

- [ ] Reload ST → console logs `[command-x] v0.13.0 Loaded OK` without errors.
- [ ] OpenClaw no longer on the home screen.
- [ ] Nova tile opens to empty transcript + "Pick a connection profile" card.
- [ ] Install preset via the Settings button → preset appears in ST; set as
  active on a new profile named "Command-X".
- [ ] Point Nova at that profile; Read-only turn ("list my characters") →
  `st_list_characters` card renders; assistant summarises.
- [ ] Elevate to Write + Character Creator → "Create Aria, a hacker" → Nova
  proposes `fs_write` → approval modal with diff → approve → file written →
  re-read.
- [ ] Worldbook Creator: 3 entries → load in ST's Worldbook UI, schema valid.
- [ ] Image Prompter mid-RP → structured positive/negative prompts.
- [ ] Edit `soul.md` via in-phone editor → next turn reflects change.
- [ ] Install `nova-agent-bridge` → `/fs/list` works → `shell_run` `git status`
  works behind approval → audit log exists.
- [ ] Uninstall bridge → Nova works with ST-API subset; yellow banner shows.
- [ ] Cancel mid-turn → loop aborts; profile restored (verify via `/profile`).
- [ ] Swipe underlying ST chat → Nova transcript untouched.

---

## Amendments log

- **2026-04-22** — User approved plan and added §11: ship a Chat Completion
  preset usable by Nova and other Command-X utilities. Schema modeled on
  upstream ST `Default.json`. Plan saved to this file prior to starting work.
