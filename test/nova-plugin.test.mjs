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
    const handler = (method) => (routePath, h) => {
        assert.equal(typeof h, 'function', `handler for ${method} ${routePath} must be a function`);
        routes.push({ method, path: routePath, handler: h });
    };
    return {
        routes,
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
        assert.ok(body.shellAllowList.includes('git'));
        assert.equal(typeof body.capabilities, 'object');
        // Every declared capability key must be a boolean (scaffold: all false).
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

    it('fs/shell write + shell stubs still return 501 not-implemented', async () => {
        const r = mockRouter();
        await plugin.init(r);
        // After the read-only fs routes landed, only writes + shell remain stubs.
        const stubPaths = ['/fs/write', '/fs/delete', '/fs/move', '/shell/run'];
        for (const p of stubPaths) {
            const route = r.routes.find(x => x.path === p);
            const res = mockRes();
            route.handler({}, res);
            assert.equal(res._state.statusCode, 501, `${p} should return 501`);
            assert.equal(res._state.body.error, 'not-implemented');
            assert.equal(res._state.body.plugin, 'nova-agent-bridge');
            assert.equal(res._state.body.route, p);
        }
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

    it('/manifest capabilities report fs_list, fs_read, fs_stat, fs_search = true', async () => {
        const r = mockRouter();
        await plugin.init(r);
        const manifestRoute = r.routes.find(x => x.method === 'GET' && x.path === '/manifest');
        const res = mockRes();
        manifestRoute.handler({}, res);
        const caps = res._state.body.capabilities;
        assert.equal(caps.fs_list, true, 'fs_list capability should be true');
        assert.equal(caps.fs_read, true, 'fs_read capability should be true');
        assert.equal(caps.fs_stat, true, 'fs_stat capability should be true');
        assert.equal(caps.fs_search, true, 'fs_search capability should be true');
        assert.equal(caps.fs_write, false, 'fs_write still pending');
        assert.equal(caps.fs_delete, false, 'fs_delete still pending');
        assert.equal(caps.fs_move, false, 'fs_move still pending');
        assert.equal(caps.shell_run, false, 'shell_run still pending');
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
