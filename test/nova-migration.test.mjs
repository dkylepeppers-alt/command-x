/**
 * Unit tests for Nova legacy OpenClaw metadata migration (plan §1f / §10).
 * Run with: node --test test/nova-migration.test.mjs
 *
 * Mirrors `migrateLegacyOpenClawMetadata` in index.js under the
 * `/* === NOVA AGENT === *\/` section. Inline-copy convention per
 * AGENT_MEMORY — update this copy when the production helper changes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const EXT = 'command_x';

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

function makeCtx({ extBlob, hasMetadata = true } = {}) {
    let saveCalls = 0;
    const ctx = {
        saveMetadataDebounced: () => { saveCalls++; },
        get __saves() { return saveCalls; },
    };
    if (hasMetadata) {
        ctx.chatMetadata = {};
        if (extBlob !== undefined) ctx.chatMetadata[EXT] = extBlob;
    }
    return ctx;
}

describe('migrateLegacyOpenClawMetadata', () => {
    it('returns no-metadata when ctx has no chatMetadata', () => {
        const ctx = makeCtx({ hasMetadata: false });
        const r = migrateLegacyOpenClawMetadata(ctx);
        assert.deepEqual(r, { migrated: false, reason: 'no-metadata' });
        assert.equal(ctx.__saves, 0);
    });

    it('returns no-metadata when ctx.chatMetadata[EXT] is missing', () => {
        const ctx = makeCtx({ extBlob: undefined });
        const r = migrateLegacyOpenClawMetadata(ctx);
        assert.deepEqual(r, { migrated: false, reason: 'no-metadata' });
        assert.equal(ctx.__saves, 0);
    });

    it('returns no-metadata when ctx.chatMetadata[EXT] is not an object', () => {
        const ctx = makeCtx({ extBlob: 'not-an-object' });
        const r = migrateLegacyOpenClawMetadata(ctx);
        assert.equal(r.reason, 'no-metadata');
        assert.equal(ctx.__saves, 0);
    });

    it('returns no-legacy-key when extBlob has no openclaw key', () => {
        const ctx = makeCtx({ extBlob: { nova: { sessions: [] } } });
        const r = migrateLegacyOpenClawMetadata(ctx);
        assert.deepEqual(r, { migrated: false, reason: 'no-legacy-key' });
        assert.equal(ctx.__saves, 0);
    });

    it('moves openclaw → legacy_openclaw when only legacy key is present', () => {
        const payload = { mode: 'observe', log: ['hi'] };
        const ctx = makeCtx({ extBlob: { openclaw: payload } });
        const r = migrateLegacyOpenClawMetadata(ctx);
        assert.deepEqual(r, { migrated: true, reason: 'moved' });
        const root = ctx.chatMetadata[EXT];
        assert.equal('openclaw' in root, false);
        assert.equal(root.legacy_openclaw, payload); // reference moved, not cloned
        assert.equal(ctx.__saves, 1);
    });

    it('does not overwrite an existing legacy_openclaw but drops the raw legacy key', () => {
        const preserved = { from: 'earlier-session' };
        const stale = { from: 'should-be-discarded' };
        const ctx = makeCtx({ extBlob: { openclaw: stale, legacy_openclaw: preserved } });
        const r = migrateLegacyOpenClawMetadata(ctx);
        assert.deepEqual(r, { migrated: false, reason: 'already-migrated' });
        const root = ctx.chatMetadata[EXT];
        assert.equal('openclaw' in root, false);
        assert.equal(root.legacy_openclaw, preserved);
        assert.equal(ctx.__saves, 1);
    });

    it('is idempotent: second call after a successful move is a noop', () => {
        const ctx = makeCtx({ extBlob: { openclaw: { any: 'thing' } } });
        const first = migrateLegacyOpenClawMetadata(ctx);
        assert.equal(first.migrated, true);
        const second = migrateLegacyOpenClawMetadata(ctx);
        assert.deepEqual(second, { migrated: false, reason: 'no-legacy-key' });
        assert.equal(ctx.__saves, 1); // only the first call saved
    });

    it('preserves sibling keys (e.g. nova state) untouched', () => {
        const nova = { sessions: [{ id: 'abc' }], activeSessionId: 'abc', auditLog: [] };
        const ctx = makeCtx({ extBlob: { openclaw: { x: 1 }, nova } });
        migrateLegacyOpenClawMetadata(ctx);
        assert.equal(ctx.chatMetadata[EXT].nova, nova);
        assert.deepEqual(ctx.chatMetadata[EXT].nova.sessions[0], { id: 'abc' });
    });

    it('tolerates falsy openclaw value (null still counts as present)', () => {
        // "openclaw in root" is the gate — null is a legit "migrate" signal.
        const ctx = makeCtx({ extBlob: { openclaw: null } });
        const r = migrateLegacyOpenClawMetadata(ctx);
        assert.equal(r.migrated, true);
        assert.equal(ctx.chatMetadata[EXT].legacy_openclaw, null);
        assert.equal('openclaw' in ctx.chatMetadata[EXT], false);
    });

    it('does not throw when ctx.saveMetadataDebounced is absent', () => {
        const ctx = { chatMetadata: { [EXT]: { openclaw: { x: 1 } } } };
        const r = migrateLegacyOpenClawMetadata(ctx);
        assert.equal(r.migrated, true);
        // Ensure the raw legacy key is gone even without save().
        assert.equal('openclaw' in ctx.chatMetadata[EXT], false);
        assert.equal(ctx.chatMetadata[EXT].legacy_openclaw.x, 1);
    });
});
