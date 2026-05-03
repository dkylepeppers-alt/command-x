/**
 * Unit tests for Nova tool-dispatch loop (plan §3c, §3d).
 * Run with: node --test test/nova-tool-dispatch.test.mjs
 *
 * Inline-copy of `runNovaToolDispatch` + the gate helper it calls.
 * Per AGENT_MEMORY convention: when you edit the production helper,
 * edit this copy too.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// -------- Inline copy of production helpers --------

const NOVA_TIERS = Object.freeze(['read', 'write', 'full']);
const NOVA_PERMISSIONS = Object.freeze(['read', 'write', 'shell']);
const _NOVA_TIER_ALLOWS = {
    read: new Set(['read']),
    write: new Set(['read', 'write']),
    full: new Set(['read', 'write', 'shell']),
};
function _novaRememberedApprovalsHas(container, toolName) {
    if (!container || typeof toolName !== 'string' || !toolName) return false;
    if (container instanceof Set) return container.has(toolName);
    if (Array.isArray(container)) return container.includes(toolName);
    return false;
}
function novaToolGate({ permission, tier, toolName, rememberedApprovals } = {}) {
    const safeTier = NOVA_TIERS.includes(tier) ? tier : 'read';
    if (permission == null) return { allowed: false, requiresApproval: false, reason: 'missing-permission' };
    if (!NOVA_PERMISSIONS.includes(permission)) return { allowed: false, requiresApproval: false, reason: 'unknown-permission' };
    const allows = _NOVA_TIER_ALLOWS[safeTier];
    if (!allows.has(permission)) return { allowed: false, requiresApproval: false, reason: 'tier-too-low' };
    if (permission === 'read') return { allowed: true, requiresApproval: false };
    return { allowed: true, requiresApproval: !_novaRememberedApprovalsHas(rememberedApprovals, toolName) };
}

const NOVA_DEFAULT_MAX_TOOL_CALLS = 24;

function _stringifyNovaToolResult(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch (_) { return String(value); }
}

function isNovaEmptyAssistantContent(value) {
    const text = String(value ?? '').trim().toLowerCase();
    return !text || text === 'none' || text === '[none]';
}

function summarizeNovaToolDispatchCompletion({ events = [], toolsExecuted = 0, toolsDenied = 0, toolsFailed = 0 } = {}) {
    const toolEvents = Array.isArray(events) ? events.filter(ev => ev && ev.role === 'tool') : [];
    const names = Array.from(new Set(toolEvents.map(ev => String(ev.name || 'tool')).filter(Boolean)));
    const parts = [];
    if (toolsExecuted > 0) parts.push(`${toolsExecuted} tool${toolsExecuted === 1 ? '' : 's'} ran`);
    if (toolsDenied > 0) parts.push(`${toolsDenied} denied`);
    if (toolsFailed > 0) parts.push(`${toolsFailed} failed`);
    const status = parts.length ? parts.join(', ') : 'Tool turn completed';
    return names.length ? `${status}: ${names.join(', ')}` : `${status}.`;
}

async function runNovaToolDispatch({
    initialResponse,
    messages,
    toolRegistry = [],
    handlers = {},
    tier = 'read',
    rememberedApprovals = null,
    maxToolCalls = NOVA_DEFAULT_MAX_TOOL_CALLS,
    confirmApproval,
    sendRequest,
    tools = [],
    signal,
    gate = novaToolGate,
    nowImpl = Date.now,
    onAudit,
} = {}) {
    if (typeof sendRequest !== 'function') return { ok: false, reason: 'no-send-request' };

    const events = [];
    let rounds = 0;
    let toolsExecuted = 0;
    let toolsDenied = 0;
    let toolsFailed = 0;
    let capHit = false;
    let response = initialResponse;
    let finalAssistant = null;

    const audit = (tool, argsSummary, outcome) => {
        if (typeof onAudit === 'function') {
            try { onAudit({ tool, argsSummary, outcome }); } catch (_) { /* noop */ }
        }
    };

    while (true) {
        if (signal && signal.aborted) return { ok: false, reason: 'aborted' };

        const assistantContent = String(response?.content ?? '');
        const toolCalls = Array.isArray(response?.tool_calls) ? response.tool_calls : [];
        const assistantMsg = { role: 'assistant', content: assistantContent, ts: nowImpl() };
        if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
        messages.push(assistantMsg);
        events.push(assistantMsg);
        finalAssistant = assistantMsg;

        if (toolCalls.length === 0) {
            if (isNovaEmptyAssistantContent(assistantMsg.content) && (toolsExecuted > 0 || toolsDenied > 0 || toolsFailed > 0)) {
                assistantMsg.content = summarizeNovaToolDispatchCompletion({
                    events,
                    toolsExecuted,
                    toolsDenied,
                    toolsFailed,
                });
            }
            break;
        }

        for (const call of toolCalls) {
            if (signal && signal.aborted) return { ok: false, reason: 'aborted' };
            if (toolsExecuted >= maxToolCalls) {
                capHit = true;
                audit('dispatch', `executed=${toolsExecuted} cap=${maxToolCalls}`, 'cap-hit');
                break;
            }
            const callId = String(call?.id ?? '');
            const fn = call?.function || {};
            const name = String(fn.name || '');
            const rawArgs = fn.arguments;

            const tool = toolRegistry.find(t => t && t.name === name);
            if (!tool) {
                toolsDenied++;
                audit(name || '(unnamed)', '', 'denied:unknown-tool');
                const toolMsg = { role: 'tool', tool_call_id: callId, name, content: JSON.stringify({ error: 'unknown-tool' }), ts: nowImpl() };
                messages.push(toolMsg); events.push(toolMsg);
                continue;
            }

            let args;
            if (rawArgs == null || rawArgs === '') args = {};
            else if (typeof rawArgs === 'object') args = rawArgs;
            else {
                try { args = JSON.parse(String(rawArgs)); }
                catch (_) {
                    toolsDenied++;
                    audit(name, 'raw-args=<unparsable>', 'denied:malformed-arguments');
                    const toolMsg = { role: 'tool', tool_call_id: callId, name, content: JSON.stringify({ error: 'malformed-arguments' }), ts: nowImpl() };
                    messages.push(toolMsg); events.push(toolMsg);
                    continue;
                }
            }

            const gateResult = gate({ permission: tool.permission, tier, toolName: name, rememberedApprovals });
            if (!gateResult.allowed) {
                toolsDenied++;
                audit(name, `tier=${tier}`, `denied:${gateResult.reason}`);
                const toolMsg = { role: 'tool', tool_call_id: callId, name, content: JSON.stringify({ error: 'denied', reason: gateResult.reason }), ts: nowImpl() };
                messages.push(toolMsg); events.push(toolMsg);
                continue;
            }

            if (gateResult.requiresApproval) {
                if (typeof confirmApproval !== 'function') {
                    toolsDenied++;
                    audit(name, `tier=${tier}`, 'denied:no-confirmer');
                    const toolMsg = { role: 'tool', tool_call_id: callId, name, content: JSON.stringify({ error: 'denied', reason: 'no-confirmer' }), ts: nowImpl() };
                    messages.push(toolMsg); events.push(toolMsg);
                    continue;
                }
                let approved;
                try {
                    approved = await confirmApproval({ tool, args, permission: tool.permission, toolCallId: callId });
                } catch (err) {
                    toolsDenied++;
                    audit(name, `tier=${tier}`, `denied:confirmer-error:${String(err?.message || err)}`);
                    const toolMsg = { role: 'tool', tool_call_id: callId, name, content: JSON.stringify({ error: 'denied', reason: 'confirmer-error' }), ts: nowImpl() };
                    messages.push(toolMsg); events.push(toolMsg);
                    continue;
                }
                if (!approved) {
                    toolsDenied++;
                    audit(name, `tier=${tier}`, 'denied:user-rejected');
                    const toolMsg = { role: 'tool', tool_call_id: callId, name, content: JSON.stringify({ error: 'denied', reason: 'user-rejected' }), ts: nowImpl() };
                    messages.push(toolMsg); events.push(toolMsg);
                    continue;
                }
            }

            const handler = handlers[name];
            if (typeof handler !== 'function') {
                toolsFailed++;
                audit(name, '', 'error:no-handler');
                const toolMsg = { role: 'tool', tool_call_id: callId, name, content: JSON.stringify({ error: 'no-handler' }), ts: nowImpl() };
                messages.push(toolMsg); events.push(toolMsg);
                continue;
            }
            let result;
            try { result = await handler(args, { signal }); }
            catch (err) {
                toolsFailed++;
                audit(name, `tier=${tier}`, `error:${String(err?.message || err)}`);
                const toolMsg = { role: 'tool', tool_call_id: callId, name, content: JSON.stringify({ error: String(err?.message || err) }), ts: nowImpl() };
                messages.push(toolMsg); events.push(toolMsg);
                continue;
            }

            toolsExecuted++;
            audit(name, `tier=${tier}`, 'ok');
            const toolMsg = { role: 'tool', tool_call_id: callId, name, content: _stringifyNovaToolResult(result), ts: nowImpl() };
            messages.push(toolMsg); events.push(toolMsg);
        }

        if (capHit) break;
        if (signal && signal.aborted) return { ok: false, reason: 'aborted' };

        rounds++;
        try { response = await sendRequest({ messages, tools, tool_choice: 'auto', signal }); }
        catch (err) {
            const aborted = (signal && signal.aborted) || err?.name === 'AbortError';
            audit('send-request', `round=${rounds}`, aborted ? 'aborted' : `send-failed:${String(err?.message || err)}`);
            return { ok: false, reason: aborted ? 'aborted' : 'send-failed', error: String(err?.message || err) };
        }
    }

    return { ok: true, rounds, toolsExecuted, toolsDenied, toolsFailed, capHit, aborted: false, finalAssistant, events };
}

