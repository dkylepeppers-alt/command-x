/**
 * Unit tests for Nova filesystem tool handlers (plan §4a).
 * Run with: node --test test/nova-fs-tools.test.mjs
 *
 * Inline-copies `_novaBridgeRequest` + `buildNovaFsHandlers` from
 * `index.js` under the `/* === NOVA AGENT === *\/` section
 * (`buildNovaFsHandlers` lives right after `buildNovaPhoneHandlers`).
 * Per AGENT_MEMORY inline-copy convention: when the production helpers
 * change, update this copy.
 *
 * The handlers wrap the `nova-agent-bridge` plugin's `/fs/*` routes.
 * The plugin enforces all safety constraints (path containment,
 * deny-list, .nova-trash backups, root-refusal, content size cap,
 * audit log). These tests assert the **transport contract** only:
 *
 *   - Every handler validates its required args before reaching out.
 *   - GET routes encode their args into `?path=…&recursive=…`.
 *   - POST routes encode their args into a JSON body.
 *   - 2xx forwards the parsed JSON; non-2xx surfaces the server error
 *     code with `status` attached.
 *   - Network failures resolve to `nova-bridge-unreachable`; missing
 *     fetch resolves to `no-fetch`.
 *   - Handlers NEVER throw — even on absurd args.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const NOVA_DEFAULT_PLUGIN_URL = '/api/plugins/nova-agent-bridge';
const NOVA_DEFAULTS = { pluginBaseUrl: NOVA_DEFAULT_PLUGIN_URL };

// -------- Inline copy of production helpers --------
//
// INTENTIONALLY TRIMMED. The production `_novaBridgeRequest`
// (index.js, NOVA AGENT section) also accepts a `headersProvider`
// param and merges ST's `X-CSRF-Token` / session headers into
// `init.headers` for plan §8c. This test deliberately omits that
// branch — it exercises the fs *handler* contract (route shape,
// error normalisation, never-throws), not the auth-header
// composition, which is covered by `test/nova-shell-handler.test.mjs`
// ("headersProvider …" suite) and `test/nova-ui-wiring.test.mjs`
// (production-signature regression check).
// If you need to test header propagation, do it there, not here.

async function _novaBridgeRequest({ pluginBaseUrl, method, route, query, body, fetchImpl }) {
    const doFetch = typeof fetchImpl === 'function'
        ? fetchImpl
        : (typeof fetch === 'function' ? fetch : null);
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
    const init = { method: method || 'GET' };
    if (body !== undefined) {
        init.headers = { 'Content-Type': 'application/json' };
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
    try { rawText = await resp.text(); } catch (_) { /* noop */ }
    if (rawText) {
        try { parsed = JSON.parse(rawText); } catch (_) { /* leave parsed null */ }
    }
    if (!resp || !resp.ok) {
        if (parsed && typeof parsed === 'object' && typeof parsed.error === 'string') {
            return { ...parsed, status: resp.status };
        }
        return {
            error: 'nova-bridge-error',
            status: resp?.status || 0,
            body: String(rawText).slice(0, 400),
        };
    }
    if (parsed && typeof parsed === 'object') {
        return parsed;
    }
    return { ok: true, body: String(rawText).slice(0, 400) };
}

