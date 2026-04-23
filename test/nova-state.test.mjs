/**
 * Unit tests for Nova per-chat state helpers (plan §3a).
 * Run with: node --test test/nova-state.test.mjs
 *
 * Mirrors the pure helpers in index.js under the
 * `/* === NOVA AGENT === *\/` section. Update in lockstep if the production
 * copies change.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const EXT = 'command_x';
const NOVA_STATE_KEY = 'nova';
const NOVA_SESSION_CAP = 20;
const NOVA_AUDIT_CAP = 500;

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

function createNovaSession(state, { skill, tier, profileName }) {
    const now = Date.now();
    const rand = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
        ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
        : (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function'
            ? Array.from(crypto.getRandomValues(new Uint8Array(6))).map(b => b.toString(16).padStart(2, '0')).join('')
            : Date.now().toString(36) + 'xxxxxx');
    const id = `nova-${now.toString(36)}-${rand}`;
    const session = {
        id,
        skill: String(skill || 'freeform'),
        tier: String(tier || 'read'),
        profileName: String(profileName || ''),
        messages: [],
        toolCalls: [],
        createdAt: now,
        updatedAt: now,
    };
    state.sessions.push(session);
    while (state.sessions.length > NOVA_SESSION_CAP) state.sessions.shift();
    state.activeSessionId = id;
    return session;
}

function appendNovaAuditLog(state, { tool, argsSummary, outcome }) {
    const entry = {
        ts: Date.now(),
        tool: String(tool || 'unknown'),
        argsSummary: String(argsSummary ?? ''),
        outcome: String(outcome ?? ''),
    };
    state.auditLog.push(entry);
    while (state.auditLog.length > NOVA_AUDIT_CAP) state.auditLog.shift();
    return entry;
}

describe('getNovaState', () => {
    it('returns an empty state when chatMetadata lacks the EXT root', () => {
        const state = getNovaState({ chatMetadata: {} });
        assert.deepEqual(state, { sessions: [], activeSessionId: null, auditLog: [] });
    });

    it('returns an empty state when ctx is missing entirely', () => {
        const state = getNovaState(undefined);
        assert.deepEqual(state, { sessions: [], activeSessionId: null, auditLog: [] });
    });

    it('lazily initialises the nova blob on first access', () => {
        const ctx = { chatMetadata: { [EXT]: {} } };
        const state = getNovaState(ctx);
        assert.equal(ctx.chatMetadata[EXT].nova, state);
        assert.deepEqual(state.sessions, []);
        assert.deepEqual(state.auditLog, []);
        assert.equal(state.activeSessionId, null);
    });

    it('heals legacy blobs missing individual fields', () => {
        const ctx = { chatMetadata: { [EXT]: { nova: { sessions: 'not-an-array' } } } };
        const state = getNovaState(ctx);
        assert.ok(Array.isArray(state.sessions));
        assert.ok(Array.isArray(state.auditLog));
        assert.equal(state.activeSessionId, null);
    });
});

describe('createNovaSession', () => {
    it('creates a well-formed session with defaults for unspecified fields', () => {
        const state = createEmptyNovaState();
        const session = createNovaSession(state, {});
        assert.equal(session.skill, 'freeform');
        assert.equal(session.tier, 'read');
        assert.equal(session.profileName, '');
        assert.deepEqual(session.messages, []);
        assert.deepEqual(session.toolCalls, []);
        assert.ok(typeof session.id === 'string' && session.id.startsWith('nova-'));
        assert.equal(state.activeSessionId, session.id);
        assert.equal(state.sessions.length, 1);
    });

    it('enforces the NOVA_SESSION_CAP by evicting the oldest session', () => {
        const state = createEmptyNovaState();
        for (let i = 0; i < NOVA_SESSION_CAP + 5; i++) {
            createNovaSession(state, { skill: `s${i}` });
        }
        assert.equal(state.sessions.length, NOVA_SESSION_CAP);
        // Oldest kept is s5 (since s0..s4 were evicted).
        assert.equal(state.sessions[0].skill, 's5');
        // Newest is s24.
        assert.equal(state.sessions[state.sessions.length - 1].skill, `s${NOVA_SESSION_CAP + 4}`);
    });

    it('always points activeSessionId at the most recently created session', () => {
        const state = createEmptyNovaState();
        const a = createNovaSession(state, { skill: 'a' });
        const b = createNovaSession(state, { skill: 'b' });
        assert.notEqual(a.id, b.id);
        assert.equal(state.activeSessionId, b.id);
    });
});

describe('appendNovaAuditLog', () => {
    it('appends entries with the documented shape', () => {
        const state = createEmptyNovaState();
        const entry = appendNovaAuditLog(state, { tool: 'fs_read', argsSummary: 'path=a.json', outcome: 'ok' });
        assert.equal(state.auditLog.length, 1);
        assert.equal(entry.tool, 'fs_read');
        assert.equal(entry.argsSummary, 'path=a.json');
        assert.equal(entry.outcome, 'ok');
        assert.ok(typeof entry.ts === 'number' && entry.ts > 0);
    });

    it('coerces missing fields to safe strings instead of undefined', () => {
        const state = createEmptyNovaState();
        const entry = appendNovaAuditLog(state, {});
        assert.equal(entry.tool, 'unknown');
        assert.equal(entry.argsSummary, '');
        assert.equal(entry.outcome, '');
    });

    it('enforces NOVA_AUDIT_CAP by evicting oldest entries', () => {
        const state = createEmptyNovaState();
        for (let i = 0; i < NOVA_AUDIT_CAP + 10; i++) {
            appendNovaAuditLog(state, { tool: `t${i}`, argsSummary: '', outcome: 'ok' });
        }
        assert.equal(state.auditLog.length, NOVA_AUDIT_CAP);
        assert.equal(state.auditLog[0].tool, 't10');
        assert.equal(state.auditLog[state.auditLog.length - 1].tool, `t${NOVA_AUDIT_CAP + 9}`);
    });
});
