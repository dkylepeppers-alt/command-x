/**
 * Command-X Phone — SillyTavern Extension v0.10.0
 *
 * Approach: inject a system prompt that tells the LLM to wrap the
 * character's text/neural reply in [sms]…[/sms] tags. The extension
 * extracts that block for the phone UI and hides it from ST chat.
 * Message history is stored in localStorage (phone owns its own log).
 *
 * v0.10.0: Compose queue (batch mode), notification badges, [status] tag,
 *          Profiles app, Settings app, toast notifications, recency sort,
 *          character avatars, [sms to] filtering, and embedded OpenClaw bridge controls.
 */
import { getContext } from '../../../st-context.js';
import {
    setExtensionPrompt,
    extension_prompt_types,
    extension_prompt_roles,
} from '../../../../script.js';

const EXT = 'command-x';
const INJECT_KEY = 'command-x-sms';
const INJECT_KEY_CONTACTS = 'command-x-contacts';
const DEFAULTS = { enabled: true, styleCommands: true, showLockscreen: false, panelOpen: false, batchMode: false, autoDetectNpcs: true, openclawMode: 'assist' };
let settings = { ...DEFAULTS };
let phoneContainer = null;
let commandMode = null; // null | 'COMMAND' | 'FORGET' | 'BELIEVE' | 'COMPEL'
let neuralMode = false; // toggled via ⚡ button in chat header


const OPENCLAW_API_BASE = '/api/plugins/openclaw-bridge';

function getOpenClawChatState() {
    const ctx = getContext();
    ctx.chatMetadata[EXT] = ctx.chatMetadata[EXT] || {};
    ctx.chatMetadata[EXT].openclaw = ctx.chatMetadata[EXT].openclaw || {};
    const state = ctx.chatMetadata[EXT].openclaw;
    if (!Number.isFinite(Number(state.resetNonce))) state.resetNonce = 0;
    return state;
}

function saveOpenClawChatState(patch = {}) {
    const ctx = getContext();
    const current = getOpenClawChatState();
    ctx.chatMetadata[EXT] = ctx.chatMetadata[EXT] || {};
    ctx.chatMetadata[EXT].openclaw = { ...current, ...patch };
    ctx.saveMetadata();
    return ctx.chatMetadata[EXT].openclaw;
}

function currentChatId() {
    const ctx = getContext();
    return String(ctx.chatId || ctx.groupId || ctx.getCurrentChatId?.() || 'no-chat');
}

function getRecentMessages() {
    const ctx = getContext();
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    return chat.slice(-12).map((message, index) => ({
        name: message.name || message.original_name || message.role || `message-${index + 1}`,
        text: message.mes || message.message || message.content || '',
        isUser: !!message.is_user,
        isSystem: !!message.is_system,
    }));
}

async function callOpenClawBridge(path, options = {}) {
    const ctx = getContext();
    const response = await fetch(`${OPENCLAW_API_BASE}${path}`, {
        method: options.method || 'GET',
        headers: ctx.getRequestHeaders(),
        body: options.body ? JSON.stringify(options.body) : undefined,
    });

    const data = await response.json();
    if (!response.ok || !data?.ok) {
        throw new Error(data?.error || `${response.status} ${response.statusText}`);
    }

    return data;
}

function getOpenClawEls() {
    return {
        status: phoneContainer?.querySelector('#cx-ocb-status'),
        session: phoneContainer?.querySelector('#cx-ocb-session'),
        reply: phoneContainer?.querySelector('#cx-ocb-reply'),
        prompt: phoneContainer?.querySelector('#cx-ocb-prompt'),
        mode: phoneContainer?.querySelector('#cx-ocb-mode'),
        actions: phoneContainer?.querySelector('#cx-ocb-actions-list'),
        actionState: phoneContainer?.querySelector('#cx-ocb-actions-state'),
        log: phoneContainer?.querySelector('#cx-ocb-log'),
    };
}

function setOpenClawStatus(text) {
    const { status } = getOpenClawEls();
    if (status) status.textContent = text;
}

