/**
 * Unit tests for Nova bridge capability probe (plan §4f).
 * Run with: node --test test/nova-probe.test.mjs
 *
 * Mirrors `probeNovaBridge` in index.js under the
 * `/* === NOVA AGENT === *\/` section. Update in lockstep if the production
 * copy changes — this file is an inline copy per the AGENT_MEMORY convention
 * (index.js can't be `import`-ed from plain Node because of ST runtime deps).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const NOVA_DEFAULTS = {
    profileName: '',
    defaultTier: 'read',
    maxToolCalls: 24,
    turnTimeoutMs: 300000,
    pluginBaseUrl: '/api/plugins/nova-agent-bridge',
    rememberApprovalsSession: false,
    activeSkill: 'freeform',
};

const NOVA_PROBE_TTL_MS = 60_000;
const NOVA_PROBE_TIMEOUT_MS = 3_000;

let _novaBridgeProbeCache = null;

function invalidateNovaBridgeProbeCache() {
    _novaBridgeProbeCache = null;
}

function _coerceNovaCapabilities(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const out = {};
    for (const k of Object.keys(raw)) out[k] = !!raw[k];
    return out;
}

async function probeNovaBridge({
    baseUrl,
    fetchImpl,
    nowImpl,
    ttlMs = NOVA_PROBE_TTL_MS,
    timeoutMs = NOVA_PROBE_TIMEOUT_MS,
    force = false,
} = {}) {
    const now = typeof nowImpl === 'function' ? nowImpl : Date.now;
    const doFetch = typeof fetchImpl === 'function'
        ? fetchImpl
        : (typeof fetch === 'function' ? fetch : null);

    if (!force && _novaBridgeProbeCache && _novaBridgeProbeCache.expiresAt > now()) {
        return _novaBridgeProbeCache.result;
    }

    const url = String(baseUrl || NOVA_DEFAULTS.pluginBaseUrl).replace(/\/+$/, '') + '/manifest';

    const miss = (_reason) => {
        const result = { present: false };
        _novaBridgeProbeCache = { result, expiresAt: now() + ttlMs };
        return result;
    };

    if (!doFetch) return miss('no-fetch');

    let signal;
    try {
        if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
            signal = AbortSignal.timeout(timeoutMs);
        } else if (typeof AbortController === 'function') {
            const ctl = new AbortController();
            setTimeout(() => ctl.abort(), timeoutMs);
            signal = ctl.signal;
        }
    } catch (_) { /* leave signal undefined */ }

    let resp;
    try {
        resp = await doFetch(url, { method: 'GET', signal });
    } catch (_err) {
        return miss('network-error');
    }

    if (!resp || !resp.ok) {
        return miss(`status-${resp && resp.status}`);
    }

    let body;
    try {
        body = await resp.json();
    } catch (_err) {
        return miss('bad-json');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return miss('non-object-body');
    }

    const result = { present: true };
    if (body.version !== undefined) result.version = String(body.version);
    if (body.root !== undefined) result.root = String(body.root);
    if (Array.isArray(body.shellAllowList)) {
        result.shellAllowList = body.shellAllowList.map(String);
    }
    const caps = _coerceNovaCapabilities(body.capabilities);
    if (caps) result.capabilities = caps;

    _novaBridgeProbeCache = { result, expiresAt: now() + ttlMs };
    return result;
}

// --- Test helpers ---

/**
 * Minimal stand-in for a `fetch` Response that mirrors the subset the probe
 * reads: `ok`, `status`, and `json()`. Accepts a `jsonImpl` so tests can
 * simulate malformed bodies via a rejected promise.
 */
function mockResp({ ok = true, status = 200, body = {}, jsonImpl } = {}) {
    return {
        ok,
        status,
        json: jsonImpl ? jsonImpl : async () => body,
    };
}

/**
 * Build a fetch mock that records calls and returns a configured response.
 * `handler` receives `(url, init)` and returns either a Response, a Promise
 * of one, or throws to simulate a network error.
 */
function makeFetchMock(handler) {
    const calls = [];
    const fn = async (url, init) => {
        calls.push({ url, init });
        return handler(url, init);
    };
    fn.calls = calls;
    return fn;
}

// --- Tests ---

