# nova-agent-bridge

SillyTavern **server plugin** companion for the Command-X Nova agent. Provides the filesystem and shell surface Nova needs to operate on your SillyTavern install directory.

> ⚠️ Server plugins are **not sandboxed**. They run in the same Node process as SillyTavern itself and have full access to whatever user account ST is running under. Install only if you trust this repository.

## Status

**Feature-complete for v0.13.0.** Filesystem (read + write) and shell are all shipped.

- `init` / `exit` / `info` exports matching the ST plugin contract.
- `GET /api/plugins/nova-agent-bridge/manifest` — reports version, configured root, shell allow-list, audit log path, and per-capability implementation status.
- `GET /api/plugins/nova-agent-bridge/health` — liveness probe.
- **Implemented filesystem:**
  - `GET /fs/list`, `GET /fs/read`, `GET /fs/stat`, `POST /fs/search` — read-only.
  - `POST /fs/write`, `POST /fs/delete`, `POST /fs/move` — destructive routes. Writes back existing files up to `.nova-trash/<ts>/<path>` before overwrite. Deletes never hard-unlink — they move to trash so an agent mistake is always recoverable. Moves refuse to clobber by default.
- **Implemented shell:** `POST /shell/run` — single-shot, no-shell `child_process.spawn` against an allow-list resolved at startup (default: `node`, `npm`, `git`, `python`, `python3`, `grep`, `rg`, `ls`, `cat`, `head`, `tail`, `wc`, `find`). Hard timeout (default 60s, hard cap 5min), stdin closed, 1 MB per-stream output cap. The manifest reports `capabilities.shell_run: true` only when at least one allow-list binary resolves on `PATH`; otherwise the route refuses with `outcome: "refused-not-allowed"`.
- **Audit log:** every write / delete / move / shell call appends a newline-terminated JSON line to `<root>/data/_nova-audit.jsonl` (preferred) or `<root>/_nova-audit.jsonl` (fallback when no `data/` dir exists). Schema: `{ ts, route, outcome, argsSummary, bytes?, backup?, error? }`. Raw content is NEVER logged — top-level and nested `content` / `data` / `payload` / `body` / `raw` keys are always stripped.
- `paths.js` — pure path-safety helper (normalise + containment check + deny-list).
- `routes-fs-read.js` — read-only handlers + shared `resolveRequestPath` (realpath-reverify, including parent-realpath walk for non-existent write targets so symlink-escape attempts are caught before any fs call).
- `routes-fs-write.js` — write/delete/move handlers + `moveToTrash` helper.
- `routes-shell.js` — shell-run handler.
- `audit.js` — append-only JSONL audit logger factory.

## Install

1. Enable server plugins in your `config.yaml` at the root of your SillyTavern install:
   ```yaml
   enableServerPlugins: true
   ```
2. Copy (or symlink) this directory into `SillyTavern/plugins/nova-agent-bridge`.
3. (Optional) copy `config.example.yaml` → `config.yaml` in the plugin folder and set an explicit `root:` if you want to restrict the plugin to a subdirectory. Default is `process.cwd()`, i.e. the ST install directory.
4. Restart SillyTavern. On startup the server log should show:
   ```
   [nova-agent-bridge] loaded — root=/path/to/your/root
   ```
5. Probe the manifest route to confirm:
   ```
   curl http://localhost:8000/api/plugins/nova-agent-bridge/manifest
   ```

## Security model (plan §8c)

- Every request path is normalised via `paths.js::normalizeNovaPath` against the configured root. Escape attempts (`..`, absolute paths that land outside the root, null bytes) are rejected before any fs call.
- Deny-list denies any path segment equal to `.git` or `node_modules`, and any `plugins/nova-agent-bridge/**` subtree.
- Symlink-escape protection (via `fs.realpath`) is layered on top at request time, including a parent-realpath walk for non-existent write targets so a symlink in an intermediate directory cannot redirect the write outside the root.
- Shell invocations use `spawn` without `shell: true`, resolve the binary against a static allow-list (`node`, `npm`, `git`, `python`, `python3`, `grep`, `rg`, `ls`, `cat`, `head`, `tail`, `wc`, `find` by default) at init time and spawn the absolute path (so a later `PATH` change cannot redirect mid-session), and enforce a hard timeout (default 60s, hard cap 5min, hard min 100ms).
- All writes and shell invocations are append-logged to `<root>/data/_nova-audit.jsonl` (or `<root>/_nova-audit.jsonl` if no `data/` dir). Raw file content and shell-arg values are **never** logged — only `{ ts, route, argsSummary, outcome, bytes? }`.

## License

MIT.