function appendOpenClawLog(title, value) {
    const { log } = getOpenClawEls();
    if (!log) return;
    const chunk = [title, value].filter(Boolean).join('\n');
    const previous = String(log.textContent || '').trim();
    log.textContent = [previous, chunk].filter(Boolean).join('\n\n').slice(-16000);
    log.scrollTop = log.scrollHeight;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function parseOpenClawOperateEnvelope(reply, envelopeFromBridge = null) {
    const raw = envelopeFromBridge || (() => {
        const match = String(reply || '').match(/\[command-x-operate\]\s*([\s\S]*?)\s*\[\/command-x-operate\]/i);
        if (!match) return null;
        try {
            return JSON.parse(match[1]);
        } catch {
            return null;
        }
    })();

    if (!raw || raw.kind !== 'command-x/operate/v1' || !Array.isArray(raw.actions)) return null;
    const actions = raw.actions
        .map((action, index) => ({
            id: String(action?.id || `action-${index + 1}`),
            type: String(action?.type || ''),
            title: String(action?.title || action?.type || `Action ${index + 1}`),
            command: String(action?.command || '').trim(),
            reason: String(action?.reason || '').trim(),
            status: 'pending',
            receipt: '',
        }))
        .filter(action => action.type === 'slash.run' && action.command.startsWith('/'));

    if (!actions.length) return null;
    return {
        kind: raw.kind,
        summary: String(raw.summary || '').trim(),
        actions,
    };
}

function applyOpenClawResponse(data, logTitle = 'OPENCLAW RESULT', responseMode = settings.openclawMode || 'assist') {
    const envelope = responseMode === 'operate'
        ? parseOpenClawOperateEnvelope(data.reply, data.operateEnvelope)
        : null;

    saveOpenClawChatState({
        lastReply: data.reply,
        lastSessionId: data.sessionId,
        lastOperateEnvelope: envelope,
    });
    syncOpenClawView();
    appendOpenClawLog(logTitle, JSON.stringify({
        sessionId: data.sessionId,
        reply: data.reply,
        operateEnvelope: envelope,
    }, null, 2));
    return envelope;
}

function formatOpenClawResult(result) {
    if (result == null) return '(no output)';
    if (typeof result === 'string') return result.trim() || '(empty string)';
    try {
        return JSON.stringify(result, null, 2);
    } catch {
        return String(result);
    }
}

function renderOpenClawActions() {
    const chatState = getOpenClawChatState();
    const { actions, actionState } = getOpenClawEls();
    if (!actions || !actionState) return;

    const envelope = chatState.lastOperateEnvelope;
    if (!envelope?.actions?.length) {
        actions.innerHTML = '<div class="cx-openclaw-empty">No pending local actions.</div>';
        actionState.textContent = settings.openclawMode === 'operate'
            ? 'Operate mode can propose slash.run actions here.'
            : 'Switch to operate mode to receive actionable proposals.';
        return;
    }

    actionState.textContent = envelope.summary || 'OpenClaw proposed local actions.';
    actions.innerHTML = envelope.actions.map(action => `
        <div class="cx-openclaw-action-card" data-action-id="${escapeHtml(action.id)}">
            <div class="cx-openclaw-action-head">
                <strong>${escapeHtml(action.title)}</strong>
                <span class="cx-openclaw-action-type">${escapeHtml(action.type)}</span>
            </div>
            <pre class="cx-openclaw-action-command">${escapeHtml(action.command)}</pre>
            ${action.reason ? `<div class="cx-openclaw-action-reason">${escapeHtml(action.reason)}</div>` : ''}
            <div class="cx-openclaw-action-receipt">${escapeHtml(action.receipt || `Status: ${action.status}`)}</div>
            <div class="cx-openclaw-actions">
                <button data-ocb-approve="${escapeHtml(action.id)}" ${action.status !== 'pending' ? 'disabled' : ''}>Approve</button>
                <button data-ocb-reject="${escapeHtml(action.id)}" ${action.status !== 'pending' ? 'disabled' : ''}>Reject</button>
            </div>
        </div>
    `).join('');
}

function syncOpenClawView() {
    const chatState = getOpenClawChatState();
    const { session, reply, mode } = getOpenClawEls();
    if (session) session.textContent = chatState.lastSessionId || '(not used yet)';
    if (reply) reply.textContent = chatState.lastReply || '(no reply yet)';
    if (mode) mode.value = settings.openclawMode || 'assist';
    renderOpenClawActions();
}

function insertContextIntoOpenClawPrompt() {
    const { prompt } = getOpenClawEls();
    if (!prompt) return;
    const ctx = getContext();
    const lines = getRecentMessages().map(message => `${message.name}: ${message.text}`);
    const block = [
        `Mode: ${settings.openclawMode || 'assist'}`,
        `Chat ID: ${currentChatId()}`,
        `Character ID: ${ctx.characterId}`,
        `Group ID: ${ctx.groupId}`,
        '',
        ...lines,
    ].join('\n');
    prompt.value = prompt.value ? `${prompt.value}\n\n${block}` : block;
    setOpenClawStatus('Inserted current SillyTavern context.');
}

async function checkOpenClawHealth() {
    setOpenClawStatus('Checking bridge health...');
    const data = await callOpenClawBridge('/health');
    appendOpenClawLog('HEALTH', JSON.stringify(data, null, 2));
    setOpenClawStatus(`Bridge healthy: ${data.version}`);
}

async function refreshOpenClawSessionStatus() {
    setOpenClawStatus('Checking session status...');
    const chatState = getOpenClawChatState();
    const params = new URLSearchParams({
        chatId: currentChatId(),
        resetNonce: String(chatState.resetNonce || 0),
    });
    const data = await callOpenClawBridge(`/session/status?${params.toString()}`);
    saveOpenClawChatState({ lastSessionId: data.sessionId });
    syncOpenClawView();
    appendOpenClawLog('SESSION STATUS', JSON.stringify(data, null, 2));
    setOpenClawStatus(data.sessionFound ? `Session ready: ${data.sessionId} (existing)` : `Session ready: ${data.sessionId}`);
}

async function sendToOpenClaw() {
    const { prompt } = getOpenClawEls();
    const ctx = getContext();
    const userPrompt = String(prompt?.value || '').trim();
    if (!userPrompt) {
        setOpenClawStatus('Write a prompt first.');
        return;
    }

    const chatState = getOpenClawChatState();
    setOpenClawStatus('Sending to OpenClaw...');

    const data = await callOpenClawBridge('/session/message', {
        method: 'POST',
        body: {
            mode: settings.openclawMode || 'assist',
            chatId: currentChatId(),
            characterId: ctx.characterId,
            groupId: ctx.groupId,
            resetNonce: chatState.resetNonce || 0,
            userPrompt,
            recentMessages: getRecentMessages(),
        },
    });

    const envelope = applyOpenClawResponse(data, 'OPENCLAW RESULT', settings.openclawMode || 'assist');
    setOpenClawStatus(envelope ? `OpenClaw proposed ${envelope.actions.length} local action(s).` : `OpenClaw replied on ${data.sessionId}.`);
}

async function sendOpenClawOperateReceipt(userPrompt, logTitle) {
    const ctx = getContext();
    const chatState = getOpenClawChatState();
    const data = await callOpenClawBridge('/session/message', {
        method: 'POST',
        body: {
            mode: 'operate',
            chatId: currentChatId(),
            characterId: ctx.characterId,
            groupId: ctx.groupId,
            resetNonce: chatState.resetNonce || 0,
            userPrompt,
            recentMessages: getRecentMessages(),
        },
    });
    return applyOpenClawResponse(data, logTitle, 'operate');
}

async function resetOpenClawSession() {
    const state = getOpenClawChatState();
    const nextNonce = Number(state.resetNonce || 0) + 1;
    const data = await callOpenClawBridge('/session/reset', {
        method: 'POST',
        body: {
            chatId: currentChatId(),
            resetNonce: nextNonce,
        },
    });
    saveOpenClawChatState({
        resetNonce: nextNonce,
        lastSessionId: data.sessionId,
        lastReply: '',
        lastOperateEnvelope: null,
    });
    syncOpenClawView();
    appendOpenClawLog('SESSION RESET', JSON.stringify(data, null, 2));
    setOpenClawStatus(`Switched to ${data.sessionId}.`);
}

async function executeOpenClawSlashCommand(text) {
    return getContext().executeSlashCommandsWithOptions(text, {
        handleExecutionErrors: true,
        source: 'command-x-openclaw',
    });
}

async function approveOpenClawAction(actionId) {
    const chatState = getOpenClawChatState();
    const envelope = chatState.lastOperateEnvelope;
    const action = envelope?.actions?.find(item => item.id === actionId);
    if (!action || action.status !== 'pending') return;

    action.status = 'running';
    action.receipt = 'Executing locally...';
    saveOpenClawChatState({ lastOperateEnvelope: envelope });
    syncOpenClawView();
    setOpenClawStatus(`Running ${action.command}`);

    try {
        const result = await executeOpenClawSlashCommand(action.command);
        const receipt = formatOpenClawResult(result);
        action.status = 'approved';
        action.receipt = `Approved and executed.\n\n${receipt}`;
        saveOpenClawChatState({ lastOperateEnvelope: envelope });
        syncOpenClawView();
        appendOpenClawLog('OPERATE ACTION APPROVED', JSON.stringify({ actionId, command: action.command, receipt }, null, 2));
        const followUp = await sendOpenClawOperateReceipt([
            `Action receipt for ${action.id}:`,
            `- decision: approved`,
            `- type: ${action.type}`,
            `- command: ${action.command}`,
            '- result:',
            receipt,
        ].join('\n'), 'OPERATE FOLLOW-UP');
        setOpenClawStatus(followUp ? 'Action executed. OpenClaw sent a follow-up proposal.' : 'Action executed. OpenClaw received the result.');
    } catch (error) {
        const receipt = String(error?.message || error);
        action.status = 'failed';
        action.receipt = `Execution failed.\n\n${receipt}`;
        saveOpenClawChatState({ lastOperateEnvelope: envelope });
        syncOpenClawView();
        appendOpenClawLog('OPERATE ACTION ERROR', JSON.stringify({ actionId, command: action.command, error: receipt }, null, 2));
        const followUp = await sendOpenClawOperateReceipt([
            `Action receipt for ${action.id}:`,
            `- decision: approved`,
            `- type: ${action.type}`,
            `- command: ${action.command}`,
            '- outcome: execution_error',
            '- error:',
            receipt,
        ].join('\n'), 'OPERATE FOLLOW-UP');
        setOpenClawStatus(followUp ? 'Execution failed. OpenClaw proposed a next step.' : 'Execution failed. OpenClaw received the error.');
    }
}

async function rejectOpenClawAction(actionId) {
    const chatState = getOpenClawChatState();
    const envelope = chatState.lastOperateEnvelope;
    const action = envelope?.actions?.find(item => item.id === actionId);
    if (!action || action.status !== 'pending') return;

    action.status = 'rejected';
    action.receipt = 'Rejected locally. Command was not run.';
    saveOpenClawChatState({ lastOperateEnvelope: envelope });
    syncOpenClawView();
    appendOpenClawLog('OPERATE ACTION REJECTED', JSON.stringify({ actionId, command: action.command }, null, 2));
    setOpenClawStatus('Action rejected. Sending receipt back to OpenClaw...');
    const followUp = await sendOpenClawOperateReceipt([
        `Action receipt for ${action.id}:`,
        '- decision: rejected',
        `- type: ${action.type}`,
        `- command: ${action.command}`,
        '- note: The local operator rejected this action and it was not executed.',
    ].join('\n'), 'OPERATE FOLLOW-UP');
    setOpenClawStatus(followUp ? 'Action rejected. OpenClaw proposed an alternative.' : 'Action rejected. OpenClaw received the rejection.');
}

async function runOpenClawSlashLocally() {
    const { prompt } = getOpenClawEls();
    const text = String(prompt?.value || '').trim();
    if (!text.startsWith('/')) {
        setOpenClawStatus('Local action expects a slash command starting with /.');
        return;
    }

    try {
        const result = await executeOpenClawSlashCommand(text);
        appendOpenClawLog('LOCAL SLASH', `${text}\n\n${formatOpenClawResult(result)}`);
        setOpenClawStatus('Ran slash command locally.');
    } catch (error) {
        appendOpenClawLog('LOCAL SLASH ERROR', String(error?.message || error));
        setOpenClawStatus(String(error?.message || error));
    }
}

function clearOpenClawPrompt() {
    const { prompt } = getOpenClawEls();
    if (prompt) prompt.value = '';
    setOpenClawStatus('Cleared prompt.');
}

/* ======================================================================
   COMPOSE QUEUE — batch multiple texts before sending to LLM
   ====================================================================== */

let composeQueue = []; // [{contactName, text, displayText, isNeural, cmdType}]

function addToQueue(contactName, text, displayText, isNeural, cmdType) {
    composeQueue.push({ contactName, text, displayText, isNeural, cmdType });
    updateQueueBar();
}

function clearQueue() {
    composeQueue = [];
    updateQueueBar();
}

function updateQueueBar() {
    const bar = phoneContainer?.querySelector('#cx-queue-bar');
    if (!bar) return;
    if (composeQueue.length === 0 || !settings.batchMode) {
        bar.classList.add('cx-hidden');
        return;
    }
    const names = [...new Set(composeQueue.map(q => q.contactName))];
    const label = composeQueue.length === 1
        ? `1 text to ${names[0]}`
        : `${composeQueue.length} texts to ${names.join(', ')}`;
    bar.querySelector('.cx-queue-label').textContent = label;
    bar.classList.remove('cx-hidden');
}

function flushQueue() {
    if (!composeQueue.length) return;

    // Build batched RP message
    const rpParts = composeQueue.map(q => {
        if (q.cmdType || q.isNeural) {
            return `*opens Command-X and sends a neural command to ${q.contactName}:*\n${q.text}`;
        } else {
            return `*texts ${q.contactName} on phone:*\n"${q.text}"`;
        }
    });
    const batchedMessage = rpParts.join('\n\n');

    // Build targets for prompt injection
    const targets = composeQueue.map(q => ({
        name: q.contactName,
        isNeural: q.isNeural,
        cmdType: q.cmdType,
    }));

    // Inject prompt for all targets
    injectSmsPrompt(targets);
    awaitingReply = true;

    // Send to ST
    const textarea = document.querySelector('#send_textarea');
    if (textarea) {
        textarea.value = batchedMessage;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        const sendBtn = document.querySelector('#send_but');
        if (sendBtn) sendBtn.click();
    }

    // Show typing indicator in current chat if one of the targets
    const currentInQueue = composeQueue.some(q => q.contactName === currentContactName);
    if (currentInQueue) {
        clearTypingIndicator();
        const area = phoneContainer?.querySelector('#cx-msg-area');
        if (area) {
            const typing = document.createElement('div');
            typing.id = 'cx-typing-indicator';
            typing.className = 'cx-typing-row';
            typing.innerHTML = `<div class="cx-typing-bubble"><span></span><span></span><span></span></div>`;
            area.appendChild(typing);
            area.scrollTop = area.scrollHeight;
        }
        typingTimeout = setTimeout(() => {
            clearTypingIndicator();
            if (awaitingReply) awaitingReply = false;
        }, 30000);
    }

    clearQueue();
}

/* ======================================================================
   SMS TAG PARSING
   We instruct the LLM to wrap phone replies in [sms]…[/sms].
   ====================================================================== */

const SMS_TAG_RE = /\[sms([^\]]*)\]([\s\S]*?)\[\/sms\]/gi;
const SMS_ATTR_RE = /(\w+)="([^"]*)"/g;

/**
 * Parse attributes from an [sms ...] tag's attribute string.
 */
function parseSmsAttrs(attrStr) {
    const attrs = {};
    if (!attrStr) return attrs;
    let m;
    SMS_ATTR_RE.lastIndex = 0;
    while ((m = SMS_ATTR_RE.exec(attrStr)) !== null) {
        attrs[m[1].toLowerCase()] = m[2].trim();
    }
    return attrs;
}

