/**
 * Tests for nova-agent-bridge `/shell/run` route handler (plan §4b / §8b).
 * Run with: node --test test/nova-shell-route.test.mjs
 *
 * Drives `createShellRunHandler` against a real OS tempdir using the real
 * `node` binary on PATH for end-to-end exit-code, stdout, and stderr
 * coverage, plus a fake-spawn variant for the safety-critical paths
 * (timeout, output truncation, audit-log no-leak).
 *
 * Why both: the tempdir+real-spawn tests prove the route works against
 * an actual child process (allow-list resolution, JSON response shape,
 * audit shape after a real exit); the fake-spawn tests prove the
 * timeout/SIGTERM/output-cap logic without depending on host scheduler
 * behaviour or sleeping in CI.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import fsPromises from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const shell = require(path.resolve(__dirname, '../server-plugin/nova-agent-bridge/routes-shell.js'));
const { normalizeNovaPath } = require(path.resolve(__dirname, '../server-plugin/nova-agent-bridge/paths.js'));
const plugin = require(path.resolve(__dirname, '../server-plugin/nova-agent-bridge/index.js'));

const { createShellRunHandler, _internal } = shell;
const { resolveAllowList } = plugin._internal;

function mockRes() {
    const state = { statusCode: 200, body: null };
    const res = {
        status(code) { state.statusCode = code; return res; },
        json(payload) { state.body = payload; return res; },
        get _state() { return state; },
    };
    return res;
}

function mockAudit() {
    const entries = [];
    return {
        entries,
        append: async (e) => { entries.push(e); return { ok: true }; },
        close: async () => {},
    };
}

let ROOT;
let audit;
before(async () => {
    ROOT = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'nova-shell-'));
});
after(async () => { if (ROOT) await fsPromises.rm(ROOT, { recursive: true, force: true }); });
beforeEach(async () => {
    const entries = await fsPromises.readdir(ROOT);
    await Promise.all(entries.map(e =>
        fsPromises.rm(path.join(ROOT, e), { recursive: true, force: true })));
    audit = mockAudit();
});

const baseDeps = (extra = {}) => ({
    root: ROOT,
    normalizePath: normalizeNovaPath,
    auditLogger: audit,
    ...extra,
});

/* ====================================================================== */

describe('createShellRunHandler — factory shape', () => {
    it('returns an async handler function', () => {
        const h = createShellRunHandler(baseDeps({ allowList: {} }));
        assert.equal(typeof h, 'function');
    });

    it('exports the expected internals', () => {
        assert.equal(typeof _internal.coerceArgs, 'function');
        assert.equal(typeof _internal.coerceTimeout, 'function');
        assert.equal(_internal.SHELL_TIMEOUT_MIN_MS, 100);
        assert.equal(_internal.SHELL_TIMEOUT_MAX_MS, 5 * 60 * 1000);
        assert.equal(_internal.SHELL_TIMEOUT_DEFAULT_MS, 60 * 1000);
        assert.equal(_internal.SHELL_OUTPUT_CAP_BYTES, 1024 * 1024);
    });
});

