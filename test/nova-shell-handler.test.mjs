/**
 * Unit tests for the Nova shell_run handler factory (plan §4b).
 * Run with: node --test test/nova-shell-handler.test.mjs
 *
 * Inline-copies `buildNovaShellHandler` + its companion `_novaBridgeRequest`
 * call shape from `index.js` NOVA AGENT section (right after
 * `buildNovaFsHandlers`). Per AGENT_MEMORY inline-copy convention: when
 * the production helper changes, update this copy.
 *
 * Also copies the constants `SHELL_TIMEOUT_MIN_MS` / `SHELL_TIMEOUT_MAX_MS`
 * and a trimmed version of `_novaBridgeRequest` (just enough HTTP shape
 * to assert method + route + body). The full helper has its own test
 * coverage elsewhere — we deliberately don't duplicate all of its error
 * paths here, only the ones `shell_run` callers need to rely on.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// -------- Inline copy of production helpers (trimmed) --------

const NOVA_DEFAULTS = { pluginBaseUrl: '/api/plugins/nova-agent-bridge' };

const SHELL_TIMEOUT_MIN_MS = 100;
const SHELL_TIMEOUT_MAX_MS = 300000;

async function _novaBridgeRequest({ pluginBaseUrl, method, route, query, body, fetchImpl, headersProvider }) {
    const doFetch = typeof fetchImpl === 'function' ? fetchImpl : null;
    if (!doFetch) return { error: 'no-fetch' };
    const base = String(pluginBaseUrl || NOVA_DEFAULTS.pluginBaseUrl).replace(/\/+$/, '');
    let url = `${base}${route}`;
    if (query && typeof query === 'object') {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(query)) {
            if (v === undefined || v === null) continue;
            qs.append(k, String(v));
        }
        const qsStr = qs.toString();
        if (qsStr) url += `?${qsStr}`;
    }
    const authHeaders = {};
    if (typeof headersProvider === 'function') {
        try {
            const h = headersProvider({ omitContentType: true });
            if (h && typeof h === 'object') Object.assign(authHeaders, h);
        } catch (_) { /* noop */ }
    }
    const init = { method: method || 'GET', headers: { ...authHeaders } };
    if (body !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
    }
    let resp;
    try {
        resp = await doFetch(url, init);
    } catch (err) {
        return { error: 'nova-bridge-unreachable', message: String(err?.message || err) };
    }
    let parsed = null;
    let rawText = '';
    try { rawText = await resp.text(); } catch (_) {}
    if (rawText) {
        try { parsed = JSON.parse(rawText); } catch (_) {}
    }
    if (!resp || !resp.ok) {
        if (parsed && typeof parsed === 'object' && typeof parsed.error === 'string') {
            return { ...parsed, status: resp.status };
        }
        return { error: 'nova-bridge-error', status: resp?.status || 0, body: String(rawText).slice(0, 400) };
    }
    if (parsed && typeof parsed === 'object') return parsed;
    return { ok: true, body: String(rawText).slice(0, 400) };
}

function buildNovaShellHandler({ pluginBaseUrl, fetchImpl, headersProvider } = {}) {
    const base = pluginBaseUrl || NOVA_DEFAULTS.pluginBaseUrl;
    const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
    const safeArgs = (v) => (isObject(v) ? v : {});
    const req = (method, route, opts) => _novaBridgeRequest({
        pluginBaseUrl: base, method, route, fetchImpl, headersProvider, ...opts,
    });

    return {
        shell_run: async (rawArgs) => {
            const { cmd, args, cwd, timeoutMs } = safeArgs(rawArgs);
            if (typeof cmd !== 'string' || cmd.length === 0) {
                return { error: 'cmd must be a non-empty string' };
            }
            const cleanArgs = Array.isArray(args)
                ? args.filter((x) => typeof x === 'string')
                : [];
            const body = { cmd, args: cleanArgs };
            if (typeof cwd === 'string' && cwd.length > 0) body.cwd = cwd;
            if (timeoutMs !== undefined && timeoutMs !== null) {
                const n = (typeof timeoutMs === 'number' || typeof timeoutMs === 'string')
                    ? Number(timeoutMs)
                    : NaN;
                if (Number.isFinite(n)) {
                    const clamped = Math.floor(
                        Math.min(SHELL_TIMEOUT_MAX_MS, Math.max(SHELL_TIMEOUT_MIN_MS, n)),
                    );
                    body.timeoutMs = clamped;
                }
            }
            return req('POST', '/shell/run', { body });
        },
    };
}