/**
 * Extract all [sms]…[/sms] blocks from a message string.
 * Supports optional from/to attributes: [sms from="Name" to="user"]...[/sms]
 * Returns array of {from, to, text} objects, or null if no tags found.
 */
function extractSmsBlocks(raw) {
    if (!raw) return null;
    const blocks = [];
    let m;
    SMS_TAG_RE.lastIndex = 0;
    while ((m = SMS_TAG_RE.exec(raw)) !== null) {
        const attrs = parseSmsAttrs(m[1]);
        const text = m[2].trim();
        if (text) blocks.push({ from: attrs.from || null, to: attrs.to || null, text });
    }
    return blocks.length ? blocks : null;
}

/** Legacy compat wrapper — returns concatenated text or null */
function extractSmsContent(raw) {
    const blocks = extractSmsBlocks(raw);
    if (!blocks) return null;
    return blocks.map(b => b.text).join('\n');
}

/**
 * Hide [sms]…[/sms] tags in the rendered ST message DOM,
 * replacing them with a styled "📱 Text sent" indicator.
 */
function hideSmsTagsInDom(mesId) {
    const el = document.querySelector(`.mes[mesid="${mesId}"] .mes_text`);
    if (!el) return;
    SMS_TAG_RE.lastIndex = 0;
    if (SMS_TAG_RE.test(el.innerHTML)) {
        SMS_TAG_RE.lastIndex = 0;
        el.innerHTML = el.innerHTML.replace(SMS_TAG_RE, (_match, attrStr, inner) => {
            const attrs = parseSmsAttrs(attrStr);
            const preview = inner.trim();
            const label = attrs.from ? `📱 ${attrs.from}: ` : '📱 ';
            return `<span class="cx-sms-inline" title="${preview.replace(/"/g, '&quot;')}">${label}<em>${preview.slice(0, 50)}${preview.length > 50 ? '…' : ''}</em></span>`;
        });
    }
}

/* ======================================================================
   NPC CONTACT STORE — localStorage-backed, keyed per chat
   ====================================================================== */

const CONTACTS_TAG_RE = /\[(?:contacts|status)\]([\s\S]*?)\[\/(?:contacts|status)\]/gi;

function npcStoreKey() {
    const ctx = getContext();
    const chatId = ctx.chatId || ctx.groupId || 'default';
    return `cx-npcs-${chatId}`;
}

function loadNpcs() {
    try { return JSON.parse(localStorage.getItem(npcStoreKey()) || '[]'); }
    catch { return []; }
}

function saveNpcs(npcs) {
    try { localStorage.setItem(npcStoreKey(), JSON.stringify(npcs.slice(-50))); }
    catch (e) { console.warn('[command-x] npc store save', e); }
}

/**
 * Parse [status] (or legacy [contacts]) JSON from a message.
 * [status][{"name":"Sarah","emoji":"👩","status":"online","mood":"😊 happy","location":"home","relationship":"friendly","thoughts":"..."}][/status]
 */
function extractContacts(raw) {
    if (!raw) return null;
    CONTACTS_TAG_RE.lastIndex = 0;
    const m = CONTACTS_TAG_RE.exec(raw);
    if (!m) return null;
    try {
        const arr = JSON.parse(m[1].trim());
        if (!Array.isArray(arr)) return null;
        return arr.filter(c => c && typeof c.name === 'string').map(c => ({
            name: c.name.trim(),
            emoji: c.emoji || '🧑',
            status: c.status || 'nearby',
            mood: c.mood || null,
            location: c.location || null,
            relationship: c.relationship || null,
            thoughts: c.thoughts || null,
        }));
    } catch (e) {
        console.warn('[command-x] failed to parse [status] JSON:', e);
        return null;
    }
}

/**
 * Merge parsed NPCs into the stored list. Existing NPCs with the same
 * name are updated; new ones are appended.
 */
function mergeNpcs(incoming) {
    if (!incoming || !incoming.length) return;
    const stored = loadNpcs();
    for (const npc of incoming) {
        const idx = stored.findIndex(s => s.name.toLowerCase() === npc.name.toLowerCase());
        if (idx >= 0) stored[idx] = { ...stored[idx], ...npc };
        else stored.push(npc);
    }
    saveNpcs(stored);
}

/** Hide [contacts] tags in rendered ST chat DOM */
function hideContactsTagsInDom(mesId) {
    const el = document.querySelector(`.mes[mesid="${mesId}"] .mes_text`);
    if (!el) return;
    CONTACTS_TAG_RE.lastIndex = 0;
    if (CONTACTS_TAG_RE.test(el.innerHTML)) {
        CONTACTS_TAG_RE.lastIndex = 0;
        el.innerHTML = el.innerHTML.replace(CONTACTS_TAG_RE, '');
    }
}

/**
 * Inject persistent [contacts] prompt — always active when extension
 * is enabled and a chat is open, so the LLM continuously reports NPCs.
 */
function injectContactsPrompt() {
    const ctx = getContext();
    const userName = ctx.name1 || '';
    const charName = ctx.name2 || '';
    const excludeNote = [userName, charName].filter(Boolean).map(n => `"${n}"`).join(' or ');
    setExtensionPrompt(
        INJECT_KEY_CONTACTS,
        `[System: At the end of each response, include a [status] block with a JSON array of NPCs/side characters. Format: [status][{"name":"Name","emoji":"👩","status":"online","mood":"😊 happy","location":"her apartment","relationship":"friendly","thoughts":"wondering about dinner"}][/status] — "status" can be "online"/"offline"/"nearby". "mood" is an emoji + short descriptor. "location" is where they currently are. "relationship" is how they feel about the user (friendly/neutral/hostile/romantic/etc). "thoughts" is a brief inner thought. Only include side characters/NPCs who exist in the scene. Do NOT include ${excludeNote || 'the user or the main character'}. If no NPCs are relevant, omit the [status] block entirely.]`,
        extension_prompt_types.IN_CHAT,
        2,       // depth = 2 (slightly further back than [sms])
        false,
        extension_prompt_roles.SYSTEM,
    );
}

function clearContactsPrompt() {
    setExtensionPrompt(INJECT_KEY_CONTACTS, '', extension_prompt_types.NONE, 0);
}

/* ======================================================================
   PROMPT INJECTION
   When the user sends a phone message, we inject a system instruction
   so the LLM knows to include [sms] tags in its response.
   ====================================================================== */

/**
 * Build a single SMS prompt instruction for one target.
 */
function buildSmsInstruction(contactName, isNeural, cmdType) {
    if (isNeural && cmdType) {
        const cmdContext = {
            COMMAND: `The neural command takes effect subliminally — ${contactName} is completely unaware any command was sent. They simply feel an irresistible compulsion to comply, as if it were their own idea. They do NOT see, read, or acknowledge the command itself.`,
            FORGET: `The neural command takes effect subliminally — ${contactName} is completely unaware their memory is being altered. The specified memory or knowledge simply fades away. They do NOT see, read, or acknowledge any command.`,
            BELIEVE: `The neural command takes effect subliminally — ${contactName} is completely unaware their perception is being rewritten. They now genuinely believe the stated thing as absolute truth, as if they always believed it. They do NOT see, read, or acknowledge any command.`,
            COMPEL: `The neural command takes effect subliminally — ${contactName} is completely unaware of any external influence. They feel an overwhelming urge driving them toward the specified behavior, but it feels entirely like their own desire. They do NOT see, read, or acknowledge any command.`,
        }[cmdType] || '';
        return `A subliminal ${cmdType} neural command was activated targeting ${contactName}. ${cmdContext} ${contactName} responds naturally — influenced but unaware. Wrap their reply to the user in [sms from="${contactName}" to="user"]...[/sms].`;
    } else if (isNeural) {
        return `A subliminal neural command was activated targeting ${contactName}. They respond naturally, subtly influenced but unaware. Wrap their reply to the user in [sms from="${contactName}" to="user"]...[/sms].`;
    } else {
        return `The user texted ${contactName}. ${contactName} texts back naturally and in-character. Wrap their reply to the user in [sms from="${contactName}" to="user"]...[/sms].`;
    }
}

/**
 * Inject SMS prompt for one or more targets.
 * @param {Array<{name:string, isNeural:boolean, cmdType:string|null}>} targets
 */
function injectSmsPrompt(targets) {
    if (!Array.isArray(targets)) {
        // Legacy single-call compat: injectSmsPrompt(name, isNeural, cmdType)
        targets = [{ name: arguments[0], isNeural: arguments[1], cmdType: arguments[2] }];
    }
    const parts = targets.map(t => buildSmsInstruction(t.name, t.isNeural, t.cmdType));
    const names = targets.map(t => t.name);
    const multi = targets.length > 1;

    let instruction = `[System: ${parts.join(' ')}`;
    if (multi) {
        instruction += ` Include a separate [sms from="Name"] block for EACH person who was texted/commanded. Each person replies independently.`;
    }
    instruction += ` Example: *She glanced at her phone.* [sms from="${names[0]}" to="user"]hey yeah on my way[/sms] *She set it down.*`;
    if (multi) {
        instruction += ` [sms from="${names[1] || names[0]}" to="user"]sounds good[/sms]`;
    }
    instruction += ` — The [sms] block is phone text content only. Always include from and to attributes. Only use to="user" for texts directed at the user's phone. If characters text each other, do NOT use [sms] tags — just narrate it normally.]`;

    setExtensionPrompt(
        INJECT_KEY,
        instruction,
        extension_prompt_types.IN_CHAT,
        1,       // depth = 1 (right before the last message)
        false,
        extension_prompt_roles.SYSTEM,
    );
}

function clearSmsPrompt() {
    setExtensionPrompt(INJECT_KEY, '', extension_prompt_types.NONE, 0);
}

/* ======================================================================
   MESSAGE STORE — localStorage-backed, keyed per chat+contact
   ====================================================================== */

