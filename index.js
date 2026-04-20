/**
 * Command-X Phone — SillyTavern Extension v0.11.0
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

const VERSION = '0.11.0';
const EXT = 'command-x';
const INJECT_KEY = 'command-x-sms';
const INJECT_KEY_CONTACTS = 'command-x-contacts';
const INJECT_KEY_PRIVATE_PHONE = 'command-x-private-phone';
const INJECT_KEY_QUESTS = 'command-x-quests';
const DEFAULTS = { enabled: true, styleCommands: true, showLockscreen: false, panelOpen: false, batchMode: false, autoDetectNpcs: true, manualHybridPrivateTexts: true, openclawMode: 'assist', contactsInjectEveryN: 1, questsInjectEveryN: 1, autoPrivatePollEveryN: 0 };
const MAX_AVATAR_FILE_BYTES = 8 * 1024 * 1024; // 8 MB hard cap on raw upload size
const AWAIT_TIMEOUT_MS = 30_000;             // ms before awaitingReply auto-clears
const CLOCK_INTERVAL_MS = 30_000;            // clock display refresh interval
const MESSAGE_HISTORY_CAP = 200;             // max messages stored per contact
const QUEST_HISTORY_CAP = 150;              // max quests stored
const TOAST_DURATION_MS = 4_000;            // toast auto-dismiss duration
const CONTACT_GRADIENTS = [
    'linear-gradient(135deg,#553355,#442244)',
    'linear-gradient(135deg,#334455,#223344)',
    'linear-gradient(135deg,#ffaa88,#ff7755)',
    'linear-gradient(135deg,#88aacc,#557799)',
    'linear-gradient(135deg,#55aa77,#338855)',
    'linear-gradient(135deg,#aa5577,#883355)',
];
const CONTACT_EMOJIS = ['👩','👩‍🦰','👱‍♀️','👩‍🏫','🧑','👨','👩‍🎤','🧑‍💼','👧','🧝‍♀️'];
const CONTACT_FIELDS = ['emoji', 'status', 'mood', 'location', 'relationship', 'thoughts', 'avatarUrl'];
const VOLATILE_CONTACT_FIELDS = ['status', 'mood', 'location', 'thoughts'];
const STABLE_CONTACT_FIELDS = ['emoji', 'relationship', 'avatarUrl'];
const MANUAL_OVERRIDE_FIELDS = [...CONTACT_FIELDS];
const QUEST_FIELDS = ['title', 'summary', 'objective', 'priority', 'urgency', 'source', 'relatedContact', 'status', 'focused', 'nextAction', 'subtasks', 'notes'];
const QUEST_STATUS_ORDER = { active: 0, waiting: 1, blocked: 2, completed: 3, failed: 4 };
const QUEST_PRIORITY_ORDER = { critical: 0, high: 1, normal: 2, low: 3 };
const QUEST_URGENCY_ORDER = { urgent: 0, soon: 1, none: 2 };
let settings = { ...DEFAULTS };
let phoneContainer = null;
let clockIntervalId = null;
let commandMode = null; // null | 'COMMAND' | 'FORGET' | 'BELIEVE' | 'COMPEL'
let neuralMode = false; // toggled via ⚡ button in chat header
let profileEditorState = null;
let questEditorState = null;
let privatePollInFlight = false;
let scanContactsInFlight = false;
const SCAN_CONTACTS_LABEL = '🔍 Scan Contacts';
let questEnrichmentInFlight = false;


const OPENCLAW_API_BASE = '/api/plugins/openclaw-bridge';

function getOpenClawChatState() {
    const ctx = getContext();
    ctx.chatMetadata[EXT] = ctx.chatMetadata[EXT] || {};
    ctx.chatMetadata[EXT].openclaw = ctx.chatMetadata[EXT].openclaw || {};
    const state = ctx.chatMetadata[EXT].openclaw;
    let mutated = false;
    if (!Number.isFinite(Number(state.resetNonce))) { state.resetNonce = 0; mutated = true; }
    if (mutated && typeof ctx.saveMetadata === 'function') ctx.saveMetadata();
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

function getExtensionChatState() {
    const ctx = getContext();
    ctx.chatMetadata[EXT] = ctx.chatMetadata[EXT] || {};
    ctx.chatMetadata[EXT].privatePhone = ctx.chatMetadata[EXT].privatePhone || {};
    const state = ctx.chatMetadata[EXT].privatePhone;
    let mutated = false;
    if (!Array.isArray(state.events)) { state.events = []; mutated = true; }
    if (!Number.isFinite(Number(state.lastPollAt))) { state.lastPollAt = 0; mutated = true; }
    if (!Array.isArray(state.lastPollSummary)) { state.lastPollSummary = []; mutated = true; }
    if (mutated && typeof ctx.saveMetadata === 'function') ctx.saveMetadata();
    return state;
}

function saveExtensionChatState(patch = {}) {
    const ctx = getContext();
    const current = getExtensionChatState();
    ctx.chatMetadata[EXT] = ctx.chatMetadata[EXT] || {};
    ctx.chatMetadata[EXT].privatePhone = { ...current, ...patch };
    ctx.saveMetadata();
    return ctx.chatMetadata[EXT].privatePhone;
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
            return `*Command-X sends a neural command to ${q.contactName}:*\n${q.text}`;
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
    // Always arm cleanup so the injected per-message prompt is cleared on the next
    // assistant message. SMS-specific UI behavior (typing indicator) is gated below.
    awaitingReply = true;
    // A target expects an SMS reply only if it's neither neural nor a legacy command.
    const expectingSmsReply = targets.some(t => !t.isNeural && !t.cmdType);

    for (const queued of composeQueue) {
        pushPrivatePhoneEvent({
            type: 'outgoing_sms',
            from: 'user',
            to: queued.contactName,
            text: queued.displayText,
            visibility: 'private',
            source: 'inline',
            canonical: true,
            sceneAware: false,
            timestamp: Date.now(),
        });
    }

    // Send to ST
    const textarea = document.querySelector('#send_textarea');
    if (textarea) {
        textarea.value = batchedMessage;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        const sendBtn = document.querySelector('#send_but');
        if (sendBtn) sendBtn.click();
    }

    // Show typing indicator in current chat only if expecting a text reply
    const currentInQueue = expectingSmsReply && composeQueue.some(q => q.contactName === currentContactName && !q.isNeural && !q.cmdType);
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
        }, AWAIT_TIMEOUT_MS);
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

/* ── Global avatar store (persists across chats, keyed by normalized name) ── */
const GLOBAL_AVATAR_STORE_KEY = 'cx-global-avatars';
const GLOBAL_AVATAR_MAX_ENTRIES = 50;
const GLOBAL_AVATAR_MAX_DATA_URL_SIZE = 100 * 1024; // 100 KB

let _globalAvatarCache = null; // in-memory cache; null = not yet loaded

function _isAvatarUrlOversized(url) {
    return typeof url === 'string' && url.startsWith('data:') && url.length > GLOBAL_AVATAR_MAX_DATA_URL_SIZE;
}

function loadGlobalAvatars() {
    if (_globalAvatarCache) return _globalAvatarCache;
    try {
        const raw = JSON.parse(localStorage.getItem(GLOBAL_AVATAR_STORE_KEY) || '{}');
        const entries = {};
        for (const [key, value] of Object.entries(raw)) {
            if (!key) continue;
            // Support both old flat {key: url} format and new {key: {url, lastUsed}} format
            if (typeof value === 'string') {
                if (!_isAvatarUrlOversized(value)) entries[key] = { url: value, lastUsed: 0 };
            } else if (value && typeof value.url === 'string' && !_isAvatarUrlOversized(value.url)) {
                entries[key] = { url: value.url, lastUsed: Number.isFinite(value.lastUsed) ? value.lastUsed : 0 };
            }
        }
        _globalAvatarCache = entries;
    } catch {
        _globalAvatarCache = {};
    }
    return _globalAvatarCache;
}

function saveGlobalAvatars(entries) {
    // Trim to max entries by LRU (most recently used kept)
    let sorted = Object.entries(entries).sort((a, b) => (b[1]?.lastUsed || 0) - (a[1]?.lastUsed || 0));
    if (sorted.length > GLOBAL_AVATAR_MAX_ENTRIES) sorted = sorted.slice(0, GLOBAL_AVATAR_MAX_ENTRIES);
    const trimmed = Object.fromEntries(sorted);
    _globalAvatarCache = trimmed;
    try { localStorage.setItem(GLOBAL_AVATAR_STORE_KEY, JSON.stringify(trimmed)); }
    catch (e) { console.warn('[command-x] global avatar save', e); }
}

function getGlobalAvatar(name) {
    if (!name) return null;
    const entries = loadGlobalAvatars();
    const key = normalizeContactName(name);
    const entry = entries[key];
    if (!entry?.url) return null;
    // Update lastUsed in-memory only (no write-back on read to avoid churn)
    entry.lastUsed = Date.now();
    return entry.url;
}

function setGlobalAvatar(name, url) {
    if (!name) return;
    const entries = loadGlobalAvatars();
    const key = normalizeContactName(name);
    if (url && !_isAvatarUrlOversized(url)) {
        entries[key] = { url, lastUsed: Date.now() };
    } else {
        delete entries[key];
    }
    saveGlobalAvatars(entries);
}

function sanitizeContactValue(field, value) {
    if (field === 'emoji') return String(value || '').trim() || '🧑';
    if (field === 'status') {
        const normalized = String(value || '').trim().toLowerCase();
        return ['online', 'offline', 'nearby'].includes(normalized) ? normalized : 'nearby';
    }
    const text = String(value || '').trim();
    return text || null;
}

function getManualOverrides(contact = {}) {
    return { ...(contact.manualOverrides || {}) };
}

/**
 * Parse [status] (or legacy [contacts]) JSON from a message.
 * [status][{"name":"Sarah","emoji":"👩","status":"online","mood":"😊 happy","location":"home","relationship":"friendly","thoughts":"I need to play this cool or she'll notice immediately."}][/status]
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
            avatarUrl: c.avatarUrl || null,
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
function mergeStoredContactRecord(existing = {}, incoming = {}, options = {}) {
    const preferExisting = !!options.preferExisting;
    const manualOverrides = getManualOverrides(existing);
    const merged = {
        ...incoming,
        ...existing,
        name: existing.name || incoming.name || '',
    };

    const mergeField = (field, fallback = null) => {
        const existingValue = existing[field];
        const incomingValue = incoming[field];
        const hasExisting = existingValue != null && String(existingValue).trim() !== '';
        const hasIncoming = incomingValue != null && String(incomingValue).trim() !== '';
        if (manualOverrides[field]) {
            merged[field] = hasExisting ? existingValue : fallback;
            return;
        }
        if (preferExisting) {
            merged[field] = hasExisting ? existingValue : (hasIncoming ? incomingValue : fallback);
            return;
        }
        merged[field] = hasIncoming ? incomingValue : (hasExisting ? existingValue : fallback);
    };

    STABLE_CONTACT_FIELDS.forEach(field => mergeField(field));
    VOLATILE_CONTACT_FIELDS.forEach(field => mergeField(field));
    merged.isManual = !!existing.isManual || !!incoming.isManual || Object.values(manualOverrides).some(Boolean);
    merged.manualOverrides = { ...manualOverrides, ...(incoming.manualOverrides || {}) };
    return merged;
}

function mergeNpcs(incoming) {
    if (!incoming || !incoming.length) return;
    const stored = loadNpcs();
    const avatarUpdates = {};
    for (const npc of incoming) {
        const idx = findStoredNpcIndexByName(npc.name, stored);
        if (idx >= 0) {
            stored[idx] = mergeStoredContactRecord(stored[idx], npc);
        } else {
            stored.push({ ...npc, manualOverrides: { ...(npc.manualOverrides || {}) } });
        }
        if (npc.avatarUrl) avatarUpdates[normalizeContactName(npc.name)] = npc.avatarUrl;
    }
    saveNpcs(stored);
    // Batch: apply all avatar updates in a single load+save
    if (Object.keys(avatarUpdates).length) {
        const entries = loadGlobalAvatars();
        const now = Date.now();
        for (const [key, url] of Object.entries(avatarUpdates)) {
            if (!_isAvatarUrlOversized(url)) entries[key] = { url, lastUsed: now };
        }
        saveGlobalAvatars(entries);
    }
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
    const excludeNote = [userName].filter(Boolean).map(n => `"${n}"`).join(' or ');
    setExtensionPrompt(
        INJECT_KEY_CONTACTS,
        `[System: At the end of each response, include a [status] block with a JSON array of the present characters relevant to the scene, including the current main character and any side characters/NPCs. Format: [status][{"name":"Name","emoji":"👩","status":"online","mood":"😊 happy","location":"her apartment","relationship":"friendly","thoughts":"I need to keep my voice steady or he'll hear how much this matters to me."}][/status] — "status" can be "online"/"offline"/"nearby". "mood" is an emoji + short descriptor. "location" is where they currently are. "relationship" is how they feel about the user (friendly/neutral/hostile/romantic/etc). "thoughts" is a short first-person internal monologue line written in the character's own private voice, as if we are hearing their exact thoughts directly. It should sound like something they are silently thinking to themselves right now, not a narrator summary, not a mood label, and not a generic state description. Include the active main character plus any relevant side characters/NPCs who exist in the scene. Do NOT include ${excludeNote || 'the user'}. If no other characters are relevant, you may still include the current main character alone.]`,
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
   QUEST STORE — localStorage-backed, keyed per chat
   ====================================================================== */

const QUESTS_TAG_RE = /\[quests\]([\s\S]*?)\[\/quests\]/gi;

function questStoreKey() {
    const ctx = getContext();
    const chatId = ctx.chatId || ctx.groupId || 'default';
    return `cx-quests-${chatId}`;
}

function loadQuests() {
    try { return JSON.parse(localStorage.getItem(questStoreKey()) || '[]'); }
    catch { return []; }
}

function sortQuests(quests) {
    return [...(quests || [])].sort((a, b) => {
        const focusDiff = Number(!!b?.focused) - Number(!!a?.focused);
        if (focusDiff !== 0) return focusDiff;
        const statusDiff = (QUEST_STATUS_ORDER[a?.status] ?? 99) - (QUEST_STATUS_ORDER[b?.status] ?? 99);
        if (statusDiff !== 0) return statusDiff;
        const urgencyDiff = (QUEST_URGENCY_ORDER[a?.urgency || 'none'] ?? 99) - (QUEST_URGENCY_ORDER[b?.urgency || 'none'] ?? 99);
        if (urgencyDiff !== 0) return urgencyDiff;
        const priorityDiff = (QUEST_PRIORITY_ORDER[a?.priority || 'normal'] ?? 99) - (QUEST_PRIORITY_ORDER[b?.priority || 'normal'] ?? 99);
        if (priorityDiff !== 0) return priorityDiff;
        return Number(b?.updatedAt || 0) - Number(a?.updatedAt || 0);
    });
}

function saveQuests(quests) {
    try { localStorage.setItem(questStoreKey(), JSON.stringify(sortQuests(quests).slice(-QUEST_HISTORY_CAP))); }
    catch (e) { console.warn('[command-x] quest store save', e); }
}