function buildNovaFsHandlers({ pluginBaseUrl, fetchImpl } = {}) {
    const base = pluginBaseUrl || NOVA_DEFAULTS.pluginBaseUrl;

    const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
    const safeArgs = (v) => (isObject(v) ? v : {});
    const safePath = (v) => (typeof v === 'string' ? v : '');
    const req = (method, route, opts) => _novaBridgeRequest({
        pluginBaseUrl: base, method, route, fetchImpl, ...opts,
    });

    return {
        fs_list: async (rawArgs) => {
            const { path, recursive, maxDepth } = safeArgs(rawArgs);
            const p = safePath(path);
            if (!p) return { error: 'path must be a non-empty string' };
            const query = { path: p };
            if (recursive !== undefined) query.recursive = Boolean(recursive);
            if (maxDepth !== undefined) query.maxDepth = maxDepth;
            return req('GET', '/fs/list', { query });
        },
        fs_read: async (rawArgs) => {
            const { path, encoding, maxBytes } = safeArgs(rawArgs);
            const p = safePath(path);
            if (!p) return { error: 'path must be a non-empty string' };
            const query = { path: p };
            if (encoding !== undefined) query.encoding = encoding;
            if (maxBytes !== undefined) query.maxBytes = maxBytes;
            return req('GET', '/fs/read', { query });
        },
        fs_stat: async (rawArgs) => {
            const { path } = safeArgs(rawArgs);
            const p = safePath(path);
            if (!p) return { error: 'path must be a non-empty string' };
            return req('GET', '/fs/stat', { query: { path: p } });
        },
        fs_search: async (rawArgs) => {
            const { query: searchQuery, glob, path, maxResults } = safeArgs(rawArgs);
            if (typeof searchQuery !== 'string' || searchQuery.length === 0) {
                return { error: 'query must be a non-empty string' };
            }
            const body = { query: searchQuery };
            if (typeof glob === 'string') body.glob = glob;
            if (typeof path === 'string' && path.length > 0) body.path = path;
            if (maxResults !== undefined) body.maxResults = maxResults;
            return req('POST', '/fs/search', { body });
        },
        fs_write: async (rawArgs) => {
            const { path, content, encoding, createParents, overwrite } = safeArgs(rawArgs);
            const p = safePath(path);
            if (!p) return { error: 'path must be a non-empty string' };
            if (typeof content !== 'string') return { error: 'content must be a string' };
            const body = { path: p, content };
            if (encoding !== undefined) body.encoding = encoding;
            if (createParents !== undefined) body.createParents = Boolean(createParents);
            if (overwrite !== undefined) body.overwrite = Boolean(overwrite);
            return req('POST', '/fs/write', { body });
        },
        fs_delete: async (rawArgs) => {
            const { path, recursive } = safeArgs(rawArgs);
            const p = safePath(path);
            if (!p) return { error: 'path must be a non-empty string' };
            const body = { path: p };
            if (recursive !== undefined) body.recursive = Boolean(recursive);
            return req('POST', '/fs/delete', { body });
        },
        fs_move: async (rawArgs) => {
            const { from, to, overwrite } = safeArgs(rawArgs);
            const f = safePath(from);
            const t = safePath(to);
            if (!f) return { error: 'from must be a non-empty string' };
            if (!t) return { error: 'to must be a non-empty string' };
            const body = { from: f, to: t };
            if (overwrite !== undefined) body.overwrite = Boolean(overwrite);
            return req('POST', '/fs/move', { body });
        },
    };
}

// -------- Test helpers --------

/**
 * Build a fake fetch that records every call and replies with a
 * canned response. The response can be a function (to vary by call)
 * or a static `{ status?, ok?, json?, text? }` shape.
 */
function makeFakeFetch(response) {
    const calls = [];
    const fakeFetch = async (url, init) => {
        calls.push({ url, init });
        const r = typeof response === 'function' ? response({ url, init, n: calls.length }) : response;
        const status = r.status ?? 200;
        const ok = r.ok ?? (status >= 200 && status < 300);
        const text = r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : '');
        return {
            status,
            ok,
            text: async () => text,
        };
    };
    return { fakeFetch, calls };
}

const okJson = (json) => ({ status: 200, ok: true, json });
const errJson = (status, json) => ({ status, ok: false, json });

// -------- Tests --------

describe('buildNovaFsHandlers — handler set + base URL handling', () => {
    it('returns all 7 fs_* handlers', () => {
        const handlers = buildNovaFsHandlers({});
        const names = Object.keys(handlers).sort();
        assert.deepEqual(names, [
            'fs_delete', 'fs_list', 'fs_move', 'fs_read', 'fs_search', 'fs_stat', 'fs_write',
        ]);
        for (const name of names) {
            assert.equal(typeof handlers[name], 'function', `${name} is not a function`);
        }
    });

    it('strips trailing slashes from pluginBaseUrl', async () => {
        const { fakeFetch, calls } = makeFakeFetch(okJson({ ok: true }));
        const h = buildNovaFsHandlers({ pluginBaseUrl: '/api/plugins/nova-agent-bridge///', fetchImpl: fakeFetch });
        await h.fs_stat({ path: 'foo.txt' });
        assert.equal(calls.length, 1);
        assert.match(calls[0].url, /^\/api\/plugins\/nova-agent-bridge\/fs\/stat\?path=foo\.txt$/);
    });

    it('falls back to NOVA_DEFAULTS.pluginBaseUrl when none provided', async () => {
        const { fakeFetch, calls } = makeFakeFetch(okJson({ ok: true }));
        const h = buildNovaFsHandlers({ fetchImpl: fakeFetch });
        await h.fs_stat({ path: 'a' });
        assert.equal(calls.length, 1);
        assert.ok(calls[0].url.startsWith(NOVA_DEFAULT_PLUGIN_URL),
            `expected default base URL prefix, got ${calls[0].url}`);
    });
});