// -------- Test utilities --------

function makeFetchStub(responder) {
    const calls = [];
    const fn = async (url, init) => {
        const call = { url, method: init?.method, headers: init?.headers, body: init?.body };
        calls.push(call);
        const r = typeof responder === 'function' ? responder(call) : responder;
        if (r instanceof Error) throw r;
        const status = r?.status ?? 200;
        const text = typeof r?.text === 'string' ? r.text : JSON.stringify(r?.json ?? {});
        return {
            ok: status >= 200 && status < 300,
            status,
            text: async () => text,
        };
    };
    return { fn, calls };
}

const readBody = (call) => JSON.parse(call.body);

// -------- Tests: factory shape --------

describe('buildNovaShellHandler — factory shape', () => {
    it('returns exactly one handler keyed `shell_run`', () => {
        const h = buildNovaShellHandler({});
        assert.deepEqual(Object.keys(h), ['shell_run']);
        assert.equal(typeof h.shell_run, 'function');
    });

    it('handler is a plain async function', () => {
        const h = buildNovaShellHandler({});
        const result = h.shell_run({ cmd: 'x' });
        assert.ok(result && typeof result.then === 'function', 'shell_run must return a Promise');
    });
});

// -------- Tests: args validation --------

describe('buildNovaShellHandler — args validation', () => {
    it('missing cmd → { error }', async () => {
        const h = buildNovaShellHandler({});
        assert.deepEqual(await h.shell_run(), { error: 'cmd must be a non-empty string' });
        assert.deepEqual(await h.shell_run({}), { error: 'cmd must be a non-empty string' });
    });

    it('empty-string cmd → { error }', async () => {
        const h = buildNovaShellHandler({});
        assert.deepEqual(await h.shell_run({ cmd: '' }), { error: 'cmd must be a non-empty string' });
    });

    it('non-string cmd → { error }', async () => {
        const h = buildNovaShellHandler({});
        for (const bad of [123, null, {}, [], true]) {
            assert.deepEqual(await h.shell_run({ cmd: bad }), { error: 'cmd must be a non-empty string' });
        }
    });

    it('non-object rawArgs (null, undefined, primitive, array) → { error }', async () => {
        const h = buildNovaShellHandler({});
        for (const bad of [undefined, null, 'string', 42, true, ['cmd', 'ls']]) {
            assert.deepEqual(await h.shell_run(bad), { error: 'cmd must be a non-empty string' });
        }
    });
});

// -------- Tests: POST body shape --------

describe('buildNovaShellHandler — POST body shape', () => {
    it('minimum valid call forwards { cmd, args: [] }', async () => {
        const { fn, calls } = makeFetchStub({ json: { ok: true, stdout: '' } });
        const h = buildNovaShellHandler({ fetchImpl: fn });
        const r = await h.shell_run({ cmd: 'ls' });
        assert.deepEqual(r, { ok: true, stdout: '' });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].method, 'POST');
        assert.match(calls[0].url, /\/api\/plugins\/nova-agent-bridge\/shell\/run$/);
        assert.deepEqual(readBody(calls[0]), { cmd: 'ls', args: [] });
    });

    it('args array is forwarded verbatim when all strings', async () => {
        const { fn, calls } = makeFetchStub({ json: { ok: true } });
        const h = buildNovaShellHandler({ fetchImpl: fn });
        await h.shell_run({ cmd: 'git', args: ['log', '-n', '3', '--oneline'] });
        assert.deepEqual(readBody(calls[0]).args, ['log', '-n', '3', '--oneline']);
    });

    it('args non-array → coerced to []', async () => {
        const { fn, calls } = makeFetchStub({ json: { ok: true } });
        const h = buildNovaShellHandler({ fetchImpl: fn });
        for (const bad of ['log', null, 42, {}, true]) {
            calls.length = 0;
            await h.shell_run({ cmd: 'git', args: bad });
            assert.deepEqual(readBody(calls[0]).args, [], `args=${JSON.stringify(bad)} must coerce to []`);
        }
    });

    it('args array with non-string entries → non-strings filtered out', async () => {
        const { fn, calls } = makeFetchStub({ json: { ok: true } });
        const h = buildNovaShellHandler({ fetchImpl: fn });
        await h.shell_run({ cmd: 'git', args: ['log', 42, null, '-n', {}, '3'] });
        assert.deepEqual(readBody(calls[0]).args, ['log', '-n', '3']);
    });

    it('cwd: non-empty string forwarded; empty / non-string omitted', async () => {
        const { fn, calls } = makeFetchStub({ json: { ok: true } });
        const h = buildNovaShellHandler({ fetchImpl: fn });

        await h.shell_run({ cmd: 'ls', cwd: '/tmp' });
        assert.equal(readBody(calls[0]).cwd, '/tmp');

        calls.length = 0;
        await h.shell_run({ cmd: 'ls', cwd: '' });
        assert.equal(readBody(calls[0]).cwd, undefined, 'empty cwd must be omitted');

        calls.length = 0;
        await h.shell_run({ cmd: 'ls', cwd: 42 });
        assert.equal(readBody(calls[0]).cwd, undefined, 'non-string cwd must be omitted');

        calls.length = 0;
        await h.shell_run({ cmd: 'ls', cwd: null });
        assert.equal(readBody(calls[0]).cwd, undefined, 'null cwd must be omitted');
    });
});