describe('createShellRunHandler — argument validation', () => {
    it('refuses missing cmd with 400 cmd-required + audits refused-bad-arg', async () => {
        const h = createShellRunHandler(baseDeps({ allowList: { node: '/usr/bin/node' } }));
        const res = mockRes();
        await h({ body: {} }, res);
        assert.equal(res._state.statusCode, 400);
        assert.equal(res._state.body.error, 'cmd-required');
        const last = audit.entries.at(-1);
        assert.equal(last.outcome, 'refused-bad-arg');
        assert.equal(last.argsSummary.cmd, '');
    });

    it('refuses non-string cmd with 400 cmd-required', async () => {
        const h = createShellRunHandler(baseDeps({ allowList: { node: '/usr/bin/node' } }));
        for (const bad of [null, 0, true, [], {}]) {
            const res = mockRes();
            await h({ body: { cmd: bad } }, res);
            assert.equal(res._state.statusCode, 400);
            assert.equal(res._state.body.error, 'cmd-required');
        }
    });

    it('refuses cmd not on the allow-list with 403 command-not-allowed', async () => {
        const h = createShellRunHandler(baseDeps({ allowList: { node: '/usr/bin/node' } }));
        const res = mockRes();
        await h({ body: { cmd: 'rm', args: ['-rf', '/'] } }, res);
        assert.equal(res._state.statusCode, 403);
        assert.equal(res._state.body.error, 'command-not-allowed');
        const last = audit.entries.at(-1);
        assert.equal(last.outcome, 'refused-not-allowed');
        assert.equal(last.argsSummary.cmd, 'rm');
        // The audit entry MUST NOT contain the literal arg values.
        const json = JSON.stringify(last);
        assert.equal(json.includes('-rf'), false, 'audit must not include arg values');
    });

    it('refuses cmd not on the allow-list even when allow-list is empty', async () => {
        const h = createShellRunHandler(baseDeps({ allowList: {} }));
        const res = mockRes();
        await h({ body: { cmd: 'node' } }, res);
        assert.equal(res._state.statusCode, 403);
        assert.equal(res._state.body.error, 'command-not-allowed');
    });

    it('handler is robust to missing req.body', async () => {
        const h = createShellRunHandler(baseDeps({ allowList: { node: '/x' } }));
        const res = mockRes();
        await h({}, res);
        assert.equal(res._state.statusCode, 400);
        assert.equal(res._state.body.error, 'cmd-required');
    });
});

describe('coerceArgs / coerceTimeout', () => {
    it('coerceArgs filters non-strings and rejects non-arrays', () => {
        assert.deepEqual(_internal.coerceArgs(['a', 1, 'b', null, 'c']), ['a', 'b', 'c']);
        assert.deepEqual(_internal.coerceArgs('single'), []);
        assert.deepEqual(_internal.coerceArgs(undefined), []);
        assert.deepEqual(_internal.coerceArgs(null), []);
        assert.deepEqual(_internal.coerceArgs({ 0: 'x' }), []);
    });

    it('coerceTimeout clamps to [100, 300000] with default 60000', () => {
        assert.equal(_internal.coerceTimeout(undefined), 60000);
        assert.equal(_internal.coerceTimeout(null), 60000);
        assert.equal(_internal.coerceTimeout(50), 100);    // clamped up
        assert.equal(_internal.coerceTimeout(999999), 300000); // clamped down
        assert.equal(_internal.coerceTimeout(5000), 5000);
        assert.equal(_internal.coerceTimeout('5000'), 5000);
    });

    it('coerceTimeout falls back to default for non-finite / array inputs', () => {
        assert.equal(_internal.coerceTimeout(NaN), 60000);
        // Non-finite (including Infinity) → default, not clamped.
        assert.equal(_internal.coerceTimeout(Infinity), 60000);
        assert.equal(_internal.coerceTimeout(-Infinity), 60000);
        // Number([]) is 0 (finite!) — must NOT sneak through.
        assert.equal(_internal.coerceTimeout([]), 60000);
        assert.equal(_internal.coerceTimeout([42]), 60000);
        assert.equal(_internal.coerceTimeout({}), 60000);
        assert.equal(_internal.coerceTimeout(true), 60000);
    });
});