// -------- Test fixtures --------

const TOOL_REGISTRY = [
    { name: 'st_get_context', permission: 'read' },
    { name: 'st_write_worldbook', permission: 'write' },
    { name: 'fs_read',        permission: 'read' },
    { name: 'fs_write',       permission: 'write' },
    { name: 'shell_run',      permission: 'shell' },
];

function makeCall(id, name, args) {
    return { id, function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args || {}) } };
}

// -------- Tests --------

describe('runNovaToolDispatch — happy path', () => {
    it('resolves without tool_calls immediately', async () => {
        const messages = [{ role: 'system', content: 'sys' }];
        const res = await runNovaToolDispatch({
            initialResponse: { content: 'hi' },
            messages,
            sendRequest: async () => assert.fail('should not be called'),
        });
        assert.equal(res.ok, true);
        assert.equal(res.rounds, 0);
        assert.equal(res.toolsExecuted, 0);
        assert.equal(res.events.length, 1);
        assert.equal(messages.length, 2);
        assert.equal(messages[1].role, 'assistant');
        assert.equal(messages[1].content, 'hi');
    });

    it('executes a single read tool call and follows up with final assistant', async () => {
        const calls = [];
        const handlers = {
            st_get_context: async (args) => { calls.push(['st_get_context', args]); return { ok: true, chars: 2 }; },
        };
        const followups = [
            { content: 'Here is the context.' },
        ];
        let sendCount = 0;
        const sendRequest = async () => { sendCount++; return followups.shift(); };
        const messages = [{ role: 'system', content: 's' }];
        const res = await runNovaToolDispatch({
            initialResponse: { content: '', tool_calls: [makeCall('c1', 'st_get_context', {})] },
            messages,
            toolRegistry: TOOL_REGISTRY,
            handlers,
            tier: 'read',
            sendRequest,
        });
        assert.equal(res.ok, true);
        assert.equal(res.toolsExecuted, 1);
        assert.equal(res.toolsDenied, 0);
        assert.equal(res.toolsFailed, 0);
        assert.equal(res.rounds, 1);
        assert.equal(sendCount, 1);
        assert.equal(res.finalAssistant.content, 'Here is the context.');
        // Transcript: initial assistant+toolcalls, tool result, final assistant
        assert.equal(res.events.length, 3);
        assert.equal(res.events[1].role, 'tool');
        assert.equal(res.events[1].tool_call_id, 'c1');
        assert.equal(res.events[1].name, 'st_get_context');
        // Content is stringified JSON of the handler result.
        assert.equal(res.events[1].content, JSON.stringify({ ok: true, chars: 2 }));
    });

    it('executes multiple sequential rounds', async () => {
        const handlers = {
            st_get_context: async () => ({ ctx: 1 }),
            fs_read: async () => 'file contents',
        };
        let n = 0;
        const followups = [
            { content: '', tool_calls: [makeCall('c2', 'fs_read', { path: 'a.md' })] },
            { content: 'done' },
        ];
        const sendRequest = async () => { n++; return followups.shift(); };
        const messages = [{ role: 'system', content: 's' }];
        const res = await runNovaToolDispatch({
            initialResponse: { content: '', tool_calls: [makeCall('c1', 'st_get_context', {})] },
            messages,
            toolRegistry: TOOL_REGISTRY,
            handlers,
            tier: 'read',
            sendRequest,
        });
        assert.equal(res.ok, true);
        assert.equal(res.toolsExecuted, 2);
        assert.equal(res.rounds, 2);
        assert.equal(n, 2);
        // fs_read result was a plain string — should be stored verbatim, not JSON-quoted.
        const fsResult = res.events.find(e => e.role === 'tool' && e.name === 'fs_read');
        assert.equal(fsResult.content, 'file contents');
    });

    it('replaces final [none] after tool execution with a deterministic completion summary', async () => {
        const handlers = {
            st_write_worldbook: async () => ({ ok: true, action: 'created', name: 'siren', file_id: 'siren' }),
        };
        const sendRequest = async () => ({ content: '[none]' });
        const messages = [{ role: 'system', content: 's' }];
        const res = await runNovaToolDispatch({
            initialResponse: { content: '', tool_calls: [makeCall('c1', 'st_write_worldbook', { name: 'siren', book: { entries: {} } })] },
            messages,
            toolRegistry: TOOL_REGISTRY,
            handlers,
            tier: 'write',
            rememberedApprovals: new Set(['st_write_worldbook']),
            sendRequest,
        });
        assert.equal(res.ok, true);
        assert.equal(res.finalAssistant.content, '1 tool ran: st_write_worldbook');
        assert.equal(res.events.at(-1).content, '1 tool ran: st_write_worldbook');
    });
});

