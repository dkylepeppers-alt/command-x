/**
 * Behavioural tests for the Nova turn lifecycle (plan §3b).
 * Run with: node --test test/nova-turn.test.mjs
 *
 * Mirrors `sendNovaTurn` + its immediate helpers in `index.js` under the
 * `/* === NOVA AGENT === *\/` section. Inline-copy convention per
 * AGENT_MEMORY — update this copy in lockstep when the production
 * helpers change.
 *
 * Phase 3b ships the skeleton: re-entrancy guard, profile snapshot/swap/
 * restore inside try…finally, AbortController wiring, user/assistant
 * message push + save, wall-clock timeout, audit-log on failure paths.
 * Tool-call dispatch + streaming are deferred to Phase 3c.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Inline copies of production helpers.
// ---------------------------------------------------------------------------

const EXT = 'command-x';
const NOVA_STATE_KEY = 'nova';
const NOVA_SESSION_CAP = 20;
const NOVA_AUDIT_CAP = 500;
const NOVA_MEMORY_CHARS_CAP = 16 * 1024;
const NOVA_DEFAULT_MAX_TOOL_CALLS = 24;
const NOVA_DEFAULT_TURN_TIMEOUT_MS = 300_000;

const NOVA_BASE_PROMPT = [
    'You are Nova, an interactive SillyTavern assistant living inside the',
    'Command-X phone. Say what you are about to do in one short sentence,',
    'then call the appropriate tool. Prefer the smallest correct edit.',
    'Confirm destructive operations by letting the approval modal fire — do',
    'not try to route around it.',
].join('\n');
const NOVA_TOOL_CONTRACT = [
    'Tool-use contract:',
    '- Call one tool at a time. Wait for the result before calling the next.',
    '- If a tool errors, explain what went wrong and propose a recovery.',
    '- Stop calling tools once the user\'s request is satisfied — do not',
    '  loop for the sake of looping.',
    '- Never invent tool names; only call tools from the provided schema.',
].join('\n');

const NOVA_SKILLS_FIXTURE = [
    { id: 'freeform', label: 'Plain helper', defaultTier: 'read', defaultTools: 'all', systemPrompt: 'You are Nova in free-form helper mode.' },
    { id: 'character-creator', label: 'Character Creator', defaultTier: 'write', defaultTools: [], systemPrompt: 'You are the Character Creator skill.' },
];

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
function saveNovaState(ctx) {
    if (ctx?.saveMetadataDebounced) ctx.saveMetadataDebounced();
}
function createNovaSession(state, { skill, tier, profileName }) {
    const now = Date.now();
    const id = `nova-test-${now}-${state.sessions.length}`;
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
function composeNovaSystemPrompt({ basePrompt = '', skillPrompt = '', soul = '', memory = '', toolContract = '' } = {}) {
    const mem = String(memory || '');
    const truncated = mem.length > NOVA_MEMORY_CHARS_CAP;
    const memSlice = truncated
        ? '[…truncated head…]\n' + mem.slice(mem.length - NOVA_MEMORY_CHARS_CAP)
        : mem;
    const sections = [
        String(basePrompt || '').trim(),
        String(skillPrompt || '').trim(),
        '---', '# Soul', String(soul || '').trim(),
        '---', '# Memory', memSlice.trim(),
        '---', String(toolContract || '').trim(),
    ];
    return sections.filter(s => s.length > 0).join('\n');
}

function resolveNovaSkill(skillId, skills = NOVA_SKILLS_FIXTURE) {
    const id = String(skillId || 'freeform');
    return skills.find(s => s.id === id) || skills.find(s => s.id === 'freeform') || null;
}
function buildNovaRequestMessages({ systemPrompt, sessionMessages = [] }) {
    const out = [];
    if (systemPrompt) out.push({ role: 'system', content: String(systemPrompt) });
    for (const m of sessionMessages) {
        if (!m || typeof m !== 'object') continue;
        if (!m.role) continue;
        out.push({ role: String(m.role), content: String(m.content ?? '') });
    }
    return out;
}
function parseNovaProfilePipe(pipeValue) {
    if (pipeValue == null) return '';
    const s = String(pipeValue).trim();
    if (!s || s.toLowerCase() === 'none') return '';
    return s;
}
async function getActiveNovaProfile({ executeSlash }) {
    if (typeof executeSlash !== 'function') return '';
    try {
        const res = await executeSlash('/profile');
        return parseNovaProfilePipe(res && res.pipe);
    } catch (_) { return ''; }
}

// `sendNovaTurn` needs the module-level `novaTurnInFlight` /
// `novaAbortController` bindings, so we wrap it in a capsule closure
// that reproduces the module-level semantics exactly.
function makeTurnCapsule() {
    let novaTurnInFlight = false;
    let novaAbortController = null;
    let novaToolRegistryVersion = 0;

    async function sendNovaTurn({
        ctx,
        userText,
        skillId = 'freeform',
        profileName = '',
        soul = '',
        memory = '',
        maxToolCalls = NOVA_DEFAULT_MAX_TOOL_CALLS,
        turnTimeoutMs = NOVA_DEFAULT_TURN_TIMEOUT_MS,
        tools = [],
        sendRequest,
        executeSlash,
        isToolCallingSupported,
        nowImpl = Date.now,
    } = {}) {
        if (novaTurnInFlight) return { ok: false, reason: 'in-flight' };

        const text = String(userText ?? '').trim();
        if (!text) return { ok: false, reason: 'empty-text' };
        if (typeof sendRequest !== 'function') return { ok: false, reason: 'no-send-request' };
        if (typeof isToolCallingSupported === 'function' && !isToolCallingSupported()) {
            return { ok: false, reason: 'no-tool-calling' };
        }
        const targetProfile = String(profileName || '').trim();
        if (!targetProfile) return { ok: false, reason: 'no-profile' };
        const skill = resolveNovaSkill(skillId);
        if (!skill) return { ok: false, reason: 'no-skill' };

        const state = getNovaState(ctx);
        let session = state.sessions.find(s => s && s.id === state.activeSessionId);
        if (!session) {
            session = createNovaSession(state, {
                skill: skill.id,
                tier: skill.defaultTier || 'read',
                profileName: targetProfile,
            });
        }

        const turnStartedAt = nowImpl();
        session.messages.push({ role: 'user', content: text, ts: turnStartedAt });
        session.updatedAt = turnStartedAt;
        saveNovaState(ctx);

        let timeoutHandle;
        const controller = new AbortController();
        novaAbortController = controller;
        novaTurnInFlight = true;
        if (turnTimeoutMs > 0 && turnTimeoutMs < Infinity) {
            timeoutHandle = setTimeout(() => {
                try { controller.abort(new Error('turn-timeout')); } catch (_) { /* noop */ }
            }, turnTimeoutMs);
        }

        let swappedFrom = '';
        let swapPerformed = false;

        try {
            if (typeof executeSlash === 'function') {
                swappedFrom = await getActiveNovaProfile({ executeSlash });
                if (swappedFrom !== targetProfile) {
                    try {
                        await executeSlash(`/profile ${targetProfile}`);
                        swapPerformed = true;
                    } catch (err) {
                        appendNovaAuditLog(state, {
                            tool: 'profile-swap',
                            argsSummary: `to=${targetProfile}`,
                            outcome: `error:${String(err?.message || err)}`,
                        });
                        saveNovaState(ctx);
                        return { ok: false, reason: 'profile-swap-failed', error: String(err?.message || err) };
                    }
                }
            }

            const systemPrompt = composeNovaSystemPrompt({
                basePrompt: NOVA_BASE_PROMPT,
                skillPrompt: skill.systemPrompt || '',
                soul, memory, toolContract: NOVA_TOOL_CONTRACT,
            });
            const messages = buildNovaRequestMessages({ systemPrompt, sessionMessages: session.messages });

            let response;
            try {
                response = await sendRequest({
                    messages,
                    tools: Array.isArray(tools) ? tools : [],
                    tool_choice: 'auto',
                    signal: controller.signal,
                });
            } catch (err) {
                const aborted = controller.signal?.aborted || err?.name === 'AbortError';
                const reason = aborted ? 'aborted' : 'send-failed';
                appendNovaAuditLog(state, {
                    tool: 'send-request',
                    argsSummary: `skill=${skill.id} profile=${targetProfile} msgs=${messages.length}`,
                    outcome: `${reason}:${String(err?.message || err)}`,
                });
                saveNovaState(ctx);
                return { ok: false, reason, error: String(err?.message || err) };
            }

            const assistantContent = String(response?.content ?? '');
            const toolCalls = Array.isArray(response?.tool_calls) ? response.tool_calls : [];
            const assistantMessage = { role: 'assistant', content: assistantContent, ts: nowImpl() };
            if (toolCalls.length > 0) {
                assistantMessage.tool_calls = toolCalls;
                appendNovaAuditLog(state, {
                    tool: 'tool-calls',
                    argsSummary: `count=${toolCalls.length} cap=${maxToolCalls}`,
                    outcome: 'deferred-to-phase-3c',
                });
            }
            session.messages.push(assistantMessage);
            session.updatedAt = assistantMessage.ts;
            saveNovaState(ctx);

            return {
                ok: true,
                assistantMessage,
                toolCalls,
                toolCallsDeferred: toolCalls.length > 0,
                swappedProfile: swapPerformed ? { from: swappedFrom, to: targetProfile } : null,
            };
        } finally {
            if (timeoutHandle !== undefined) {
                try { clearTimeout(timeoutHandle); } catch (_) { /* noop */ }
            }
            if (swapPerformed && typeof executeSlash === 'function') {
                try {
                    if (swappedFrom) await executeSlash(`/profile ${swappedFrom}`);
                } catch (err) {
                    appendNovaAuditLog(state, {
                        tool: 'profile-restore',
                        argsSummary: `to=${swappedFrom}`,
                        outcome: `error:${String(err?.message || err)}`,
                    });
                    saveNovaState(ctx);
                }
            }
            novaTurnInFlight = false;
            novaAbortController = null;
        }
    }

    return {
        sendNovaTurn,
        snapshot() {
            return {
                inFlight: novaTurnInFlight,
                hasAbort: novaAbortController !== null,
                registryVersion: novaToolRegistryVersion,
            };
        },
    };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeCtx() {
    let saves = 0;
    return {
        chatMetadata: { [EXT]: {} },
        saveMetadataDebounced: () => { saves++; },
        _getSaves: () => saves,
    };
}