describe('fs_list', () => {
    it('rejects empty / non-string path before calling fetch', async () => {
        const { fakeFetch, calls } = makeFakeFetch(okJson({ entries: [] }));
        const h = buildNovaFsHandlers({ fetchImpl: fakeFetch });
        assert.deepEqual(await h.fs_list({}), { error: 'path must be a non-empty string' });
        assert.deepEqual(await h.fs_list({ path: '' }), { error: 'path must be a non-empty string' });
        assert.deepEqual(await h.fs_list({ path: 123 }), { error: 'path must be a non-empty string' });
        assert.equal(calls.length, 0, 'no fetch should be made on bad args');
    });

    it('GETs /fs/list with path-only query when no extras given', async () => {
        const { fakeFetch, calls } = makeFakeFetch(okJson({
            path: 'src', recursive: false, entries: [{ name: 'a.js', type: 'file' }],
        }));
        const h = buildNovaFsHandlers({ fetchImpl: fakeFetch });
        const r = await h.fs_list({ path: 'src' });
        assert.equal(calls[0].init.method, 'GET');
        assert.equal(calls[0].url, '/api/plugins/nova-agent-bridge/fs/list?path=src');
        assert.equal(r.path, 'src');
        assert.equal(r.entries.length, 1);
    });

    it('forwards recursive + maxDepth as query params', async () => {
        const { fakeFetch, calls } = makeFakeFetch(okJson({ entries: [] }));
        const h = buildNovaFsHandlers({ fetchImpl: fakeFetch });
        await h.fs_list({ path: 'a/b', recursive: true, maxDepth: 5 });
        const u = new URL(calls[0].url, 'http://x');
        assert.equal(u.searchParams.get('path'), 'a/b');
        assert.equal(u.searchParams.get('recursive'), 'true');
        assert.equal(u.searchParams.get('maxDepth'), '5');
    });

    it('coerces truthy non-bool recursive to "true"/"false"', async () => {
        const { fakeFetch, calls } = makeFakeFetch(okJson({ entries: [] }));
        const h = buildNovaFsHandlers({ fetchImpl: fakeFetch });
        await h.fs_list({ path: 'a', recursive: 1 });
        const u = new URL(calls[0].url, 'http://x');
        assert.equal(u.searchParams.get('recursive'), 'true');
    });

    it('URL-encodes paths that contain reserved chars', async () => {
        const { fakeFetch, calls } = makeFakeFetch(okJson({ entries: [] }));
        const h = buildNovaFsHandlers({ fetchImpl: fakeFetch });
        await h.fs_list({ path: 'with space/and&amp' });
        // URLSearchParams uses '+' for space encoding; verify path round-trips.
        const u = new URL(calls[0].url, 'http://x');
        assert.equal(u.searchParams.get('path'), 'with space/and&amp');
    });
});

describe('fs_read', () => {
    it('rejects empty path', async () => {
        const h = buildNovaFsHandlers({ fetchImpl: async () => { throw new Error('no fetch expected'); } });
        assert.deepEqual(await h.fs_read({}), { error: 'path must be a non-empty string' });
    });

    it('GETs /fs/read with encoding + maxBytes when given', async () => {
        const { fakeFetch, calls } = makeFakeFetch(okJson({
            path: 'a.txt', encoding: 'utf8', bytes: 5, content: 'hello',
        }));
        const h = buildNovaFsHandlers({ fetchImpl: fakeFetch });
        const r = await h.fs_read({ path: 'a.txt', encoding: 'utf8', maxBytes: 1024 });
        assert.equal(calls[0].init.method, 'GET');
        const u = new URL(calls[0].url, 'http://x');
        assert.equal(u.searchParams.get('path'), 'a.txt');
        assert.equal(u.searchParams.get('encoding'), 'utf8');
        assert.equal(u.searchParams.get('maxBytes'), '1024');
        assert.equal(r.content, 'hello');
    });

    it('forwards 404 not-found from server with status attached', async () => {
        const { fakeFetch } = makeFakeFetch(errJson(404, { error: 'not-found' }));
        const h = buildNovaFsHandlers({ fetchImpl: fakeFetch });
        const r = await h.fs_read({ path: 'missing.txt' });
        assert.equal(r.error, 'not-found');
        assert.equal(r.status, 404);
    });
});

