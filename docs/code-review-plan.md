# Code Review Improvement Plan

Tracking checklist for acting on the v0.10.0 comprehensive code review.
The canonical, live version of this checklist lives in the pull request
description. This file is a stable, in-repo snapshot so that the plan
can be browsed and referenced from the source tree.

## Phase 1 — Correctness & security fixes (high priority)

- [x] Clear the 30s clock `setInterval` on `rebuildPhone()` / `destroyPanel()`
      to stop timer accumulation.
- [x] Escape all LLM-sourced strings (contact name, avatar URL, mood,
      thoughts, toast text) that are interpolated into HTML templates.
- [x] Replace the inline `onerror=` handler on avatar `<img>` with a
      delegated, CSP-safe listener.
- [x] Fix `enrichQuestDraftIfNeeded` to use `{ quietPrompt, jsonSchema }`
      (matches `pollPrivateMessages`).
- [x] Gate `eventSource` handlers (MESSAGE_RECEIVED /
      CHARACTER_MESSAGE_RENDERED / USER_MESSAGE_RENDERED / MESSAGE_SWIPED /
      MESSAGE_DELETED / CHAT_CHANGED) on `settings.enabled`.
- [x] Fix `MESSAGE_DELETED` to use the event's `mesId` argument and handle
      non-tail deletions correctly.
- [x] Make `escHtml` string-coerce its input and unify with `escapeHtml`.
- [x] Persist defaults written by `getExtensionChatState` /
      `getOpenClawChatState` on first init (call `saveMetadata` once).
- [x] Arm a cleanup timeout for `awaitingReply` in `sendImmediate` (parity
      with `flushQueue`).
- [x] Tighten `[sms]` reply-capture fallback: drop the "first contact"
      fallback and require `to="user"` or `awaitingReply`.

## Phase 2 — Performance & storage

- [x] Cache `historyContactNames()` results; invalidate on write.
- [x] Cache last-message timestamp per contact; stop JSON-parsing every
      thread on sort.
- [ ] Move avatar data URLs out of `localStorage` into IndexedDB (or a
      global-scoped key).
- [x] Add a size/length cap to `safeDataUrlFromFile` before
      `drawImage` / `toDataURL`.
- [x] Throttle `[status]` / `[quests]` prompt injection (skip every N
      turns, configurable).

## Phase 3 — Architecture & maintainability

- [ ] Split `index.js` (~3.8k lines) into focused modules (`storage`,
      `prompts`, `parse`, `contacts`, `quests`, `openclaw`, `ui/*`).
      *Deferred — ST loads a single JS entry point; splitting requires a bundler
      or dynamic imports, which changes the extension loading architecture.*
- [ ] Introduce a safe ``html`` `` tagged-template helper; migrate template
      literals to it.
      *Deferred — would require touching hundreds of template literals.*
- [ ] Centralize module-scoped mutable state into one `state` object.
      *Deferred — invasive full-file refactor with high breakage risk.*
- [x] Extract magic numbers and the gradient palette into named constants
      (`CONTACT_GRADIENTS`, `CONTACT_EMOJIS`, `AWAIT_TIMEOUT_MS`,
      `CLOCK_INTERVAL_MS`, `MESSAGE_HISTORY_CAP`, `QUEST_HISTORY_CAP`,
      `TOAST_DURATION_MS`).
- [x] Remove the legacy single-call compatibility in `injectSmsPrompt`.
- [x] Add `node --test` unit tests for pure helpers (tag extractors,
      sanitizers, normalizers) — 63 assertions across 11 suites.

## Phase 4 — UX & accessibility

- [x] Add keyboard / `role="button"` / `aria-label` support to clickable
      `<div>` controls; Enter/Space delegation handler in `wirePhone`.
- [x] Update `aria-pressed` on toggle buttons (`#cx-neural-toggle`,
      `#cx-batch-toggle`) on state change.
- [x] Replace `alert` / `confirm` calls with styled in-phone `cxAlert` /
      `cxConfirm` modals (CSS animation, Esc/Enter keyboard support,
      focus management, `danger` variant for destructive confirms).
- [x] Add dismiss-on-Esc and pause-on-hover for toast notifications.
- [x] Disable `#cx-send` during `sendToChat`; re-enable in
      `clearTypingIndicator()` to prevent double-send.

## Phase 5 — Docs & housekeeping

- [x] Regenerate `CLAUDE.md` to reflect v0.10.0 reality (new apps, state variables,
      named constants, private-poll flow, OpenClaw operate flow, pitfalls, version history).
- [x] Single-source the version string (`const VERSION = '0.10.0'` drives console.log
      and the in-phone version display).
- [x] Document the private-poll and OpenClaw operate-mode flows in README.
