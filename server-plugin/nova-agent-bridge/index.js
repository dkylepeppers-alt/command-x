/**
 * nova-agent-bridge — SillyTavern server plugin (plan §8).
 *
 * Scaffold phase: wires `info`, `init`, `exit`, and the two read-only
 * discovery routes (`GET /manifest`, `GET /health`). The filesystem and
 * shell routes (plan §8b) land in follow-up sprints once path safety,
 * audit logging, and CSRF checks have their own tests. Until then the
 * fs/shell paths return `501 Not Implemented` so the extension's
 * capability probe (plan §4f) sees the plugin *and* knows what is/isn't
 * ready, rather than silently succeeding on stubs.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { normalizeNovaPath } = require('./paths.js');
const {
    createFsListHandler,
    createFsReadHandler,
    createFsStatHandler,
    createFsSearchHandler,
} = require('./routes-fs-read.js');
const {
    createFsWriteHandler,
    createFsDeleteHandler,
    createFsMoveHandler,
} = require('./routes-fs-write.js');
const { createShellRunHandler } = require('./routes-shell.js');
const { buildAuditLogger } = require('./audit.js');
const { buildNovaSecurityMiddleware } = require('./middleware.js');

const PLUGIN_ID = 'nova-agent-bridge';

/**
 * Single-source the plugin version from `package.json` so `/manifest.version`
 * can never drift from the installed package. Falls back to '0.0.0' with a
 * warning if the manifest is somehow unreadable — the plugin should still
 * load in that case, just without a meaningful version string.
 */
function resolvePluginVersion() {
    try {
        const pkgPath = path.join(__dirname, 'package.json');
        const raw = fs.readFileSync(pkgPath, 'utf8');
        const pkg = JSON.parse(raw);
        if (typeof pkg.version === 'string' && pkg.version.trim().length > 0) {
            return pkg.version.trim();
        }
    } catch (e) {
        console.warn(`[${PLUGIN_ID}] package.json version read failed:`, e?.message || e);
    }
    return '0.0.0';
}

const PLUGIN_VERSION = resolvePluginVersion();

// Plan §4b — shell allow-list. Kept as a static list here; a future config
// loader (§8a config.yaml) will override via `NOVA_SHELL_ALLOW` or equivalent.
const DEFAULT_SHELL_ALLOW = Object.freeze([
    'node', 'npm', 'git', 'python', 'python3',
    'grep', 'rg', 'ls', 'cat', 'head', 'tail', 'wc', 'find',
]);

// Capabilities surface advertised via /manifest. Keys are plan-stable
// identifiers the extension reads during Phase 4f capability discovery.
// `false` means "route exists but not yet implemented in this build" so
// the UI can render a yellow "partial support" banner instead of silently
// degrading.
//
// `shell_run` is no longer a static `false` — its presence depends on
// whether `resolveAllowList` (called at init time) found at least one
// binary on PATH. The actual value is computed in `init()` and merged
// into the manifest response there.
const BASE_CAPABILITIES = Object.freeze({
    fs_list: true,
    fs_read: true,
    fs_write: true,
    fs_delete: true,
    fs_move: true,
    fs_stat: true,
    fs_search: true,
});

/**
 * Resolve the filesystem root the plugin is allowed to touch. Plan §8c says
 * "`process.cwd()` by default; override via `config.yaml: root:`." We keep
 * that contract here and surface whatever we chose via `/manifest`.
 *
 * The config-file loader itself is deliberately minimal — we only read
 * `root:` as a plain `key: value` line so we stay zero-dep. A future sprint
 * can swap in a real YAML parser if the shape grows.
 */