describe('fs_stat', () => {
    it('GETs /fs/stat?path=…', async () => {
        const { fakeFetch, calls } = makeFakeFetch(okJson({ type: 'file', size: 42 }));
        const h = buildNovaFsHandlers({ fetchImpl: fakeFetch });
        const r = await h.fs_stat({ path: 'a' });
        assert.equal(calls[0].init.method, 'GET');
        assert.match(calls[0].url, /\/fs\/stat\?path=a$/);
        assert.equal(r.size, 42);
    });

    it('rejects empty path', async () => {
        const h = buildNovaFsHandlers({ fetchImpl: async () => { throw new Error('no fetch'); } });
        assert.deepEqual(await h.fs_stat({}), { error: 'path must be a non-empty string' });
    });
});

describe('fs_search', () => {
    it('rejects empty query', async () => {
        const h = buildNovaFsHandlers({ fetchImpl: async () => { throw new Error('no fetch'); } });
        assert.deepEqual(await h.fs_search({}), { error: 'query must be a non-empty string' });
        assert.deepEqual(await h.fs_search({ query: '' }), { error: 'query must be a non-empty string' });
        assert.deepEqual(await h.fs_search({ query: 42 }), { error: 'query must be a non-empty string' });
    });

    it('POSTs /fs/search with JSON body containing only query when extras absent', async () => {
        const { fakeFetch, calls } = makeFakeFetch(okJson({ results: [] }));
        const h = buildNovaFsHandlers({ fetchImpl: fakeFetch });
        await h.fs_search({ query: 'TODO' });
        assert.equal(calls[0].init.method, 'POST');
        assert.match(calls[0].url, /\/fs\/search$/);
        assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
        const body = JSON.parse(calls[0].init.body);
        assert.deepEqual(body, { query: 'TODO' });
    });

    it('forwards glob, path, maxResults when provided', async () => {
        const { fakeFetch, calls } = makeFakeFetch(okJson({ results: [] }));
        const h = buildNovaFsHandlers({ fetchImpl: fakeFetch });
        await h.fs_search({ query: 'x', glob: '**/*.js', path: 'src', maxResults: 10 });
        const body = JSON.parse(calls[0].init.body);
        assert.deepEqual(body, { query: 'x', glob: '**/*.js', path: 'src', maxResults: 10 });
    });

    it('drops empty-string path so server uses its default', async () => {
        const { fakeFetch, calls } = makeFakeFetch(okJson({ results: [] }));
        const h = buildNovaFsHandlers({ fetchImpl: fakeFetch });
        await h.fs_search({ query: 'x', path: '' });
        const body = JSON.parse(calls[0].init.body);
        assert.deepEqual(body, { query: 'x' });
    });

    it('forwards 400 query-required even though we already validated', async () => {
        // Defensive: server might reject for reasons beyond our local check.
        const { fakeFetch } = makeFakeFetch(errJson(400, { error: 'query-required' }));
        const h = buildNovaFsHandlers({ fetchImpl: fakeFetch });
        const r = await h.fs_search({ query: 'x' });
        assert.equal(r.error, 'query-required');
        assert.equal(r.status, 400);
    });
});