describe('runNovaToolDispatch — approval', () => {
    it('calls confirmApproval for write permission and executes on approve', async () => {
        const seen = [];
        const confirmApproval = async ({ tool, args }) => { seen.push([tool.name, args]); return true; };
        const handlers = { fs_write: async () => ({ ok: true, bytes: 10 }) };
        const followups = [{ content: 'wrote it' }];
        const sendRequest = async () => followups.shift();
        const messages = [{ role: 'system', content: 's' }];
        const res = await runNovaToolDispatch({
            initialResponse: { content: '', tool_calls: [makeCall('c1', 'fs_write', { path: 'x', content: 'y' })] },
            messages,
            toolRegistry: TOOL_REGISTRY,
            handlers,
            tier: 'write',
            confirmApproval,
            sendRequest,
        });
        assert.equal(res.ok, true);
        assert.equal(res.toolsExecuted, 1);
        assert.equal(res.toolsDenied, 0);
        assert.equal(seen.length, 1);
        assert.equal(seen[0][0], 'fs_write');
        assert.deepEqual(seen[0][1], { path: 'x', content: 'y' });
    });

    it('records denied:user-rejected and sends a tool error to the LLM on reject', async () => {
        const confirmApproval = async () => false;
        const handlers = { fs_write: async () => assert.fail('should not run') };
        const followups = [{ content: 'ok, skipped' }];
        const sendRequest = async () => followups.shift();
        const audits = [];
        const messages = [{ role: 'system', content: 's' }];
        const res = await runNovaToolDispatch({
            initialResponse: { content: '', tool_calls: [makeCall('c1', 'fs_write', { path: 'x' })] },
            messages,
            toolRegistry: TOOL_REGISTRY,
            handlers,
            tier: 'write',
            confirmApproval,
            sendRequest,
            onAudit: (e) => audits.push(e),
        });
        assert.equal(res.ok, true);
        assert.equal(res.toolsDenied, 1);
        assert.equal(res.toolsExecuted, 0);
        assert.ok(audits.some(a => a.outcome === 'denied:user-rejected'));
        const toolEvent = res.events.find(e => e.role === 'tool');
        const parsed = JSON.parse(toolEvent.content);
        assert.deepEqual(parsed, { error: 'denied', reason: 'user-rejected' });
    });

    it('bypasses approval when rememberedApprovals contains the tool name', async () => {
        let confirmed = 0;
        const confirmApproval = async () => { confirmed++; return true; };
        const handlers = { fs_write: async () => 'ok' };
        const followups = [{ content: 'done' }];
        const sendRequest = async () => followups.shift();
        const messages = [{ role: 'system', content: 's' }];
        const res = await runNovaToolDispatch({
            initialResponse: { content: '', tool_calls: [makeCall('c1', 'fs_write', {})] },
            messages,
            toolRegistry: TOOL_REGISTRY,
            handlers,
            tier: 'write',
            rememberedApprovals: new Set(['fs_write']),
            confirmApproval,
            sendRequest,
        });
        assert.equal(res.ok, true);
        assert.equal(confirmed, 0); // never called because pre-approved
        assert.equal(res.toolsExecuted, 1);
    });

    it('denies with no-confirmer when approval required but confirmer absent', async () => {
        const handlers = { fs_write: async () => assert.fail('should not run') };
        const followups = [{ content: 'done' }];
        const sendRequest = async () => followups.shift();
        const audits = [];
        const messages = [{ role: 'system', content: 's' }];
        const res = await runNovaToolDispatch({
            initialResponse: { content: '', tool_calls: [makeCall('c1', 'fs_write', {})] },
            messages,
            toolRegistry: TOOL_REGISTRY,
            handlers,
            tier: 'write',
            sendRequest,
            onAudit: (e) => audits.push(e),
        });
        assert.equal(res.ok, true);
        assert.equal(res.toolsDenied, 1);
        assert.ok(audits.some(a => a.outcome === 'denied:no-confirmer'));
    });

    it('treats a throwing confirmer as a rejection (not a crash)', async () => {
        const confirmApproval = async () => { throw new Error('modal error'); };
        const handlers = { fs_write: async () => assert.fail('should not run') };
        const followups = [{ content: 'done' }];
        const sendRequest = async () => followups.shift();
        const audits = [];
        const messages = [{ role: 'system', content: 's' }];
        const res = await runNovaToolDispatch({
            initialResponse: { content: '', tool_calls: [makeCall('c1', 'fs_write', {})] },
            messages,
            toolRegistry: TOOL_REGISTRY,
            handlers,
            tier: 'write',
            confirmApproval,
            sendRequest,
            onAudit: (e) => audits.push(e),
        });
        assert.equal(res.ok, true);
        assert.equal(res.toolsDenied, 1);
        assert.ok(audits.some(a => a.outcome.startsWith('denied:confirmer-error:')));
    });
});