function storeKey(contactName) {
    const ctx = getContext();
    const chatId = ctx.chatId || ctx.groupId || 'default';
    return `cx-msgs-${chatId}-${contactName}`;
}

function loadMessages(contactName) {
    try { return JSON.parse(localStorage.getItem(storeKey(contactName)) || '[]'); }
    catch { return []; }
}

function saveMessages(contactName, msgs) {
    try { localStorage.setItem(storeKey(contactName), JSON.stringify(msgs.slice(-200))); }
    catch (e) { console.warn('[command-x] store save', e); }
}

function pushMessage(contactName, type, text, mesId) {
    const msgs = loadMessages(contactName);
    msgs.push({ type, text, time: now(), ts: Date.now(), mesId: mesId ?? null });
    saveMessages(contactName, msgs);
}

/* ======================================================================
   UNREAD COUNTS — localStorage-backed
   ====================================================================== */

function unreadKey(contactName) {
    const ctx = getContext();
    const chatId = ctx.chatId || ctx.groupId || 'default';
    return `cx-unread-${chatId}-${contactName}`;
}

function getUnread(contactName) {
    return parseInt(localStorage.getItem(unreadKey(contactName)) || '0', 10);
}

function incrementUnread(contactName) {
    const n = getUnread(contactName) + 1;
    localStorage.setItem(unreadKey(contactName), String(n));
    updateUnreadBadges();
}

function showToast(contactName, text) {
    // Remove existing toast
    document.getElementById('cx-toast')?.remove();
    const preview = text.length > 60 ? text.slice(0, 60) + '…' : text;
    const toast = document.createElement('div');
    toast.id = 'cx-toast';
    toast.className = 'cx-toast cx-toast-show';
    toast.innerHTML = `<div class="cx-toast-icon">📱</div><div class="cx-toast-body"><div class="cx-toast-name">${contactName}</div><div class="cx-toast-text">${escHtml(preview)}</div></div>`;
    toast.addEventListener('click', () => {
        toast.remove();
        // Open phone to this contact's chat
        const wrapper = document.getElementById('cx-panel-wrapper');
        if (wrapper) {
            wrapper.classList.remove('cx-hidden');
            settings.panelOpen = true;
            saveSettings();
            rebuildPhone();
            openChat(contactName, 'cmdx');
        }
    });
    document.body.appendChild(toast);
    // Auto-dismiss after 4s
    setTimeout(() => { toast.classList.remove('cx-toast-show'); setTimeout(() => toast.remove(), 400); }, 4000);
}

function markRead(contactName) {
    localStorage.removeItem(unreadKey(contactName));
    updateUnreadBadges();
}

function getTotalUnread() {
    const contacts = getContactsFromContext();
    return contacts.reduce((sum, c) => sum + getUnread(c.name), 0);
}

function updateUnreadBadges() {
    // Update contact row badges
    phoneContainer?.querySelectorAll('.cx-contact-row').forEach(row => {
        const name = row.dataset.cname;
        if (!name) return;
        let badge = row.querySelector('.cx-unread-badge');
        const count = getUnread(name);
        if (count > 0) {
            if (!badge) {
                badge = document.createElement('div');
                badge.className = 'cx-unread-badge';
                row.querySelector('.cx-status-col')?.prepend(badge);
            }
            badge.textContent = count > 99 ? '99+' : count;
        } else {
            badge?.remove();
        }
    });
    // Update phone toggle button badge
    const menuBtn = document.querySelector('#cx-menu-button');
    if (menuBtn) {
        let dot = menuBtn.querySelector('.cx-menu-badge');
        const total = getTotalUnread();
        if (total > 0) {
            if (!dot) {
                dot = document.createElement('span');
                dot.className = 'cx-menu-badge';
                menuBtn.appendChild(dot);
            }
            dot.textContent = total > 99 ? '99+' : total;
        } else {
            dot?.remove();
        }
    }
}

/**
 * Remove all phone messages associated with a given ST message ID
 * (for handling swipes/regenerations). Scans ALL contacts for this chat.
 */
function removeMessagesForMesId(mesId) {
    if (mesId == null) return;
    const allContacts = getContactsFromContext();
    for (const c of allContacts) {
        const msgs = loadMessages(c.name);
        const filtered = msgs.filter(m => m.mesId !== mesId);
        if (filtered.length !== msgs.length) {
            saveMessages(c.name, filtered);
        }
    }
}

/* ======================================================================
   CONTEXT HELPERS
   ====================================================================== */

function getChatCharacters() {
    const ctx = getContext();
    const chars = [];
    if (ctx.groupId) {
        const group = Object.values(ctx.groups || {}).find(g => g.id === ctx.groupId);
        if (group?.members) {
            for (const avatar of group.members) {
                const char = (ctx.characters || []).find(c => c.avatar === avatar);
                if (char) chars.push(char);
            }
        }
    } else if (ctx.characterId !== undefined) {
        const char = ctx.characters?.[ctx.characterId];
        if (char) chars.push(char);
    }
    return chars;
}

function getContactsFromContext() {
    const chars = getChatCharacters();
    const ctx = getContext();
    const userName = (ctx.name1 || '').toLowerCase();
    const emojis = ['👩','👩‍🦰','👱‍♀️','👩‍🏫','🧑','👨','👩‍🎤','🧑‍💼','👧','🧝‍♀️'];
    const gradients = [
        'linear-gradient(135deg,#553355,#442244)',
        'linear-gradient(135deg,#334455,#223344)',
        'linear-gradient(135deg,#ffaa88,#ff7755)',
        'linear-gradient(135deg,#88aacc,#557799)',
        'linear-gradient(135deg,#55aa77,#338855)',
        'linear-gradient(135deg,#aa5577,#883355)',
    ];
    const storedNpcs = loadNpcs();
    // ST characters — filter out user persona, merge any stored NPC state
    const contacts = chars
        .filter(c => (c.name || '').toLowerCase() !== userName)
        .map((c, i) => {
            const npcData = storedNpcs.find(n => n.name.toLowerCase() === (c.name || '').toLowerCase());
            // Use ST thumbnail if character has an avatar file
            let thumbUrl = null;
            if (c.avatar && typeof c.avatar === 'string' && !c.avatar.startsWith('none')) {
                try { thumbUrl = `/thumbnail?type=avatar&file=${encodeURIComponent(c.avatar)}`; }
                catch { /* ignore */ }
            }
            return {
                id: c.avatar || `char_${i}`,
                name: c.name || `Character ${i + 1}`,
                emoji: npcData?.emoji || emojis[i % emojis.length],
                gradient: gradients[i % gradients.length],
                online: true,
                isNpc: false,
                mood: npcData?.mood || null,
                location: npcData?.location || null,
                relationship: npcData?.relationship || null,
                thoughts: npcData?.thoughts || null,
                avatarUrl: npcData?.avatarUrl || thumbUrl || null,
            };
        });
    // Merge stored NPCs (skip duplicates by name + skip user persona)
    const existingNames = new Set(contacts.map(c => c.name.toLowerCase()));
    const npcs = storedNpcs.filter(n => (n.name || '').toLowerCase() !== userName);
    for (let i = 0; i < npcs.length; i++) {
        if (existingNames.has(npcs[i].name.toLowerCase())) continue;
        contacts.push({
            id: `npc_${i}`,
            name: npcs[i].name,
            emoji: npcs[i].emoji || '🧑',
            gradient: gradients[(chars.length + i) % gradients.length],
            online: npcs[i].status === 'online' || npcs[i].status === 'nearby',
            isNpc: true,
            npcStatus: npcs[i].status || 'nearby',
            mood: npcs[i].mood || null,
            location: npcs[i].location || null,
            relationship: npcs[i].relationship || null,
            thoughts: npcs[i].thoughts || null,
            avatarUrl: npcs[i].avatarUrl || null,
        });
    }
    // Sort by most recent message timestamp (contacts with messages first)
    contacts.sort((a, b) => {
        const aMsgs = loadMessages(a.name);
        const bMsgs = loadMessages(b.name);
        const aTs = aMsgs.length ? (aMsgs[aMsgs.length - 1].ts || 0) : 0;
        const bTs = bMsgs.length ? (bMsgs[bMsgs.length - 1].ts || 0) : 0;
        if (aTs && !bTs) return -1;
        if (!aTs && bTs) return 1;
        return bTs - aTs; // most recent first
    });
    return contacts;
}

const now = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const today = () => new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>'); }

/* ======================================================================
   SEND MESSAGE THROUGH THE RP
   ====================================================================== */

async function sendToChat(text, contactName, isCommand) {
    let formatted;
    if (isCommand) {
        formatted = `*opens Command-X on phone and sends a neural command to ${contactName}:*\n${text}`;
    } else {
        formatted = `*texts ${contactName} on phone:*\n"${text}"`;
    }
    const textarea = document.querySelector('#send_textarea');
    if (textarea) {
        textarea.value = formatted;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        const sendBtn = document.querySelector('#send_but');
        if (sendBtn) sendBtn.click();
    }
}

/** Send immediately (instant mode) — single target */
function sendImmediate(contactName, chatText, isNeural, cmdType) {
    injectSmsPrompt([{ name: contactName, isNeural, cmdType }]);
    awaitingReply = true;
    sendToChat(chatText, contactName, !!cmdType || isNeural);
}

/* ======================================================================
   HTML BUILDERS
   ====================================================================== */

function avatarHTML(c, sizeClass = '') {
    if (c.avatarUrl) {
        return `<div class="cx-avatar ${sizeClass}" style="background:${c.gradient}"><img class="cx-avatar-img" src="${c.avatarUrl}" alt="" onerror="this.style.display='none';this.nextSibling.style.display=''"><span style="display:none">${c.emoji}</span></div>`;
    }
    return `<div class="cx-avatar ${sizeClass}" style="background:${c.gradient}">${c.emoji}</div>`;
}