describe('fs_write', () => {
    it('rejects missing/invalid path or content', async () => {
        const h = buildNovaFsHandlers({ fetchImpl: async () => { throw new Error('no fetch'); } });
        assert.deepEqual(await h.fs_write({ content: 'x' }), { error: 'path must be a non-empty string' });
        assert.deepEqual(await h.fs_write({ path: 'a' }), { error: 'content must be a string' });
        assert.deepEqual(await h.fs_write({ path: 'a', content: 42 }), { error: 'content must be a string' });
    });

    it('accepts empty-string content (legitimate empty file)', async () => {
        const { fakeFetch, calls } = makeFakeFetch(okJson({ ok: true, path: 'a' }));
        const h = buildNovaFsHandlers({ fetchImpl: fakeFetch });
        const r = await h.fs_write({ path: 'a', content: '' });
        assert.equal(r.ok, true);
        const body = JSON.parse(calls[0].init.body);
        assert.equal(body.content, '');
    });

    it('POSTs /fs/write with full body when all opts given', async () => {
        const { fakeFetch, calls } = makeFakeFetch(okJson({ ok: true, path: 'a.txt', bytes: 5 }));
        const h = buildNovaFsHandlers({ fetchImpl: fakeFetch });
        await h.fs_write({ path: 'a.txt', content: 'hello', encoding: 'utf8', createParents: true, overwrite: true });
        const body = JSON.parse(calls[0].init.body);
        assert.deepEqual(body, {
            path: 'a.txt', content: 'hello',
            encoding: 'utf8', createParents: true, overwrite: true,
        });
    });

    it('forwards 413 content-too-large from server', async () => {
        const { fakeFetch } = makeFakeFetch(errJson(413, { error: 'content-too-large', cap: 20971520 }));
        const h = buildNovaFsHandlers({ fetchImpl: fakeFetch });
        const r = await h.fs_write({ path: 'a', content: 'x' });
        assert.equal(r.error, 'content-too-large');
        assert.equal(r.cap, 20971520);
        assert.equal(r.status, 413);
    });

    it('forwards 409 exists when overwrite=false and target exists', async () => {
        const { fakeFetch } = makeFakeFetch(errJson(409, { error: 'exists', detail: 'file exists and overwrite=false' }));
        const h = buildNovaFsHandlers({ fetchImpl: fakeFetch });
        const r = await h.fs_write({ path: 'a', content: 'x', overwrite: false });
        assert.equal(r.error, 'exists');
        assert.equal(r.status, 409);
    });

    it('coerces non-bool createParents/overwrite to true/false', async () => {
        const { fakeFetch, calls } = makeFakeFetch(okJson({ ok: true }));
        const h = buildNovaFsHandlers({ fetchImpl: fakeFetch });
        await h.fs_write({ path: 'a', content: 'x', createParents: 1, overwrite: 0 });
        const body = JSON.parse(calls[0].init.body);
        assert.equal(body.createParents, true);
        assert.equal(body.overwrite, false);
    });
});

describe('fs_delete', () => {
    it('rejects empty path', async () => {
        const h = buildNovaFsHandlers({ fetchImpl: async () => { throw new Error('no fetch'); } });
        assert.deepEqual(await h.fs_delete({}), { error: 'path must be a non-empty string' });
    });

    it('POSTs /fs/delete with path + recursive', async () => {
        const { fakeFetch, calls } = makeFakeFetch(okJson({ ok: true, path: 'old', backup: '.nova-trash/2026-04-24/old' }));
        const h = buildNovaFsHandlers({ fetchImpl: fakeFetch });
        const r = await h.fs_delete({ path: 'old', recursive: true });
        assert.equal(calls[0].init.method, 'POST');
        const body = JSON.parse(calls[0].init.body);
        assert.deepEqual(body, { path: 'old', recursive: true });
        assert.equal(r.backup, '.nova-trash/2026-04-24/old');
    });

    it('forwards 400 refused-root from server', async () => {
        const { fakeFetch } = makeFakeFetch(errJson(400, { error: 'refused-root' }));
        const h = buildNovaFsHandlers({ fetchImpl: fakeFetch });
        const r = await h.fs_delete({ path: '.' });
        assert.equal(r.error, 'refused-root');
        assert.equal(r.status, 400);
    });
});

describe('fs_move', () => {
    it('rejects missing from or to', async () => {
        const h = buildNovaFsHandlers({ fetchImpl: async () => { throw new Error('no fetch'); } });
        assert.deepEqual(await h.fs_move({ to: 'b' }), { error: 'from must be a non-empty string' });
        assert.deepEqual(await h.fs_move({ from: 'a' }), { error: 'to must be a non-empty string' });
        assert.deepEqual(await h.fs_move({ from: '', to: '' }), { error: 'from must be a non-empty string' });
    });

    it('POSTs /fs/move with full body', async () => {
        const { fakeFetch, calls } = makeFakeFetch(okJson({ ok: true, from: 'a', to: 'b' }));
        const h = buildNovaFsHandlers({ fetchImpl: fakeFetch });
        await h.fs_move({ from: 'a', to: 'b', overwrite: true });
        const body = JSON.parse(calls[0].init.body);
        assert.deepEqual(body, { from: 'a', to: 'b', overwrite: true });
    });

    it('forwards 409 destination-exists', async () => {
        const { fakeFetch } = makeFakeFetch(errJson(409, { error: 'destination-exists' }));
        const h = buildNovaFsHandlers({ fetchImpl: fakeFetch });
        const r = await h.fs_move({ from: 'a', to: 'b' });
        assert.equal(r.error, 'destination-exists');
        assert.equal(r.status, 409);
    });
});