function resolveRoot(configPath) {
    try {
        if (configPath && fs.existsSync(configPath)) {
            const raw = fs.readFileSync(configPath, 'utf8');
            const m = raw.match(/^\s*root\s*:\s*(.+?)\s*$/m);
            if (m && m[1]) {
                // Strip surrounding quotes if present.
                // The `g` flag is required: the regex is `^['"]|['"]$`
                // (alternation). Without `g`, `.replace` stops after the
                // first match and only the leading quote would be stripped.
                const stripped = m[1].replace(/^['"]|['"]$/g, '').trim();
                if (stripped.length > 0) return path.resolve(stripped);
            }
        }
    } catch (e) {
        console.warn(`[${PLUGIN_ID}] config read failed:`, e?.message || e);
    }
    return path.resolve(process.cwd());
}

// Module-scoped so exit() can close the audit logger on teardown. Kept at
// module level rather than a closure because init() returns before the
// logger is retained anywhere else.
let activeAuditLogger = null;

/**
 * Choose the audit log path (plan §8c). Prefers `<root>/data/_nova-audit.jsonl`
 * when the ST-style `data/` directory exists under the root. Falls back to
 * `<root>/_nova-audit.jsonl` otherwise. Resolved once at init time.
 */
function resolveAuditLogPath(root) {
    try {
        const dataDir = path.join(root, 'data');
        const st = fs.statSync(dataDir);
        if (st && st.isDirectory()) return path.join(dataDir, '_nova-audit.jsonl');
    } catch { /* falls through to root */ }
    return path.join(root, '_nova-audit.jsonl');
}

/**
 * Walk `process.env.PATH` and resolve each name in `names` to its absolute
 * path. Returns `{ [name]: absolutePath }` for every binary found.
 *
 * Plan §8c: "Shell: no `shell: true`; binaries resolved via allow-list at
 * startup." Resolving once at init means a later PATH change can't
 * redirect us to a different binary, AND missing binaries (e.g. `python3`
 * on a host that only has `python`) cleanly drop out of the allow-list
 * rather than failing with ENOENT every call.
 *
 * Adds a `.exe` suffix on Windows (POSIX hosts treat `.exe` as a normal
 * filename, so the suffix-less branch covers them). On both, the first
 * directory that contains the binary wins.
 *
 * Resilient to a malformed PATH: returns `{}` rather than throwing.
 */
function resolveAllowList(names) {
    const out = {};
    if (!Array.isArray(names) || names.length === 0) return out;
    let pathEnv = '';
    try { pathEnv = String(process.env.PATH || ''); }
    catch { return out; }
    if (!pathEnv) return out;
    const sep = process.platform === 'win32' ? ';' : ':';
    const dirs = pathEnv.split(sep).filter(Boolean);
    const exts = process.platform === 'win32'
        ? ['.exe', '.cmd', '.bat', '']
        : [''];
    for (const name of names) {
        if (typeof name !== 'string' || name.length === 0) continue;
        // Refuse path-like names — only bare command names are allow-listed.
        // `node`, `npm`, `git` are fine; `/usr/bin/node` or `..\node` are not.
        if (name.includes('/') || name.includes('\\')) continue;
        for (const dir of dirs) {
            let found = null;
            for (const ext of exts) {
                const candidate = path.join(dir, name + ext);
                try {
                    const st = fs.statSync(candidate);
                    if (st && st.isFile()) { found = candidate; break; }
                } catch { /* try next ext */ }
            }
            if (found) {
                out[name] = found;
                break;
            }
        }
    }
    return out;
}

/**
 * Express plugin init. Kept synchronous aside from the returned Promise so
 * any thrown error during router wiring propagates up to ST's plugin
 * loader instead of silently registering a broken plugin.
 */
async function init(router) {
    const configPath = path.resolve(__dirname, 'config.yaml');
    const root = resolveRoot(configPath);
    const auditLogPath = resolveAuditLogPath(root);
    activeAuditLogger = buildAuditLogger({ logPath: auditLogPath });

    // Plan §4b / §8c — resolve the shell allow-list once at startup.
    // `shell_run` is enabled in the manifest only when at least one
    // allow-listed binary was found on PATH. The shell handler refuses
    // commands not in this map.
    const resolvedAllowList = resolveAllowList(DEFAULT_SHELL_ALLOW);
    const capabilities = Object.freeze({
        ...BASE_CAPABILITIES,
        shell_run: Object.keys(resolvedAllowList).length > 0,
    });

    // Plan §8c — belt-and-suspenders session + CSRF check. ST's global
    // `csrf-sync` middleware already protects these routes when the
    // host is configured normally; this re-check means the plugin
    // stays safe if ST is run with `--disableCsrf` or if the mount
    // ordering ever changes. `/health` and `/manifest` are exempt so
    // the extension's capability probe keeps working before a user
    // session exists.
    router.use(buildNovaSecurityMiddleware());

    router.get('/manifest', (_req, res) => {
        res.json({
            id: PLUGIN_ID,
            version: PLUGIN_VERSION,
            root,
            // Surface only the names of resolved binaries (extension's
            // capability probe expects `Array.isArray(shellAllowList)`).
            // Absolute paths are an internal plugin detail.
            shellAllowList: Object.keys(resolvedAllowList),
            capabilities,
            auditLogPath,
        });
    });

    router.get('/health', (_req, res) => {
        res.json({ ok: true, id: PLUGIN_ID, version: PLUGIN_VERSION });
    });

    // Shared handler dependencies. The write-side factories additionally
    // receive the audit logger so every write/delete/move appends an entry.
    const fsReadDeps = { root, normalizePath: normalizeNovaPath };
    const fsWriteDeps = { ...fsReadDeps, auditLogger: activeAuditLogger };

    router.get('/fs/list', createFsListHandler(fsReadDeps));
    router.get('/fs/read', createFsReadHandler(fsReadDeps));
    router.get('/fs/stat', createFsStatHandler(fsReadDeps));
    router.post('/fs/search', createFsSearchHandler(fsReadDeps));

    router.post('/fs/write', createFsWriteHandler(fsWriteDeps));
    router.post('/fs/delete', createFsDeleteHandler(fsWriteDeps));
    router.post('/fs/move', createFsMoveHandler(fsWriteDeps));

    // Plan §4b / §8b — shell route. When the allow-list is empty, the
    // route is still wired (so the LLM gets a deterministic
    // `command-not-allowed` error rather than a 404) but every call
    // refuses; the manifest reflects this via `capabilities.shell_run:false`.
    router.post('/shell/run', createShellRunHandler({
        root,
        normalizePath: normalizeNovaPath,
        allowList: resolvedAllowList,
        auditLogger: activeAuditLogger,
    }));

    console.log(`[${PLUGIN_ID}] loaded — root=${root} audit=${auditLogPath} shell=${capabilities.shell_run ? Object.keys(resolvedAllowList).length + ' binaries' : 'disabled (no binaries on PATH)'}`);
    return Promise.resolve();
}

async function exit() {
    // Plan §8d — close the audit logger. Today `close()` is a no-op but
    // calling it keeps the lifecycle contract clean for the rotation
    // sprint that may hold a write stream.
    if (activeAuditLogger && typeof activeAuditLogger.close === 'function') {
        try { await activeAuditLogger.close(); } catch { /* best-effort */ }
    }
    activeAuditLogger = null;
    return Promise.resolve();
}

module.exports = {
    init,
    exit,
    info: {
        id: PLUGIN_ID,
        name: 'Nova Agent Bridge',
        description: 'Filesystem and shell bridge for the Command-X Nova agent.',
    },
    // Exposed for unit tests / other modules. Not part of the plugin contract.
    _internal: { resolveRoot, resolvePluginVersion, resolveAuditLogPath, resolveAllowList, PLUGIN_VERSION, DEFAULT_SHELL_ALLOW, BASE_CAPABILITIES },
};