function contactRowHTML(c, i, app) {
    const msgs = loadMessages(c.name);
    const last = msgs.length ? msgs[msgs.length - 1] : null;
    const preview = last ? (last.type.startsWith('sent') ? `You: ${last.text}` : last.text) : 'Tap to chat';
    const previewTrunc = preview.length > 38 ? preview.slice(0, 38) + '…' : preview;
    const npcBadge = c.isNpc ? '<span class="cx-npc-badge">NPC</span>' : '';

    return `
    <div class="cx-contact-row" data-idx="${i}" data-app="${app}" data-cid="${c.id}" data-cname="${c.name}">
        ${avatarHTML(c)}
        <div class="cx-contact-info">
            <div class="cx-contact-name">${c.name} ${npcBadge}</div>
            <div class="cx-contact-preview">${escHtml(previewTrunc)}</div>
        </div>
        <div class="cx-status-col">
            ${c.online ? '<div class="cx-dot-online"></div>' : '<div class="cx-dot-offline"></div>'}
            ${last ? `<div class="cx-status-time">${last.time || ''}</div>` : ''}
        </div>
    </div>`;
}

function buildPhone() {
    const contacts = getContactsFromContext();
    const hasContacts = contacts.length > 0;
    const lockActive = settings.showLockscreen ? 'active' : '';
    const homeActive = settings.showLockscreen ? '' : 'active';
    const charName = hasContacts ? contacts[0].name : 'No character';

    return `
    <div class="cx-device" id="cx-phone">
      <div class="cx-screen">
        <div class="cx-statusbar">
            <span class="cx-sig" id="cx-clock">${now()}</span>
            <span class="cx-batt">📶 🔋 73%</span>
        </div>

        <!-- Lock Screen -->
        <div class="cx-view cx-lock ${lockActive}" data-view="lock">
            <div class="cx-lock-time">${now()}</div>
            <div class="cx-lock-date">${today()}</div>
            ${hasContacts ? `
            <div class="cx-notif" data-goto="cmdx">
                <div class="cx-notif-app">COMMAND-X</div>
                <div class="cx-notif-title">Neural Link Active</div>
                <div class="cx-notif-body">${contacts.length} contact${contacts.length > 1 ? 's' : ''} synced. Tap to open.</div>
            </div>` : ''}
            <div class="cx-lock-hint" data-action="unlock">Tap to unlock</div>
        </div>

        <!-- Home Screen -->
        <div class="cx-view cx-home ${homeActive}" data-view="home">
            <div class="cx-home-time">${now()}</div>
            <div class="cx-home-date">${today()}</div>
            <div class="cx-app-grid">
                <div class="cx-app-icon" data-app="cmdx">
                    <div class="cx-icon-img cx-icon-cmdx">⚡</div>
                    <div class="cx-icon-label">Command-X</div>
                </div>
                <div class="cx-app-icon" data-app="profiles">
                    <div class="cx-icon-img cx-icon-profiles">🔍</div>
                    <div class="cx-icon-label">Profiles</div>
                </div>
                <div class="cx-app-icon" data-app="openclaw">
                    <div class="cx-icon-img cx-icon-openclaw">🦞</div>
                    <div class="cx-icon-label">OpenClaw</div>
                </div>
                <div class="cx-app-icon" data-app="phone-settings">
                    <div class="cx-icon-img cx-icon-settings">⚙️</div>
                    <div class="cx-icon-label">Settings</div>
                </div>
            </div>
        </div>

        <!-- Command-X App (unified messaging + neural commands) -->
        <div class="cx-view" data-view="cmdx">
            <div class="cx-cmdx-header">
                <div class="cx-cmdx-title">COMMAND-X</div>
                <div class="cx-cmdx-sub">NETHERTECH INDUSTRIES v3.4.2</div>
            </div>
            <div class="cx-sync-bar">✓ Neural Link Stable · ${hasContacts ? contacts.length + ' Contact' + (contacts.length > 1 ? 's' : '') + ' Synced' : 'No Contacts Found'}</div>
            <div class="cx-contact-list">
                ${hasContacts ? contacts.map((c, i) => contactRowHTML(c, i, 'cmdx')).join('') : '<div style="padding:20px;color:#666;text-align:center">No characters in current chat</div>'}
            </div>
            <div class="cx-navbar">
                <div class="cx-nav active"><div class="cx-nav-ico">💬</div><div class="cx-nav-lbl">Chats</div></div>
                <div class="cx-nav" data-goto="home"><div class="cx-nav-ico">🏠</div><div class="cx-nav-lbl">Home</div></div>
            </div>
        </div>

        <!-- Profiles View -->
        <div class="cx-view" data-view="profiles">
            <div class="cx-profiles-header">
                <div class="cx-profiles-title">Profiles</div>
                <div class="cx-profiles-sub">Contact Intelligence</div>
            </div>
            <div class="cx-profiles-list">
                ${hasContacts ? contacts.map(c => `
                <div class="cx-profile-card" data-pname="${c.name}">
                    <div class="cx-profile-top">
                        ${avatarHTML(c, 'cx-avatar-lg')}
                        <div class="cx-profile-name-col">
                            <div class="cx-profile-name">${c.name} ${c.isNpc ? '<span class="cx-npc-badge">NPC</span>' : ''}</div>
                            <div class="cx-profile-status">${c.mood || (c.online ? '🟢 Online' : '⚫ Offline')}</div>
                        </div>
                    </div>
                    <div class="cx-profile-fields">
                        ${c.location ? `<div class="cx-profile-field"><span class="cx-pf-label">📍 Location</span><span class="cx-pf-value">${escHtml(c.location)}</span></div>` : ''}
                        ${c.relationship ? `<div class="cx-profile-field"><span class="cx-pf-label">💬 Relationship</span><span class="cx-pf-value">${escHtml(c.relationship)}</span></div>` : ''}
                        ${c.thoughts ? `<div class="cx-profile-field"><span class="cx-pf-label">💭 Thoughts</span><span class="cx-pf-value cx-pf-italic">${escHtml(c.thoughts)}</span></div>` : ''}
                        ${!c.location && !c.relationship && !c.thoughts ? '<div class="cx-profile-field"><span class="cx-pf-value" style="color:#666">No intel yet</span></div>' : ''}
                    </div>
                </div>`).join('') : '<div style="padding:20px;color:#666;text-align:center">No contacts in current chat</div>'}
            </div>
            <div class="cx-navbar">
                <div class="cx-nav active"><div class="cx-nav-ico">🔍</div><div class="cx-nav-lbl">Profiles</div></div>
                <div class="cx-nav" data-goto="home"><div class="cx-nav-ico">🏠</div><div class="cx-nav-lbl">Home</div></div>
            </div>
        </div>

        <!-- Settings View -->
        <div class="cx-view" data-view="phone-settings">
            <div class="cx-settings-header">
                <div class="cx-settings-title">Settings</div>
            </div>
            <div class="cx-settings-list">
                <div class="cx-settings-section">MESSAGING</div>
                <div class="cx-settings-row">
                    <span class="cx-settings-label">Batch Send Mode</span>
                    <label class="cx-toggle"><input type="checkbox" id="cx-set-batch" ${settings.batchMode ? 'checked' : ''}><span class="cx-toggle-slider"></span></label>
                </div>
                <div class="cx-settings-row">
                    <span class="cx-settings-label">Style Commands in Chat</span>
                    <label class="cx-toggle"><input type="checkbox" id="cx-set-style" ${settings.styleCommands ? 'checked' : ''}><span class="cx-toggle-slider"></span></label>
                </div>
                <div class="cx-settings-section">CONTACTS</div>
                <div class="cx-settings-row">
                    <span class="cx-settings-label">Auto-Detect NPCs</span>
                    <label class="cx-toggle"><input type="checkbox" id="cx-set-npcs" ${settings.autoDetectNpcs !== false ? 'checked' : ''}><span class="cx-toggle-slider"></span></label>
                </div>
                <div class="cx-settings-row cx-settings-btn-row">
                    <button class="cx-settings-btn cx-settings-btn-danger" id="cx-set-clear-npcs">Clear All NPC Data</button>
                </div>
                <div class="cx-settings-section">DISPLAY</div>
                <div class="cx-settings-row">
                    <span class="cx-settings-label">Lock Screen on Open</span>
                    <label class="cx-toggle"><input type="checkbox" id="cx-set-lock" ${settings.showLockscreen ? 'checked' : ''}><span class="cx-toggle-slider"></span></label>
                </div>
                <div class="cx-settings-section">ABOUT</div>
                <div class="cx-settings-row cx-settings-about">
                    <div>Command-X v0.10.0</div>
                    <div style="color:#666;font-size:11px;margin-top:4px">By Kyle & Bucky 🦌</div>
                </div>
            </div>
            <div class="cx-navbar">
                <div class="cx-nav active"><div class="cx-nav-ico">⚙️</div><div class="cx-nav-lbl">Settings</div></div>
                <div class="cx-nav" data-goto="home"><div class="cx-nav-ico">🏠</div><div class="cx-nav-lbl">Home</div></div>
            </div>
        </div>

        <!-- OpenClaw View -->
        <div class="cx-view" data-view="openclaw">
            <div class="cx-openclaw-header">
                <div class="cx-openclaw-title">OpenClaw</div>
                <div class="cx-openclaw-sub">Bridge console inside Command-X</div>
            </div>
            <div class="cx-openclaw-body">
                <label class="cx-openclaw-field">
                    <span>Mode</span>
                    <select id="cx-ocb-mode">
                        <option value="observe">observe</option>
                        <option value="assist">assist</option>
                        <option value="operate">operate</option>
                    </select>
                </label>
                <div class="cx-openclaw-actions cx-openclaw-actions-tight">
                    <button id="cx-ocb-health">Health</button>
                    <button id="cx-ocb-session-btn">Session</button>
                    <button id="cx-ocb-reset">Reset</button>
                </div>
                <div class="cx-openclaw-status" id="cx-ocb-status">Ready.</div>
                <div class="cx-openclaw-meta">
                    <div>
                        <span class="cx-openclaw-meta-label">Session</span>
                        <pre id="cx-ocb-session">(not used yet)</pre>
                    </div>
                    <div>
                        <span class="cx-openclaw-meta-label">Last reply</span>
                        <pre id="cx-ocb-reply">(no reply yet)</pre>
                    </div>
                </div>
                <textarea id="cx-ocb-prompt" placeholder="Ask OpenClaw about the current chat, or paste a SillyTavern slash command to run locally."></textarea>
                <div class="cx-openclaw-actions">
                    <button id="cx-ocb-insert">Insert context</button>
                    <button id="cx-ocb-send" class="cx-openclaw-primary">Send</button>
                </div>
                <div class="cx-openclaw-actions">
                    <button id="cx-ocb-slash">Run slash locally</button>
                    <button id="cx-ocb-clear">Clear</button>
                </div>
                <div class="cx-openclaw-meta">
                    <div>
                        <span class="cx-openclaw-meta-label">Proposed actions</span>
                        <div class="cx-openclaw-action-state" id="cx-ocb-actions-state">Switch to operate mode to receive actionable proposals.</div>
                        <div id="cx-ocb-actions-list"><div class="cx-openclaw-empty">No pending local actions.</div></div>
                    </div>
                </div>
                <pre id="cx-ocb-log"></pre>
            </div>
            <div class="cx-navbar">
                <div class="cx-nav active"><div class="cx-nav-ico">🦞</div><div class="cx-nav-lbl">OpenClaw</div></div>
                <div class="cx-nav" data-goto="home"><div class="cx-nav-ico">🏠</div><div class="cx-nav-lbl">Home</div></div>
            </div>
        </div>


        <!-- Chat View -->
        <div class="cx-view" data-view="chat">
            <div class="cx-chat-header">
                <div class="cx-chat-back" id="cx-back">‹</div>
                <div class="cx-chat-header-info">
                    <div class="cx-chat-header-name" id="cx-chat-name"></div>
                    <div class="cx-chat-header-status" id="cx-chat-status"></div>
                </div>
                <div class="cx-neural-toggle" id="cx-neural-toggle" title="Toggle neural commands">⚡</div>
                <div class="cx-batch-toggle ${settings.batchMode ? 'cx-batch-active' : ''}" id="cx-batch-toggle" title="Toggle batch mode (queue texts)">📋</div>
            </div>
            <div class="cx-messages" id="cx-msg-area"></div>
            <div class="cx-cmd-drawer cx-hidden" id="cx-cmd-drawer">
                <div class="cx-cmd-drawer-btns">
                    <button class="cx-cmd-btn cx-cmd-btn-command" data-mode="COMMAND">⚡ Command</button>
                    <button class="cx-cmd-btn cx-cmd-btn-believe" data-mode="BELIEVE">💚 Believe</button>
                    <button class="cx-cmd-btn cx-cmd-btn-forget" data-mode="FORGET">💜 Forget</button>
                    <button class="cx-cmd-btn cx-cmd-btn-compel" data-mode="COMPEL">🔶 Compel</button>
                </div>
            </div>
            <div class="cx-queue-bar cx-hidden" id="cx-queue-bar">
                <span class="cx-queue-label"></span>
                <button class="cx-queue-send" id="cx-queue-send">Send ▶</button>
                <button class="cx-queue-clear" id="cx-queue-clear">✕</button>
            </div>
            <div class="cx-input-bar">
                <input type="text" id="cx-msg-input" placeholder="Type a message..." />
                <button class="cx-send-btn" id="cx-send">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                </button>
            </div>
        </div>

      </div>
    </div>`;
}