function sanitizeQuestSubtasks(value, existing = []) {
    const list = Array.isArray(value)
        ? value
        : typeof value === 'string'
            ? value.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(text => ({ text }))
            : [];
    return list.map((item, index) => ({
        id: String(item?.id || existing?.[index]?.id || `sub_${Math.random().toString(36).slice(2, 8)}`).trim(),
        text: String(item?.text || item?.title || item || '').trim(),
        done: !!item?.done,
    })).filter(item => item.text);
}

function sanitizeQuestValue(field, value, existing = null) {
    if (field === 'status') {
        const normalized = String(value || '').trim().toLowerCase();
        return ['active', 'waiting', 'blocked', 'completed', 'failed'].includes(normalized) ? normalized : 'active';
    }
    if (field === 'priority') {
        const normalized = String(value || '').trim().toLowerCase();
        return ['low', 'normal', 'high', 'critical'].includes(normalized) ? normalized : 'normal';
    }
    if (field === 'urgency') {
        const normalized = String(value || '').trim().toLowerCase();
        return ['none', 'soon', 'urgent'].includes(normalized) ? normalized : 'none';
    }
    if (field === 'focused') return value === true || String(value || '').trim().toLowerCase() === 'true';
    if (field === 'subtasks') return sanitizeQuestSubtasks(value, existing);
    const text = String(value ?? '').trim();
    if (!text && field === 'title') return 'Untitled Quest';
    return text || null;
}

function getQuestManualOverrides(quest = {}) {
    return { ...(quest.manualOverrides || {}) };
}

function normalizeQuestKey(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function slugifyQuestTitle(value) {
    const slug = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return slug || 'quest';
}

function ensureQuestId(quest = {}) {
    if (String(quest.id || '').trim()) return String(quest.id).trim();
    return `quest_${slugifyQuestTitle(quest.title)}_${Math.random().toString(36).slice(2, 7)}`;
}

function canonicalQuest(quest = {}, existing = null) {
    const base = existing || {};
    const clean = {
        id: ensureQuestId({ ...base, ...quest }),
        title: sanitizeQuestValue('title', quest.title ?? base.title),
        summary: sanitizeQuestValue('summary', quest.summary ?? base.summary),
        objective: sanitizeQuestValue('objective', quest.objective ?? base.objective),
        status: sanitizeQuestValue('status', quest.status ?? base.status),
        priority: sanitizeQuestValue('priority', quest.priority ?? base.priority),
        urgency: sanitizeQuestValue('urgency', quest.urgency ?? base.urgency),
        source: sanitizeQuestValue('source', quest.source ?? base.source),
        relatedContact: sanitizeQuestValue('relatedContact', quest.relatedContact ?? base.relatedContact),
        focused: sanitizeQuestValue('focused', quest.focused ?? base.focused),
        nextAction: sanitizeQuestValue('nextAction', quest.nextAction ?? base.nextAction),
        subtasks: sanitizeQuestValue('subtasks', quest.subtasks ?? base.subtasks, base.subtasks || []),
        notes: sanitizeQuestValue('notes', quest.notes ?? base.notes),
        updatedAt: Number.isFinite(Number(quest.updatedAt)) ? Number(quest.updatedAt) : Date.now(),
        manualOverrides: { ...(base.manualOverrides || {}), ...(quest.manualOverrides || {}) },
    };
    return clean;
}

function findStoredQuestIndex(query, stored = null) {
    const list = stored || loadQuests();
    const id = String(query?.id || '').trim();
    if (id) {
        const byId = list.findIndex(quest => String(quest.id || '').trim() === id);
        if (byId >= 0) return byId;
    }
    const titleKey = normalizeQuestKey(query?.title);
    if (!titleKey) return -1;
    return list.findIndex(quest => normalizeQuestKey(quest.title) === titleKey);
}

function extractQuests(raw) {
    if (!raw) return null;
    QUESTS_TAG_RE.lastIndex = 0;
    const match = QUESTS_TAG_RE.exec(raw);
    if (!match) return null;
    try {
        const parsed = JSON.parse(match[1].trim());
        const list = Array.isArray(parsed)
            ? parsed
            : Array.isArray(parsed?.quests)
                ? parsed.quests
                : [];
        if (!Array.isArray(list)) return null;
        return list
            .filter(Boolean)
            .map(quest => canonicalQuest(quest))
            .filter(quest => quest.title);
    } catch (error) {
        console.warn('[command-x] failed to parse [quests] JSON:', error);
        return null;
    }
}

function normalizeFocusedQuests(quests = [], focusedId = null) {
    let found = false;
    return quests.map(quest => {
        const focused = focusedId ? quest.id === focusedId : (!!quest.focused && !found);
        if (focused) found = true;
        return { ...quest, focused };
    });
}

function saveAndRefreshQuests(quests = []) {
    saveQuests(normalizeFocusedQuests(quests));
    injectQuestPrompt();
}

function shouldAutoUpdateQuestField(field, existing, incoming) {
    if (incoming == null) return false;
    const current = existing?.[field];
    if (field === 'status') return sanitizeQuestValue('status', incoming) !== sanitizeQuestValue('status', current);
    if (field === 'focused') return !!incoming !== !!current;
    if (field === 'nextAction') return !!String(incoming || '').trim() && String(incoming || '').trim() !== String(current || '').trim();
    if (field === 'subtasks') return Array.isArray(incoming) && JSON.stringify(incoming) !== JSON.stringify(current || []);
    if (field === 'relatedContact' || field === 'source') return !!String(incoming || '').trim() && String(incoming || '').trim() !== String(current || '').trim();
    if (field === 'priority' || field === 'urgency') {
        const normalizedIncoming = sanitizeQuestValue(field, incoming);
        const normalizedCurrent = sanitizeQuestValue(field, current);
        return normalizedIncoming !== normalizedCurrent && normalizedIncoming !== (field === 'priority' ? 'normal' : 'none');
    }
    if (field === 'summary' || field === 'objective' || field === 'notes') return false;
    return String(incoming || '').trim() !== String(current || '').trim();
}

function mergeQuests(incoming, options = {}) {
    if (!incoming || !incoming.length) return false;
    const source = options.source || 'auto';
    const stored = loadQuests();
    let changed = false;
    let focusedId = stored.find(quest => quest.focused)?.id || null;

    for (const incomingQuest of incoming) {
        const idx = findStoredQuestIndex(incomingQuest, stored);
        if (idx >= 0) {
            const existing = stored[idx];
            const manualOverrides = getQuestManualOverrides(existing);
            let merged;
            if (source === 'auto') {
                merged = { ...existing, id: existing.id || incomingQuest.id };
                QUEST_FIELDS.forEach(field => {
                    if (manualOverrides[field]) {
                        merged[field] = existing[field] ?? (field === 'subtasks' ? [] : null);
                        return;
                    }
                    if (shouldAutoUpdateQuestField(field, existing, incomingQuest)) {
                        merged[field] = incomingQuest[field];
                    }
                });
                merged = canonicalQuest({ ...merged, manualOverrides, updatedAt: Date.now() }, existing);
                merged.manualOverrides = manualOverrides;
            } else {
                merged = canonicalQuest({ ...existing, ...incomingQuest, updatedAt: Date.now() }, existing);
                merged.manualOverrides = { ...manualOverrides, ...(incomingQuest.manualOverrides || {}) };
            }
            merged.id = existing.id || merged.id;
            if (JSON.stringify(merged) !== JSON.stringify(existing)) {
                merged.updatedAt = Date.now();
                stored[idx] = merged;
                changed = true;
            }
            if (merged.focused) focusedId = merged.id;
        } else {
            const clean = canonicalQuest({ ...incomingQuest, updatedAt: Date.now() });
            stored.push(clean);
            if (clean.focused) focusedId = clean.id;
            changed = true;
        }
    }

    if (changed) saveAndRefreshQuests(normalizeFocusedQuests(stored, focusedId));
    return changed;
}

function upsertQuest(quest, options = {}) {
    const stored = loadQuests();
    const existingIdx = options.oldId ? stored.findIndex(entry => entry.id === options.oldId) : findStoredQuestIndex(quest, stored);
    const existing = existingIdx >= 0 ? stored[existingIdx] : null;
    const clean = canonicalQuest({ ...quest, updatedAt: Date.now() }, existing);
    clean.manualOverrides = { ...(existing?.manualOverrides || {}), ...(quest.manualOverrides || {}) };
    if (existingIdx >= 0) stored[existingIdx] = { ...stored[existingIdx], ...clean };
    else stored.push(clean);
    saveAndRefreshQuests(normalizeFocusedQuests(stored, clean.focused ? clean.id : (stored.find(item => item.focused)?.id || null)));
    return clean;
}

function updateQuestFields(questId, patch = {}, pinnedFields = []) {
    const stored = loadQuests();
    const idx = stored.findIndex(quest => quest.id === questId);
    if (idx < 0) return null;
    const existing = stored[idx];
    const manualOverrides = { ...(existing.manualOverrides || {}) };
    pinnedFields.forEach(field => { manualOverrides[field] = true; });
    const updated = canonicalQuest({ ...existing, ...patch, manualOverrides, updatedAt: Date.now() }, existing);
    stored[idx] = updated;
    saveAndRefreshQuests(normalizeFocusedQuests(stored, updated.focused ? updated.id : (stored.find(item => item.focused && item.id !== questId)?.id || null)));
    return updated;
}

function setQuestStatus(questId, status) {
    return updateQuestFields(questId, { status: sanitizeQuestValue('status', status) }, ['status']);
}

function setQuestFocused(questId, focused) {
    return updateQuestFields(questId, { focused: !!focused }, ['focused']);
}

function toggleQuestSubtask(questId, subtaskId) {
    const quest = getEditableQuest(questId);
    if (!quest) return null;
    const subtasks = (quest.subtasks || []).map(item => item.id === subtaskId ? { ...item, done: !item.done } : item);
    return updateQuestFields(questId, { subtasks }, ['subtasks']);
}

async function enhanceQuestById(questId) {
    const existing = getEditableQuest(questId);
    if (!existing) return null;
    const enrichment = await enrichQuestDraftIfNeeded({
        id: existing.id,
        title: existing.title,
        summary: existing.summary || '',
        objective: existing.objective || '',
        priority: existing.priority || 'normal',
        urgency: existing.urgency || 'none',
        source: existing.source || '',
        relatedContact: existing.relatedContact || '',
        status: existing.status || 'active',
        focused: !!existing.focused,
        nextAction: existing.nextAction || '',
        subtasks: Array.isArray(existing.subtasks) ? existing.subtasks : [],
        notes: existing.notes || '',
        manualOverrides: { ...(existing.manualOverrides || {}) },
    });
    if (enrichment.error) {
        throw enrichment.error;
    }
    if (!enrichment.changed) {
        showToast(existing.title, 'No missing quest fields to fill.');
        return existing;
    }
    const saved = upsertQuest(enrichment.draft, { oldId: existing.id });
    rebuildPhone();
    switchView('quests');
    showToast(saved.title, 'Filled missing quest fields.');
    return saved;
}

function findContactForQuest(quest = {}) {
    const contacts = getKnownContactsForPrivateMessaging();
    const key = normalizeContactName(quest.relatedContact || quest.source || '');
    if (!key) return null;
    return contacts.find(contact => normalizeContactName(contact.name) === key) || null;
}

function activeQuestSummary(limit = 8) {
    const summary = sortQuests(loadQuests())
        .filter(quest => !['completed', 'failed'].includes(quest.status))
        .slice(0, limit);
    if (!summary.length) return 'No active quests right now.';
    return summary.map(quest => {
        const bits = [
            quest.focused ? 'FOCUSED' : null,
            quest.status !== 'active' ? quest.status : null,
            quest.urgency && quest.urgency !== 'none' ? `${quest.urgency} urgency` : null,
            quest.priority && quest.priority !== 'normal' ? `${quest.priority} priority` : null,
            quest.nextAction ? `next: ${quest.nextAction}` : null,
            quest.objective || quest.summary || null,
            quest.relatedContact ? `contact: ${quest.relatedContact}` : null,
            quest.notes ? `notes: ${quest.notes}` : null,
        ].filter(Boolean);
        return `- ${quest.title}${bits.length ? ` — ${bits.join(' · ')}` : ''}`;
    }).join('\n');
}

function injectQuestPrompt() {
    if (!settings.enabled) {
        clearQuestPrompt();
        return;
    }
    const activeSummary = activeQuestSummary(8);
    setExtensionPrompt(
        INJECT_KEY_QUESTS,
        `[Command-X quest context. At the end of each response, include a [quests] JSON block ONLY when a meaningful quest should be created or updated. Format: [quests][{"id":"quest_optional_existing_id","title":"Quest title","summary":"short summary","objective":"current concrete objective","status":"active|waiting|blocked|completed|failed","priority":"low|normal|high|critical","urgency":"none|soon|urgent","source":"who/what created the quest","relatedContact":"matching contact name when relevant","focused":false,"nextAction":"optional immediate next step","subtasks":[{"id":"sub_optional","text":"step text","done":false}],"notes":"optional note"}][/quests]. Quests represent meaningful goals, obligations, promises, leads, investigations, errands, blockers, or unresolved story pressures that may matter later. Reuse existing quest ids/titles when updating instead of duplicating. Check existing quests for progress, completion, blockage, waiting state, next-step changes, and subtask completion — but do NOT rewrite summaries/objectives/priority/urgency/notes just because wording could be improved. Only change stable quest fields when the story meaning actually changed. Avoid trivial one-off actions and excessive churn, especially on rerolls. Manual quest edits may be pinned field-by-field and should not be blindly overwritten later. Focused quests matter most. Urgent/high-priority active quests matter next. Waiting/blocked quests are still relevant but lower pressure. Completed/failed quests are historical only and should not be treated as current pressure. Not every quest must be mentioned every turn.\nCurrent quest state:\n${activeSummary}]`,
        extension_prompt_types.IN_CHAT,
        4,
        false,
        extension_prompt_roles.SYSTEM,
    );
}

function clearQuestPrompt() {
    setExtensionPrompt(INJECT_KEY_QUESTS, '', extension_prompt_types.NONE, 0);
}

/* ------------------------------------------------------------------
   Prompt injection throttling (Phase 2). Counted per received message;
   when `contactsInjectEveryN` / `questsInjectEveryN` is > 1 we clear
   the relevant injection on off-turns and re-inject on the matching
   turn. A value of 1 (default) keeps the legacy every-turn behavior.
   ------------------------------------------------------------------ */
let _turnCounter = 0;

function applyInjectionThrottle() {
    _turnCounter += 1;
    const contactsN = Math.max(1, Number(settings.contactsInjectEveryN) || 1);
    const questsN = Math.max(1, Number(settings.questsInjectEveryN) || 1);

    if (!settings.enabled) return;

    if (settings.autoDetectNpcs !== false) {
        if (_turnCounter % contactsN === 0) injectContactsPrompt();
        else if (contactsN > 1) clearContactsPrompt();
    }
    if (_turnCounter % questsN === 0) injectQuestPrompt();
    else if (questsN > 1) clearQuestPrompt();

    const pollN = Math.floor(Number(settings.autoPrivatePollEveryN) || 0);
    if (pollN > 0 && _turnCounter % pollN === 0) {
        pollPrivateMessages({ silent: true }).catch(e => console.warn(`[${EXT}] Auto private poll error`, e));
    }
}

function hideQuestTagsInDom(mesId) {
    const el = document.querySelector(`.mes[mesid="${mesId}"] .mes_text`);
    if (!el) return;
    QUESTS_TAG_RE.lastIndex = 0;
    if (QUESTS_TAG_RE.test(el.innerHTML)) {
        QUESTS_TAG_RE.lastIndex = 0;
        el.innerHTML = el.innerHTML.replace(QUESTS_TAG_RE, '');
    }
}

function questPriorityBadge(priority) {
    const value = sanitizeQuestValue('priority', priority) || 'normal';
    return `<span class="cx-quest-priority cx-quest-priority-${escAttr(value)}">${escHtml(value)}</span>`;
}

function questUrgencyBadge(urgency) {
    const value = sanitizeQuestValue('urgency', urgency) || 'none';
    if (value === 'none') return '';
    return `<span class="cx-quest-urgency cx-quest-urgency-${escAttr(value)}">${escHtml(value)}</span>`;
}

function questStatusBadge(status) {
    const value = sanitizeQuestValue('status', status) || 'active';
    return `<span class="cx-quest-status cx-quest-status-${escAttr(value)}">${escHtml(value)}</span>`;
}

function renderQuestSubtasks(quest) {
    const subtasks = Array.isArray(quest.subtasks) ? quest.subtasks : [];
    if (!subtasks.length) return '';
    const doneCount = subtasks.filter(item => item.done).length;
    return `
        <div class="cx-quest-field">
            <span>Checklist · ${doneCount}/${subtasks.length}</span>
            <div class="cx-quest-subtasks">
                ${subtasks.map(item => `
                    <button type="button" class="cx-quest-subtask ${item.done ? 'done' : ''}" data-cx-quest-subtask="${escAttr(quest.id)}" data-cx-subtask-id="${escAttr(item.id)}">
                        <span class="cx-quest-checkbox${item.done ? ' done' : ''}"></span>
                        <strong>${escHtml(item.text)}</strong>
                    </button>
                `).join('')}
            </div>
        </div>`;
}

function renderQuestSection(statuses, title) {
    const statusList = Array.isArray(statuses) ? statuses : [statuses];
    const quests = loadQuests().filter(quest => statusList.includes(quest.status));
    return `
        <div class="cx-quest-section">
            <div class="cx-quest-section-head">
                <div class="cx-quest-section-title">${title}</div>
                <div class="cx-quest-section-count">${quests.length}</div>
            </div>
            ${quests.length ? quests.map(quest => {
                const contact = findContactForQuest(quest);
                return `
                <div class="cx-quest-card ${quest.focused ? 'cx-quest-card-focused' : ''}" data-quest-id="${escAttr(quest.id)}">
                    <div class="cx-quest-card-top">
                        <div>
                            <div class="cx-quest-title-row">
                                <div class="cx-quest-title">${escHtml(quest.title || 'Untitled Quest')}</div>
                                ${quest.focused ? '<span class="cx-quest-chip cx-quest-focus-chip">Focused</span>' : ''}
                                ${questStatusBadge(quest.status)}
                            </div>
                            <div class="cx-quest-meta-row">
                                ${questPriorityBadge(quest.priority || 'normal')}
                                ${questUrgencyBadge(quest.urgency || 'none')}
                                ${quest.source ? `<span class="cx-quest-chip">${escHtml(quest.source)}</span>` : ''}
                                ${contact ? `<span class="cx-quest-chip">📱 ${escHtml(contact.name)}</span>` : (quest.relatedContact ? `<span class="cx-quest-chip">📱 ${escHtml(quest.relatedContact)}</span>` : '')}
                                <span class="cx-quest-chip">${new Date(Number(quest.updatedAt || Date.now())).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                            </div>
                        </div>
                    </div>
                    ${quest.summary ? `<div class="cx-quest-summary">${escHtml(quest.summary)}</div>` : ''}
                    ${quest.objective ? `<div class="cx-quest-field"><span>Objective</span><strong>${escHtml(quest.objective)}</strong></div>` : ''}
                    ${quest.nextAction ? `<div class="cx-quest-field"><span>Next Action</span><strong>${escHtml(quest.nextAction)}</strong></div>` : ''}
                    ${renderQuestSubtasks(quest)}
                    ${quest.notes ? `<div class="cx-quest-field"><span>Notes</span><strong>${escHtml(quest.notes)}</strong></div>` : ''}
                    <div class="cx-quest-actions">
                        <button class="cx-profile-action-btn" data-cx-quest-edit="${escAttr(quest.id)}">Edit</button>
                        <button class="cx-profile-action-btn" data-cx-quest-focus="${escAttr(quest.id)}">${quest.focused ? 'Unfocus' : 'Focus'}</button>
                        ${quest.status !== 'waiting' ? `<button class="cx-profile-action-btn" data-cx-quest-status="${escAttr(quest.id)}" data-cx-status-value="waiting">Wait</button>` : ''}
                        ${quest.status !== 'blocked' ? `<button class="cx-profile-action-btn" data-cx-quest-status="${escAttr(quest.id)}" data-cx-status-value="blocked">Block</button>` : ''}
                        ${quest.status !== 'active' ? `<button class="cx-profile-action-btn" data-cx-quest-status="${escAttr(quest.id)}" data-cx-status-value="active">Activate</button>` : ''}
                        ${quest.status !== 'completed' ? `<button class="cx-profile-action-btn" data-cx-quest-complete="${escAttr(quest.id)}">Complete</button>` : ''}
                        ${quest.status !== 'failed' ? `<button class="cx-profile-action-btn cx-quest-fail-btn" data-cx-quest-fail="${escAttr(quest.id)}">Fail</button>` : ''}
                        ${contact ? `<button class="cx-profile-action-btn" data-cx-quest-open-thread="${escAttr(contact.name)}">Open Thread</button>` : ''}
                        <button class="cx-profile-action-btn" data-cx-quest-enhance="${escAttr(quest.id)}">Enhance</button>
                    </div>
                </div>`;
            }).join('') : '<div class="cx-quest-empty">No quests in this section.</div>'}
        </div>`;
}

function getEditableQuest(questId = null) {
    if (!questId) return null;
    return loadQuests().find(quest => quest.id === questId) || null;
}

function openQuestEditor(questId = null) {
    const existing = questId ? getEditableQuest(questId) : null;
    questEditorState = {
        mode: existing ? 'edit' : 'new',
        oldId: existing?.id || null,
        draft: {
            id: existing?.id || '',
            title: existing?.title || '',
            summary: existing?.summary || '',
            objective: existing?.objective || '',
            priority: existing?.priority || 'normal',
            urgency: existing?.urgency || 'none',
            source: existing?.source || '',
            relatedContact: existing?.relatedContact || '',
            status: existing?.status || 'active',
            focused: !!existing?.focused,
            nextAction: existing?.nextAction || '',
            subtasks: (existing?.subtasks || []).map(item => `${item.done ? '[x]' : '[ ]'} ${item.text}`).join('\n'),
            notes: existing?.notes || '',
        },
    };
    rebuildPhone();
    switchView('quests');
}

function closeQuestEditor() {
    if (!questEditorState) return;
    questEditorState = null;
    rebuildPhone();
    switchView('quests');
}


function buildQuestEnrichmentPrompt(partialQuest) {
    const recentMessages = getRecentMessages().slice(-10);
    const knownContacts = getKnownContactsForPrivateMessaging().map(contact => ({
        name: contact.name,
        relationship: contact.relationship || null,
        mood: contact.mood || null,
        location: contact.location || null,
    }));
    return [
        'You are enriching a manually created Command-X quest.',
        'Return ONLY valid JSON matching the provided schema.',
        'Fill ONLY missing or blank fields. Do not rewrite fields the user already supplied.',
        'Keep outputs concise, plausible, and useful for future narrative context.',
        'Subtasks should be short actionable checklist items when appropriate.',
        `Partial quest JSON: ${JSON.stringify(partialQuest)}`,
        `Known contacts JSON: ${JSON.stringify(knownContacts)}`,
        `Recent chat context JSON: ${JSON.stringify(recentMessages)}`,
    ].join('\n');
}

function questEnrichmentSchema() {
    return {
        name: 'CommandXQuestEnrichment',
        description: 'Fill missing quest fields for a manually created Command-X quest.',
        strict: true,
        value: {
            '$schema': 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            additionalProperties: false,
            properties: {
                summary: { type: 'string' },
                objective: { type: 'string' },
                priority: { type: 'string' },
                urgency: { type: 'string' },
                source: { type: 'string' },
                relatedContact: { type: 'string' },
                status: { type: 'string' },
                focused: { type: 'boolean' },
                nextAction: { type: 'string' },
                subtasks: {
                    type: 'array',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            text: { type: 'string' },
                            done: { type: 'boolean' },
                        },
                        required: ['text', 'done'],
                    },
                },
                notes: { type: 'string' },
            },
            required: ['summary', 'objective', 'priority', 'urgency', 'source', 'relatedContact', 'status', 'focused', 'nextAction', 'subtasks', 'notes'],
        },
    };
}