describe('createShellRunHandler — cwd handling', () => {
    it('refuses non-existent cwd with 400 cwd-not-found', async () => {
        const allowList = { node: '/x' }; // never spawned (cwd refused first)
        const h = createShellRunHandler(baseDeps({ allowList }));
        const res = mockRes();
        await h({ body: { cmd: 'node', cwd: 'definitely/not/here' } }, res);
        assert.equal(res._state.statusCode, 400);
        assert.equal(res._state.body.error, 'cwd-not-found');
        const last = audit.entries.at(-1);
        assert.equal(last.outcome, 'refused-cwd');
    });

    it('refuses cwd that escapes root with 400 invalid-path', async () => {
        const h = createShellRunHandler(baseDeps({ allowList: { node: '/x' } }));
        const res = mockRes();
        await h({ body: { cmd: 'node', cwd: '../escape' } }, res);
        assert.equal(res._state.statusCode, 400);
        assert.equal(res._state.body.error, 'invalid-path');
    });

    it('refuses cwd that points to a file', async () => {
        await fsPromises.writeFile(path.join(ROOT, 'file.txt'), 'hi', 'utf8');
        const h = createShellRunHandler(baseDeps({ allowList: { node: '/x' } }));
        const res = mockRes();
        await h({ body: { cmd: 'node', cwd: 'file.txt' } }, res);
        assert.equal(res._state.statusCode, 400);
        assert.equal(res._state.body.error, 'cwd-not-a-directory');
    });
});

/* ----------------------------------------------------------------------
 * Fake-spawn unit tests for the timeout, output-cap, and exit-flow logic.
 * Each test builds a `FakeChild` EventEmitter that mimics the
 * child_process.ChildProcess surface we depend on (`stdout`, `stderr`
 * Readable streams, `kill(signal)` method, `'exit'` event).
 * ---------------------------------------------------------------------- */

function makeFakeChild() {
    const child = new EventEmitter();
    child.stdout = new Readable({ read() {} });
    child.stderr = new Readable({ read() {} });
    child.killed = false;
    child.lastSignal = null;
    child.kill = (sig) => { child.killed = true; child.lastSignal = sig || 'SIGTERM'; return true; };
    return child;
}

/**
 * Helper: spawn impl factory. Captures the spawn args for inspection
 * and returns the prepared fake child.
 */
function fakeSpawnFactory(child, capture) {
    return (cmd, args, opts) => {
        capture.cmd = cmd; capture.args = args; capture.opts = opts;
        return child;
    };
}

