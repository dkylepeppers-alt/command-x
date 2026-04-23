/**
 * Unit tests for Nova one-shot per-chat init (plan §1f).
 * Run with: node --test test/nova-init-once.test.mjs
 *
 * Mirrors `initNovaOnce` + `migrateLegacyOpenClawMetadata` + `getNovaState`
 * in index.js under the `/* === NOVA AGENT === *\/` section. Inline-copy
 * convention per AGENT_MEMORY — update this copy when the production
 * helpers change.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const EXT = 'command_x';
const NOVA_STATE_KEY = 'nova';
const NOVA_INIT_VERSION = 1;

function createEmptyNovaState() {
    return { sessions: [], activeSessionId: null, auditLog: [] };
}

function getNovaState(ctx) {
    const root = ctx?.chatMetadata?.[EXT];
    if (!root) return createEmptyNovaState();
    if (!root[NOVA_STATE_KEY] || typeof root[NOVA_STATE_KEY] !== 'object') {
        root[NOVA_STATE_KEY] = createEmptyNovaState();
    }
    const state = root[NOVA_STATE_KEY];
    if (!Array.isArray(state.sessions)) state.sessions = [];
    if (!Array.isArray(state.auditLog)) state.auditLog = [];
    if (!('activeSessionId' in state)) state.activeSessionId = null;
    return state;
}

function migrateLegacyOpenClawMetadata(ctx) {
    const root = ctx?.chatMetadata?.[EXT];
    if (!root || typeof root !== 'object') {
        return { migrated: false, reason: 'no-metadata' };
    }
    if (!('openclaw' in root)) {
        return { migrated: false, reason: 'no-legacy-key' };
    }
    if ('legacy_openclaw' in root) {
        delete root.openclaw;
        if (ctx?.saveMetadataDebounced) ctx.saveMetadataDebounced();
        return { migrated: false, reason: 'already-migrated' };
    }
    root.legacy_openclaw = root.openclaw;
    delete root.openclaw;
    if (ctx?.saveMetadataDebounced) ctx.saveMetadataDebounced();
    return { migrated: true, reason: 'moved' };
}

function initNovaOnce(ctx) {
    const root = ctx?.chatMetadata?.[EXT];
    if (!root || typeof root !== 'object') {
        return { ran: false, reason: 'no-metadata' };
    }
    const state = getNovaState(ctx);
    const stampedVersion = Number(state?._initVersion) || 0;
    if (stampedVersion >= NOVA_INIT_VERSION) {
        return { ran: false, reason: 'already-initialised', version: stampedVersion };
    }
    let migration;
    try {
        migration = migrateLegacyOpenClawMetadata(ctx);
    } catch (err) {
        return { ran: false, reason: 'migration-error', error: String(err?.message || err) };
    }
    state._initVersion = NOVA_INIT_VERSION;
    if (ctx?.saveMetadataDebounced) ctx.saveMetadataDebounced();
    return { ran: true, reason: 'initialised', version: NOVA_INIT_VERSION, migration };
}

// --- Test helpers ---

function makeCtx({ extBlob, hasMetadata = true, migrateThrows = false } = {}) {
    let saves = 0;
    const ctx = {
        saveMetadataDebounced: () => { saves++; },
        get __saves() { return saves; },
    };
    if (hasMetadata) {
        ctx.chatMetadata = {};
        if (extBlob !== undefined) ctx.chatMetadata[EXT] = extBlob;
    }
    if (migrateThrows) {
        // Wrap getter on `openclaw` to throw when migration reads it.
        // Keep `in` check passing but reads blow up.
        Object.defineProperty(ctx.chatMetadata[EXT], 'openclaw', {
            configurable: true,
            enumerable: true,
            get() { throw new Error('boom'); },
        });
    }
    return ctx;
}

// --- Tests ---

describe('initNovaOnce', () => {
    it('returns no-metadata when ctx has no chatMetadata', () => {
        const ctx = makeCtx({ hasMetadata: false });
        const r = initNovaOnce(ctx);
        assert.deepEqual(r, { ran: false, reason: 'no-metadata' });
        assert.equal(ctx.__saves, 0);
    });

    it('returns no-metadata when chatMetadata[EXT] missing', () => {
        const ctx = makeCtx({});
        const r = initNovaOnce(ctx);
        assert.equal(r.ran, false);
        assert.equal(r.reason, 'no-metadata');
    });

    it('runs migration and stamps _initVersion on first call (no legacy key)', () => {
        const ctx = makeCtx({ extBlob: {} });
        const r = initNovaOnce(ctx);
        assert.equal(r.ran, true);
        assert.equal(r.reason, 'initialised');
        assert.equal(r.version, NOVA_INIT_VERSION);
        assert.equal(r.migration.reason, 'no-legacy-key');
        const state = ctx.chatMetadata[EXT].nova;
        assert.equal(state._initVersion, NOVA_INIT_VERSION);
        assert.deepEqual(state.sessions, []);
        assert.deepEqual(state.auditLog, []);
        assert.equal(state.activeSessionId, null);
        // saveMetadataDebounced should have been called at least once.
        assert.ok(ctx.__saves >= 1);
    });

    it('migrates a legacy OpenClaw blob and stamps in one pass', () => {
        const ctx = makeCtx({ extBlob: { openclaw: { mode: 'operate', data: { x: 1 } } } });
        const r = initNovaOnce(ctx);
        assert.equal(r.ran, true);
        assert.equal(r.migration.migrated, true);
        assert.equal(r.migration.reason, 'moved');
        const root = ctx.chatMetadata[EXT];
        assert.equal('openclaw' in root, false);
        assert.deepEqual(root.legacy_openclaw, { mode: 'operate', data: { x: 1 } });
        assert.equal(root.nova._initVersion, NOVA_INIT_VERSION);
    });

    it('is idempotent: the second call is already-initialised', () => {
        const ctx = makeCtx({ extBlob: { openclaw: { mode: 'operate' } } });
        const first = initNovaOnce(ctx);
        assert.equal(first.ran, true);
        const savesAfterFirst = ctx.__saves;
        const second = initNovaOnce(ctx);
        assert.equal(second.ran, false);
        assert.equal(second.reason, 'already-initialised');
        assert.equal(second.version, NOVA_INIT_VERSION);
        // Second call must not save.
        assert.equal(ctx.__saves, savesAfterFirst);
    });

    it('short-circuits when _initVersion is already >= current version', () => {
        const ctx = makeCtx({ extBlob: {
            openclaw: { stale: true }, // still present but we should NOT migrate
            nova: { sessions: [], activeSessionId: null, auditLog: [], _initVersion: 99 },
        } });
        const r = initNovaOnce(ctx);
        assert.equal(r.ran, false);
        assert.equal(r.reason, 'already-initialised');
        assert.equal(r.version, 99);
        // No save, and legacy key untouched (future version bumps would clean it up).
        assert.equal(ctx.__saves, 0);
        assert.equal('openclaw' in ctx.chatMetadata[EXT], true);
    });

    it('re-runs when _initVersion is lower than current (forward migration)', () => {
        // Simulate a chat stamped at version 0 (e.g. we bumped NOVA_INIT_VERSION
        // in a later release and want existing chats to re-migrate exactly once).
        const ctx = makeCtx({ extBlob: {
            openclaw: { mode: 'operate' },
            nova: { sessions: [], activeSessionId: null, auditLog: [], _initVersion: 0 },
        } });
        const r = initNovaOnce(ctx);
        assert.equal(r.ran, true);
        assert.equal(r.migration.migrated, true);
        assert.equal(ctx.chatMetadata[EXT].nova._initVersion, NOVA_INIT_VERSION);
    });

    it('handles legacy + already-migrated: drops raw openclaw, still stamps', () => {
        // Legacy key present AND legacy_openclaw already preserved (from an
        // earlier session before initNovaOnce existed).
        const ctx = makeCtx({ extBlob: {
            openclaw: { mode: 'stale' },
            legacy_openclaw: { mode: 'operate' }, // previously preserved
        } });
        const r = initNovaOnce(ctx);
        assert.equal(r.ran, true);
        assert.equal(r.migration.migrated, false);
        assert.equal(r.migration.reason, 'already-migrated');
        assert.equal('openclaw' in ctx.chatMetadata[EXT], false);
        // Prior preserved copy must not be overwritten.
        assert.deepEqual(ctx.chatMetadata[EXT].legacy_openclaw, { mode: 'operate' });
        assert.equal(ctx.chatMetadata[EXT].nova._initVersion, NOVA_INIT_VERSION);
    });

    it('heals malformed nova blob when stamping', () => {
        // Pre-existing non-object nova field should be replaced with a fresh
        // empty state, then stamped. Exercises getNovaState's healing path.
        const ctx = makeCtx({ extBlob: { nova: 'not-an-object' } });
        const r = initNovaOnce(ctx);
        assert.equal(r.ran, true);
        const state = ctx.chatMetadata[EXT].nova;
        assert.equal(typeof state, 'object');
        assert.deepEqual(state.sessions, []);
        assert.equal(state._initVersion, NOVA_INIT_VERSION);
    });

    it('does not stamp when the migration throws (retries next load)', () => {
        const ctx = makeCtx({
            extBlob: { openclaw: { mode: 'operate' } },
            migrateThrows: true,
        });
        const r = initNovaOnce(ctx);
        assert.equal(r.ran, false);
        assert.equal(r.reason, 'migration-error');
        assert.ok(r.error.includes('boom'));
        // The nova blob was lazily created by getNovaState, but must NOT carry
        // _initVersion since migration failed.
        assert.equal('_initVersion' in (ctx.chatMetadata[EXT].nova || {}), false);
    });

    it('calls saveMetadataDebounced exactly once on a first-run no-legacy chat', () => {
        const ctx = makeCtx({ extBlob: {} });
        initNovaOnce(ctx);
        // migrate is a noop (no save), stamp saves once.
        assert.equal(ctx.__saves, 1);
    });

    it('calls saveMetadataDebounced twice when migration also saves (legacy present)', () => {
        const ctx = makeCtx({ extBlob: { openclaw: { mode: 'operate' } } });
        initNovaOnce(ctx);
        // migrate saves once (moved the blob), stamp saves once.
        assert.equal(ctx.__saves, 2);
    });
});