function makeSlashMock({ initialProfile = 'old-profile', failSwap = false, failRestore = false } = {}) {
    const calls = [];
    let current = initialProfile;
    const exec = async (cmd) => {
        calls.push(cmd);
        const m = cmd.match(/^\/profile(?:\s+(.+))?$/);
        if (m) {
            if (!m[1]) return { pipe: current };
            const target = m[1].trim();
            // Restore of the original profile fails when failRestore is set
            // and we're moving back (target matches initialProfile after a swap).
            if (failRestore && target === initialProfile && current !== initialProfile) {
                throw new Error('restore-failed');
            }
            if (failSwap && target !== initialProfile) {
                throw new Error('swap-failed');
            }
            current = target;
            return { pipe: current };
        }
        return { pipe: '' };
    };
    return { exec, calls, getCurrent: () => current };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sendNovaTurn — precondition validation', () => {
    it('rejects empty text', async () => {
        const { sendNovaTurn } = makeTurnCapsule();
        const res = await sendNovaTurn({ ctx: makeCtx(), userText: '   ', sendRequest: async () => ({ content: 'x' }), profileName: 'p' });
        assert.deepEqual(res, { ok: false, reason: 'empty-text' });
    });

    it('rejects when sendRequest is not a function', async () => {
        const { sendNovaTurn } = makeTurnCapsule();
        const res = await sendNovaTurn({ ctx: makeCtx(), userText: 'hi', profileName: 'p' });
        assert.deepEqual(res, { ok: false, reason: 'no-send-request' });
    });

    it('rejects when isToolCallingSupported returns false', async () => {
        const { sendNovaTurn } = makeTurnCapsule();
        const res = await sendNovaTurn({
            ctx: makeCtx(), userText: 'hi', profileName: 'p',
            sendRequest: async () => ({ content: 'x' }),
            isToolCallingSupported: () => false,
        });
        assert.deepEqual(res, { ok: false, reason: 'no-tool-calling' });
    });

    it('rejects when profileName is blank', async () => {
        const { sendNovaTurn } = makeTurnCapsule();
        const res = await sendNovaTurn({
            ctx: makeCtx(), userText: 'hi', sendRequest: async () => ({ content: 'x' }),
        });
        assert.deepEqual(res, { ok: false, reason: 'no-profile' });
    });
});