describe('createShellRunHandler — fake-spawn flow', () => {
    it('spawns with shell:false and stdin closed', async () => {
        const child = makeFakeChild();
        const capture = {};
        const h = createShellRunHandler(baseDeps({
            allowList: { node: '/abs/node' },
            spawnImpl: fakeSpawnFactory(child, capture),
        }));
        const res = mockRes();
        const p = h({ body: { cmd: 'node', args: ['-v'] } }, res);
        // Drive the fake child to completion.
        setImmediate(() => {
            child.stdout.push('v20.0.0\n');
            child.stdout.push(null);
            child.stderr.push(null);
            child.emit('exit', 0, null);
        });
        await p;
        assert.equal(capture.cmd, '/abs/node', 'must spawn the absolute path, not the bare name');
        assert.deepEqual(capture.args, ['-v']);
        assert.equal(capture.opts.shell, false, 'shell:false is required');
        assert.deepEqual(capture.opts.stdio, ['ignore', 'pipe', 'pipe'], 'stdin must be closed');
        assert.equal(typeof capture.opts.cwd, 'string');
        assert.equal(capture.opts.cwd, ROOT);
    });

    it('returns a 200 with exitCode/stdout/stderr on success', async () => {
        const child = makeFakeChild();
        const h = createShellRunHandler(baseDeps({
            allowList: { node: '/abs/node' },
            spawnImpl: fakeSpawnFactory(child, {}),
        }));
        const res = mockRes();
        const p = h({ body: { cmd: 'node' } }, res);
        setImmediate(() => {
            child.stdout.push('hello\n');
            child.stdout.push(null);
            child.stderr.push('warn\n');
            child.stderr.push(null);
            child.emit('exit', 0, null);
        });
        await p;
        assert.equal(res._state.statusCode, 200);
        assert.equal(res._state.body.ok, true);
        assert.equal(res._state.body.exitCode, 0);
        assert.equal(res._state.body.signal, null);
        assert.equal(res._state.body.stdout, 'hello\n');
        assert.equal(res._state.body.stderr, 'warn\n');
        assert.equal(res._state.body.timedOut, false);
        assert.equal(typeof res._state.body.durationMs, 'number');
        assert.deepEqual(res._state.body.truncated, { stdout: false, stderr: false });
    });

    it('surfaces non-zero exit codes verbatim', async () => {
        const child = makeFakeChild();
        const h = createShellRunHandler(baseDeps({
            allowList: { node: '/abs/node' },
            spawnImpl: fakeSpawnFactory(child, {}),
        }));
        const res = mockRes();
        const p = h({ body: { cmd: 'node' } }, res);
        setImmediate(() => {
            child.stdout.push(null);
            child.stderr.push('err\n');
            child.stderr.push(null);
            child.emit('exit', 17, null);
        });
        await p;
        assert.equal(res._state.body.exitCode, 17);
    });

    it('truncates stdout past the 1 MB cap and reports truncated:true', async () => {
        const child = makeFakeChild();
        const h = createShellRunHandler(baseDeps({
            allowList: { node: '/abs/node' },
            spawnImpl: fakeSpawnFactory(child, {}),
        }));
        const res = mockRes();
        const p = h({ body: { cmd: 'node' } }, res);
        const cap = _internal.SHELL_OUTPUT_CAP_BYTES;
        setImmediate(() => {
            // Push 1.5 MB of output so we cross the cap with margin.
            child.stdout.push('A'.repeat(cap));
            child.stdout.push('B'.repeat(cap / 2));
            child.stdout.push(null);
            child.stderr.push(null);
            child.emit('exit', 0, null);
        });
        await p;
        assert.equal(res._state.body.stdout.length, cap, 'stdout must be capped at cap bytes');
        assert.equal(res._state.body.truncated.stdout, true);
        assert.equal(res._state.body.truncated.stderr, false);
    });

    it('triggers timeout: kills with SIGTERM and reports timedOut:true', async () => {
        const child = makeFakeChild();
        const h = createShellRunHandler(baseDeps({
            allowList: { node: '/abs/node' },
            spawnImpl: fakeSpawnFactory(child, {}),
        }));
        const res = mockRes();
        // Min timeout is 100ms.
        const p = h({ body: { cmd: 'node', timeoutMs: 100 } }, res);
        // Don't push EOF for ~150ms; let timeout fire and kill the child.
        setTimeout(() => {
            // Once kill is called, the fake child auto-exits with SIGTERM.
            child.stdout.push(null);
            child.stderr.push(null);
            child.emit('exit', null, child.lastSignal || 'SIGTERM');
        }, 150);
        await p;
        assert.equal(res._state.body.timedOut, true);
        assert.equal(child.killed, true, 'child.kill() should have been invoked');
        assert.equal(child.lastSignal, 'SIGTERM');
        const last = audit.entries.at(-1);
        assert.equal(last.outcome, 'timed-out');
    });

    it('surfaces spawn() throwing as 500 spawn-failed + audit spawn-failed', async () => {
        const h = createShellRunHandler(baseDeps({
            allowList: { node: '/abs/node' },
            spawnImpl: () => { throw new Error('ENOENT no such file'); },
        }));
        const res = mockRes();
        await h({ body: { cmd: 'node' } }, res);
        assert.equal(res._state.statusCode, 500);
        assert.equal(res._state.body.error, 'spawn-failed');
        const last = audit.entries.at(-1);
        assert.equal(last.outcome, 'spawn-failed');
    });

    it('surfaces child error event as 500 spawn-failed', async () => {
        const child = makeFakeChild();
        const h = createShellRunHandler(baseDeps({
            allowList: { node: '/abs/node' },
            spawnImpl: fakeSpawnFactory(child, {}),
        }));
        const res = mockRes();
        const p = h({ body: { cmd: 'node' } }, res);
        setImmediate(() => {
            child.stdout.push(null);
            child.stderr.push(null);
            child.emit('error', new Error('spawn ENOENT'));
        });
        await p;
        assert.equal(res._state.statusCode, 500);
        assert.equal(res._state.body.error, 'spawn-failed');
    });
});

