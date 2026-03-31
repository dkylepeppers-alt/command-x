# Command-X Hybrid Private Texting — Implementation Plan

Last updated: 2026-03-31
Status: phases 1–4 implemented; local validation/commit done; push/runtime sync pending

## Goal

Implement the **manual hybrid** private-texting system described in `docs/private-phone-hybrid-spec.md`.

This version should allow Command-X to generate inbound texts from **any known contact** without displaying those texts in visible ST chat, while preserving them as private background canon.

---

## Success Criteria

- [x] Known contacts can be used as senders for out-of-band inbound texts
- [x] A user-triggered action exists in Command-X UI to check/poll for private messages
- [x] Out-of-band private texts are stored in Command-X without appearing in visible ST chat
- [x] Private phone events can be summarized/injected back into model context as **private**, non-public knowledge
- [x] Prompting explicitly prevents other scene characters from automatically knowing private phone content
- [x] Existing inline `[sms]` behavior keeps working
- [ ] Implementation is validated and reviewed before push

---

## Work Phases

### Phase 1 — Foundation / state model
- [x] Define private phone event structure
- [x] Add storage helpers for private/out-of-band phone events
- [x] Decide whether to reuse message store or add parallel event store
- [x] Add private-context summary builder for recent phone events

### Phase 2 — Generation pipeline
- [x] Add a separate out-of-band generation path
- [x] Build sender pool from known contacts
- [x] Create strict output format for phone-only generation
- [x] Add parser for out-of-band generated SMS/events
- [x] Make generation return 0–N messages cleanly

### Phase 3 — Privacy / context rules
- [x] Add private-context injection prompt
- [x] Explicitly mark private phone texts as not automatically known by other scene characters
- [x] Ensure sender + user know the message, but bystanders do not by default
- [x] Prevent visible ST chat pollution from out-of-band events

### Phase 4 — UI / UX
- [x] Add a user-triggered action in Command-X (ex: `Check Messages` / `Poll Contacts`)
- [x] Show resulting private texts in phone threads
- [x] Trigger badge/toast updates for out-of-band inbound texts
- [x] Add any needed settings/toggles for manual hybrid mode

### Phase 5 — Validation
- [x] Static validation / syntax checks
- [ ] Reviewer pass on architecture and privacy model
- [ ] Live runtime validation in ST copy
- [x] Commit in canonical repo
- [ ] Push to GitHub
- [ ] Fast-forward ST copy from GitHub

---

## Orchestration Notes

Planned division of work:

- **Implementer agent**
  - builds the feature in `~/projects/command-x`
- **Reviewer agent**
  - audits privacy model, state handling, and regression risks
- **Main agent (me)**
  - keeps checklist updated
  - sanity-checks repo state
  - communicates progress
  - decides when to sync to live ST copy

---


## Current Status Notes

- Canonical repo: `~/projects/command-x`
- Source of truth: GitHub
- Live deployed copy: `~/SillyTavern/public/scripts/extensions/third-party/command-x`
- Manual hybrid private texting now uses a dedicated quiet-generation path (`generateQuietPrompt`) with JSON-schema output, private event storage in chat metadata, and a persistent privacy-scoped context injection prompt.
- Known contacts for private polling now include current chat contacts, stored NPC/manual contacts, and history-only contacts inferred from existing Command-X message logs for the current chat.
- UI adds a `Check Messages` action plus settings toggles for manual hybrid private texting; out-of-band results go to phone threads/unread badges/toasts only.
- Inline `[sms]` flow remains in place and now also feeds the private-event summary store.
- Current known open bug unrelated to this plan: manual Add Contact feature appears broken and should be revisited later
