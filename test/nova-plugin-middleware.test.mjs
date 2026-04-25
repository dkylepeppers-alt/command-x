/**
 * Unit tests for the nova-agent-bridge security middleware (plan §8c).
 * Run with: node --test test/nova-plugin-middleware.test.mjs
 *
 * Loads the real module via createRequire — the middleware is pure
 * (no I/O, no state) so we can drive it with synthetic req/res/next
 * mocks and fully cover the contract.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mw = require(path.resolve(__dirname, '../server-plugin/nova-agent-bridge/middleware.js'));
const { buildNovaSecurityMiddleware, STATE_CHANGING_METHODS, _internal } = mw;

// -------- Test utilities --------

function makeRes() {
    const state = { status: null, body: null, ended: false };
    return {
        status(c) { state.status = c; return this; },
        json(b) { state.body = b; return this; },
        end() { state.ended = true; return this; },
        get _state() { return state; },
    };
}

function run(middleware, req, res) {
    let called = 0;
    middleware(req, res || makeRes(), () => { called++; });
    return called;
}

// -------- Tests: exports --------

describe('module exports', () => {
    it('exports buildNovaSecurityMiddleware as a factory function', () => {
        assert.equal(typeof buildNovaSecurityMiddleware, 'function');
    });
    it('STATE_CHANGING_METHODS is a Set of POST/PUT/PATCH/DELETE', () => {
        assert.ok(STATE_CHANGING_METHODS instanceof Set);
        for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.ok(STATE_CHANGING_METHODS.has(m));
        for (const m of ['GET', 'HEAD', 'OPTIONS']) assert.ok(!STATE_CHANGING_METHODS.has(m));
    });
    it('returns a function named novaSecurityMiddleware for stack inspection', () => {
        const fn = buildNovaSecurityMiddleware();
        assert.equal(typeof fn, 'function');
        assert.equal(fn.name, 'novaSecurityMiddleware');
    });
});

// -------- Tests: skip list --------

describe('skip list', () => {
    it('defaults to /health and /manifest — no session required', () => {
        const m = buildNovaSecurityMiddleware();
        const res1 = makeRes();
        assert.equal(run(m, { method: 'GET', path: '/health', headers: {} }, res1), 1);
        assert.equal(res1._state.status, null, 'skip-listed route must not set status');

        const res2 = makeRes();
        assert.equal(run(m, { method: 'GET', path: '/manifest', headers: {} }, res2), 1);
        assert.equal(res2._state.status, null);
    });

    it('explicit skip array is honoured; defaults are replaced', () => {
        const m = buildNovaSecurityMiddleware({ skip: ['/custom'] });
        assert.equal(run(m, { method: 'GET', path: '/custom', headers: {} }), 1);
        // /health is no longer skipped → session check triggers
        const res = makeRes();
        assert.equal(run(m, { method: 'GET', path: '/health', headers: {} }, res), 0);
        assert.equal(res._state.status, 401);
    });

    it('skip list accepts a Set', () => {
        const m = buildNovaSecurityMiddleware({ skip: new Set(['/a', '/b']) });
        assert.equal(run(m, { method: 'GET', path: '/a', headers: {} }), 1);
        assert.equal(run(m, { method: 'GET', path: '/b', headers: {} }), 1);
        assert.equal(run(m, { method: 'GET', path: '/c', headers: {} }), 0);
    });

    it('skip list filters out non-string entries', () => {
        const m = buildNovaSecurityMiddleware({ skip: ['/ok', null, undefined, 42, '/also'] });
        assert.equal(run(m, { method: 'GET', path: '/ok', headers: {} }), 1);
        assert.equal(run(m, { method: 'GET', path: '/also', headers: {} }), 1);
    });

    it('req.path missing → falls back to req.url (strips query)', () => {
        const m = buildNovaSecurityMiddleware();
        assert.equal(run(m, { method: 'GET', url: '/health?foo=1', headers: {} }), 1);
        assert.equal(run(m, { method: 'GET', url: '/manifest', headers: {} }), 1);
    });
});

// -------- Tests: session check --------

describe('session check', () => {
    it('missing req.session → 401 nova-unauthorized', () => {
        const m = buildNovaSecurityMiddleware();
        const res = makeRes();
        assert.equal(run(m, { method: 'GET', path: '/fs/list', headers: {} }, res), 0);
        assert.equal(res._state.status, 401);
        assert.equal(res._state.body.error, 'nova-unauthorized');
    });

    it('empty req.session object → 401', () => {
        const m = buildNovaSecurityMiddleware();
        const res = makeRes();
        assert.equal(run(m, { method: 'GET', path: '/fs/list', headers: {}, session: {} }, res), 0);
        assert.equal(res._state.status, 401);
    });

    it('req.session.handle alone is enough (authenticated user with no CSRF yet)', () => {
        const m = buildNovaSecurityMiddleware();
        assert.equal(run(m, {
            method: 'GET', path: '/fs/list', headers: {}, session: { handle: 'alice' },
        }), 1);
    });

    it('req.session.csrfToken alone is enough (anonymous read flow)', () => {
        const m = buildNovaSecurityMiddleware();
        assert.equal(run(m, {
            method: 'GET', path: '/fs/list', headers: {}, session: { csrfToken: 'abc' },
        }), 1);
    });

    it('non-object session values → 401', () => {
        const m = buildNovaSecurityMiddleware();
        for (const bad of [null, 42, 'string', true, []]) {
            const res = makeRes();
            assert.equal(run(m, { method: 'GET', path: '/fs/list', headers: {}, session: bad }, res), 0);
            assert.equal(res._state.status, 401, `session=${JSON.stringify(bad)} should 401`);
        }
    });

    it('sessionRequired: false disables the check', () => {
        const m = buildNovaSecurityMiddleware({ sessionRequired: false, csrfRequired: false });
        assert.equal(run(m, { method: 'GET', path: '/fs/list', headers: {} }), 1);
        assert.equal(run(m, { method: 'GET', path: '/fs/list', headers: {}, session: null }), 1);
    });
});

// -------- Tests: CSRF check --------

describe('CSRF check', () => {
    const session = { handle: 'alice', csrfToken: 'tok-123' };

    it('GET does not require CSRF even with session present', () => {
        const m = buildNovaSecurityMiddleware();
        assert.equal(run(m, { method: 'GET', path: '/fs/list', headers: {}, session }), 1);
    });

    it('HEAD and OPTIONS are not state-changing → pass without CSRF', () => {
        const m = buildNovaSecurityMiddleware();
        assert.equal(run(m, { method: 'HEAD', path: '/fs/list', headers: {}, session }), 1);
        assert.equal(run(m, { method: 'OPTIONS', path: '/fs/list', headers: {}, session }), 1);
    });

    it('POST with matching token passes', () => {
        const m = buildNovaSecurityMiddleware();
        assert.equal(run(m, {
            method: 'POST', path: '/fs/write', headers: { 'x-csrf-token': 'tok-123' }, session,
        }), 1);
    });

    it('PUT/PATCH/DELETE also require token', () => {
        const m = buildNovaSecurityMiddleware();
        for (const method of ['PUT', 'PATCH', 'DELETE']) {
            const resOk = makeRes();
            assert.equal(
                run(m, { method, path: '/fs/whatever', headers: { 'x-csrf-token': 'tok-123' }, session }, resOk),
                1,
                `${method} with token must pass`,
            );
            const resFail = makeRes();
            assert.equal(
                run(m, { method, path: '/fs/whatever', headers: {}, session }, resFail),
                0,
                `${method} without token must fail`,
            );
            assert.equal(resFail._state.status, 403);
            assert.equal(resFail._state.body.error, 'nova-csrf-missing');
        }
    });

    it('POST missing header → 403 nova-csrf-missing', () => {
        const m = buildNovaSecurityMiddleware();
        const res = makeRes();
        assert.equal(run(m, { method: 'POST', path: '/fs/write', headers: {}, session }, res), 0);
        assert.equal(res._state.status, 403);
        assert.equal(res._state.body.error, 'nova-csrf-missing');
    });

    it('POST with empty header → treated as missing', () => {
        const m = buildNovaSecurityMiddleware();
        const res = makeRes();
        assert.equal(run(m, {
            method: 'POST', path: '/fs/write', headers: { 'x-csrf-token': '' }, session,
        }, res), 0);
        assert.equal(res._state.body.error, 'nova-csrf-missing');
    });

    it('POST with mismatched header → 403 nova-csrf-mismatch', () => {
        const m = buildNovaSecurityMiddleware();
        const res = makeRes();
        assert.equal(run(m, {
            method: 'POST', path: '/fs/write', headers: { 'x-csrf-token': 'wrong-tok' }, session,
        }, res), 0);
        assert.equal(res._state.status, 403);
        assert.equal(res._state.body.error, 'nova-csrf-mismatch');
    });

    it('POST with header but no session csrfToken slot → 403 nova-csrf-stale-session', () => {
        const m = buildNovaSecurityMiddleware();
        const res = makeRes();
        assert.equal(run(m, {
            method: 'POST', path: '/fs/write',
            headers: { 'x-csrf-token': 'anything' },
            session: { handle: 'alice' }, // no csrfToken
        }, res), 0);
        assert.equal(res._state.status, 403);
        assert.equal(res._state.body.error, 'nova-csrf-stale-session');
    });

    it('x-csrf-token array shape (proxy-coalesced) → first element used', () => {
        const m = buildNovaSecurityMiddleware();
        assert.equal(run(m, {
            method: 'POST', path: '/fs/write',
            headers: { 'x-csrf-token': ['tok-123', 'dup'] }, session,
        }), 1);
    });

    it('method is upper-cased before matching', () => {
        const m = buildNovaSecurityMiddleware();
        const res = makeRes();
        assert.equal(run(m, { method: 'post', path: '/fs/write', headers: {}, session }, res), 0);
        assert.equal(res._state.status, 403, 'lowercase method must still trigger CSRF');
    });

    it('csrfRequired: false disables the check (still runs session)', () => {
        const m = buildNovaSecurityMiddleware({ csrfRequired: false });
        assert.equal(run(m, { method: 'POST', path: '/fs/write', headers: {}, session }), 1);
    });

    it('GET with a bad/spoofed token in header is not validated (CSRF only gates writes)', () => {
        // Rationale: GETs are idempotent; csrf-sync (ST's upstream) also
        // doesn't check them. Keep behaviour aligned.
        const m = buildNovaSecurityMiddleware();
        assert.equal(run(m, {
            method: 'GET', path: '/fs/list', headers: { 'x-csrf-token': 'garbage' }, session,
        }), 1);
    });
});

// -------- Tests: defensive / never-throws --------

describe('defensive contract', () => {
    it('missing req → no-op pass-through (does not crash Express error chain)', () => {
        const m = buildNovaSecurityMiddleware();
        let called = 0;
        m(undefined, makeRes(), () => { called++; });
        assert.equal(called, 1);
        m(null, makeRes(), () => { called++; });
        assert.equal(called, 2);
    });

    it('missing next callback does not throw', () => {
        const m = buildNovaSecurityMiddleware();
        assert.doesNotThrow(() => m({ method: 'GET', path: '/health', headers: {} }, makeRes()));
        assert.doesNotThrow(() => m({ method: 'GET', path: '/fs/list', headers: {} }, makeRes()));
    });

    it('malformed res falls back to end() where possible', () => {
        const m = buildNovaSecurityMiddleware();
        let ended = false;
        const badRes = {
            status() { throw new Error('status blew up'); },
            end() { ended = true; },
        };
        assert.doesNotThrow(() => m({ method: 'POST', path: '/fs/write', headers: {} }, badRes, () => {}));
        assert.equal(ended, true, 'middleware should fall back to end() when status/json throw');
    });

    it('never throws for garbage req shapes', () => {
        const m = buildNovaSecurityMiddleware();
        const cases = [
            { method: {}, path: 42, headers: 'string', session: [] },
            { method: null, path: null, headers: null, session: null },
            { method: 'POST', headers: { 'x-csrf-token': 42 }, session: { csrfToken: 'x' } },
            { method: 'POST', url: '/fs/write?x=1', headers: {}, session: { handle: 'a', csrfToken: 'x' } },
        ];
        for (const req of cases) {
            assert.doesNotThrow(() => m(req, makeRes(), () => {}), `should not throw for ${JSON.stringify(req)}`);
        }
    });
});

// -------- Tests: constant-time compare --------

describe('constantTimeStringEqual (internal)', () => {
    const { constantTimeStringEqual } = _internal;

    it('matches identical strings', () => {
        assert.equal(constantTimeStringEqual('abc123', 'abc123'), true);
        assert.equal(constantTimeStringEqual('', ''), true);
    });

    it('rejects differing-content same-length strings', () => {
        assert.equal(constantTimeStringEqual('abc', 'abd'), false);
        assert.equal(constantTimeStringEqual('0000', '0001'), false);
    });

    it('rejects differing lengths', () => {
        assert.equal(constantTimeStringEqual('abc', 'abcd'), false);
        assert.equal(constantTimeStringEqual('a', ''), false);
    });

    it('rejects non-string inputs without throwing', () => {
        assert.equal(constantTimeStringEqual(null, 'x'), false);
        assert.equal(constantTimeStringEqual('x', null), false);
        assert.equal(constantTimeStringEqual(undefined, undefined), false);
        assert.equal(constantTimeStringEqual(42, 42), false);
        assert.equal(constantTimeStringEqual({}, {}), false);
    });
});