describe('runNovaToolDispatch — gate denies', () => {
    it('denies tier-too-low and keeps running other calls', async () => {
        const handlers = { st_get_context: async () => 'ok', fs_write: async () => assert.fail() };
        const followups = [{ content: 'done' }];
        const sendRequest = async () => followups.shift();
        const messages = [{ role: 'system', content: 's' }];
        const res = await runNovaToolDispatch({
            initialResponse: {
                content: '',
                tool_calls: [
                    makeCall('c1', 'st_get_context', {}),
                    makeCall('c2', 'fs_write', { path: 'x' }),
                ],
            },
            messages,
            toolRegistry: TOOL_REGISTRY,
            handlers,
            tier: 'read', // blocks fs_write
            sendRequest,
        });
        assert.equal(res.ok, true);
        assert.equal(res.toolsExecuted, 1);
        assert.equal(res.toolsDenied, 1);
        const denied = res.events.find(e => e.role === 'tool' && e.name === 'fs_write');
        const body = JSON.parse(denied.content);
        assert.equal(body.reason, 'tier-too-low');
    });

    it('denies unknown-tool', async () => {
        const followups = [{ content: 'done' }];
        const sendRequest = async () => followups.shift();
        const messages = [{ role: 'system', content: 's' }];
        const res = await runNovaToolDispatch({
            initialResponse: { content: '', tool_calls: [makeCall('c1', 'nuclear_launch', {})] },
            messages,
            toolRegistry: TOOL_REGISTRY,
            tier: 'full',
            sendRequest,
        });
        assert.equal(res.ok, true);
        assert.equal(res.toolsDenied, 1);
        const denied = res.events.find(e => e.role === 'tool');
        assert.equal(JSON.parse(denied.content).error, 'unknown-tool');
    });

    it('denies tools outside the per-turn registry even when a handler exists', async () => {
        let ranForbiddenHandler = false;
        const handlers = {
            fs_write: async () => {
                ranForbiddenHandler = true;
                return 'should-not-run';
            },
        };
        const followups = [{ content: 'done' }];
        const sendRequest = async () => followups.shift();
        const messages = [{ role: 'system', content: 's' }];
        const res = await runNovaToolDispatch({
            initialResponse: { content: '', tool_calls: [makeCall('c1', 'fs_write', { path: 'x', content: 'y' })] },
            messages,
            toolRegistry: TOOL_REGISTRY.filter(t => t.name !== 'fs_write'),
            handlers,
            tier: 'full',
            confirmApproval: async () => true,
            sendRequest,
        });
        assert.equal(res.ok, true);
        assert.equal(res.toolsDenied, 1);
        assert.equal(ranForbiddenHandler, false);
        const denied = res.events.find(e => e.role === 'tool' && e.name === 'fs_write');
        assert.equal(JSON.parse(denied.content).error, 'unknown-tool');
    });

    it('denies malformed-arguments', async () => {
        const handlers = { st_get_context: async () => 'ok' };
        const followups = [{ content: 'done' }];
        const sendRequest = async () => followups.shift();
        const messages = [{ role: 'system', content: 's' }];
        const res = await runNovaToolDispatch({
            initialResponse: {
                content: '',
                tool_calls: [{ id: 'c1', function: { name: 'st_get_context', arguments: '{not json' } }],
            },
            messages,
            toolRegistry: TOOL_REGISTRY,
            handlers,
            tier: 'read',
            sendRequest,
        });
        assert.equal(res.ok, true);
        assert.equal(res.toolsDenied, 1);
        assert.equal(JSON.parse(res.events.find(e => e.role === 'tool').content).error, 'malformed-arguments');
    });

    it('accepts pre-parsed object arguments', async () => {
        const seen = [];
        const handlers = { st_get_context: async (args) => { seen.push(args); return 'ok'; } };
        const followups = [{ content: 'done' }];
        const sendRequest = async () => followups.shift();
        const messages = [{ role: 'system', content: 's' }];
        const res = await runNovaToolDispatch({
            initialResponse: {
                content: '',
                tool_calls: [{ id: 'c1', function: { name: 'st_get_context', arguments: { key: 'v' } } }],
            },
            messages,
            toolRegistry: TOOL_REGISTRY,
            handlers,
            tier: 'read',
            sendRequest,
        });
        assert.equal(res.ok, true);
        assert.deepEqual(seen[0], { key: 'v' });
    });
});