function extractJsonObjectFromText(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced?.[1]) return fenced[1].trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) return text.slice(start, end + 1).trim();
    return null;
}

function parseQuestEnrichmentResponse(raw) {
    if (raw && typeof raw === 'object') return raw;
    if (typeof raw !== 'string') {
        throw new Error(`Quest enrichment returned unsupported type: ${typeof raw}`);
    }
    try {
        return JSON.parse(raw);
    } catch (directError) {
        const extracted = extractJsonObjectFromText(raw);
        if (!extracted || extracted === raw.trim()) {
            throw directError;
        }
        return JSON.parse(extracted);
    }
}

async function enrichQuestDraftIfNeeded(draft) {
    const ctx = getContext();
    if (typeof ctx.generateQuietPrompt !== 'function') return { draft, changed: false, error: new Error('generateQuietPrompt unavailable') };
    const missing = [
        !draft.summary,
        !draft.objective,
        !draft.source,
        !draft.relatedContact,
        !draft.nextAction,
        !draft.notes,
        !Array.isArray(draft.subtasks) || !draft.subtasks.length,
        !draft.priority || draft.priority === 'normal',
        !draft.urgency || draft.urgency === 'none',
    ].some(Boolean);
    if (!missing) return { draft, changed: false, error: null };
    if (questEnrichmentInFlight) return { draft, changed: false, error: new Error('Quest enrichment already running') };
    questEnrichmentInFlight = true;
    let raw = null;
    try {
        raw = await ctx.generateQuietPrompt({
            quietPrompt: buildQuestEnrichmentPrompt(draft),
            jsonSchema: questEnrichmentSchema(),
        });
        const parsed = parseQuestEnrichmentResponse(raw);
        const enriched = { ...draft };
        const fillIfMissing = (field, fallbackCheck) => {
            const current = enriched[field];
            const missingNow = fallbackCheck ? fallbackCheck(current) : (!current || !String(current).trim());
            if (!missingNow) return;
            if (parsed?.[field] == null) return;
            enriched[field] = parsed[field];
        };
        fillIfMissing('summary');
        fillIfMissing('objective');
        fillIfMissing('source');
        fillIfMissing('relatedContact');
        fillIfMissing('nextAction');
        fillIfMissing('notes');
        if ((!enriched.priority || enriched.priority === 'normal') && parsed?.priority) enriched.priority = parsed.priority;
        if ((!enriched.urgency || enriched.urgency === 'none') && parsed?.urgency) enriched.urgency = parsed.urgency;
        if ((!enriched.status || enriched.status === 'active') && parsed?.status) enriched.status = parsed.status;
        if ((!Array.isArray(enriched.subtasks) || !enriched.subtasks.length) && Array.isArray(parsed?.subtasks)) enriched.subtasks = parsed.subtasks;
        if (!enriched.focused && typeof parsed?.focused === 'boolean') enriched.focused = parsed.focused;
        return { draft: enriched, changed: JSON.stringify(enriched) !== JSON.stringify(draft), error: null };
    } catch (error) {
        console.warn('[command-x] quest enrichment failed', error, raw);
        return { draft, changed: false, error };
    } finally {
        questEnrichmentInFlight = false;
    }
}
function parseQuestSubtasksFromEditor(value) {
    return String(value || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map((line, index) => {
            const done = /^\[(x|X)\]\s*/.test(line);
            const text = line.replace(/^\[(x|X| )\]\s*/, '').trim();
            return { id: `sub_editor_${index}_${Math.random().toString(36).slice(2, 6)}`, text, done };
        })
        .filter(item => item.text);
}

async function saveQuestEditor() {
    if (!questEditorState) return;
    const form = phoneContainer?.querySelector('#cx-quest-form');
    if (!form) return;
    const data = new FormData(form);
    const draft = {
        id: String(data.get('id') || '').trim() || undefined,
        title: String(data.get('title') || '').trim(),
        summary: String(data.get('summary') || '').trim(),
        objective: String(data.get('objective') || '').trim(),
        priority: String(data.get('priority') || 'normal').trim().toLowerCase(),
        urgency: String(data.get('urgency') || 'none').trim().toLowerCase(),
        source: String(data.get('source') || '').trim(),
        relatedContact: String(data.get('relatedContact') || '').trim(),
        status: String(data.get('status') || 'active').trim().toLowerCase(),
        focused: data.get('focused') === 'on',
        nextAction: String(data.get('nextAction') || '').trim(),
        subtasks: parseQuestSubtasksFromEditor(data.get('subtasks')),
        notes: String(data.get('notes') || '').trim(),
        manualOverrides: QUEST_FIELDS.reduce((acc, field) => {
            acc[field] = true;
            return acc;
        }, {}),
    };

    if (!draft.title) {
        await cxAlert('Quest title is required.', 'Quest Editor');
        return;
    }

    try {
        let finalDraft = draft;
        if (questEditorState.mode === 'new') {
            const enrichment = await enrichQuestDraftIfNeeded(draft);
            finalDraft = enrichment.draft;
            if (enrichment.error) {
                showToast(draft.title, `Quest save kept your fields, but AI fill failed: ${enrichment.error.message || enrichment.error}`);
            } else if (enrichment.changed) {
                showToast(draft.title, 'Filled missing quest fields.');
            }
        }
        const saved = upsertQuest(finalDraft, { oldId: questEditorState.oldId || null });
        const wasNew = questEditorState.mode === 'new';
        questEditorState = null;
        rebuildPhone();
        switchView('quests');
        showToast(saved.title, wasNew ? 'Quest added.' : 'Quest updated.');
    } catch (error) {
        await cxAlert(String(error?.message || error), 'Quest Error');
    }
}

function questEditorModalHTML() {
    if (!questEditorState) return '';
    const draft = questEditorState.draft || {};
    const title = questEditorState.mode === 'new' ? 'Add Quest' : 'Edit Quest';
    const saveLabel = questEditorState.mode === 'new' ? 'Add Quest' : 'Save Changes';
    return `
    <div class="cx-quest-editor-backdrop" id="cx-quest-editor-backdrop">
        <div class="cx-quest-editor-sheet" role="dialog" aria-modal="true" aria-label="${title}">
            <div class="cx-profile-editor-header">
                <div>
                    <div class="cx-profile-editor-title">${title}</div>
                    <div class="cx-profile-editor-sub">Manual quest edits stay pinned over later automatic [quests] updates.</div>
                </div>
                <button type="button" class="cx-profile-editor-close" id="cx-quest-cancel">✕</button>
            </div>
            <form class="cx-profile-editor-form" id="cx-quest-form">
                <input type="hidden" name="id" value="${escAttr(draft.id || '')}" />
                <label class="cx-profile-editor-field">
                    <span>Title</span>
                    <input type="text" name="title" maxlength="120" value="${escAttr(draft.title || '')}" placeholder="Meet Sarah at the diner" />
                </label>
                <label class="cx-profile-editor-field">
                    <span>Summary</span>
                    <textarea name="summary" placeholder="Why this matters...">${escapeHtml(draft.summary || '')}</textarea>
                </label>
                <label class="cx-profile-editor-field">
                    <span>Objective</span>
                    <textarea name="objective" placeholder="What needs to happen next...">${escapeHtml(draft.objective || '')}</textarea>
                </label>
                <div class="cx-profile-editor-grid">
                    <label class="cx-profile-editor-field">
                        <span>Priority</span>
                        <select name="priority">
                            ${['low', 'normal', 'high', 'critical'].map(value => `<option value="${value}" ${draft.priority === value ? 'selected' : ''}>${value}</option>`).join('')}
                        </select>
                    </label>
                    <label class="cx-profile-editor-field">
                        <span>Urgency</span>
                        <select name="urgency">
                            ${['none', 'soon', 'urgent'].map(value => `<option value="${value}" ${draft.urgency === value ? 'selected' : ''}>${value}</option>`).join('')}
                        </select>
                    </label>
                </div>
                <div class="cx-profile-editor-grid">
                    <label class="cx-profile-editor-field">
                        <span>Status</span>
                        <select name="status">
                            ${['active', 'waiting', 'blocked', 'completed', 'failed'].map(value => `<option value="${value}" ${draft.status === value ? 'selected' : ''}>${value}</option>`).join('')}
                        </select>
                    </label>
                    <label class="cx-profile-editor-field">
                        <span>Focused</span>
                        <label class="cx-quest-checkbox-row"><input type="checkbox" name="focused" ${draft.focused ? 'checked' : ''} /><strong>Pin this as the current focus</strong></label>
                    </label>
                </div>
                <label class="cx-profile-editor-field">
                    <span>Next Action</span>
                    <input type="text" name="nextAction" maxlength="160" value="${escAttr(draft.nextAction || '')}" placeholder="Text Sarah that you're on your way" />
                </label>
                <div class="cx-profile-editor-grid">
                    <label class="cx-profile-editor-field">
                        <span>Source</span>
                        <input type="text" name="source" maxlength="120" value="${escAttr(draft.source || '')}" placeholder="Sarah" />
                    </label>
                    <label class="cx-profile-editor-field">
                        <span>Related Contact</span>
                        <input type="text" name="relatedContact" maxlength="120" value="${escAttr(draft.relatedContact || '')}" placeholder="Sarah" />
                    </label>
                </div>
                <label class="cx-profile-editor-field">
                    <span>Subtasks</span>
                    <textarea name="subtasks" placeholder="[ ] Leave apartment&#10;[x] Grab keys">${escapeHtml(draft.subtasks || '')}</textarea>
                </label>
                <label class="cx-profile-editor-field">
                    <span>Notes</span>
                    <textarea name="notes" placeholder="Pinned details, reminders, caveats...">${escapeHtml(draft.notes || '')}</textarea>
                </label>
                <div class="cx-profile-editor-footer">
                    <button type="button" class="cx-profile-editor-secondary" id="cx-quest-cancel-footer">Cancel</button>
                    <button type="submit" class="cx-profile-editor-primary">${saveLabel}</button>
                </div>
            </form>
        </div>
    </div>`;
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
    // Any command (neural-mode or legacy {{COMMAND}} syntax) is treated as subliminal —
    // character unaware, no SMS reply.
    if (cmdType) {
        const cmdContext = {
            COMMAND: `${contactName} is completely unaware any command was sent. They simply feel an irresistible compulsion to comply, as if it were their own idea. They do NOT see, read, or acknowledge the command itself.`,
            FORGET: `${contactName} is completely unaware their memory is being altered. The specified memory or knowledge simply fades away as if it was never there. They do NOT see, read, or acknowledge any command.`,
            BELIEVE: `${contactName} is completely unaware their perception is being rewritten. They now genuinely hold the stated belief as absolute truth, as if they always believed it. They do NOT see, read, or acknowledge any command.`,
            COMPEL: `${contactName} is completely unaware of any external influence. They feel an overwhelming internal urge driving them toward the specified behavior, but it feels entirely like their own desire. They do NOT see, read, or acknowledge any command.`,
        }[cmdType] || '';
        return `A subliminal ${cmdType} neural command was silently transmitted to ${contactName}. ${cmdContext} ${contactName} has no idea a command was received and does NOT send a text message in response. Show the command taking effect only through ${contactName}'s in-scene behavior, thoughts, or narrative — no [sms] tag, no phone reply.`;
    } else if (isNeural) {
        return `A subliminal neural command was silently transmitted to ${contactName}. They are completely unaware any command was sent or received. They do NOT send a text message in response. Show the command taking effect only through ${contactName}'s in-scene behavior or narrative — no [sms] tag, no phone reply.`;
    } else {
        return `The user texted ${contactName}. ${contactName} texts back naturally and in-character. Wrap their reply to the user in [sms from="${contactName}" to="user"]...[/sms].`;
    }
}

/**
 * Inject SMS prompt for one or more targets.
 * @param {Array<{name:string, isNeural:boolean, cmdType:string|null}>} targets
 */
function injectSmsPrompt(targets) {
    const parts = targets.map(t => buildSmsInstruction(t.name, t.isNeural, t.cmdType));
    const names = targets.map(t => t.name);
    const multi = targets.length > 1;

    // Determine which targets expect an SMS reply (non-neural, non-command texting only).
    // Commands (whether via neural mode or legacy {{COMMAND}} syntax) don't produce [sms] replies.
    const smsTargets = targets.filter(t => !t.isNeural && !t.cmdType);
    const allNeural = smsTargets.length === 0;

    let instruction = `[System: ${parts.join(' ')}`;
    if (!allNeural) {
        if (multi && smsTargets.length > 1) {
            instruction += ` Include a separate [sms from="Name"] block for EACH person who was texted. Each person replies independently.`;
        }
        const smsExampleName = smsTargets.length ? smsTargets[0].name : names[0];
        instruction += ` Example: *She glanced at her phone.* [sms from="${smsExampleName}" to="user"]hey yeah on my way[/sms] *She set it down.*`;
        if (multi && smsTargets.length > 1) {
            instruction += ` [sms from="${smsTargets[1].name}" to="user"]sounds good[/sms]`;
        }
        instruction += ` — The [sms] block is phone text content only. Always include from and to attributes. Only use to="user" for texts directed at the user's phone. If characters text each other, do NOT use [sms] tags — just narrate it normally.`;
    }
    instruction += `]`;

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

/* ------------------------------------------------------------------
   Phase 2 caches — keyed by current chat id, invalidated on any write.
   historyContactNames() used to scan every localStorage key, and sort
   helpers re-parsed every message thread for a single timestamp each
   time the phone rebuilt. These caches make both O(1) amortized.
   ------------------------------------------------------------------ */
let _historyContactNamesCache = { chatId: null, names: null };
const _lastMsgTsCache = new Map(); // key: `${chatId}::${contactName}` -> ts

function invalidateContactCaches(contactName = null) {
    _historyContactNamesCache = { chatId: null, names: null };
    if (contactName == null) _lastMsgTsCache.clear();
    else {
        const prefix = `${currentChatId()}::`;
        _lastMsgTsCache.delete(prefix + contactName);
    }
}

function lastMessageTs(contactName) {
    const key = `${currentChatId()}::${contactName}`;
    if (_lastMsgTsCache.has(key)) return _lastMsgTsCache.get(key);
    const msgs = loadMessages(contactName);
    const ts = msgs.length ? (msgs[msgs.length - 1].ts || 0) : 0;
    _lastMsgTsCache.set(key, ts);
    return ts;
}

function loadMessages(contactName) {
    try { return JSON.parse(localStorage.getItem(storeKey(contactName)) || '[]'); }
    catch { return []; }
}

function saveMessages(contactName, msgs) {
    try { localStorage.setItem(storeKey(contactName), JSON.stringify(msgs.slice(-MESSAGE_HISTORY_CAP))); }
    catch (e) { console.warn('[command-x] store save', e); }
    invalidateContactCaches(contactName);
}

function pushMessage(contactName, type, text, mesId) {
    const msgs = loadMessages(contactName);
    msgs.push({ type, text, time: now(), ts: Date.now(), mesId: mesId ?? null });
    saveMessages(contactName, msgs);
}

function historyContactNames() {
    const chatId = currentChatId();
    if (_historyContactNamesCache.chatId === chatId && _historyContactNamesCache.names) {
        return _historyContactNamesCache.names.slice();
    }
    const prefix = `cx-msgs-${chatId}-`;
    const names = new Set();
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith(prefix)) continue;
        const name = key.slice(prefix.length).trim();
        if (name) names.add(name);
    }
    const result = [...names];
    _historyContactNamesCache = { chatId, names: result };
    return result.slice();
}

