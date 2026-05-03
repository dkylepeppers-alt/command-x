/**
 * Plugin-level smoke tests for nova-agent-bridge (plan §8a/§8b).
 * Run with: node --test test/nova-plugin.test.mjs
 *
 * Requires the plugin itself (via `createRequire`) because the test
 * subject is the plugin's `init`/`info`/`exit` contract. A small
 * `mockRouter` captures route registrations — we don't spin up Express.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const plugin = require(path.resolve(__dirname, '../server-plugin/nova-agent-bridge/index.js'));

function mockRouter() {
    const routes = [];
    const middlewares = [];
    const handler = (method) => (routePath, h) => {
        assert.equal(typeof h, 'function', `handler for ${method} ${routePath} must be a function`);
        routes.push({ method, path: routePath, handler: h });
    };
    return {
        routes,
        middlewares,
        // `use` captures middleware so we can introspect it but doesn't
        // run it — the integration tests invoke route handlers directly.
        // The middleware itself has its own dedicated unit-test file.
        use(mw) {
            assert.equal(typeof mw, 'function', 'router.use() arg must be a middleware function');
            middlewares.push(mw);
        },
        get: handler('GET'),
        post: handler('POST'),
        put: handler('PUT'),
        delete: handler('DELETE'),
    };
}

function mockRes() {
    const state = { statusCode: 200, body: null };
    const res = {
        status(code) { state.statusCode = code; return res; },
        json(payload) { state.body = payload; return res; },
        get _state() { return state; },
    };
    return res;
}

describe('nova-agent-bridge plugin exports', () => {
    it('exposes the SillyTavern plugin contract (init, exit, info)', () => {
        assert.equal(typeof plugin.init, 'function');
        assert.equal(typeof plugin.exit, 'function');
        assert.equal(typeof plugin.info, 'object');
        assert.equal(plugin.info.id, 'nova-agent-bridge');
        assert.equal(typeof plugin.info.name, 'string');
        assert.equal(typeof plugin.info.description, 'string');
    });

    it('exit() resolves without throwing', async () => {
        await plugin.exit();
    });
});

describe('nova-agent-bridge init()', () => {
    it('wires the documented plan §8b routes', async () => {
        const r = mockRouter();
        await plugin.init(r);
        const pairs = r.routes.map(x => `${x.method} ${x.path}`);
        for (const expected of [
            'GET /manifest',
            'GET /health',
            'GET /fs/list',
            'GET /fs/read',
            'POST /fs/write',
            'POST /fs/delete',
            'POST /fs/move',
            'GET /fs/stat',
            'POST /fs/search',
            'POST /shell/run',
        ]) {
            assert.ok(pairs.includes(expected), `missing route: ${expected}\nwired: ${pairs.join(', ')}`);
        }
    });

    it('mounts the Nova security middleware (plan §8c)', async () => {
        const r = mockRouter();
        await plugin.init(r);
        assert.ok(r.middlewares.length >= 1, 'plugin must register at least one router-level middleware');
        // The first middleware must be the security gate so it runs
        // before any route handler. Check both its name (exported as
        // `novaSecurityMiddleware`) and a behavioural probe: sending a
        // POST without an x-csrf-token must be rejected.
        const [mw] = r.middlewares;
        assert.equal(mw.name, 'novaSecurityMiddleware', 'first router.use() must be novaSecurityMiddleware');
        let statusOut = 0; let bodyOut = null;
        const fakeRes = {
            status(c) { statusOut = c; return this; },
            json(b) { bodyOut = b; return this; },
        };
        let nextCalled = false;
        mw({ method: 'POST', path: '/fs/write', headers: {}, session: { handle: 'u' } }, fakeRes, () => { nextCalled = true; });
        assert.equal(nextCalled, false, 'middleware must not pass-through a POST without CSRF');
        assert.equal(statusOut, 403);
        assert.equal(bodyOut?.error, 'nova-csrf-missing');
    });

    it('/manifest version matches the version in package.json (single source of truth)', async () => {
        const fs = await import('node:fs/promises');
        const raw = await fs.readFile(path.resolve(__dirname, '../server-plugin/nova-agent-bridge/package.json'), 'utf8');
        const pkg = JSON.parse(raw);
        const r = mockRouter();
        await plugin.init(r);
        const manifestRoute = r.routes.find(x => x.method === 'GET' && x.path === '/manifest');
        const res = mockRes();
        manifestRoute.handler({}, res);
        assert.equal(res._state.body.version, pkg.version);
    });

    it('/manifest returns the advertised shape', async () => {
        const r = mockRouter();
        await plugin.init(r);
        const manifestRoute = r.routes.find(x => x.method === 'GET' && x.path === '/manifest');
        const res = mockRes();
        manifestRoute.handler({}, res);
        const body = res._state.body;
        assert.equal(typeof body, 'object');
        assert.equal(body.id, 'nova-agent-bridge');
        assert.equal(typeof body.version, 'string');
        assert.equal(typeof body.root, 'string');
        assert.ok(path.isAbsolute(body.root), 'root should be absolute');
        assert.ok(Array.isArray(body.shellAllowList));
        assert.deepEqual(body.shellAllowList, []);
        assert.equal(body.shell.enabled, false);
        assert.equal(typeof body.capabilities, 'object');
        // Every declared capability key must be a boolean.
        for (const [k, v] of Object.entries(body.capabilities)) {
            assert.equal(typeof v, 'boolean', `capabilities.${k} must be boolean`);
        }
    });

    it('/health returns ok: true', async () => {
        const r = mockRouter();
        await plugin.init(r);
        const health = r.routes.find(x => x.method === 'GET' && x.path === '/health');
        const res = mockRes();
        health.handler({}, res);
        assert.equal(res._state.statusCode, 200);
        assert.equal(res._state.body.ok, true);
        assert.equal(res._state.body.id, 'nova-agent-bridge');
    });

    it('shell_run is wired (non-501; refuses unknown commands as command-not-allowed)', async () => {
        const r = mockRouter();
        await plugin.init(r);
        const route = r.routes.find(x => x.path === '/shell/run');
        assert.ok(route, '/shell/run must be wired');
        // Drive with a command that is guaranteed not to be on the
        // allow-list (random nonsense). The handler must refuse with
        // closed-enum 'command-not-allowed' rather than the legacy 501.
        const res = mockRes();
        await route.handler({ body: { cmd: 'absolutely-not-a-real-binary-xyz' } }, res);
        assert.notEqual(res._state.statusCode, 501, '/shell/run must no longer return 501');
        assert.equal(res._state.statusCode, 403);
        assert.equal(res._state.body.error, 'command-not-allowed');
    });

    it('shell_run rejects an empty cmd with cmd-required', async () => {
        const r = mockRouter();
        await plugin.init(r);
        const route = r.routes.find(x => x.path === '/shell/run');
        const res = mockRes();
        await route.handler({ body: {} }, res);
        assert.equal(res._state.statusCode, 400);
        assert.equal(res._state.body.error, 'cmd-required');
    });

    it('read-only fs routes are wired (non-501; 400 on missing path)', async () => {
        const r = mockRouter();
        await plugin.init(r);
        // Driving with an empty query exercises the path-safety gate: the
        // handler should respond with a 400 `invalid-path`/`empty` error,
        // NOT the 501 not-implemented body.
        const livePaths = ['/fs/list', '/fs/read', '/fs/stat'];
        for (const p of livePaths) {
            const route = r.routes.find(x => x.method === 'GET' && x.path === p);
            assert.ok(route, `missing route: GET ${p}`);
            const res = mockRes();
            await route.handler({ query: {} }, res);
            assert.notEqual(res._state.statusCode, 501, `${p} should NOT return 501 anymore`);
            assert.equal(res._state.statusCode, 400, `${p} should 400 on missing path`);
            assert.equal(res._state.body.error, 'invalid-path');
            assert.equal(res._state.body.reason, 'empty');
        }
        // /fs/search is POST with a JSON body; missing query → 400.
        const searchRoute = r.routes.find(x => x.method === 'POST' && x.path === '/fs/search');
        assert.ok(searchRoute);
        const res = mockRes();
        await searchRoute.handler({ body: {} }, res);
        assert.notEqual(res._state.statusCode, 501);
        assert.equal(res._state.statusCode, 400);
        assert.equal(res._state.body.error, 'query-required');
    });

    it('write fs routes are wired (non-501; reject empty inputs with a 400)', async () => {
        const r = mockRouter();
        await plugin.init(r);
        // /fs/write requires a `content` string → 400 content-required.
        const writeRoute = r.routes.find(x => x.method === 'POST' && x.path === '/fs/write');
        assert.ok(writeRoute);
        const r1 = mockRes();
        await writeRoute.handler({ body: {} }, r1);
        assert.notEqual(r1._state.statusCode, 501);
        assert.equal(r1._state.statusCode, 400);
        assert.equal(r1._state.body.error, 'content-required');

        // /fs/delete on empty path → 400 invalid-path.
        const deleteRoute = r.routes.find(x => x.method === 'POST' && x.path === '/fs/delete');
        assert.ok(deleteRoute);
        const r2 = mockRes();
        await deleteRoute.handler({ body: {} }, r2);
        assert.notEqual(r2._state.statusCode, 501);
        assert.equal(r2._state.statusCode, 400);
        assert.equal(r2._state.body.error, 'invalid-path');

        // /fs/move on empty from → 400 invalid-path.
        const moveRoute = r.routes.find(x => x.method === 'POST' && x.path === '/fs/move');
        assert.ok(moveRoute);
        const r3 = mockRes();
        await moveRoute.handler({ body: {} }, r3);
        assert.notEqual(r3._state.statusCode, 501);
        assert.equal(r3._state.statusCode, 400);
        assert.equal(r3._state.body.error, 'invalid-path');
    });

    it('/manifest capabilities report all fs routes true; shell_run disabled by default', async () => {
        const r = mockRouter();
        await plugin.init(r);
        const manifestRoute = r.routes.find(x => x.method === 'GET' && x.path === '/manifest');
        const res = mockRes();
        manifestRoute.handler({}, res);
        const caps = res._state.body.capabilities;
        assert.equal(caps.fs_list, true);
        assert.equal(caps.fs_read, true);
        assert.equal(caps.fs_stat, true);
        assert.equal(caps.fs_search, true);
        assert.equal(caps.fs_write, true, 'fs_write capability should be true');
        assert.equal(caps.fs_delete, true, 'fs_delete capability should be true');
        assert.equal(caps.fs_move, true, 'fs_move capability should be true');
        assert.equal(typeof caps.shell_run, 'boolean');
        assert.equal(caps.shell_run, false);
        assert.deepEqual(res._state.body.shellAllowList, []);
        // /manifest now surfaces the resolved audit log path.
        assert.equal(typeof res._state.body.auditLogPath, 'string');
        assert.ok(path.isAbsolute(res._state.body.auditLogPath));
    });
});

describe('nova-agent-bridge _internal.resolveRoot', () => {
    const { resolveRoot } = plugin._internal;

    it('falls back to cwd when the config file is missing', () => {
        const r = resolveRoot('/definitely/not/a/real/path.yaml');
        assert.equal(r, path.resolve(process.cwd()));
    });

    it('falls back to cwd when no arg is supplied', () => {
        assert.equal(resolveRoot(), path.resolve(process.cwd()));
    });

    it('reads a "root:" line from a config file (via a tempfile)', async () => {
        const fs = await import('node:fs/promises');
        const os = await import('node:os');
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-cfg-'));
        const cfg = path.join(dir, 'config.yaml');
        try {
            await fs.writeFile(cfg, 'root: /var/lib/custom-root\nother: ignored\n', 'utf8');
            assert.equal(resolveRoot(cfg), path.resolve('/var/lib/custom-root'));
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    });

    it('strips quotes around a root value', async () => {
        const fs = await import('node:fs/promises');
        const os = await import('node:os');
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-cfg-'));
        const cfg = path.join(dir, 'config.yaml');
        try {
            await fs.writeFile(cfg, 'root: "/quoted/root"\n', 'utf8');
            assert.equal(resolveRoot(cfg), path.resolve('/quoted/root'));
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    });
});

describe('nova-agent-bridge _internal.resolveShellPolicy', () => {
    const { resolveShellPolicy, resolveAllowList } = plugin._internal;

    it('defaults shell to disabled with an empty allow-list', () => {
        assert.deepEqual(resolveShellPolicy('/definitely/not/a/real/path.yaml'), {
            enabled: false,
            allow: [],
        });
    });

    it('reads shell.enabled and shell.allow from config.yaml', async () => {
        const fs = await import('node:fs/promises');
        const os = await import('node:os');
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-shell-cfg-'));
        const cfg = path.join(dir, 'config.yaml');
        try {
            await fs.writeFile(cfg, [
                'shell:',
                '  enabled: true',
                '  allow:',
                '    - node',
                '    - /bin/sh',
                '    - git',
                '    - node',
                '',
            ].join('\n'), 'utf8');
            assert.deepEqual(resolveShellPolicy(cfg), {
                enabled: true,
                allow: ['node', 'git'],
            });
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    });

    it('enables only configured commands that resolve on PATH', () => {
        const resolved = resolveAllowList(['node']);
        assert.deepEqual(Object.keys(resolved), ['node']);
        assert.equal(resolveAllowList(['absolutely-not-a-real-binary-xyz']).constructor, Object);
        assert.deepEqual(resolveAllowList(['absolutely-not-a-real-binary-xyz']), {});
    });
});
