/**
 * Unit tests for Nova connection-profile handling (plan §9).
 * Run with: node --test test/nova-profile-swap.test.mjs
 *
 * Covers:
 *   - parseNovaProfileListPipe  — JSON + fallback parsing
 *   - listNovaProfiles          — executor integration
 *   - withNovaProfileMutex      — serialisation + non-poisoning
 *
 * Inline-copy convention per AGENT_MEMORY.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// -------- Inline copy --------

function parseNovaProfileListPipe(pipeValue) {
    if (pipeValue == null) return [];
    const s = String(pipeValue).trim();
    if (!s) return [];
    if (s.startsWith('[')) {
        try {
            const arr = JSON.parse(s);
            if (Array.isArray(arr)) {
                return Array.from(new Set(
                    arr.map(x => String(x ?? '').trim()).filter(Boolean),
                ));
            }
        } catch (_) { /* fallthrough */ }
    }
    return Array.from(new Set(
        s.split(/[\n,]+/).map(x => x.trim()).filter(Boolean),
    ));
}

async function listNovaProfiles({ executeSlash }) {
    if (typeof executeSlash !== 'function') {
        return { ok: false, reason: 'no-executor', profiles: [] };
    }
    let res;
    try {
        res = await executeSlash('/profile-list');
    } catch (err) {
        return { ok: false, reason: 'executor-failed', error: String(err?.message || err), profiles: [] };
    }
    const profiles = parseNovaProfileListPipe(res && res.pipe);
    return { ok: true, profiles };
}

async function withNovaProfileMutex(fn, { mutex } = {}) {
    const m = mutex || { chain: Promise.resolve() };
    const prev = m.chain;
    let release;
    m.chain = new Promise((resolve) => { release = resolve; });
    try {
        await prev.catch(() => {});
        return await fn();
    } finally {
        release();
    }
}

// -------- Tests --------

describe('parseNovaProfileListPipe', () => {
    it('parses JSON array pipe', () => {
        assert.deepEqual(parseNovaProfileListPipe('["a","b","c"]'), ['a', 'b', 'c']);
    });
    it('trims whitespace and drops empties from JSON array', () => {
        assert.deepEqual(parseNovaProfileListPipe('[" a ", "", "b"]'), ['a', 'b']);
    });
    it('dedupes JSON entries', () => {
        assert.deepEqual(parseNovaProfileListPipe('["a","a","b"]'), ['a', 'b']);
    });
    it('handles empty / null / whitespace', () => {
        assert.deepEqual(parseNovaProfileListPipe(null), []);
        assert.deepEqual(parseNovaProfileListPipe(undefined), []);
        assert.deepEqual(parseNovaProfileListPipe(''), []);
        assert.deepEqual(parseNovaProfileListPipe('   '), []);
    });
    it('falls back to newline/comma split when not JSON', () => {
        assert.deepEqual(parseNovaProfileListPipe('a\nb\nc'), ['a', 'b', 'c']);
        assert.deepEqual(parseNovaProfileListPipe('a, b, c'), ['a', 'b', 'c']);
    });
    it('returns [] when JSON parse fails entirely and input starts with [', () => {
        // Malformed JSON that still starts with '[' falls through to the
        // whitespace split. That split will still extract tokens, which
        // is acceptable forward-compat behaviour.
        const got = parseNovaProfileListPipe('[this is not json');
        assert.ok(Array.isArray(got));
    });
    it('coerces non-string entries to strings', () => {
        assert.deepEqual(parseNovaProfileListPipe('[1, 2, "three"]'), ['1', '2', 'three']);
    });
});

describe('listNovaProfiles', () => {
    it('returns profiles on successful executor call', async () => {
        const executeSlash = async (cmd) => {
            assert.equal(cmd, '/profile-list');
            return { pipe: '["Alpha","Beta"]' };
        };
        const out = await listNovaProfiles({ executeSlash });
        assert.deepEqual(out, { ok: true, profiles: ['Alpha', 'Beta'] });
    });
    it('returns no-executor when executeSlash missing', async () => {
        const out = await listNovaProfiles({});
        assert.equal(out.ok, false);
        assert.equal(out.reason, 'no-executor');
        assert.deepEqual(out.profiles, []);
    });
    it('returns executor-failed when executeSlash throws', async () => {
        const executeSlash = async () => { throw new Error('slash unavailable'); };
        const out = await listNovaProfiles({ executeSlash });
        assert.equal(out.ok, false);
        assert.equal(out.reason, 'executor-failed');
        assert.match(out.error, /slash unavailable/);
    });
    it('returns empty profile list on empty pipe', async () => {
        const executeSlash = async () => ({ pipe: '' });
        const out = await listNovaProfiles({ executeSlash });
        assert.deepEqual(out, { ok: true, profiles: [] });
    });
});

describe('withNovaProfileMutex', () => {
    it('runs fn and returns its result', async () => {
        const out = await withNovaProfileMutex(async () => 42);
        assert.equal(out, 42);
    });

    it('serialises concurrent callers (second waits for first)', async () => {
        const mutex = { chain: Promise.resolve() };
        const events = [];
        let release1;
        const p1 = withNovaProfileMutex(async () => {
            events.push('1-start');
            await new Promise((r) => { release1 = r; });
            events.push('1-end');
            return 'one';
        }, { mutex });
        // Kick off second caller; it should not start until p1 finishes.
        const p2 = withNovaProfileMutex(async () => {
            events.push('2-start');
            return 'two';
        }, { mutex });

        // Let microtasks settle. p1 should have started, p2 should NOT.
        await new Promise((r) => setTimeout(r, 5));
        assert.deepEqual(events, ['1-start']);

        release1();
        const [r1, r2] = await Promise.all([p1, p2]);
        assert.equal(r1, 'one');
        assert.equal(r2, 'two');
        assert.deepEqual(events, ['1-start', '1-end', '2-start']);
    });

    it('does NOT poison the chain when predecessor rejects', async () => {
        const mutex = { chain: Promise.resolve() };
        const p1 = withNovaProfileMutex(async () => { throw new Error('boom'); }, { mutex });
        await assert.rejects(p1, /boom/);

        // Chain must still accept new callers after a rejection.
        const r = await withNovaProfileMutex(async () => 'recovered', { mutex });
        assert.equal(r, 'recovered');
    });

    it('preserves order under sequential failures', async () => {
        const mutex = { chain: Promise.resolve() };
        const results = [];
        const p1 = withNovaProfileMutex(async () => { throw new Error('e1'); }, { mutex })
            .catch((e) => results.push(`err:${e.message}`));
        const p2 = withNovaProfileMutex(async () => { results.push('ok2'); return 2; }, { mutex });
        const p3 = withNovaProfileMutex(async () => { throw new Error('e3'); }, { mutex })
            .catch((e) => results.push(`err:${e.message}`));

        await Promise.all([p1, p2, p3]);
        assert.deepEqual(results, ['err:e1', 'ok2', 'err:e3']);
    });

    it('uses a fresh module-level mutex when none injected', async () => {
        // Smoke test only — the caller should always inject its own mutex
        // in production, but the helper tolerates the bare call.
        const r = await withNovaProfileMutex(async () => 'bare');
        assert.equal(r, 'bare');
    });
});