function getKnownContactsForPrivateMessaging() {
    const contacts = getContactsFromContext();
    const byName = new Map(contacts.map(c => [normalizeContactName(c.name), c]));
    for (const name of historyContactNames()) {
        const normalized = normalizeContactName(name);
        if (byName.has(normalized)) continue;
        byName.set(normalized, {
            id: `history_${normalized}`,
            name,
            emoji: '🧑',
            gradient: CONTACT_GRADIENTS[byName.size % CONTACT_GRADIENTS.length],
            online: false,
            isNpc: true,
            status: 'known',
            mood: null,
            location: null,
            relationship: null,
            thoughts: null,
            avatarUrl: null,
            isHistoryOnly: true,
        });
    }
    return [...byName.values()].sort((a, b) => {
        const aTs = lastMessageTs(a.name);
        const bTs = lastMessageTs(b.name);
        if (aTs && !bTs) return -1;
        if (!aTs && bTs) return 1;
        return bTs - aTs;
    });
}

function sanitizePhoneEvent(event = {}) {
    const type = String(event.type || 'incoming_sms').trim() || 'incoming_sms';
    const from = String(event.from || '').trim();
    const to = String(event.to || 'user').trim() || 'user';
    const text = String(event.text || '').trim();
    if (!from || !text) return null;
    return {
        id: String(event.id || `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
        type,
        from,
        to,
        text,
        visibility: event.visibility === 'public' ? 'public' : 'private',
        source: String(event.source || 'out_of_band').trim() || 'out_of_band',
        canonical: event.canonical !== false,
        sceneAware: event.sceneAware === true,
        timestamp: Number.isFinite(Number(event.timestamp)) ? Number(event.timestamp) : Date.now(),
        mesId: event.mesId ?? null,
    };
}

function removePrivatePhoneEventsForMesId(mesId) {
    if (mesId == null) return;
    const events = loadPrivatePhoneEvents();
    const filtered = events.filter(event => event.mesId !== mesId);
    if (filtered.length !== events.length) {
        savePrivatePhoneEvents(filtered);
        refreshPrivatePhonePrompt();
    }
}

function loadPrivatePhoneEvents() {
    return [...getExtensionChatState().events].sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
}

function savePrivatePhoneEvents(events) {
    const clean = (Array.isArray(events) ? events : [])
        .map(sanitizePhoneEvent)
        .filter(Boolean)
        .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0))
        .slice(-MESSAGE_HISTORY_CAP);
    saveExtensionChatState({ events: clean });
    return clean;
}

function pushPrivatePhoneEvent(event) {
    const clean = sanitizePhoneEvent(event);
    if (!clean) return null;
    const events = loadPrivatePhoneEvents();
    events.push(clean);
    savePrivatePhoneEvents(events);
    refreshPrivatePhonePrompt();
    return clean;
}

function privateEventSummaryLine(event) {
    if (!event) return null;
    const sourceLabel = event.source === 'out_of_band' ? 'out-of-band' : 'inline';
    const direction = String(event.type || '').startsWith('outgoing') ? 'You texted' : `${event.from} texted`;
    return `${direction}: "${event.text}" (${sourceLabel}, private)`;
}

function buildPrivatePhoneSummary(limit = 8) {
    const events = loadPrivatePhoneEvents().slice(-limit);
    if (!events.length) return 'No recent private phone events.';
    return events
        .map(privateEventSummaryLine)
        .filter(Boolean)
        .map(line => `- ${line}`)
        .join('\n');
}

function refreshPrivatePhonePrompt() {
    if (!settings.enabled || settings.manualHybridPrivateTexts === false) {
        setExtensionPrompt(INJECT_KEY_PRIVATE_PHONE, '', extension_prompt_types.NONE, 0);
        return;
    }
    const summary = buildPrivatePhoneSummary(8);
    const prompt = `[Command-X private phone context — phone events are private by default. The user and the sender know the contents of each private text. Other in-scene characters do NOT automatically know these texts unless the user reveals them, another character observes the phone activity, or the narration explicitly establishes disclosure. Private phone events may influence the user's private mood, decisions, and replies, but they remain non-public scene knowledge by default.
Recent private phone events:
${summary}]`;
    setExtensionPrompt(
        INJECT_KEY_PRIVATE_PHONE,
        prompt,
        extension_prompt_types.IN_CHAT,
        3,
        false,
        extension_prompt_roles.SYSTEM,
    );
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

function setUnread(contactName, value) {
    const count = Math.max(0, parseInt(value || '0', 10) || 0);
    if (!count) localStorage.removeItem(unreadKey(contactName));
    else localStorage.setItem(unreadKey(contactName), String(count));
    updateUnreadBadges();
}

function showToast(contactName, text) {
    // Remove existing toast
    document.getElementById('cx-toast')?.remove();
    const preview = text.length > 60 ? text.slice(0, 60) + '…' : text;
    const toast = document.createElement('div');
    toast.id = 'cx-toast';
    toast.className = 'cx-toast cx-toast-show';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.setAttribute('aria-label', `New message from ${contactName}`);
    toast.innerHTML = `<div class="cx-toast-icon">📱</div><div class="cx-toast-body"><div class="cx-toast-name">${escHtml(contactName)}</div><div class="cx-toast-text">${escHtml(preview)}</div></div>`;
    // Esc key listener variable — declared early so the click handler can reference it
    let onKey;

    toast.addEventListener('click', () => {
        document.removeEventListener('keydown', onKey);
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

    // Auto-dismiss with pause-on-hover
    let remainingMs = TOAST_DURATION_MS;
    let startedAt = Date.now();
    let dismissTimer = null;
    const dismiss = () => {
        document.removeEventListener('keydown', onKey);
        if (dismissTimer) { clearTimeout(dismissTimer); dismissTimer = null; }
        toast.classList.remove('cx-toast-show');
        setTimeout(() => toast.remove(), 400);
    };
    const armDismiss = (ms) => {
        if (dismissTimer) clearTimeout(dismissTimer);
        dismissTimer = setTimeout(dismiss, ms);
    };
    toast.addEventListener('mouseenter', () => {
        if (dismissTimer) { clearTimeout(dismissTimer); dismissTimer = null; }
        remainingMs = Math.max(0, remainingMs - (Date.now() - startedAt));
    });
    toast.addEventListener('mouseleave', () => {
        startedAt = Date.now();
        armDismiss(remainingMs);
    });
    armDismiss(TOAST_DURATION_MS);

    // Dismiss on Esc — listener always cleaned up inside dismiss()
    onKey = (e) => { if (e.key === 'Escape') dismiss(); };
    document.addEventListener('keydown', onKey);
}

/**
 * Styled in-phone alert (replaces native alert()).
 * Returns a Promise that resolves when the user clicks OK.
 * Esc also closes the dialog. Enter is handled natively by the focused OK button.
 */
function cxAlert(message, title = 'Command-X') {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'cx-modal-overlay';
        overlay.innerHTML = `
        <div class="cx-modal-box" role="alertdialog" aria-modal="true" aria-labelledby="cx-modal-title" aria-describedby="cx-modal-body">
            <div class="cx-modal-title" id="cx-modal-title">${escHtml(title)}</div>
            <div class="cx-modal-body" id="cx-modal-body">${escHtml(message)}</div>
            <div class="cx-modal-actions">
                <button class="cx-modal-btn cx-modal-btn-primary" id="cx-modal-ok" autofocus>OK</button>
            </div>
        </div>`;
        const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(); };
        const onKey = (e) => { if (e.key === 'Escape') close(); };
        overlay.querySelector('#cx-modal-ok').addEventListener('click', close);
        document.addEventListener('keydown', onKey);
        document.body.appendChild(overlay);
        overlay.querySelector('#cx-modal-ok').focus();
    });
}

/**
 * Styled in-phone confirm dialog (replaces native confirm()).
 * Returns a Promise<boolean> — true if user confirms, false if cancelled.
 * Esc cancels. Enter is handled natively by the focused button.
 * When danger=true the cancel button receives initial focus to reduce accidental
 * confirmation of destructive operations.
 */
function cxConfirm(message, title = 'Are you sure?', { confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = {}) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'cx-modal-overlay';
        overlay.innerHTML = `
        <div class="cx-modal-box" role="alertdialog" aria-modal="true" aria-labelledby="cx-modal-title" aria-describedby="cx-modal-body">
            <div class="cx-modal-title" id="cx-modal-title">${escHtml(title)}</div>
            <div class="cx-modal-body" id="cx-modal-body">${escHtml(message)}</div>
            <div class="cx-modal-actions">
                <button class="cx-modal-btn cx-modal-btn-secondary" id="cx-modal-cancel">${escHtml(cancelLabel)}</button>
                <button class="cx-modal-btn ${danger ? 'cx-modal-btn-danger' : 'cx-modal-btn-primary'}" id="cx-modal-confirm">${escHtml(confirmLabel)}</button>
            </div>
        </div>`;
        const close = (result) => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(result); };
        const onKey = (e) => { if (e.key === 'Escape') close(false); };
        overlay.querySelector('#cx-modal-cancel').addEventListener('click', () => close(false));
        overlay.querySelector('#cx-modal-confirm').addEventListener('click', () => close(true));
        document.addEventListener('keydown', onKey);
        document.body.appendChild(overlay);
        // Dangerous actions default to cancel focus; safe confirms default to confirm focus.
        overlay.querySelector(danger ? '#cx-modal-cancel' : '#cx-modal-confirm').focus();
    });
}

function markRead(contactName) {
    localStorage.removeItem(unreadKey(contactName));
    updateUnreadBadges();
}

function getTotalUnread() {
    const contacts = getKnownContactsForPrivateMessaging();
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
    const allContacts = getKnownContactsForPrivateMessaging();
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
    const userName = normalizeContactName(ctx.name1 || '');
    const storedNpcs = loadNpcs();
    const storedByName = new Map(storedNpcs.map(npc => [normalizeContactName(npc.name), npc]));
    const deduped = new Map();

    chars
        .filter(c => normalizeContactName(c.name || '') !== userName)
        .forEach((c, i) => {
            const key = normalizeContactName(c.name || '');
            const npcData = storedByName.get(key) || {};
            let thumbUrl = null;
            if (c.avatar && typeof c.avatar === 'string' && !c.avatar.startsWith('none')) {
                try { thumbUrl = `/thumbnail?type=avatar&file=${encodeURIComponent(c.avatar)}`; }
                catch { /* ignore */ }
            }
            const liveContact = {
                id: c.avatar || `char_${i}`,
                name: c.name || `Character ${i + 1}`,
                emoji: CONTACT_EMOJIS[i % CONTACT_EMOJIS.length],
                gradient: CONTACT_GRADIENTS[i % CONTACT_GRADIENTS.length],
                online: true,
                isNpc: false,
                status: 'online',
                mood: null,
                location: null,
                relationship: null,
                thoughts: null,
                avatarUrl: thumbUrl || npcData.avatarUrl || getGlobalAvatar(c.name) || null,
                isManual: !!npcData.isManual,
                manualOverrides: { ...(npcData.manualOverrides || {}) },
            };
            deduped.set(key, mergeStoredContactRecord(npcData, liveContact, { preferExisting: true }));
        });

    storedNpcs
        .filter(n => normalizeContactName(n.name || '') !== userName)
        .forEach((npc, i) => {
            const key = normalizeContactName(npc.name);
            if (!key) return;
            const fallback = {
                id: `npc_${i}`,
                name: npc.name,
                emoji: npc.emoji || '🧑',
                gradient: CONTACT_GRADIENTS[(chars.length + i) % CONTACT_GRADIENTS.length],
                online: npc.status === 'online' || npc.status === 'nearby',
                isNpc: true,
                status: npc.status || 'nearby',
                npcStatus: npc.status || 'nearby',
                mood: npc.mood || null,
                location: npc.location || null,
                relationship: npc.relationship || null,
                thoughts: npc.thoughts || null,
                avatarUrl: npc.avatarUrl || getGlobalAvatar(npc.name) || null,
                isManual: !!npc.isManual,
                manualOverrides: { ...(npc.manualOverrides || {}) },
            };
            if (deduped.has(key)) {
                const existing = deduped.get(key);
                const merged = mergeStoredContactRecord(npc, existing, { preferExisting: true });
                merged.name = existing.name || npc.name;
                merged.isNpc = false;
                merged.online = existing.online;
                merged.avatarUrl = existing.avatarUrl || npc.avatarUrl || getGlobalAvatar(npc.name) || null;
                deduped.set(key, merged);
                return;
            }
            deduped.set(key, fallback);
        });

    const contacts = [...deduped.values()];
    contacts.sort((a, b) => {
        const aTs = lastMessageTs(a.name);
        const bTs = lastMessageTs(b.name);
        if (aTs && !bTs) return -1;
        if (!aTs && bTs) return 1;
        return bTs - aTs;
    });
    return contacts;
}

const now = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const today = () => new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
function escHtml(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>'); }
function escAttr(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }


function buildOutOfBandPollPrompt() {
    const contacts = getKnownContactsForPrivateMessaging();
    const recentMessages = getRecentMessages().slice(-10);
    const phoneHistory = contacts.flatMap(contact => {
        const msgs = loadMessages(contact.name).slice(-4);
        return msgs.map(msg => ({
            contact: contact.name,
            direction: msg.type === 'received' ? 'incoming' : 'outgoing',
            text: msg.text,
            ts: msg.ts || 0,
        }));
    }).sort((a, b) => a.ts - b.ts).slice(-18);

    const contactSummary = contacts.map(contact => ({
        name: contact.name,
        status: contact.status || null,
        mood: contact.mood || null,
        location: contact.location || null,
        relationship: contact.relationship || null,
        thoughts: contact.thoughts || null,
        historyOnly: !!contact.isHistoryOnly,
    }));

    return [
        'You are generating private phone activity for Command-X.',
        'Return ONLY valid JSON matching the provided schema.',
        'Generate 0 to 3 plausible inbound SMS events from known contacts.',
        'These are private phone events: the user and sender know them; unrelated scene characters do NOT automatically know them.',
        'Do not write public narration. Do not mention tags. Do not include explanations.',
        'Prefer plausibility over volume. It is valid to return no events.',
        'Any sender must come from the known contact list below.',
        '',
        `Known contacts JSON: ${JSON.stringify(contactSummary)}`,
        `Recent chat context JSON: ${JSON.stringify(recentMessages)}`,
        `Recent phone history JSON: ${JSON.stringify(phoneHistory)}`,
        `Existing private phone summary:
${buildPrivatePhoneSummary(8)}`,
    ].join('\n');
}

function privatePhoneSchema() {
    return {
        name: 'CommandXPrivatePhonePoll',
        description: 'Structured out-of-band private SMS events for Command-X.',
        strict: true,
        value: {
            '$schema': 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            additionalProperties: false,
            properties: {
                events: {
                    type: 'array',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            from: { type: 'string' },
                            to: { type: 'string' },
                            text: { type: 'string' },
                            shouldSend: { type: 'boolean' },
                            reason: { type: 'string' },
                        },
                        required: ['from', 'to', 'text', 'shouldSend', 'reason'],
                    },
                },
            },
            required: ['events'],
        },
    };
}

function parsePrivatePhoneGeneration(raw) {
    if (!raw) return [];
    let parsed = {};
    try {
        parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (error) {
        console.warn(`[${EXT}] Could not parse private phone generation`, error, raw);
        return [];
    }
    const knownContacts = getKnownContactsForPrivateMessaging();
    const knownByName = new Map(knownContacts.map(contact => [normalizeContactName(contact.name), contact.name]));
    return (Array.isArray(parsed?.events) ? parsed.events : [])
        .filter(event => event && event.shouldSend !== false)
        .map(event => {
            const sender = knownByName.get(normalizeContactName(event.from));
            if (!sender) return null;
            return sanitizePhoneEvent({
                type: 'incoming_sms',
                from: sender,
                to: 'user',
                text: event.text,
                visibility: 'private',
                source: 'out_of_band',
                canonical: true,
                sceneAware: false,
                timestamp: Date.now(),
            });
        })
        .filter(Boolean)
        .slice(0, 3);
}

async function pollPrivateMessages(options = {}) {
    if (privatePollInFlight) return;
    const silent = !!options.silent;
    if (settings.manualHybridPrivateTexts === false) {
        if (!silent) showToast('Command-X', 'Private polling is disabled in settings.');
        return;
    }
    const ctx = getContext();
    if (typeof ctx.generateQuietPrompt !== 'function') {
        if (!silent) await cxAlert('This SillyTavern build does not expose generateQuietPrompt() for private polling.');
        return;
    }
    const contacts = getKnownContactsForPrivateMessaging();
    if (!contacts.length) {
        if (!silent) await cxAlert('No known contacts are available to poll yet.');
        return;
    }

    privatePollInFlight = true;
    const button = phoneContainer?.querySelector('#cx-check-private');
    const status = phoneContainer?.querySelector('#cx-private-status');
    if (!silent) {
        if (button) button.disabled = true;
        if (status) status.textContent = 'Checking private messages…';
    }

    try {
        const raw = await ctx.generateQuietPrompt({
            quietPrompt: buildOutOfBandPollPrompt(),
            jsonSchema: privatePhoneSchema(),
        });
        const events = parsePrivatePhoneGeneration(raw);
        const nowTs = Date.now();
        saveExtensionChatState({
            lastPollAt: nowTs,
            lastPollSummary: events.map(event => ({ from: event.from, text: event.text, timestamp: event.timestamp })),
        });

        for (const event of events) {
            pushPrivatePhoneEvent(event);
            pushMessage(event.from, 'received', event.text, null);
            const isViewingThis = currentContactName === event.from
                && phoneContainer
                && !document.getElementById('cx-panel-wrapper')?.classList.contains('cx-hidden');
            if (!isViewingThis) incrementUnread(event.from);
            if (!silent) showToast(event.from, event.text);
        }

        const area = phoneContainer?.querySelector('#cx-msg-area');
        if (area && currentContactName) renderAllBubbles(area, currentContactName, false);
        updateUnreadBadges();

        if (status && !silent) status.textContent = events.length
            ? `Found ${events.length} private message${events.length === 1 ? '' : 's'}.`
            : 'No new private messages.';
    } catch (error) {
        console.error(`[${EXT}] Private message poll failed`, error);
        if (status && !silent) status.textContent = `Private check failed: ${error?.message || error}`;
    } finally {
        if (!silent && button) button.disabled = false;
        privatePollInFlight = false;
    }
}

/**
 * Manual scan — ask the LLM (out-of-band via generateQuietPrompt) to return a
 * [status] block describing the NPCs/characters currently relevant to the
 * scene. Merges the result into the stored NPC list and refreshes the phone.
 * Invoked by the "Scan Contacts" button on the Profiles app.
 */
function applyScanContactsButtonState() {
    const btn = phoneContainer?.querySelector('#cx-scan-contacts');
    if (!btn) return;
    btn.disabled = scanContactsInFlight;
    btn.textContent = scanContactsInFlight ? 'Scanning…' : SCAN_CONTACTS_LABEL;
}

async function scanContactsNow() {
    if (scanContactsInFlight) return;
    const ctx = getContext();
    if (typeof ctx.generateQuietPrompt !== 'function') {
        await cxAlert('This SillyTavern build does not expose generateQuietPrompt() for manual contact scans.');
        return;
    }

    scanContactsInFlight = true;
    applyScanContactsButtonState();

    try {
        const userName = ctx.name1 || '';
        const excludeNote = [userName].filter(Boolean).map(n => `"${n}"`).join(' or ');
        const quietPrompt =
            `Scan the current scene and return ONLY a [status] block describing every character relevant right now — the main character plus any side characters or NPCs present or recently involved. ` +
            `Format exactly: [status][{"name":"Name","emoji":"👩","status":"online","mood":"😊 happy","location":"her apartment","relationship":"friendly","thoughts":"short first-person inner monologue"}][/status] — ` +
            `"status" is "online"/"offline"/"nearby", "mood" is an emoji + short descriptor, "location" is where they currently are, "relationship" is how they feel about the user, and "thoughts" is a short private first-person thought in the character's own voice. ` +
            `Do NOT include ${excludeNote || 'the user'}. Do NOT include any prose, explanation, or other tags — output the [status] block only.`;

        const raw = await ctx.generateQuietPrompt({ quietPrompt });
        const parsed = extractContacts(raw);
        if (!parsed || !parsed.length) {
            showToast('Command-X', 'Scan complete — no contacts detected.');
            return;
        }
        mergeNpcs(parsed);
        rebuildPhone();
        showToast('Command-X', `Scan complete — ${parsed.length} contact${parsed.length === 1 ? '' : 's'} updated.`);
    } catch (error) {
        console.error(`[${EXT}] Manual contact scan failed`, error);
        await cxAlert(`Contact scan failed: ${error?.message || error}`);
    } finally {
        scanContactsInFlight = false;
        // Re-query because rebuildPhone() may have replaced the button DOM node.
        applyScanContactsButtonState();
    }
}

function normalizeContactName(name) {
    return String(name || '')
        .trim()
        .toLowerCase()
        .replace(/\([^)]*\)/g, ' ')
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
        .replace(/^(the|a|an)\s+/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function safeDataUrlFromFile(file, maxWidth = 256, quality = 0.82) {
    return new Promise((resolve, reject) => {
        if (!file || !file.type || !file.type.startsWith('image/')) {
            reject(new Error('Please choose an image file.'));
            return;
        }
        if (Number.isFinite(file.size) && file.size > MAX_AVATAR_FILE_BYTES) {
            const mb = (MAX_AVATAR_FILE_BYTES / (1024 * 1024)).toFixed(0);
            reject(new Error(`Image is too large (over ${mb} MB). Please choose a smaller file.`));
            return;
        }
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Could not read image file.'));
        reader.onload = () => {
            const img = new Image();
            img.onerror = () => reject(new Error('Could not load selected image.'));
            img.onload = () => {
                const scale = Math.min(1, maxWidth / Math.max(img.width, img.height));
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(img.width * scale));
                canvas.height = Math.max(1, Math.round(img.height * scale));
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                try {
                    resolve(canvas.toDataURL('image/jpeg', quality));
                } catch {
                    reject(new Error('Could not compress image for storage.'));
                }
            };
            img.src = String(reader.result || '');
        };
        reader.readAsDataURL(file);
    });
}

function findStoredNpcIndexByName(name, stored = null) {
    const list = stored || loadNpcs();
    const normalized = normalizeContactName(name);
    return list.findIndex(s => normalizeContactName(s.name) == normalized);
}

function upsertStoredContact(contact, options = {}) {
    if (!contact || !String(contact.name || '').trim()) throw new Error('Contact name is required.');
    const stored = loadNpcs();
    const oldName = options.oldName ? normalizeContactName(options.oldName) : null;
    const targetName = normalizeContactName(contact.name);
    const existingIdx = oldName ? findStoredNpcIndexByName(options.oldName, stored) : -1;
    const collidingIdx = stored.findIndex((entry, idx) => normalizeContactName(entry.name) === targetName && idx !== existingIdx);
    if (collidingIdx >= 0) throw new Error('A contact with that name already exists in this chat.');

    const existingEntry = existingIdx >= 0 ? stored[existingIdx] : null;
    const manualOverrides = { ...(existingEntry?.manualOverrides || {}), ...(contact.manualOverrides || {}) };
    const clean = {
        name: String(contact.name || '').trim(),
        emoji: sanitizeContactValue('emoji', contact.emoji),
        status: sanitizeContactValue('status', contact.status),
        mood: sanitizeContactValue('mood', contact.mood),
        location: sanitizeContactValue('location', contact.location),
        relationship: sanitizeContactValue('relationship', contact.relationship),
        thoughts: sanitizeContactValue('thoughts', contact.thoughts),
        avatarUrl: sanitizeContactValue('avatarUrl', contact.avatarUrl),
        isManual: contact.isManual !== false,
        manualOverrides,
    };

    if (existingIdx >= 0) stored[existingIdx] = { ...stored[existingIdx], ...clean, isManual: true };
    else stored.push(clean);
    saveNpcs(stored);
    if (clean.avatarUrl) setGlobalAvatar(clean.name, clean.avatarUrl);

    if (options.oldName && normalizeContactName(options.oldName) !== targetName) renameContactThread(options.oldName, clean.name);
    return clean;
}

function renameContactThread(oldName, newName) {
    if (!oldName || !newName || oldName === newName) return;
    const oldMsgs = loadMessages(oldName);
    if (oldMsgs.length) {
        saveMessages(newName, oldMsgs);
        try { localStorage.removeItem(storeKey(oldName)); } catch { /* ignore */ }
        invalidateContactCaches();
    }
    const unread = getUnread(oldName);
    if (unread) {
        setUnread(newName, unread);
        try { localStorage.removeItem(unreadKey(oldName)); } catch { /* ignore */ }
    }
    if (currentContactName === oldName) currentContactName = newName;
    composeQueue = composeQueue.map(item => item.contactName === oldName ? { ...item, contactName: newName } : item);
}

function deleteStoredContact(name) {
    const stored = loadNpcs();
    const idx = findStoredNpcIndexByName(name, stored);
    if (idx < 0) return false;
    stored.splice(idx, 1);
    saveNpcs(stored);
    try { localStorage.removeItem(storeKey(name)); } catch { /* ignore */ }
    try { localStorage.removeItem(unreadKey(name)); } catch { /* ignore */ }
    invalidateContactCaches();
    composeQueue = composeQueue.filter(item => item.contactName !== name);
    if (currentContactName === name) currentContactName = null;
    return true;
}

function getEditableContact(name) {
    const contacts = getKnownContactsForPrivateMessaging();
    const found = contacts.find(c => c.name === name);
    if (found) return { ...found };
    const stored = loadNpcs().find(n => normalizeContactName(n.name) === normalizeContactName(name));
    return stored ? { ...stored, isNpc: true, isManual: true } : null;
}

function openProfileEditor(contactName = null) {
    const existing = contactName ? getEditableContact(contactName) : null;
    profileEditorState = {
        mode: existing ? 'edit' : 'new',
        oldName: existing?.name || null,
        draft: {
            name: existing?.name || '',
            emoji: existing?.emoji || '🧑',
            status: existing?.status || (existing?.online ? 'online' : 'nearby'),
            mood: existing?.mood || '',
            location: existing?.location || '',
            relationship: existing?.relationship || '',
            thoughts: existing?.thoughts || '',
            avatarUrl: existing?.avatarUrl || '',
        },
    };
    rebuildPhone();
    switchView('profiles');
}

function closeProfileEditor() {
    if (!profileEditorState) return;
    profileEditorState = null;
    rebuildPhone();
    switchView('profiles');
}

function syncProfileEditorDraftFromForm() {
    if (!profileEditorState) return;
    const form = phoneContainer?.querySelector('#cx-profile-form');
    if (!form) return;
    const data = new FormData(form);
    profileEditorState.draft = {
        ...profileEditorState.draft,
        name: String(data.get('name') || '').trim(),
        emoji: String(data.get('emoji') || '').trim() || '🧑',
        status: String(data.get('status') || 'nearby').trim().toLowerCase(),
        mood: String(data.get('mood') || '').trim(),
        location: String(data.get('location') || '').trim(),
        relationship: String(data.get('relationship') || '').trim(),
        thoughts: String(data.get('thoughts') || '').trim(),
        avatarUrl: String(data.get('avatarUrl') || '').trim(),
    };
}

async function saveProfileEditor() {
    if (!profileEditorState) return;
    const form = phoneContainer?.querySelector('#cx-profile-form');
    if (!form) return;
    const data = new FormData(form);
    const draft = {
        name: String(data.get('name') || '').trim(),
        emoji: String(data.get('emoji') || '').trim() || '🧑',
        status: String(data.get('status') || 'nearby').trim().toLowerCase(),
        mood: String(data.get('mood') || '').trim(),
        location: String(data.get('location') || '').trim(),
        relationship: String(data.get('relationship') || '').trim(),
        thoughts: String(data.get('thoughts') || '').trim(),
        avatarUrl: String(data.get('avatarUrl') || '').trim(),
        manualOverrides: MANUAL_OVERRIDE_FIELDS.reduce((acc, field) => {
            acc[field] = true;
            return acc;
        }, {}),
    };

    if (!draft.name) {
        await cxAlert('Contact name is required.', 'Contact Editor');
        return;
    }

    try {
        const saved = upsertStoredContact(draft, { oldName: profileEditorState.oldName || null });
        const wasNew = profileEditorState.mode === 'new';
        profileEditorState = null;
        rebuildPhone();
        switchView('profiles');
        showToast(saved.name, wasNew ? 'Contact added.' : 'Profile updated.');
    } catch (error) {
        await cxAlert(String(error?.message || error), 'Contact Error');
    }
}

function triggerAvatarPicker(contactName) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) {
            input.remove();
            return;
        }
        try {
            const dataUrl = await safeDataUrlFromFile(file);
            if (profileEditorState) {
                profileEditorState.draft.avatarUrl = dataUrl;
                rebuildPhone();
                switchView('profiles');
                return;
            }
            const existing = getEditableContact(contactName);
            if (!existing) throw new Error('Could not find that contact.');
            upsertStoredContact({
                ...existing,
                avatarUrl: dataUrl,
                manualOverrides: { ...(existing.manualOverrides || {}), avatarUrl: true },
            }, { oldName: existing.name });
            rebuildPhone();
            switchView('profiles');
            showToast(existing.name, 'Avatar updated.');
        } catch (error) {
            await cxAlert(String(error?.message || error), 'Avatar Error');
        } finally {
            input.remove();
        }
    }, { once: true });
    input.click();
}

