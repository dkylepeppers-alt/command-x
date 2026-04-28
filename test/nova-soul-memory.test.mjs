/**
 * Unit tests for Nova soul.md / memory.md loader (plan §6a).
 * Run with: node --test test/nova-soul-memory.test.mjs
 *
 * Mirrors `loadNovaSoulMemory` + `_fetchNovaMarkdown` +
 * `invalidateNovaSoulMemoryCache` in `index.js` under the
 * `/* === NOVA AGENT === *\/` section. Inline-copy convention per
 * AGENT_MEMORY — update this copy when the production helpers change.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const EXT = 'command-x';
const NOVA_SOUL_MEMORY_TTL_MS = 5 * 60_000;
const NOVA_SOUL_FILENAME = 'soul.md';
const NOVA_MEMORY_FILENAME = 'memory.md';
const NOVA_DEFAULT_PLUGIN_URL = '/api/plugins/nova-agent-bridge';
const NOVA_SOUL_BRIDGE_PATH = `nova/${NOVA_SOUL_FILENAME}`;
const NOVA_MEMORY_BRIDGE_PATH = `nova/${NOVA_MEMORY_FILENAME}`;

function defaultNovaSoulMemoryBaseUrl() {
    return `/scripts/extensions/third-party/${EXT}/nova`;
}

function makeCapsule() {
    let _novaSoulMemoryCache = null;

    function invalidateNovaSoulMemoryCache() {
        _novaSoulMemoryCache = null;
    }

    async function _fetchNovaMarkdown(url, { fetchImpl }) {
        const doFetch = typeof fetchImpl === 'function'
            ? fetchImpl
            : (typeof fetch === 'function' ? fetch : null);
        if (!doFetch) return '';
        let resp;
        try {
            resp = await doFetch(url, { method: 'GET' });
        } catch (_) {
            return '';
        }
        if (!resp || !resp.ok) return '';
        let text;
        try {
            text = await resp.text();
        } catch (_) {
            return '';
        }
        return typeof text === 'string' ? text : '';
    }

    async function _novaBridgeReadText({ pluginBaseUrl, path, fetchImpl, maxBytes = 262144 }) {
        const doFetch = typeof fetchImpl === 'function'
            ? fetchImpl
            : (typeof fetch === 'function' ? fetch : null);
        if (!doFetch) return { error: 'no-fetch' };
        const base = String(pluginBaseUrl || NOVA_DEFAULT_PLUGIN_URL).replace(/\/+$/, '');
        const qs = new URLSearchParams({
            path: String(path || ''),
            encoding: 'utf8',
            maxBytes: String(maxBytes),
        });
        let resp;
        try {
            resp = await doFetch(`${base}/fs/read?${qs.toString()}`, { method: 'GET', headers: {} });
        } catch (err) {
            return { error: 'nova-bridge-unreachable', message: String(err?.message || err) };
        }
        let raw = '';
        try { raw = await resp.text(); } catch (_) { /* noop */ }
        let parsed = null;
        if (raw) {
            try { parsed = JSON.parse(raw); } catch (_) { /* noop */ }
        }
        if (!resp || !resp.ok) {
            if (parsed && typeof parsed === 'object' && typeof parsed.error === 'string') {
                return { ...parsed, status: resp?.status || 0 };
            }
            return { error: 'nova-bridge-error', status: resp?.status || 0, body: String(raw).slice(0, 400) };
        }
        if (parsed && typeof parsed === 'object' && typeof parsed.content === 'string') {
            return {
                ok: true,
                content: parsed.content,
                path: typeof parsed.path === 'string' ? parsed.path : path,
                bytes: Number(parsed.bytes) || parsed.content.length,
                truncated: Boolean(parsed.truncated),
            };
        }
        return { error: 'invalid-response' };
    }

    async function loadNovaSoulMemory({
        baseUrl,
        pluginBaseUrl,
        soulPath = NOVA_SOUL_BRIDGE_PATH,
        memoryPath = NOVA_MEMORY_BRIDGE_PATH,
        fetchImpl,
        nowImpl,
        ttlMs = NOVA_SOUL_MEMORY_TTL_MS,
        force = false,
    } = {}) {
        const now = typeof nowImpl === 'function' ? nowImpl : Date.now;
        if (!force && _novaSoulMemoryCache && _novaSoulMemoryCache.expiresAt > now()) {
            return _novaSoulMemoryCache.result;
        }
        const root = String(baseUrl || defaultNovaSoulMemoryBaseUrl()).replace(/\/+$/, '');
        const soulUrl = `${root}/${NOVA_SOUL_FILENAME}`;
        const memoryUrl = `${root}/${NOVA_MEMORY_FILENAME}`;
        let soul;
        let memory;
        if (baseUrl) {
            [soul, memory] = await Promise.all([
                _fetchNovaMarkdown(soulUrl, { fetchImpl }),
                _fetchNovaMarkdown(memoryUrl, { fetchImpl }),
            ]);
        } else {
            const [bridgeSoul, bridgeMemory] = await Promise.all([
                _novaBridgeReadText({ pluginBaseUrl, path: soulPath, fetchImpl }),
                _novaBridgeReadText({ pluginBaseUrl, path: memoryPath, fetchImpl }),
            ]);
            const fallbackReads = [];
            const fallbackSlots = [];
            if (bridgeSoul?.ok) {
                soul = bridgeSoul.content;
            } else {
                fallbackSlots.push('soul');
                fallbackReads.push(_fetchNovaMarkdown(soulUrl, { fetchImpl }));
            }
            if (bridgeMemory?.ok) {
                memory = bridgeMemory.content;
            } else {
                fallbackSlots.push('memory');
                fallbackReads.push(_fetchNovaMarkdown(memoryUrl, { fetchImpl }));
            }
            if (fallbackReads.length) {
                const fallback = await Promise.all(fallbackReads);
                fallback.forEach((value, idx) => {
                    if (fallbackSlots[idx] === 'soul') soul = value;
                    if (fallbackSlots[idx] === 'memory') memory = value;
                });
            }
        }
        const result = { soul, memory };
        _novaSoulMemoryCache = { result, expiresAt: now() + ttlMs };
        return result;
    }

    return {
        loadNovaSoulMemory,
        invalidateNovaSoulMemoryCache,
        peekCache: () => _novaSoulMemoryCache,
    };
}