describe('sendNovaTurn — happy path', () => {
    it('pushes user + assistant messages and persists', async () => {
        const { sendNovaTurn, snapshot } = makeTurnCapsule();
        const ctx = makeCtx();
        const res = await sendNovaTurn({
            ctx, userText: 'hello', profileName: 'nova-profile',
            sendRequest: async () => ({ content: 'hi back' }),
        });
        assert.equal(res.ok, true);
        assert.equal(res.assistantMessage.content, 'hi back');
        assert.equal(res.toolCallsDeferred, false);
        const state = getNovaState(ctx);
        const session = state.sessions[state.sessions.length - 1];
        assert.equal(session.messages.length, 2);
        assert.equal(session.messages[0].role, 'user');
        assert.equal(session.messages[0].content, 'hello');
        assert.equal(session.messages[1].role, 'assistant');
        assert.equal(session.messages[1].content, 'hi back');
        // save was called for user push + assistant push ≥ 2
        assert.ok(ctx._getSaves() >= 2);
        // turn state clean
        assert.deepEqual(snapshot(), { inFlight: false, hasAbort: false, registryVersion: 0 });
    });

    it('composes system prompt with base + skill + soul + memory + tool contract', async () => {
        const { sendNovaTurn } = makeTurnCapsule();
        const ctx = makeCtx();
        let captured = null;
        await sendNovaTurn({
            ctx, userText: 'hi', profileName: 'p', skillId: 'character-creator',
            soul: 'SOUL-BLOB', memory: 'MEM-BLOB',
            sendRequest: async ({ messages }) => { captured = messages; return { content: 'ok' }; },
        });
        assert.ok(captured);
        assert.equal(captured[0].role, 'system');
        const sys = captured[0].content;
        assert.ok(sys.includes('You are Nova'));
        assert.ok(sys.includes('Character Creator skill'));
        assert.ok(sys.includes('SOUL-BLOB'));
        assert.ok(sys.includes('MEM-BLOB'));
        assert.ok(sys.includes('Tool-use contract:'));
    });

    it('forwards the abort signal to sendRequest', async () => {
        const { sendNovaTurn } = makeTurnCapsule();
        let seenSignal = null;
        await sendNovaTurn({
            ctx: makeCtx(), userText: 'hi', profileName: 'p',
            sendRequest: async ({ signal }) => { seenSignal = signal; return { content: 'ok' }; },
        });
        assert.ok(seenSignal instanceof AbortSignal);
        assert.equal(seenSignal.aborted, false);
    });
});

