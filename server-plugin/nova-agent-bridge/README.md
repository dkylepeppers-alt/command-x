# nova-agent-bridge

SillyTavern **server plugin** companion for the Command-X Nova agent. Provides the filesystem and shell surface Nova needs to operate on your SillyTavern install directory.

> ⚠️ Server plugins are **not sandboxed**. They run in the same Node process as SillyTavern itself and have full access to whatever user account ST is running under. Install only if you trust this repository.

## Status

**Scaffold.** This sprint ships:

- `init` / `exit` / `info` exports matching the ST plugin contract.
- `GET /api/plugins/nova-agent-bridge/manifest` — reports version, configured root, shell allow-list, and per-capability implementation status.
- `GET /api/plugins/nova-agent-bridge/health` — liveness probe.
- Placeholder `GET /fs/list`, `GET /fs/read`, `POST /fs/write`, `POST /fs/delete`, `POST /fs/move`, `GET /fs/stat`, `POST /fs/search`, `POST /shell/run` — all return `501 Not Implemented` so the extension's capability probe (plan §4f) can distinguish "plugin present, handler pending" from "plugin missing".
- `paths.js` — pure path-safety helper (normalise + containment check + deny-list) used by every future route.

The `fs_*` and `shell_run` **handlers** land in follow-up sprints. The [`docs/nova-agent-plan.md`](../../docs/nova-agent-plan.md) §8 is the source of truth for the route contract and security model.

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
- Symlink-escape protection (via `fs.realpath`) is layered on top at request-time once the fs handlers land.
- Shell invocations will use `spawn` without `shell: true`, resolve the binary against a static allow-list (`node`, `npm`, `git`, `python`, `python3`, `grep`, `rg`, `ls`, `cat`, `head`, `tail`, `wc`, `find` by default), and enforce a hard timeout (default 60 s).
- All writes and shell invocations will be append-logged to `SillyTavern/data/_nova-audit.jsonl`. Raw file content is **never** logged — only `{ ts, user, route, argsSummary, outcome, bytes }`.

## License

MIT.
