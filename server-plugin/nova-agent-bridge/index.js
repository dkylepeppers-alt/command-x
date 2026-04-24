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
const CAPABILITIES = Object.freeze({
    fs_list: false,
    fs_read: false,
    fs_write: false,
    fs_delete: false,
    fs_move: false,
    fs_stat: false,
    fs_search: false,
    shell_run: false,
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

/**
 * Express plugin init. Kept synchronous aside from the returned Promise so
 * any thrown error during router wiring propagates up to ST's plugin
 * loader instead of silently registering a broken plugin.
 */
async function init(router) {
    const configPath = path.resolve(__dirname, 'config.yaml');
    const root = resolveRoot(configPath);

    router.get('/manifest', (_req, res) => {
        res.json({
            id: PLUGIN_ID,
            version: PLUGIN_VERSION,
            root,
            shellAllowList: DEFAULT_SHELL_ALLOW.slice(),
            capabilities: CAPABILITIES,
        });
    });

    router.get('/health', (_req, res) => {
        res.json({ ok: true, id: PLUGIN_ID, version: PLUGIN_VERSION });
    });

    // Placeholder fs/* and shell/* routes — explicit 501 so the extension
    // can distinguish "plugin present but tool not implemented" from
    // "plugin missing entirely" (404 from ST's router).
    const notImplemented = (route) => (_req, res) => {
        res.status(501).json({
            error: 'not-implemented',
            plugin: PLUGIN_ID,
            version: PLUGIN_VERSION,
            route,
        });
    };

    router.get('/fs/list', notImplemented('/fs/list'));
    router.get('/fs/read', notImplemented('/fs/read'));
    router.post('/fs/write', notImplemented('/fs/write'));
    router.post('/fs/delete', notImplemented('/fs/delete'));
    router.post('/fs/move', notImplemented('/fs/move'));
    router.get('/fs/stat', notImplemented('/fs/stat'));
    router.post('/fs/search', notImplemented('/fs/search'));
    router.post('/shell/run', notImplemented('/shell/run'));

    console.log(`[${PLUGIN_ID}] loaded — root=${root}`);
    return Promise.resolve();
}

async function exit() {
    // Plan §8d — flush audit log, release handles. Nothing to flush yet;
    // stays a Promise so future async teardown slots in without changing
    // the export shape.
    return Promise.resolve();
}

module.exports = {
    init,
    exit,
    info: {
        id: PLUGIN_ID,
        name: 'Nova Agent Bridge',
        description: 'Filesystem and shell bridge for the Command-X Nova agent. Scaffold — routes wired, fs/shell handlers pending.',
    },
    // Exposed for unit tests / other modules. Not part of the plugin contract.
    _internal: { resolveRoot, resolvePluginVersion, PLUGIN_VERSION, DEFAULT_SHELL_ALLOW, CAPABILITIES },
};