// -------- fetch mocks --------

function makeFetchMock(responses = {}) {
    const calls = [];
    const fn = async (url) => {
        calls.push(url);
        const entry = responses[url];
        if (!entry) return { ok: false, status: 404, text: async () => '' };
        if (entry.throws) throw entry.throws;
        return {
            ok: entry.ok !== false,
            status: entry.status ?? 200,
            text: async () => {
                if (entry.textThrows) throw entry.textThrows;
                return entry.body;
            },
        };
    };
    return { fn, calls };
}

// -------- Tests --------

describe('loadNovaSoulMemory — happy path', () => {
    it('returns { soul, memory } on 200/200', async () => {
        const cap = makeCapsule();
        const mock = makeFetchMock({
            '/x/soul.md': { body: 'SOUL' },
            '/x/memory.md': { body: 'MEM' },
        });
        const out = await cap.loadNovaSoulMemory({ baseUrl: '/x', fetchImpl: mock.fn });
        assert.deepEqual(out, { soul: 'SOUL', memory: 'MEM' });
    });

    it('fetches both files in parallel (both requests fire before any resolves)', async () => {
        const cap = makeCapsule();
        const order = [];
        let releaseSoul;
        let releaseMemory;
        const soulPromise = new Promise(r => { releaseSoul = r; });
        const memoryPromise = new Promise(r => { releaseMemory = r; });
        const fn = async (url) => {
            order.push(`start:${url}`);
            if (url.endsWith('soul.md')) { await soulPromise; order.push(`done:${url}`); return { ok: true, text: async () => 'S' }; }
            if (url.endsWith('memory.md')) { await memoryPromise; order.push(`done:${url}`); return { ok: true, text: async () => 'M' }; }
            return { ok: false };
        };
        const p = cap.loadNovaSoulMemory({ baseUrl: '/x', fetchImpl: fn });
        // Allow microtasks to register both fetches before resolving either.
        await new Promise(r => setImmediate(r));
        assert.deepEqual(order, ['start:/x/soul.md', 'start:/x/memory.md']);
        releaseMemory();
        releaseSoul();
        const out = await p;
        assert.deepEqual(out, { soul: 'S', memory: 'M' });
    });

    it('defaults to bridge-backed runtime files under nova/*.md', async () => {
        const cap = makeCapsule();
        const mock = makeFetchMock({
            [`${NOVA_DEFAULT_PLUGIN_URL}/fs/read?path=nova%2Fsoul.md&encoding=utf8&maxBytes=262144`]: {
                body: JSON.stringify({ ok: true, path: 'nova/soul.md', content: 'S', bytes: 1 }),
            },
            [`${NOVA_DEFAULT_PLUGIN_URL}/fs/read?path=nova%2Fmemory.md&encoding=utf8&maxBytes=262144`]: {
                body: JSON.stringify({ ok: true, path: 'nova/memory.md', content: 'M', bytes: 1 }),
            },
        });
        const out = await cap.loadNovaSoulMemory({ fetchImpl: mock.fn });
        assert.deepEqual(out, { soul: 'S', memory: 'M' });
        assert.deepEqual(mock.calls, [
            `${NOVA_DEFAULT_PLUGIN_URL}/fs/read?path=nova%2Fsoul.md&encoding=utf8&maxBytes=262144`,
            `${NOVA_DEFAULT_PLUGIN_URL}/fs/read?path=nova%2Fmemory.md&encoding=utf8&maxBytes=262144`,
        ]);
    });

    it('falls back to extension-bundled templates when bridge files are missing', async () => {
        const cap = makeCapsule();
        const mock = makeFetchMock({
            [`${NOVA_DEFAULT_PLUGIN_URL}/fs/read?path=nova%2Fsoul.md&encoding=utf8&maxBytes=262144`]: {
                ok: false,
                status: 404,
                body: JSON.stringify({ error: 'not-found' }),
            },
            [`${NOVA_DEFAULT_PLUGIN_URL}/fs/read?path=nova%2Fmemory.md&encoding=utf8&maxBytes=262144`]: {
                ok: false,
                status: 404,
                body: JSON.stringify({ error: 'not-found' }),
            },
            [`/scripts/extensions/third-party/${EXT}/nova/soul.md`]: { body: 'starter soul' },
            [`/scripts/extensions/third-party/${EXT}/nova/memory.md`]: { body: 'starter memory' },
        });
        const out = await cap.loadNovaSoulMemory({ fetchImpl: mock.fn });
        assert.deepEqual(out, { soul: 'starter soul', memory: 'starter memory' });
        assert.deepEqual(mock.calls, [
            `${NOVA_DEFAULT_PLUGIN_URL}/fs/read?path=nova%2Fsoul.md&encoding=utf8&maxBytes=262144`,
            `${NOVA_DEFAULT_PLUGIN_URL}/fs/read?path=nova%2Fmemory.md&encoding=utf8&maxBytes=262144`,
            `/scripts/extensions/third-party/${EXT}/nova/soul.md`,
            `/scripts/extensions/third-party/${EXT}/nova/memory.md`,
        ]);
    });

    it('strips trailing slashes from baseUrl', async () => {
        const cap = makeCapsule();
        const mock = makeFetchMock({
            '/x/soul.md': { body: 'S' },
            '/x/memory.md': { body: 'M' },
        });
        await cap.loadNovaSoulMemory({ baseUrl: '/x///', fetchImpl: mock.fn });
        assert.ok(mock.calls.includes('/x/soul.md'));
        assert.ok(mock.calls.includes('/x/memory.md'));
    });
});