async function promptDeleteContact(contactName) {
    const contact = getEditableContact(contactName);
    if (!contact?.isNpc) {
        await cxAlert('Only manual/NPC contacts can be deleted from Command-X.');
        return;
    }
    if (!await cxConfirm(`Delete ${contactName} from Command-X contacts for this chat?`, 'Delete Contact', { confirmLabel: 'Delete', danger: true })) return;
    deleteStoredContact(contactName);
    rebuildPhone();
    switchView('profiles');
}

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
    // Disable the in-phone send button while we're awaiting a reply to prevent
    // double-send. It is re-enabled in clearTypingIndicator() + the AWAIT timeout.
    const inPhoneSend = phoneContainer?.querySelector('#cx-send');
    if (inPhoneSend) {
        inPhoneSend.disabled = true;
        inPhoneSend.setAttribute('aria-disabled', 'true');
    }
}

/** Send immediately (instant mode) — single target */
function sendImmediate(contactName, chatText, isNeural, cmdType) {
    injectSmsPrompt([{ name: contactName, isNeural, cmdType }]);
    // Always arm cleanup so the injected per-message prompt is cleared on the next
    // assistant message regardless of whether an SMS reply is expected. SMS-specific
    // UI (typing indicator, auto-route) is gated separately by the caller.
    awaitingReply = true;
    // Parity with flushQueue: ensure awaitingReply gets cleared even if the LLM never
    // responds with a parseable [sms] block.
    if (typingTimeout) { clearTimeout(typingTimeout); typingTimeout = null; }
    typingTimeout = setTimeout(() => {
        clearTypingIndicator();
        if (awaitingReply) awaitingReply = false;
    }, AWAIT_TIMEOUT_MS);
    sendToChat(chatText, contactName, !!cmdType || isNeural);
}