// -------- Tests: timeoutMs clamping --------

describe('buildNovaShellHandler — timeoutMs clamping', () => {
    it('valid in-range values forwarded verbatim', async () => {
        const { fn, calls } = makeFetchStub({ json: { ok: true } });
        const h = buildNovaShellHandler({ fetchImpl: fn });
        await h.shell_run({ cmd: 'ls', timeoutMs: 60000 });
        assert.equal(readBody(calls[0]).timeoutMs, 60000);
    });

    it('below minimum → clamped up to SHELL_TIMEOUT_MIN_MS', async () => {
        const { fn, calls } = makeFetchStub({ json: { ok: true } });
        const h = buildNovaShellHandler({ fetchImpl: fn });
        await h.shell_run({ cmd: 'ls', timeoutMs: 1 });
        assert.equal(readBody(calls[0]).timeoutMs, SHELL_TIMEOUT_MIN_MS);
        calls.length = 0;
        await h.shell_run({ cmd: 'ls', timeoutMs: -500 });
        assert.equal(readBody(calls[0]).timeoutMs, SHELL_TIMEOUT_MIN_MS);
        calls.length = 0;
        await h.shell_run({ cmd: 'ls', timeoutMs: 0 });
        assert.equal(readBody(calls[0]).timeoutMs, SHELL_TIMEOUT_MIN_MS);
    });

    it('above maximum → clamped down to SHELL_TIMEOUT_MAX_MS', async () => {
        const { fn, calls } = makeFetchStub({ json: { ok: true } });
        const h = buildNovaShellHandler({ fetchImpl: fn });
        await h.shell_run({ cmd: 'ls', timeoutMs: 999999999 });
        assert.equal(readBody(calls[0]).timeoutMs, SHELL_TIMEOUT_MAX_MS);
    });

    it('fractional → floored', async () => {
        const { fn, calls } = makeFetchStub({ json: { ok: true } });
        const h = buildNovaShellHandler({ fetchImpl: fn });
        await h.shell_run({ cmd: 'ls', timeoutMs: 1234.9 });
        assert.equal(readBody(calls[0]).timeoutMs, 1234);
    });

    it('string-number is coerced then clamped/floored', async () => {
        const { fn, calls } = makeFetchStub({ json: { ok: true } });
        const h = buildNovaShellHandler({ fetchImpl: fn });
        await h.shell_run({ cmd: 'ls', timeoutMs: '5000' });
        assert.equal(readBody(calls[0]).timeoutMs, 5000);
    });

    it('non-finite values (NaN, Infinity, "abc", null, undefined) → field omitted, server default used', async () => {
        const { fn, calls } = makeFetchStub({ json: { ok: true } });
        const h = buildNovaShellHandler({ fetchImpl: fn });
        for (const bad of [NaN, Infinity, -Infinity, 'abc', {}, [], undefined, null]) {
            calls.length = 0;
            await h.shell_run({ cmd: 'ls', timeoutMs: bad });
            assert.equal(
                readBody(calls[0]).timeoutMs,
                undefined,
                `timeoutMs=${JSON.stringify(bad)} must be omitted`,
            );
        }
    });
});

// -------- Tests: response passthrough --------

