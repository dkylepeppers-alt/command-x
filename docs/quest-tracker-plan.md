# Command-X Quest Tracker — Implementation Plan

Last updated: 2026-03-31
Status: implementation complete, local validation complete

## Goal

Implement the Quest Tracker described in `docs/quest-tracker-spec.md`.

This version should support:
- automatic quest extraction/update from roleplay
- manual add/edit management
- persistent quest state per chat
- quest influence on future narrative

---

## Success Criteria

- [x] Quest app exists on the Command-X home screen
- [x] Quests can be automatically created/updated via structured extraction
- [x] User can manually add quests
- [x] User can manually edit quests
- [x] User can mark quests complete/failed
- [x] Quest state persists per chat
- [x] Active quests influence future narrative via context injection
- [x] Manual quest edits are not blindly overwritten by later auto updates
- [x] Implementation is validated and reviewed before push

---

## Work Phases

### Phase 1 — State / data model
- [x] Define quest object shape
- [x] Add quest storage helpers
- [x] Add quest merge/update logic
- [x] Add manual override tracking

### Phase 2 — Prompting / extraction
- [x] Add `[quests]` extraction path
- [x] Add quest parser
- [x] Add quest prompt injection
- [x] Ensure quest updates are sparse/relevant rather than noisy

### Phase 3 — Narrative influence
- [x] Add active-quest summary builder
- [x] Inject active quest context back into model prompt
- [x] Weight active/high-priority quests as background relevance
- [x] Avoid forcing quest mentions every turn

### Phase 4 — UI / UX
- [x] Add Quests app icon to home screen
- [x] Add Quests view
- [x] Add manual quest editor UI
- [x] Add complete/fail actions
- [x] Add active/completed/failed sections

### Phase 5 — Validation / ship
- [x] Static validation / syntax checks
- [x] Reviewer pass on merge logic and narrative influence
- [ ] Live runtime validation in ST copy (not run in this implementation pass)
- [x] Commit in canonical repo
- [ ] Push to GitHub (intentionally not done here)
- [ ] Fast-forward ST copy from GitHub (not done here)

---

## Orchestration Notes

Planned division of work:

- **Implementer agent**
  - builds quest tracker in `~/projects/command-x`
- **Reviewer agent**
  - audits merge behavior, UI coherence, and prompt/context influence
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
- Desired behavior: quests should be editable/addable manually and should influence the narrative as structured state
- 2026-03-31 implementation pass: quest store, `[quests]` parser/merge, prompt injection, Quests app UI, manual editor, and complete/fail actions are in place in the canonical repo.
- Validation completed locally with `node --check index.js` plus diff inspection. Live ST runtime validation still remains as a separate follow-up.