/* ======================================================================
   PHONE INTERACTIVITY
   ====================================================================== */

let currentApp = null;
let currentContactName = null;
let awaitingReply = false;
let typingTimeout = null;

function switchView(viewName) {
    const screen = phoneContainer?.querySelector('.cx-screen');
    if (!screen) return;
    screen.querySelectorAll('.cx-view').forEach(v => v.classList.remove('active'));
    const target = screen.querySelector(`.cx-view[data-view="${viewName}"]`);
    if (target) target.classList.add('active');
}

function renderBubble(msg) {
    const div = document.createElement('div');
    const isSent = msg.type === 'sent' || msg.type === 'sent-neural';
    div.className = `cx-sms ${isSent ? 'cx-sms-sent' : 'cx-sms-recv'}${msg.type === 'sent-neural' ? ' cx-sms-neural' : ''}`;
    div.innerHTML = `<span class="cx-sms-body">${escHtml(msg.text)}</span>` +
                    (msg.time ? `<span class="cx-sms-ts">${msg.time}</span>` : '');
    return div;
}

function renderAllBubbles(area, contactName, isNeural) {
    area.innerHTML = '';
    const msgs = loadMessages(contactName);
    if (!msgs.length) {
        area.innerHTML = `<div class="cx-chat-hint">${isNeural ? 'Neural link active. Send a command.' : `Text ${contactName}`}</div>`;
        return;
    }
    for (const m of msgs) area.appendChild(renderBubble(m));
    area.scrollTop = area.scrollHeight;
}

function openChat(contactName, app, preserveState = false) {
    currentContactName = contactName;
    currentApp = app || 'cmdx';
    markRead(contactName);
    if (!preserveState) {
        awaitingReply = false;
        commandMode = null;
        neuralMode = false;
        clearSmsPrompt();
        clearTypingIndicator();
    }

    const nameEl = phoneContainer?.querySelector('#cx-chat-name');
    const statusEl = phoneContainer?.querySelector('#cx-chat-status');
    if (nameEl) nameEl.textContent = contactName;
    if (statusEl) statusEl.textContent = 'online';

    const input = phoneContainer?.querySelector('#cx-msg-input');
    if (input) input.placeholder = 'Type a message...';

    // Drawer starts hidden; user toggles via ⚡ button
    const drawer = phoneContainer?.querySelector('#cx-cmd-drawer');
    if (drawer && !preserveState) drawer.classList.add('cx-hidden');

    // Reset drawer button states if not preserving
    if (!preserveState) {
        phoneContainer?.querySelectorAll('.cx-cmd-btn').forEach(b => b.classList.remove('cx-cmd-active'));
        const toggle = phoneContainer?.querySelector('#cx-neural-toggle');
        if (toggle) toggle.classList.remove('cx-neural-active');
    }

    const area = phoneContainer?.querySelector('#cx-msg-area');
    if (area) renderAllBubbles(area, contactName, false);

    switchView('chat');
}

function clearTypingIndicator() {
    if (typingTimeout) { clearTimeout(typingTimeout); typingTimeout = null; }
    phoneContainer?.querySelector('#cx-typing-indicator')?.remove();
}

function sendPhoneMessage() {
    const input = phoneContainer?.querySelector('#cx-msg-input');
    const area = phoneContainer?.querySelector('#cx-msg-area');
    const rawText = input?.value?.trim();
    if (!rawText || !area || !currentContactName) return;

    const isNeural = neuralMode;

    // Determine command type: from drawer mode or legacy {{CMD}} syntax
    const CMD_RE = /\{\{(COMMAND|FORGET|BELIEVE|COMPEL)\}\}\s*\{\{(.+?)\}\}/i;
    let cmdType = commandMode; // from drawer (null if no mode active)
    let displayText = rawText;
    let chatText = rawText;
    const legacyMatch = CMD_RE.exec(rawText);

    if (legacyMatch) {
        cmdType = legacyMatch[1].toUpperCase();
        displayText = `⚡ ${cmdType}: ${legacyMatch[2]}`;
        chatText = rawText;
    } else if (cmdType) {
        displayText = `⚡ ${cmdType}: ${rawText}`;
        chatText = `{{${cmdType}}} {{${rawText}}}`;
    }

    const isCommand = !!cmdType;

    // Remove empty-state hint
    area.querySelector('.cx-chat-hint')?.remove();

    // Store + render sent bubble (pending style in batch mode)
    const msgType = isNeural ? 'sent-neural' : 'sent';
    pushMessage(currentContactName, msgType, displayText);

    if (settings.batchMode) {
        // ── BATCH MODE: stage message, don't send yet ──
        const bubble = renderBubble({ type: msgType, text: displayText, time: now() });
        bubble.classList.add('cx-sms-pending');
        area.appendChild(bubble);
        area.scrollTop = area.scrollHeight;
        input.value = '';

        addToQueue(currentContactName, chatText, displayText, isNeural, cmdType);
    } else {
        // ── INSTANT MODE: send immediately (original behavior) ──
        area.appendChild(renderBubble({ type: msgType, text: displayText, time: now() }));
        input.value = '';

        sendImmediate(currentContactName, chatText, isNeural, cmdType);

        // Typing indicator
        clearTypingIndicator();
        const typing = document.createElement('div');
        typing.id = 'cx-typing-indicator';
        typing.className = 'cx-typing-row';
        typing.innerHTML = `<div class="cx-typing-bubble"><span></span><span></span><span></span></div>`;
        area.appendChild(typing);
        area.scrollTop = area.scrollHeight;

        typingTimeout = setTimeout(() => {
            clearTypingIndicator();
            if (awaitingReply) {
                awaitingReply = false;
                const hint = document.createElement('div');
                hint.className = 'cx-chat-hint';
                hint.textContent = 'No phone reply received';
                hint.style.fontSize = '11px';
                area.appendChild(hint);
                area.scrollTop = area.scrollHeight;
            }
        }, 30000);
    }
}