describe('runNovaToolDispatch — handler errors', () => {
    it('handler throw → role:tool with error body; loop continues', async () => {
        const handlers = { st_get_context: async () => { throw new Error('boom'); } };
        const followups = [{ content: 'recovered' }];
        const sendRequest = async () => followups.shift();
        const audits = [];
        const messages = [{ role: 'system', content: 's' }];
        const res = await runNovaToolDispatch({
            initialResponse: { content: '', tool_calls: [makeCall('c1', 'st_get_context', {})] },
            messages,
            toolRegistry: TOOL_REGISTRY,
            handlers,
            tier: 'read',
            sendRequest,
            onAudit: (e) => audits.push(e),
        });
        assert.equal(res.ok, true);
        assert.equal(res.toolsFailed, 1);
        assert.equal(res.toolsExecuted, 0);
        const body = JSON.parse(res.events.find(e => e.role === 'tool').content);
        assert.equal(body.error, 'boom');
        assert.ok(audits.some(a => a.outcome.startsWith('error:boom')));
    });

    it('missing handler → no-handler error', async () => {
        const followups = [{ content: 'done' }];
        const sendRequest = async () => followups.shift();
        const messages = [{ role: 'system', content: 's' }];
        const res = await runNovaToolDispatch({
            initialResponse: { content: '', tool_calls: [makeCall('c1', 'st_get_context', {})] },
            messages,
            toolRegistry: TOOL_REGISTRY,
            handlers: {},
            tier: 'read',
            sendRequest,
        });
        assert.equal(res.ok, true);
        assert.equal(res.toolsFailed, 1);
        assert.equal(JSON.parse(res.events.find(e => e.role === 'tool').content).error, 'no-handler');
    });
});