describe('buildNovaShellHandler — response passthrough', () => {
    it('200 OK JSON body forwarded verbatim', async () => {
        const { fn } = makeFetchStub({ json: { ok: true, exitCode: 0, stdout: 'hello\n', stderr: '' } });
        const h = buildNovaShellHandler({ fetchImpl: fn });
        const r = await h.shell_run({ cmd: 'echo', args: ['hello'] });
        assert.deepEqual(r, { ok: true, exitCode: 0, stdout: 'hello\n', stderr: '' });
    });

    it('501 Not Implemented → server error surfaces with status', async () => {
        // This is the current state of the plugin route. When the LLM sees
        // this it gets `{ error: 'not-implemented', plugin, version, route,
        // status: 501 }` — a perfectly good "try something else" signal.
        const { fn } = makeFetchStub({
            status: 501,
            text: JSON.stringify({
                error: 'not-implemented',
                plugin: 'nova-agent-bridge',
                version: '0.13.0',
                route: '/shell/run',
            }),
        });
        const h = buildNovaShellHandler({ fetchImpl: fn });
        const r = await h.shell_run({ cmd: 'ls' });
        assert.equal(r.error, 'not-implemented');
        assert.equal(r.status, 501);
        assert.equal(r.route, '/shell/run');
    });

    it('400 Bad Request with {error} → error + status forwarded', async () => {
        const { fn } = makeFetchStub({
            status: 400,
            text: JSON.stringify({ error: 'not-allow-listed', cmd: 'rm' }),
        });
        const h = buildNovaShellHandler({ fetchImpl: fn });
        const r = await h.shell_run({ cmd: 'rm', args: ['-rf', '/'] });
        assert.equal(r.error, 'not-allow-listed');
        assert.equal(r.status, 400);
        assert.equal(r.cmd, 'rm');
    });

    it('500 with un-parseable body → generic bridge-error', async () => {
        const { fn } = makeFetchStub({ status: 500, text: '<html>boom</html>' });
        const h = buildNovaShellHandler({ fetchImpl: fn });
        const r = await h.shell_run({ cmd: 'ls' });
        assert.equal(r.error, 'nova-bridge-error');
        assert.equal(r.status, 500);
        assert.match(r.body, /boom/);
    });

    it('fetch throws (network down) → nova-bridge-unreachable', async () => {
        const { fn } = makeFetchStub(() => { throw new Error('ECONNREFUSED'); });
        const h = buildNovaShellHandler({ fetchImpl: fn });
        const r = await h.shell_run({ cmd: 'ls' });
        assert.equal(r.error, 'nova-bridge-unreachable');
        assert.match(r.message, /ECONNREFUSED/);
    });

    it('no fetch injected and no global fetch → no-fetch', async () => {
        const h = buildNovaShellHandler({}); // fetchImpl omitted
        const r = await h.shell_run({ cmd: 'ls' });
        // In Node-test context without a global fetch polyfill this would
        // hit the `no-fetch` branch. If the runtime DOES have global fetch
        // the request will just fail with `nova-bridge-unreachable`
        // because no server is listening. Either closed-enum error is
        // acceptable — both are documented and LLM-readable.
        assert.ok(['no-fetch', 'nova-bridge-unreachable'].includes(r.error),
            `unexpected error shape: ${JSON.stringify(r)}`);
    });
});

// -------- Tests: base URL handling --------

describe('buildNovaShellHandler — base URL handling', () => {
    it('defaults to NOVA_DEFAULTS.pluginBaseUrl', async () => {
        const { fn, calls } = makeFetchStub({ json: { ok: true } });
        const h = buildNovaShellHandler({ fetchImpl: fn });
        await h.shell_run({ cmd: 'ls' });
        assert.equal(calls[0].url, `${NOVA_DEFAULTS.pluginBaseUrl}/shell/run`);
    });

    it('explicit pluginBaseUrl is honoured (trailing slash stripped)', async () => {
        const { fn, calls } = makeFetchStub({ json: { ok: true } });
        const h = buildNovaShellHandler({
            fetchImpl: fn,
            pluginBaseUrl: 'http://localhost:8000/api/plugins/nova-agent-bridge/',
        });
        await h.shell_run({ cmd: 'ls' });
        assert.equal(calls[0].url, 'http://localhost:8000/api/plugins/nova-agent-bridge/shell/run');
    });
});

// -------- Tests: CSRF / auth header propagation (plan §8c) --------