function wirePhone() {
    if (!phoneContainer) return;
    phoneContainer.querySelectorAll('[data-action="unlock"]').forEach(el =>
        el.addEventListener('click', () => switchView('home'))
    );
    phoneContainer.querySelectorAll('.cx-notif[data-goto]').forEach(el =>
        el.addEventListener('click', () => switchView(el.dataset.goto))
    );
    phoneContainer.querySelectorAll('.cx-app-icon[data-app]').forEach(icon =>
        icon.addEventListener('click', () => {
            const app = icon.dataset.app;
            if (app === 'cmdx' || app === 'profiles' || app === 'openclaw' || app === 'phone-settings') {
                currentApp = app;
                switchView(app);
                if (app === 'openclaw') {
                    syncOpenClawView();
                    setOpenClawStatus('Ready.');
                }
            }
        })
    );
    // Settings toggles
    phoneContainer.querySelector('#cx-set-batch')?.addEventListener('change', (e) => {
        settings.batchMode = e.target.checked;
        saveSettings();
        updateQueueBar();
    });
    phoneContainer.querySelector('#cx-set-style')?.addEventListener('change', (e) => {
        settings.styleCommands = e.target.checked;
        saveSettings();
    });
    phoneContainer.querySelector('#cx-set-npcs')?.addEventListener('change', (e) => {
        settings.autoDetectNpcs = e.target.checked;
        saveSettings();
        if (e.target.checked) injectContactsPrompt();
        else clearContactsPrompt();
    });
    phoneContainer.querySelector('#cx-set-lock')?.addEventListener('change', (e) => {
        settings.showLockscreen = e.target.checked;
        saveSettings();
    });
    phoneContainer.querySelector('#cx-set-clear-npcs')?.addEventListener('click', () => {
        if (confirm('Clear all NPC contacts for this chat?')) {
            saveNpcs([]);
            rebuildPhone();
        }
    });
    phoneContainer.querySelector('#cx-ocb-mode')?.addEventListener('change', (e) => {
        settings.openclawMode = e.target.value;
        saveSettings();
        setOpenClawStatus(`Mode set: ${settings.openclawMode}`);
    });
    phoneContainer.querySelector('#cx-ocb-health')?.addEventListener('click', () => checkOpenClawHealth().catch(error => setOpenClawStatus(String(error?.message || error))));
    phoneContainer.querySelector('#cx-ocb-session-btn')?.addEventListener('click', () => refreshOpenClawSessionStatus().catch(error => setOpenClawStatus(String(error?.message || error))));
    phoneContainer.querySelector('#cx-ocb-send')?.addEventListener('click', () => sendToOpenClaw().catch(error => setOpenClawStatus(String(error?.message || error))));
    phoneContainer.querySelector('#cx-ocb-reset')?.addEventListener('click', () => resetOpenClawSession().catch(error => setOpenClawStatus(String(error?.message || error))));
    phoneContainer.querySelector('#cx-ocb-insert')?.addEventListener('click', insertContextIntoOpenClawPrompt);
    phoneContainer.querySelector('#cx-ocb-slash')?.addEventListener('click', runOpenClawSlashLocally);
    phoneContainer.querySelector('#cx-ocb-clear')?.addEventListener('click', clearOpenClawPrompt);
    phoneContainer.querySelector('#cx-ocb-actions-list')?.addEventListener('click', (event) => {
        const approveId = event.target?.closest?.('[data-ocb-approve]')?.dataset?.ocbApprove;
        const rejectId = event.target?.closest?.('[data-ocb-reject]')?.dataset?.ocbReject;
        if (approveId) {
            approveOpenClawAction(approveId).catch(error => setOpenClawStatus(String(error?.message || error)));
            return;
        }
        if (rejectId) {
            rejectOpenClawAction(rejectId).catch(error => setOpenClawStatus(String(error?.message || error)));
        }
    });
    // Profile card → open chat with that contact
    phoneContainer.querySelectorAll('.cx-profile-card[data-pname]').forEach(card =>
        card.addEventListener('click', () => {
            const name = card.dataset.pname;
            if (name) openChat(name, 'cmdx');
        })
    );
    phoneContainer.querySelectorAll('.cx-nav[data-goto]').forEach(nav =>
        nav.addEventListener('click', () => switchView(nav.dataset.goto))
    );
    phoneContainer.querySelectorAll('.cx-contact-row').forEach(row =>
        row.addEventListener('click', () => {
            const name = row.dataset.cname;
            const app = row.dataset.app;
            if (name) openChat(name, app);
        })
    );
    phoneContainer.querySelector('#cx-back')?.addEventListener('click', () => {
        switchView('cmdx');
        currentContactName = null;
        awaitingReply = false;
        commandMode = null;
        neuralMode = false;
        clearSmsPrompt();
        clearTypingIndicator();
    });
    // Batch mode toggle
    phoneContainer.querySelector('#cx-batch-toggle')?.addEventListener('click', () => {
        settings.batchMode = !settings.batchMode;
        const btn = phoneContainer.querySelector('#cx-batch-toggle');
        if (settings.batchMode) btn?.classList.add('cx-batch-active');
        else { btn?.classList.remove('cx-batch-active'); }
        saveSettings();
        updateQueueBar();
    });
    // Neural toggle button in chat header
    phoneContainer.querySelector('#cx-neural-toggle')?.addEventListener('click', () => {
        neuralMode = !neuralMode;
        const toggle = phoneContainer.querySelector('#cx-neural-toggle');
        const drawer = phoneContainer.querySelector('#cx-cmd-drawer');
        const input = phoneContainer.querySelector('#cx-msg-input');
        if (neuralMode) {
            toggle?.classList.add('cx-neural-active');
            drawer?.classList.remove('cx-hidden');
            if (input) input.placeholder = 'Enter neural command...';
        } else {
            toggle?.classList.remove('cx-neural-active');
            drawer?.classList.add('cx-hidden');
            commandMode = null;
            phoneContainer.querySelectorAll('.cx-cmd-btn').forEach(b => b.classList.remove('cx-cmd-active'));
            if (input) input.placeholder = 'Type a message...';
        }
    });
    // Command drawer mode buttons
    phoneContainer.querySelectorAll('.cx-cmd-btn[data-mode]').forEach(btn =>
        btn.addEventListener('click', () => {
            const mode = btn.dataset.mode;
            const input = phoneContainer.querySelector('#cx-msg-input');
            if (commandMode === mode) {
                // Deselect
                commandMode = null;
                btn.classList.remove('cx-cmd-active');
                if (input) input.placeholder = neuralMode ? 'Enter neural command...' : 'Type a message...';
            } else {
                // Select this mode
                commandMode = mode;
                phoneContainer.querySelectorAll('.cx-cmd-btn').forEach(b => b.classList.remove('cx-cmd-active'));
                btn.classList.add('cx-cmd-active');
                const placeholders = {
                    COMMAND: `Command ${currentContactName || 'target'} to...`,
                    BELIEVE: `Make ${currentContactName || 'target'} believe...`,
                    FORGET: `Make ${currentContactName || 'target'} forget...`,
                    COMPEL: `Compel ${currentContactName || 'target'} to...`,
                };
                if (input) input.placeholder = placeholders[mode] || 'Enter command...';
            }
            input?.focus();
        })
    );
    phoneContainer.querySelector('#cx-send')?.addEventListener('click', sendPhoneMessage);
    phoneContainer.querySelector('#cx-msg-input')?.addEventListener('keydown', e => {
        if (e.key === 'Enter') sendPhoneMessage();
    });
    // Queue bar buttons
    phoneContainer.querySelector('#cx-queue-send')?.addEventListener('click', flushQueue);
    phoneContainer.querySelector('#cx-queue-clear')?.addEventListener('click', () => {
        // Remove pending messages from store too
        for (const q of composeQueue) {
            const msgs = loadMessages(q.contactName);
            // Remove last message matching this text (the staged one)
            for (let i = msgs.length - 1; i >= 0; i--) {
                if (msgs[i].text === q.displayText) { msgs.splice(i, 1); break; }
            }
            saveMessages(q.contactName, msgs);
        }
        clearQueue();
        // Re-render current chat
        const area = phoneContainer?.querySelector('#cx-msg-area');
        if (area && currentContactName) renderAllBubbles(area, currentContactName, false);
    });
    setInterval(() => {
        const t = now();
        phoneContainer?.querySelectorAll('#cx-clock, .cx-lock-time, .cx-home-time').forEach(el => { el.textContent = t; });
    }, 30000);
}

/* ======================================================================
   PANEL
   ====================================================================== */

function createPanel() {
    if (phoneContainer) return;
    const wrapper = document.createElement('div');
    wrapper.id = 'cx-panel-wrapper';
    wrapper.classList.add('cx-hidden');
    wrapper.innerHTML = `<div id="cx-panel-close">✕</div>${buildPhone()}`;
    document.body.appendChild(wrapper);
    phoneContainer = wrapper;

    const menuContainer = document.querySelector('#extensionsMenu');
    if (menuContainer && !document.querySelector('#cx-menu-button')) {
        const menuBtn = document.createElement('div');
        menuBtn.id = 'cx-menu-button';
        menuBtn.className = 'list-group-item flex-container flexGap5';
        menuBtn.innerHTML = '<div class="fa-solid fa-mobile-screen extensionsMenuExtensionButton"></div>Command-X';
        menuContainer.append(menuBtn);
        menuBtn.addEventListener('click', () => {
            rebuildPhone();
            wrapper.classList.toggle('cx-hidden');
            settings.panelOpen = !wrapper.classList.contains('cx-hidden');
            saveSettings();
        });
    }
    wrapper.querySelector('#cx-panel-close')?.addEventListener('click', () => {
        wrapper.classList.add('cx-hidden');
        settings.panelOpen = false;
        saveSettings();
    });
    wrapper.addEventListener('click', (e) => {
        if (e.target === wrapper) {
            wrapper.classList.add('cx-hidden');
            settings.panelOpen = false;
            saveSettings();
        }
    });
    wirePhone();
    syncOpenClawView();
    updateUnreadBadges();
}

function rebuildPhone() {
    const wrapper = document.getElementById('cx-panel-wrapper');
    if (!wrapper) return;
    const savedContact = currentContactName;
    const savedApp = currentApp;
    wrapper.innerHTML = `<div id="cx-panel-close">✕</div>${buildPhone()}`;
    wrapper.querySelector('#cx-panel-close')?.addEventListener('click', () => {
        wrapper.classList.add('cx-hidden');
        settings.panelOpen = false;
        saveSettings();
    });
    wirePhone();
    syncOpenClawView();
    if (savedContact && savedApp) {
        openChat(savedContact, savedApp, true);
    } else if (savedApp === 'openclaw') {
        switchView('openclaw');
        setOpenClawStatus('Ready.');
    }
    updateUnreadBadges();
}