describe('loadNovaSoulMemory — error handling (never throws)', () => {
    it('returns empty string for a 404 file without affecting the other', async () => {
        const cap = makeCapsule();
        const mock = makeFetchMock({
            '/x/soul.md': { body: 'SOUL' },
            // memory.md absent → default 404 from the mock
        });
        const out = await cap.loadNovaSoulMemory({ baseUrl: '/x', fetchImpl: mock.fn });
        assert.deepEqual(out, { soul: 'SOUL', memory: '' });
    });

    it('returns empty strings when fetch throws (network error)', async () => {
        const cap = makeCapsule();
        const fn = async () => { throw new Error('offline'); };
        const out = await cap.loadNovaSoulMemory({ baseUrl: '/x', fetchImpl: fn });
        assert.deepEqual(out, { soul: '', memory: '' });
    });

    it('returns empty string when resp.text() throws', async () => {
        const cap = makeCapsule();
        const mock = makeFetchMock({
            '/x/soul.md': { body: 'SOUL' },
            '/x/memory.md': { textThrows: new Error('decode-fail') },
        });
        const out = await cap.loadNovaSoulMemory({ baseUrl: '/x', fetchImpl: mock.fn });
        assert.deepEqual(out, { soul: 'SOUL', memory: '' });
    });

    it('coerces non-string body to empty string', async () => {
        const cap = makeCapsule();
        const mock = makeFetchMock({
            '/x/soul.md': { body: 42 }, // unusual: resp.text() returned a number
            '/x/memory.md': { body: 'MEM' },
        });
        const out = await cap.loadNovaSoulMemory({ baseUrl: '/x', fetchImpl: mock.fn });
        assert.deepEqual(out, { soul: '', memory: 'MEM' });
    });

    it('returns empty strings when no fetchImpl is provided and global fetch is absent', async () => {
        const cap = makeCapsule();
        // Temporarily hide global.fetch to simulate an environment without fetch.
        const savedFetch = global.fetch;
        try {
            global.fetch = undefined;
            const out = await cap.loadNovaSoulMemory({ baseUrl: '/x' });
            assert.deepEqual(out, { soul: '', memory: '' });
        } finally {
            global.fetch = savedFetch;
        }
    });
});