describe('sendNovaTurn — profile snapshot / swap / restore', () => {
    it('snapshots, swaps to target, then restores in finally', async () => {
        const { sendNovaTurn } = makeTurnCapsule();
        const slash = makeSlashMock({ initialProfile: 'user-profile' });
        const res = await sendNovaTurn({
            ctx: makeCtx(), userText: 'hi', profileName: 'nova-profile',
            sendRequest: async () => ({ content: 'ok' }),
            executeSlash: slash.exec,
        });
        assert.equal(res.ok, true);
        assert.deepEqual(res.swappedProfile, { from: 'user-profile', to: 'nova-profile' });
        // Expected sequence: query → swap to nova → swap back to user
        assert.deepEqual(slash.calls, ['/profile', '/profile nova-profile', '/profile user-profile']);
        assert.equal(slash.getCurrent(), 'user-profile');
    });

    it('skips swap when already on target profile', async () => {
        const { sendNovaTurn } = makeTurnCapsule();
        const slash = makeSlashMock({ initialProfile: 'nova-profile' });
        const res = await sendNovaTurn({
            ctx: makeCtx(), userText: 'hi', profileName: 'nova-profile',
            sendRequest: async () => ({ content: 'ok' }),
            executeSlash: slash.exec,
        });
        assert.equal(res.ok, true);
        assert.equal(res.swappedProfile, null);
        // Only the snapshot query should have fired.
        assert.deepEqual(slash.calls, ['/profile']);
    });

    it('restores profile even when sendRequest throws', async () => {
        const { sendNovaTurn, snapshot } = makeTurnCapsule();
        const slash = makeSlashMock({ initialProfile: 'user-profile' });
        const ctx = makeCtx();
        const res = await sendNovaTurn({
            ctx, userText: 'hi', profileName: 'nova-profile',
            sendRequest: async () => { throw new Error('boom'); },
            executeSlash: slash.exec,
        });
        assert.equal(res.ok, false);
        assert.equal(res.reason, 'send-failed');
        assert.equal(res.error, 'boom');
        // Profile must be back to user-profile.
        assert.equal(slash.getCurrent(), 'user-profile');
        // Restore call must have fired.
        assert.ok(slash.calls.includes('/profile user-profile'));
        // Turn state fully cleared.
        assert.deepEqual(snapshot(), { inFlight: false, hasAbort: false, registryVersion: 0 });
        // Audit log captured the failure.
        const state = getNovaState(ctx);
        assert.ok(state.auditLog.some(e => e.tool === 'send-request' && e.outcome.startsWith('send-failed:')));
    });

    it('bails with profile-swap-failed and does NOT attempt restore when swap fails', async () => {
        const { sendNovaTurn, snapshot } = makeTurnCapsule();
        const slash = makeSlashMock({ initialProfile: 'user-profile', failSwap: true });
        const ctx = makeCtx();
        const res = await sendNovaTurn({
            ctx, userText: 'hi', profileName: 'nova-profile',
            sendRequest: async () => ({ content: 'ok' }),
            executeSlash: slash.exec,
        });
        assert.equal(res.ok, false);
        assert.equal(res.reason, 'profile-swap-failed');
        // Only snapshot + failed swap attempt — no restore because no swap was performed.
        assert.deepEqual(slash.calls, ['/profile', '/profile nova-profile']);
        assert.deepEqual(snapshot(), { inFlight: false, hasAbort: false, registryVersion: 0 });
        // Audit log recorded the swap failure.
        const state = getNovaState(ctx);
        assert.ok(state.auditLog.some(e => e.tool === 'profile-swap' && e.outcome.startsWith('error:')));
    });

    it('logs (and swallows) a restore failure rather than masking the happy-path result', async () => {
        const { sendNovaTurn } = makeTurnCapsule();
        const slash = makeSlashMock({ initialProfile: 'user-profile', failRestore: true });
        const ctx = makeCtx();
        const res = await sendNovaTurn({
            ctx, userText: 'hi', profileName: 'nova-profile',
            sendRequest: async () => ({ content: 'ok' }),
            executeSlash: slash.exec,
        });
        // Primary turn succeeded; restore failure lives only in the audit log.
        assert.equal(res.ok, true);
        const state = getNovaState(ctx);
        assert.ok(state.auditLog.some(e => e.tool === 'profile-restore' && e.outcome.startsWith('error:')));
    });
});

