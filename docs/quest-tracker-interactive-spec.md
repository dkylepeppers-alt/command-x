# Command-X Interactive Quest Tracker Spec

Last updated: 2026-04-01

## Goal

Upgrade the existing Quest Tracker into a **fully interactive quest/task system** with:
- richer quest state
- manual interaction controls
- automatic quest updates from roleplay
- stronger but still natural narrative influence
- tighter integration with Command-X contacts/threads when relevant

This spec also tracks a related side fix:
- **group chat duplicate contact dedupe**, where the same character can appear both as a real character contact and as a duplicate NPC contact

---

## Core Principles

1. **Quests are living state, not static notes**
   - quests should evolve over time
   - they should track progress, blockers, urgency, and next actions
   - they should invite interaction, not just record it

2. **Manual + automatic coexistence**
   - the model may add or update quest state automatically
   - the user may manually add/edit/focus/resolve quests
   - user-driven values must not be blindly overwritten

3. **Narrative influence should be weighted, not spammy**
   - focused/high-urgency/high-priority quests should matter more
   - quests should shape priorities and decision pressure
   - they should not be forced into every response unnaturally

4. **Quest data should connect to the rest of Command-X**
   - quests may reference contacts
   - quests may expose actions like opening a thread or texting a contact
   - quest state should feel integrated with the phone, not siloed from it

5. **Contact identity should remain clean in group chats**
   - the same person should not appear twice because one entry came from ST characters and another from stored NPC/profile status

---

## Expanded Quest Model

Suggested quest object shape:

```json
{
  "id": "quest_123",
  "title": "Meet Sarah at the diner",
  "summary": "Hear her out before 8 PM.",
  "objective": "Get to the diner tonight",
  "status": "active",
  "priority": "high",
  "urgency": "urgent",
  "source": "Sarah",
  "relatedContact": "Sarah",
  "focused": true,
  "nextAction": "Text Sarah that you're on your way",
  "subtasks": [
    { "id": "sub_1", "text": "Leave apartment", "done": true },
    { "id": "sub_2", "text": "Arrive before 8 PM", "done": false }
  ],
  "notes": "She sounded tense.",
  "updatedAt": 1712034720,
  "manualOverrides": {
    "title": false,
    "summary": false,
    "objective": false,
    "status": false,
    "priority": false,
    "urgency": false,
    "source": false,
    "relatedContact": false,
    "focused": false,
    "nextAction": false,
    "subtasks": false,
    "notes": false
  }
}
```

### Required fields
- `id`
- `title`
- `status`
- `updatedAt`

### Recommended fields
- `summary`
- `objective`
- `priority`
- `urgency`
- `source`
- `relatedContact`
- `focused`
- `nextAction`
- `subtasks`
- `notes`
- `manualOverrides`

### Allowed statuses
- `active`
- `waiting`
- `blocked`
- `completed`
- `failed`

### Allowed priorities
- `low`
- `normal`
- `high`
- `critical`

### Allowed urgencies
- `none`
- `soon`
- `urgent`

---

## Interactive Behaviors

### Quest card actions
Each quest card should support:
- Edit
- Focus / Unfocus
- Complete
- Fail
- Optional status controls like Wait / Block
- If `relatedContact` exists:
  - Open Thread
  - Text Contact

### Subtasks
- quests may contain subtasks/checklist items
- user can manually toggle them
- model may update them automatically when story progress changes
- subtasks should help visualize progress without requiring a full objective tree system

### Focused Quest
- only one quest should ideally be focused at a time (preferred v1.1 behavior)
- focused quest receives stronger narrative relevance weighting
- focused quest should render with stronger visual prominence

### Next Action
- each active quest may optionally expose a `nextAction`
- this can guide both the user and the narrative

---

## Automatic Update Path

The model should be able to emit richer structured quest updates.

### Tag
Use the existing quest tag family:
- `[quests][...JSON...][/quests]`

### Model responsibilities
The model may:
- create quests
- update quest fields
- add or revise subtasks
- update next action
- change status/urgency/priority
- mark quests completed or failed when clearly resolved

### Guardrails
- avoid duplicating the same quest repeatedly
- avoid turning trivial one-off actions into quests
- avoid excessive churn to quest state every turn
- prefer meaningful updates

---

## Manual Override Rules

User edits must be protected field-by-field.

### Rule
When the user manually edits a field, later auto-updates should not overwrite that field unless:
- the user edits it again
- the user clears it
- the merge logic explicitly permits it for a non-pinned field

This should apply to:
- title
- summary
- objective
- status
- priority
- urgency
- source
- relatedContact
- focused
- nextAction
- subtasks
- notes

---

## Narrative Influence Rules

Quest state should be summarized back into model context.

### Influence goals
The model should naturally account for:
- unresolved goals
- blocked or waiting states
- urgent/high-priority pressures
- the currently focused quest
- unfinished subtasks when relevant

### Weighting guidance
Narrative relevance should be weighted approximately like this:
1. focused quest
2. urgent/high-priority active quests
3. other active quests
4. waiting/blocked quests
5. completed/failed quests (historical only, not active pressure)

### Prompt behavior
Injected quest context should explicitly say:
- active quests are unresolved narrative pressures/goals
- focused quest matters most
- not every quest must be mentioned every turn
- completed/failed quests should not be treated as active pressure

---

## UI / UX Upgrade Targets

### Quests app view
Should support:
- Active section
- Waiting/Blocked section (can be grouped or separate)
- Completed section
- Failed section
- Focused quest prominence

### Quest card display
Should include, where available:
- title
- status badge
- priority badge
- urgency badge
- summary/objective
- next action
- related contact
- subtasks progress
- notes

### Manual editor
Should support editing:
- title
- summary
- objective
- status
- priority
- urgency
- source
- relatedContact
- focused
- nextAction
- subtasks
- notes

---

## Contact Integration

If a quest has a `relatedContact` and that contact exists in Command-X:
- the quest card may provide a shortcut to open the thread
- optional later: quick compose from the quest

This makes quests feel integrated with the phone ecosystem.

---

## Side Fix — Group Chat Duplicate Contact Dedupe

### Problem
In group chats, the phone may show:
- one contact from real ST character resolution
- another duplicate contact from stored NPC/profile state
for the **same actual character**

### Desired behavior
A single character should appear once in the contact list/profile list.

### Likely cause
Contact identity/merge logic is probably not deduping robustly enough between:
- ST character contacts
- stored NPC/profile contacts
- `[status]`-derived entries

### Fix goals
- normalize identity matching more reliably
- prefer ST character entry as the canonical contact when both exist
- merge stored/profile fields into that canonical entry
- avoid presenting duplicate rows/cards for the same person in group contexts

This should be handled as part of the same implementation pass if practical.

---

## Non-Goals for this pass

- quest dependency trees
- quest rewards/XP
- due-date schedulers/reminders
- global cross-chat quest syncing
- perfect entity resolution across wildly inconsistent naming schemes

---

## Summary

This upgrade should turn the Quest Tracker into a **fully interactive, evolving story-state system**.

It should:
- support richer quest state
- support manual and automatic updates
- surface actions and progress clearly
- influence the narrative in a weighted, natural way
- integrate with related contacts/threads where possible
- fix obvious duplicate-contact issues in group chats