describe('loadNovaSoulMemory — caching', () => {
    it('returns cached result within TTL without re-fetching', async () => {
        const cap = makeCapsule();
        const mock = makeFetchMock({
            '/x/soul.md': { body: 'S1' },
            '/x/memory.md': { body: 'M1' },
        });
        let nowVal = 1000;
        const nowImpl = () => nowVal;
        const first = await cap.loadNovaSoulMemory({ baseUrl: '/x', fetchImpl: mock.fn, nowImpl, ttlMs: 5000 });
        assert.deepEqual(first, { soul: 'S1', memory: 'M1' });
        assert.equal(mock.calls.length, 2);
        // Advance clock within TTL and call again — expect cache hit.
        nowVal = 2000;
        const second = await cap.loadNovaSoulMemory({ baseUrl: '/x', fetchImpl: mock.fn, nowImpl, ttlMs: 5000 });
        assert.deepEqual(second, { soul: 'S1', memory: 'M1' });
        assert.equal(mock.calls.length, 2, 'no new fetches while cache is warm');
        // Advance clock past TTL — expect refetch.
        nowVal = 10_000;
        const third = await cap.loadNovaSoulMemory({ baseUrl: '/x', fetchImpl: mock.fn, nowImpl, ttlMs: 5000 });
        assert.deepEqual(third, { soul: 'S1', memory: 'M1' });
        assert.equal(mock.calls.length, 4, 'two new fetches after TTL expiry');
    });

    it('force:true bypasses the cache', async () => {
        const cap = makeCapsule();
        let i = 0;
        const fn = async () => ({ ok: true, text: async () => `v${++i}` });
        const a = await cap.loadNovaSoulMemory({ baseUrl: '/x', fetchImpl: fn });
        const b = await cap.loadNovaSoulMemory({ baseUrl: '/x', fetchImpl: fn }); // cache hit
        const c = await cap.loadNovaSoulMemory({ baseUrl: '/x', fetchImpl: fn, force: true });
        assert.deepEqual(a, b); // cache hit returns same shape
        assert.notEqual(a.soul, c.soul, 'force must refetch');
    });

    it('invalidateNovaSoulMemoryCache() drops the cache', async () => {
        const cap = makeCapsule();
        let i = 0;
        const fn = async () => ({ ok: true, text: async () => `v${++i}` });
        await cap.loadNovaSoulMemory({ baseUrl: '/x', fetchImpl: fn });
        const cached = cap.peekCache();
        assert.ok(cached, 'cache populated after first load');
        cap.invalidateNovaSoulMemoryCache();
        assert.equal(cap.peekCache(), null);
        await cap.loadNovaSoulMemory({ baseUrl: '/x', fetchImpl: fn });
        assert.ok(cap.peekCache(), 'cache re-populated after invalidation + load');
    });

    it('caches failure results too (prevents hot-loop refetching when files are missing)', async () => {
        const cap = makeCapsule();
        let fetchCount = 0;
        const fn = async () => { fetchCount++; return { ok: false, status: 404, text: async () => '' }; };
        const nowImpl = () => 0;
        await cap.loadNovaSoulMemory({ baseUrl: '/x', fetchImpl: fn, nowImpl });
        assert.equal(fetchCount, 2);
        await cap.loadNovaSoulMemory({ baseUrl: '/x', fetchImpl: fn, nowImpl });
        assert.equal(fetchCount, 2, 'second call must hit the cache even though both files returned empty');
    });
});

