# Nova — Memory

> Durable notes Nova keeps across sessions. Nova appends to this file via the
> `nova_append_memory` tool (with user approval). Entries should be short,
> dated, and factual. Delete stale entries aggressively — context is scarce.
>
> **Lifecycle:** the version checked into the repo is the *install-time
> default* — typically empty or example-only. At runtime Nova owns this
> file: every approved `nova_append_memory` call writes back via the
> bridge's `routes-soul-memory.js`. The runtime copy on a user's machine
> diverges from the repo copy as soon as Nova learns anything; do not
> assume the repo version reflects what any installed agent has stored.

## User preferences

<!-- e.g. "2026-04-22 — User prefers SDXL Anime booru tag prompts over natural-language." -->

## Project notes

<!-- e.g. "2026-04-22 — User's ST install is at ~/apps/SillyTavern. Plugins live under ./plugins/." -->

## Recent wins / failures

<!-- e.g. "2026-04-22 — Created characters/aria.json; user confirmed schema v2 validated." -->
<!-- e.g. "2026-04-22 — fs_write to worlds/eden.json rejected — schema mismatch on `entries` map." -->

## Do not do

<!-- e.g. "2026-04-22 — Never auto-run `git push`. User reviews every commit." -->