/* ======================================================================
   HTML BUILDERS
   ====================================================================== */

function avatarHTML(c, sizeClass = '') {
    const gradient = escAttr(c.gradient || '');
    const emoji = escHtml(c.emoji || '');
    if (c.avatarUrl) {
        return `<div class="cx-avatar ${sizeClass}" style="background:${gradient}"><img class="cx-avatar-img" data-cx-avatar-fallback="1" src="${escAttr(c.avatarUrl)}" alt=""><span class="cx-avatar-emoji-fallback" style="display:none">${emoji}</span></div>`;
    }
    return `<div class="cx-avatar ${sizeClass}" style="background:${gradient}">${emoji}</div>`;
}

function profileEditorModalHTML() {
    if (!profileEditorState) return '';
    const draft = profileEditorState.draft || {};
    const title = profileEditorState.mode === 'new' ? 'Add Contact' : 'Edit Profile';
    const saveLabel = profileEditorState.mode === 'new' ? 'Add Contact' : 'Save Changes';
    const avatarPreview = draft.avatarUrl
        ? `<div class="cx-profile-editor-avatar-preview"><img src="${escAttr(draft.avatarUrl)}" alt="Avatar preview" /></div>`
        : `<div class="cx-profile-editor-avatar-fallback">${escHtml(draft.emoji || '🧑')}</div>`;
    return `
    <div class="cx-profile-editor-backdrop" id="cx-profile-editor-backdrop">
        <div class="cx-profile-editor-sheet" role="dialog" aria-modal="true" aria-label="${title}">
            <div class="cx-profile-editor-header">
                <div>
                    <div class="cx-profile-editor-title">${title}</div>
                    <div class="cx-profile-editor-sub">Manual contact info stays pinned over future [status] sync updates.</div>
                </div>
                <button type="button" class="cx-profile-editor-close" id="cx-profile-cancel">✕</button>
            </div>
            <form class="cx-profile-editor-form" id="cx-profile-form">
                <div class="cx-profile-editor-avatar-row">
                    ${avatarPreview}
                    <div class="cx-profile-editor-avatar-actions">
                        <button type="button" class="cx-profile-editor-upload" id="cx-profile-upload">Upload Avatar</button>
                        <button type="button" class="cx-profile-editor-clear" id="cx-profile-clear-avatar">Clear Avatar</button>
                    </div>
                </div>
                <label class="cx-profile-editor-field">
                    <span>Name</span>
                    <input type="text" name="name" maxlength="80" value="${escAttr(draft.name || '')}" placeholder="Contact name" />
                </label>
                <div class="cx-profile-editor-grid">
                    <label class="cx-profile-editor-field">
                        <span>Emoji</span>
                        <input type="text" name="emoji" maxlength="8" value="${escAttr(draft.emoji || '🧑')}" placeholder="🧑" />
                    </label>
                    <label class="cx-profile-editor-field">
                        <span>Status</span>
                        <select name="status">
                            <option value="online" ${String(draft.status || 'nearby') === 'online' ? 'selected' : ''}>Online</option>
                            <option value="nearby" ${String(draft.status || 'nearby') === 'nearby' ? 'selected' : ''}>Nearby</option>
                            <option value="offline" ${String(draft.status || 'nearby') === 'offline' ? 'selected' : ''}>Offline</option>
                        </select>
                    </label>
                </div>
                <label class="cx-profile-editor-field">
                    <span>Mood</span>
                    <input type="text" name="mood" maxlength="120" value="${escAttr(draft.mood || '')}" placeholder="😊 calm, keyed up, curious..." />
                </label>
                <label class="cx-profile-editor-field">
                    <span>Location</span>
                    <input type="text" name="location" maxlength="120" value="${escAttr(draft.location || '')}" placeholder="Where they are right now" />
                </label>
                <label class="cx-profile-editor-field">
                    <span>Relationship</span>
                    <input type="text" name="relationship" maxlength="120" value="${escAttr(draft.relationship || '')}" placeholder="friendly, tense, romantic..." />
                </label>
                <label class="cx-profile-editor-field">
                    <span>Inner Monologue</span>
                    <textarea name="thoughts" rows="3" placeholder="What they're privately thinking right now">${escAttr(draft.thoughts || '')}</textarea>
                </label>
                <label class="cx-profile-editor-field">
                    <span>Avatar URL</span>
                    <input type="url" name="avatarUrl" value="${escAttr(draft.avatarUrl || '')}" placeholder="https://... or keep uploaded avatar" />
                </label>
                <div class="cx-profile-editor-footer">
                    <button type="button" class="cx-profile-editor-secondary" id="cx-profile-cancel-footer">Cancel</button>
                    <button type="submit" class="cx-profile-editor-primary">${saveLabel}</button>
                </div>
            </form>
        </div>
    </div>`;
}