describe('runNovaToolDispatch — caps and aborts', () => {
    it('hits maxToolCalls cap and stops early', async () => {
        const handlers = { st_get_context: async () => 'ok' };
        // Two calls, cap=1 → second is cap-denied before running.
        const followups = []; // shouldn't reach follow-up
        const sendRequest = async () => { assert.fail('cap should prevent follow-up'); };
        const audits = [];
        const messages = [{ role: 'system', content: 's' }];
        const res = await runNovaToolDispatch({
            initialResponse: {
                content: '',
                tool_calls: [makeCall('c1', 'st_get_context', {}), makeCall('c2', 'st_get_context', {})],
            },
            messages,
            toolRegistry: TOOL_REGISTRY,
            handlers,
            tier: 'read',
            maxToolCalls: 1,
            sendRequest,
            onAudit: (e) => audits.push(e),
        });
        assert.equal(res.ok, true);
        assert.equal(res.capHit, true);
        assert.equal(res.toolsExecuted, 1);
        assert.ok(audits.some(a => a.outcome === 'cap-hit'));
    });

    it('aborts mid-loop when signal fires', async () => {
        const ac = new AbortController();
        const handlers = {
            st_get_context: async () => { ac.abort(); return 'ok'; },
        };
        const sendRequest = async () => assert.fail('should not follow up after abort');
        const messages = [{ role: 'system', content: 's' }];
        const res = await runNovaToolDispatch({
            initialResponse: {
                content: '',
                tool_calls: [makeCall('c1', 'st_get_context', {}), makeCall('c2', 'st_get_context', {})],
            },
            messages,
            toolRegistry: TOOL_REGISTRY,
            handlers,
            tier: 'read',
            sendRequest,
            signal: ac.signal,
        });
        assert.equal(res.ok, false);
        assert.equal(res.reason, 'aborted');
    });

    it('send-request throw → ok:false with reason send-failed', async () => {
        const handlers = { st_get_context: async () => 'ok' };
        const sendRequest = async () => { throw new Error('network'); };
        const messages = [{ role: 'system', content: 's' }];
        const res = await runNovaToolDispatch({
            initialResponse: { content: '', tool_calls: [makeCall('c1', 'st_get_context', {})] },
            messages,
            toolRegistry: TOOL_REGISTRY,
            handlers,
            tier: 'read',
            sendRequest,
        });
        assert.equal(res.ok, false);
        assert.equal(res.reason, 'send-failed');
        assert.ok(String(res.error).includes('network'));
    });

    it('ok:false still lets caller read the partial transcript via events', async () => {
        const handlers = { st_get_context: async () => 'ok' };
        const sendRequest = async () => { throw new Error('x'); };
        const messages = [{ role: 'system', content: 's' }];
        const res = await runNovaToolDispatch({
            initialResponse: { content: '', tool_calls: [makeCall('c1', 'st_get_context', {})] },
            messages,
            toolRegistry: TOOL_REGISTRY,
            handlers,
            tier: 'read',
            sendRequest,
        });
        // The dispatcher still mutated messages with the round-0 assistant
        // and the tool result before the send-request failed.
        assert.equal(res.ok, false);
        // system + assistant + tool = 3
        assert.equal(messages.length, 3);
        assert.equal(messages[2].role, 'tool');
    });

    it('rejects missing sendRequest early', async () => {
        const res = await runNovaToolDispatch({
            initialResponse: { content: 'hi' },
            messages: [],
        });
        assert.equal(res.ok, false);
        assert.equal(res.reason, 'no-send-request');
    });
});