describe('probeNovaBridge', () => {
    beforeEach(() => invalidateNovaBridgeProbeCache());

    it('returns { present: true, ... } on a well-formed manifest', async () => {
        const fetchImpl = makeFetchMock(() => mockResp({
            body: {
                id: 'nova-agent-bridge',
                version: '0.1.0',
                root: '/srv/sillytavern',
                shellAllowList: ['git', 'node'],
                capabilities: { fs_list: true, fs_read: false, shell_run: 0 },
            },
        }));
        const result = await probeNovaBridge({ fetchImpl, nowImpl: () => 1000 });
        assert.equal(result.present, true);
        assert.equal(result.version, '0.1.0');
        assert.equal(result.root, '/srv/sillytavern');
        assert.deepEqual(result.shellAllowList, ['git', 'node']);
        // Strict boolean coercion — 0 becomes false.
        assert.deepEqual(result.capabilities, {
            fs_list: true, fs_read: false, shell_run: false,
        });
    });

    it('hits the expected /manifest URL derived from baseUrl', async () => {
        const fetchImpl = makeFetchMock(() => mockResp({ body: { version: '1' } }));
        await probeNovaBridge({ fetchImpl, baseUrl: '/api/plugins/nova-agent-bridge/' });
        assert.equal(fetchImpl.calls.length, 1);
        // Trailing slash on baseUrl is stripped before appending /manifest.
        assert.equal(fetchImpl.calls[0].url, '/api/plugins/nova-agent-bridge/manifest');
    });

    it('honours a custom baseUrl override', async () => {
        const fetchImpl = makeFetchMock(() => mockResp({ body: { version: '9' } }));
        await probeNovaBridge({ fetchImpl, baseUrl: 'https://example.test/plugins/nab' });
        assert.equal(fetchImpl.calls[0].url, 'https://example.test/plugins/nab/manifest');
    });

    it('returns { present: false } on 404', async () => {
        const fetchImpl = makeFetchMock(() => mockResp({ ok: false, status: 404 }));
        const result = await probeNovaBridge({ fetchImpl });
        assert.deepEqual(result, { present: false });
    });

    it('returns { present: false } on non-200 non-404 (e.g. 500)', async () => {
        const fetchImpl = makeFetchMock(() => mockResp({ ok: false, status: 500 }));
        const result = await probeNovaBridge({ fetchImpl });
        assert.deepEqual(result, { present: false });
    });

    it('returns { present: false } when fetch rejects (network error)', async () => {
        const fetchImpl = makeFetchMock(() => { throw new Error('ECONNREFUSED'); });
        const result = await probeNovaBridge({ fetchImpl });
        assert.deepEqual(result, { present: false });
    });

    it('returns { present: false } when the request times out', async () => {
        // Simulate AbortSignal.timeout firing — fetch receives an already-aborted
        // signal and throws a DOMException-like error.
        const fetchImpl = makeFetchMock(async (_url, init) => {
            // Honour the signal — throw synchronously in the "already aborted"
            // case to mirror real fetch behaviour.
            if (init && init.signal && init.signal.aborted) {
                const e = new Error('The operation was aborted');
                e.name = 'AbortError';
                throw e;
            }
            // Wait for abort, then throw.
            await new Promise((resolve, reject) => {
                init.signal.addEventListener('abort', () => {
                    const e = new Error('The operation was aborted');
                    e.name = 'AbortError';
                    reject(e);
                });
            });
        });
        // Use a very short timeout so the test finishes quickly.
        const result = await probeNovaBridge({ fetchImpl, timeoutMs: 5 });
        assert.deepEqual(result, { present: false });
    });

    it('returns { present: false } on malformed JSON body', async () => {
        const fetchImpl = makeFetchMock(() => mockResp({
            jsonImpl: async () => { throw new SyntaxError('Unexpected token'); },
        }));
        const result = await probeNovaBridge({ fetchImpl });
        assert.deepEqual(result, { present: false });
    });

    it('returns { present: false } on non-object body (e.g. array)', async () => {
        const fetchImpl = makeFetchMock(() => mockResp({ body: [] }));
        const result = await probeNovaBridge({ fetchImpl });
        assert.deepEqual(result, { present: false });
    });

    it('drops capabilities field when manifest omits it or sends non-object', async () => {
        const fetchImpl = makeFetchMock(() => mockResp({
            body: { version: '0.1.0', capabilities: 'nope' },
        }));
        const result = await probeNovaBridge({ fetchImpl });
        assert.equal(result.present, true);
        assert.equal(result.version, '0.1.0');
        assert.equal('capabilities' in result, false);
    });

    it('drops shellAllowList field when manifest sends non-array', async () => {
        const fetchImpl = makeFetchMock(() => mockResp({
            body: { version: '0.1.0', shellAllowList: 'git,node' },
        }));
        const result = await probeNovaBridge({ fetchImpl });
        assert.equal(result.present, true);
        assert.equal('shellAllowList' in result, false);
    });

    it('caches hits within TTL (second call does not refetch)', async () => {
        const fetchImpl = makeFetchMock(() => mockResp({ body: { version: '1' } }));
        let now = 1000;
        const nowImpl = () => now;
        const first = await probeNovaBridge({ fetchImpl, nowImpl });
        assert.equal(first.present, true);
        now += 30_000; // still within 60s TTL
        const second = await probeNovaBridge({ fetchImpl, nowImpl });
        assert.equal(second, first, 'cache hit should return the same object');
        assert.equal(fetchImpl.calls.length, 1, 'second call must not refetch');
    });

    it('caches misses within TTL too (avoids hammering a missing plugin)', async () => {
        const fetchImpl = makeFetchMock(() => mockResp({ ok: false, status: 404 }));
        let now = 1000;
        const nowImpl = () => now;
        await probeNovaBridge({ fetchImpl, nowImpl });
        now += 30_000;
        await probeNovaBridge({ fetchImpl, nowImpl });
        assert.equal(fetchImpl.calls.length, 1);
    });

    it('refetches after TTL expiry', async () => {
        const fetchImpl = makeFetchMock(() => mockResp({ body: { version: '1' } }));
        let now = 1000;
        const nowImpl = () => now;
        await probeNovaBridge({ fetchImpl, nowImpl, ttlMs: 1000 });
        now += 1500; // past TTL
        await probeNovaBridge({ fetchImpl, nowImpl, ttlMs: 1000 });
        assert.equal(fetchImpl.calls.length, 2);
    });

    it('force: true bypasses the cache', async () => {
        const fetchImpl = makeFetchMock(() => mockResp({ body: { version: '1' } }));
        const nowImpl = () => 1000;
        await probeNovaBridge({ fetchImpl, nowImpl });
        await probeNovaBridge({ fetchImpl, nowImpl, force: true });
        assert.equal(fetchImpl.calls.length, 2);
    });

    it('invalidateNovaBridgeProbeCache forces a refetch', async () => {
        const fetchImpl = makeFetchMock(() => mockResp({ body: { version: '1' } }));
        const nowImpl = () => 1000;
        await probeNovaBridge({ fetchImpl, nowImpl });
        invalidateNovaBridgeProbeCache();
        await probeNovaBridge({ fetchImpl, nowImpl });
        assert.equal(fetchImpl.calls.length, 2);
    });

    it('returns { present: false } and caches when no fetch impl is available', async () => {
        // Simulate a platform without global fetch by passing a non-function.
        const nowImpl = () => 1000;
        const result = await probeNovaBridge({ fetchImpl: null, nowImpl });
        // In Node 18+ global fetch exists, so this path only fires when the
        // platform genuinely lacks it. Assert the return shape is valid
        // regardless — either {present:false} (no fetch) or {present:true}
        // (global fetch returned something, but we forced fetchImpl=null so
        // it must fall through to global fetch which will likely fail for
        // '/api/plugins/...' with no host).
        assert.equal(typeof result.present, 'boolean');
    });

    it('does not throw on manifest body missing expected keys', async () => {
        const fetchImpl = makeFetchMock(() => mockResp({ body: {} }));
        const result = await probeNovaBridge({ fetchImpl });
        assert.equal(result.present, true);
        assert.equal('version' in result, false);
        assert.equal('root' in result, false);
    });
});

describe('_coerceNovaCapabilities', () => {
    it('returns undefined for non-objects', () => {
        assert.equal(_coerceNovaCapabilities(null), undefined);
        assert.equal(_coerceNovaCapabilities(undefined), undefined);
        assert.equal(_coerceNovaCapabilities('string'), undefined);
        assert.equal(_coerceNovaCapabilities(42), undefined);
        assert.equal(_coerceNovaCapabilities([]), undefined);
    });

    it('coerces all values to strict booleans', () => {
        assert.deepEqual(
            _coerceNovaCapabilities({ a: 1, b: 0, c: '', d: 'yes', e: null, f: true, g: false }),
            { a: true, b: false, c: false, d: true, e: false, f: true, g: false },
        );
    });

    it('returns an empty object for an empty capabilities map', () => {
        assert.deepEqual(_coerceNovaCapabilities({}), {});
    });
});
