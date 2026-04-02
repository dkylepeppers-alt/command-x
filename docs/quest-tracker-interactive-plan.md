# Command-X Interactive Quest Tracker — Implementation Plan

Last updated: 2026-04-01
Status: implemented in canonical repo; pending live runtime sync/validation

## Goal

Implement the full interactive quest upgrade described in `docs/quest-tracker-interactive-spec.md`, plus fix the group-chat duplicate-contact issue.

---

## Success Criteria

- [x] Quests support richer states (`active`, `waiting`, `blocked`, `completed`, `failed`)
- [x] Quests support urgency
- [x] Quests support focus/pin behavior
- [x] Quests support next action
- [x] Quests support subtasks/checklist items
- [x] Manual editing supports the full interactive quest model
- [x] Auto quest updates can change interactive fields without stomping manual overrides
- [x] Focused/high-urgency quests influence narrative more strongly
- [x] Quest cards integrate with related contacts where possible
- [x] Group-chat duplicate contacts are deduped cleanly
- [x] Implementation is validated and reviewed before push

---

## Work Phases

### Phase 1 — Quest model expansion
- [x] Expand quest schema with urgency, focused, nextAction, subtasks, relatedContact
- [x] Update canonicalization / sanitization helpers
- [x] Update manual override tracking for new fields
- [x] Update merge logic for richer quest state

### Phase 2 — Prompting / auto updates
- [x] Update `[quests]` prompt to support richer fields
- [x] Update parser for richer quest structures
- [x] Weight focused/high-urgency quests in injected context
- [x] Keep updates relevant and non-spammy

### Phase 3 — UI / interactivity
- [x] Add richer quest card UI
- [x] Add focus/unfocus action
- [x] Add waiting/blocked actions or equivalent status controls
- [x] Add subtask rendering and editing/toggling
- [x] Add next-action display
- [x] Add related-contact action when possible

### Phase 4 — Group-chat dedupe fix
- [x] Audit current contact identity merge path
- [x] Fix duplicate character/NPC entries in group chats
- [x] Prefer canonical ST character entry when both exist
- [x] Preserve merged status/profile data on the deduped entry

### Phase 5 — Validation / ship
- [x] Static validation / syntax checks
- [x] Reviewer pass on quest state model, merge logic, and dedupe behavior
- [ ] Live runtime validation in ST copy
- [x] Commit in canonical repo
- [ ] Push to GitHub
- [ ] Fast-forward ST copy from GitHub

---

## Orchestration Notes

Planned division of work:

- **Implementer agent**
  - builds the interactive quest upgrade + dedupe fix in `~/projects/command-x`
- **Reviewer agent**
  - audits quest-state behavior, narrative weighting, and duplicate-contact merge logic
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
- Existing quest tracker is already live; this pass is the interactive upgrade
- Side issue included in scope: group chat duplicate contact dedupe bug
- Implemented in canonical repo: richer quest schema, editor/actions, focused weighting, contact shortcuts, and stronger ST-vs-stored contact dedupe normalization
- Validated locally with `node --check index.js` and diff inspection; not yet synced to the live ST copy in this task