describe('runNovaToolDispatch — audit coverage', () => {
    it('emits one audit entry per tool_call outcome', async () => {
        const handlers = { st_get_context: async () => 'ok' };
        const followups = [{ content: 'done' }];
        const sendRequest = async () => followups.shift();
        const audits = [];
        const messages = [{ role: 'system', content: 's' }];
        await runNovaToolDispatch({
            initialResponse: {
                content: '',
                tool_calls: [
                    makeCall('c1', 'st_get_context', {}),
                    makeCall('c2', 'nuclear_launch', {}),
                    makeCall('c3', 'fs_write', { path: 'x' }),
                ],
            },
            messages,
            toolRegistry: TOOL_REGISTRY,
            handlers,
            tier: 'read',
            sendRequest,
            onAudit: (e) => audits.push(e),
        });
        // 3 tool calls → 3 audit entries (ok, unknown-tool, tier-too-low)
        const outcomes = audits.map(a => a.outcome);
        assert.deepEqual(outcomes.sort(), ['denied:tier-too-low', 'denied:unknown-tool', 'ok']);
    });
});

// -------- Source-shape contract --------

describe('index.js source shape', () => {
    it('declares runNovaToolDispatch + cxNovaApprovalModal + buildNovaApprovalModalBody', async () => {
        const here = dirname(fileURLToPath(import.meta.url));
        const js = await readFile(resolve(here, '..', 'index.js'), 'utf8');
        assert.match(js, /async\s+function\s+runNovaToolDispatch\s*\(/);
        assert.match(js, /function\s+buildNovaApprovalModalBody\s*\(/);
        assert.match(js, /function\s+cxNovaApprovalModal\s*\(/);
    });

    it('sendNovaTurn accepts toolHandlers + confirmApproval + tier + rememberedApprovals', async () => {
        const here = dirname(fileURLToPath(import.meta.url));
        const js = await readFile(resolve(here, '..', 'index.js'), 'utf8');
        // All four params must appear in the sendNovaTurn destructuring block.
        const start = js.indexOf('async function sendNovaTurn(');
        const openBrace = js.indexOf('{', start);
        const closeBrace = js.indexOf('} = {}', openBrace);
        const block = js.slice(openBrace, closeBrace);
        assert.match(block, /tier\s*=/);
        assert.match(block, /rememberedApprovals\s*=/);
        assert.match(block, /toolHandlers\s*=/);
        assert.match(block, /confirmApproval\s*=/);
        assert.match(js, /toolRegistry:\s*tools/,
            'sendNovaTurn must pass per-turn filtered tools as the dispatcher registry');
    });
});