describe('sendNovaTurn — re-entrancy guard', () => {
    it('rejects a second concurrent call with in-flight', async () => {
        const { sendNovaTurn, snapshot } = makeTurnCapsule();
        let releaseFirst;
        const firstReq = new Promise(res => { releaseFirst = res; });
        const first = sendNovaTurn({
            ctx: makeCtx(), userText: 'one', profileName: 'p',
            sendRequest: async () => { await firstReq; return { content: 'first' }; },
        });
        // Wait a tick to ensure the first turn has set novaTurnInFlight.
        await new Promise(r => setImmediate(r));
        assert.equal(snapshot().inFlight, true);
        const second = await sendNovaTurn({
            ctx: makeCtx(), userText: 'two', profileName: 'p',
            sendRequest: async () => ({ content: 'second' }),
        });
        assert.deepEqual(second, { ok: false, reason: 'in-flight' });
        // Now unblock the first; it should settle cleanly.
        releaseFirst();
        const firstRes = await first;
        assert.equal(firstRes.ok, true);
        assert.deepEqual(snapshot(), { inFlight: false, hasAbort: false, registryVersion: 0 });
    });
});

describe('sendNovaTurn — deferred tool calls (Phase 3c placeholder)', () => {
    it('records an audit entry and returns toolCallsDeferred=true when sendRequest returns tool_calls', async () => {
        const { sendNovaTurn } = makeTurnCapsule();
        const ctx = makeCtx();
        const res = await sendNovaTurn({
            ctx, userText: 'list characters', profileName: 'p',
            sendRequest: async () => ({
                content: 'I will list characters.',
                tool_calls: [{ id: 't1', type: 'function', function: { name: 'st_list_characters', arguments: '{}' } }],
            }),
        });
        assert.equal(res.ok, true);
        assert.equal(res.toolCallsDeferred, true);
        assert.equal(res.toolCalls.length, 1);
        const state = getNovaState(ctx);
        assert.ok(state.auditLog.some(e => e.tool === 'tool-calls' && e.outcome === 'deferred-to-phase-3c'));
        const session = state.sessions[state.sessions.length - 1];
        assert.deepEqual(session.messages[session.messages.length - 1].tool_calls,
            [{ id: 't1', type: 'function', function: { name: 'st_list_characters', arguments: '{}' } }]);
    });
});