// -------- Source-text contract --------

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

describe('index.js source shape', () => {
    it('declares the soul/memory loader in the NOVA AGENT section', async () => {
        const here = dirname(fileURLToPath(import.meta.url));
        const js = await readFile(resolve(here, '..', 'index.js'), 'utf8');
        assert.match(js, /async\s+function\s+loadNovaSoulMemory\s*\(/);
        assert.match(js, /function\s+invalidateNovaSoulMemoryCache\s*\(/);
        assert.match(js, /async\s+function\s+_fetchNovaMarkdown\s*\(/);
        assert.match(js, /const\s+NOVA_SOUL_MEMORY_TTL_MS\s*=/);
        assert.match(js, /const\s+NOVA_SOUL_FILENAME\s*=\s*'soul\.md'/);
        assert.match(js, /const\s+NOVA_MEMORY_FILENAME\s*=\s*'memory\.md'/);
    });

    it('default baseUrl references the EXT constant, not a hard-coded slug', async () => {
        const here = dirname(fileURLToPath(import.meta.url));
        const js = await readFile(resolve(here, '..', 'index.js'), 'utf8');
        // Default builder must interpolate EXT so a rename of the extension
        // folder only has to happen in one place.
        assert.match(js, /function\s+defaultNovaSoulMemoryBaseUrl[\s\S]*?\$\{EXT\}\/nova/);
    });

    it('loader lives between the probe helper and the diff helper', async () => {
        const here = dirname(fileURLToPath(import.meta.url));
        const js = await readFile(resolve(here, '..', 'index.js'), 'utf8');
        const probeIdx = js.indexOf('async function probeNovaBridge(');
        const loaderIdx = js.indexOf('async function loadNovaSoulMemory(');
        const diffIdx = js.indexOf('function buildNovaUnifiedDiff(');
        assert.ok(probeIdx > 0 && loaderIdx > 0 && diffIdx > 0);
        assert.ok(loaderIdx > probeIdx, 'loader must come after probe');
        assert.ok(loaderIdx < diffIdx, 'loader must come before diff helper');
    });
});
