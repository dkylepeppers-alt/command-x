/**
 * Unit tests for Nova connection-profile resolution helpers.
 * Run with: node --test test/nova-profile-resolve.test.mjs
 *
 * Covers:
 *   - resolveNovaConnectionProfileId  — exact, compact, and fuzzy matching
 *   - doesNovaProfileExist            — existence check + abort/alert path logic
 *
 * Inline-copy convention per AGENT_MEMORY.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// -------- Inline copy of production helpers --------

function resolveNovaConnectionProfileId(ctx, profileName) {
    const wanted = String(profileName || '').trim();
    if (!wanted) return '';
    const profiles = ctx?.extensionSettings?.connectionManager?.profiles;
    if (!Array.isArray(profiles)) return wanted;
    const norm = (s) => String(s || '').trim().toLowerCase();
    const wantedNorm = norm(wanted);
    const wantedCompact = wantedNorm.replace(/[\s_-]+/g, '');
    // Exact id/name match first.
    let hit = profiles.find(p => p && (norm(p.id) === wantedNorm || norm(p.name) === wantedNorm));
    // Fuzzy fallback: tolerate minor profile-name variations like
    // "Command X", "command-x", or "... profile/preset".
    if (!hit) {
        hit = profiles.find((p) => {
            const idN = norm(p?.id);
            const nameN = norm(p?.name);
            const idC = idN.replace(/[\s_-]+/g, '');
            const nameC = nameN.replace(/[\s_-]+/g, '');
            return idC === wantedCompact
                || nameC === wantedCompact
                || idN.includes(wantedNorm)
                || nameN.includes(wantedNorm)
                || (idN && wantedNorm.includes(idN))
                || (nameN && wantedNorm.includes(nameN));
        });
    }
    return String(hit?.id || wanted);
}

function doesNovaProfileExist(ctx, profileName) {
    const wanted = String(profileName || '').trim();
    if (!wanted) return false;
    const profiles = ctx?.extensionSettings?.connectionManager?.profiles;
    if (!Array.isArray(profiles)) return true; // fail-open on unknown ST shape
    const resolved = resolveNovaConnectionProfileId(ctx, wanted);
    const norm = (s) => String(s || '').trim().toLowerCase();
    const resolvedNorm = norm(resolved);
    return profiles.some((p) => p && (norm(p.id) === resolvedNorm || norm(p.name) === resolvedNorm));
}

// -------- Test helpers --------

function makeCtx(profiles) {
    return { extensionSettings: { connectionManager: { profiles } } };
}

// -------- Tests --------

describe('resolveNovaConnectionProfileId', () => {
    it('returns empty string when profileName is empty', () => {
        const ctx = makeCtx([{ id: 'command-x', name: 'Command-X' }]);
        assert.equal(resolveNovaConnectionProfileId(ctx, ''), '');
        assert.equal(resolveNovaConnectionProfileId(ctx, null), '');
    });

    it('returns wanted as-is when profiles array is absent', () => {
        assert.equal(resolveNovaConnectionProfileId({}, 'Command-X'), 'Command-X');
        assert.equal(resolveNovaConnectionProfileId(null, 'Command-X'), 'Command-X');
    });

    it('returns wanted as-is when profiles array is non-array', () => {
        const ctx = { extensionSettings: { connectionManager: { profiles: null } } };
        assert.equal(resolveNovaConnectionProfileId(ctx, 'Command-X'), 'Command-X');
    });

    it('exact id match (case-insensitive)', () => {
        const ctx = makeCtx([{ id: 'command-x', name: 'Command-X' }]);
        assert.equal(resolveNovaConnectionProfileId(ctx, 'COMMAND-X'), 'command-x');
    });

    it('exact name match (case-insensitive)', () => {
        const ctx = makeCtx([{ id: 'cx-profile', name: 'Command-X' }]);
        assert.equal(resolveNovaConnectionProfileId(ctx, 'command-x'), 'cx-profile');
    });

    it('compact match: "Command X" (space) resolves to "Command-X" (hyphen) profile', () => {
        const ctx = makeCtx([{ id: 'command-x', name: 'Command-X' }]);
        assert.equal(resolveNovaConnectionProfileId(ctx, 'Command X'), 'command-x');
    });

    it('compact match: "CommandX" resolves to "Command-X" profile', () => {
        const ctx = makeCtx([{ id: 'command-x', name: 'Command-X' }]);
        assert.equal(resolveNovaConnectionProfileId(ctx, 'CommandX'), 'command-x');
    });

    it('compact match: "Command_X" resolves to "Command-X" profile', () => {
        const ctx = makeCtx([{ id: 'command-x', name: 'Command-X' }]);
        assert.equal(resolveNovaConnectionProfileId(ctx, 'Command_X'), 'command-x');
    });

    it('substring match: wanted includes profile name', () => {
        const ctx = makeCtx([{ id: 'nova', name: 'nova' }]);
        // "nova profile" contains "nova"
        assert.equal(resolveNovaConnectionProfileId(ctx, 'nova profile'), 'nova');
    });

    it('substring match: profile name includes wanted', () => {
        const ctx = makeCtx([{ id: 'my-nova-profile', name: 'My Nova Profile' }]);
        // "nova" is contained within "my nova profile"
        assert.equal(resolveNovaConnectionProfileId(ctx, 'nova'), 'my-nova-profile');
    });

    it('does NOT match profiles with empty id/name via substring (empty-string guard)', () => {
        const ctx = makeCtx([
            { id: '', name: '' },
            { id: 'real-profile', name: 'Real Profile' },
        ]);
        // Should not match the empty-id profile
        const result = resolveNovaConnectionProfileId(ctx, 'Real Profile');
        assert.equal(result, 'real-profile');
    });

    it('undefined id/name does not cause false positive match', () => {
        const ctx = makeCtx([
            { id: undefined, name: undefined },
            { id: 'command-x', name: 'Command-X' },
        ]);
        // "command-x" should match the second entry, not the undefined one
        assert.equal(resolveNovaConnectionProfileId(ctx, 'command-x'), 'command-x');
    });

    it('returns wanted unchanged when no profile matches', () => {
        const ctx = makeCtx([{ id: 'alpha', name: 'Alpha' }]);
        assert.equal(resolveNovaConnectionProfileId(ctx, 'NonExistent'), 'NonExistent');
    });

    it('first exact match wins over later fuzzy match', () => {
        const ctx = makeCtx([
            { id: 'exact-match', name: 'Command-X' },
            { id: 'fuzzy-match', name: 'Command X Profile' },
        ]);
        // Exact name match on the first entry
        assert.equal(resolveNovaConnectionProfileId(ctx, 'command-x'), 'exact-match');
    });
});

describe('doesNovaProfileExist', () => {
    it('returns false for empty profile name', () => {
        const ctx = makeCtx([{ id: 'a', name: 'A' }]);
        assert.equal(doesNovaProfileExist(ctx, ''), false);
        assert.equal(doesNovaProfileExist(ctx, null), false);
    });

    it('returns true (fail-open) when profiles is not an array', () => {
        assert.equal(doesNovaProfileExist({}, 'Command-X'), true);
        assert.equal(doesNovaProfileExist(null, 'Command-X'), true);
    });

    it('returns true when exact profile exists', () => {
        const ctx = makeCtx([{ id: 'command-x', name: 'Command-X' }]);
        assert.equal(doesNovaProfileExist(ctx, 'Command-X'), true);
    });

    it('returns true when fuzzy match resolves to an existing profile', () => {
        const ctx = makeCtx([{ id: 'command-x', name: 'Command-X' }]);
        assert.equal(doesNovaProfileExist(ctx, 'Command X'), true);
        assert.equal(doesNovaProfileExist(ctx, 'command_x'), true);
        assert.equal(doesNovaProfileExist(ctx, 'CommandX'), true);
    });

    it('returns false when profile cannot be found (abort/alert path)', () => {
        const ctx = makeCtx([{ id: 'alpha', name: 'Alpha' }]);
        assert.equal(doesNovaProfileExist(ctx, 'Command-X'), false);
    });

    it('returns false for an empty profiles list', () => {
        const ctx = makeCtx([]);
        assert.equal(doesNovaProfileExist(ctx, 'Command-X'), false);
    });

    it('profiles with null/undefined id and name do not create false positives', () => {
        const ctx = makeCtx([
            { id: null, name: null },
            { id: undefined, name: undefined },
        ]);
        // "something" should not match null/undefined entries
        assert.equal(doesNovaProfileExist(ctx, 'something'), false);
    });

    it('case-insensitive match returns true', () => {
        const ctx = makeCtx([{ id: 'COMMAND-X', name: 'COMMAND-X' }]);
        assert.equal(doesNovaProfileExist(ctx, 'command-x'), true);
    });
});
