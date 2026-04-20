# Code Review Improvement Plan

Tracking checklist for acting on the v0.10.0 comprehensive code review.
The canonical, live version of this checklist lives in the pull request
description. This file is a stable, in-repo snapshot so that the plan
can be browsed and referenced from the source tree.

## Phase 1 — Correctness & security fixes (high priority)

- [ ] Clear the 30s clock `setInterval` on `rebuildPhone()` / `destroyPanel()`
      to stop timer accumulation.
- [ ] Escape all LLM-sourced strings (contact name, avatar URL, mood,
      thoughts, toast text) that are interpolated into HTML templates.
- [ ] Replace the inline `onerror=` handler on avatar `<img>` with a
      delegated, CSP-safe listener.
- [ ] Fix `enrichQuestDraftIfNeeded` to use `{ quietPrompt, jsonSchema }`
      (matches `pollPrivateMessages`).
- [ ] Gate `eventSource` handlers (MESSAGE_RECEIVED /
      CHARACTER_MESSAGE_RENDERED / USER_MESSAGE_RENDERED / MESSAGE_SWIPED /
      MESSAGE_DELETED / CHAT_CHANGED) on `settings.enabled`.
- [ ] Fix `MESSAGE_DELETED` to use the event's `mesId` argument and handle
      non-tail deletions correctly.
- [ ] Make `escHtml` string-coerce its input and unify with `escapeHtml`.
- [ ] Persist defaults written by `getExtensionChatState` /
      `getOpenClawChatState` on first init (call `saveMetadata` once).
- [ ] Arm a cleanup timeout for `awaitingReply` in `sendImmediate` (parity
      with `flushQueue`).
- [ ] Tighten `[sms]` reply-capture fallback: drop the "first contact"
      fallback and require `to="user"` or `awaitingReply`.

## Phase 2 — Performance & storage

- [ ] Cache `historyContactNames()` results; invalidate on write.
- [ ] Cache last-message timestamp per contact; stop JSON-parsing every
      thread on sort.
- [ ] Move avatar data URLs out of `localStorage` into IndexedDB (or a
      global-scoped key).
- [ ] Add a size/length cap to `safeDataUrlFromFile` before
      `drawImage` / `toDataURL`.
- [ ] Throttle `[status]` / `[quests]` prompt injection (skip every N
      turns, configurable).

## Phase 3 — Architecture & maintainability

- [ ] Split `index.js` (~3.7k lines) into focused modules (`storage`,
      `prompts`, `parse`, `contacts`, `quests`, `openclaw`, `ui/*`).
- [ ] Introduce a safe ``html`` `` tagged-template helper; migrate template
      literals to it.
- [ ] Centralize module-scoped mutable state into one `state` object.
- [ ] Extract magic numbers and the gradient palette into named constants.
- [ ] Remove the legacy single-call compatibility in `injectSmsPrompt`.
- [ ] Add `node --test` unit tests for pure helpers (tag extractors,
      sanitizers, mergers).

## Phase 4 — UX & accessibility

- [ ] Add keyboard / `role="button"` / `aria-label` support to clickable
      `<div>` controls.
- [ ] Replace `alert` / `confirm` calls with styled in-phone modals.
- [ ] Add dismiss-on-Esc and pause-on-hover for toast notifications.
- [ ] Disable the send button during `sendToChat` to prevent double-send.

## Phase 5 — Docs & housekeeping

- [ ] Regenerate `.github/copilot-instructions.md` and `CLAUDE.md` to
      reflect v0.10.0 reality.
- [ ] Single-source the version string (manifest + README + `console.log`).
- [ ] Document the private-poll and OpenClaw operate-mode flows in README.