function contactRowHTML(c, i, app) {
    const msgs = loadMessages(c.name);
    const last = msgs.length ? msgs[msgs.length - 1] : null;
    const preview = last ? (last.type.startsWith('sent') ? `You: ${last.text}` : last.text) : 'Tap to chat';
    const previewTrunc = preview.length > 38 ? preview.slice(0, 38) + '…' : preview;
    const npcBadge = c.isNpc ? '<span class="cx-npc-badge">NPC</span>' : '';

    return `
    <div class="cx-contact-row" role="button" tabindex="0" aria-label="Open chat with ${escAttr(c.name)}" data-idx="${i}" data-app="${app}" data-cid="${escAttr(c.id)}" data-cname="${escAttr(c.name)}">
        ${avatarHTML(c)}
        <div class="cx-contact-info">
            <div class="cx-contact-name">${escHtml(c.name)} ${npcBadge}</div>
            <div class="cx-contact-preview">${escHtml(previewTrunc)}</div>
        </div>
        <div class="cx-status-col">
            ${c.online ? '<div class="cx-dot-online"></div>' : '<div class="cx-dot-offline"></div>'}
            ${last ? `<div class="cx-status-time">${last.time || ''}</div>` : ''}
        </div>
    </div>`;
}

function buildPhone() {
    const contacts = getKnownContactsForPrivateMessaging();
    const hasContacts = contacts.length > 0;
    const quests = loadQuests();
    const activeQuestCount = quests.filter(quest => quest.status === 'active').length;
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
            <div class="cx-notif" data-goto="cmdx" role="button" tabindex="0" aria-label="Open Command-X — neural link active">
                <div class="cx-notif-app">COMMAND-X</div>
                <div class="cx-notif-title">Neural Link Active</div>
                <div class="cx-notif-body">${contacts.length} contact${contacts.length > 1 ? 's' : ''} synced. Tap to open.</div>
            </div>` : ''}
            <div class="cx-lock-hint" data-action="unlock" role="button" tabindex="0" aria-label="Unlock phone">Tap to unlock</div>
        </div>

        <!-- Home Screen -->
        <div class="cx-view cx-home ${homeActive}" data-view="home">
            <div class="cx-home-time">${now()}</div>
            <div class="cx-home-date">${today()}</div>
            <div class="cx-app-grid">
                <div class="cx-app-icon" data-app="cmdx" role="button" tabindex="0" aria-label="Open Command-X app">
                    <div class="cx-icon-img cx-icon-cmdx">⚡</div>
                    <div class="cx-icon-label">Command-X</div>
                </div>
                <div class="cx-app-icon" data-app="profiles" role="button" tabindex="0" aria-label="Open Profiles app">
                    <div class="cx-icon-img cx-icon-profiles">🔍</div>
                    <div class="cx-icon-label">Profiles</div>
                </div>
                <div class="cx-app-icon" data-app="quests" role="button" tabindex="0" aria-label="Open Quests app">
                    <div class="cx-icon-img cx-icon-quests">🗺️</div>
                    <div class="cx-icon-label">Quests${activeQuestCount ? ` (${activeQuestCount})` : ''}</div>
                </div>
                <div class="cx-app-icon" data-app="openclaw" role="button" tabindex="0" aria-label="Open OpenClaw app">
                    <div class="cx-icon-img cx-icon-openclaw">🦞</div>
                    <div class="cx-icon-label">OpenClaw</div>
                </div>
                <div class="cx-app-icon" data-app="phone-settings" role="button" tabindex="0" aria-label="Open Settings">
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
            <div class="cx-private-bar">
                <button class="cx-settings-btn cx-private-btn" id="cx-check-private" ${settings.manualHybridPrivateTexts === false ? 'disabled' : ''}>Check Messages</button>
                <div class="cx-private-status" id="cx-private-status">${settings.manualHybridPrivateTexts === false ? 'Private polling disabled in settings.' : 'Manual hybrid private texting ready.'}</div>
            </div>
            <div class="cx-contact-list">
                ${hasContacts ? contacts.map((c, i) => contactRowHTML(c, i, 'cmdx')).join('') : '<div style="padding:20px;color:#666;text-align:center">No characters in current chat</div>'}
            </div>
            <div class="cx-navbar">
                <div class="cx-nav active"><div class="cx-nav-ico">💬</div><div class="cx-nav-lbl">Chats</div></div>
                <div class="cx-nav" data-goto="home" role="button" tabindex="0" aria-label="Go to home screen"><div class="cx-nav-ico">🏠</div><div class="cx-nav-lbl">Home</div></div>
            </div>
        </div>

        <!-- Profiles View -->
        <div class="cx-view" data-view="profiles">
            <div class="cx-profiles-header">
                <div class="cx-profiles-title">Profiles</div>
                <div class="cx-profiles-sub">Contact Intelligence</div>
                <div class="cx-profiles-actions">
                    <button class="cx-settings-btn" id="cx-scan-contacts" title="Ask the LLM to report all characters currently in the scene" ${scanContactsInFlight ? 'disabled' : ''}>${scanContactsInFlight ? 'Scanning…' : SCAN_CONTACTS_LABEL}</button>
                    <button class="cx-settings-btn" id="cx-add-contact">+ Add Contact</button>
                </div>
            </div>
            <div class="cx-profiles-list">
                ${hasContacts ? contacts.map(c => `
                <div class="cx-profile-card" role="region" aria-label="Profile: ${escAttr(c.name)}" data-pname="${escAttr(c.name)}">
                    <div class="cx-profile-top">
                        ${avatarHTML(c, 'cx-avatar-lg')}
                        <div class="cx-profile-name-col">
                            <div class="cx-profile-name">${escHtml(c.name)} ${c.isNpc ? '<span class="cx-npc-badge">NPC</span>' : ''}</div>
                            <div class="cx-profile-status">${escHtml(c.mood || (c.online ? '🟢 Online' : '⚫ Offline'))}</div>
                        </div>
                    </div>
                    <div class="cx-profile-actions">
                        <button class="cx-profile-action-btn" data-cx-edit="${escAttr(c.name)}">Edit</button>
                        <button class="cx-profile-action-btn" data-cx-avatar="${escAttr(c.name)}">Avatar</button>
                        ${c.isNpc ? `<button class="cx-profile-action-btn cx-profile-action-danger" data-cx-delete="${escAttr(c.name)}">Delete</button>` : ``}
                    </div>
                    <div class="cx-profile-fields">
                        ${c.location ? `<div class="cx-profile-field"><span class="cx-pf-label">📍 Location</span><span class="cx-pf-value">${escHtml(c.location)}</span></div>` : ''}
                        ${c.relationship ? `<div class="cx-profile-field"><span class="cx-pf-label">💬 Relationship</span><span class="cx-pf-value">${escHtml(c.relationship)}</span></div>` : ''}
                        ${c.thoughts ? `<div class="cx-profile-field"><span class="cx-pf-label">💭 Inner Monologue</span><span class="cx-pf-value cx-pf-italic">${escHtml(c.thoughts)}</span></div>` : ''}
                        ${!c.location && !c.relationship && !c.thoughts ? '<div class="cx-profile-field"><span class="cx-pf-value" style="color:#666">No intel yet</span></div>' : ''}
                    </div>
                </div>`).join('') : '<div style="padding:20px;color:#666;text-align:center">No contacts in current chat</div>'}
            </div>
            <div class="cx-navbar">
                <div class="cx-nav active"><div class="cx-nav-ico">🔍</div><div class="cx-nav-lbl">Profiles</div></div>
                <div class="cx-nav" data-goto="home" role="button" tabindex="0" aria-label="Go to home screen"><div class="cx-nav-ico">🏠</div><div class="cx-nav-lbl">Home</div></div>
            </div>
        </div>

        <!-- Quests View -->
        <div class="cx-view" data-view="quests">
            <div class="cx-profiles-header cx-quests-header">
                <div>
                    <div class="cx-profiles-title">Quests</div>
                    <div class="cx-profiles-sub">Persistent goals, obligations, and active leads</div>
                </div>
                <div class="cx-profiles-actions">
                    <button class="cx-settings-btn" id="cx-add-quest">+ Add Quest</button>
                </div>
            </div>
            <div class="cx-quests-list">
                ${renderQuestSection('active', 'Active')}
                ${renderQuestSection(['waiting', 'blocked'], 'Waiting / Blocked')}
                ${renderQuestSection('completed', 'Completed')}
                ${renderQuestSection('failed', 'Failed')}
            </div>
            <div class="cx-navbar">
                <div class="cx-nav active"><div class="cx-nav-ico">🗺️</div><div class="cx-nav-lbl">Quests</div></div>
                <div class="cx-nav" data-goto="home" role="button" tabindex="0" aria-label="Go to home screen"><div class="cx-nav-ico">🏠</div><div class="cx-nav-lbl">Home</div></div>
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
                <div class="cx-settings-row">
                    <span class="cx-settings-label">Manual Hybrid Private Texts</span>
                    <label class="cx-toggle"><input type="checkbox" id="cx-set-private-hybrid" ${settings.manualHybridPrivateTexts !== false ? 'checked' : ''}><span class="cx-toggle-slider"></span></label>
                </div>
                <div class="cx-settings-row">
                    <span class="cx-settings-label">Auto-poll private messages every N turns (0 = off)</span>
                    <input type="number" id="cx-set-auto-poll-n" class="cx-settings-number-input" min="0" max="20" step="1" value="${Math.max(0, Number(settings.autoPrivatePollEveryN) || 0)}" />
                </div>
                <div class="cx-settings-row cx-settings-btn-row">
                    <button class="cx-settings-btn" id="cx-set-add-contact">Add Contact</button>
                    <button class="cx-settings-btn cx-settings-btn-danger" id="cx-set-clear-npcs">Clear All NPC Data</button>
                </div>
                <div class="cx-settings-section">DISPLAY</div>
                <div class="cx-settings-row">
                    <span class="cx-settings-label">Lock Screen on Open</span>
                    <label class="cx-toggle"><input type="checkbox" id="cx-set-lock" ${settings.showLockscreen ? 'checked' : ''}><span class="cx-toggle-slider"></span></label>
                </div>
                <div class="cx-settings-section">ABOUT</div>
                <div class="cx-settings-row cx-settings-about">
                    <div>Command-X v${VERSION}</div>
                    <div style="color:#666;font-size:11px;margin-top:4px">By Kyle & Bucky 🦌</div>
                </div>
            </div>
            <div class="cx-navbar">
                <div class="cx-nav active"><div class="cx-nav-ico">⚙️</div><div class="cx-nav-lbl">Settings</div></div>
                <div class="cx-nav" data-goto="home" role="button" tabindex="0" aria-label="Go to home screen"><div class="cx-nav-ico">🏠</div><div class="cx-nav-lbl">Home</div></div>
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
                <div class="cx-nav" data-goto="home" role="button" tabindex="0" aria-label="Go to home screen"><div class="cx-nav-ico">🏠</div><div class="cx-nav-lbl">Home</div></div>
            </div>
        </div>


        <!-- Chat View -->
        <div class="cx-view" data-view="chat">
            <div class="cx-chat-header">
                <div class="cx-chat-back" id="cx-back" role="button" tabindex="0" aria-label="Back">‹</div>
                <div class="cx-chat-header-info">
                    <div class="cx-chat-header-name" id="cx-chat-name"></div>
                    <div class="cx-chat-header-status" id="cx-chat-status"></div>
                </div>
                <div class="cx-neural-toggle" id="cx-neural-toggle" role="button" tabindex="0" aria-pressed="false" aria-label="Toggle neural commands" title="Toggle neural commands">⚡</div>
                <div class="cx-batch-toggle ${settings.batchMode ? 'cx-batch-active' : ''}" id="cx-batch-toggle" role="button" tabindex="0" aria-pressed="${settings.batchMode}" aria-label="Toggle batch mode" title="Toggle batch mode (queue texts)">📋</div>
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
      ${profileEditorModalHTML()}
      ${questEditorModalHTML()}
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
    const contact = getKnownContactsForPrivateMessaging().find(c => c.name === contactName);
    if (nameEl) nameEl.textContent = contactName;
    if (statusEl) statusEl.textContent = contact?.mood || contact?.location || (contact?.online ? 'online' : 'offline');

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
    // Re-enable the send button once the LLM has replied (or timed out)
    const inPhoneSend = phoneContainer?.querySelector('#cx-send');
    if (inPhoneSend) {
        inPhoneSend.disabled = false;
        inPhoneSend.removeAttribute('aria-disabled');
    }
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

        pushPrivatePhoneEvent({
            type: 'outgoing_sms',
            from: 'user',
            to: currentContactName,
            text: displayText,
            visibility: 'private',
            source: 'inline',
            canonical: true,
            sceneAware: false,
            timestamp: Date.now(),
        });
        sendImmediate(currentContactName, chatText, isNeural, cmdType);

        // Typing indicator — only show when expecting an SMS reply.
        // Commands (neural or legacy {{COMMAND}}) don't produce an SMS reply.
        if (!isNeural && !cmdType) {
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
            }, AWAIT_TIMEOUT_MS);
        }
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
            if (app === 'cmdx' || app === 'profiles' || app === 'quests' || app === 'openclaw' || app === 'phone-settings') {
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
    phoneContainer.querySelector('#cx-set-private-hybrid')?.addEventListener('change', (e) => {
        settings.manualHybridPrivateTexts = e.target.checked;
        saveSettings();
        refreshPrivatePhonePrompt();
        rebuildPhone();
    });
    phoneContainer.querySelector('#cx-set-auto-poll-n')?.addEventListener('change', (e) => {
        const val = Math.max(0, Math.floor(Number(e.target.value) || 0));
        settings.autoPrivatePollEveryN = val;
        saveSettings();
    });
    phoneContainer.querySelector('#cx-set-lock')?.addEventListener('change', (e) => {
        settings.showLockscreen = e.target.checked;
        saveSettings();
    });
    phoneContainer.querySelector('#cx-add-contact')?.addEventListener('click', () => { openProfileEditor(); });
    phoneContainer.querySelector('#cx-scan-contacts')?.addEventListener('click', () => { scanContactsNow().catch(error => console.error(`[${EXT}] Manual contact scan click failed`, error)); });
    phoneContainer.querySelector('#cx-set-add-contact')?.addEventListener('click', () => { openProfileEditor(); });
    phoneContainer.querySelector('#cx-add-quest')?.addEventListener('click', () => { openQuestEditor(); });
    phoneContainer.querySelector('#cx-check-private')?.addEventListener('click', () => { pollPrivateMessages().catch(error => console.error(`[${EXT}] Private poll click failed`, error)); });
    phoneContainer.querySelector('#cx-set-clear-npcs')?.addEventListener('click', async () => {
        if (await cxConfirm('Clear all NPC contacts for this chat?', 'Clear Contacts', { confirmLabel: 'Clear All', danger: true })) {
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
    phoneContainer.querySelectorAll('[data-cx-edit]').forEach(btn =>
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            openProfileEditor(btn.dataset.cxEdit);
        })
    );
    phoneContainer.querySelectorAll('[data-cx-avatar]').forEach(btn =>
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            triggerAvatarPicker(btn.dataset.cxAvatar);
        })
    );
    phoneContainer.querySelectorAll('[data-cx-delete]').forEach(btn =>
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            promptDeleteContact(btn.dataset.cxDelete);
        })
    );
    phoneContainer.querySelector('#cx-profile-cancel')?.addEventListener('click', closeProfileEditor);
    phoneContainer.querySelector('#cx-profile-cancel-footer')?.addEventListener('click', closeProfileEditor);
    phoneContainer.querySelector('#cx-profile-upload')?.addEventListener('click', () => {
        syncProfileEditorDraftFromForm();
        triggerAvatarPicker(profileEditorState?.oldName || profileEditorState?.draft?.name || '__draft__');
    });
    phoneContainer.querySelector('#cx-profile-clear-avatar')?.addEventListener('click', () => {
        syncProfileEditorDraftFromForm();
        if (!profileEditorState) return;
        profileEditorState.draft.avatarUrl = '';
        rebuildPhone();
        switchView('profiles');
    });
    phoneContainer.querySelector('#cx-profile-form')?.addEventListener('submit', (event) => {
        event.preventDefault();
        saveProfileEditor();
    });
    phoneContainer.querySelector('#cx-profile-editor-backdrop')?.addEventListener('click', (event) => {
        if (event.target?.id === 'cx-profile-editor-backdrop') closeProfileEditor();
    });
    phoneContainer.querySelector('#cx-quest-cancel')?.addEventListener('click', closeQuestEditor);
    phoneContainer.querySelector('#cx-quest-cancel-footer')?.addEventListener('click', closeQuestEditor);
    phoneContainer.querySelector('#cx-quest-form')?.addEventListener('submit', (event) => {
        event.preventDefault();
saveQuestEditor().catch(error => cxAlert(String(error?.message || error), 'Quest Error'));
    });
    phoneContainer.querySelector('#cx-quest-editor-backdrop')?.addEventListener('click', (event) => {
        if (event.target?.id === 'cx-quest-editor-backdrop') closeQuestEditor();
    });
    phoneContainer.querySelectorAll('[data-cx-quest-edit]').forEach(btn =>
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            openQuestEditor(btn.dataset.cxQuestEdit);
        })
    );
    phoneContainer.querySelectorAll('[data-cx-quest-focus]').forEach(btn =>
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const quest = getEditableQuest(btn.dataset.cxQuestFocus);
            const updated = setQuestFocused(btn.dataset.cxQuestFocus, !quest?.focused);
            if (updated) {
                rebuildPhone();
                switchView('quests');
                showToast(updated.title, updated.focused ? 'Quest focused.' : 'Quest unfocused.');
            }
        })
    );
    phoneContainer.querySelectorAll('[data-cx-quest-status]').forEach(btn =>
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const updated = setQuestStatus(btn.dataset.cxQuestStatus, btn.dataset.cxStatusValue);
            if (updated) {
                rebuildPhone();
                switchView('quests');
                showToast(updated.title, `Quest marked ${updated.status}.`);
            }
        })
    );
    phoneContainer.querySelectorAll('[data-cx-quest-subtask]').forEach(btn =>
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const updated = toggleQuestSubtask(btn.dataset.cxQuestSubtask, btn.dataset.cxSubtaskId);
            if (updated) {
                rebuildPhone();
                switchView('quests');
            }
        })
    );
    phoneContainer.querySelectorAll('[data-cx-quest-open-thread]').forEach(btn =>
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            openChat(btn.dataset.cxQuestOpenThread, 'cmdx');
        })
    );
    phoneContainer.querySelectorAll('[data-cx-quest-enhance]').forEach(btn =>
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
                await enhanceQuestById(btn.dataset.cxQuestEnhance);
            } catch (error) {
                await cxAlert(String(error?.message || error), 'Enhancement Error');
            }
        })
    );
    phoneContainer.querySelectorAll('[data-cx-quest-complete]').forEach(btn =>
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const updated = setQuestStatus(btn.dataset.cxQuestComplete, 'completed');
            if (updated) {
                rebuildPhone();
                switchView('quests');
                showToast(updated.title, 'Quest completed.');
            }
        })
    );
    phoneContainer.querySelectorAll('[data-cx-quest-fail]').forEach(btn =>
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const updated = setQuestStatus(btn.dataset.cxQuestFail, 'failed');
            if (updated) {
                rebuildPhone();
                switchView('quests');
                showToast(updated.title, 'Quest failed.');
            }
        })
    );
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
        btn?.setAttribute('aria-pressed', String(settings.batchMode));
        saveSettings();
        updateQueueBar();
    });
    // Neural toggle button in chat header
    phoneContainer.querySelector('#cx-neural-toggle')?.addEventListener('click', () => {
        neuralMode = !neuralMode;
        const toggle = phoneContainer.querySelector('#cx-neural-toggle');
        const drawer = phoneContainer.querySelector('#cx-cmd-drawer');
        const input = phoneContainer.querySelector('#cx-msg-input');
        toggle?.setAttribute('aria-pressed', String(neuralMode));
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
    // Avatar <img> onerror — fall back to the emoji span (CSP-safe, replaces inline onerror).
    phoneContainer.addEventListener('error', (e) => {
        const img = e.target;
        if (!(img instanceof HTMLImageElement)) return;
        if (!img.hasAttribute('data-cx-avatar-fallback')) return;
        img.style.display = 'none';
        const fallback = img.parentElement?.querySelector('.cx-avatar-emoji-fallback');
        if (fallback) fallback.style.display = '';
    }, true);

    // Keyboard activation for role="button" elements — Enter / Space → click.
    // Space default (page scroll) is suppressed for role="button" elements.
    phoneContainer.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const el = e.target;
        if (el.getAttribute('role') !== 'button') return;
        e.preventDefault(); // always suppress Space-scroll / Enter-submit for role="button"
        if (!el.disabled) el.click();
    });

    if (clockIntervalId) { clearInterval(clockIntervalId); clockIntervalId = null; }
    clockIntervalId = setInterval(() => {
        const t = now();
        phoneContainer?.querySelectorAll('#cx-clock, .cx-lock-time, .cx-home-time').forEach(el => { el.textContent = t; });
    }, CLOCK_INTERVAL_MS);
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
    } else if (savedApp) {
        switchView(savedApp);
    }
    updateUnreadBadges();
}

function destroyPanel() {
    if (clockIntervalId) { clearInterval(clockIntervalId); clockIntervalId = null; }
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
    cb('cx_set_private_hybrid', 'manualHybridPrivateTexts', true);
    if (!["observe", "assist", "operate"].includes(settings.openclawMode)) settings.openclawMode = 'assist';
    const openclawMode = document.getElementById('cx_ext_openclaw_mode');
    if (openclawMode) openclawMode.value = settings.openclawMode || 'assist';
    const contactsN = document.getElementById('cx_ext_contacts_every_n');
    if (contactsN) contactsN.value = Math.max(1, Number(settings.contactsInjectEveryN) || 1);
    const questsN = document.getElementById('cx_ext_quests_every_n');
    if (questsN) questsN.value = Math.max(1, Number(settings.questsInjectEveryN) || 1);
    const autoPollN = document.getElementById('cx_ext_auto_private_poll_n');
    if (autoPollN) autoPollN.value = Math.max(0, Number(settings.autoPrivatePollEveryN) || 0);
}

function saveSettings() {
    settings.enabled = document.getElementById('cx_enabled')?.checked ?? true;
    settings.styleCommands = document.getElementById('cx_style_commands')?.checked ?? true;
    settings.showLockscreen = document.getElementById('cx_show_lockscreen')?.checked ?? false;
    settings.batchMode = document.getElementById('cx_ext_batch_mode')?.checked ?? settings.batchMode ?? false;
    settings.autoDetectNpcs = document.getElementById('cx_ext_auto_detect_npcs')?.checked ?? settings.autoDetectNpcs ?? true;
    settings.manualHybridPrivateTexts = document.getElementById('cx_set_private_hybrid')?.checked ?? document.getElementById('cx-set-private-hybrid')?.checked ?? settings.manualHybridPrivateTexts ?? true;
    settings.openclawMode = document.getElementById('cx_ext_openclaw_mode')?.value || settings.openclawMode || 'assist';
    const contactsNRaw = Number(document.getElementById('cx_ext_contacts_every_n')?.value);
    settings.contactsInjectEveryN = Number.isFinite(contactsNRaw) && contactsNRaw >= 1 ? Math.floor(contactsNRaw) : (settings.contactsInjectEveryN || 1);
    const questsNRaw = Number(document.getElementById('cx_ext_quests_every_n')?.value);
    settings.questsInjectEveryN = Number.isFinite(questsNRaw) && questsNRaw >= 1 ? Math.floor(questsNRaw) : (settings.questsInjectEveryN || 1);
    // cx_ext_auto_private_poll_n = ST settings panel; cx-set-auto-poll-n = in-phone settings view
    const autoPollNRaw = Number(document.getElementById('cx_ext_auto_private_poll_n')?.value ?? document.getElementById('cx-set-auto-poll-n')?.value);
    settings.autoPrivatePollEveryN = Number.isFinite(autoPollNRaw) && autoPollNRaw >= 0 ? Math.floor(autoPollNRaw) : (settings.autoPrivatePollEveryN || 0);
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
        refreshPrivatePhonePrompt();
        $('#cx_enabled, #cx_style_commands, #cx_show_lockscreen, #cx_ext_batch_mode, #cx_ext_auto_detect_npcs, #cx_set_private_hybrid, #cx_ext_openclaw_mode, #cx_ext_contacts_every_n, #cx_ext_quests_every_n, #cx_ext_auto_private_poll_n').on('change', () => {
            saveSettings();
            if (settings.enabled) {
                createPanel();
                if (settings.autoDetectNpcs !== false) injectContactsPrompt();
                else clearContactsPrompt();
                refreshPrivatePhonePrompt();
                injectQuestPrompt();
            } else {
                destroyPanel();
                clearContactsPrompt();
                clearSmsPrompt();
                clearQuestPrompt();
                refreshPrivatePhonePrompt();
            }
        });

        const { eventSource, event_types } = ctx;

        // Style {{COMMAND}} tags + hide [sms] and [contacts] tags in rendered messages
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (mesId) => {
            if (!settings.enabled) return;
            styleCommandsInMessage(mesId);
            hideSmsTagsInDom(mesId);
            hideContactsTagsInDom(mesId);
            hideQuestTagsInDom(mesId);
        });
        eventSource.on(event_types.USER_MESSAGE_RENDERED, (mesId) => {
            if (!settings.enabled) return;
            styleCommandsInMessage(mesId);
        });

        // ── Live reply capture: parse [sms] + [contacts] from character response ──
        eventSource.on(event_types.MESSAGE_RECEIVED, () => {
            if (!settings.enabled) return;
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
                            // No reliable target — drop rather than mis-route to the first contact.
                            console.log(`[${EXT}] Skipping [sms] with no from/to and no current chat`);
                            continue;
                        }
                    }

                    if (targetContact) {
                        pushMessage(targetContact, 'received', block.text, mesId);
                        pushPrivatePhoneEvent({
                            type: 'incoming_sms',
                            from: targetContact,
                            to: 'user',
                            text: block.text,
                            visibility: 'private',
                            source: 'inline',
                            canonical: true,
                            sceneAware: false,
                            timestamp: Date.now(),
                            mesId,
                        });

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

            let shouldRebuild = false;

            // ── [contacts] SECOND — may call rebuildPhone which resets state ──
            const parsedContacts = extractContacts(msg.mes);
            if (parsedContacts) {
                mergeNpcs(parsedContacts);
                shouldRebuild = true;
            }

            // ── [quests] THIRD — persistent quest tracker state ──
            const parsedQuests = extractQuests(msg.mes);
            if (parsedQuests?.length) {
                shouldRebuild = mergeQuests(parsedQuests, { source: 'auto' }) || shouldRebuild;
            }

            if (shouldRebuild && phoneContainer && !document.getElementById('cx-panel-wrapper')?.classList.contains('cx-hidden')) {
                rebuildPhone();
            }

            // Throttle [status] / [quests] re-injection to every N turns (Phase 2).
            applyInjectionThrottle();
        });

        // ── Swipe/regeneration handling: remove stale phone messages ──
        eventSource.on(event_types.MESSAGE_SWIPED, (mesId) => {
            if (!settings.enabled) return;
            removeMessagesForMesId(mesId);
            removePrivatePhoneEventsForMesId(mesId);
            // Re-render current chat if open
            const area = phoneContainer?.querySelector('#cx-msg-area');
            if (area && currentContactName) {
                renderAllBubbles(area, currentContactName, false);
            }
        });
        eventSource.on(event_types.MESSAGE_DELETED, (deletedMesId) => {
            if (!settings.enabled) return;
            // Prefer the event's mesId argument (ST emits the deleted index); fall back
            // to chat.length for older ST builds that don't pass it.
            const freshCtx = getContext();
            const deletedId = Number.isFinite(Number(deletedMesId))
                ? Number(deletedMesId)
                : (freshCtx.chat || []).length;
            removeMessagesForMesId(deletedId);
            removePrivatePhoneEventsForMesId(deletedId);
            const area = phoneContainer?.querySelector('#cx-msg-area');
            if (area && currentContactName) {
                renderAllBubbles(area, currentContactName, false);
            }
        });

        // Chat changed — reset state
        eventSource.on(event_types.CHAT_CHANGED, () => {
            if (!settings.enabled) return;
            currentContactName = null;
            currentApp = null;
            awaitingReply = false;
            commandMode = null;
            _turnCounter = 0;
            invalidateContactCaches();
            clearSmsPrompt();
            clearTypingIndicator();
            // Re-inject contacts prompt for new chat
            if (settings.enabled && settings.autoDetectNpcs !== false) injectContactsPrompt();
            else clearContactsPrompt();
            if (settings.enabled) injectQuestPrompt();
            else clearQuestPrompt();
            refreshPrivatePhonePrompt();
            if (phoneContainer) rebuildPhone();
        });

        if (settings.enabled) {
            createPanel();
            if (settings.autoDetectNpcs !== false) injectContactsPrompt();
            injectQuestPrompt();
        }
        console.log(`[${EXT}] v${VERSION} Loaded OK`);
    } catch (err) {
        console.error(`[${EXT}] INIT FAILED:`, err);
    }
});