describe('createShellRunHandler — audit-log content safety', () => {
    it('audit entries on completed runs contain no raw stdout/stderr bytes', async () => {
        const child = makeFakeChild();
        const h = createShellRunHandler(baseDeps({
            allowList: { node: '/abs/node' },
            spawnImpl: fakeSpawnFactory(child, {}),
        }));
        const res = mockRes();
        const p = h({ body: { cmd: 'node', args: ['secret-arg-marker'] } }, res);
        const SECRET_OUT = 'SECRET-STDOUT-PAYLOAD-DO-NOT-LOG';
        const SECRET_ERR = 'SECRET-STDERR-PAYLOAD-DO-NOT-LOG';
        setImmediate(() => {
            child.stdout.push(SECRET_OUT);
            child.stdout.push(null);
            child.stderr.push(SECRET_ERR);
            child.stderr.push(null);
            child.emit('exit', 0, null);
        });
        await p;
        const entries = audit.entries;
        for (const entry of entries) {
            const json = JSON.stringify(entry);
            assert.equal(json.includes(SECRET_OUT), false,
                'audit entry must NOT contain raw stdout bytes');
            assert.equal(json.includes(SECRET_ERR), false,
                'audit entry must NOT contain raw stderr bytes');
            assert.equal(json.includes('secret-arg-marker'), false,
                'audit entry must NOT contain raw arg values');
        }
        const last = entries.at(-1);
        // What it SHOULD contain:
        assert.equal(last.outcome, 'completed');
        assert.equal(last.argsSummary.cmd, 'node');
        assert.equal(last.argsSummary.argsCount, 1);
        assert.equal(last.exitCode, 0);
        assert.equal(typeof last.stdoutBytes, 'number');
        assert.equal(typeof last.stderrBytes, 'number');
        assert.equal(typeof last.durationMs, 'number');
    });
});

/* ----------------------------------------------------------------------
 * End-to-end test against the real `node` binary, conditional on it
 * being present on PATH (which it is when the test suite is running).
 * ---------------------------------------------------------------------- */

describe('createShellRunHandler — real spawn against node', () => {
    let nodeAllowList;
    before(() => {
        nodeAllowList = resolveAllowList(['node']);
    });

    it('runs `node -e "console.log(2+2)"` and returns exitCode 0 + stdout "4"', async function () {
        if (!nodeAllowList.node) return; // skip on hosts without node on PATH
        const h = createShellRunHandler(baseDeps({ allowList: nodeAllowList }));
        const res = mockRes();
        await h({ body: { cmd: 'node', args: ['-e', 'console.log(2+2)'] } }, res);
        assert.equal(res._state.statusCode, 200);
        assert.equal(res._state.body.exitCode, 0);
        assert.equal(res._state.body.stdout.trim(), '4');
        assert.equal(res._state.body.timedOut, false);
        // Audit shows completed.
        assert.equal(audit.entries.at(-1).outcome, 'completed');
    });

    it('runs `node -e "process.exit(7)"` and returns exitCode 7', async function () {
        if (!nodeAllowList.node) return;
        const h = createShellRunHandler(baseDeps({ allowList: nodeAllowList }));
        const res = mockRes();
        await h({ body: { cmd: 'node', args: ['-e', 'process.exit(7)'] } }, res);
        assert.equal(res._state.body.exitCode, 7);
    });

    it('runs `node` in a sub-cwd and respects it', async function () {
        if (!nodeAllowList.node) return;
        const sub = path.join(ROOT, 'sub');
        await fsPromises.mkdir(sub);
        const h = createShellRunHandler(baseDeps({ allowList: nodeAllowList }));
        const res = mockRes();
        await h({
            body: { cmd: 'node', args: ['-e', 'console.log(process.cwd())'], cwd: 'sub' },
        }, res);
        assert.equal(res._state.body.exitCode, 0);
        // realpath equality — macOS /tmp ↔ /private/tmp etc.
        assert.equal(
            await fsPromises.realpath(res._state.body.stdout.trim()),
            await fsPromises.realpath(sub),
        );
    });
});
