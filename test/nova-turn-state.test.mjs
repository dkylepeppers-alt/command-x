/**
 * Structural tests for Nova module-level turn state (plan §3a).
 * Run with: node --test test/nova-turn-state.test.mjs
 *
 * Phase 3a ships three `let` bindings + a `_getNovaTurnState()` snapshot
 * helper that the Phase 3b turn lifecycle will mutate. Full behavioural
 * tests (finally-block cleanup, re-entrancy guard) land with §3b.
 *
 * This suite has two jobs:
 *  1. Lock in the scaffolding via source-text assertions so a careless
 *     refactor can't silently drop a binding Phase 3b depends on.
 *  2. Mirror the `_getNovaTurnState()` helper in-file (per the inline-copy
 *     convention documented in AGENT_MEMORY) and assert its shape +
 *     snapshot-independence contract on a miniature closure-backed stand-in.
 */

import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

async function loadIndex() {
    return readFile(resolve(repoRoot, 'index.js'), 'utf8');
}

// ---------------------------------------------------------------------------
// 1. Source-text contract — lock in the scaffolding.
// ---------------------------------------------------------------------------

test('index.js declares the three Nova turn-state bindings with correct initial values', async () => {
    const js = await loadIndex();
    // `let` not `const` — these are mutated by §3b.
    assert.match(js, /let\s+novaTurnInFlight\s*=\s*false\s*;/);
    assert.match(js, /let\s+novaAbortController\s*=\s*null\s*;/);
    assert.match(js, /let\s+novaToolRegistryVersion\s*=\s*0\s*;/);
});

test('index.js exports a _getNovaTurnState snapshot helper', async () => {
    const js = await loadIndex();
    assert.match(js, /function\s+_getNovaTurnState\s*\(\s*\)/);
    // The snapshot must not leak the AbortController reference — it exposes
    // a boolean `hasAbort` instead.
    assert.match(js, /hasAbort:\s*novaAbortController\s*!==\s*null/);
    // Phase 3b reads `registryVersion` to decide when to rebuild the tool
    // schema array. If this field is renamed, update §3b call sites.
    assert.match(js, /registryVersion:\s*novaToolRegistryVersion/);
    assert.match(js, /inFlight:\s*novaTurnInFlight/);
});

test('turn-state bindings live inside the NOVA AGENT section, above initNovaOnce', async () => {
    const js = await loadIndex();
    const novaSectionIdx = js.indexOf('NOVA AGENT — module-level turn state');
    const initNovaOnceIdx = js.indexOf('function initNovaOnce(');
    const stateKeyIdx = js.indexOf("const NOVA_STATE_KEY = 'nova'");
    assert.ok(novaSectionIdx > 0, 'turn-state section comment must exist');
    assert.ok(stateKeyIdx > 0 && novaSectionIdx > stateKeyIdx,
        'turn state must come after NOVA_STATE_KEY (groups with other nova consts)');
    assert.ok(initNovaOnceIdx > novaSectionIdx,
        'initNovaOnce must come after turn-state declarations so the one-shot init can reference them in future phases');
});

// ---------------------------------------------------------------------------
// 2. Shape + snapshot-independence contract — mirrored mini closure.
//
// We cannot import index.js in a Node-only harness (no st-context shim), so
// this block reproduces _getNovaTurnState semantics against closure-backed
// `let` bindings. Update this mirror when the production helper changes.
// ---------------------------------------------------------------------------

function makeTurnStateCapsule() {
    let novaTurnInFlight = false;
    let novaAbortController = null;
    let novaToolRegistryVersion = 0;

    return {
        setInFlight(v) { novaTurnInFlight = !!v; },
        setAbort(ac) { novaAbortController = ac; },
        bumpRegistry() { novaToolRegistryVersion += 1; },
        snapshot() {
            return {
                inFlight: novaTurnInFlight,
                hasAbort: novaAbortController !== null,
                registryVersion: novaToolRegistryVersion,
            };
        },
    };
}

describe('_getNovaTurnState snapshot contract', () => {
    it('returns the documented initial shape on a cold module', () => {
        const cap = makeTurnStateCapsule();
        assert.deepEqual(cap.snapshot(), {
            inFlight: false,
            hasAbort: false,
            registryVersion: 0,
        });
    });

    it('reflects mutations in subsequent snapshots', () => {
        const cap = makeTurnStateCapsule();
        cap.setInFlight(true);
        cap.setAbort(new AbortController());
        cap.bumpRegistry();
        cap.bumpRegistry();
        assert.deepEqual(cap.snapshot(), {
            inFlight: true,
            hasAbort: true,
            registryVersion: 2,
        });
    });

    it('returns a fresh object each call (snapshots are not aliased)', () => {
        const cap = makeTurnStateCapsule();
        const a = cap.snapshot();
        cap.setInFlight(true);
        const b = cap.snapshot();
        assert.notEqual(a, b);
        assert.equal(a.inFlight, false, 'prior snapshot must not see later mutation');
        assert.equal(b.inFlight, true);
    });

    it('mutating a snapshot does not affect internal state', () => {
        const cap = makeTurnStateCapsule();
        const snap = cap.snapshot();
        snap.inFlight = true;
        snap.registryVersion = 999;
        snap.hasAbort = true;
        // Next fresh snapshot must still report the real state.
        assert.deepEqual(cap.snapshot(), {
            inFlight: false,
            hasAbort: false,
            registryVersion: 0,
        });
    });

    it('hasAbort is a boolean, never an AbortController reference', () => {
        const cap = makeTurnStateCapsule();
        const ac = new AbortController();
        cap.setAbort(ac);
        const snap = cap.snapshot();
        assert.equal(typeof snap.hasAbort, 'boolean');
        assert.equal(snap.hasAbort, true);
        // Verify there is no other field leaking the reference.
        for (const v of Object.values(snap)) {
            assert.notEqual(v, ac);
        }
    });

    it('setAbort(null) flips hasAbort back to false', () => {
        const cap = makeTurnStateCapsule();
        cap.setAbort(new AbortController());
        assert.equal(cap.snapshot().hasAbort, true);
        cap.setAbort(null);
        assert.equal(cap.snapshot().hasAbort, false);
    });
});