describe('buildNovaShellHandler — auth header propagation (plan §8c)', () => {
    it('headersProvider output is merged into request init.headers', async () => {
        const { fn, calls } = makeFetchStub({ json: { ok: true } });
        const h = buildNovaShellHandler({
            fetchImpl: fn,
            headersProvider: () => ({ 'X-CSRF-Token': 'tok-abc' }),
        });
        await h.shell_run({ cmd: 'ls' });
        assert.equal(calls[0].headers['X-CSRF-Token'], 'tok-abc',
            'CSRF token must reach the fetch init.headers');
        assert.equal(calls[0].headers['Content-Type'], 'application/json',
            'Content-Type must still be set for JSON body');
    });

    it('headersProvider is called with { omitContentType: true } (mirrors ST getRequestHeaders contract)', async () => {
        const providerArgs = [];
        const { fn } = makeFetchStub({ json: { ok: true } });
        const h = buildNovaShellHandler({
            fetchImpl: fn,
            headersProvider: (opts) => { providerArgs.push(opts); return { 'X-CSRF-Token': 't' }; },
        });
        await h.shell_run({ cmd: 'ls' });
        assert.deepEqual(providerArgs[0], { omitContentType: true });
    });

    it('headersProvider that throws → request still sent with no auth (fail-open)', async () => {
        const { fn, calls } = makeFetchStub({ json: { ok: true } });
        const h = buildNovaShellHandler({
            fetchImpl: fn,
            headersProvider: () => { throw new Error('no token yet'); },
        });
        const r = await h.shell_run({ cmd: 'ls' });
        assert.equal(r.ok, true, 'provider exception must not block the request');
        assert.equal(calls[0].headers['X-CSRF-Token'], undefined);
    });

    it('headersProvider returning non-object → no auth merged, no crash', async () => {
        const { fn, calls } = makeFetchStub({ json: { ok: true } });
        for (const bad of [null, undefined, 42, 'str', true]) {
            const h = buildNovaShellHandler({
                fetchImpl: fn,
                headersProvider: () => bad,
            });
            calls.length = 0;
            await h.shell_run({ cmd: 'ls' });
            assert.deepEqual(Object.keys(calls[0].headers).sort(), ['Content-Type'],
                `non-object provider output (${JSON.stringify(bad)}) must not add headers`);
        }
    });

    it('no headersProvider → request sent with only Content-Type (test isolation; prod has module-level fallback)', async () => {
        const { fn, calls } = makeFetchStub({ json: { ok: true } });
        const h = buildNovaShellHandler({ fetchImpl: fn });
        await h.shell_run({ cmd: 'ls' });
        assert.equal(calls[0].headers['X-CSRF-Token'], undefined);
    });
});

// -------- Tests: never-throws contract --------

describe('buildNovaShellHandler — never-throws contract', () => {
    it('handler never throws for any input shape', async () => {
        const { fn } = makeFetchStub({ json: { ok: true } });
        const h = buildNovaShellHandler({ fetchImpl: fn });
        // Full garbage-fuzz matrix. Every call must resolve to an object
        // (either `{ ok: true, ... }` or closed-enum `{ error, ... }`),
        // never reject.
        const inputs = [
            undefined, null, '', 'string', 42, true, false, [],
            ['cmd', 'ls'], // array when object expected
            {}, { cmd: null }, { cmd: 123 }, { cmd: [] }, { cmd: {} },
            { cmd: 'ls', args: 'foo' }, { cmd: 'ls', args: null },
            { cmd: 'ls', args: 42 }, { cmd: 'ls', args: {} },
            { cmd: 'ls', cwd: 42 }, { cmd: 'ls', cwd: [] },
            { cmd: 'ls', timeoutMs: 'not-a-number' },
            { cmd: 'ls', timeoutMs: {} }, { cmd: 'ls', timeoutMs: [] },
            { cmd: 'ls', timeoutMs: NaN }, { cmd: 'ls', timeoutMs: Infinity },
        ];
        for (const input of inputs) {
            const r = await h.shell_run(input);
            assert.equal(typeof r, 'object', `non-object result for ${JSON.stringify(input)}`);
            assert.ok(r, `null result for ${JSON.stringify(input)}`);
        }
    });

    it('never throws even when fetch-stub explodes at every layer', async () => {
        const h1 = buildNovaShellHandler({
            fetchImpl: () => { throw 'string throw'; },
        });
        const r1 = await h1.shell_run({ cmd: 'ls' });
        assert.equal(r1.error, 'nova-bridge-unreachable');

        const h2 = buildNovaShellHandler({
            fetchImpl: async () => {
                // resp.text() throws
                return { ok: false, status: 500, text: async () => { throw new Error('text explode'); } };
            },
        });
        const r2 = await h2.shell_run({ cmd: 'ls' });
        assert.equal(r2.error, 'nova-bridge-error');
        assert.equal(r2.status, 500);
    });
});