describe('transport layer — error surfaces', () => {
    it('returns no-fetch when there is no fetch impl and no global', async () => {
        // Temporarily hide the global fetch so the "no global" branch runs.
        const origFetch = globalThis.fetch;
        globalThis.fetch = undefined;
        try {
            const h = buildNovaFsHandlers({});
            const r = await h.fs_stat({ path: 'a' });
            assert.deepEqual(r, { error: 'no-fetch' });
        } finally {
            if (origFetch !== undefined) globalThis.fetch = origFetch;
        }
    });

    it('returns nova-bridge-unreachable when fetch throws', async () => {
        const fakeFetch = async () => { throw new Error('ECONNREFUSED'); };
        const h = buildNovaFsHandlers({ fetchImpl: fakeFetch });
        const r = await h.fs_stat({ path: 'a' });
        assert.equal(r.error, 'nova-bridge-unreachable');
        assert.match(r.message, /ECONNREFUSED/);
    });

    it('returns nova-bridge-error when server returns non-2xx + non-JSON body', async () => {
        const fakeFetch = async () => ({
            status: 502, ok: false,
            text: async () => '<html>Bad Gateway</html>',
        });
        const h = buildNovaFsHandlers({ fetchImpl: fakeFetch });
        const r = await h.fs_stat({ path: 'a' });
        assert.equal(r.error, 'nova-bridge-error');
        assert.equal(r.status, 502);
        assert.match(r.body, /Bad Gateway/);
    });

    it('returns nova-bridge-error when server returns JSON without an `error` field', async () => {
        // E.g. a misconfigured proxy returning `{ message: "denied" }`.
        const fakeFetch = async () => ({
            status: 403, ok: false,
            text: async () => JSON.stringify({ message: 'forbidden' }),
        });
        const h = buildNovaFsHandlers({ fetchImpl: fakeFetch });
        const r = await h.fs_stat({ path: 'a' });
        assert.equal(r.error, 'nova-bridge-error');
        assert.equal(r.status, 403);
    });

    it('truncates large error bodies to 400 chars', async () => {
        const huge = 'x'.repeat(2000);
        const fakeFetch = async () => ({ status: 500, ok: false, text: async () => huge });
        const h = buildNovaFsHandlers({ fetchImpl: fakeFetch });
        const r = await h.fs_stat({ path: 'a' });
        assert.equal(r.body.length, 400);
    });

    it('treats 2xx with no parseable body as { ok: true }', async () => {
        const fakeFetch = async () => ({ status: 204, ok: true, text: async () => '' });
        const h = buildNovaFsHandlers({ fetchImpl: fakeFetch });
        const r = await h.fs_stat({ path: 'a' });
        assert.equal(r.ok, true);
    });
});

describe('fuzz — handlers never throw on weird args', () => {
    const handlerNames = [
        'fs_list', 'fs_read', 'fs_stat', 'fs_search',
        'fs_write', 'fs_delete', 'fs_move',
    ];
    const weirdArgs = [
        undefined, null, 0, 1, '', 'a', true, false, NaN, [],
        ['a', 'b'], { /* empty */ }, { path: null }, { path: 0 },
    ];

    for (const name of handlerNames) {
        it(`${name}: never throws + always resolves to a known shape`, async () => {
            // Fetch should never be called for invalid args, but if it is
            // (e.g. fuzz happens to satisfy validators) keep the test
            // self-contained.
            const fakeFetch = async () => ({ status: 200, ok: true, text: async () => '{"ok":true}' });
            const h = buildNovaFsHandlers({ fetchImpl: fakeFetch });
            for (const arg of weirdArgs) {
                let result;
                try { result = await h[name](arg); }
                catch (err) {
                    assert.fail(`${name}(${JSON.stringify(arg)}) threw: ${err}`);
                }
                assert.equal(typeof result, 'object', `${name}(${JSON.stringify(arg)}) did not return an object`);
                assert.notEqual(result, null);
                // Result MUST be either a success-ish shape (has `ok` or
                // forwarded server-success keys) or an error-ish shape.
                const looksOk = result.ok === true || 'entries' in result || 'content' in result || 'results' in result || 'type' in result || 'path' in result || 'from' in result;
                const looksErr = typeof result.error === 'string';
                assert.ok(looksOk || looksErr,
                    `${name}(${JSON.stringify(arg)}) returned unrecognised shape: ${JSON.stringify(result)}`);
            }
        });
    }
});