function destroyPanel() {
    document.getElementById('cx-panel-wrapper')?.remove();
    document.getElementById('cx-menu-button')?.remove();
    phoneContainer = null;
}

/* ======================================================================
   COMMAND STYLING IN ST MESSAGES
   ====================================================================== */

const CMD_STYLE_RE = /\{\{(COMMAND|FORGET|BELIEVE|COMPEL)\}\}\s*\{\{(.+?)\}\}/gi;

function styleCommandsInMessage(mesId) {
    if (!settings.styleCommands) return;
    const el = document.querySelector(`.mes[mesid="${mesId}"] .mes_text`);
    if (!el) return;
    CMD_STYLE_RE.lastIndex = 0;
    if (CMD_STYLE_RE.test(el.innerHTML)) {
        CMD_STYLE_RE.lastIndex = 0;
        el.innerHTML = el.innerHTML.replace(CMD_STYLE_RE, (_, type, action) =>
            `<span class="cx-styled-cmd" data-type="${type.toUpperCase()}">[${type}: ${action}]</span>`
        );
    }
}

/* ======================================================================
   SETTINGS
   ====================================================================== */

function loadSettings() {
    const ctx = getContext();
    if (ctx.extensionSettings[EXT]) Object.assign(settings, ctx.extensionSettings[EXT]);
    const cb = (id, key, fallback = false) => {
        const el = document.getElementById(id);
        if (el) el.checked = settings[key] ?? fallback;
    };
    cb('cx_enabled', 'enabled', true);
    cb('cx_style_commands', 'styleCommands', true);
    cb('cx_show_lockscreen', 'showLockscreen', false);
    cb('cx_ext_batch_mode', 'batchMode', false);
    cb('cx_ext_auto_detect_npcs', 'autoDetectNpcs', true);
    if (!["observe", "assist", "operate"].includes(settings.openclawMode)) settings.openclawMode = 'assist';
    const openclawMode = document.getElementById('cx_ext_openclaw_mode');
    if (openclawMode) openclawMode.value = settings.openclawMode || 'assist';
}

function saveSettings() {
    settings.enabled = document.getElementById('cx_enabled')?.checked ?? true;
    settings.styleCommands = document.getElementById('cx_style_commands')?.checked ?? true;
    settings.showLockscreen = document.getElementById('cx_show_lockscreen')?.checked ?? false;
    settings.batchMode = document.getElementById('cx_ext_batch_mode')?.checked ?? settings.batchMode ?? false;
    settings.autoDetectNpcs = document.getElementById('cx_ext_auto_detect_npcs')?.checked ?? settings.autoDetectNpcs ?? true;
    settings.openclawMode = document.getElementById('cx_ext_openclaw_mode')?.value || settings.openclawMode || 'assist';
    const ctx = getContext();
    ctx.extensionSettings[EXT] = { ...settings };
    ctx.saveSettingsDebounced();
}

/* ======================================================================
   INIT
   ====================================================================== */

jQuery(async () => {
    try {
        const ctx = getContext();

        try {
            const resp = await fetch(`/scripts/extensions/third-party/${EXT}/settings.html`);
            if (resp.ok) $('#extensions_settings2').append(await resp.text());
        } catch (e) { console.warn(`[${EXT}] Settings HTML:`, e); }

        loadSettings();
        $('#cx_enabled, #cx_style_commands, #cx_show_lockscreen, #cx_ext_batch_mode, #cx_ext_auto_detect_npcs, #cx_ext_openclaw_mode').on('change', () => {
            saveSettings();
            if (settings.enabled) {
                createPanel();
                if (settings.autoDetectNpcs !== false) injectContactsPrompt();
                else clearContactsPrompt();
            } else {
                destroyPanel();
                clearContactsPrompt();
                clearSmsPrompt();
            }
        });

        const { eventSource, event_types } = ctx;

        // Style {{COMMAND}} tags + hide [sms] and [contacts] tags in rendered messages
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (mesId) => {
            styleCommandsInMessage(mesId);
            hideSmsTagsInDom(mesId);
            hideContactsTagsInDom(mesId);
        });
        eventSource.on(event_types.USER_MESSAGE_RENDERED, styleCommandsInMessage);

        // ── Live reply capture: parse [sms] + [contacts] from character response ──
        eventSource.on(event_types.MESSAGE_RECEIVED, () => {
            const freshCtx = getContext();
            const chat = freshCtx.chat || [];
            if (!chat.length) return;
            const msg = chat[chat.length - 1];
            if (!msg || msg.is_user || msg.is_system) return;
            const mesId = chat.length - 1;

            // ── [sms] FIRST — must run before [contacts] which can trigger rebuildPhone ──
            const smsBlocks = extractSmsBlocks(msg.mes);
            const userName = (freshCtx.name1 || '').toLowerCase();
            if (smsBlocks) {
                for (const block of smsBlocks) {
                    // Filter: only capture texts directed at the user's phone.
                    // If to="user" or to=userName → capture. If to=someone else → skip.
                    // If no to attribute: capture only if we're awaitingReply (we asked for it).
                    if (block.to) {
                        const toName = block.to.toLowerCase();
                        if (toName !== 'user' && toName !== userName && toName !== 'me') {
                            // This text is between NPCs, not to us — skip
                            console.log(`[${EXT}] Skipping [sms] to="${block.to}" (not for user)`);
                            continue;
                        }
                    } else if (!awaitingReply) {
                        // No to attribute and we didn't ask for a text — likely NPC-to-NPC
                        // Skip unless it's from a known contact (unsolicited incoming text)
                        const allContacts = getContactsFromContext();
                        const fromKnown = block.from && allContacts.some(c => c.name.toLowerCase() === block.from.toLowerCase());
                        if (!fromKnown) {
                            console.log(`[${EXT}] Skipping [sms] with no to attr and unknown sender "${block.from}"`);
                            continue;
                        }
                    }

                    // Determine which contact this SMS belongs to.
                    let targetContact = null;
                    if (block.from) {
                        const allContacts = getContactsFromContext();
                        const byFrom = allContacts.find(c => c.name.toLowerCase() === block.from.toLowerCase());
                        targetContact = byFrom ? byFrom.name : block.from;
                    } else if (awaitingReply && currentContactName) {
                        targetContact = currentContactName;
                    } else {
                        const allContacts = getContactsFromContext();
                        const byName = allContacts.find(c => c.name.toLowerCase() === (msg.name || '').toLowerCase());
                        if (byName) {
                            targetContact = byName.name;
                        } else if (currentContactName) {
                            targetContact = currentContactName;
                        } else {
                            targetContact = allContacts.length ? allContacts[0].name : null;
                        }
                    }

                    if (targetContact) {
                        pushMessage(targetContact, 'received', block.text, mesId);

                        // Increment unread if not currently viewing this contact's chat
                        const isViewingThis = currentContactName === targetContact
                            && phoneContainer
                            && !document.getElementById('cx-panel-wrapper')?.classList.contains('cx-hidden');
                        if (!isViewingThis) {
                            incrementUnread(targetContact);
                            showToast(targetContact, block.text);
                        }

                        const wrapper = document.getElementById('cx-panel-wrapper');
                        const area = phoneContainer?.querySelector('#cx-msg-area');
                        if (wrapper && !wrapper.classList.contains('cx-hidden') && area && currentContactName === targetContact) {
                            area.querySelector('#cx-typing-indicator')?.remove();
                            area.appendChild(renderBubble({ type: 'received', text: block.text, time: now() }));
                            area.scrollTop = area.scrollHeight;
                        } else if (wrapper && !wrapper.classList.contains('cx-hidden') && currentContactName !== targetContact) {
                            console.log(`[${EXT}] SMS received for ${targetContact} (currently viewing ${currentContactName})`);
                        }
                    }
                }

                if (awaitingReply) {
                    awaitingReply = false;
                    clearSmsPrompt();
                    clearTypingIndicator();
                }
            } else if (awaitingReply) {
                console.warn(`[${EXT}] No [sms] tags found in response.`);
                phoneContainer?.querySelector('#cx-typing-indicator')?.remove();
                awaitingReply = false;
            }

            // ── [contacts] SECOND — may call rebuildPhone which resets state ──
            const parsedContacts = extractContacts(msg.mes);
            if (parsedContacts) {
                mergeNpcs(parsedContacts);
                if (phoneContainer && !document.getElementById('cx-panel-wrapper')?.classList.contains('cx-hidden')) {
                    rebuildPhone();
                }
            }
        });

        // ── Swipe/regeneration handling: remove stale phone messages ──
        eventSource.on(event_types.MESSAGE_SWIPED, (mesId) => {
            removeMessagesForMesId(mesId);
            // Re-render current chat if open
            const area = phoneContainer?.querySelector('#cx-msg-area');
            if (area && currentContactName) {
                renderAllBubbles(area, currentContactName, false);
            }
        });
        eventSource.on(event_types.MESSAGE_DELETED, () => {
            // On delete, the mesId is chat.length (post-delete), so the deleted
            // message was at chat.length. Clean up and re-render.
            const freshCtx = getContext();
            const deletedId = (freshCtx.chat || []).length; // this was the deleted index
            removeMessagesForMesId(deletedId);
            const area = phoneContainer?.querySelector('#cx-msg-area');
            if (area && currentContactName) {
                renderAllBubbles(area, currentContactName, false);
            }
        });

        // Chat changed — reset state
        eventSource.on(event_types.CHAT_CHANGED, () => {
            currentContactName = null;
            currentApp = null;
            awaitingReply = false;
            commandMode = null;
            clearSmsPrompt();
            clearTypingIndicator();
            // Re-inject contacts prompt for new chat
            if (settings.enabled && settings.autoDetectNpcs !== false) injectContactsPrompt();
            if (phoneContainer) rebuildPhone();
        });

        if (settings.enabled) {
            createPanel();
            if (settings.autoDetectNpcs !== false) injectContactsPrompt();
        }
        console.log(`[${EXT}] v0.10.0 Loaded OK`);
    } catch (err) {
        console.error(`[${EXT}] INIT FAILED:`, err);
    }
});