describe('parseNovaProfilePipe', () => {
    it('returns empty string for nullish / blank / "None"', () => {
        assert.equal(parseNovaProfilePipe(null), '');
        assert.equal(parseNovaProfilePipe(undefined), '');
        assert.equal(parseNovaProfilePipe(''), '');
        assert.equal(parseNovaProfilePipe('   '), '');
        assert.equal(parseNovaProfilePipe('None'), '');
        assert.equal(parseNovaProfilePipe('none'), '');
    });
    it('trims and returns the active profile name', () => {
        assert.equal(parseNovaProfilePipe('  Claude-3.5  '), 'Claude-3.5');
    });
});

describe('resolveNovaSkill', () => {
    it('resolves a known id', () => {
        const s = resolveNovaSkill('character-creator');
        assert.equal(s.id, 'character-creator');
    });
    it('falls back to freeform for unknown ids', () => {
        const s = resolveNovaSkill('nonsense');
        assert.equal(s.id, 'freeform');
    });
    it('falls back to freeform for nullish id', () => {
        assert.equal(resolveNovaSkill(null).id, 'freeform');
        assert.equal(resolveNovaSkill(undefined).id, 'freeform');
    });
});

describe('buildNovaRequestMessages', () => {
    it('prepends system prompt and preserves role/content', () => {
        const out = buildNovaRequestMessages({
            systemPrompt: 'SYS',
            sessionMessages: [
                { role: 'user', content: 'hi' },
                { role: 'assistant', content: 'hey' },
            ],
        });
        assert.deepEqual(out, [
            { role: 'system', content: 'SYS' },
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'hey' },
        ]);
    });
    it('omits malformed messages and coerces missing content', () => {
        const out = buildNovaRequestMessages({
            systemPrompt: '',
            sessionMessages: [null, {}, { role: 'user' }, { content: 'orphan' }],
        });
        assert.deepEqual(out, [{ role: 'user', content: '' }]);
    });
});

// ---------------------------------------------------------------------------
// Source-text contract: lock in the production shape matches the mirror.
// ---------------------------------------------------------------------------

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

describe('index.js source shape', () => {
    it('declares sendNovaTurn in the NOVA AGENT section, before NOVA_TOOLS', async () => {
        const here = dirname(fileURLToPath(import.meta.url));
        const js = await readFile(resolve(here, '..', 'index.js'), 'utf8');
        assert.match(js, /async\s+function\s+sendNovaTurn\s*\(/);
        assert.match(js, /function\s+parseNovaProfilePipe\s*\(/);
        assert.match(js, /function\s+resolveNovaSkill\s*\(/);
        assert.match(js, /function\s+buildNovaRequestMessages\s*\(/);
        const sendIdx = js.indexOf('async function sendNovaTurn(');
        const toolsIdx = js.indexOf('const NOVA_TOOLS = [');
        const initIdx = js.indexOf('function initNovaOnce(');
        assert.ok(sendIdx > initIdx, 'sendNovaTurn must come after initNovaOnce');
        assert.ok(sendIdx < toolsIdx, 'sendNovaTurn must come before NOVA_TOOLS');
    });
    it('clears novaTurnInFlight and novaAbortController in the finally block', async () => {
        const here = dirname(fileURLToPath(import.meta.url));
        const js = await readFile(resolve(here, '..', 'index.js'), 'utf8');
        // The finally block must reset both flags. A regex capture is brittle,
        // so just assert that both assignments occur somewhere after a
        // `} finally {` that follows the sendNovaTurn signature.
        const sendIdx = js.indexOf('async function sendNovaTurn(');
        const afterSend = js.slice(sendIdx);
        assert.match(afterSend, /finally\s*\{[\s\S]*novaTurnInFlight\s*=\s*false/);
        assert.match(afterSend, /finally\s*\{[\s\S]*novaAbortController\s*=\s*null/);
    });
});
