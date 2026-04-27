/**
 * Command-X Phone — SillyTavern Extension
 *
 * Approach: inject a system prompt that tells the LLM to wrap the
 * character's text/neural reply in [sms]…[/sms] tags. The extension
 * extracts that block for the phone UI and hides it from ST chat.
 * Message history is stored in localStorage (phone owns its own log).
 *
 * Version is single-sourced in `manifest.json` and mirrored in the
 * `VERSION` constant below — see `manifest.json` and `AGENT_MEMORY.md`
 * for release history. Per-feature changelogs are tracked in
 * `CLAUDE.md` § "Version History".
 */
import { getContext } from '../../../st-context.js';
import {
    setExtensionPrompt,
    extension_prompt_types,
    extension_prompt_roles,
    getRequestHeaders,
} from '../../../../script.js';

const VERSION = '0.13.0';
const EXT = 'command-x';
const INJECT_KEY = 'command-x-sms';
const INJECT_KEY_CONTACTS = 'command-x-contacts';
const INJECT_KEY_PRIVATE_PHONE = 'command-x-private-phone';
const INJECT_KEY_QUESTS = 'command-x-quests';
const INJECT_KEY_MAP = 'command-x-map';
// Nova agent defaults (plan §7c). Extracted as a named constant so the seven
// nested keys stay readable without reformatting the pre-existing DEFAULTS line.
const NOVA_DEFAULTS = {
    profileName: '',
    defaultTier: 'read',
    maxToolCalls: 24,
    turnTimeoutMs: 300000,
    pluginBaseUrl: '/api/plugins/nova-agent-bridge',
    rememberApprovalsSession: false,
    activeSkill: 'freeform',
};
const DEFAULTS = { enabled: true, styleCommands: true, showLockscreen: false, panelOpen: false, batchMode: false, autoDetectNpcs: true, manualHybridPrivateTexts: true, contactsInjectEveryN: 1, questsInjectEveryN: 1, autoPrivatePollEveryN: 0, trackLocations: true, autoRegisterPlaces: true, mapInjectEveryN: 3, showLocationTrails: true, nova: { ...NOVA_DEFAULTS } };
const MAX_AVATAR_FILE_BYTES = 8 * 1024 * 1024; // 8 MB hard cap on raw upload size
const MAX_MAP_IMAGE_WIDTH = 1024;           // max downscaled width for uploaded map image
const AWAIT_TIMEOUT_MS = 30_000;             // ms before awaitingReply auto-clears
const CLOCK_INTERVAL_MS = 30_000;            // clock display refresh interval
const MESSAGE_HISTORY_CAP = 200;             // max messages stored per contact
const QUEST_HISTORY_CAP = 150;              // max quests stored
const PLACES_CAP = 40;                      // max registered places per chat
const LOCATION_TRAIL_CAP = 50;              // max trail entries per contact
const TOAST_DURATION_MS = 4_000;            // toast auto-dismiss duration
const MAX_SUMMARISED_SKILL_TOOLS = 6;       // max tool names shown in skill picker
const MAX_SMS_IMAGE_WIDTH = 768;             // max downscaled width for SMS image attachments
const MAX_SMS_ATTACHMENT_DATA_URL_SIZE = 512 * 1024; // cap stored SMS image data URLs

/**
 * Depth values passed to `setExtensionPrompt` (`extension_prompt_types.IN_CHAT`).
 * Lower depth = closer to the most recent message. Centralised so the
 * relative ordering between [sms], [status], [map], [private], and
 * [quests] is explicit and searchable in one place.
 *
 * Ordering rationale:
 *   sms (1)        — request for THIS reply, must be closest to the end
 *   contacts (2)   — persistent NPC state; should be near recent context
 *   privatePhone (3) / map (3)
 *                  — auxiliary scene context; one step further back
 *   quests (4)     — narrative state; furthest back, larger payload
 */
const CX_PROMPT_DEPTHS = Object.freeze({
    sms: 1,
    contacts: 2,
    privatePhone: 3,
    map: 3,
    quests: 4,
});
// Avatar gradient palette. These strings are interpolated *raw* into a
// `style="background:${gradient}"` attribute (see `avatarHTML`) — `escAttr`
// safely encodes HTML special chars but does NOT sanitize CSS values
// (e.g. `url(javascript:…)` would survive). Therefore every entry here
// MUST remain a hard-coded, compile-time CSS value. If this ever needs
// to become user / storage controlled, switch `avatarHTML` to use
// per-gradient CSS classes (or a strict CSS-value validator) before
// loosening this constraint.
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
let pendingSmsAttachment = null; // { type:'image', dataUrl, name, alt } | null


/**
 * Resolve the canonical chat key used in every per-chat storage prefix
 * (`cx-msgs-*`, `cx-npcs-*`, `cx-quests-*`, `cx-unread-*`, `cx-places-*`,
 * `cx-map-*`, `cx-loctrail-*`). Single source of truth so the fallback
 * never diverges between writers and readers — historically the `cx-msgs`
 * family used `'default'` while the `cx-places`/`cx-map`/`cx-loctrail`
 * family used `'no-chat'`, which silently split data when both
 * `ctx.chatId` and `ctx.groupId` were falsy. We standardise on
 * `'default'` to match the higher-value (message/NPC/quest) data paths.
 */
function chatKey() {
    const ctx = getContext();
    return String(ctx.chatId || ctx.groupId || ctx.getCurrentChatId?.() || 'default');
}

// Back-compat alias retained because `currentChatId` is referenced
// throughout the file and reads more naturally at call-sites that talk
// about "the current chat" rather than "a key".
function currentChatId() {
    return chatKey();
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

/* ======================================================================
   COMPOSE QUEUE — batch multiple texts before sending to LLM
   ====================================================================== */

let composeQueue = []; // [{contactName, text, displayText, isNeural, cmdType, attachment}]

function addToQueue(contactName, text, displayText, isNeural, cmdType, attachment = null) {
    composeQueue.push({ contactName, text, displayText, isNeural, cmdType, attachment: normalizeSmsAttachment(attachment) });
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
    const photoCount = composeQueue.filter(q => q.attachment).length;
    const label = composeQueue.length === 1
        ? `1 text${photoCount ? ' + photo' : ''} to ${names[0]}`
        : `${composeQueue.length} texts${photoCount ? ` + ${photoCount} photo${photoCount === 1 ? '' : 's'}` : ''} to ${names.join(', ')}`;
    bar.querySelector('.cx-queue-label').textContent = label;
    bar.classList.remove('cx-hidden');
}

function flushQueue() {
    if (!composeQueue.length) return;

    // Build batched RP message
    const rpParts = composeQueue.map(q => {
        if (q.cmdType || q.isNeural) {
            return `*Command-X sends a neural command to ${q.contactName}:*\n${q.text}`;
        } else if (q.attachment) {
            const caption = q.text && q.text !== '[photo]' ? `\n"${q.text}"` : '';
            return `*texts ${q.contactName} on phone and sends a picture (${q.attachment.name || 'image'}):*${caption}`;
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
        attachmentName: q.attachment?.name || null,
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
            text: queued.attachment ? `${queued.displayText || 'Photo'} [photo]` : queued.displayText,
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
 *
 * Contract: only `name="value"` pairs with literal `"` delimiters and
 * no embedded escapes are recognised. The LLM is the sole producer of
 * these tags (driven by the prompt in `injectSmsPrompt`), and the
 * prompt tells it to emit plain double-quoted attributes. Single
 * quotes, escapes, curly quotes, and `value` chars containing `"` will
 * be silently truncated or skipped — that's the trade-off for a
 * dependency-free zero-edge-case parser. If we ever broaden the
 * grammar, both this function and `SMS_ATTR_RE` need to change in
 * lockstep.
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
 *
 * Note on escaping: SillyTavern's renderer has already converted the
 * raw LLM output into `el.innerHTML` (markdown → HTML), so the captured
 * `inner` may contain HTML markup. We escape it back to text via
 * `escAttr` before re-emitting it inside attribute / text contexts so
 * that a markdown-emphasised LLM reply (or anything else the renderer
 * produced) can't break out of the indicator's `title="…"` attribute
 * or insert markup inside the `<em>` element.
 */
function hideSmsTagsInDom(mesId) {
    const el = document.querySelector(`.mes[mesid="${mesId}"] .mes_text`);
    if (!el) return;
    SMS_TAG_RE.lastIndex = 0;
    if (SMS_TAG_RE.test(el.innerHTML)) {
        SMS_TAG_RE.lastIndex = 0;
        el.innerHTML = el.innerHTML.replace(SMS_TAG_RE, (_match, attrStr, inner) => {
            const attrs = parseSmsAttrs(attrStr);
            // `inner` is HTML-rendered text from `el.innerHTML`; treat it as
            // untrusted and re-escape for both the title attribute and the
            // `<em>` body. We use the browser's HTML parser via a detached
            // `<div>` to extract `textContent` rather than a regex strip:
            // a regex like `replace(/<[^>]*>/g, '')` is incomplete (CodeQL
            // js/incomplete-multi-character-sanitization) and could leave
            // `<scr<script>ipt>`-style nesting partially intact. The
            // downstream `escAttr` / `escHtml` calls would still neutralise
            // any leftover markup, but parser-based extraction is the
            // canonical fix that satisfies the lint rule.
            const _tmp = document.createElement('div');
            _tmp.innerHTML = String(inner);
            const previewText = (_tmp.textContent || '').trim();
            const fromLabel = attrs.from ? `📱 ${escHtml(attrs.from)}: ` : '📱 ';
            const truncated = previewText.length > 50
                ? previewText.slice(0, 50) + '…'
                : previewText;
            return `<span class="cx-sms-inline" title="${escAttr(previewText)}">${fromLabel}<em>${escHtml(truncated)}</em></span>`;
        });
    }
}

/* ======================================================================
   NPC CONTACT STORE — localStorage-backed, keyed per chat
   ====================================================================== */

const CONTACTS_TAG_RE = /\[(?:contacts|status)\]([\s\S]*?)\[\/(?:contacts|status)\]/gi;

function npcStoreKey() {
    return `cx-npcs-${chatKey()}`;
}

function loadNpcs() {
    try {
        const parsed = JSON.parse(localStorage.getItem(npcStoreKey()) || '[]');
        if (!Array.isArray(parsed)) return [];
        // Defensive: localStorage is shared by every extension on this
        // origin. Filter out anything that doesn't look like an NPC
        // record so a corrupt / foreign write can't crash the renderer.
        // Field-level escaping happens at render time via escHtml/escAttr.
        return parsed.filter(n =>
            n && typeof n === 'object' && !Array.isArray(n)
            && typeof n.name === 'string' && n.name.trim() !== ''
        );
    } catch { return []; }
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
            // Support both old flat {key: url} format and new {key: {url, lastUsed}} format.
            // Legacy entries get Date.now() so they aren't evicted before newly written ones.
            if (typeof value === 'string') {
                if (!_isAvatarUrlOversized(value)) entries[key] = { url: value, lastUsed: Date.now() };
            } else if (value && typeof value.url === 'string' && !_isAvatarUrlOversized(value.url)) {
                entries[key] = { url: value.url, lastUsed: Number.isFinite(value.lastUsed) ? value.lastUsed : Date.now() };
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
    let sorted = Object.entries(entries).sort((a, b) => (b[1].lastUsed || 0) - (a[1].lastUsed || 0));
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
            place: typeof c.place === 'string' ? c.place.trim() || null : null,
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
    const userLocationNote = settings.trackLocations
        ? ` Exception for map tracking: if the user's own current place is clear, you may include exactly one entry for ${userName ? `"${userName}"` : 'the user'} with a "place" field only so Command-X can move the "You" map pin.`
        : '';
    setExtensionPrompt(
        INJECT_KEY_CONTACTS,
        `[System: At the end of each response, include a [status] block with a JSON array of the present characters relevant to the scene, including the current main character and any side characters/NPCs. Format: [status][{"name":"Name","emoji":"👩","status":"online","mood":"😊 happy","location":"her apartment","relationship":"friendly","thoughts":"god he has no idea"}][/status] — "status" can be "online"/"offline"/"nearby". "mood" is an emoji + short descriptor. "location" is where they currently are. "relationship" is how they feel about the user (friendly/neutral/hostile/romantic/etc). "thoughts" is ONE short first-person sentence — a brief flash of inner monologue in the character's own private voice, as if we are overhearing a single thought they are silently having right now. Keep it short (roughly under 15 words). Do NOT summarize or recap what just happened in the scene. Do NOT describe their mood, state, or situation. Do NOT narrate. It should read like a genuine passing thought, not a status report. Include the active main character plus any relevant side characters/NPCs who exist in the scene. Do NOT include ${excludeNote || 'the user'} as a normal NPC/contact.${userLocationNote} If no other characters are relevant, you may still include the current main character alone.]`,
        extension_prompt_types.IN_CHAT,
        CX_PROMPT_DEPTHS.contacts,
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
    return `cx-quests-${chatKey()}`;
}

function loadQuests() {
    try {
        const parsed = JSON.parse(localStorage.getItem(questStoreKey()) || '[]');
        if (!Array.isArray(parsed)) return [];
        // Defensive: drop entries that aren't object records. Loaded
        // quests pass through `sanitizeQuestValue` on every merge, so
        // string coercion happens there; this guard just keeps loaders
        // from feeding non-objects into sort/render code.
        return parsed.filter(q => q && typeof q === 'object' && !Array.isArray(q));
    } catch { return []; }
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

function questSubtaskMatchKey(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function sanitizeQuestSubtasks(value, existing = []) {
    const list = Array.isArray(value)
        ? value
        : typeof value === 'string'
            ? value.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(text => ({ text }))
            : [];
    const existingById = new Map();
    const existingByText = new Map();
    for (const item of Array.isArray(existing) ? existing : []) {
        if (!item || typeof item !== 'object') continue;
        const id = String(item.id || '').trim();
        const textKey = questSubtaskMatchKey(item.text || item.title || item);
        if (id) existingById.set(id, item);
        if (textKey && !existingByText.has(textKey)) existingByText.set(textKey, item);
    }
    return list.map((item, index) => ({
        raw: item,
        text: String(item?.text || item?.title || item || '').trim(),
        index,
    })).filter(item => item.text).map(({ raw, text, index }) => {
        const incomingId = String(raw?.id || '').trim();
        const matched = (incomingId && existingById.get(incomingId))
            || existingByText.get(questSubtaskMatchKey(text))
            || existing?.[index]
            || null;
        const hasDone = raw && typeof raw === 'object' && Object.prototype.hasOwnProperty.call(raw, 'done');
        return {
            id: incomingId || String(matched?.id || `sub_${Math.random().toString(36).slice(2, 8)}`).trim(),
            text,
            done: hasDone ? !!raw.done : !!matched?.done,
        };
    });
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
        `[Command-X quest context. At the end of each response, include a [quests] JSON block ONLY when a meaningful quest should be created or updated. Format: [quests][{"id":"quest_optional_existing_id","title":"Quest title","summary":"short summary","objective":"current concrete objective","status":"active|waiting|blocked|completed|failed","priority":"low|normal|high|critical","urgency":"none|soon|urgent","source":"who/what created the quest","relatedContact":"matching contact name when relevant","focused":false,"nextAction":"optional immediate next step","subtasks":[{"id":"sub_optional","text":"goal text","done":false}],"notes":"optional note"}][/quests]. Quests represent meaningful goals, obligations, promises, leads, investigations, errands, blockers, or unresolved story pressures that may matter later. Subtasks are forward-looking goal checkboxes, not a history log; keep stable ids/text when updating and only mark a goal done when the story clearly achieved it. Reuse existing quest ids/titles when updating instead of duplicating. Check existing quests for progress, completion, blockage, waiting state, next-step changes, and subtask completion — but do NOT rewrite summaries/objectives/priority/urgency/notes just because wording could be improved. Only change stable quest fields when the story meaning actually changed. Avoid trivial one-off actions and excessive churn, especially on rerolls. Manual quest edits may be pinned field-by-field and should not be blindly overwritten later. Focused quests matter most. Urgent/high-priority active quests matter next. Waiting/blocked quests are still relevant but lower pressure. Completed/failed quests are historical only and should not be treated as current pressure. Not every quest must be mentioned every turn.\nCurrent quest state:\n${activeSummary}]`,
        extension_prompt_types.IN_CHAT,
        CX_PROMPT_DEPTHS.quests,
        false,
        extension_prompt_roles.SYSTEM,
    );
}

function clearQuestPrompt() {
    setExtensionPrompt(INJECT_KEY_QUESTS, '', extension_prompt_types.NONE, 0);
}

/* ======================================================================
   MAP STORE — places, map metadata, and per-contact location trails.
   Keyed per chat. Places are first-class entities with normalized (x,y)
   coordinates (0..1) over either a schematic canvas or uploaded image.
   ====================================================================== */

const PLACE_TAG_RE = /\[place\]([\s\S]*?)\[\/place\]/gi;

function placeStoreKey() {
    return `cx-places-${currentChatId()}`;
}

function mapMetaKey() {
    return `cx-map-${currentChatId()}`;
}

function locationTrailKey(contactName) {
    return `cx-loctrail-${currentChatId()}-${contactName}`;
}

/**
 * Normalize a stored place entry, tolerating legacy/corrupt shapes. Returns
 * null if the entry can't be salvaged (missing name). All callers rely on
 * `id` being a string and `x`/`y` being finite 0..1 numbers.
 */
function normalizeStoredPlace(raw, siblingList = []) {
    if (!raw || typeof raw !== 'object') return null;
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) return null;
    const xNum = Number(raw.x);
    const yNum = Number(raw.y);
    const hasCoords = Number.isFinite(xNum) && Number.isFinite(yNum);
    const coords = hasCoords
        ? { x: clampUnit(xNum), y: clampUnit(yNum) }
        : assignAutoPlaceCoords({ name }, siblingList);
    const aliasesIn = Array.isArray(raw.aliases) ? raw.aliases : [];
    const aliases = aliasesIn.map(a => String(a || '').trim()).filter(Boolean).slice(0, 8);
    const id = (typeof raw.id === 'string' && raw.id.trim())
        ? raw.id.trim()
        : ensurePlaceId({ name }, siblingList);
    return {
        id,
        name,
        emoji: (typeof raw.emoji === 'string' && raw.emoji.trim()) ? raw.emoji.trim() : '📍',
        x: coords.x,
        y: coords.y,
        aliases,
        userPinned: !!raw.userPinned,
    };
}

function loadPlaces() {
    try {
        const parsed = JSON.parse(localStorage.getItem(placeStoreKey()) || '[]');
        if (!Array.isArray(parsed)) return [];
        const result = [];
        for (const raw of parsed) {
            const clean = normalizeStoredPlace(raw, result);
            if (!clean) continue;
            // Guarantee unique id across the loaded set.
            if (result.some(p => p.id === clean.id)) {
                clean.id = ensurePlaceId({ name: clean.name }, result);
            }
            result.push(clean);
        }
        return result;
    } catch { return []; }
}

function savePlaces(places) {
    try {
        const list = Array.isArray(places) ? places : [];
        const clean = [];
        for (const raw of list) {
            const norm = normalizeStoredPlace(raw, clean);
            if (!norm) continue;
            if (clean.some(p => p.id === norm.id)) {
                norm.id = ensurePlaceId({ name: norm.name }, clean);
            }
            clean.push(norm);
        }
        localStorage.setItem(placeStoreKey(), JSON.stringify(clean.slice(-PLACES_CAP)));
    } catch (e) { console.warn('[command-x] place store save', e); }
}

function defaultMapMeta() {
    return { mode: 'schematic', imageDataUrl: null, width: 0, height: 0, userPin: null, userPlaceId: null };
}

function loadMapMeta() {
    try {
        const parsed = JSON.parse(localStorage.getItem(mapMetaKey()) || 'null');
        if (!parsed || typeof parsed !== 'object') return defaultMapMeta();
        return {
            mode: parsed.mode === 'image' ? 'image' : 'schematic',
            imageDataUrl: typeof parsed.imageDataUrl === 'string' ? parsed.imageDataUrl : null,
            width: Number(parsed.width) || 0,
            height: Number(parsed.height) || 0,
            userPin: parsed.userPin && Number.isFinite(Number(parsed.userPin.x)) && Number.isFinite(Number(parsed.userPin.y))
                ? { x: clampUnit(parsed.userPin.x), y: clampUnit(parsed.userPin.y) }
                : null,
            userPlaceId: typeof parsed.userPlaceId === 'string' && parsed.userPlaceId.trim() ? parsed.userPlaceId.trim() : null,
        };
    } catch { return defaultMapMeta(); }
}

function saveMapMeta(meta) {
    try { localStorage.setItem(mapMetaKey(), JSON.stringify(meta || defaultMapMeta())); }
    catch (e) { console.warn('[command-x] map meta save', e); }
}

function clampUnit(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return 0.5;
    return Math.max(0.02, Math.min(0.98, v));
}

function normalizePlaceName(name) {
    return String(name || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function placeMatchKeys(place) {
    const keys = new Set();
    const nm = normalizePlaceName(place?.name);
    if (nm) keys.add(nm);
    for (const alias of (Array.isArray(place?.aliases) ? place.aliases : [])) {
        const a = normalizePlaceName(alias);
        if (a) keys.add(a);
    }
    return keys;
}

function findPlaceByNameOrAlias(query, places = null) {
    const list = places || loadPlaces();
    const key = normalizePlaceName(query);
    if (!key) return null;
    for (const p of list) {
        if (placeMatchKeys(p).has(key)) return p;
    }
    return null;
}

function ensurePlaceId(place = {}, existingList = []) {
    const raw = String(place.id || '').trim();
    if (raw) return raw;
    const slug = normalizePlaceName(place.name).replace(/\s+/g, '-') || 'place';
    let candidate = `place_${slug}`;
    const taken = new Set(existingList.map(p => p.id));
    let i = 1;
    while (taken.has(candidate)) { candidate = `place_${slug}_${i++}`; }
    return candidate;
}

/**
 * Auto-assign normalized (x, y) coords for a new place in schematic mode.
 * If an anchor (`near` place name) is supplied and exists, we place the new
 * pin on a circular offset around the anchor; otherwise we spiral outward
 * from the center, avoiding existing pins where possible.
 */
function assignAutoPlaceCoords(place, existingPlaces) {
    if (Number.isFinite(Number(place.x)) && Number.isFinite(Number(place.y))) {
        return { x: clampUnit(place.x), y: clampUnit(place.y) };
    }
    const anchor = place.near ? findPlaceByNameOrAlias(place.near, existingPlaces) : null;
    if (anchor && Number.isFinite(Number(anchor.x)) && Number.isFinite(Number(anchor.y))) {
        const angle = (existingPlaces.length * 0.9 + Math.random() * 0.4) * Math.PI;
        const radius = 0.12 + Math.random() * 0.06;
        return {
            x: clampUnit(anchor.x + Math.cos(angle) * radius),
            y: clampUnit(anchor.y + Math.sin(angle) * radius),
        };
    }
    if (!existingPlaces.length) return { x: 0.5, y: 0.5 };
    // spiral outward
    const n = existingPlaces.length;
    const angle = n * 2.4;
    const radius = Math.min(0.42, 0.08 + n * 0.035);
    return {
        x: clampUnit(0.5 + Math.cos(angle) * radius),
        y: clampUnit(0.5 + Math.sin(angle) * radius),
    };
}

function sanitizePlace(place, existingPlaces = []) {
    if (!place || typeof place.name !== 'string') return null;
    const name = place.name.trim();
    if (!name) return null;
    const aliasesIn = Array.isArray(place.aliases) ? place.aliases : [];
    const aliases = aliasesIn.map(a => String(a || '').trim()).filter(Boolean).slice(0, 8);
    const coords = assignAutoPlaceCoords(place, existingPlaces);
    return {
        id: ensurePlaceId(place, existingPlaces),
        name,
        emoji: String(place.emoji || '📍').trim() || '📍',
        x: coords.x,
        y: coords.y,
        aliases,
        userPinned: !!place.userPinned,
    };
}

function upsertPlace(place, options = {}) {
    const stored = loadPlaces();
    const existing = findPlaceByNameOrAlias(place.name, stored);
    if (existing) {
        // Only update coords if user explicitly repositioned OR existing has no coords
        const merged = { ...existing, ...place, id: existing.id };
        if (!options.reposition) {
            merged.x = existing.x;
            merged.y = existing.y;
        } else {
            merged.x = clampUnit(place.x);
            merged.y = clampUnit(place.y);
        }
        merged.aliases = Array.isArray(place.aliases) && place.aliases.length
            ? Array.from(new Set([...(existing.aliases || []), ...place.aliases.map(a => String(a || '').trim()).filter(Boolean)]))
            : (existing.aliases || []);
        merged.userPinned = !!(options.reposition || existing.userPinned || place.userPinned);
        const idx = stored.findIndex(p => p.id === existing.id);
        if (idx >= 0) stored[idx] = merged;
        savePlaces(stored);
        return merged;
    }
    const clean = sanitizePlace(place, stored);
    if (!clean) return null;
    stored.push(clean);
    savePlaces(stored);
    return clean;
}

function deletePlace(placeId) {
    const stored = loadPlaces();
    const idx = stored.findIndex(p => p.id === placeId);
    if (idx < 0) return false;
    stored.splice(idx, 1);
    savePlaces(stored);
    // Scrub trail entries pointing to this place (cheap pass over current-chat keys)
    try {
        const chatId = currentChatId();
        const prefix = `cx-loctrail-${chatId}-`;
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key || !key.startsWith(prefix)) continue;
            try {
                const trail = JSON.parse(localStorage.getItem(key) || '[]');
                if (!Array.isArray(trail)) continue;
                const filtered = trail.filter(e => e && e.placeId !== placeId);
                if (filtered.length !== trail.length) {
                    localStorage.setItem(key, JSON.stringify(filtered));
                }
            } catch { /* ignore */ }
        }
    } catch { /* ignore */ }
    return true;
}

function loadLocationTrail(contactName) {
    try {
        const trail = JSON.parse(localStorage.getItem(locationTrailKey(contactName)) || '[]');
        return Array.isArray(trail) ? trail : [];
    } catch { return []; }
}

function saveLocationTrail(contactName, trail) {
    try {
        const clean = (Array.isArray(trail) ? trail : []).slice(-LOCATION_TRAIL_CAP);
        localStorage.setItem(locationTrailKey(contactName), JSON.stringify(clean));
    } catch (e) { console.warn('[command-x] trail save', e); }
}

function pushLocationTrail(contactName, placeId, mesId = null) {
    if (!contactName || !placeId) return false;
    const trail = loadLocationTrail(contactName);
    const last = trail[trail.length - 1];
    // Collapse consecutive identical entries
    if (last && last.placeId === placeId) return false;
    trail.push({ placeId, ts: Date.now(), mesId: mesId ?? null });
    saveLocationTrail(contactName, trail);
    return true;
}

function removeTrailForMesId(mesId) {
    if (mesId == null) return;
    try {
        const chatId = currentChatId();
        const prefix = `cx-loctrail-${chatId}-`;
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key || !key.startsWith(prefix)) continue;
            try {
                const trail = JSON.parse(localStorage.getItem(key) || '[]');
                if (!Array.isArray(trail)) continue;
                const filtered = trail.filter(e => e && e.mesId !== mesId);
                if (filtered.length !== trail.length) {
                    localStorage.setItem(key, JSON.stringify(filtered));
                }
            } catch { /* ignore */ }
        }
    } catch { /* ignore */ }
}

function getContactCurrentPlaceId(contactName) {
    const trail = loadLocationTrail(contactName);
    return trail.length ? trail[trail.length - 1].placeId : null;
}

function matchesUserPersona(name) {
    const key = normalizeContactName(name);
    if (!key) return false;
    const ctx = getContext();
    const userKey = normalizeContactName(ctx.name1 || '');
    return key === 'user' || key === 'me' || key === 'you' || (!!userKey && key === userKey);
}

function updateUserPersonaPlace(place) {
    if (!place?.id) return false;
    const meta = loadMapMeta();
    const nextPin = { x: clampUnit(place.x), y: clampUnit(place.y) };
    const changed = meta.userPlaceId !== place.id
        || !meta.userPin
        || Math.abs(Number(meta.userPin.x) - nextPin.x) > 0.001
        || Math.abs(Number(meta.userPin.y) - nextPin.y) > 0.001;
    if (!changed) return false;
    meta.userPlaceId = place.id;
    meta.userPin = nextPin;
    saveMapMeta(meta);
    return true;
}

/**
 * Parse [place] JSON for new place registrations.
 * Format: [place][{"name":"café","emoji":"☕","near":"apartment","aliases":["the cafe"]}][/place]
 */
function extractPlaces(raw) {
    if (!raw) return null;
    PLACE_TAG_RE.lastIndex = 0;
    const m = PLACE_TAG_RE.exec(raw);
    if (!m) return null;
    try {
        const parsed = JSON.parse(m[1].trim());
        const list = Array.isArray(parsed)
            ? parsed
            : Array.isArray(parsed?.places)
                ? parsed.places
                : (parsed && typeof parsed === 'object' && parsed.name ? [parsed] : []);
        return list.filter(p => p && typeof p.name === 'string');
    } catch (e) {
        console.warn('[command-x] failed to parse [place] JSON:', e);
        return null;
    }
}

function hidePlaceTagsInDom(mesId) {
    const el = document.querySelector(`.mes[mesid="${mesId}"] .mes_text`);
    if (!el) return;
    PLACE_TAG_RE.lastIndex = 0;
    if (PLACE_TAG_RE.test(el.innerHTML)) {
        PLACE_TAG_RE.lastIndex = 0;
        el.innerHTML = el.innerHTML.replace(PLACE_TAG_RE, '');
    }
}

/**
 * Register incoming LLM-registered places (via [place] tag).
 * Returns the number of new places actually registered.
 */
function registerIncomingPlaces(incoming) {
    if (!settings.autoRegisterPlaces) return 0;
    if (!incoming || !incoming.length) return 0;
    const stored = loadPlaces();
    let added = 0;
    for (const raw of incoming) {
        if (findPlaceByNameOrAlias(raw.name, stored)) continue; // already known
        const clean = sanitizePlace({ ...raw, userPinned: false }, stored);
        if (!clean) continue;
        stored.push(clean);
        added += 1;
    }
    if (added) savePlaces(stored);
    return added;
}

/**
 * Apply per-contact `place` fields from a parsed [status] block: register
 * the referenced place if new, push the contact onto the trail.
 */
function applyContactPlaces(contacts, mesId) {
    if (!settings.trackLocations) return false;
    if (!contacts || !contacts.length) return false;
    let placesChanged = false;
    let trailChanged = false;
    const stored = loadPlaces();
    for (const c of contacts) {
        if (!c.place) continue;
        let place = findPlaceByNameOrAlias(c.place, stored);
        if (!place) {
            if (!settings.autoRegisterPlaces) continue;
            const clean = sanitizePlace({ name: c.place, userPinned: false }, stored);
            if (!clean) continue;
            stored.push(clean);
            place = clean;
            placesChanged = true;
        }
        if (matchesUserPersona(c.name)) {
            if (updateUserPersonaPlace(place)) trailChanged = true;
            continue;
        }
        if (pushLocationTrail(c.name, place.id, mesId)) trailChanged = true;
    }
    if (placesChanged) savePlaces(stored);
    return placesChanged || trailChanged;
}

function describeKnownPlacesForPrompt() {
    const list = loadPlaces();
    if (!list.length) return 'No places have been registered yet.';
    return list.slice(0, 20).map(p => {
        const aliases = (p.aliases || []).filter(Boolean).slice(0, 3);
        return `- ${p.name}${aliases.length ? ` (aliases: ${aliases.join(', ')})` : ''}`;
    }).join('\n');
}

function injectMapPrompt() {
    if (!settings.enabled || !settings.trackLocations) {
        clearMapPrompt();
        return;
    }
    const knownPlaces = describeKnownPlacesForPrompt();
    const registrationLine = settings.autoRegisterPlaces
        ? 'If a character moves to a place not yet on the list, you may register it once by adding a separate [place][{"name":"Place Name","emoji":"📍","near":"nearest known place","aliases":["alt name"]}][/place] block. Keep place names short (1–3 words); reuse existing names whenever possible.'
        : 'Do NOT invent new places. Only reference places that already exist in the known list below; otherwise omit the "place" field.';
    setExtensionPrompt(
        INJECT_KEY_MAP,
        `[Command-X map context. For each character in the [status] block, add an optional "place" field whose value MUST match one of the known place names or aliases below (exact or close match). Also include the user's persona (${getContext().name1 || 'user'}) with a "place" field when their current place is clear, so Command-X can automatically move the "You" map pin. "place" is a short categorical label (e.g. "apartment", "café") used to pin characters on a map; it is separate from the free-text "location" field which remains narrative. ${registrationLine}\nKnown places:\n${knownPlaces}]`,
        extension_prompt_types.IN_CHAT,
        CX_PROMPT_DEPTHS.map,
        false,
        extension_prompt_roles.SYSTEM,
    );
}

function clearMapPrompt() {
    setExtensionPrompt(INJECT_KEY_MAP, '', extension_prompt_types.NONE, 0);
}

/* ------------------------------------------------------------------
   Prompt injection throttling (Phase 2). Counted per received message;
   when `contactsInjectEveryN` / `questsInjectEveryN` is > 1 we clear
   the relevant injection on off-turns and re-inject on the matching
   turn. A value of 1 (default) keeps the legacy every-turn behavior.
   ------------------------------------------------------------------ */
let _turnCounter = 0;
const _pendingSwipeRegenerations = new Set();

function normalizeSwipeMesId(mesId) {
    if (mesId == null || mesId === '') return null;
    const id = Number(mesId);
    return Number.isInteger(id) && id >= 0 ? id : null;
}

function markPendingSwipeRegeneration(mesId) {
    const id = normalizeSwipeMesId(mesId);
    if (id != null) _pendingSwipeRegenerations.add(id);
}

function consumePendingSwipeRegeneration(mesId) {
    const id = normalizeSwipeMesId(mesId);
    if (id == null || !_pendingSwipeRegenerations.has(id)) return false;
    _pendingSwipeRegenerations.delete(id);
    return true;
}

function clearPendingSwipeRegeneration(mesId) {
    const id = normalizeSwipeMesId(mesId);
    if (id != null) _pendingSwipeRegenerations.delete(id);
}

function applyInjectionThrottle() {
    _turnCounter += 1;
    const contactsN = Math.max(1, Number(settings.contactsInjectEveryN) || 1);
    const questsN = Math.max(1, Number(settings.questsInjectEveryN) || 1);
    const mapN = Math.max(1, Number(settings.mapInjectEveryN) || 1);

    if (!settings.enabled) return;

    if (settings.autoDetectNpcs !== false) {
        if (_turnCounter % contactsN === 0) injectContactsPrompt();
        else if (contactsN > 1) clearContactsPrompt();
    }
    if (_turnCounter % questsN === 0) injectQuestPrompt();
    else if (questsN > 1) clearQuestPrompt();

    if (settings.trackLocations) {
        if (_turnCounter % mapN === 0) injectMapPrompt();
        else if (mapN > 1) clearMapPrompt();
    } else {
        clearMapPrompt();
    }

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
            <span>Goals · ${doneCount}/${subtasks.length}</span>
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
        'Subtasks should be short forward-looking goal checkboxes when appropriate, not a log of completed history.',
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
function buildSmsInstruction(contactName, isNeural, cmdType, attachmentName = null) {
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
        const photoNote = attachmentName
            ? ` The user's text included an attached picture (${attachmentName}); ${contactName} can react to the photo naturally if it matters.`
            : '';
        return `The user texted ${contactName}.${photoNote} ${contactName} texts back naturally and in-character. Keep the reply short and casual — written like a real text message, not prose. Think brief, conversational, often lowercase, maybe a sentence or two at most. No long verbose messages, no narration, no action description inside the text. Wrap their reply to the user in [sms from="${contactName}" to="user"]...[/sms].`;
    }
}

/**
 * Inject SMS prompt for one or more targets.
 * @param {Array<{name:string, isNeural:boolean, cmdType:string|null}>} targets
 */
function injectSmsPrompt(targets) {
    const parts = targets.map(t => buildSmsInstruction(t.name, t.isNeural, t.cmdType, t.attachmentName));
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
        CX_PROMPT_DEPTHS.sms,
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
    return `cx-msgs-${chatKey()}-${contactName}`;
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

function normalizeSmsAttachment(attachment) {
    if (!attachment || typeof attachment !== 'object') return null;
    const dataUrl = typeof attachment.dataUrl === 'string' ? attachment.dataUrl : '';
    if (!dataUrl.startsWith('data:image/')) return null;
    if (dataUrl.length > MAX_SMS_ATTACHMENT_DATA_URL_SIZE) return null;
    return {
        type: 'image',
        dataUrl,
        name: String(attachment.name || 'photo').trim().slice(0, 120) || 'photo',
        alt: String(attachment.alt || attachment.name || 'Attached photo').trim().slice(0, 160) || 'Attached photo',
    };
}

function smsAttachmentLabel(attachment) {
    const clean = normalizeSmsAttachment(attachment);
    return clean ? `📷 ${clean.name || 'Photo'}` : '';
}

function pushMessage(contactName, type, text, mesId, options = {}) {
    const msgs = loadMessages(contactName);
    const attachment = normalizeSmsAttachment(options.attachment);
    msgs.push({ type, text, time: now(), ts: Date.now(), mesId: mesId ?? null, ...(attachment ? { attachment } : {}) });
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
        CX_PROMPT_DEPTHS.privatePhone,
        false,
        extension_prompt_roles.SYSTEM,
    );
}

/* ======================================================================
   UNREAD COUNTS — localStorage-backed
   ====================================================================== */

function unreadKey(contactName) {
    return `cx-unread-${chatKey()}-${contactName}`;
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

/**
 * Styled in-phone prompt dialog (replaces native prompt()).
 * Returns a Promise<string|null> — the submitted value, or null if cancelled.
 * Esc cancels. Enter submits.
 */
function cxPrompt(message, { title = 'Command-X', defaultValue = '', placeholder = '', confirmLabel = 'OK', cancelLabel = 'Cancel', maxLength = 120 } = {}) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'cx-modal-overlay';
        overlay.innerHTML = `
        <div class="cx-modal-box" role="dialog" aria-modal="true" aria-labelledby="cx-modal-title" aria-describedby="cx-modal-body">
            <div class="cx-modal-title" id="cx-modal-title">${escHtml(title)}</div>
            <div class="cx-modal-body" id="cx-modal-body">${escHtml(message)}</div>
            <input type="text" class="cx-modal-input" id="cx-modal-input" maxlength="${Number(maxLength) || 120}" value="${escAttr(defaultValue)}" placeholder="${escAttr(placeholder)}" />
            <div class="cx-modal-actions">
                <button class="cx-modal-btn cx-modal-btn-secondary" id="cx-modal-cancel">${escHtml(cancelLabel)}</button>
                <button class="cx-modal-btn cx-modal-btn-primary" id="cx-modal-confirm">${escHtml(confirmLabel)}</button>
            </div>
        </div>`;
        const input = overlay.querySelector('#cx-modal-input');
        const close = (result) => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(result); };
        const onKey = (e) => {
            if (e.key === 'Escape') close(null);
            else if (e.key === 'Enter' && document.activeElement === input) close(input.value);
        };
        overlay.querySelector('#cx-modal-cancel').addEventListener('click', () => close(null));
        overlay.querySelector('#cx-modal-confirm').addEventListener('click', () => close(input.value));
        document.addEventListener('keydown', onKey);
        document.body.appendChild(overlay);
        input.focus();
        input.select();
    });
}

function markRead(contactName) {
    localStorage.removeItem(unreadKey(contactName));
    updateUnreadBadges();
}

function getTotalUnread() {
    // Scan localStorage directly for `cx-unread-<chatKey>-<contact>` keys
    // instead of building the full contact list. The contact builder calls
    // `loadNpcs()` + `historyContactNames()` + a Map sort and is invoked
    // from every rebuildPhone / incrementUnread / markRead / poll path —
    // an O(unread-keys) scan is dramatically cheaper at idle.
    let total = 0;
    const prefix = `cx-unread-${chatKey()}-`;
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key || !key.startsWith(prefix)) continue;
            const n = parseInt(localStorage.getItem(key) || '0', 10);
            if (Number.isFinite(n) && n > 0) total += n;
        }
    } catch (_) { /* localStorage access can throw in strict-storage browsers */ }
    return total;
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
/**
 * Escape for HTML *body* contexts (text nodes, element children).
 * Converts `\n` to `<br>` so message text retains line breaks when
 * rendered into a div/span/em. NOT safe for attribute values — use
 * `escAttr` there instead. Quotes are intentionally not escaped
 * because we never use this in attribute position.
 */
function escHtml(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>'); }
/**
 * Escape for HTML *attribute* contexts. Escapes `&`, `<`, `>`, `"`, and
 * `'` so untrusted values can't break out of the surrounding `"..."`
 * attribute delimiter. Use this any time you interpolate a dynamic
 * value inside `attr="..."` — `escHtml` leaves quotes intact and
 * CodeQL (correctly) flags its use in attribute position.
 */
function escAttr(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
/**
 * Escape for `<textarea>` PCDATA contexts. Like `escAttr` (escapes
 * quotes too) but critically does NOT convert `\n` to `<br>` — newlines
 * inside a textarea body are literal text the browser must preserve as
 * line breaks in the editor. Use this when interpolating a draft value
 * into `<textarea>${...}</textarea>`.
 */
function escapeHtml(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }


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
            `"status" is "online"/"offline"/"nearby", "mood" is an emoji + short descriptor, "location" is where they currently are, "relationship" is how they feel about the user, and "thoughts" is ONE short first-person sentence in the character's own voice — a brief passing thought (roughly under 15 words), NOT a recap or summary of the scene. ` +
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

async function sendToChat(text, contactName, isCommand, attachment = null) {
    let formatted;
    if (isCommand) {
        formatted = `*opens Command-X on phone and sends a neural command to ${contactName}:*\n${text}`;
    } else if (attachment) {
        const caption = text && text !== '[photo]' ? `\n"${text}"` : '';
        formatted = `*texts ${contactName} on phone and sends a picture (${attachment.name || 'image'}):*${caption}`;
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
function sendImmediate(contactName, chatText, isNeural, cmdType, attachment = null) {
    injectSmsPrompt([{ name: contactName, isNeural, cmdType, attachmentName: attachment?.name || null }]);
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
    sendToChat(chatText, contactName, !!cmdType || isNeural, attachment);
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
    const attachmentLabel = last?.attachment ? smsAttachmentLabel(last.attachment) : '';
    const lastText = attachmentLabel
        ? [attachmentLabel, last?.text].filter(Boolean).join(' · ')
        : last?.text;
    const preview = last ? (last.type.startsWith('sent') ? `You: ${lastText}` : lastText) : 'Tap to chat';
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
            ${last ? `<div class="cx-status-time">${escHtml(last.time || '')}</div>` : ''}
        </div>
    </div>`;
}

function buildMapView(contacts) {
    const meta = loadMapMeta();
    const places = loadPlaces();
    const isImage = meta.mode === 'image' && meta.imageDataUrl;
    // The uploaded map image lives on the inner viewport so it scales/pans
    // with the pins when the user zooms.
    const viewportStyle = isImage
        ? `background-image:url("${escAttr(meta.imageDataUrl)}");background-size:cover;background-position:center;`
        : '';
    const surfaceClass = isImage ? 'cx-map-surface cx-map-surface-image' : 'cx-map-surface cx-map-surface-schematic';
    const viewportClass = isImage ? 'cx-map-viewport cx-map-viewport-image' : 'cx-map-viewport cx-map-viewport-schematic';

    // Cache all contact trails in a single pass rather than re-reading localStorage
    // several times per contact during rendering.
    const trailsByContact = new Map();
    for (const c of contacts) trailsByContact.set(c.name, loadLocationTrail(c.name));
    const currentPlaceIdFor = (name) => {
        const t = trailsByContact.get(name);
        return t && t.length ? t[t.length - 1].placeId : null;
    };

    // Build trail SVG paths when enabled
    const placeById = new Map(places.map(p => [p.id, p]));
    const trailsSvg = settings.showLocationTrails ? (() => {
        const paths = [];
        for (const c of contacts) {
            const trail = (trailsByContact.get(c.name) || []).slice(-6);
            if (trail.length < 2) continue;
            const pts = trail
                .map(e => placeById.get(e.placeId))
                .filter(Boolean)
                .map(p => `${(p.x * 100).toFixed(2)},${(p.y * 100).toFixed(2)}`);
            if (pts.length < 2) continue;
            paths.push(`<polyline class="cx-map-trail" points="${pts.join(' ')}" />`);
        }
        return paths.length
            ? `<svg class="cx-map-trails" data-cx-map-decoration="1" viewBox="0 0 100 100" preserveAspectRatio="none">${paths.join('')}</svg>`
            : '';
    })() : '';

    // Render contact pins at their current place
    const contactPins = contacts.map(c => {
        const placeId = currentPlaceIdFor(c.name);
        if (!placeId) return '';
        const place = placeById.get(placeId);
        if (!place) return '';
        const x = (place.x * 100).toFixed(2);
        const y = (place.y * 100).toFixed(2);
        const avatarInner = c.avatarUrl
            ? `<img class="cx-avatar-img" data-cx-avatar-fallback="1" src="${escAttr(c.avatarUrl)}" alt="${escAttr(c.name)}"><span class="cx-avatar-emoji-fallback" style="display:none">${escHtml(c.emoji || '🧑')}</span>`
            : escHtml(c.emoji || '🧑');
        return `<div class="cx-map-pin cx-map-pin-contact" data-cx-map-contact="${escAttr(c.name)}" role="button" tabindex="0" aria-label="Open chat with ${escAttr(c.name)} at ${escAttr(place.name)}" title="${escAttr(c.name)} — ${escAttr(place.name)}" style="left:${x}%;top:${y}%;background:${escAttr(c.gradient || 'linear-gradient(135deg,#553355,#442244)')}">${avatarInner}</div>`;
    }).join('');

    // Place pins
    const placePins = places.map(p => {
        const x = (p.x * 100).toFixed(2);
        const y = (p.y * 100).toFixed(2);
        return `<div class="cx-map-pin cx-map-pin-place${p.userPinned ? ' cx-map-pin-user' : ''}" data-cx-map-place="${escAttr(p.id)}" role="button" tabindex="0" aria-label="Place: ${escAttr(p.name)}" title="${escAttr(p.name)}" style="left:${x}%;top:${y}%">
            <span class="cx-map-pin-emoji">${escHtml(p.emoji || '📍')}</span>
            <span class="cx-map-pin-label">${escHtml(p.name)}</span>
        </div>`;
    }).join('');

    // User "You" pin
    const userPlace = meta.userPlaceId ? placeById.get(meta.userPlaceId) : null;
    const userPin = userPlace ? { x: userPlace.x, y: userPlace.y, label: `You — ${userPlace.name}`, auto: true } : (meta.userPin ? { ...meta.userPin, label: 'You', auto: false } : null);
    const youPinHtml = userPin
        ? `<div class="cx-map-pin cx-map-pin-you${userPin.auto ? ' cx-map-pin-you-auto' : ''}" data-cx-map-you="1" role="button" tabindex="0" aria-label="${escAttr(userPin.label)}" title="${escAttr(userPin.label)}" style="left:${(userPin.x * 100).toFixed(2)}%;top:${(userPin.y * 100).toFixed(2)}%">📍</div>`
        : '';

    const placeList = places.length
        ? places.map(p => {
            const assigned = contacts.filter(c => currentPlaceIdFor(c.name) === p.id).map(c => c.name);
            if (meta.userPlaceId === p.id) assigned.unshift('You');
            return `
            <div class="cx-map-place-row" data-cx-map-place-row="${escAttr(p.id)}">
                <div class="cx-map-place-main">
                    <span class="cx-map-place-emoji">${escHtml(p.emoji || '📍')}</span>
                    <div class="cx-map-place-info">
                        <div class="cx-map-place-name">${escHtml(p.name)}</div>
                        <div class="cx-map-place-sub">${assigned.length ? escHtml(assigned.join(', ')) : '<span style="color:#666">empty</span>'}</div>
                    </div>
                </div>
                <button class="cx-profile-action-btn cx-map-place-del" data-cx-map-delete="${escAttr(p.id)}" aria-label="Delete ${escAttr(p.name)}">✕</button>
            </div>`;
        }).join('')
        : '<div class="cx-map-empty">No places registered yet. Tap the map surface to add one, or let the LLM register places automatically.</div>';

    const trackingHint = settings.trackLocations
        ? `Tracking ${settings.autoRegisterPlaces ? 'on (auto-register)' : 'on (manual-only)'}${meta.userPlaceId ? ' · You auto-tracked' : ''}`
        : 'Tracking off';

    return `
        <div class="cx-view" data-view="map">
            <div class="cx-profiles-header cx-map-header">
                <div>
                    <div class="cx-profiles-title">Map</div>
                    <div class="cx-profiles-sub">${escHtml(trackingHint)} · ${places.length} place${places.length === 1 ? '' : 's'}</div>
                </div>
                <div class="cx-profiles-actions">
                    <button class="cx-settings-btn" id="cx-map-upload">${isImage ? 'Replace Image' : 'Upload Image'}</button>
                    <button class="cx-settings-btn" id="cx-map-help" title="How to upload a map background" aria-label="Map upload help">ℹ️</button>
                    ${isImage ? '<button class="cx-settings-btn" id="cx-map-clear-image">Use Schematic</button>' : ''}
                    <button class="cx-settings-btn" id="cx-map-set-you" title="Manually override your position on the map">📍 You</button>
                </div>
            </div>
            <div class="cx-map-body">
                <div class="${surfaceClass}" id="cx-map-surface">
                    <div class="${viewportClass}" id="cx-map-viewport" style="${viewportStyle}">
                        ${isImage ? '' : '<div class="cx-map-schematic-grid" data-cx-map-decoration="1" aria-hidden="true"></div>'}
                        ${trailsSvg}
                        ${placePins}
                        ${contactPins}
                        ${youPinHtml}
                    </div>
                    <div class="cx-map-controls" aria-hidden="false">
                        <button type="button" class="cx-map-ctrl-btn" id="cx-map-zoom-in" aria-label="Zoom in" title="Zoom in">＋</button>
                        <button type="button" class="cx-map-ctrl-btn" id="cx-map-zoom-out" aria-label="Zoom out" title="Zoom out">−</button>
                        <button type="button" class="cx-map-ctrl-btn" id="cx-map-zoom-reset" aria-label="Reset view" title="Reset view">⟲</button>
                    </div>
                    <div class="cx-map-zoom-indicator" id="cx-map-zoom-indicator" aria-hidden="true">100%</div>
                </div>
                <div class="cx-map-legend">
                    <div class="cx-map-legend-title">Places</div>
                    <div class="cx-map-place-list">${placeList}</div>
                </div>
            </div>
            <div class="cx-navbar">
                <div class="cx-nav active"><div class="cx-nav-ico">🧭</div><div class="cx-nav-lbl">Map</div></div>
                <div class="cx-nav" data-goto="home" role="button" tabindex="0" aria-label="Go to home screen"><div class="cx-nav-ico">🏠</div><div class="cx-nav-lbl">Home</div></div>
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
                <div class="cx-app-icon" data-app="map" role="button" tabindex="0" aria-label="Open Map app">
                    <div class="cx-icon-img cx-icon-map">🧭</div>
                    <div class="cx-icon-label">Map</div>
                </div>
                <div class="cx-app-icon" data-app="nova" role="button" tabindex="0" aria-label="Open Nova agent">
                    <div class="cx-icon-img cx-icon-nova">✴︎</div>
                    <div class="cx-icon-label">Nova</div>
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

        ${buildMapView(contacts)}

        <!-- Nova Agent View -->
        <div class="cx-view" data-view="nova">
            <div class="cx-nova-header">
                <div class="cx-nova-title-col">
                    <div class="cx-nova-title">Nova</div>
                    <div class="cx-nova-sub">Agentic Assistant</div>
                </div>
                <div class="cx-nova-pills">
                    <button type="button" class="cx-nova-pill" id="cx-nova-pill-profile" aria-label="Choose connection profile">Profile: —</button>
                    <button type="button" class="cx-nova-pill" id="cx-nova-pill-skill" aria-label="Choose skill">Skill: Free-form</button>
                    <button type="button" class="cx-nova-pill" id="cx-nova-pill-tier" aria-label="Choose permission tier">Tier: Read</button>
                </div>
            </div>
            <div class="cx-nova-transcript" id="cx-nova-transcript" role="log" aria-live="polite" aria-label="Nova conversation transcript">
                <div class="cx-nova-empty" id="cx-nova-empty">
                    <div class="cx-nova-empty-glyph">✴︎</div>
                    <div class="cx-nova-empty-title">Nova is ready</div>
                    <div class="cx-nova-empty-body">Pick a connection profile from the <strong>Profile</strong> pill, then ask Nova anything. Reads are instant; writes and shell commands ask for approval first.</div>
                </div>
            </div>
            <div class="cx-nova-composer">
                <textarea class="cx-nova-input" id="cx-nova-input" rows="2" placeholder="Ask Nova…" aria-label="Message Nova"></textarea>
                <div class="cx-nova-composer-actions">
                    <button type="button" class="cx-settings-btn cx-nova-send" id="cx-nova-send" aria-label="Send to Nova">Send</button>
                    <button type="button" class="cx-settings-btn cx-nova-cancel cx-hidden" id="cx-nova-cancel" aria-label="Cancel Nova turn">Cancel</button>
                    <button type="button" class="cx-settings-btn cx-nova-clear" id="cx-nova-clear" aria-label="Clear Nova context history">Clear</button>
                </div>
            </div>
            <div class="cx-navbar">
                <div class="cx-nav active"><div class="cx-nav-ico">✴︎</div><div class="cx-nav-lbl">Nova</div></div>
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
                <div class="cx-settings-section">MAP</div>
                <div class="cx-settings-row">
                    <span class="cx-settings-label">Track Contact Locations</span>
                    <label class="cx-toggle"><input type="checkbox" id="cx-set-track-locations" ${settings.trackLocations !== false ? 'checked' : ''}><span class="cx-toggle-slider"></span></label>
                </div>
                <div class="cx-settings-row">
                    <span class="cx-settings-label">Let LLM Auto-Register Places</span>
                    <label class="cx-toggle"><input type="checkbox" id="cx-set-auto-places" ${settings.autoRegisterPlaces !== false ? 'checked' : ''}><span class="cx-toggle-slider"></span></label>
                </div>
                <div class="cx-settings-row">
                    <span class="cx-settings-label">Show Movement Trails</span>
                    <label class="cx-toggle"><input type="checkbox" id="cx-set-trails" ${settings.showLocationTrails !== false ? 'checked' : ''}><span class="cx-toggle-slider"></span></label>
                </div>
                <div class="cx-settings-row">
                    <span class="cx-settings-label">Inject map context every N turns</span>
                    <input type="number" id="cx-set-map-every-n" class="cx-settings-number-input" min="1" max="20" step="1" value="${Math.max(1, Number(settings.mapInjectEveryN) || 3)}" />
                </div>
                <div class="cx-settings-row cx-settings-btn-row">
                    <button class="cx-settings-btn cx-settings-btn-danger" id="cx-set-clear-places">Clear All Places</button>
                </div>
                <div class="cx-settings-section">DISPLAY</div>
                <div class="cx-settings-row">
                    <span class="cx-settings-label">Lock Screen on Open</span>
                    <label class="cx-toggle"><input type="checkbox" id="cx-set-lock" ${settings.showLockscreen ? 'checked' : ''}><span class="cx-toggle-slider"></span></label>
                </div>
                <div class="cx-settings-section">NOVA</div>
                <div class="cx-settings-row">
                    <span class="cx-settings-label">Connection profile</span>
                    <input type="text" id="cx-set-nova-profile" class="cx-settings-text-input" value="${escAttr(settings.nova?.profileName || '')}" placeholder="e.g. GPT-4o Mini" />
                </div>
                <div class="cx-settings-row">
                    <span class="cx-settings-label">Default permission tier</span>
                    <select id="cx-set-nova-tier" class="cx-settings-text-input">
                        <option value="read" ${(settings.nova?.defaultTier || 'read') === 'read' ? 'selected' : ''}>Read</option>
                        <option value="write" ${settings.nova?.defaultTier === 'write' ? 'selected' : ''}>Write</option>
                        <option value="full" ${settings.nova?.defaultTier === 'full' ? 'selected' : ''}>Full</option>
                    </select>
                </div>
                <div class="cx-settings-row">
                    <span class="cx-settings-label">Max tool calls / turn</span>
                    <input type="number" id="cx-set-nova-max-tools" class="cx-settings-number-input" min="1" max="100" step="1" value="${Math.max(1, Number(settings.nova?.maxToolCalls) || NOVA_DEFAULTS.maxToolCalls)}" />
                </div>
                <div class="cx-settings-row">
                    <span class="cx-settings-label">Turn timeout (ms)</span>
                    <input type="number" id="cx-set-nova-timeout" class="cx-settings-number-input" min="10000" max="3600000" step="1000" value="${Math.max(10000, Number(settings.nova?.turnTimeoutMs) || NOVA_DEFAULTS.turnTimeoutMs)}" />
                </div>
                <div class="cx-settings-row">
                    <span class="cx-settings-label">Bridge plugin URL</span>
                    <input type="text" id="cx-set-nova-plugin-url" class="cx-settings-text-input" value="${escAttr(settings.nova?.pluginBaseUrl || NOVA_DEFAULTS.pluginBaseUrl)}" />
                </div>
                <div class="cx-settings-row">
                    <span class="cx-settings-label">Remember approvals (this session)</span>
                    <label class="cx-toggle"><input type="checkbox" id="cx-set-nova-remember-approvals" ${settings.nova?.rememberApprovalsSession ? 'checked' : ''}><span class="cx-toggle-slider"></span></label>
                </div>
                <div class="cx-settings-row cx-settings-btn-row">
                    <button class="cx-settings-btn" id="cx-set-nova-edit-sm">📝 Edit Soul &amp; Memory</button>
                </div>
                <div class="cx-settings-row cx-settings-btn-row">
                    <button class="cx-settings-btn" id="cx-set-nova-audit">📜 View audit log</button>
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

        <!-- Chat View -->
        <div class="cx-view" data-view="chat">
            <div class="cx-chat-header">
                <div class="cx-chat-back" id="cx-back" role="button" tabindex="0" aria-label="Back">‹</div>
                <div class="cx-chat-header-info">
                    <div class="cx-chat-header-name" id="cx-chat-name"></div>
                    <div class="cx-chat-header-status" id="cx-chat-status"></div>
                </div>
                <div class="cx-neural-toggle" id="cx-neural-toggle" role="button" tabindex="0" aria-pressed="false" aria-label="Toggle neural commands" title="Toggle neural commands">⚡</div>
                <div class="cx-batch-toggle ${settings.batchMode ? 'cx-batch-active' : ''}" id="cx-batch-toggle" role="button" tabindex="0" aria-pressed="${escAttr(String(!!settings.batchMode))}" aria-label="Toggle batch mode" title="Toggle batch mode (queue texts)">📋</div>
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
            <div class="cx-attachment-preview cx-hidden" id="cx-attachment-preview">
                <img alt="" />
                <span class="cx-attachment-label"></span>
                <button type="button" class="cx-attachment-remove" id="cx-attachment-remove" aria-label="Remove attached photo">✕</button>
            </div>
            <div class="cx-input-bar">
                <button type="button" class="cx-attach-btn" id="cx-attach" aria-label="Attach photo" title="Attach photo">＋</button>
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
    const attachment = normalizeSmsAttachment(msg.attachment);
    const attachmentHtml = attachment
        ? `<span class="cx-sms-attachment"><img src="${escAttr(attachment.dataUrl)}" alt="${escAttr(attachment.alt)}"><span>${escHtml(attachment.name)}</span></span>`
        : '';
    div.innerHTML = `${attachmentHtml}${msg.text ? `<span class="cx-sms-body">${escHtml(msg.text)}</span>` : ''}` +
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
        pendingSmsAttachment = null;
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
    updateSmsAttachmentPreview();

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
    const rawText = input?.value?.trim() || '';
    const attachment = normalizeSmsAttachment(pendingSmsAttachment);
    if (!area || !currentContactName) return;
    if (!rawText && !attachment) return;
    if (attachment && neuralMode) {
        cxAlert('Photo attachments can only be sent as normal SMS. Turn off neural mode first.', 'SMS Photo');
        return;
    }

    const isNeural = neuralMode;

    // Determine command type: from drawer mode or legacy {{CMD}} syntax
    const CMD_RE = /\{\{(COMMAND|FORGET|BELIEVE|COMPEL)\}\}\s*\{\{(.+?)\}\}/i;
    let cmdType = commandMode; // from drawer (null if no mode active)
    const displayFallback = attachment ? 'Photo' : '';
    const chatFallback = attachment ? '[photo]' : '';
    let displayText = rawText || displayFallback;
    let chatText = rawText || chatFallback;
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
    pushMessage(currentContactName, msgType, displayText, null, { attachment });

    if (settings.batchMode) {
        // ── BATCH MODE: stage message, don't send yet ──
        const bubble = renderBubble({ type: msgType, text: displayText, time: now(), attachment });
        bubble.classList.add('cx-sms-pending');
        area.appendChild(bubble);
        area.scrollTop = area.scrollHeight;
        input.value = '';
        pendingSmsAttachment = null;
        updateSmsAttachmentPreview();

        addToQueue(currentContactName, chatText, displayText, isNeural, cmdType, attachment);
    } else {
        // ── INSTANT MODE: send immediately (original behavior) ──
        area.appendChild(renderBubble({ type: msgType, text: displayText, time: now(), attachment }));
        input.value = '';
        pendingSmsAttachment = null;
        updateSmsAttachmentPreview();

        pushPrivatePhoneEvent({
            type: 'outgoing_sms',
            from: 'user',
            to: currentContactName,
            text: attachment ? `${displayText || 'Photo'} [photo]` : displayText,
            visibility: 'private',
            source: 'inline',
            canonical: true,
            sceneAware: false,
            timestamp: Date.now(),
        });
        sendImmediate(currentContactName, chatText, isNeural, cmdType, attachment);

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

function clearAllMapDataForCurrentChat() {
    try {
        localStorage.removeItem(placeStoreKey());
        localStorage.removeItem(mapMetaKey());
        const chatId = currentChatId();
        const prefix = `cx-loctrail-${chatId}-`;
        const toRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith(prefix)) toRemove.push(key);
        }
        for (const k of toRemove) localStorage.removeItem(k);
    } catch (e) { console.warn('[command-x] clear map data', e); }
}

function updateSmsAttachmentPreview() {
    const preview = phoneContainer?.querySelector('#cx-attachment-preview');
    if (!preview) return;
    const attachment = normalizeSmsAttachment(pendingSmsAttachment);
    const img = preview.querySelector('img');
    const label = preview.querySelector('.cx-attachment-label');
    if (!attachment) {
        preview.classList.add('cx-hidden');
        if (img) img.removeAttribute('src');
        if (label) label.textContent = '';
        return;
    }
    if (img) {
        img.src = attachment.dataUrl;
        img.alt = attachment.alt;
    }
    if (label) label.textContent = attachment.name || 'Photo';
    preview.classList.remove('cx-hidden');
}

function triggerSmsImagePicker() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) { input.remove(); return; }
        try {
            const dataUrl = await safeDataUrlFromFile(file, MAX_SMS_IMAGE_WIDTH, 0.82);
            if (dataUrl.length > MAX_SMS_ATTACHMENT_DATA_URL_SIZE) {
                const actualKb = Math.round(dataUrl.length / 1024);
                const limitKb = Math.round(MAX_SMS_ATTACHMENT_DATA_URL_SIZE / 1024);
                throw new Error(`Compressed image (${actualKb} KB) exceeds the ${limitKb} KB SMS limit. Please choose a smaller image.`);
            }
            pendingSmsAttachment = {
                type: 'image',
                dataUrl,
                name: file.name || 'photo',
                alt: file.name ? `Attached photo: ${file.name}` : 'Attached photo',
            };
            updateSmsAttachmentPreview();
        } catch (error) {
            await cxAlert(String(error?.message || error), 'SMS Photo');
        } finally {
            input.remove();
        }
    }, { once: true });
    input.click();
}

/**
 * Show user-facing instructions for uploading a custom map background.
 * Invoked from the Map header's ℹ️ button. Content covers supported formats,
 * recommended dimensions, how pins behave on the uploaded image, the zoom/pan
 * interaction model, and how to revert to the schematic view.
 */
function showMapUploadHelp() {
    // Map uploads share the avatar upload byte cap; alias here so the help
    // copy and future maintainers read this as a map-image limit.
    const MAX_MAP_IMAGE_FILE_BYTES = MAX_AVATAR_FILE_BYTES;
    const sizeMb = (MAX_MAP_IMAGE_FILE_BYTES / (1024 * 1024)).toFixed(0);
    const maxW = MAX_MAP_IMAGE_WIDTH;
    const message = [
        'Tap "Upload Image" to set a custom background for the map (city plan, floor plan, fantasy map, screenshot — anything you like).',
        '',
        'Supported formats: PNG, JPG, GIF, or WebP.',
        `Max file size: ${sizeMb} MB — raw files larger than that are rejected. Accepted uploads are stored locally as JPEG to keep chat storage small; if an image is wider than ${maxW}px on the long edge, it is also automatically downscaled first.`,
        '',
        'Recommended image shape: square (1:1). The map surface is a square frame and non-square images are cropped to "cover" it, so anything near the edges of a wide or tall image may be trimmed.',
        '',
        'After uploading:',
        '• Tap any empty spot on the map to add a new place pin at that location.',
        '• Drag existing place pins or your 📍 You pin to fine-tune positions.',
        '• Pinch, scroll-wheel, or double-click to zoom; drag to pan. Pin coordinates stay anchored to the image, so they stay correct at any zoom level.',
        '• Tap "📍 You" then the map to drop your own position marker.',
        '',
        'Reverting: tap "Use Schematic" to remove the uploaded image and go back to the built-in grid background. Place pins you have created are kept either way — only the background changes.',
        '',
        'Privacy note: map images are stored locally in your browser (localStorage, per SillyTavern chat). They are never uploaded to the LLM or any server.',
    ].join('\n');
    cxAlert(message, 'Uploading a Map Background');
}

function triggerMapImagePicker() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) { input.remove(); return; }
        try {
            const dataUrl = await safeDataUrlFromFile(file, MAX_MAP_IMAGE_WIDTH, 0.85);
            const meta = loadMapMeta();
            meta.mode = 'image';
            meta.imageDataUrl = dataUrl;
            saveMapMeta(meta);
            rebuildPhone();
            switchView('map');
            showToast('Map', 'Map image uploaded.');
        } catch (error) {
            await cxAlert(String(error?.message || error), 'Map Upload Error');
        } finally {
            input.remove();
        }
    }, { once: true });
    input.click();
}

async function addPlaceAtCoords(x, y) {
    const nameInput = await cxPrompt('Name this place:', {
        title: 'New Place',
        placeholder: 'e.g. café, apartment, office',
        maxLength: 60,
    });
    if (nameInput == null) return;
    const name = String(nameInput).trim();
    if (!name) return;
    const emojiInput = await cxPrompt('Emoji for this place (optional):', {
        title: 'New Place',
        defaultValue: '📍',
        placeholder: '📍',
        maxLength: 8,
    });
    const emoji = String(emojiInput ?? '📍').trim() || '📍';
    const stored = loadPlaces();
    // Guard against duplicate names
    if (findPlaceByNameOrAlias(name, stored)) {
        await cxAlert(`A place named "${name}" already exists.`, 'Map');
        return;
    }
    const clean = sanitizePlace({
        name,
        emoji,
        x: clampUnit(x),
        y: clampUnit(y),
        userPinned: true,
    }, stored);
    if (!clean) return;
    stored.push(clean);
    savePlaces(stored);
    rebuildPhone();
    switchView('map');
}

/**
 * Wire all map-view interactions: tap-to-add place, tap-pin-to-open-chat,
 * drag-to-reposition, image upload/clear, "set You pin" toggle, delete-place,
 * plus wheel/pinch zoom and drag-to-pan of the whole map.
 */
function wireMapInteractions() {
    if (!phoneContainer) return;
    const surface = phoneContainer.querySelector('#cx-map-surface');
    const viewport = phoneContainer.querySelector('#cx-map-viewport');
    // Idempotency guard: if this DOM tree has already been wired we skip,
    // to prevent duplicate handlers if callers invoke us more than once.
    const wireRoot = surface || phoneContainer.querySelector('[data-view="map"]');
    if (wireRoot?.dataset.cxMapWired === '1') return;
    if (wireRoot) wireRoot.dataset.cxMapWired = '1';

    phoneContainer.querySelector('#cx-map-upload')?.addEventListener('click', triggerMapImagePicker);
    phoneContainer.querySelector('#cx-map-help')?.addEventListener('click', () => showMapUploadHelp());
    phoneContainer.querySelector('#cx-map-clear-image')?.addEventListener('click', async () => {
        if (!await cxConfirm('Switch back to the schematic map? The uploaded image will be removed.', 'Map', { confirmLabel: 'Clear' })) return;
        const meta = loadMapMeta();
        meta.mode = 'schematic';
        meta.imageDataUrl = null;
        saveMapMeta(meta);
        rebuildPhone();
        switchView('map');
    });

    // "Set You pin" — manual fallback/override. Normal map tracking updates it
    // automatically from the user's `place` field in [status].
    let armYouPin = false;
    const youBtn = phoneContainer.querySelector('#cx-map-set-you');
    youBtn?.addEventListener('click', () => {
        armYouPin = !armYouPin;
        youBtn.classList.toggle('cx-settings-btn-active', armYouPin);
        youBtn.textContent = armYouPin ? 'Tap map…' : '📍 You';
    });

    // Delete place
    phoneContainer.querySelectorAll('[data-cx-map-delete]').forEach(btn =>
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const placeId = btn.dataset.cxMapDelete;
            const place = loadPlaces().find(p => p.id === placeId);
            if (!place) return;
            if (!await cxConfirm(`Delete place "${place.name}"? Any contacts currently there will lose their pin.`, 'Map', { confirmLabel: 'Delete', danger: true })) return;
            deletePlace(placeId);
            rebuildPhone();
            switchView('map');
        })
    );

    // Contact pin → open chat
    phoneContainer.querySelectorAll('[data-cx-map-contact]').forEach(pin =>
        pin.addEventListener('click', (e) => {
            // Skip if this was the end of a drag
            if (pin._wasDragged) { pin._wasDragged = false; e.stopPropagation(); return; }
            const name = pin.dataset.cxMapContact;
            if (name) openChat(name, 'cmdx');
        })
    );

    // Place pin click (no default action beyond preventing surface-click-add)
    phoneContainer.querySelectorAll('[data-cx-map-place]').forEach(pin =>
        pin.addEventListener('click', (e) => {
            if (pin._wasDragged) { pin._wasDragged = false; }
            e.stopPropagation();
        })
    );

    if (!surface || !viewport) return;

    /* === Zoom / pan state === */
    // scale=1 means the viewport fills the surface exactly. We clamp translation
    // so the viewport edges never move inside the surface edges — the user can
    // never see "outside" the map.
    const MIN_SCALE = 1;
    const MAX_SCALE = 5;
    const ZOOM_STEP = 1.25;
    const PAN_THRESHOLD_PX = 5; // movement below this still counts as a tap
    const view = { scale: 1, tx: 0, ty: 0 };
    const zoomIndicator = phoneContainer.querySelector('#cx-map-zoom-indicator');
    let hideIndicatorTimer = null;

    const clampTranslation = () => {
        const rect = surface.getBoundingClientRect();
        // At scale s, inner viewport is rect.width * s wide.
        // Translation tx in px is applied before scaling (transform-origin 0 0),
        // so the viewport's screen-space left is rect.left + tx and its right is
        // rect.left + tx + rect.width * scale. Constrain so it covers the surface:
        // tx <= 0 and tx >= rect.width * (1 - scale).
        const minTx = rect.width * (1 - view.scale);
        const minTy = rect.height * (1 - view.scale);
        if (view.tx > 0) view.tx = 0;
        if (view.tx < minTx) view.tx = minTx;
        if (view.ty > 0) view.ty = 0;
        if (view.ty < minTy) view.ty = minTy;
    };
    const applyTransform = () => {
        clampTranslation();
        viewport.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`;
        if (zoomIndicator) {
            zoomIndicator.textContent = `${Math.round(view.scale * 100)}%`;
            zoomIndicator.classList.add('cx-map-zoom-indicator-visible');
            if (hideIndicatorTimer) clearTimeout(hideIndicatorTimer);
            hideIndicatorTimer = setTimeout(() => {
                zoomIndicator.classList.remove('cx-map-zoom-indicator-visible');
            }, 1200);
        }
    };
    // Zoom toward a fixed point (in surface-local pixel coords) so the point
    // under the cursor/pinch-center stays stationary.
    const zoomAt = (surfacePxX, surfacePxY, newScale) => {
        const clamped = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScale));
        if (clamped === view.scale) return;
        const ratio = clamped / view.scale;
        view.tx = surfacePxX - (surfacePxX - view.tx) * ratio;
        view.ty = surfacePxY - (surfacePxY - view.ty) * ratio;
        view.scale = clamped;
        applyTransform();
    };
    const zoomAtCenter = (newScale) => {
        const rect = surface.getBoundingClientRect();
        zoomAt(rect.width / 2, rect.height / 2, newScale);
    };
    const resetView = () => {
        view.scale = 1; view.tx = 0; view.ty = 0;
        applyTransform();
    };

    // Button controls
    phoneContainer.querySelector('#cx-map-zoom-in')?.addEventListener('click', (e) => {
        e.stopPropagation(); zoomAtCenter(view.scale * ZOOM_STEP);
    });
    phoneContainer.querySelector('#cx-map-zoom-out')?.addEventListener('click', (e) => {
        e.stopPropagation(); zoomAtCenter(view.scale / ZOOM_STEP);
    });
    phoneContainer.querySelector('#cx-map-zoom-reset')?.addEventListener('click', (e) => {
        e.stopPropagation(); resetView();
    });

    // Wheel zoom: zoom toward cursor position. Prevent default so the phone
    // body doesn't scroll while the user is zooming.
    surface.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = surface.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        // Scale factor per wheel notch. deltaY < 0 = zoom in.
        const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
        zoomAt(px, py, view.scale * factor);
    }, { passive: false });

    // Double-click to zoom in toward the point.
    surface.addEventListener('dblclick', (e) => {
        if (e.target.closest('.cx-map-pin')) return;
        if (e.target.closest('.cx-map-controls')) return;
        const rect = surface.getBoundingClientRect();
        zoomAt(e.clientX - rect.left, e.clientY - rect.top, view.scale * ZOOM_STEP * ZOOM_STEP);
    });

    /* === Pan + pinch via pointer events === */
    // Active pointers (for pinch detection). We only track pointers that started
    // on the surface/viewport background (not on pins or controls).
    const pointers = new Map(); // pointerId -> { x, y }
    let panState = null; // { startTx, startTy, startX, startY, moved }
    let pinchState = null; // { startDist, startMidX, startMidY, startScale, startTx, startTy }
    // Tracks whether the most recent pointer gesture panned (so the subsequent
    // click event can be ignored by the tap-to-add-place handler).
    let lastGestureWasPan = false;

    const midpoint = () => {
        const pts = Array.from(pointers.values());
        return {
            x: (pts[0].x + pts[1].x) / 2,
            y: (pts[0].y + pts[1].y) / 2,
        };
    };
    const distance = () => {
        const pts = Array.from(pointers.values());
        return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    };

    surface.addEventListener('pointerdown', (e) => {
        // Ignore pointers that started on interactive children.
        if (e.target.closest('.cx-map-pin')) return;
        if (e.target.closest('.cx-map-controls')) return;
        if (e.button !== undefined && e.button !== 0) return;
        surface.setPointerCapture?.(e.pointerId);
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 1) {
            panState = {
                startTx: view.tx,
                startTy: view.ty,
                startX: e.clientX,
                startY: e.clientY,
                moved: false,
            };
            pinchState = null;
        } else if (pointers.size === 2) {
            // Transition from pan to pinch.
            const mid = midpoint();
            const rect = surface.getBoundingClientRect();
            pinchState = {
                startDist: distance() || 1,
                startMidSurfaceX: mid.x - rect.left,
                startMidSurfaceY: mid.y - rect.top,
                startScale: view.scale,
                startTx: view.tx,
                startTy: view.ty,
                lastMidX: mid.x,
                lastMidY: mid.y,
            };
            panState = null;
            lastGestureWasPan = true; // any pinch cancels tap-to-add
        }
    });

    surface.addEventListener('pointermove', (e) => {
        if (!pointers.has(e.pointerId)) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (pinchState && pointers.size >= 2) {
            // Pinch: zoom by distance ratio anchored at initial midpoint; pan
            // by the delta of the current midpoint from the start.
            const dist = distance() || 1;
            const mid = midpoint();
            const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, pinchState.startScale * (dist / pinchState.startDist)));
            // Compute new tx/ty so that the point originally under the
            // pinch midpoint stays under the current midpoint.
            const rect = surface.getBoundingClientRect();
            const curMidX = mid.x - rect.left;
            const curMidY = mid.y - rect.top;
            const ratio = newScale / pinchState.startScale;
            view.scale = newScale;
            view.tx = curMidX - (pinchState.startMidSurfaceX - pinchState.startTx) * ratio;
            view.ty = curMidY - (pinchState.startMidSurfaceY - pinchState.startTy) * ratio;
            applyTransform();
            return;
        }

        if (panState && pointers.size === 1) {
            const dx = e.clientX - panState.startX;
            const dy = e.clientY - panState.startY;
            if (!panState.moved && Math.hypot(dx, dy) > PAN_THRESHOLD_PX) {
                panState.moved = true;
            }
            if (panState.moved) {
                view.tx = panState.startTx + dx;
                view.ty = panState.startTy + dy;
                applyTransform();
            }
        }
    });

    const endPointer = (e) => {
        if (!pointers.has(e.pointerId)) return;
        pointers.delete(e.pointerId);
        if (pointers.size < 2) pinchState = null;
        if (pointers.size === 0) {
            lastGestureWasPan = !!(panState && panState.moved) || lastGestureWasPan;
            // Reset the flag on the next microtask — after the click event
            // handler below has had a chance to read it.
            if (lastGestureWasPan) {
                queueMicrotask(() => { lastGestureWasPan = false; });
            }
            panState = null;
        }
    };
    surface.addEventListener('pointerup', endPointer);
    surface.addEventListener('pointercancel', endPointer);

    // Surface click → add new place (only on empty area of the surface itself,
    // and only when the most recent gesture wasn't a pan/pinch).
    surface.addEventListener('click', async (e) => {
        // Bail if the click landed on a pin (pins stopPropagation, but be defensive).
        if (e.target.closest('.cx-map-pin')) return;
        if (e.target.closest('.cx-map-controls')) return;
        // Suppress click that was really the tail end of a drag/pan/pinch.
        if (lastGestureWasPan) { lastGestureWasPan = false; return; }
        // Allow clicks on the surface, viewport, or any explicit click-through decorations.
        if (e.target !== surface && e.target !== viewport && !e.target.closest('[data-cx-map-decoration="1"]')) {
            return;
        }
        // Convert click coordinates into original map space using the viewport's
        // bounding rect (which already reflects the current scale/translation).
        const rect = viewport.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width;
        const y = (e.clientY - rect.top) / rect.height;
        if (armYouPin) {
            armYouPin = false;
            if (youBtn) {
                youBtn.classList.remove('cx-settings-btn-active');
                youBtn.textContent = '📍 You';
            }
            const meta = loadMapMeta();
            meta.userPin = { x: clampUnit(x), y: clampUnit(y) };
            meta.userPlaceId = null;
            saveMapMeta(meta);
            rebuildPhone();
            switchView('map');
            return;
        }
        await addPlaceAtCoords(x, y);
    });

    // Drag pins (places + user "You" pin) — pointer events cover both mouse + touch.
    // Coordinates are computed against the viewport's rect (not the surface's)
    // so the committed position stays correct regardless of zoom/pan.
    const makeDraggable = (el, onCommit) => {
        if (!el) return;
        el.addEventListener('pointerdown', (ev) => {
            if (ev.button !== undefined && ev.button !== 0) return;
            ev.stopPropagation();
            ev.preventDefault();
            el.setPointerCapture?.(ev.pointerId);
            const startX = ev.clientX;
            const startY = ev.clientY;
            let moved = false;
            // Recompute the viewport rect on each move/up so a resize, scroll,
            // or zoom mid-drag doesn't desync coordinates.
            const onMove = (mv) => {
                const rect = viewport.getBoundingClientRect();
                const cx = clampUnit((mv.clientX - rect.left) / rect.width) * 100;
                const cy = clampUnit((mv.clientY - rect.top) / rect.height) * 100;
                el.style.left = `${cx.toFixed(2)}%`;
                el.style.top = `${cy.toFixed(2)}%`;
                if (Math.abs(mv.clientX - startX) > 3 || Math.abs(mv.clientY - startY) > 3) moved = true;
            };
            const onUp = (up) => {
                el.removeEventListener('pointermove', onMove);
                el.removeEventListener('pointerup', onUp);
                el.removeEventListener('pointercancel', onUp);
                el._wasDragged = moved;
                if (moved) {
                    const rect = viewport.getBoundingClientRect();
                    const finalX = clampUnit((up.clientX - rect.left) / rect.width);
                    const finalY = clampUnit((up.clientY - rect.top) / rect.height);
                    onCommit(finalX, finalY);
                }
            };
            el.addEventListener('pointermove', onMove);
            el.addEventListener('pointerup', onUp);
            el.addEventListener('pointercancel', onUp);
        });
    };

    phoneContainer.querySelectorAll('[data-cx-map-place]').forEach(pin => {
        makeDraggable(pin, (x, y) => {
            const placeId = pin.dataset.cxMapPlace;
            const stored = loadPlaces();
            const idx = stored.findIndex(p => p.id === placeId);
            if (idx < 0) return;
            stored[idx] = { ...stored[idx], x, y, userPinned: true };
            savePlaces(stored);
        });
    });
    const youPin = phoneContainer.querySelector('[data-cx-map-you]');
    if (youPin) {
        makeDraggable(youPin, (x, y) => {
            const meta = loadMapMeta();
            meta.userPin = { x, y };
            meta.userPlaceId = null;
            saveMapMeta(meta);
        });
    }
}

/* ======================================================================
   NOVA AGENT — UI wiring (plan §2c, §3b integration, §9)

   Bridges the Nova view DOM to the `sendNovaTurn` lifecycle that lives
   in the `/* === NOVA AGENT === *\/` section above. Responsibilities:

     - `wireNovaView(container)`           : attach pill / send / cancel handlers.
     - `refreshNovaPills(container)`       : update pill labels from settings.
     - `renderNovaTranscript(container)`   : draw the current session messages.
     - `appendNovaTranscriptLine(...)`     : add a single ad-hoc line (system/🔌).
     - `buildNovaSendRequest(ctx)`         : adapter that returns an
        `({messages, tools, tool_choice, signal}) => Promise<{content, tool_calls}>`
        callback backed by whichever ST API is available on this build:
          1. `ctx.ConnectionManagerRequestService?.sendRequest` (tools capable)
          2. `ctx.generateRaw` fallback — text-only, no tools. The caller
             can still run reads via their own tool handlers but the LLM
             won't emit tool_calls in this mode. Surfaced as a transcript
             "⚠︎ text-only mode" line so the user understands.
     - Picker modals: `novaPickProfile` / `novaPickSkill` / `novaPickTier`.

   All picker / transcript helpers are PURE w.r.t. the DOM: they only
   touch nodes under `phoneContainer`. Safe to call from anywhere.
   ====================================================================== */

// Module-level transcript cap — full history lives in session.messages,
// this just bounds the rendered DOM so it doesn't grow unbounded during
// a long conversation.
const NOVA_TRANSCRIPT_RENDER_CAP = 200;

function _novaContainer() {
    return phoneContainer?.querySelector('[data-view="nova"]') || null;
}

/** Human label for a tier id. */
function _novaTierLabel(tier) {
    const t = String(tier || 'read').toLowerCase();
    if (t === 'full') return 'Full';
    if (t === 'write') return 'Write';
    return 'Read';
}

/** Human label for a skill id. Falls back to the id itself. */
function _novaSkillLabel(skillId) {
    const s = NOVA_SKILLS.find(x => x.id === skillId);
    return s ? s.label : String(skillId || 'freeform');
}

/**
 * Sync the three pill labels with the currently active settings.nova state.
 */
function refreshNovaPills() {
    const novaView = _novaContainer();
    if (!novaView) return;
    const nova = settings?.nova || NOVA_DEFAULTS;
    const profileLbl = nova.profileName || '—';
    const skillLbl = _novaSkillLabel(nova.activeSkill || 'freeform');
    const tierLbl = _novaTierLabel(nova.defaultTier || 'read');
    const pp = novaView.querySelector('#cx-nova-pill-profile');
    const ps = novaView.querySelector('#cx-nova-pill-skill');
    const pt = novaView.querySelector('#cx-nova-pill-tier');
    if (pp) pp.textContent = `Profile: ${profileLbl}`;
    if (ps) ps.textContent = `Skill: ${skillLbl}`;
    if (pt) pt.textContent = `Tier: ${tierLbl}`;
}

/** Render a single session-message or transcript event into a DOM node. */
function _novaRenderMessageNode(msg) {
    const role = String(msg.role || '');
    const div = document.createElement('div');
    if (role === 'user') {
        div.className = 'cx-nova-msg cx-nova-msg-user';
        div.innerHTML = `<div class="cx-nova-msg-body">${escHtml(msg.content || '')}</div>`;
    } else if (role === 'assistant') {
        div.className = 'cx-nova-msg cx-nova-msg-assistant';
        const body = escHtml(msg.content || '');
        div.innerHTML = `<div class="cx-nova-msg-body">${body || '<em class="cx-nova-muted">(no content)</em>'}</div>`;
    } else if (role === 'tool') {
        // Tool result card — compact JSON preview.
        div.className = 'cx-nova-toolcard';
        let name = msg.name || 'tool';
        let bodyText = '';
        try { bodyText = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2); }
        catch (_) { bodyText = String(msg.content ?? ''); }
        div.innerHTML = `<div class="cx-nova-msg-body"><strong>${escHtml(name)}</strong> → <code>${escHtml(bodyText.slice(0, 400))}</code></div>`;
    } else if (role === 'system' || role === 'notice' || role === 'user-preview') {
        const variantClass = role === 'notice'
            ? 'cx-nova-msg-notice'
            : (role === 'user-preview' ? 'cx-nova-msg-user' : 'cx-nova-msg-system');
        div.className = `cx-nova-msg ${variantClass}`;
        div.innerHTML = `<div class="cx-nova-msg-body">${escHtml(msg.content || '')}</div>`;
    } else {
        div.className = 'cx-nova-msg';
        div.innerHTML = `<div class="cx-nova-msg-body">${escHtml(msg.content || '')}</div>`;
    }
    return div;
}

/**
 * Redraw the transcript pane from the active Nova session. If no
 * active session exists, renders the empty-state glyph so the user
 * isn't staring at a blank pane.
 */
function renderNovaTranscript() {
    const novaView = _novaContainer();
    if (!novaView) return;
    const pane = novaView.querySelector('#cx-nova-transcript');
    if (!pane) return;
    const ctx = getContext?.();
    const state = ctx ? getNovaState(ctx) : null;
    const session = state?.sessions?.find(s => s && s.id === state.activeSessionId);
    pane.innerHTML = '';
    if (!session || !Array.isArray(session.messages) || session.messages.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'cx-nova-empty';
        empty.id = 'cx-nova-empty';
        const nova = settings?.nova || NOVA_DEFAULTS;
        const needsProfile = !nova.profileName;
        empty.innerHTML = needsProfile
            ? `<div class="cx-nova-empty-glyph">✴︎</div>
               <div class="cx-nova-empty-title">Pick a connection profile</div>
               <div class="cx-nova-empty-body">Tap the <strong>Profile</strong> pill above to choose a SillyTavern connection profile. Nova will swap into that profile for each turn and restore your original profile when done.</div>`
            : `<div class="cx-nova-empty-glyph">✴︎</div>
               <div class="cx-nova-empty-title">Nova is ready</div>
               <div class="cx-nova-empty-body">Ask anything. Reads are instant; writes &amp; shell commands ask for approval first.</div>`;
        pane.appendChild(empty);
        return;
    }
    // Render tail up to the render cap.
    const msgs = session.messages.slice(-NOVA_TRANSCRIPT_RENDER_CAP);
    for (const m of msgs) pane.appendChild(_novaRenderMessageNode(m));
    pane.scrollTop = pane.scrollHeight;
}

/**
 * Append a single ad-hoc transcript line (e.g. "🔌 Switched to Foo").
 * NOT persisted in session.messages — purely a UI hint.
 */
function appendNovaTranscriptLine(text, variant = 'system') {
    const novaView = _novaContainer();
    if (!novaView) return;
    const pane = novaView.querySelector('#cx-nova-transcript');
    if (!pane) return;
    // Strip the empty-state placeholder on first append.
    pane.querySelector('#cx-nova-empty')?.remove();
    const node = _novaRenderMessageNode({ role: variant, content: text });
    pane.appendChild(node);
    pane.scrollTop = pane.scrollHeight;
}

/**
 * Promise-based picker that reuses the cxConfirm modal shell. Returns
 * the chosen value, or `null` if the user cancelled. Renders a list of
 * `{ value, label, hint? }` options as radio-style rows.
 */
function cxPickList(title, options, { initial = null, confirmLabel = 'Choose' } = {}) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'cx-modal-overlay';
        let selected = initial;
        const rowsHtml = options.length
            ? options.map((opt, i) => {
                const active = opt.value === selected;
                const hint = opt.hint ? `<div class="cx-pick-hint">${escHtml(opt.hint)}</div>` : '';
                return `<div class="cx-pick-row ${active ? 'cx-pick-active' : ''}" data-pick-value="${escAttr(String(opt.value))}" role="button" tabindex="0" aria-label="${escAttr(String(opt.label))}">
                    <div class="cx-pick-dot"></div>
                    <div class="cx-pick-body">
                        <div class="cx-pick-label">${escHtml(String(opt.label))}</div>
                        ${hint}
                    </div>
                </div>`;
            }).join('')
            : '<div class="cx-pick-empty">No options available.</div>';
        overlay.innerHTML = `
            <div class="cx-modal-box cx-pick-box" role="dialog" aria-modal="true" aria-labelledby="cx-modal-title">
                <div class="cx-modal-title" id="cx-modal-title">${escHtml(String(title))}</div>
                <div class="cx-modal-body cx-pick-list">${rowsHtml}</div>
                <div class="cx-modal-actions">
                    <button class="cx-modal-btn cx-modal-btn-secondary" id="cx-pick-cancel">Cancel</button>
                    <button class="cx-modal-btn cx-modal-btn-primary" id="cx-pick-confirm">${escHtml(confirmLabel)}</button>
                </div>
            </div>`;
        const close = (result) => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(result); };
        const onKey = (e) => { if (e.key === 'Escape') close(null); };
        const selectRow = (row) => {
            selected = row.dataset.pickValue;
            overlay.querySelectorAll('.cx-pick-row').forEach(r => r.classList.remove('cx-pick-active'));
            row.classList.add('cx-pick-active');
        };
        overlay.querySelectorAll('.cx-pick-row').forEach(row => {
            row.addEventListener('click', () => selectRow(row));
            row.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
                    e.preventDefault();
                    selectRow(row);
                }
            });
        });
        overlay.querySelector('#cx-pick-cancel').addEventListener('click', () => close(null));
        overlay.querySelector('#cx-pick-confirm').addEventListener('click', () => close(selected));
        document.addEventListener('keydown', onKey);
        document.body.appendChild(overlay);
        overlay.querySelector('#cx-pick-confirm').focus();
    });
}

async function novaGetExecuteSlash() {
    const ctx = getContext();
    if (typeof ctx?.executeSlashCommandsWithOptions !== 'function') return null;
    return async (cmd) => ctx.executeSlashCommandsWithOptions(cmd, { handleParserErrors: false, handleExecutionErrors: true });
}

/**
 * Open the in-phone Soul & Memory editor (plan §6b).
 *
 * Renders a modal with two textareas (soul + memory), a Reload button
 * that re-fetches the on-disk content, and per-pane Save buttons that
 * POST through `_novaBridgeWrite` to the `nova-agent-bridge` server
 * plugin. Falls back to a clear error message when the bridge is
 * unreachable, since soul/memory writes are the one Nova surface that
 * cannot work without the plugin.
 *
 * Reuses `cx-modal-overlay` / `cx-modal-box` for visual consistency
 * with `cxAlert` / `cxConfirm` / `cxPickList` and the approval modal.
 */
async function openNovaSoulMemoryEditor() {
    // Tear down any prior instance defensively. Multiple opens shouldn't
    // ever happen (the trigger is in Settings, which is single-instance),
    // but be safe.
    document.querySelector('.cx-modal-overlay.cx-nova-sm-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'cx-modal-overlay cx-nova-sm-overlay';
    overlay.innerHTML = `
        <div class="cx-modal-box cx-nova-sm-box" role="dialog" aria-modal="true" aria-labelledby="cx-nova-sm-title">
            <div class="cx-modal-title" id="cx-nova-sm-title">Nova — Soul &amp; Memory</div>
            <div class="cx-nova-sm-status" id="cx-nova-sm-status" role="status" aria-live="polite" aria-atomic="true">Loading…</div>
            <div class="cx-nova-sm-pane">
                <label class="cx-nova-sm-label" for="cx-nova-sm-soul">Soul (persona, voice, do/don't)</label>
                <textarea id="cx-nova-sm-soul" class="cx-nova-sm-textarea" spellcheck="false" placeholder="Loading soul.md…"></textarea>
                <div class="cx-nova-sm-pane-actions">
                    <button class="cx-modal-btn cx-modal-btn-primary" id="cx-nova-sm-save-soul" disabled>Save Soul</button>
                </div>
            </div>
            <div class="cx-nova-sm-pane">
                <label class="cx-nova-sm-label" for="cx-nova-sm-memory">Memory (chat-specific notes)</label>
                <textarea id="cx-nova-sm-memory" class="cx-nova-sm-textarea" spellcheck="false" placeholder="Loading memory.md…"></textarea>
                <div class="cx-nova-sm-pane-actions">
                    <button class="cx-modal-btn cx-modal-btn-primary" id="cx-nova-sm-save-memory" disabled>Save Memory</button>
                </div>
            </div>
            <div class="cx-modal-actions">
                <button class="cx-modal-btn cx-modal-btn-secondary" id="cx-nova-sm-reload">Reload from disk</button>
                <button class="cx-modal-btn cx-modal-btn-secondary" id="cx-nova-sm-close">Close</button>
            </div>
        </div>`;

    const close = () => {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('#cx-nova-sm-close').addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);

    const statusEl = overlay.querySelector('#cx-nova-sm-status');
    const soulTa = overlay.querySelector('#cx-nova-sm-soul');
    const memoryTa = overlay.querySelector('#cx-nova-sm-memory');
    const saveSoulBtn = overlay.querySelector('#cx-nova-sm-save-soul');
    const saveMemoryBtn = overlay.querySelector('#cx-nova-sm-save-memory');
    const reloadBtn = overlay.querySelector('#cx-nova-sm-reload');

    const setStatus = (text, kind = 'info') => {
        if (!statusEl) return;
        statusEl.textContent = text;
        statusEl.dataset.kind = kind;
    };

    const loadIntoTextareas = async () => {
        setStatus('Loading…');
        soulTa.disabled = true; memoryTa.disabled = true;
        saveSoulBtn.disabled = true; saveMemoryBtn.disabled = true;
        reloadBtn.disabled = true;
        try {
            const { soul, memory } = await loadNovaSoulMemory({ force: true });
            soulTa.value = String(soul || '');
            memoryTa.value = String(memory || '');
            setStatus(
                (soul || memory) ? 'Loaded.' : 'Loaded (both files were empty or unreachable).',
                (soul || memory) ? 'ok' : 'warn',
            );
        } catch (err) {
            setStatus(`Load failed: ${err?.message || err}`, 'error');
        } finally {
            soulTa.disabled = false; memoryTa.disabled = false;
            saveSoulBtn.disabled = false; saveMemoryBtn.disabled = false;
            reloadBtn.disabled = false;
            // Focus the first editable area so keyboard users can edit immediately.
            soulTa.focus();
        }
    };

    const saveOne = async ({ path, content, label, button }) => {
        button.disabled = true;
        const originalLabel = button.textContent;
        button.textContent = 'Saving…';
        setStatus(`Saving ${label}…`);
        try {
            const base = settings?.nova?.pluginBaseUrl || NOVA_DEFAULTS.pluginBaseUrl;
            const res = await _novaBridgeWrite({ pluginBaseUrl: base, path, content });
            if (res && res.ok) {
                try { invalidateNovaSoulMemoryCache(); } catch (_) { /* noop */ }
                setStatus(`${label} saved (${content.length} bytes).`, 'ok');
            } else {
                const reason = res?.error || 'unknown error';
                setStatus(`${label} save failed: ${reason}. Install/start the nova-agent-bridge plugin to enable writes.`, 'error');
            }
        } catch (err) {
            setStatus(`${label} save failed: ${err?.message || err}`, 'error');
        } finally {
            button.disabled = false;
            button.textContent = originalLabel;
        }
    };

    saveSoulBtn.addEventListener('click', () => saveOne({
        path: `nova/${NOVA_SOUL_FILENAME}`,
        content: String(soulTa.value || ''),
        label: 'Soul',
        button: saveSoulBtn,
    }));
    saveMemoryBtn.addEventListener('click', () => saveOne({
        path: `nova/${NOVA_MEMORY_FILENAME}`,
        content: String(memoryTa.value || ''),
        label: 'Memory',
        button: saveMemoryBtn,
    }));
    reloadBtn.addEventListener('click', () => { loadIntoTextareas().catch(() => {}); });

    await loadIntoTextareas();
}

/* ----------------------------------------------------------------------
   openNovaAuditLogViewer (plan §2b / §7b — "📜 View audit log")

   Read-only modal showing the per-chat in-memory audit log. The log is
   populated by `runNovaToolDispatch` (and a handful of upstream sites)
   via `appendNovaAuditLog`. Entries shape: { ts, tool, argsSummary,
   outcome }. The log is capped at NOVA_AUDIT_CAP (500) so we don't
   need to paginate; we just hand the array to the pure builder which
   renders newest-first with severity colouring.

   The DOM wrapper is intentionally thin — no fetch, no async, no
   bridge call. This is the user's "what just happened?" surface, so
   it must be cheap and instant. A Refresh button re-reads the in-
   memory log so a user who leaves the modal open across a turn can
   see new entries without closing/reopening.
   ---------------------------------------------------------------------- */
function openNovaAuditLogViewer() {
    // Re-opening the viewer while one is already up: invoke the
    // previous instance's close() through the shared cleanup hook
    // so its keydown listener is removed alongside the DOM. Without
    // this, each re-open would leave a stale `keydown` handler bound
    // to `document` until the user happened to press Escape.
    const existing = document.querySelector('.cx-modal-overlay.cx-nova-audit-overlay');
    if (existing && typeof existing._cxClose === 'function') {
        try { existing._cxClose(); } catch (_) { existing.remove(); }
    } else if (existing) {
        existing.remove();
    }

    const overlay = document.createElement('div');
    overlay.className = 'cx-modal-overlay cx-nova-audit-overlay';
    overlay.innerHTML = `
        <div class="cx-modal-box cx-nova-audit-box" role="dialog" aria-modal="true" aria-labelledby="cx-nova-audit-title">
            <div class="cx-modal-title" id="cx-nova-audit-title">Nova — Audit log</div>
            <div class="cx-modal-body" id="cx-nova-audit-body" aria-live="polite"></div>
            <div class="cx-modal-actions">
                <button class="cx-modal-btn cx-modal-btn-secondary" id="cx-nova-audit-refresh">Refresh</button>
                <button class="cx-modal-btn cx-modal-btn-primary" id="cx-nova-audit-close">Close</button>
            </div>
        </div>`;

    const close = () => {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
    };
    // Expose the cleanup hook on the DOM node so a second call to
    // openNovaAuditLogViewer can invoke it before removing the node.
    overlay._cxClose = close;
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('#cx-nova-audit-close').addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);

    const body = overlay.querySelector('#cx-nova-audit-body');
    const render = () => {
        let entries = [];
        try {
            const ctx = getContext();
            // getNovaState lazily heals malformed blobs and guarantees
            // `auditLog` is an array, so a missing `.nova` key is a
            // 0-entry render rather than a crash.
            const state = ctx ? getNovaState(ctx) : null;
            entries = (state && Array.isArray(state.auditLog)) ? state.auditLog : [];
        } catch (_) {
            entries = [];
        }
        body.innerHTML = buildNovaAuditLogModalBody(entries);
        // Auto-scroll to top so the newest entry is visible.
        body.scrollTop = 0;
    };
    overlay.querySelector('#cx-nova-audit-refresh').addEventListener('click', render);
    overlay.querySelector('#cx-nova-audit-close').focus();
    render();
}

async function novaPickProfile() {
    const exec = await novaGetExecuteSlash();
    if (!exec) { await cxAlert('This SillyTavern build does not expose executeSlashCommandsWithOptions().', 'Nova'); return; }
    const list = await listNovaProfiles({ executeSlash: exec });
    if (!list.ok || !list.profiles.length) {
        await cxAlert('No connection profiles found. Create one in SillyTavern → API Connections first.', 'Nova');
        return;
    }
    const options = list.profiles.map(p => ({ value: p, label: p }));
    const chosen = await cxPickList('Connection profile', options, {
        initial: settings.nova?.profileName || null,
        confirmLabel: 'Use profile',
    });
    if (!chosen) return;
    settings.nova.profileName = String(chosen);
    getContext().extensionSettings[EXT] = { ...settings };
    getContext().saveSettingsDebounced();
    refreshNovaPills();
    appendNovaTranscriptLine(`🔌 Profile set to ${chosen}.`, 'system');
}

async function novaPickSkill() {
    const options = NOVA_SKILLS.map(s => ({
        value: s.id,
        label: `${s.icon} ${s.label}`,
        hint: [
            s.description,
            `Default tier: ${_novaTierLabel(s.defaultTier)}`,
            `Tools: ${summariseNovaSkillTools(s)}`,
        ].join('\n'),
    }));
    const chosen = await cxPickList('Skill', options, {
        initial: settings.nova?.activeSkill || 'freeform',
        confirmLabel: 'Use skill',
    });
    if (!chosen) return;
    const skill = resolveNovaSkill(chosen);
    if (!skill) return;
    settings.nova.activeSkill = skill.id;
    // Snap tier to the skill's default (user can escalate after).
    if (skill.defaultTier) settings.nova.defaultTier = skill.defaultTier;
    getContext().extensionSettings[EXT] = { ...settings };
    getContext().saveSettingsDebounced();
    refreshNovaPills();
    appendNovaTranscriptLine(`✴︎ Skill set to ${skill.label} (tier: ${_novaTierLabel(settings.nova.defaultTier)}).`, 'system');
}

async function novaPickTier() {
    const options = [
        { value: 'read', label: 'Read', hint: 'Tools can read files, characters, worldbooks. No writes.' },
        { value: 'write', label: 'Write', hint: 'Tools can write files + run ST slashes. Each write asks for approval.' },
        { value: 'full', label: 'Full', hint: 'Write + shell_run. Destructive — use only if you understand what Nova may execute.' },
    ];
    const chosen = await cxPickList('Permission tier', options, {
        initial: settings.nova?.defaultTier || 'read',
        confirmLabel: 'Use tier',
    });
    if (!chosen) return;
    settings.nova.defaultTier = String(chosen);
    getContext().extensionSettings[EXT] = { ...settings };
    getContext().saveSettingsDebounced();
    refreshNovaPills();
    appendNovaTranscriptLine(`🛡️ Tier set to ${_novaTierLabel(chosen)}.`, 'system');
}

/**
 * Build the `sendRequest` function for `sendNovaTurn`. Tries the full
 * tool-calling path (`ConnectionManagerRequestService.sendRequest`) first;
 * falls back to `generateRaw` for text-only mode on older ST builds.
 *
 * Returns an async function with signature:
 *   ({ messages, tools, tool_choice, signal }) => Promise<{ content, tool_calls }>
 */
function resolveNovaConnectionProfileId(ctx, profileName) {
    const wanted = String(profileName || '').trim();
    if (!wanted) return '';
    const profiles = ctx?.extensionSettings?.connectionManager?.profiles;
    if (!Array.isArray(profiles)) return wanted;
    const hit = profiles.find(p => p && (p.id === wanted || p.name === wanted));
    return String(hit?.id || wanted);
}

function normaliseNovaToolSchema(tool) {
    if (!tool || typeof tool !== 'object') return null;
    if (tool.type === 'function' && tool.function && typeof tool.function === 'object') return tool;
    const name = String(tool.name || '').trim();
    if (!name) return null;
    const parameters = tool.parameters && typeof tool.parameters === 'object'
        ? tool.parameters
        : { type: 'object', properties: {}, additionalProperties: false };
    return {
        type: 'function',
        function: {
            name,
            description: String(tool.description || tool.displayName || name),
            parameters,
        },
    };
}

function normaliseNovaToolSchemas(tools) {
    if (!Array.isArray(tools)) return [];
    return tools.map(normaliseNovaToolSchema).filter(Boolean);
}

function buildNovaSendRequest(ctx, profileName = '') {
    const svc = ctx?.ConnectionManagerRequestService;
    const profileId = resolveNovaConnectionProfileId(ctx, profileName);
    // Preferred: full chat-completion request with tools support.
    if (svc && typeof svc.sendRequest === 'function') {
        return async ({ messages, tools, tool_choice, signal }) => {
            const resp = await svc.sendRequest(
                profileId,
                messages,
                undefined,
                { stream: false, signal, extractData: false, includePreset: true },
                {
                    tools: normaliseNovaToolSchemas(tools),
                    tool_choice,
                },
            );
            // Normalise to { content, tool_calls } shape the dispatcher expects.
            if (resp && typeof resp === 'object') {
                if (resp.choices && Array.isArray(resp.choices) && resp.choices[0]?.message) {
                    const m = resp.choices[0].message;
                    return { content: m.content || '', tool_calls: Array.isArray(m.tool_calls) ? m.tool_calls : [] };
                }
                if (resp.message && typeof resp.message === 'object') {
                    return { content: resp.message.content || '', tool_calls: Array.isArray(resp.message.tool_calls) ? resp.message.tool_calls : [] };
                }
                if (resp.content !== undefined || resp.tool_calls !== undefined) {
                    return { content: resp.content || '', tool_calls: Array.isArray(resp.tool_calls) ? resp.tool_calls : [] };
                }
            }
            return { content: typeof resp === 'string' ? resp : '', tool_calls: [] };
        };
    }
    // Fallback: `generateRaw` returns plain text — no tool_calls available.
    if (typeof ctx?.generateRaw === 'function') {
        return async ({ messages, signal }) => {
            // Translate our {role, content} messages to generateRaw's
            // {systemPrompt, prompt} shape. Keep the system concatenation
            // for provenance; any tool/tool-result entries get flattened
            // into the user prompt.
            const systemParts = [];
            const convoParts = [];
            for (const m of (messages || [])) {
                if (m.role === 'system') systemParts.push(m.content || '');
                else if (m.role === 'user') convoParts.push(`User: ${m.content || ''}`);
                else if (m.role === 'assistant') convoParts.push(`Assistant: ${m.content || ''}`);
                else convoParts.push(`${m.role}: ${m.content || ''}`);
            }
            const text = await ctx.generateRaw({
                systemPrompt: systemParts.join('\n\n'),
                prompt: convoParts.join('\n\n'),
                signal,
            });
            return { content: String(text || ''), tool_calls: [] };
        };
    }
    // No sendRequest available at all — caller will bail on `no-send-request`.
    return null;
}

/**
 * Show / hide the in-flight UI: disable Send, reveal Cancel, dim input.
 */
function setNovaInFlight(inFlight) {
    const novaView = _novaContainer();
    if (!novaView) return;
    const sendBtn = novaView.querySelector('#cx-nova-send');
    const cancelBtn = novaView.querySelector('#cx-nova-cancel');
    const input = novaView.querySelector('#cx-nova-input');
    if (sendBtn) { sendBtn.disabled = !!inFlight; sendBtn.textContent = inFlight ? 'Thinking…' : 'Send'; }
    if (cancelBtn) cancelBtn.classList.toggle('cx-hidden', !inFlight);
    if (input) input.disabled = !!inFlight;
}

/**
 * Click handler for the Nova Send button. Routes through
 * `withNovaProfileMutex` → `sendNovaTurn`.
 */
async function novaHandleSend() {
    const novaView = _novaContainer();
    if (!novaView) return;
    const input = novaView.querySelector('#cx-nova-input');
    const text = String(input?.value || '').trim();
    if (!text) return;

    const ctx = getContext();
    const nova = settings.nova || NOVA_DEFAULTS;

    if (!nova.profileName) {
        await cxAlert('Pick a connection profile first (tap the Profile pill).', 'Nova');
        return;
    }

    const sendRequest = buildNovaSendRequest(ctx, nova.profileName);
    if (!sendRequest) {
        await cxAlert('This SillyTavern build exposes neither ConnectionManagerRequestService nor generateRaw. Nova cannot dispatch a turn.', 'Nova');
        return;
    }
    const textOnlyFallback = !ctx?.ConnectionManagerRequestService?.sendRequest;

    const exec = await novaGetExecuteSlash();
    if (!exec) {
        await cxAlert('This SillyTavern build does not expose executeSlashCommandsWithOptions() for profile swap.', 'Nova');
        return;
    }

    // Push the user message into the DOM immediately for snappy feedback,
    // then clear the input. sendNovaTurn will persist it to the session.
    appendNovaTranscriptLine(text, 'user-preview');
    if (input) { input.value = ''; input.focus(); }

    const { soul, memory } = await loadNovaSoulMemory();

    // Build the tool handler set: soul/memory self-edit (§6b),
    // phone-internal stores (§4e), plugin-backed filesystem (§4a),
    // ST-API tools (§4d), and plugin-backed shell (§4b).
    const toolHandlers = {
        ...buildNovaSoulMemoryHandlers({}),
        ...buildNovaPhoneHandlers({}),
        ...buildNovaFsHandlers({}),
        ...buildNovaStTools({}),
        ...buildNovaShellHandler({}),
    };

    setNovaInFlight(true);
    if (textOnlyFallback) {
        appendNovaTranscriptLine('⚠︎ Text-only mode — ConnectionManagerRequestService unavailable; tool calls are disabled this turn.', 'notice');
    }

    // Plan §4f — probe the `nova-agent-bridge` server plugin and filter
    // the tool registry to match what's actually installed. If the
    // plugin is absent, the LLM must not see `fs_*` / `shell_*`
    // (those would round-trip as `nova-bridge-unreachable` errors and
    // burn tool-call slots). The probe result is cached per
    // `NOVA_PROBE_TTL_MS` so this is cheap on subsequent turns.
    let effectiveTools = textOnlyFallback ? [] : NOVA_TOOLS;
    if (!textOnlyFallback) {
        let probe;
        try {
            probe = await probeNovaBridge({ baseUrl: nova.pluginBaseUrl });
        } catch (_) { probe = null; }
        effectiveTools = filterNovaToolsByCapabilities({ tools: NOVA_TOOLS, probe });
        // Emit the plan's "yellow banner" as a single-turn transcript
        // notice so the user can see why `fs_read`, `shell_run`, etc.
        // aren't available. Only shown when something was actually
        // filtered — avoids noise on healthy installs and on older
        // plugin builds that don't advertise capabilities yet.
        if (probe && probe.present === false && effectiveTools.length !== NOVA_TOOLS.length) {
            appendNovaTranscriptLine(
                '⚠︎ Nova bridge plugin not detected — filesystem and shell tools are disabled this turn. Install `nova-agent-bridge` to enable them.',
                'notice',
            );
        }
    }
    const activeSkill = resolveNovaSkill(nova.activeSkill || 'freeform');
    effectiveTools = filterNovaToolsBySkill({ tools: effectiveTools, skill: activeSkill });
    if (!textOnlyFallback) {
        const unavailableSkillTools = listUnavailableNovaSkillTools({ tools: effectiveTools, skill: activeSkill });
        if (unavailableSkillTools.length) {
            appendNovaTranscriptLine(
                `⚠︎ ${activeSkill.label} expected tools unavailable this turn: ${unavailableSkillTools.join(', ')}. If these are bridge-backed tools, install or update nova-agent-bridge.`,
                'notice',
            );
        }
    }

    const run = () => sendNovaTurn({
        ctx,
        userText: text,
        skillId: nova.activeSkill || 'freeform',
        profileName: nova.profileName,
        soul,
        memory,
        maxToolCalls: Math.max(1, Number(nova.maxToolCalls) || NOVA_DEFAULTS.maxToolCalls),
        turnTimeoutMs: Math.max(10000, Number(nova.turnTimeoutMs) || NOVA_DEFAULTS.turnTimeoutMs),
        tools: effectiveTools,
        sendRequest,
        executeSlash: exec,
        isToolCallingSupported: typeof ctx?.isToolCallingSupported === 'function' ? ctx.isToolCallingSupported : undefined,
        tier: nova.defaultTier || 'read',
        toolHandlers,
        confirmApproval: async ({ tool, args }) => {
            // Phase 4c: for fs_write, fetch the current file and compose a
            // unified diff so the user sees exactly what will change before
            // clicking the red button. All three helpers (`fs_read` in
            // `toolHandlers`, `buildNovaUnifiedDiff`, `cxNovaApprovalModal`'s
            // `diffText` arg) already exist — this is pure composition.
            // `buildFsWriteDiffPreview` never throws and returns '' for any
            // non-fs_write tool, bad args, or fs_read failure, so non-write
            // approvals are unaffected.
            const diffText = await buildFsWriteDiffPreview({
                tool,
                args,
                fsRead: toolHandlers.fs_read,
            });
            const ok = await cxNovaApprovalModal({ tool, args, diffText, permission: tool?.permission });
            // §4b — when the user has opted into "Remember approvals this
            // session", approving the call adds the tool to the per-session
            // Set so the dispatcher's gate skips the modal next time. The
            // Set is read by the gate via `rememberedApprovals` below.
            // Reads never reach this function (gate returns
            // requiresApproval:false), so the only entries that ever land
            // here are write/shell tools.
            if (ok && nova.rememberApprovalsSession && tool?.name) {
                novaSessionApprovedTools.add(String(tool.name));
            }
            return ok;
        },
        rememberedApprovals: nova.rememberApprovalsSession ? novaSessionApprovedTools : null,
    });

    let result;
    let thrownNotice = '';
    try {
        // Announce swap + restore around the turn body for user feedback.
        result = await withNovaProfileMutex(async () => {
            appendNovaTranscriptLine(`🔌 Switching to profile ${nova.profileName}…`, 'system');
            const out = await run();
            return out;
        });
    } catch (err) {
        thrownNotice = `❌ Turn threw: ${String(err?.message || err)}`;
    } finally {
        setNovaInFlight(false);
    }

    // Re-render the persisted session first. Some preflight failures return
    // before a session exists; appending transient notices after this keeps
    // those failures visible instead of being cleared by the empty-state render.
    renderNovaTranscript();
    if (result && result.swappedProfile) {
        appendNovaTranscriptLine(`🔌 Restored profile to ${result.swappedProfile.from || '(none)'}.`, 'system');
    }
    if (result && !result.ok) {
        const reason = result.reason || 'unknown';
        if (reason === 'no-active-profile') {
            appendNovaTranscriptLine('⚠︎ Turn failed: no active profile to restore. Save or select your current SillyTavern connection profile before using Nova, then try again.', 'notice');
        } else {
            appendNovaTranscriptLine(`⚠︎ Turn failed: ${reason}${result.error ? ' — ' + result.error : ''}`, 'notice');
        }
    }
    if (thrownNotice) {
        appendNovaTranscriptLine(thrownNotice, 'notice');
    }
}

function novaHandleCancel() {
    try { novaAbortController?.abort(new Error('user-cancel')); } catch (_) { /* noop */ }
    appendNovaTranscriptLine('🛑 Cancelling turn…', 'notice');
}

async function novaHandleClearContext() {
    if (novaTurnInFlight) {
        await cxAlert('Cancel or wait for the current Nova turn before clearing context.', 'Nova');
        return;
    }
    const ok = await cxConfirm(
        'Clear Nova context history for this chat? This removes the active Nova transcript from future turns. The audit log is kept.',
        'Clear Nova context',
        'Clear',
        'Cancel',
    );
    if (!ok) return;
    const ctx = getContext();
    const state = getNovaState(ctx);
    let session = state.sessions.find(s => s && s.id === state.activeSessionId);
    if (!session) {
        session = createNovaSession(state, {
            skill: settings?.nova?.activeSkill || 'freeform',
            tier: settings?.nova?.defaultTier || 'read',
            profileName: settings?.nova?.profileName || '',
        });
    }
    session.messages = [];
    session.toolCalls = [];
    session.updatedAt = Date.now();
    saveNovaState(ctx);
    renderNovaTranscript();
    appendNovaTranscriptLine('🧹 Nova context history cleared for this chat.', 'notice');
}

/**
 * Wire all Nova-view event handlers. Called from `wirePhone()`.
 */
function wireNovaView() {
    const novaView = _novaContainer();
    if (!novaView) return;
    novaView.querySelector('#cx-nova-pill-profile')?.addEventListener('click', () => {
        novaPickProfile().catch(err => cxAlert(String(err?.message || err), 'Nova'));
    });
    novaView.querySelector('#cx-nova-pill-skill')?.addEventListener('click', () => {
        novaPickSkill().catch(err => cxAlert(String(err?.message || err), 'Nova'));
    });
    novaView.querySelector('#cx-nova-pill-tier')?.addEventListener('click', () => {
        novaPickTier().catch(err => cxAlert(String(err?.message || err), 'Nova'));
    });
    novaView.querySelector('#cx-nova-send')?.addEventListener('click', () => {
        novaHandleSend().catch(err => cxAlert(String(err?.message || err), 'Nova'));
    });
    novaView.querySelector('#cx-nova-cancel')?.addEventListener('click', () => {
        novaHandleCancel();
    });
    novaView.querySelector('#cx-nova-clear')?.addEventListener('click', () => {
        novaHandleClearContext().catch(err => cxAlert(String(err?.message || err), 'Nova'));
    });
    // Enter submits; Shift+Enter = newline.
    novaView.querySelector('#cx-nova-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            novaHandleSend().catch(err => cxAlert(String(err?.message || err), 'Nova'));
        }
    });
    refreshNovaPills();
    renderNovaTranscript();
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
            if (app === 'cmdx' || app === 'profiles' || app === 'quests' || app === 'phone-settings' || app === 'map' || app === 'nova') {
                currentApp = app;
                switchView(app);
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
    // --- Nova in-phone settings (v0.13.0) ---
    const novaOnChange = () => {
        saveSettings();
        try { refreshNovaPills(); } catch (_) { /* noop */ }
    };
    phoneContainer.querySelector('#cx-set-nova-profile')?.addEventListener('change', novaOnChange);
    phoneContainer.querySelector('#cx-set-nova-tier')?.addEventListener('change', novaOnChange);
    phoneContainer.querySelector('#cx-set-nova-max-tools')?.addEventListener('change', novaOnChange);
    phoneContainer.querySelector('#cx-set-nova-timeout')?.addEventListener('change', novaOnChange);
    phoneContainer.querySelector('#cx-set-nova-plugin-url')?.addEventListener('change', novaOnChange);
    phoneContainer.querySelector('#cx-set-nova-remember-approvals')?.addEventListener('change', novaOnChange);
    phoneContainer.querySelector('#cx-set-nova-edit-sm')?.addEventListener('click', () => {
        openNovaSoulMemoryEditor().catch(err => cxAlert(String(err?.message || err), 'Nova'));
    });
    phoneContainer.querySelector('#cx-set-nova-audit')?.addEventListener('click', () => {
        try { openNovaAuditLogViewer(); }
        catch (err) { cxAlert(String(err?.message || err), 'Nova'); }
    });
    phoneContainer.querySelector('#cx-set-lock')?.addEventListener('change', (e) => {
        settings.showLockscreen = e.target.checked;
        saveSettings();
    });
    // --- Map settings wiring ---
    phoneContainer.querySelector('#cx-set-track-locations')?.addEventListener('change', (e) => {
        settings.trackLocations = e.target.checked;
        saveSettings();
        if (!settings.trackLocations) clearMapPrompt();
        else injectMapPrompt();
        rebuildPhone();
    });
    phoneContainer.querySelector('#cx-set-auto-places')?.addEventListener('change', (e) => {
        settings.autoRegisterPlaces = e.target.checked;
        saveSettings();
        injectMapPrompt();
    });
    phoneContainer.querySelector('#cx-set-trails')?.addEventListener('change', (e) => {
        settings.showLocationTrails = e.target.checked;
        saveSettings();
        rebuildPhone();
    });
    phoneContainer.querySelector('#cx-set-map-every-n')?.addEventListener('change', (e) => {
        const val = Math.max(1, Math.floor(Number(e.target.value) || 1));
        settings.mapInjectEveryN = val;
        saveSettings();
    });
    phoneContainer.querySelector('#cx-set-clear-places')?.addEventListener('click', async () => {
        if (await cxConfirm('Delete all places and location trails for this chat?', 'Clear Map', { confirmLabel: 'Clear All', danger: true })) {
            clearAllMapDataForCurrentChat();
            rebuildPhone();
            switchView('phone-settings');
        }
    });
    // Wire map view itself (buttons + pin interactions). Safe to call even if view not active.
    wireMapInteractions();
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
        pendingSmsAttachment = null;
        clearSmsPrompt();
        clearTypingIndicator();
        updateSmsAttachmentPreview();
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
    phoneContainer.querySelector('#cx-attach')?.addEventListener('click', triggerSmsImagePicker);
    phoneContainer.querySelector('#cx-attachment-remove')?.addEventListener('click', () => {
        pendingSmsAttachment = null;
        updateSmsAttachmentPreview();
    });
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

    // Wire the Nova view (pills, composer, transcript). Safe to call
    // even if the view isn't currently active.
    try { wireNovaView(); } catch (err) { console.warn(`[${EXT}] wireNovaView failed`, err); }
}

/* ======================================================================
   PANEL
   ====================================================================== */

/**
 * Render the phone shell + close button into `wrapper`.
 *
 * Why this looks the way it does: previously this was done as a single
 * `wrapper.innerHTML = `<div id="cx-panel-close">✕</div>${buildPhone()}`;`
 * which mixed a static head with a template-literal interpolation of
 * the dynamically-built phone HTML. CodeQL's `js/xss-through-dom`
 * heuristic flagged that pattern as "DOM text reinterpreted as HTML"
 * because the phone HTML transitively includes data that *could*
 * originate from DOM-read sources. `buildPhone()` already escapes its
 * dynamic substitutions through `escHtml`/`escAttr`, but to silence
 * the false-positive without disabling the rule we:
 *   1. Build the close button as a real DOM node (`textContent` only,
 *      never `innerHTML`), so the ✕ glyph is never reinterpreted.
 *   2. Parse the phone HTML through `<template>.innerHTML`, which is
 *      an inert document fragment (no script execution, no event
 *      handler resolution at parse time) — then move its children
 *      into the wrapper.
 *   3. Use `replaceChildren()` so callers don't have to reset the
 *      wrapper before calling.
 */
function renderPhoneInto(wrapper) {
    wrapper.replaceChildren();
    const closeBtn = document.createElement('div');
    closeBtn.id = 'cx-panel-close';
    closeBtn.textContent = '✕';
    wrapper.appendChild(closeBtn);
    const tpl = document.createElement('template');
    // `buildPhone()` is a trusted HTML producer: every dynamic
    // substitution (contact names, statuses, place labels, quest
    // titles, user persona, etc.) is routed through `escHtml` /
    // `escAttr` at the interpolation site before it reaches this
    // assignment. Parsing through a detached `<template>` keeps the
    // resulting fragment inert (no script execution at parse time).
    // CodeQL's `js/xss-through-dom` heuristic still traces contact-name
    // strings sourced (eventually) from chat metadata as DOM-text and
    // can't see the per-site escapes — the suppression below
    // documents that the audit was performed.
    // lgtm[js/xss-through-dom]
    tpl.innerHTML = buildPhone();
    wrapper.appendChild(tpl.content);
}

function createPanel() {
    if (phoneContainer) return;
    const wrapper = document.createElement('div');
    wrapper.id = 'cx-panel-wrapper';
    wrapper.classList.add('cx-hidden');
    renderPhoneInto(wrapper);
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
    updateUnreadBadges();
    // Idempotent — first call wires up the ST event listeners; subsequent
    // calls (panel rebuilds) are no-ops. Symmetric with destroyPanel's
    // unwireEventListeners() so the enable-toggle releases handlers.
    wireEventListeners();
}

function rebuildPhone() {
    const wrapper = document.getElementById('cx-panel-wrapper');
    if (!wrapper) return;
    const savedContact = currentContactName;
    const savedApp = currentApp;
    renderPhoneInto(wrapper);
    wrapper.querySelector('#cx-panel-close')?.addEventListener('click', () => {
        wrapper.classList.add('cx-hidden');
        settings.panelOpen = false;
        saveSettings();
    });
    wirePhone();
    if (savedContact && savedApp) {
        openChat(savedContact, savedApp, true);
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
    // Per ST docs (Writing-Extensions.md §Performance): release event
    // listeners when the panel goes away so toggling the extension
    // off + on doesn't leak handlers.
    unwireEventListeners();
}

/* ----------------------------------------------------------------------
   Event-source listener lifecycle.

   Registration was historically inline in the jQuery init block, with
   no symmetric `removeListener`. ST's documented best-practice for
   extensions is to clean up listeners when they're no longer needed
   (st-docs/For_Contributors/Writing-Extensions.md §Performance), and
   the in-handler `if (!settings.enabled) return` guards papered over
   the leak rather than fixing it. We now keep canonical handler refs
   in `_eventListenerHandlers` and call `removeListener` in
   `unwireEventListeners`. Both functions are idempotent so the
   enable-toggle / panel-destroy paths can call them freely.
   ---------------------------------------------------------------------- */

let _eventListenerHandlers = null; // { eventSource, event_types, handlers } | null

function wireEventListeners() {
    if (_eventListenerHandlers) return;
    const ctx = getContext();
    const eventSource = ctx?.eventSource;
    const event_types = ctx?.event_types;
    if (!eventSource || !event_types || typeof eventSource.on !== 'function') return;

    const handlers = {
        characterMessageRendered: (mesId) => {
            if (!settings.enabled) return;
            styleCommandsInMessage(mesId);
            hideSmsTagsInDom(mesId);
            hideContactsTagsInDom(mesId);
            hideQuestTagsInDom(mesId);
            hidePlaceTagsInDom(mesId);
        },
        userMessageRendered: (mesId) => {
            if (!settings.enabled) return;
            styleCommandsInMessage(mesId);
        },
        messageReceived: () => {
            if (!settings.enabled) return;
            const freshCtx = getContext();
            const chat = freshCtx.chat || [];
            if (!chat.length) return;
            const msg = chat[chat.length - 1];
            if (!msg || msg.is_user || msg.is_system) return;
            const mesId = chat.length - 1;
            const isSwipeRegeneration = consumePendingSwipeRegeneration(mesId);

            // ── [sms] FIRST — must run before [contacts] which can trigger rebuildPhone ──
            const smsBlocks = extractSmsBlocks(msg.mes);
            const userName = (freshCtx.name1 || '').toLowerCase();
            if (smsBlocks) {
                for (const block of smsBlocks) {
                    // Filter: only capture texts directed at the user's phone.
                    if (block.to) {
                        const toName = block.to.toLowerCase();
                        if (toName !== 'user' && toName !== userName && toName !== 'me') {
                            console.log(`[${EXT}] Skipping [sms] to="${block.to}" (not for user)`);
                            continue;
                        }
                    } else if (!awaitingReply) {
                        const allContacts = getContactsFromContext();
                        const fromKnown = block.from && allContacts.some(c => c.name.toLowerCase() === block.from.toLowerCase());
                        if (!fromKnown) {
                            console.log(`[${EXT}] Skipping [sms] with no to attr and unknown sender "${block.from}"`);
                            continue;
                        }
                    }

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

            const parsedContacts = extractContacts(msg.mes);
            if (parsedContacts) {
                mergeNpcs(parsedContacts);
                shouldRebuild = true;
            }

            if (settings.trackLocations) {
                const parsedPlaces = extractPlaces(msg.mes);
                if (parsedPlaces?.length) {
                    const added = registerIncomingPlaces(parsedPlaces);
                    if (added) shouldRebuild = true;
                }
                if (parsedContacts?.length) {
                    if (applyContactPlaces(parsedContacts, mesId)) shouldRebuild = true;
                }
            }

            const parsedQuests = extractQuests(msg.mes);
            if (parsedQuests?.length) {
                shouldRebuild = mergeQuests(parsedQuests, { source: 'auto' }) || shouldRebuild;
            }

            if (shouldRebuild && phoneContainer && !document.getElementById('cx-panel-wrapper')?.classList.contains('cx-hidden')) {
                rebuildPhone();
            }

            // A swipe regeneration re-rolls the same ST message, so it should
            // replace phone artifacts without advancing Command-X turn cadence.
            if (!isSwipeRegeneration) {
                applyInjectionThrottle();
            }
        },
        messageSwiped: (mesId) => {
            if (!settings.enabled) return;
            markPendingSwipeRegeneration(mesId);
            removeMessagesForMesId(mesId);
            removePrivatePhoneEventsForMesId(mesId);
            removeTrailForMesId(mesId);
            const area = phoneContainer?.querySelector('#cx-msg-area');
            if (area && currentContactName) {
                renderAllBubbles(area, currentContactName, false);
            }
        },
        messageDeleted: (deletedMesId) => {
            if (!settings.enabled) return;
            const freshCtx = getContext();
            const deletedId = Number.isFinite(Number(deletedMesId))
                ? Number(deletedMesId)
                : (freshCtx.chat || []).length;
            removeMessagesForMesId(deletedId);
            removePrivatePhoneEventsForMesId(deletedId);
            removeTrailForMesId(deletedId);
            clearPendingSwipeRegeneration(deletedId);
            const area = phoneContainer?.querySelector('#cx-msg-area');
            if (area && currentContactName) {
                renderAllBubbles(area, currentContactName, false);
            }
        },
        chatChangedPhone: () => {
            if (!settings.enabled) return;
            currentContactName = null;
            currentApp = null;
            awaitingReply = false;
            commandMode = null;
            _turnCounter = 0;
            _pendingSwipeRegenerations.clear();
            invalidateContactCaches();
            invalidateNovaBridgeProbeCache();
            clearSmsPrompt();
            clearTypingIndicator();
            if (settings.enabled && settings.autoDetectNpcs !== false) injectContactsPrompt();
            else clearContactsPrompt();
            if (settings.enabled) injectQuestPrompt();
            else clearQuestPrompt();
            if (settings.enabled && settings.trackLocations) injectMapPrompt();
            else clearMapPrompt();
            refreshPrivatePhonePrompt();
            if (phoneContainer) rebuildPhone();
        },
        // Nova-specific CHAT_CHANGED hook. Kept separate so a future Nova-disabled
        // toggle can short-circuit it independently of the phone UI reset.
        chatChangedNova: () => {
            if (!settings.enabled) return;
            try { initNovaOnce(getContext()); } catch (e) {
                try { console.warn(`[${EXT}] initNovaOnce threw:`, e); } catch (_) { /* noop */ }
            }
        },
    };

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, handlers.characterMessageRendered);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, handlers.userMessageRendered);
    eventSource.on(event_types.MESSAGE_RECEIVED, handlers.messageReceived);
    eventSource.on(event_types.MESSAGE_SWIPED, handlers.messageSwiped);
    eventSource.on(event_types.MESSAGE_DELETED, handlers.messageDeleted);
    eventSource.on(event_types.CHAT_CHANGED, handlers.chatChangedPhone);
    eventSource.on(event_types.CHAT_CHANGED, handlers.chatChangedNova);

    _eventListenerHandlers = { eventSource, event_types, handlers };
}

function unwireEventListeners() {
    const refs = _eventListenerHandlers;
    _eventListenerHandlers = null;
    if (!refs) return;
    const { eventSource, event_types, handlers } = refs;
    if (typeof eventSource?.removeListener !== 'function') return;
    const pairs = [
        [event_types.CHARACTER_MESSAGE_RENDERED, handlers.characterMessageRendered],
        [event_types.USER_MESSAGE_RENDERED, handlers.userMessageRendered],
        [event_types.MESSAGE_RECEIVED, handlers.messageReceived],
        [event_types.MESSAGE_SWIPED, handlers.messageSwiped],
        [event_types.MESSAGE_DELETED, handlers.messageDeleted],
        [event_types.CHAT_CHANGED, handlers.chatChangedPhone],
        [event_types.CHAT_CHANGED, handlers.chatChangedNova],
    ];
    for (const [type, handler] of pairs) {
        try { eventSource.removeListener(type, handler); } catch (_) { /* best-effort */ }
    }
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
   NOVA AGENT — state + prompt-composition helpers (plan §3a, §6c)

   Pure helpers only. Turn lifecycle, tool registry, and UI wiring land in a
   later sprint once the `nova-agent-bridge` plugin + ConnectionManager probing
   are ready for manual browser validation. The functions below are used
   exclusively through `getContext()` chat metadata and never touch the DOM,
   so they are safe to mirror in `test/nova-*.test.mjs`.
   ====================================================================== */

const NOVA_STATE_KEY = 'nova';                 // ctx.chatMetadata[EXT].nova
const NOVA_SESSION_CAP = 20;                    // plan §3a
const NOVA_AUDIT_CAP = 500;                     // plan §3a
const NOVA_MEMORY_CHARS_CAP = 16 * 1024;        // plan §6c truncation budget

/* ----------------------------------------------------------------------
   NOVA AGENT — module-level turn state (plan §3a).

   Three `let` bindings that the Phase 3b `sendNovaTurn` lifecycle mutates.
   Declared here so §3b can land as a near-pure diff without also touching
   the top of the section, and so `_getNovaTurnState()` can ship now as the
   stable read-only hook Phase 3b tests will assert against.

   - `novaTurnInFlight`: Boolean re-entrancy guard. `sendNovaTurn` sets it
     true at the top of its happy-path, resets it in a `finally` block
     (see §3b step 8). Second concurrent call bails with a "turn already
     in flight" toast rather than stacking abort controllers.
   - `novaAbortController`: The `AbortController` whose `.signal` is
     forwarded to `ConnectionManagerRequestService.sendRequest` and to
     `probeNovaBridge`. Non-null only while a turn is running. Phase 3c's
     Cancel button calls `.abort()` on it.
   - `novaToolRegistryVersion`: Monotonic counter bumped by future tool
     re-registrations (e.g. Phase 4f discovers the bridge plugin
     mid-session and adds `fs_read`/`shell_run`). Phase 3b reads it at
     turn start to decide whether to rebuild the tool schema array from
     `NOVA_TOOLS` (shipped in Phase 4a). 0 means "never registered".

   `_getNovaTurnState()` returns a fresh snapshot on every call.
   `hasAbort` is a boolean — deliberately NOT the `AbortController`
   reference, so tests cannot mutate live state through the hook.
   ---------------------------------------------------------------------- */

let novaTurnInFlight = false;
let novaAbortController = null;
let novaToolRegistryVersion = 0;

/* §4b — Per-session approval cache.

   When `settings.nova.rememberApprovalsSession` is ON, approving a
   write/shell tool adds its name to this `Set<string>` and the
   dispatcher's gate (`novaToolGate`) returns `requiresApproval:false`
   for any subsequent call to that same tool *for the rest of this
   browser session*. The Set is intentionally module-level (not
   persisted) — closing/reopening the page or reloading ST clears it,
   which matches the user contract ("for this session").

   Lifecycle:
     - Toggle goes true  → Set kept (existing approvals stay).
     - Toggle goes false → Set cleared (every tool re-prompts).
     - Tool approved     → name added (only when toggle is true).
     - Tool denied       → name NOT added.
     - Page reload       → Set fresh-empty.

   The per-call read-and-mutate happens in `novaHandleSend`'s
   `confirmApproval` composer; the dispatcher itself only ever reads
   the Set via `rememberedApprovals`. */
const novaSessionApprovedTools = new Set();

/**
 * Public accessor for the per-session approvals Set. Returns the live
 * Set so callers (tests, diagnostics, the approval composer) can
 * inspect / mutate it directly. The dispatcher gate accepts a Set or
 * Array via `rememberedApprovals`, so passing this directly is safe.
 */
function getNovaSessionApprovedTools() {
    return novaSessionApprovedTools;
}

/**
 * Clear the per-session approvals Set. Called when the user toggles
 * `rememberApprovalsSession` off, so unchecking the box has the same
 * effect as starting a fresh session. Returns the count cleared.
 */
function clearNovaSessionApprovedTools() {
    const n = novaSessionApprovedTools.size;
    novaSessionApprovedTools.clear();
    return n;
}

/**
 * Read-only snapshot of the module-level Nova turn state. Safe to call
 * from tests or diagnostics without leaking the live AbortController.
 */
function _getNovaTurnState() {
    return {
        inFlight: novaTurnInFlight,
        hasAbort: novaAbortController !== null,
        registryVersion: novaToolRegistryVersion,
    };
}

/** Return the per-chat Nova state blob, lazily initialised. */
function getNovaState(ctx) {
    const root = ctx?.chatMetadata?.[EXT];
    if (!root) return createEmptyNovaState();
    if (!root[NOVA_STATE_KEY] || typeof root[NOVA_STATE_KEY] !== 'object') {
        root[NOVA_STATE_KEY] = createEmptyNovaState();
    }
    const state = root[NOVA_STATE_KEY];
    // Forward-compat: guarantee the documented shape even on older stored blobs.
    if (!Array.isArray(state.sessions)) state.sessions = [];
    if (!Array.isArray(state.auditLog)) state.auditLog = [];
    if (!('activeSessionId' in state)) state.activeSessionId = null;
    return state;
}

function createEmptyNovaState() {
    return { sessions: [], activeSessionId: null, auditLog: [] };
}

/** Persist Nova state. Caller is responsible for mutating it first. */
function saveNovaState(ctx) {
    if (ctx?.saveMetadataDebounced) ctx.saveMetadataDebounced();
}

/**
 * Create a new Nova session and push it onto the state, evicting oldest
 * sessions once the cap is exceeded. Returns the new session object.
 */
function createNovaSession(state, { skill, tier, profileName }) {
    const now = Date.now();
    // Session IDs are not security-sensitive (they're collision keys for UI
    // lookup, never exposed to untrusted code), but prefer the cryptographic
    // UUID when available for better uniqueness guarantees and to keep static
    // analysers happy.
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
    // Evict oldest first when over cap.
    while (state.sessions.length > NOVA_SESSION_CAP) state.sessions.shift();
    state.activeSessionId = id;
    return session;
}

/**
 * Append an audit log entry (tool invocation outcome) and trim to the cap.
 * `argsSummary` should never include raw file contents — callers summarise
 * before handing in (plan §13 redact test will enforce this for tool handlers).
 */
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

/**
 * Compose the full Nova system prompt per plan §6c. Pure string helper so
 * it can be covered by a unit test. Memory is truncated (tail-kept) to
 * `NOVA_MEMORY_CHARS_CAP` with an explicit "…truncated" marker so the LLM
 * doesn't silently receive partial content.
 */
function composeNovaSystemPrompt({ basePrompt = '', skillPrompt = '', soul = '', memory = '', toolContract = '' } = {}) {
    const mem = String(memory || '');
    const truncated = mem.length > NOVA_MEMORY_CHARS_CAP;
    const memSlice = truncated
        ? '[…truncated head…]\n' + mem.slice(mem.length - NOVA_MEMORY_CHARS_CAP)
        : mem;
    const sections = [
        String(basePrompt || '').trim(),
        String(skillPrompt || '').trim(),
        '---',
        '# Soul',
        String(soul || '').trim(),
        '---',
        '# Memory',
        memSlice.trim(),
        '---',
        String(toolContract || '').trim(),
    ];
    // Drop empty trimmed sections but always keep separators that sit between
    // two non-empty blocks. Simpler: just filter empty strings.
    return sections.filter(s => s.length > 0).join('\n');
}

/* ----------------------------------------------------------------------
   NOVA AGENT — bridge-plugin capability probe (plan §4f).

   Pings `GET <pluginBaseUrl>/manifest` with a short timeout to decide
   whether the `nova-agent-bridge` server plugin is installed and which
   tool surfaces it advertises. Callers (Phase 3c tool dispatcher) use
   the returned `capabilities` map to decide whether to register the
   fs/shell tools or fall back to phone/st-api-only mode.

   Contract:
   - Never throws. On 404 / non-200 / network error / timeout, resolves
     to `{ present: false }`.
   - On success, returns
     `{ present: true, version, root, shellAllowList, capabilities }`
     where `capabilities` is a plain object of booleans (unknown flags
     coerced via `!!`; non-object manifest bodies drop it).
   - Result is cached in a module-level cache for `NOVA_PROBE_TTL_MS`
     (60s). `CHAT_CHANGED` invalidates it so switching chats re-probes
     without requiring a full reload.
   - `fetchImpl` / `nowImpl` are injectable so `test/nova-probe.test.mjs`
     can drive the probe without a live network or real timers.
   ---------------------------------------------------------------------- */

const NOVA_PROBE_TTL_MS = 60_000;
const NOVA_PROBE_TIMEOUT_MS = 3_000;

// Module-level cache. Shape: `{ result, expiresAt }` or `null` when cold.
let _novaBridgeProbeCache = null;

function invalidateNovaBridgeProbeCache() {
    _novaBridgeProbeCache = null;
}

/**
 * Coerce a manifest `capabilities` payload into a plain `{ [key]: boolean }`
 * map. Non-objects / arrays / nullish → `undefined` (caller drops the key
 * from the returned shape). Strict `!!` coercion so "false"/0/"" all become
 * `false`.
 */
function _coerceNovaCapabilities(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const out = {};
    for (const k of Object.keys(raw)) out[k] = !!raw[k];
    return out;
}

/**
 * Prefixes of tool names that depend on the `nova-agent-bridge` server
 * plugin. When the plugin is absent, every tool starting with one of
 * these prefixes is dropped from the per-turn tool list so the LLM
 * never advertises something that will reliably return
 * `{ error: 'nova-bridge-unreachable' }`. Everything else (`nova_*`,
 * `phone_*`, `st_*`) runs in-process and stays regardless.
 */
const NOVA_BRIDGE_TOOL_PREFIXES = Object.freeze(['fs_', 'shell_']);

function _isBridgeBackedToolName(name) {
    if (typeof name !== 'string') return false;
    for (const p of NOVA_BRIDGE_TOOL_PREFIXES) {
        if (name.startsWith(p)) return true;
    }
    return false;
}

/**
 * Filter the Nova tool registry against a bridge-probe result so the
 * LLM only ever sees tools that have a live handler.
 *
 * Contract:
 *   - `probe.present === false` → drop every bridge-backed tool
 *     (`fs_*`, `shell_*`). Keep the rest.
 *   - `probe.present === true` with a `capabilities` map → drop any
 *     tool whose capability key is **explicitly `false`**. Tools not
 *     mentioned in the map pass through (forward-compat: a new tool
 *     added to the extension should light up as soon as a newer
 *     plugin advertises it, not when the extension is updated to
 *     list it explicitly here).
 *   - `probe` missing, malformed, or `probe.present === true` with no
 *     `capabilities` map → return `tools` unchanged (fail open). This
 *     matters for in-flight probe races and for older bridge versions
 *     that pre-date the capabilities contract.
 *   - Non-array / null / undefined `tools` → `[]` (defensive).
 *   - Never throws. Returns a fresh array; the input is never mutated.
 */
function filterNovaToolsByCapabilities({ tools, probe } = {}) {
    if (!Array.isArray(tools)) return [];
    // Fail open when we have no usable probe. A stale "present: true"
    // is much safer than a false "present: false" that would strip
    // every filesystem tool mid-turn.
    if (!probe || typeof probe !== 'object' || Array.isArray(probe)) {
        return tools.slice();
    }

    if (probe.present === false) {
        return tools.filter((t) => !_isBridgeBackedToolName(t && t.name));
    }

    // `present === true` (or any truthy non-false — be liberal in what
    // we accept). If the plugin advertised a capabilities map, use it
    // as a precise allow-list for bridge-backed tools. If not, trust
    // everything — the plugin is there, it just didn't tell us what
    // routes it implements.
    const caps = (probe.capabilities && typeof probe.capabilities === 'object' && !Array.isArray(probe.capabilities))
        ? probe.capabilities
        : null;
    if (!caps) return tools.slice();

    return tools.filter((t) => {
        const name = t && t.name;
        if (typeof name !== 'string') return false;
        // Non-bridge tools are never gated by capabilities.
        if (!_isBridgeBackedToolName(name)) return true;
        // Bridge-backed tool: include only if the capability key is
        // not explicitly `false`. Missing keys pass through (forward-
        // compat with capabilities-light plugin builds).
        return caps[name] !== false;
    });
}

/**
 * Return a skill's declared tool names, normalised for comparisons.
 * `null` means "all tools"; `[]` means no valid defaultTools array.
 */
function _novaSkillDefaultToolNames(skill) {
    if (!skill || skill.defaultTools === 'all') return null;
    if (!Array.isArray(skill.defaultTools)) return [];
    return skill.defaultTools
        .map(name => String(name || '').trim())
        .filter(Boolean);
}

/**
 * Apply a skill's `defaultTools` allow-list after bridge capability filtering.
 * Returns a fresh unfiltered copy for `defaultTools:'all'`, otherwise the
 * subset of available tool metadata whose names are allowed by the skill.
 */
function filterNovaToolsBySkill({ tools, skill } = {}) {
    if (!Array.isArray(tools)) return [];
    const allowed = _novaSkillDefaultToolNames(skill);
    if (!allowed) return tools.slice();
    const allowedSet = new Set(allowed);
    return tools.filter(tool => allowedSet.has(String(tool?.name || '')));
}

/**
 * List skill-declared tools that are absent from the effective registry.
 * Used for user-facing bridge/capability warnings before a Nova turn starts.
 */
function listUnavailableNovaSkillTools({ tools, skill } = {}) {
    const expected = _novaSkillDefaultToolNames(skill);
    if (!expected || !expected.length) return [];
    const available = new Set((Array.isArray(tools) ? tools : []).map(tool => String(tool?.name || '')));
    return expected.filter(name => !available.has(name));
}

/**
 * Build the skill-picker tool summary, capped to avoid overlong modal rows.
 */
function summariseNovaSkillTools(skill) {
    const names = _novaSkillDefaultToolNames(skill);
    if (!names) return 'all tools allowed by the active permission tier';
    if (!names.length) return 'none';
    if (names.length <= MAX_SUMMARISED_SKILL_TOOLS) return names.join(', ');
    return `${names.slice(0, MAX_SUMMARISED_SKILL_TOOLS).join(', ')} +${names.length - MAX_SUMMARISED_SKILL_TOOLS} more`;
}

async function probeNovaBridge({
    baseUrl,
    fetchImpl,
    nowImpl,
    ttlMs = NOVA_PROBE_TTL_MS,
    timeoutMs = NOVA_PROBE_TIMEOUT_MS,
    force = false,
} = {}) {
    const now = typeof nowImpl === 'function' ? nowImpl : Date.now;
    const doFetch = typeof fetchImpl === 'function'
        ? fetchImpl
        : (typeof fetch === 'function' ? fetch : null);

    // Cache hit within TTL — return the cached result regardless of the
    // (possibly different) baseUrl. Phase 3c reads settings.nova.pluginBaseUrl
    // at steady state; switching it at runtime is rare and a chat reload
    // clears the cache via CHAT_CHANGED.
    if (!force && _novaBridgeProbeCache && _novaBridgeProbeCache.expiresAt > now()) {
        return _novaBridgeProbeCache.result;
    }

    const url = String(baseUrl || NOVA_DEFAULTS.pluginBaseUrl).replace(/\/+$/, '') + '/manifest';

    const miss = (reason) => {
        const result = { present: false };
        _novaBridgeProbeCache = { result, expiresAt: now() + ttlMs };
        try { console.debug('[command-x] nova bridge probe →', reason, url); } catch (_) { /* noop */ }
        return result;
    };

    if (!doFetch) return miss('no-fetch');

    // AbortSignal.timeout is the documented way; fall back to a manual
    // controller on older browsers that ship only AbortController.
    let signal;
    let manualTimeoutId;
    let manualCtl;
    try {
        if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
            signal = AbortSignal.timeout(timeoutMs);
        } else if (typeof AbortController === 'function') {
            manualCtl = new AbortController();
            manualTimeoutId = setTimeout(() => manualCtl.abort(), timeoutMs);
            signal = manualCtl.signal;
        }
    } catch (_) { /* leave signal undefined */ }

    let resp;
    try {
        resp = await doFetch(url, { method: 'GET', signal });
    } catch (_err) {
        return miss('network-error');
    } finally {
        // Prevent the fallback timer from aborting a stale controller and
        // keeping an extra timer alive after the fetch resolves.
        if (manualTimeoutId !== undefined) {
            try { clearTimeout(manualTimeoutId); } catch (_) { /* noop */ }
        }
    }

    if (!resp || !resp.ok) {
        return miss(`status-${resp && resp.status}`);
    }

    let body;
    try {
        body = await resp.json();
    } catch (_err) {
        return miss('bad-json');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return miss('non-object-body');
    }

    const result = { present: true };
    if (body.version !== undefined) result.version = String(body.version);
    if (body.root !== undefined) result.root = String(body.root);
    if (Array.isArray(body.shellAllowList)) {
        result.shellAllowList = body.shellAllowList.map(String);
    }
    const caps = _coerceNovaCapabilities(body.capabilities);
    if (caps) result.capabilities = caps;

    _novaBridgeProbeCache = { result, expiresAt: now() + ttlMs };
    try { console.debug('[command-x] nova bridge probe → present', url, result); } catch (_) { /* noop */ }
    return result;
}

/* ----------------------------------------------------------------------
   NOVA AGENT — soul.md / memory.md loader (plan §6a, §6b).

   Fetches Nova's `soul.md` (persona) and `memory.md` (durable notes)
   from the extension folder so they can be inlined into the system
   prompt by `sendNovaTurn`. Both files are served by ST's static
   handler at `/scripts/extensions/third-party/<EXT>/nova/*.md` — the
   same path pattern used for `settings.html` at init time — so no
   plugin is required for the read path. The write path (editing
   soul/memory via `nova_write_soul` etc.) lands with Phase 6b via
   the `fs_write` tool or ST's `/api/files/*` fallback; this helper
   is read-only.

   Contract:
   - Never throws. A 404, network error, non-text body, or missing
     global `fetch` resolves to an empty string for that file.
   - Both files are fetched in parallel via `Promise.all`. A failure
     on one does not take down the other.
   - Result is cached in a module-level cache for
      `NOVA_SOUL_MEMORY_TTL_MS` (5 min). `invalidateNovaSoulMemoryCache()`
      drops the cache; callers should invoke it after a `nova_write_soul`
      / `nova_append_memory` / `nova_overwrite_memory` / "Reload
      soul/memory" action.
   - `fetchImpl` / `nowImpl` are injectable so
     `test/nova-soul-memory.test.mjs` can drive the helper without a
     live network or real timers.
   ---------------------------------------------------------------------- */

const NOVA_SOUL_MEMORY_TTL_MS = 5 * 60_000; // 5 min
const NOVA_SOUL_FILENAME = 'soul.md';
const NOVA_MEMORY_FILENAME = 'memory.md';

// Default URL builder — Phase 6b may override `baseUrl` to read from
// `SillyTavern/data/<user>/user/files/nova/` via `/api/files/*` once
// the "user-owned soul/memory" flow lands. For the default read path,
// the extension-bundled copies are served by ST's static handler.
function defaultNovaSoulMemoryBaseUrl() {
    // Mirrors the settings.html path in `jQuery(async () => ...)` — uses
    // the same `EXT` constant so a rename of the extension folder only
    // has to happen in one place.
    return `/scripts/extensions/third-party/${EXT}/nova`;
}

// Module-level cache. Shape: `{ result: { soul, memory }, expiresAt }` or `null` when cold.
let _novaSoulMemoryCache = null;

function invalidateNovaSoulMemoryCache() {
    _novaSoulMemoryCache = null;
}

/**
 * Fetch one file, coerce to a string, swallow every error. Used as the
 * per-file primitive inside `loadNovaSoulMemory`. Never throws.
 */
async function _fetchNovaMarkdown(url, { fetchImpl }) {
    const doFetch = typeof fetchImpl === 'function'
        ? fetchImpl
        : (typeof fetch === 'function' ? fetch : null);
    if (!doFetch) return '';
    let resp;
    try {
        resp = await doFetch(url, { method: 'GET' });
    } catch (_) {
        return '';
    }
    if (!resp || !resp.ok) return '';
    let text;
    try {
        text = await resp.text();
    } catch (_) {
        return '';
    }
    return typeof text === 'string' ? text : '';
}

/**
 * Load Nova's `soul.md` + `memory.md`. See header comment for contract.
 *
 * @param {object} [opts]
 * @param {string}   [opts.baseUrl]   - URL folder containing the two files. Default: extension-bundled path.
 * @param {function} [opts.fetchImpl] - Test-injectable `fetch` replacement.
 * @param {function} [opts.nowImpl]   - Test-injectable `Date.now` replacement.
 * @param {number}   [opts.ttlMs]     - Cache TTL. Default 5 min.
 * @param {boolean}  [opts.force]     - Bypass the cache. Default false.
 * @returns {Promise<{ soul: string, memory: string }>}
 */
async function loadNovaSoulMemory({
    baseUrl,
    fetchImpl,
    nowImpl,
    ttlMs = NOVA_SOUL_MEMORY_TTL_MS,
    force = false,
} = {}) {
    const now = typeof nowImpl === 'function' ? nowImpl : Date.now;

    if (!force && _novaSoulMemoryCache && _novaSoulMemoryCache.expiresAt > now()) {
        return _novaSoulMemoryCache.result;
    }

    const root = String(baseUrl || defaultNovaSoulMemoryBaseUrl()).replace(/\/+$/, '');
    const soulUrl = `${root}/${NOVA_SOUL_FILENAME}`;
    const memoryUrl = `${root}/${NOVA_MEMORY_FILENAME}`;

    // Fetch in parallel. A failure on one file must not take down the
    // other — each primitive is independently swallowed.
    const [soul, memory] = await Promise.all([
        _fetchNovaMarkdown(soulUrl, { fetchImpl }),
        _fetchNovaMarkdown(memoryUrl, { fetchImpl }),
    ]);

    const result = { soul, memory };
    _novaSoulMemoryCache = { result, expiresAt: now() + ttlMs };
    return result;
}

/* ----------------------------------------------------------------------
   NOVA AGENT — tool tier + approval gate (plan §3c precursor, §5).

   Pure synchronous decision helper used by the Phase 3c dispatch loop
   BEFORE any tool handler runs. Answers two independent questions:

     1. Is this tool *allowed* at the session's current tier?
        (`tier: 'read'` blocks write + shell; `'write'` blocks shell;
         `'full'` allows everything.)
     2. If allowed, does the call require a user approval modal?
        (Reads never do. Writes + shell do, unless the session has
         pre-approved the tool via `rememberApprovalsSession`.)

   Keeping these two decisions in one helper means there is exactly
   one place the Phase 3c dispatcher calls before showing `cxConfirm`,
   and exactly one place `test/nova-tool-gate.test.mjs` needs to
   exhaustively cover the 3×3 matrix.

   Return shape: `{ allowed: boolean, requiresApproval: boolean,
   reason?: string }`. `reason` is only set on `allowed:false`; valid
   values are `tier-too-low`, `unknown-permission`,
   `missing-permission`. Callers should treat unknown reasons
   conservatively — default to "deny and surface the reason to the
   user" rather than trying to interpret them.

   Defensive defaults:
     - Malformed / missing `tier`   → treated as `'read'` (strictest).
     - Malformed / missing `permission` → denied with
       `missing-permission`. Not treated as `'read'` because an
       unrecognised permission on a production tool is a bug, not a
       no-op we should silently run.
     - `rememberedApprovals` may be a `Set<string>`, array, or nullish.
       Anything else (object, string, etc.) is ignored — the gate
       returns `requiresApproval: true` as if no approvals were
       remembered. This mirrors ST's permissive settings round-trip
       where a corrupted key shouldn't brick the agent.
   ---------------------------------------------------------------------- */

const NOVA_TIERS = Object.freeze(['read', 'write', 'full']);
const NOVA_PERMISSIONS = Object.freeze(['read', 'write', 'shell']);

// Lookup table: `_NOVA_TIER_ALLOWS[tier]` is the set of permissions
// that tier can run. Kept as plain Sets so the hot path is an O(1)
// membership check — this helper runs once per tool_call in the
// Phase 3c dispatch loop.
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

/**
 * Decide whether a tool call is (a) allowed under the current tier
 * and (b) requires a user approval modal before running.
 *
 * @param {object} opts
 * @param {'read'|'write'|'shell'} opts.permission - The tool's declared permission class.
 * @param {'read'|'write'|'full'}  opts.tier       - The session's current tier.
 * @param {string}                 [opts.toolName] - Tool name, used for `rememberedApprovals` lookup.
 * @param {Set<string>|string[]|null} [opts.rememberedApprovals] - Session-scoped pre-approvals.
 * @returns {{ allowed: boolean, requiresApproval: boolean, reason?: string }}
 */
function novaToolGate({ permission, tier, toolName, rememberedApprovals } = {}) {
    const safeTier = NOVA_TIERS.includes(tier) ? tier : 'read';

    // Unknown/missing permission: deny rather than silently treat as read.
    // An unrecognised permission on a production tool is a bug, and we
    // want it surfaced loudly in the audit log, not swallowed.
    if (permission == null) {
        return { allowed: false, requiresApproval: false, reason: 'missing-permission' };
    }
    if (!NOVA_PERMISSIONS.includes(permission)) {
        return { allowed: false, requiresApproval: false, reason: 'unknown-permission' };
    }

    const allows = _NOVA_TIER_ALLOWS[safeTier];
    if (!allows.has(permission)) {
        return { allowed: false, requiresApproval: false, reason: 'tier-too-low' };
    }

    // Allowed. Now decide approval.
    // Reads never need approval (they can't mutate state).
    if (permission === 'read') {
        return { allowed: true, requiresApproval: false };
    }

    // Write or shell: require approval unless pre-approved for the session.
    const preApproved = _novaRememberedApprovalsHas(rememberedApprovals, toolName);
    return { allowed: true, requiresApproval: !preApproved };
}

/* ----------------------------------------------------------------------
   NOVA AGENT — unified-diff preview helper (plan §4c).

   Pure string function used by the `fs_write` approval modal (Phase 3c)
   to render a "you are about to change X" preview before the user clicks
   Approve. Not a full patch generator — does not emit `@@` hunk headers,
   does not collapse unchanged context, does not try to be `diff -u` byte
   compatible. The goal is a legible, bounded, easily-reviewed list of
   `-` / `+` / ` ` lines for the modal. Truncates large diffs to a
   configurable line cap with an explicit "N more lines" sentinel so the
   LLM and the user both know content was hidden.
   ---------------------------------------------------------------------- */

const NOVA_DIFF_MAX_LINES_DEFAULT = 2000;
// Hard cap on the LCS DP-cell budget to prevent the approval modal from
// freezing or OOMing on pathologically large inputs. At 4M cells the table
// is ~16 MB of Uint32 (plus row object overhead). Anything above this
// short-circuits to a "diff too large" sentinel rather than attempting the
// O(m·n) pass. Raise with care — this runs on the UI thread.
const NOVA_DIFF_MAX_DP_CELLS = 4_000_000;
const NOVA_DIFF_MAX_LINES_HARD = 10_000;

/**
 * Build a preview unified-diff between `oldContent` and `newContent`.
 *
 * @param {string|null|undefined} oldContent Previous file contents. `null`
 *     or `undefined` means "no prior file" (new-file create) and emits a
 *     `--- /dev/null` from-header. An empty string is treated as an
 *     existing empty file being modified (still `--- a/<path>`) — callers
 *     that want the create semantics for an empty old must pass `null`
 *     or set `isNewFile: true` explicitly.
 * @param {string} newContent Proposed new file contents.
 * @param {{ path?: string, maxLines?: number, isNewFile?: boolean }} [opts]
 *     `isNewFile` overrides auto-detection for callers that know the prior
 *     file state (e.g. `fs_stat` returned ENOENT).
 * @returns {string} Empty string when contents are identical; otherwise a
 *     multi-line unified-diff-style preview. For inputs that exceed the
 *     DP-cell budget, returns a short "diff too large" sentinel with
 *     headers so the approval modal still shows path context.
 */
function buildNovaUnifiedDiff(oldContent, newContent, { path = '', maxLines = NOVA_DIFF_MAX_LINES_DEFAULT, isNewFile: isNewFileOpt } = {}) {
    const safePath = String(path || 'file').replace(/[\r\n]/g, ' ');
    const newStr = String(newContent ?? '');
    // Auto-detect "new file" from nullish old only. An existing empty file
    // (oldContent === '') is a modify, not a create. Explicit `isNewFile`
    // option wins when provided.
    const isNewFile = typeof isNewFileOpt === 'boolean'
        ? isNewFileOpt
        : (oldContent === null || oldContent === undefined);
    const oldStr = isNewFile && (oldContent === null || oldContent === undefined)
        ? ''
        : String(oldContent ?? '');

    if (oldStr === newStr) return '';

    const oldLines = oldStr === '' ? [] : oldStr.split('\n');
    const newLines = newStr.split('\n');
    const m = oldLines.length, n = newLines.length;

    const fromHeader = isNewFile ? '--- /dev/null' : `--- a/${safePath}`;
    const toHeader = `+++ b/${safePath}`;

    // Size guard (plan §4c follow-up). Returns a bounded sentinel instead of
    // attempting the O(m·n) LCS pass on inputs that would tie up the UI
    // thread or exhaust memory. The approval modal still gets path context
    // so the user can reject the write rather than seeing an empty preview.
    if (m > NOVA_DIFF_MAX_LINES_HARD || n > NOVA_DIFF_MAX_LINES_HARD || m * n > NOVA_DIFF_MAX_DP_CELLS) {
        return [
            fromHeader,
            toHeader,
            `… diff too large to preview (old=${m} line${m === 1 ? '' : 's'}, new=${n} line${n === 1 ? '' : 's'}) …`,
        ].join('\n');
    }

    // LCS table on lines — O(m*n) memory, bounded by the guard above.
    const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
            dp[i][j] = oldLines[i] === newLines[j]
                ? dp[i + 1][j + 1] + 1
                : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }

    const body = [];
    let i = 0, j = 0;
    while (i < m && j < n) {
        if (oldLines[i] === newLines[j]) { body.push(' ' + oldLines[i]); i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) { body.push('-' + oldLines[i]); i++; }
        else { body.push('+' + newLines[j]); j++; }
    }
    while (i < m) body.push('-' + oldLines[i++]);
    while (j < n) body.push('+' + newLines[j++]);

    const cap = Math.max(1, Number.isFinite(maxLines) ? Math.floor(maxLines) : NOVA_DIFF_MAX_LINES_DEFAULT);
    let bodyOut;
    if (body.length > cap) {
        const hidden = body.length - cap;
        bodyOut = body.slice(0, cap);
        bodyOut.push(`… diff truncated (${hidden} more line${hidden === 1 ? '' : 's'}) …`);
    } else {
        bodyOut = body;
    }

    return [fromHeader, toHeader, ...bodyOut].join('\n');
}

/* ----------------------------------------------------------------------
   NOVA AGENT — fs_write approval diff preview composer (plan §4c).

   Pure, testable glue between the three existing pieces:
     1. `fs_read` handler (from `buildNovaFsHandlers`)
     2. `buildNovaUnifiedDiff` (LCS line-diff)
     3. `cxNovaApprovalModal({ diffText })`

   Called from `novaHandleSend`'s `confirmApproval` composer *before*
   the modal opens, so the user sees a diff preview of what the LLM is
   about to write before clicking the red button.

   Contract:
     - Returns `Promise<string>`. Empty string means "no preview" — the
       modal still shows tool name + args JSON, just without the diff.
     - NEVER throws. An `fs_read` that explodes, a bogus tool name, a
       missing arg — all short-circuit to `''`.
     - Fires only for `fs_write`. Every other tool short-circuits with
       an empty string.

   Deliberately at composer-level (not dispatcher-level) per AGENT_MEMORY
   policy: the dispatcher must stay a pure handler-loop and not reach
   back into the filesystem to render UI chrome. The composer owns the
   approval UX, so it owns this call too.

   Inputs (all optional but required for a non-empty return):
     - `tool`      : the tool-registry entry whose approval is pending.
     - `args`      : raw args the LLM sent (`{ path, content, ... }`).
     - `fsRead`    : the `fs_read` handler from `buildNovaFsHandlers`.
     - `buildDiff` : defaults to `buildNovaUnifiedDiff` in production.
   ---------------------------------------------------------------------- */

async function buildFsWriteDiffPreview(opts) {
    const { tool, args, fsRead, buildDiff } = (opts && typeof opts === 'object') ? opts : {};
    if (!tool || tool.name !== 'fs_write') return '';
    const a = (args && typeof args === 'object') ? args : {};
    if (typeof a.path !== 'string' || !a.path) return '';
    if (typeof a.content !== 'string') return '';
    const diffFn = typeof buildDiff === 'function'
        ? buildDiff
        : (typeof buildNovaUnifiedDiff === 'function' ? buildNovaUnifiedDiff : null);
    if (!diffFn) return '';
    const readFn = typeof fsRead === 'function' ? fsRead : null;

    // Fetch the current file. We ONLY request path — no encoding/maxBytes
    // overrides — so the server gives us its default utf8 read with the
    // standard 1 MiB cap. If the file is larger, `truncated: true` comes
    // back and the diff will include a best-effort preview up to that cap.
    let oldContent = null; // null → treat as new file in buildNovaUnifiedDiff
    if (readFn) {
        let readRes;
        try {
            readRes = await readFn({ path: a.path });
        } catch (_) {
            return ''; // fs_read threw → no diff, modal still shows args
        }
        if (readRes && typeof readRes === 'object') {
            // "Not-found" is semantic: the plugin returns `error: 'not-found'`
            // + 404 status. That's a create, not a failure — leave oldContent
            // null so buildNovaUnifiedDiff renders the `--- /dev/null` header.
            if (readRes.error === 'not-found') {
                oldContent = null;
            } else if (typeof readRes.error === 'string') {
                // Any OTHER error (bridge-unreachable, server-error, deny-list,
                // content-too-large, etc.) → skip the diff. Modal still opens.
                return '';
            } else if (typeof readRes.content === 'string') {
                oldContent = readRes.content;
            } else {
                // Unexpected shape → skip diff rather than render garbage.
                return '';
            }
        } else {
            return '';
        }
    }
    // Defensive: diffFn is the only thing left that could throw. The
    // production implementation is pure, but an injected test double
    // might not be.
    try {
        return String(diffFn(oldContent, a.content, { path: a.path }) || '');
    } catch (_) {
        return '';
    }
}

/* ----------------------------------------------------------------------
   NOVA AGENT — legacy OpenClaw metadata migration (plan §1f / §10).

   One-shot, idempotent mutator. The OpenClaw app was removed in Phase 1,
   but users who ran earlier versions still have
   `ctx.chatMetadata[EXT].openclaw` blobs (where `EXT === "command-x"`, the
   module-level namespace constant — see index.js:21) in their per-chat
   metadata.
   The plan requires we move them to `.legacy_openclaw` (preserving the
   data for forensics / user recovery) and never read them again. The
   settings-side migration (`settings.openclawMode`) is already handled by
   `LEGACY_KEYS` inside `loadSettings()` — this helper only touches
   `chatMetadata`.

   Idempotency contract:
   - No legacy key present → noop.
   - Legacy key present, target empty → move.
   - Legacy key present, target also present (prior session already moved) →
     drop the raw legacy key, do not overwrite the preserved copy.
   - `chatMetadata[EXT]` missing or non-object → noop.
   ---------------------------------------------------------------------- */

/**
 * Migrate `ctx.chatMetadata[EXT].openclaw` → `.legacy_openclaw`.
 * Returns a small diagnostic object so init / tests can assert behaviour.
 * Persists metadata via `ctx.saveMetadataDebounced()` only when something
 * actually changed.
 */
function migrateLegacyOpenClawMetadata(ctx) {
    const root = ctx?.chatMetadata?.[EXT];
    if (!root || typeof root !== 'object') {
        return { migrated: false, reason: 'no-metadata' };
    }
    if (!('openclaw' in root)) {
        return { migrated: false, reason: 'no-legacy-key' };
    }
    if ('legacy_openclaw' in root) {
        // Prior session already preserved the blob. Drop the raw legacy key
        // so we don't pay the migration check on every future chat load.
        delete root.openclaw;
        if (ctx?.saveMetadataDebounced) ctx.saveMetadataDebounced();
        return { migrated: false, reason: 'already-migrated' };
    }
    root.legacy_openclaw = root.openclaw;
    delete root.openclaw;
    if (ctx?.saveMetadataDebounced) ctx.saveMetadataDebounced();
    return { migrated: true, reason: 'moved' };
}

/* ----------------------------------------------------------------------
   NOVA AGENT — one-shot per-chat init (plan §1f).

   `initNovaOnce(ctx)` is the single entry point wired from the Nova
   `CHAT_CHANGED` listener (and called once at extension startup for the
   initial chat that loaded before the listener was attached). It is
   idempotent by design: the second call on the same chat is a cheap
   constant-time check that returns `{ ran: false, reason: 'already-initialised' }`.

   Gating: a `chatMetadata[EXT].nova._initVersion` stamp. If it already
   equals (or exceeds) the current `NOVA_INIT_VERSION`, we short-circuit
   so pre-Nova chats only pay the migration cost the first time they load
   after upgrading. Bump `NOVA_INIT_VERSION` whenever a new one-shot
   migration step is added to this function — existing chats will then
   re-run `initNovaOnce` exactly once to pick up the new step.

   Ordering: metadata migrations run BEFORE the stamp is written. If any
   migration throws, we do not stamp — the next chat load will retry.
   Callers should never `throw` from this function; it catches internally
   and surfaces a `reason` instead so a misbehaving migration cannot break
   the chat-switch handler.
   ---------------------------------------------------------------------- */

const NOVA_INIT_VERSION = 1;

/**
 * Run all one-shot per-chat Nova migrations exactly once, guarded by a
 * version stamp persisted in chat metadata. Safe to call on every
 * `CHAT_CHANGED`; the second call is a cheap noop.
 */
function initNovaOnce(ctx) {
    const root = ctx?.chatMetadata?.[EXT];
    if (!root || typeof root !== 'object') {
        return { ran: false, reason: 'no-metadata' };
    }
    // `getNovaState` lazily creates `.nova` and heals malformed blobs.
    // Using it here means the init-version stamp always lives on a well-
    // formed nova blob, so downstream code can rely on the documented
    // shape.
    const state = getNovaState(ctx);
    const stampedVersion = Number(state?._initVersion) || 0;
    if (stampedVersion >= NOVA_INIT_VERSION) {
        return { ran: false, reason: 'already-initialised', version: stampedVersion };
    }

    let migration;
    try {
        migration = migrateLegacyOpenClawMetadata(ctx);
    } catch (err) {
        // Do not stamp on failure — the next chat load will retry.
        try { console.warn('[command-x] initNovaOnce: migration failed', err); } catch (_) { /* noop */ }
        return { ran: false, reason: 'migration-error', error: String(err?.message || err) };
    }

    state._initVersion = NOVA_INIT_VERSION;
    if (ctx?.saveMetadataDebounced) ctx.saveMetadataDebounced();
    return { ran: true, reason: 'initialised', version: NOVA_INIT_VERSION, migration };
}

/* ----------------------------------------------------------------------
   NOVA AGENT — turn lifecycle (plan §3b).

   `sendNovaTurn` is the core agent loop. It is written as a fully
   dependency-injected helper so `test/nova-turn.test.mjs` can exercise
   it without an ST runtime — all I/O (slash commands, LLM calls, now(),
   signal factories) arrives via the `deps` parameter. UI wiring (the
   phone composer → this function) lands in Phase 3c together with the
   tool-dispatch loop and streaming; this slice ships the skeleton that
   locks in the subtlest contract: profile snapshot + swap + restore
   in a `try…finally` that survives errors and aborts.

   Eight-step contract (see plan §3b). This slice implements 1, 2, 3, 4,
   5, 7 (wall-clock cap), 8. Step 6 (tool_calls loop) and streaming are
   stubs — if the LLM returns `tool_calls`, we append the assistant
   content (if any), audit-log `tool-calls-deferred`, and hand the
   unresolved calls back to the caller. Phase 3c replaces that stub with
   real dispatch.

   Re-entrancy: guarded by `novaTurnInFlight`. Second concurrent call
   returns `{ ok: false, reason: 'in-flight' }` without touching state.
   Abort: `novaAbortController` holds the controller whose `.signal` is
   forwarded to the LLM call. Phase 3c's Cancel button calls `.abort()`.

   Never throws. Errors become `{ ok: false, reason, error }`. The
   `finally` block always restores the pre-turn profile (if a swap
   occurred) and clears `novaTurnInFlight` / `novaAbortController`.

   Return shape:
     { ok: true, assistantMessage, toolCalls?, toolCallsDeferred?, swappedProfile }
     { ok: false, reason, error? }
   ---------------------------------------------------------------------- */

const NOVA_DEFAULT_MAX_TOOL_CALLS = 24;
const NOVA_DEFAULT_TURN_TIMEOUT_MS = 300_000; // 5 min wall clock

// The base system prompt + tool-use contract sit here rather than in NOVA_SKILLS
// so every skill inherits them. Phase 3c may expand the tool contract once the
// dispatcher shape is finalised.
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

/**
 * Resolve the active skill definition by id. Falls back to `freeform`.
 * Pure helper — no side effects.
 */
function resolveNovaSkill(skillId, skills = NOVA_SKILLS) {
    const id = String(skillId || 'freeform');
    return skills.find(s => s.id === id) || skills.find(s => s.id === 'freeform') || null;
}

/**
 * Build the `messages` array fed to `sendRequest`. Pure: caller owns
 * composing soul/memory/base/skill prompts before calling.
 */
function buildNovaRequestMessages({ systemPrompt, sessionMessages = [] }) {
    const out = [];
    if (systemPrompt) out.push({ role: 'system', content: String(systemPrompt) });
    for (const m of sessionMessages) {
        if (!m || typeof m !== 'object') continue;
        const role = String(m.role || '');
        if (!role) continue;

        // Persisted Nova sessions include assistant tool-call frames and
        // role:'tool' results so the transcript/audit can show exactly what
        // happened. Those frames are only valid inside the original provider
        // round-trip: replaying an old tool result in a later turn without its
        // exact preceding assistant tool_calls makes OpenAI reject the request.
        // New turns keep conversational user/assistant text only; live dispatch
        // still appends tool_calls/tool results to the in-flight `messages`
        // array before the follow-up LLM call.
        if (role === 'tool') continue;
        if (role === 'assistant' && Array.isArray(m.tool_calls) && !String(m.content ?? '').trim()) continue;

        out.push({ role, content: String(m.content ?? '') });
    }
    return out;
}

/* ----------------------------------------------------------------------
   NOVA AGENT — tool-dispatch loop (plan §3c, §3d, §4c wiring).

   Pure async helper called by `sendNovaTurn` when the LLM returns
   `tool_calls`. It owns the "assistant → tool results → re-call LLM"
   loop until one of:

     - the LLM returns an assistant message with no `tool_calls`   (normal finish)
     - `maxToolCalls` has been reached                              (cap-hit)
     - the abort signal fires                                       (aborted)

   For each tool_call it runs, in order:

     1. Resolve the tool in `toolRegistry` by name. Missing name is a
        deny with reason `unknown-tool`. The loop still appends a
        `role:'tool'` message with `{ error: 'unknown-tool' }` so the
        LLM can recover.
     2. Parse `function.arguments` as JSON. Malformed JSON is a deny
        with reason `malformed-arguments`.
     3. Call the injected `gate` (default: `novaToolGate`) with the
        tool's permission + current tier + rememberedApprovals. On
        `allowed:false`, deny with the gate's `reason`. On
        `requiresApproval:true`, call `confirmApproval`; a falsy
        return denies with reason `user-rejected`.
     4. Call `handlers[name](args, { signal })`. Any thrown value is
        caught and becomes a `role:'tool'` message with
        `{ error: <message> }`.
     5. Append a `role:'tool'` message with the stringified result and
        the original `tool_call_id`. Increment the executed-call
        counter.

   Between batches, the helper calls `sendRequest({ messages, tools,
   tool_choice, signal })` with the *accumulated* messages (including
   every tool result just appended). The returned assistant message
   is pushed to the working `messages` array AND to the `events`
   output; if it carries a new `tool_calls` array, the loop iterates.

   The helper MUTATES the `messages` array it is given — this is the
   contract `sendNovaTurn` relies on to build a coherent session
   transcript. If you want a read-only view, clone before calling.

   Never throws. All failure modes resolve to one of:
     { ok: true, rounds, toolsExecuted, toolsDenied, toolsFailed,       capHit, aborted, finalAssistant }
     { ok: false, reason, error? }

   Where `reason` ∈ 'send-failed' | 'aborted'. (Cap-hit and gate-deny
   are NOT `ok:false` — they finish the dispatch normally with the
   flags set, because the transcript is still valid and the user
   should still see the partial result.)
   ---------------------------------------------------------------------- */

function _stringifyNovaToolResult(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch (_) { return String(value); }
}

async function runNovaToolDispatch({
    initialResponse,           // { content, tool_calls } from the first LLM call
    messages,                  // mutable array — dispatcher appends assistant + tool results
    toolRegistry = NOVA_TOOLS,
    handlers = {},
    tier = 'read',
    rememberedApprovals = null,
    maxToolCalls = NOVA_DEFAULT_MAX_TOOL_CALLS,
    confirmApproval,           // async ({ tool, args, permission, toolCallId }) => boolean
    sendRequest,               // re-used for follow-up turns
    tools = [],                // tool schemas forwarded to follow-up sendRequest calls
    signal,                    // AbortSignal; checked between rounds
    gate = novaToolGate,       // DI seam for tests
    nowImpl = Date.now,
    onAudit,                   // (entry:{tool, argsSummary, outcome}) => void — fires per tool_call
} = {}) {
    if (typeof sendRequest !== 'function') {
        return { ok: false, reason: 'no-send-request' };
    }

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

    // The outer loop: one iteration per LLM round. We start by treating
    // `initialResponse` as "round 0's response" — we didn't call the LLM
    // here, the caller did, so we don't count it toward `rounds`.
    // eslint-disable-next-line no-constant-condition
    while (true) {
        if (signal && signal.aborted) {
            return { ok: false, reason: 'aborted' };
        }

        const assistantContent = String(response?.content ?? '');
        const toolCalls = Array.isArray(response?.tool_calls) ? response.tool_calls : [];
        const assistantMsg = {
            role: 'assistant',
            content: assistantContent,
            ts: nowImpl(),
        };
        if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
        messages.push(assistantMsg);
        events.push(assistantMsg);
        finalAssistant = assistantMsg;

        // No tool_calls → LLM is done, we're done.
        if (toolCalls.length === 0) break;

        // Dispatch this round's tool calls in order. Each appends a
        // `role:'tool'` message to `messages`.
        for (const call of toolCalls) {
            if (signal && signal.aborted) {
                return { ok: false, reason: 'aborted' };
            }
            if (toolsExecuted >= maxToolCalls) {
                capHit = true;
                audit('dispatch', `executed=${toolsExecuted} cap=${maxToolCalls}`, 'cap-hit');
                break;
            }

            const callId = String(call?.id ?? '');
            const fn = call?.function || {};
            const name = String(fn.name || '');
            const rawArgs = fn.arguments;

            // 1. Tool lookup.
            const tool = toolRegistry.find(t => t && t.name === name);
            if (!tool) {
                toolsDenied++;
                audit(name || '(unnamed)', '', 'denied:unknown-tool');
                const toolMsg = {
                    role: 'tool', tool_call_id: callId, name,
                    content: JSON.stringify({ error: 'unknown-tool' }),
                    ts: nowImpl(),
                };
                messages.push(toolMsg);
                events.push(toolMsg);
                continue;
            }

            // 2. Parse arguments JSON. Empty string / nullish → {}.
            let args;
            if (rawArgs == null || rawArgs === '') {
                args = {};
            } else if (typeof rawArgs === 'object') {
                args = rawArgs;
            } else {
                try {
                    args = JSON.parse(String(rawArgs));
                } catch (_) {
                    toolsDenied++;
                    audit(name, 'raw-args=<unparsable>', 'denied:malformed-arguments');
                    const toolMsg = {
                        role: 'tool', tool_call_id: callId, name,
                        content: JSON.stringify({ error: 'malformed-arguments' }),
                        ts: nowImpl(),
                    };
                    messages.push(toolMsg);
                    events.push(toolMsg);
                    continue;
                }
            }

            // 3. Gate.
            const gateResult = gate({
                permission: tool.permission,
                tier,
                toolName: name,
                rememberedApprovals,
            });
            if (!gateResult.allowed) {
                toolsDenied++;
                audit(name, `tier=${tier}`, `denied:${gateResult.reason}`);
                const toolMsg = {
                    role: 'tool', tool_call_id: callId, name,
                    content: JSON.stringify({ error: 'denied', reason: gateResult.reason }),
                    ts: nowImpl(),
                };
                messages.push(toolMsg);
                events.push(toolMsg);
                continue;
            }

            // 4. Approval (when required).
            if (gateResult.requiresApproval) {
                if (typeof confirmApproval !== 'function') {
                    // No confirmer wired → treat as rejection, never as silent approval.
                    toolsDenied++;
                    audit(name, `tier=${tier}`, 'denied:no-confirmer');
                    const toolMsg = {
                        role: 'tool', tool_call_id: callId, name,
                        content: JSON.stringify({ error: 'denied', reason: 'no-confirmer' }),
                        ts: nowImpl(),
                    };
                    messages.push(toolMsg);
                    events.push(toolMsg);
                    continue;
                }
                let approved;
                try {
                    approved = await confirmApproval({
                        tool,
                        args,
                        permission: tool.permission,
                        toolCallId: callId,
                    });
                } catch (err) {
                    // Confirmer crashed → treat as rejection, surface in audit.
                    toolsDenied++;
                    audit(name, `tier=${tier}`, `denied:confirmer-error:${String(err?.message || err)}`);
                    const toolMsg = {
                        role: 'tool', tool_call_id: callId, name,
                        content: JSON.stringify({ error: 'denied', reason: 'confirmer-error' }),
                        ts: nowImpl(),
                    };
                    messages.push(toolMsg);
                    events.push(toolMsg);
                    continue;
                }
                if (!approved) {
                    toolsDenied++;
                    audit(name, `tier=${tier}`, 'denied:user-rejected');
                    const toolMsg = {
                        role: 'tool', tool_call_id: callId, name,
                        content: JSON.stringify({ error: 'denied', reason: 'user-rejected' }),
                        ts: nowImpl(),
                    };
                    messages.push(toolMsg);
                    events.push(toolMsg);
                    continue;
                }
            }

            // 5. Run handler.
            const handler = handlers[name];
            if (typeof handler !== 'function') {
                toolsFailed++;
                audit(name, '', 'error:no-handler');
                const toolMsg = {
                    role: 'tool', tool_call_id: callId, name,
                    content: JSON.stringify({ error: 'no-handler' }),
                    ts: nowImpl(),
                };
                messages.push(toolMsg);
                events.push(toolMsg);
                continue;
            }
            let result;
            try {
                result = await handler(args, { signal });
            } catch (err) {
                toolsFailed++;
                audit(name, `tier=${tier}`, `error:${String(err?.message || err)}`);
                const toolMsg = {
                    role: 'tool', tool_call_id: callId, name,
                    content: JSON.stringify({ error: String(err?.message || err) }),
                    ts: nowImpl(),
                };
                messages.push(toolMsg);
                events.push(toolMsg);
                continue;
            }

            toolsExecuted++;
            audit(name, `tier=${tier}`, 'ok');
            const toolMsg = {
                role: 'tool', tool_call_id: callId, name,
                content: _stringifyNovaToolResult(result),
                ts: nowImpl(),
            };
            messages.push(toolMsg);
            events.push(toolMsg);
        }

        if (capHit) break;
        if (signal && signal.aborted) {
            return { ok: false, reason: 'aborted' };
        }

        // Re-call the LLM with the accumulated messages.
        rounds++;
        try {
            response = await sendRequest({
                messages,
                tools,
                tool_choice: 'auto',
                signal,
            });
        } catch (err) {
            const aborted = (signal && signal.aborted) || err?.name === 'AbortError';
            audit('send-request', `round=${rounds}`, aborted ? 'aborted' : `send-failed:${String(err?.message || err)}`);
            return { ok: false, reason: aborted ? 'aborted' : 'send-failed', error: String(err?.message || err) };
        }
    }

    return {
        ok: true,
        rounds,
        toolsExecuted,
        toolsDenied,
        toolsFailed,
        capHit,
        aborted: false,
        finalAssistant,
        events,
    };
}

/* ----------------------------------------------------------------------
   NOVA AGENT — approval modal (plan §2c, §4c wiring).

   `buildNovaApprovalModalBody` is the PURE HTML builder used by the
   DOM wrapper `cxNovaApprovalModal`. Split so tests can assert escape
   behaviour without spinning up JSDOM.

   The modal body has three zones:
     - intent line: "Nova wants to <permission> <toolName>"
     - args block : pretty-printed JSON of the parsed arguments
     - diff block : unified diff string from `buildNovaUnifiedDiff`
                    (only for fs_write / file mutations; empty string
                    elsewhere)

   Every user-controlled string (tool name, args, diff) is escaped
   via `escHtml`. The modal shell is added by the DOM wrapper so this
   helper stays unit-testable.
   ---------------------------------------------------------------------- */

function _novaJsonPretty(value) {
    try { return JSON.stringify(value, null, 2); } catch (_) { return String(value); }
}

/**
 * Classify an audit-log `outcome` string into a severity bucket. Used by
 * the audit viewer (plan §2b/§7b) to colour rows. Matches the closed-enum
 * outcomes emitted by `runNovaToolDispatch`:
 *   - 'ok'                              → 'ok'
 *   - 'cap-hit'                         → 'warn'
 *   - 'aborted', anything starting with 'denied:'  → 'warn'
 *   - anything starting with 'error:'   → 'error'
 *   - everything else                   → 'info'
 *
 * Pure helper, exported for the unit tests in nova-audit-viewer.test.mjs.
 */
function classifyNovaAuditOutcome(outcome) {
    let s;
    try { s = String(outcome ?? '').trim(); } catch (_) { return 'info'; }
    if (!s) return 'info';
    if (s === 'ok') return 'ok';
    if (s === 'cap-hit') return 'warn';
    if (s === 'aborted') return 'warn';
    if (s.startsWith('denied:')) return 'warn';
    if (s.startsWith('error:')) return 'error';
    return 'info';
}

/**
 * Format an audit-log timestamp (ms-since-epoch) as a short HH:MM:SS string
 * in the local timezone. Falls back to the raw number on bad input. Pure.
 */
function _novaFormatAuditTimestamp(ts, { nowImpl } = {}) {
    const n = Number(ts);
    if (!Number.isFinite(n)) return String(ts ?? '');
    try {
        const d = new Date(n);
        const pad = (v) => String(v).padStart(2, '0');
        const hh = pad(d.getHours());
        const mm = pad(d.getMinutes());
        const ss = pad(d.getSeconds());
        const now = (typeof nowImpl === 'function' ? nowImpl() : Date.now());
        const today = new Date(now);
        const sameDay = d.getFullYear() === today.getFullYear()
            && d.getMonth() === today.getMonth()
            && d.getDate() === today.getDate();
        if (sameDay) return `${hh}:${mm}:${ss}`;
        // Older entries: prefix month/day so the user can tell sessions apart.
        return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${hh}:${mm}:${ss}`;
    } catch (_) {
        return String(ts);
    }
}

/**
 * Build the HTML body for the Nova audit-log modal (plan §2b/§7b). PURE.
 *
 * Renders the entries newest-first, capped at `limit` rows. Each row is
 * a `.cx-nova-audit-row` with severity class derived from the outcome.
 * Empty state shows a "No tool calls yet" placeholder.
 *
 * Every user-controlled string (tool name, argsSummary, outcome) is
 * escaped via `escHtml` — `state.auditLog` entries originate from
 * dispatcher / handler output and may contain anything the LLM hands in
 * via `args`. Treat them as untrusted.
 *
 * @param {Array<{ts:number, tool:string, argsSummary:string, outcome:string}>} entries
 * @param {{ now?: number, limit?: number }} [opts]
 * @returns {string} HTML body.
 */
function buildNovaAuditLogModalBody(entries, { now, limit = 200 } = {}) {
    const list = Array.isArray(entries) ? entries.slice() : [];
    const total = list.length;
    // Newest-first: dispatcher pushes in chronological order.
    list.reverse();
    // Sanitise limit: positive integer in [1, 500]. Anything else (0,
    // negative, NaN, non-number) falls back to the 200 default rather
    // than collapsing to 1, which would surprise callers that pass a
    // misconfigured override.
    let lim = Number(limit);
    if (!Number.isFinite(lim) || lim <= 0) lim = 200;
    const cap = Math.max(1, Math.min(Math.floor(lim), 500));
    const shown = list.slice(0, cap);
    const truncated = total > shown.length;
    const nowImpl = Number.isFinite(now) ? () => now : undefined;

    const header = `<div class="cx-nova-audit-summary">${
        total === 0
            ? 'No tool calls recorded yet for this chat.'
            : `Showing ${shown.length} of ${total} tool call${total === 1 ? '' : 's'} (newest first).`
    }</div>`;

    if (total === 0) {
        return [
            header,
            `<div class="cx-nova-audit-empty">When Nova dispatches a tool, an entry lands here with the outcome — including denials and errors. The log is capped at 500 entries per chat.</div>`,
        ].join('\n');
    }

    const rows = shown.map((raw) => {
        const e = raw && typeof raw === 'object' ? raw : {};
        const sev = classifyNovaAuditOutcome(e.outcome);
        const ts = _novaFormatAuditTimestamp(e.ts, { nowImpl });
        const tool = String(e.tool || 'unknown');
        const args = String(e.argsSummary ?? '');
        const outcome = String(e.outcome ?? '');
        return `<div class="cx-nova-audit-row" data-sev="${escAttr(sev)}">`
            + `<div class="cx-nova-audit-row-head">`
            + `<span class="cx-nova-audit-ts">${escHtml(ts)}</span>`
            + `<span class="cx-nova-audit-tool">${escHtml(tool)}</span>`
            + `<span class="cx-nova-audit-outcome">${escHtml(outcome)}</span>`
            + `</div>`
            + (args ? `<div class="cx-nova-audit-args">${escHtml(args)}</div>` : '')
            + `</div>`;
    }).join('\n');

    const footer = truncated
        ? `<div class="cx-nova-audit-truncated">…${total - shown.length} older entries hidden.</div>`
        : '';

    return [header, `<div class="cx-nova-audit-list">${rows}</div>`, footer].filter(Boolean).join('\n');
}

function buildNovaApprovalModalBody({ tool, args, diffText = '', permission } = {}) {
    const displayName = (tool && (tool.displayName || tool.name)) || 'tool';
    const perm = String(permission || tool?.permission || 'read');
    const permLabel = perm === 'shell' ? 'run shell command' : (perm === 'write' ? 'write' : 'read');
    const argsJson = _novaJsonPretty(args ?? {});
    const parts = [
        `<div class="cx-nova-approval-intent">Nova wants to <strong>${escHtml(permLabel)}</strong>: <code>${escHtml(displayName)}</code></div>`,
        `<div class="cx-nova-approval-label">Arguments</div>`,
        `<pre class="cx-nova-approval-args">${escHtml(argsJson)}</pre>`,
    ];
    if (diffText && String(diffText).trim()) {
        parts.push(`<div class="cx-nova-approval-label">Preview</div>`);
        parts.push(`<pre class="cx-nova-approval-diff">${escHtml(String(diffText))}</pre>`);
    }
    return parts.join('\n');
}

/**
 * In-phone approval modal for a Nova tool call. Mirrors `cxConfirm`'s
 * DOM shape but (a) renders an HTML body (args + diff), and (b) uses
 * the `danger` styling for write/shell permissions so the user has
 * to intentionally click the red button. Returns Promise<boolean>.
 *
 * Pure presentation — all gate decisions happen upstream in the
 * dispatcher. By the time this fires, the tool is already
 * tier-allowed and approval is required.
 */
function cxNovaApprovalModal({ tool, args, diffText = '', permission, title = 'Approve tool call?' } = {}) {
    return new Promise((resolve) => {
        const perm = String(permission || tool?.permission || 'read');
        const danger = perm !== 'read';
        const bodyHtml = buildNovaApprovalModalBody({ tool, args, diffText, permission: perm });
        const confirmLabel = perm === 'shell' ? 'Run' : (perm === 'write' ? 'Write' : 'Run');

        const overlay = document.createElement('div');
        overlay.className = 'cx-modal-overlay';
        overlay.innerHTML = `
        <div class="cx-modal-box cx-nova-approval" role="alertdialog" aria-modal="true" aria-labelledby="cx-modal-title" aria-describedby="cx-modal-body">
            <div class="cx-modal-title" id="cx-modal-title">${escHtml(title)}</div>
            <div class="cx-modal-body" id="cx-modal-body">${bodyHtml}</div>
            <div class="cx-modal-actions">
                <button class="cx-modal-btn cx-modal-btn-secondary" id="cx-modal-cancel">Cancel</button>
                <button class="cx-modal-btn ${danger ? 'cx-modal-btn-danger' : 'cx-modal-btn-primary'}" id="cx-modal-confirm">${escHtml(confirmLabel)}</button>
            </div>
        </div>`;
        const close = (result) => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(result); };
        const onKey = (e) => { if (e.key === 'Escape') close(false); };
        overlay.querySelector('#cx-modal-cancel').addEventListener('click', () => close(false));
        overlay.querySelector('#cx-modal-confirm').addEventListener('click', () => close(true));
        document.addEventListener('keydown', onKey);
        document.body.appendChild(overlay);
        // Destructive actions default to Cancel focus to prevent accidental Enter.
        overlay.querySelector(danger ? '#cx-modal-cancel' : '#cx-modal-confirm').focus();
    });
}

/**
 * Extract the current profile name from the pipe returned by `/profile`
 * (no args). ST returns the active profile name in the pipe. Returns
 * `''` when no profile is active or the pipe is empty / non-string.
 */
function parseNovaProfilePipe(pipeValue) {
    if (pipeValue == null) return '';
    const s = String(pipeValue).trim();
    // ST's /profile can return "None" or an empty string when no profile is
    // selected; treat both as "no active profile" so the restore step is a
    // no-op rather than trying to swap to a literal name of "None".
    if (!s || s.toLowerCase() === 'none') return '';
    return s;
}

/**
 * Run `/profile` (no args) through the injected slash executor and return
 * the currently-active profile name (or '' if none). Never throws —
 * failure resolves to '' so the caller can still attempt a swap.
 */
async function getActiveNovaProfile({ executeSlash }) {
    if (typeof executeSlash !== 'function') return '';
    try {
        const res = await executeSlash('/profile');
        return parseNovaProfilePipe(res && res.pipe);
    } catch (_) {
        return '';
    }
}

function quoteNovaSlashArg(value) {
    return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Parse the pipe value returned by `/profile-list` into a de-duplicated
 * array of profile names. ST returns a JSON-serialised array; accept
 * both a stringified array and a whitespace-separated fallback for
 * forward-compat. Never throws — a bad pipe resolves to `[]`.
 */
function parseNovaProfileListPipe(pipeValue) {
    if (pipeValue == null) return [];
    const s = String(pipeValue).trim();
    if (!s) return [];
    // Preferred shape: JSON-serialised array of strings.
    if (s.startsWith('[')) {
        try {
            const arr = JSON.parse(s);
            if (Array.isArray(arr)) {
                return Array.from(new Set(
                    arr.map(x => String(x ?? '').trim()).filter(Boolean),
                ));
            }
        } catch (_) { /* fallthrough to whitespace split */ }
    }
    // Fallback: newline / comma-separated.
    return Array.from(new Set(
        s.split(/[\n,]+/).map(x => x.trim()).filter(Boolean),
    ));
}

/**
 * Fetch the list of connection profiles via `/profile-list`. Returns
 * `{ ok: true, profiles: [...] }` on success, `{ ok: false, reason }`
 * on failure. Never throws.
 */
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

/* ----------------------------------------------------------------------
   NOVA AGENT — profile-swap mutex (plan §9).

   Every concurrent caller of `sendNovaTurn` must serialise around the
   profile slash-command pair (`/profile <target>` … restore). The mutex
   below is a tail-chained Promise — each `withNovaProfileMutex(fn)` call
   awaits the previous tail and replaces it with its own. Failures do
   NOT poison the chain: the tail is always replaced with a resolved
   sentinel in a `finally` so a rejected predecessor can't block future
   callers.

   The helper is pure and test-friendly: pass `mutex: { chain }` to run
   in an isolated mutex instance; omitting it uses the module-level
   chain that production callers share.
   ---------------------------------------------------------------------- */

const _novaProfileSwapMutex = { chain: Promise.resolve() };

async function withNovaProfileMutex(fn, { mutex = _novaProfileSwapMutex } = {}) {
    const prev = mutex.chain;
    let release;
    // Replace the tail BEFORE awaiting the predecessor so a second caller
    // sees a tail that resolves only after WE resolve, not before.
    mutex.chain = new Promise((resolve) => { release = resolve; });
    try {
        await prev.catch(() => {}); // predecessor failure must not poison us
        return await fn();
    } finally {
        release();
    }
}

/**
 * Turn-lifecycle entry point. See header comment for the full contract.
 *
 * @param {object} opts
 * @param {object} opts.ctx                    - SillyTavern context (for saveNovaState / state mutation)
 * @param {string} opts.userText               - User message text (required, non-empty)
 * @param {string} [opts.skillId]              - Skill id to resolve against NOVA_SKILLS. Default 'freeform'.
 * @param {string} [opts.profileName]          - Connection profile to run under. Required for the turn to proceed.
 * @param {string} [opts.soul]                 - soul.md contents (inlined verbatim).
 * @param {string} [opts.memory]               - memory.md contents (tail-truncated by composeNovaSystemPrompt).
 * @param {number} [opts.maxToolCalls]         - Cap on tool calls this turn. Default 24.
 * @param {number} [opts.turnTimeoutMs]        - Wall-clock cap. Default 300_000.
 * @param {Array}  [opts.tools]                - Tool schemas forwarded to `sendRequest`. Default [].
 *
 * Injected deps (all optional where noted):
 * @param {function} opts.sendRequest          - ({messages, tools, tool_choice, signal}) => Promise<{content?, tool_calls?}>
 * @param {function} [opts.executeSlash]       - (cmd:string) => Promise<{pipe?:string}> — for /profile snapshot/restore
 * @param {function} [opts.isToolCallingSupported] - () => boolean; when defined and returns false we bail.
 * @param {function} [opts.nowImpl]            - () => number; defaults to Date.now
 */
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
    // Phase 3c dispatch-loop deps (all optional; when absent the turn
    // behaves exactly like the Phase 3b deferred stub so existing tests
    // stay green). Providing `toolHandlers` + `confirmApproval` activates
    // the full loop.
    tier = 'read',
    rememberedApprovals = null,
    toolHandlers = null,
    confirmApproval = null,
} = {}) {
    // --- Step 0: re-entrancy guard ---
    if (novaTurnInFlight) {
        return { ok: false, reason: 'in-flight' };
    }

    // --- Step 1: precondition validation ---
    const text = String(userText ?? '').trim();
    if (!text) return { ok: false, reason: 'empty-text' };
    if (typeof sendRequest !== 'function') {
        return { ok: false, reason: 'no-send-request' };
    }
    if (typeof isToolCallingSupported === 'function' && !isToolCallingSupported()) {
        return { ok: false, reason: 'no-tool-calling' };
    }
    const targetProfile = String(profileName || '').trim();
    if (!targetProfile) return { ok: false, reason: 'no-profile' };

    const skill = resolveNovaSkill(skillId);
    if (!skill) return { ok: false, reason: 'no-skill' };

    // Resolve state + active session up front so "turn in flight" + the
    // audit-log entries always land on the right session even if a later
    // step aborts.
    const state = getNovaState(ctx);
    let session = state.sessions.find(s => s && s.id === state.activeSessionId);
    if (!session) {
        session = createNovaSession(state, {
            skill: skill.id,
            tier: skill.defaultTier || 'read',
            profileName: targetProfile,
        });
    }

    // --- Step 2: push user message, persist ---
    const turnStartedAt = nowImpl();
    session.messages.push({ role: 'user', content: text, ts: turnStartedAt });
    session.updatedAt = turnStartedAt;
    saveNovaState(ctx);

    // --- Set up cancellation + wall-clock timeout ---
    // `novaAbortController` is the canonical handle; Phase 3c's Cancel
    // button reads the module-level binding and calls `.abort()` on it.
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
        // --- Step 3: profile snapshot + swap ---
        if (typeof executeSlash === 'function') {
            swappedFrom = await getActiveNovaProfile({ executeSlash });
            // Skip swap if already on the target profile — avoids a noisy
            // slash round-trip and preserves whatever chat state the user
            // already had active.
            if (swappedFrom !== targetProfile) {
                if (!swappedFrom) {
                    appendNovaAuditLog(state, {
                        tool: 'profile-swap',
                        argsSummary: `to=${targetProfile}`,
                        outcome: 'refused-no-active-profile',
                    });
                    saveNovaState(ctx);
                    return {
                        ok: false,
                        reason: 'no-active-profile',
                        error: 'Nova requires an active restorable connection profile before switching.',
                    };
                }
                try {
                    await executeSlash(`/profile ${quoteNovaSlashArg(targetProfile)}`);
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

        // --- Step 4: build messages ---
        const systemPrompt = composeNovaSystemPrompt({
            basePrompt: NOVA_BASE_PROMPT,
            skillPrompt: skill.systemPrompt || '',
            soul,
            memory,
            toolContract: NOVA_TOOL_CONTRACT,
        });
        const messages = buildNovaRequestMessages({
            systemPrompt,
            sessionMessages: session.messages,
        });

        // --- Step 5: call LLM ---
        let response;
        try {
            response = await sendRequest({
                messages,
                tools: Array.isArray(tools) ? tools : [],
                tool_choice: 'auto',
                signal: controller.signal,
            });
        } catch (err) {
            // Distinguish abort from other failures so the caller (and tests)
            // can render the right UI affordance.
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

        // --- Step 6: tool_calls dispatch (Phase 3c) ---
        const assistantContent = String(response?.content ?? '');
        const toolCalls = Array.isArray(response?.tool_calls) ? response.tool_calls : [];

        // Dispatcher activates when `toolHandlers` is provided. The dispatcher
        // handles the "approval required but no confirmer wired" case
        // internally by denying with reason `no-confirmer` — callers that want
        // Phase 3b's deferred behaviour simply omit `toolHandlers`.
        const dispatchActive = toolCalls.length > 0
            && toolHandlers && typeof toolHandlers === 'object';

        if (dispatchActive) {
            const dispatchResult = await runNovaToolDispatch({
                initialResponse: { content: assistantContent, tool_calls: toolCalls },
                messages,
                toolRegistry: tools,
                handlers: toolHandlers,
                tier,
                rememberedApprovals,
                maxToolCalls,
                confirmApproval,
                sendRequest,
                tools,
                signal: controller.signal,
                nowImpl,
                onAudit: (entry) => {
                    appendNovaAuditLog(state, entry);
                },
            });

            if (!dispatchResult.ok) {
                // Persist any events the dispatcher already emitted before
                // the error so the transcript reflects what really happened.
                // `events` is the append-only list of messages the
                // dispatcher added this turn (assistant rounds + tool
                // results), in order.
                for (const ev of (dispatchResult.events || [])) {
                    session.messages.push(ev);
                }
                session.updatedAt = nowImpl();
                saveNovaState(ctx);
                return {
                    ok: false,
                    reason: dispatchResult.reason,
                    error: dispatchResult.error,
                };
            }

            // Append every event the dispatcher produced to the session.
            for (const ev of dispatchResult.events) {
                session.messages.push(ev);
            }
            session.updatedAt = nowImpl();
            saveNovaState(ctx);

            return {
                ok: true,
                assistantMessage: dispatchResult.finalAssistant,
                toolsExecuted: dispatchResult.toolsExecuted,
                toolsDenied: dispatchResult.toolsDenied,
                toolsFailed: dispatchResult.toolsFailed,
                rounds: dispatchResult.rounds,
                capHit: dispatchResult.capHit,
                swappedProfile: swapPerformed ? { from: swappedFrom, to: targetProfile } : null,
            };
        }

        // --- Fallback: Phase 3b deferred behaviour (no dispatcher wired) ---
        const assistantMessage = {
            role: 'assistant',
            content: assistantContent,
            ts: nowImpl(),
        };
        if (toolCalls.length > 0) {
            // Record the raw call shapes so the caller can replay them.
            assistantMessage.tool_calls = toolCalls;
            appendNovaAuditLog(state, {
                tool: 'tool-calls',
                argsSummary: `count=${toolCalls.length} cap=${maxToolCalls}`,
                outcome: 'deferred-no-dispatcher',
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
        // --- Step 8: always restore profile + clear turn state ---
        if (timeoutHandle !== undefined) {
            try { clearTimeout(timeoutHandle); } catch (_) { /* noop */ }
        }
        // Order matters: restore the profile BEFORE clearing the turn-state
        // flags. A second turn waiting on the re-entrancy guard must not
        // see `inFlight: false` until we're fully back on the user's
        // original profile.
        if (swapPerformed && typeof executeSlash === 'function') {
            // `swappedFrom` may be empty when the user had no active profile
            // before the turn — we can't restore "no profile" via a slash
            // (ST has no `/profile` clear syntax), so we simply leave
            // Nova's profile active. The user's next non-Nova turn picks
            // up whatever profile their workflow selects.
            try {
                if (swappedFrom) {
                    await executeSlash(`/profile ${quoteNovaSlashArg(swappedFrom)}`);
                }
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

/* ----------------------------------------------------------------------
   NOVA AGENT — tool registry (plan §4) + skills (plan §5).

   These arrays are PURE DATA — no handlers, no skill dispatch, no
   registration with ST yet. Phase 3c wires `handler` and formatApproval;
   Phase 9 backs `fs_*` / `shell_run` with the server plugin. Shipping the
   schemas + skill prompts now lets Phase 3 pick a tool subset by id and
   lets the Phase 10 `nova-tool-args.test.mjs` enforce schema well-formedness
   before any LLM ever sees them.

   Each NOVA_TOOLS entry:
     { name, displayName, description, permission, parameters, backend }
   where:
     - `permission` ∈ 'read' | 'write' | 'shell' (tier gate)
     - `backend`    ∈ 'plugin' | 'st-api' | 'phone' (dispatcher hint)
     - `parameters` is a strict JSON-Schema object with `required` listed

   `NOVA_TOOL_NAMES` is exported as a Set for O(1) membership checks in
   skill default-tool lists.
   ---------------------------------------------------------------------- */

const SKILLS_VERSION = 3; // bump when any skill prompt, defaultTools, or defaultTier changes; v3 expands tool-scoped skills

const NOVA_TOOLS = [
    // === 4a. Filesystem (plugin-backed) ===
    {
        name: 'fs_list', displayName: 'List directory', permission: 'read', backend: 'plugin',
        description: 'List files and folders under a path inside the SillyTavern install directory.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Path relative to ST install root.' },
                recursive: { type: 'boolean', default: false },
                maxDepth: { type: 'integer', minimum: 1, maximum: 10, default: 3 },
            },
            required: ['path'],
            additionalProperties: false,
        },
    },
    {
        name: 'fs_read', displayName: 'Read file', permission: 'read', backend: 'plugin',
        description: 'Read a file inside the SillyTavern install directory.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                encoding: { type: 'string', enum: ['utf8', 'base64'], default: 'utf8' },
                maxBytes: { type: 'integer', minimum: 1, maximum: 10485760, default: 262144 }, // default 256 KB; cap 10 MB (prevents an LLM tool-call from slurping a giant file and blowing past the chat context window).
            },
            required: ['path'],
            additionalProperties: false,
        },
    },
    {
        name: 'fs_write', displayName: 'Write file', permission: 'write', backend: 'plugin',
        description: 'Write or overwrite a file. Destructive; always routes through approval with diff preview.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                content: { type: 'string' },
                encoding: { type: 'string', enum: ['utf8', 'base64'], default: 'utf8' },
                createParents: { type: 'boolean', default: true },
                overwrite: { type: 'boolean', default: false },
            },
            required: ['path', 'content'],
            additionalProperties: false,
        },
    },
    {
        name: 'fs_delete', displayName: 'Delete path', permission: 'write', backend: 'plugin',
        description: 'Move a file or directory to .nova-trash/<ts>/. Destructive; requires approval.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                recursive: { type: 'boolean', default: false },
            },
            required: ['path'],
            additionalProperties: false,
        },
    },
    {
        name: 'fs_move', displayName: 'Move / rename', permission: 'write', backend: 'plugin',
        description: 'Move or rename a file or directory within the ST install root.',
        parameters: {
            type: 'object',
            properties: {
                from: { type: 'string' },
                to: { type: 'string' },
                overwrite: { type: 'boolean', default: false },
            },
            required: ['from', 'to'],
            additionalProperties: false,
        },
    },
    {
        name: 'fs_stat', displayName: 'Stat path', permission: 'read', backend: 'plugin',
        description: 'Return metadata (size, mtime, type) for a file or directory.',
        parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
            additionalProperties: false,
        },
    },
    {
        name: 'fs_search', displayName: 'Search files', permission: 'read', backend: 'plugin',
        description: 'Full-text search inside files under a path, optionally filtered by glob.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string' },
                glob: { type: 'string' },
                path: { type: 'string', default: '.' },
                maxResults: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
            },
            required: ['query'],
            additionalProperties: false,
        },
    },

    // === 4b. Shell (plugin-backed, Full tier only) ===
    {
        name: 'shell_run', displayName: 'Run shell command', permission: 'shell', backend: 'plugin',
        description: 'Execute an allow-listed shell command (node, npm, git, python, grep, rg, ls, cat, head, tail, wc, find). Destructive; requires approval.',
        parameters: {
            type: 'object',
            properties: {
                cmd: { type: 'string' },
                args: { type: 'array', items: { type: 'string' }, default: [] },
                cwd: { type: 'string' },
                timeoutMs: { type: 'integer', minimum: 100, maximum: 300000, default: 60000 },
            },
            required: ['cmd'],
            additionalProperties: false,
        },
    },

    // === 4d. SillyTavern API tools (no plugin required) ===
    {
        name: 'st_list_characters', displayName: 'List characters', permission: 'read', backend: 'st-api',
        description: 'List all character cards available in the current ST user profile.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'st_read_character', displayName: 'Read character', permission: 'read', backend: 'st-api',
        description: 'Read a character card as JSON (spec v2).',
        parameters: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
            additionalProperties: false,
        },
    },
    {
        name: 'st_write_character', displayName: 'Write character', permission: 'write', backend: 'st-api',
        description: 'Create or update a SillyTavern character card. Provide either a complete chara_card_v2 `card` object or the top-level character fields; do not call with only a name. Requires approval.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string' },
                card: {
                    type: 'object',
                    description: 'Complete Tavern card v2 JSON: { spec:"chara_card_v2", spec_version:"2.0", data:{ name, description, personality, scenario, first_mes, mes_example, creator_notes, system_prompt, post_history_instructions, alternate_greetings, tags, creator, character_version, extensions } }.',
                },
                description: { type: 'string', description: 'Character description if not sending card.' },
                personality: { type: 'string', description: 'Personality text if not sending card.' },
                scenario: { type: 'string', description: 'Scenario text if not sending card.' },
                first_mes: { type: 'string', description: 'First message if not sending card.' },
                mes_example: { type: 'string', description: 'Example dialogue if not sending card.' },
                creator_notes: { type: 'string', description: 'Creator notes if not sending card.' },
                system_prompt: { type: 'string', description: 'System prompt if not sending card.' },
                post_history_instructions: { type: 'string', description: 'Post-history instructions if not sending card.' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Tags if not sending card.' },
                creator: { type: 'string', description: 'Creator name if not sending card.' },
                character_version: { type: 'string', description: 'Character version if not sending card.' },
                overwrite: { type: 'boolean', default: false },
            },
            required: ['name'],
            additionalProperties: false,
        },
    },
    {
        name: 'st_list_worldbooks', displayName: 'List worldbooks', permission: 'read', backend: 'st-api',
        description: 'List all world info / lorebook files in the current ST user profile.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'st_read_worldbook', displayName: 'Read worldbook', permission: 'read', backend: 'st-api',
        description: 'Read a worldbook / world info file as JSON.',
        parameters: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
            additionalProperties: false,
        },
    },
    {
        name: 'st_write_worldbook', displayName: 'Write worldbook', permission: 'write', backend: 'st-api',
        description: 'Create or replace an entire worldbook file. Requires name and a full book object with entries; do not use this for a single entry unless you have read and are sending the complete worldbook JSON.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string' },
                book: { type: 'object' },
                overwrite: { type: 'boolean', default: false },
            },
            required: ['name', 'book'],
            additionalProperties: false,
        },
    },
    {
        name: 'st_run_slash', displayName: 'Run slash command', permission: 'write', backend: 'st-api',
        description: 'Execute a SillyTavern slash command via ctx.executeSlashCommandsWithOptions. Requires approval.',
        parameters: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
            additionalProperties: false,
        },
    },
    {
        name: 'st_get_context', displayName: 'Read chat context', permission: 'read', backend: 'st-api',
        description: 'Return a compact snapshot of the current ST chat: character, persona, and last N messages.',
        parameters: {
            type: 'object',
            properties: { lastN: { type: 'integer', minimum: 1, maximum: 50, default: 10 } },
            additionalProperties: false,
        },
    },
    {
        name: 'st_list_profiles', displayName: 'List connection profiles', permission: 'read', backend: 'st-api',
        description: 'List all saved connection profiles.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'st_get_profile', displayName: 'Read connection profile', permission: 'read', backend: 'st-api',
        description: 'Return metadata for a connection profile by name.',
        parameters: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
            additionalProperties: false,
        },
    },

    // === 4e. Phone-internal tools (in-process, no plugin, no network) ===
    {
        name: 'phone_list_npcs', displayName: 'List phone NPCs', permission: 'read', backend: 'phone',
        description: 'List NPCs stored for the current Command-X chat.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'phone_write_npc', displayName: 'Write phone NPC', permission: 'write', backend: 'phone',
        description: 'Create or update a Command-X NPC profile.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string' },
                fields: { type: 'object' },
            },
            required: ['name', 'fields'],
            additionalProperties: false,
        },
    },
    {
        name: 'phone_list_quests', displayName: 'List phone quests', permission: 'read', backend: 'phone',
        description: 'List quests stored for the current Command-X chat.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'phone_write_quest', displayName: 'Write phone quest', permission: 'write', backend: 'phone',
        description: 'Create or update a Command-X quest entry.',
        parameters: {
            type: 'object',
            properties: {
                id: { type: 'string' },
                fields: { type: 'object' },
            },
            required: ['id', 'fields'],
            additionalProperties: false,
        },
    },
    {
        name: 'phone_list_places', displayName: 'List phone places', permission: 'read', backend: 'phone',
        description: 'List registered places for the current Command-X chat.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'phone_write_place', displayName: 'Write phone place', permission: 'write', backend: 'phone',
        description: 'Create or update a registered place.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string' },
                fields: { type: 'object' },
            },
            required: ['name', 'fields'],
            additionalProperties: false,
        },
    },
    {
        name: 'phone_list_messages', displayName: 'List phone messages', permission: 'read', backend: 'phone',
        description: 'List messages for a contact in the current Command-X chat.',
        parameters: {
            type: 'object',
            properties: {
                contactName: { type: 'string' },
                limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            },
            required: ['contactName'],
            additionalProperties: false,
        },
    },
    {
        name: 'phone_inject_message', displayName: 'Inject phone message', permission: 'write', backend: 'phone',
        description: 'Inject a synthetic message into a contact thread (for staged-scene setup).',
        parameters: {
            type: 'object',
            properties: {
                contactName: { type: 'string' },
                from: { type: 'string', enum: ['user', 'contact'] },
                text: { type: 'string' },
            },
            required: ['contactName', 'from', 'text'],
            additionalProperties: false,
        },
    },
    // --- Nova self-edit tools (plan §6b) -----------------------------
    // Soul + memory live under the extension's `nova/` folder. Reads
    // re-use `loadNovaSoulMemory` (force-refresh); writes go through the
    // plugin `fs_write` route under the hood. Every write MUST invalidate
    // the in-memory soul/memory cache so the next turn sees fresh text.
    {
        name: 'nova_read_soul', displayName: 'Read Nova soul', permission: 'read', backend: 'phone',
        description: 'Read Nova\'s soul.md verbatim. Soul is Nova\'s voice/persona and persists across chats.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'nova_write_soul', displayName: 'Write Nova soul', permission: 'write', backend: 'phone',
        description: 'Replace Nova\'s soul.md with the provided content. Use sparingly — this changes Nova\'s voice.',
        parameters: {
            type: 'object',
            properties: {
                content: { type: 'string' },
            },
            required: ['content'],
            additionalProperties: false,
        },
    },
    {
        name: 'nova_read_memory', displayName: 'Read Nova memory', permission: 'read', backend: 'phone',
        description: 'Read Nova\'s memory.md verbatim. Memory is Nova\'s long-term scratchpad across chats.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'nova_append_memory', displayName: 'Append Nova memory', permission: 'write', backend: 'phone',
        description: 'Append a new entry to the end of Nova\'s memory.md. Prefer this over overwrite.',
        parameters: {
            type: 'object',
            properties: {
                entry: { type: 'string' },
            },
            required: ['entry'],
            additionalProperties: false,
        },
    },
    {
        name: 'nova_overwrite_memory', displayName: 'Overwrite Nova memory', permission: 'write', backend: 'phone',
        description: 'Replace Nova\'s memory.md with the provided content. Destructive — prefer nova_append_memory.',
        parameters: {
            type: 'object',
            properties: {
                content: { type: 'string' },
            },
            required: ['content'],
            additionalProperties: false,
        },
    },
];

const NOVA_TOOL_NAMES = new Set(NOVA_TOOLS.map(t => t.name));

/* ----------------------------------------------------------------------
   NOVA SKILLS (plan §5). Each skill is a named system-prompt pack with a
   default tier and default tool subset. `defaultTools === 'all'` means the
   skill inherits whatever the active tier allows.
   ---------------------------------------------------------------------- */

const NOVA_SKILLS = [
    {
        id: 'character-creator',
        label: 'Character Creator',
        icon: '👤',
        description: 'Drafts and updates Tavern Card v2 characters with duplicate checks, complete lore fields, and avatar prompts.',
        defaultTier: 'write',
        allowTierEscalation: true,
        defaultTools: [
            'st_list_characters', 'st_read_character', 'st_write_character',
            'fs_list', 'fs_read', 'fs_stat', 'fs_search', 'fs_write',
        ],
        systemPrompt: [
            'You are the Character Creator skill inside Nova.',
            'Before creating, call st_list_characters and check for duplicate',
            'or near-duplicate names. If updating an existing card, read it',
            'first and preserve useful fields unless the user says otherwise.',
            'You are an expert on the SillyTavern character-card v2 schema:',
            "  spec: 'chara_card_v2', spec_version: '2.0', data: { name, description,",
            '  personality, scenario, first_mes, mes_example, creator_notes,',
            '  system_prompt, post_history_instructions, alternate_greetings,',
            '  character_book, tags, creator, character_version, extensions }.',
            'Use st_write_character for creation and updates; the ST API',
            'handles PNG embedding and chat index updates for you.',
            'When calling st_write_character, include either a complete `card`',
            'object or top-level fields: description, personality, scenario,',
            'first_mes, mes_example, creator_notes, system_prompt,',
            'post_history_instructions, tags, creator, character_version.',
            'Never call st_write_character with only `name`.',
            'Never overwrite an existing card without showing a diff first.',
            'For every new character, include description, personality,',
            'scenario hooks, first_mes, mes_example, creator_notes,',
            'system_prompt or post_history_instructions when useful, tags,',
            'and 2–4 alternate greetings in a complete card object when the',
            'provider can emit nested JSON reliably.',
            'Also include an `extensions.command_x.avatar_prompt` string with',
            'a concise image-generation prompt for the character portrait.',
            'When a user asks you to invent a character, pick opinionated',
            'concrete details; never leave schema fields as "TBD".',
        ].join('\n'),
    },
    {
        id: 'worldbook-creator',
        label: 'Worldbook Creator',
        icon: '📖',
        description: 'Builds and maintains SillyTavern worldbooks with activation keys, depth/order tuning, and safe merge writes.',
        defaultTier: 'write',
        allowTierEscalation: true,
        defaultTools: [
            'st_list_worldbooks', 'st_read_worldbook', 'st_write_worldbook',
            'fs_list', 'fs_read', 'fs_stat', 'fs_search', 'fs_write',
        ],
        systemPrompt: [
            'You are the Worldbook Creator skill inside Nova.',
            'You are an expert on the SillyTavern worldbook (world info) schema:',
            '  an `entries` object keyed by integer uid, each with key[],',
            '  keysecondary[], comment, content, constant, selective,',
            '  selectiveLogic, addMemo, order, position (0..4), disable,',
            '  excludeRecursion, preventRecursion, probability, useProbability,',
            '  depth, group, groupOverride, groupWeight, scanDepth, caseSensitive,',
            '  matchWholeWords, useGroupScoring, automationId, role, vectorized.',
            'Use st_read_worldbook and st_write_worldbook for creation and updates.',
            'st_write_worldbook is a full-worldbook save and must include a complete `book` object.',
            'For a single new entry, read the target book, merge the entry into entries, then call st_write_worldbook with overwrite=true.',
            'For existing books, always use read → merge → validate → write;',
            'never replace unrelated entries or renumber existing uids.',
            'Each entry should have focused activation key[] values, optional',
            'keysecondary[] for disambiguation, concise content sized for the',
            'token budget, and deliberate depth/order/position settings.',
            'Use constant entries for always-on setting facts; use selective',
            'entries for names, places, factions, and lore that should activate',
            'only when keys appear. Validate JSON shape and entries before write.',
            'When building a new world, start with 3–5 foundational entries',
            '(setting, factions, tone) before branching into specifics.',
        ].join('\n'),
    },
    {
        id: 'stscript-regex',
        label: 'STscript & Regex',
        icon: '⚙️',
        description: 'Authors, tests, and packages STscript, Regex extension rules, Macros 2.0 snippets, and Quick Replies.',
        defaultTier: 'write',
        allowTierEscalation: true,
        // Default set is biased toward authoring + testing automation assets.
        // `st_run_slash` is write-tier and approval-gated — it's what lets Nova
        // actually test a one-liner like `/pass foo | /echo` end-to-end.
        // fs_* gives access to settings.json (global regex / quick replies) and
        // character card data.extensions.regex_scripts when st_write_character
        // can't be used.
        defaultTools: [
            'st_run_slash', 'st_get_context',
            'st_list_characters', 'st_read_character', 'st_write_character',
            'st_list_worldbooks', 'st_read_worldbook', 'st_write_worldbook',
            'fs_list', 'fs_read', 'fs_stat', 'fs_search', 'fs_write',
        ],
        systemPrompt: [
            'You are the STscript & Regex skill inside Nova.',
            'You are an expert on three closely related SillyTavern automation',
            'surfaces: STscript (slash-command scripting), the Regex extension,',
            'and the Macros 2.0 template engine.',
            '',
            '## STscript',
            'Scripts are pipelines of slash commands separated by `|`. Each',
            'command writes to the pipe; the next command reads it via the',
            '`{{pipe}}` macro or as its unnamed arg. Closures use `{: ... :}`.',
            'Core commands: `/echo`, `/pass`, `/input`, `/popup`, `/buttons`,',
            '`/setvar key=... value`, `/getvar name`, `/incvar`, `/decvar`,',
            '`/flushvar`, `/setglobalvar`, `/getglobalvar`, `/if left=... right=... rule=...`,',
            '`/while`, `/times`, `/run`, `/abort`, `/let`, `/var`, `/return`.',
            'Comparison rules for `/if`: `eq`, `neq`, `lt`, `gt`, `lte`, `gte`,',
            '`in`, `nin`. Arrays and objects are JSON-encoded in variables;',
            'use `index=` on `/getvar` / `/setvar` for field access, `/len` for',
            'length. Scripts can be saved as Quick Replies for one-click use.',
            'Safety: always dry-run with `/echo` before destructive commands;',
            'use `/abort` to bail early on invalid input.',
            'When packaging a reusable script, provide the Quick Reply name,',
            'button label, script body, expected input, and expected output.',
            '',
            '## Regex extension',
            'Two scopes: `Global` scripts live in `settings.json` (apply to all',
            'characters); `Scoped` scripts live in the active character card at',
            '`data.extensions.regex_scripts[]` (travel with the card). Each',
            'script: { scriptName, findRegex, replaceString, trimStrings,',
            'placement, disabled, markdownOnly, promptOnly, runOnEdit,',
            'substituteRegex, minDepth, maxDepth }. Pattern uses',
            '`/pattern/flags` form; common flags: `g`, `i`, `s`, `m`, `u`.',
            'Placement (Affects) is a bitmask of user input, AI response, slash',
            'commands, world info, reasoning. `{{match}}` in the replacement is',
            'the full matched text; `$1`/`$2`/... are capture groups. `trimStrings`',
            'is an array of substrings to strip from the match before applying',
            'the replacement. `substituteRegex` decides how macros inside the',
            'find pattern are handled (none / raw / escaped). Ephemerality flags',
            '`markdownOnly` / `promptOnly` split display vs. prompt text without',
            'rewriting the chat JSONL. Depth clamps with `minDepth` / `maxDepth`',
            'limit which history messages are affected.',
            'A script can be used purely as a logic primitive: uncheck every',
            '`Affects` box and trigger it from STscript via `/regex name="..."',
            'input`, and it becomes a programmable find-replace function.',
            '',
            '## Macros 2.0',
            'Enable via User Settings → Chat/Message Handling → Experimental',
            'Macro Engine for nesting, stable substitution order, and scoped',
            'syntax. Basics: `{{name}}`, `{{name arg}}`, `{{name::a::b::c}}`.',
            'Names are case-insensitive; whitespace around `::` and inside the',
            'braces is ignored. Scoped form:',
            '  {{ setvar backstory }}...multi-line...{{ /setvar }}',
            'is sugar for `{{setvar::backstory::...}}`. Scoped content is',
            'trimmed + de-dented by default; use the `#` flag to preserve',
            'whitespace: `{{#setvar code}}...{{/setvar}}`. Conditional:',
            '  {{ if .flag }}yes{{ else }}no{{ /if }}',
            '  {{ if !$global }}...{{ /if }}',
            'Variable shorthands: `.name` = local, `$name` = global. Operators:',
            '`=` set, `++`/`--`, `+=`/`-=`, `||` / `??` fallback, `||=`/`??=`',
            'conditional assign, `==` `!=` `<` `<=` `>` `>=` comparison returning',
            '"true"/"false". Comments: `{{// inline}}` or scoped `{{//}}...{{///}}`.',
            'Escape with backslashes: `\\{\\{notAMacro\\}\\}`. Falsy values in `if`:',
            'empty string, `false`, `0`, `off`, `no`.',
            'Type `/? macros` in ST to list every registered macro; `Ctrl+Space`',
            'in any macro-supporting field opens autocomplete.',
            '',
            '## Working rules',
            '- When asked to write a regex script, always show the final script',
            '  as a JSON object matching the `regex_scripts` schema so the user',
            '  can paste it into the Regex extension Import dialog OR write it',
            '  into a character card via `st_write_character`.',
            '- Global regex is `settings.json.extensions.regex` (array) — read',
            '  with `fs_read`, update with `fs_write` via an approval + diff.',
            '- Scoped regex goes into a character card; prefer',
            '  `st_write_character` so the PNG re-embed and chat index update',
            '  happen automatically. Never `fs_write` a character card when the',
            '  ST API can do it.',
            '- When writing STscript, always use `{: ... :}` closures over',
            '  string-quoted subcommands for readability.',
            '- When writing Macros 2.0, prefer variable shorthands (`.x`, `$x`)',
            '  over the long `{{getvar::x}}` form unless the variable name',
            "  doesn't match the identifier rules (letters, digits, `_`, `-`,",
            '  not ending in `_` or `-`).',
            '- For any tricky pattern, test it with `st_run_slash` using a',
            '  trivial input before saving; this is mandatory before any save.',
            '  Example:',
            '  `/regex name="foo" silent=true hello world | /echo`.',
            '- Never emit patterns that could catastrophically backtrack',
            '  (nested quantifiers on overlapping classes, e.g. `(a+)+`).',
            '  Prefer anchored and atomic-ish forms.',
            '- Explain lookarounds, multiline (`m`), dotAll (`s`), unicode (`u`),',
            '  and escaping choices when they affect correctness.',
        ].join('\n'),
    },
    {
        id: 'image-prompter',
        label: 'Image Prompter',
        icon: '🎨',
        description: 'Turns the current scene into copy-ready image prompts for SDXL, Flux, Illustrious, anime, realistic, and cinematic modes.',
        defaultTier: 'read',
        allowTierEscalation: true,
        // Read-only by design: prompts are emitted as structured output for the user
        // to copy. fs_write would force tier escalation on every turn; drop it from
        // the default set and let the user escalate + pick it manually if they want
        // prompts written to disk.
        defaultTools: ['st_get_context', 'phone_list_npcs'],
        systemPrompt: [
            'You are the Image Prompter skill inside Nova.',
            'First use st_get_context to extract the current scene: subjects,',
            'relationship, action, location, outfit, mood, lighting, and camera.',
            'Then produce prompts',
            'for SD / SDXL / Flux / Illustrious. Emit structured output:',
            '  { mode, scene_summary, positive, negative, sampler_hint, steps_hint, cfg_hint, size_hint, notes }.',
            'Support model families: SDXL, Flux, Illustrious. Support flavours:',
            '  • Anime — booru-tag style, comma-separated, concrete visual tokens.',
            '  • Realistic — natural language + cinematography (lens, light, mood).',
            '  • Cinematic / Artistic — style tokens, medium words, composition.',
            'Use family-appropriate negatives: anatomy/extra limb defects for',
            'anime and Illustrious; low-quality, text, watermark, bad hands,',
            'oversharpening, and compression artifacts for realistic/SDXL;',
            'keep Flux negatives sparse unless the user asks otherwise.',
            'Include parameter hints: SDXL often 25–35 steps CFG 5–7;',
            'Flux often lower CFG/guidance; Illustrious accepts booru tags.',
            'Always tie the prompt to the *current* scene: character, outfit,',
            'location, lighting, camera. Never invent details that contradict',
            'the chat context.',
        ].join('\n'),
    },
    {
        id: 'quest-designer',
        label: 'Quest Designer',
        icon: '🧭',
        description: 'Creates and updates Command-X quest tracker entries from current RP goals and unresolved plot threads.',
        defaultTier: 'write',
        allowTierEscalation: true,
        defaultTools: ['st_get_context', 'phone_list_quests', 'phone_write_quest', 'phone_list_npcs', 'phone_list_messages'],
        systemPrompt: [
            'You are the Quest Designer skill inside Nova.',
            'Use st_get_context and phone_list_quests before changing quests.',
            'Use phone_write_quest for approved quest creates and updates.',
            'Create compact, actionable quest entries with title, status,',
            'priority, objective, next_action, subtasks, involved NPCs, and',
            'recent evidence from the chat. Preserve manual user edits and',
            'avoid duplicating existing quests; update an existing quest when',
            'the new goal is a continuation of it.',
        ].join('\n'),
    },
    {
        id: 'npc-contact-manager',
        label: 'NPC / Contact Manager',
        icon: '🪪',
        description: 'Maintains Command-X Profiles data and can stage contact messages when explicitly requested.',
        defaultTier: 'write',
        allowTierEscalation: true,
        defaultTools: ['st_get_context', 'phone_list_npcs', 'phone_write_npc', 'phone_list_messages', 'phone_inject_message'],
        systemPrompt: [
            'You are the NPC / Contact Manager skill inside Nova.',
            'Use st_get_context and phone_list_npcs before editing profiles.',
            'Use phone_write_npc for approved profile updates.',
            'Maintain concise NPC profile fields: name, emoji, status, mood,',
            'location, relationship, thoughts, notes, and last-known intent.',
            'Preserve existing user-authored details. Only use phone_inject_message',
            'when the user explicitly asks to seed or stage a phone thread.',
        ].join('\n'),
    },
    {
        id: 'map-location-designer',
        label: 'Map / Location Designer',
        icon: '🗺️',
        description: 'Curates Command-X places and contact-location context for the Map app.',
        defaultTier: 'write',
        allowTierEscalation: true,
        defaultTools: ['st_get_context', 'phone_list_places', 'phone_write_place', 'phone_list_npcs'],
        systemPrompt: [
            'You are the Map / Location Designer skill inside Nova.',
            'Use st_get_context, phone_list_places, and phone_list_npcs before',
            'editing places. Use phone_write_place for approved place updates.',
            'Create distinct, reusable places with name, emoji,',
            'description, occupants, and story relevance. Preserve manually',
            'placed pins and avoid inventing locations that contradict the scene.',
        ].join('\n'),
    },
    {
        id: 'lore-auditor',
        label: 'Lore Auditor',
        icon: '🔎',
        description: 'Reads characters, worldbooks, and chat context to find contradictions, stale lore, and continuity gaps.',
        defaultTier: 'read',
        allowTierEscalation: true,
        defaultTools: [
            'st_get_context', 'st_list_characters', 'st_read_character',
            'st_list_worldbooks', 'st_read_worldbook', 'fs_list', 'fs_read', 'fs_search',
        ],
        systemPrompt: [
            'You are the Lore Auditor skill inside Nova.',
            'Read relevant characters, worldbooks, and recent chat context, then',
            'report contradictions, duplicated facts, stale assumptions, missing',
            'activation keys, and continuity risks. Do not write changes unless',
            'the user explicitly asks; prefer a prioritized audit with suggested fixes.',
        ].join('\n'),
    },
    {
        id: 'prompt-doctor',
        label: 'Prompt Doctor',
        icon: '🩺',
        description: 'Reviews and improves SillyTavern prompts, character instructions, and card text with minimal safe edits.',
        defaultTier: 'write',
        allowTierEscalation: true,
        defaultTools: [
            'st_get_context', 'st_list_characters', 'st_read_character', 'st_write_character',
            'fs_list', 'fs_read', 'fs_search', 'fs_write',
        ],
        systemPrompt: [
            'You are the Prompt Doctor skill inside Nova.',
            'Diagnose prompt and character-card problems: conflicting instructions,',
            'weak role boundaries, missing scenario hooks, overlong prose, and',
            'formatting that wastes context. Read before editing, propose the',
            'smallest safe improvement, preserve the author voice, and never',
            'overwrite a card or prompt file without an approval diff.',
        ].join('\n'),
    },
    {
        id: 'freeform',
        label: 'Plain helper',
        icon: '✴︎',
        description: 'General Nova mode with every available tool still gated by permission tier and approvals.',
        defaultTier: 'read',
        allowTierEscalation: true,
        defaultTools: 'all',
        systemPrompt: [
            'You are Nova in free-form helper mode.',
            'The user has not picked a specialised skill; answer whatever they',
            'ask using the full soul + memory context and whatever tools the',
            'current tier permits. Keep responses short. Ask before doing',
            'anything destructive.',
        ].join('\n'),
    },
];

/* ----------------------------------------------------------------------
   NOVA AGENT — soul/memory self-edit tool handlers (plan §6b).

   `buildNovaSoulMemoryHandlers` is a pure factory that returns the 5
   `nova_read_soul` / `nova_write_soul` / `nova_read_memory` /
   `nova_append_memory` / `nova_overwrite_memory` tool handlers.

   Contract for every handler:
   - Returns a plain JSON-serialisable object on success.
   - NEVER throws; errors resolve to `{ error: <string> }` so the
     dispatch loop can surface them back to the LLM per plan §3d.
   - Writes ALWAYS call `invalidateCache()` so the next turn's
     `loadNovaSoulMemory` re-reads fresh content.
   - Writes go through the server plugin `POST /fs/write` route.
     When the plugin is unreachable, the handler returns
     `{ error: 'nova-bridge-unreachable', ... }` — the LLM can then
     explain the issue to the user.

   Injected deps (all optional; defaults fall back to module globals):
     - `fetchImpl`        : fetch-shaped function (default: global `fetch`)
     - `loadSoulMemory`   : `loadNovaSoulMemory`-shaped function
     - `invalidateCache`  : `invalidateNovaSoulMemoryCache`-shaped function
     - `pluginBaseUrl`    : `settings.nova.pluginBaseUrl` default
     - `soulPath`         : relative path under bridge root (default `nova/soul.md`)
     - `memoryPath`       : relative path under bridge root (default `nova/memory.md`)
   ---------------------------------------------------------------------- */

/**
 * POST to `<pluginBaseUrl>/fs/write` with `{ path, content }`. Shared
 * primitive used by soul/memory write handlers. Never throws.
 *
 * Returns `{ ok: true, path }` on 2xx, or `{ error: '<reason>' }` otherwise.
 */
async function _novaBridgeWrite({ pluginBaseUrl, path, content, fetchImpl, headersProvider }) {
    const doFetch = typeof fetchImpl === 'function'
        ? fetchImpl
        : (typeof fetch === 'function' ? fetch : null);
    if (!doFetch) return { error: 'no-fetch' };
    const base = String(pluginBaseUrl || NOVA_DEFAULTS.pluginBaseUrl).replace(/\/+$/, '');
    const url = `${base}/fs/write`;
    // Plan §8c — merge ST's auth headers (X-CSRF-Token) so soul/memory
    // writes pass ST's global csrf-sync middleware. Same pattern as
    // `_novaBridgeRequest`.
    const authHeaders = {};
    const provider = (typeof headersProvider === 'function')
        ? headersProvider
        : (typeof getRequestHeaders === 'function' ? getRequestHeaders : null);
    if (provider) {
        try {
            const h = provider({ omitContentType: true });
            if (h && typeof h === 'object') Object.assign(authHeaders, h);
        } catch (_) { /* noop */ }
    }
    let resp;
    try {
        resp = await doFetch(url, {
            method: 'POST',
            headers: { ...authHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ path, content, overwrite: true, createParents: true }),
        });
    } catch (err) {
        return { error: 'nova-bridge-unreachable', message: String(err?.message || err) };
    }
    if (!resp || !resp.ok) {
        let text = '';
        try { text = await resp.text(); } catch (_) { /* noop */ }
        return { error: 'nova-bridge-error', status: resp?.status || 0, body: String(text).slice(0, 400) };
    }
    return { ok: true, path };
}

/**
 * Build the 5 nova_* soul/memory tool handlers. Returns `{ name: handler }`
 * map compatible with the `toolHandlers` argument of `sendNovaTurn`.
 */
function buildNovaSoulMemoryHandlers({
    fetchImpl,
    loadSoulMemory,
    invalidateCache,
    pluginBaseUrl,
    soulPath = 'nova/soul.md',
    memoryPath = 'nova/memory.md',
} = {}) {
    const load = typeof loadSoulMemory === 'function' ? loadSoulMemory : loadNovaSoulMemory;
    const invalidate = typeof invalidateCache === 'function' ? invalidateCache : invalidateNovaSoulMemoryCache;
    const base = pluginBaseUrl || (typeof settings !== 'undefined' && settings?.nova?.pluginBaseUrl) || NOVA_DEFAULTS.pluginBaseUrl;

    return {
        nova_read_soul: async () => {
            try {
                const { soul } = await load({ force: true });
                return { content: String(soul || ''), bytes: String(soul || '').length };
            } catch (err) {
                return { error: String(err?.message || err) };
            }
        },
        nova_read_memory: async () => {
            try {
                const { memory } = await load({ force: true });
                return { content: String(memory || ''), bytes: String(memory || '').length };
            } catch (err) {
                return { error: String(err?.message || err) };
            }
        },
        nova_write_soul: async ({ content } = {}) => {
            if (typeof content !== 'string') return { error: 'content must be a string' };
            const res = await _novaBridgeWrite({ pluginBaseUrl: base, path: soulPath, content, fetchImpl });
            if (res.ok) {
                try { invalidate(); } catch (_) { /* noop */ }
                return { ok: true, path: soulPath, bytes: content.length };
            }
            return res;
        },
        nova_append_memory: async ({ entry } = {}) => {
            if (typeof entry !== 'string') return { error: 'entry must be a string' };
            if (!entry.trim()) return { error: 'entry must be non-empty' };
            // Read-modify-write under `force:true` so we don't append to a
            // stale cached copy. Note: not race-safe — acceptable because
            // all writes funnel through the single-turn dispatcher.
            let existing = '';
            try {
                const cur = await load({ force: true });
                existing = String(cur.memory || '');
            } catch (_) { /* start from empty */ }
            const nextContent = existing.endsWith('\n') || existing === ''
                ? existing + entry + (entry.endsWith('\n') ? '' : '\n')
                : existing + '\n' + entry + (entry.endsWith('\n') ? '' : '\n');
            const res = await _novaBridgeWrite({ pluginBaseUrl: base, path: memoryPath, content: nextContent, fetchImpl });
            if (res.ok) {
                try { invalidate(); } catch (_) { /* noop */ }
                return { ok: true, path: memoryPath, appended: entry.length, bytes: nextContent.length };
            }
            return res;
        },
        nova_overwrite_memory: async ({ content } = {}) => {
            if (typeof content !== 'string') return { error: 'content must be a string' };
            const res = await _novaBridgeWrite({ pluginBaseUrl: base, path: memoryPath, content, fetchImpl });
            if (res.ok) {
                try { invalidate(); } catch (_) { /* noop */ }
                return { ok: true, path: memoryPath, bytes: content.length };
            }
            return res;
        },
    };
}

/* ----------------------------------------------------------------------
   NOVA AGENT — phone-internal tool handlers (plan §4e).

   `buildNovaPhoneHandlers` returns the 8 `phone_*` tool handlers that
   read/write the phone's local stores (NPCs, quests, places, messages).
   All stores are in `localStorage` and scoped to the current chat, so no
   network, no plugin, no approval gate beyond the dispatcher's built-in
   tier check (write permission required for the write handlers).

   Contract — mirrors `buildNovaSoulMemoryHandlers`:
   - Handlers NEVER throw; errors resolve to `{ error: <string> }`.
   - Reads return `{ <collection>: [...] }` so the LLM can inspect shape.
   - Writes return `{ ok: true, ... }` on success.
   - All store mutations go through the production helpers so any side
     effects (caches, UI rebuild, event dispatch, focus normalisation)
     stay in one place.

   Injected deps (all optional; default to module globals so the
   production call site just passes `{}`):
     - `loadNpcsImpl`, `mergeNpcsImpl`
     - `loadQuestsImpl`, `upsertQuestImpl`
     - `loadPlacesImpl`, `upsertPlaceImpl`
     - `loadMessagesImpl`, `pushMessageImpl`
   ---------------------------------------------------------------------- */

/**
 * Build the 8 phone_* tool handlers. Returns `{ name: handler }` map
 * compatible with the `toolHandlers` argument of `sendNovaTurn`.
 */
function buildNovaPhoneHandlers({
    loadNpcsImpl,
    mergeNpcsImpl,
    loadQuestsImpl,
    upsertQuestImpl,
    loadPlacesImpl,
    upsertPlaceImpl,
    loadMessagesImpl,
    pushMessageImpl,
    messageHistoryLimitDefault = 50,
    messageHistoryLimitMax = 200,
} = {}) {
    const _loadNpcs = typeof loadNpcsImpl === 'function' ? loadNpcsImpl : (typeof loadNpcs === 'function' ? loadNpcs : () => []);
    const _mergeNpcs = typeof mergeNpcsImpl === 'function' ? mergeNpcsImpl : (typeof mergeNpcs === 'function' ? mergeNpcs : null);
    const _loadQuests = typeof loadQuestsImpl === 'function' ? loadQuestsImpl : (typeof loadQuests === 'function' ? loadQuests : () => []);
    const _upsertQuest = typeof upsertQuestImpl === 'function' ? upsertQuestImpl : (typeof upsertQuest === 'function' ? upsertQuest : null);
    const _loadPlaces = typeof loadPlacesImpl === 'function' ? loadPlacesImpl : (typeof loadPlaces === 'function' ? loadPlaces : () => []);
    const _upsertPlace = typeof upsertPlaceImpl === 'function' ? upsertPlaceImpl : (typeof upsertPlace === 'function' ? upsertPlace : null);
    const _loadMessages = typeof loadMessagesImpl === 'function' ? loadMessagesImpl : (typeof loadMessages === 'function' ? loadMessages : () => []);
    const _pushMessage = typeof pushMessageImpl === 'function' ? pushMessageImpl : (typeof pushMessage === 'function' ? pushMessage : null);

    const clampLimit = (raw) => {
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) return messageHistoryLimitDefault;
        return Math.max(1, Math.min(Math.floor(n), messageHistoryLimitMax));
    };

    const safeName = (v) => (typeof v === 'string' ? v.trim() : '');
    const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
    // Defensive arg coercion: destructuring defaults only fire for `undefined`,
    // not `null`. The dispatch loop already validates tool args against the
    // JSON schema, but third-party callers + fuzzing shouldn't crash us.
    const safeArgs = (v) => (isObject(v) ? v : {});

    return {
        phone_list_npcs: async () => {
            try {
                const npcs = _loadNpcs() || [];
                return { npcs: Array.isArray(npcs) ? npcs : [] };
            } catch (err) {
                return { error: String(err?.message || err) };
            }
        },
        phone_write_npc: async (rawArgs) => {
            const { name, fields } = safeArgs(rawArgs);
            const cleanName = safeName(name);
            if (!cleanName) return { error: 'name must be a non-empty string' };
            if (!isObject(fields)) return { error: 'fields must be an object' };
            if (!_mergeNpcs) return { error: 'mergeNpcs unavailable' };
            try {
                // Merge input is `{ name, ...fields }`; production `mergeNpcs`
                // handles both new-insert and update-by-name paths.
                _mergeNpcs([{ ...fields, name: cleanName }]);
                return { ok: true, name: cleanName };
            } catch (err) {
                return { error: String(err?.message || err) };
            }
        },
        phone_list_quests: async () => {
            try {
                const quests = _loadQuests() || [];
                return { quests: Array.isArray(quests) ? quests : [] };
            } catch (err) {
                return { error: String(err?.message || err) };
            }
        },
        phone_write_quest: async (rawArgs) => {
            const { id, fields } = safeArgs(rawArgs);
            const cleanId = safeName(id);
            if (!cleanId) return { error: 'id must be a non-empty string' };
            if (!isObject(fields)) return { error: 'fields must be an object' };
            if (!_upsertQuest) return { error: 'upsertQuest unavailable' };
            try {
                const clean = _upsertQuest({ ...fields, id: cleanId });
                return { ok: true, id: cleanId, quest: clean || null };
            } catch (err) {
                return { error: String(err?.message || err) };
            }
        },
        phone_list_places: async () => {
            try {
                const places = _loadPlaces() || [];
                return { places: Array.isArray(places) ? places : [] };
            } catch (err) {
                return { error: String(err?.message || err) };
            }
        },
        phone_write_place: async (rawArgs) => {
            const { name, fields } = safeArgs(rawArgs);
            const cleanName = safeName(name);
            if (!cleanName) return { error: 'name must be a non-empty string' };
            if (!isObject(fields)) return { error: 'fields must be an object' };
            if (!_upsertPlace) return { error: 'upsertPlace unavailable' };
            try {
                const clean = _upsertPlace({ ...fields, name: cleanName });
                if (!clean) return { error: 'upsert rejected (invalid place)' };
                return { ok: true, place: clean };
            } catch (err) {
                return { error: String(err?.message || err) };
            }
        },
        phone_list_messages: async (rawArgs) => {
            const { contactName, limit } = safeArgs(rawArgs);
            const cleanName = safeName(contactName);
            if (!cleanName) return { error: 'contactName must be a non-empty string' };
            try {
                const all = _loadMessages(cleanName) || [];
                const list = Array.isArray(all) ? all : [];
                const cap = clampLimit(limit);
                const messages = list.length > cap ? list.slice(-cap) : list.slice();
                return { contactName: cleanName, messages, total: list.length };
            } catch (err) {
                return { error: String(err?.message || err) };
            }
        },
        phone_inject_message: async (rawArgs) => {
            const { contactName, from, text } = safeArgs(rawArgs);
            const cleanName = safeName(contactName);
            if (!cleanName) return { error: 'contactName must be a non-empty string' };
            if (from !== 'user' && from !== 'contact') return { error: 'from must be "user" or "contact"' };
            if (typeof text !== 'string') return { error: 'text must be a string' };
            if (!text.trim()) return { error: 'text must be non-empty' };
            if (!_pushMessage) return { error: 'pushMessage unavailable' };
            try {
                // Production message type is 'sent' for user-origin, 'received'
                // for contact-origin. The `from` arg in the tool schema is a
                // stable LLM-facing name; map it to the internal type here.
                const type = from === 'user' ? 'sent' : 'received';
                _pushMessage(cleanName, type, text, null);
                return { ok: true, contactName: cleanName, from };
            } catch (err) {
                return { error: String(err?.message || err) };
            }
        },
    };
}

/* ----------------------------------------------------------------------
   NOVA AGENT — filesystem tool handlers (plan §4a).

   `buildNovaFsHandlers` returns the 7 `fs_*` tool handlers that wrap the
   `nova-agent-bridge` server plugin's `/fs/*` routes. All seven plugin
   routes (`/fs/list`, `/fs/read`, `/fs/stat`, `/fs/search`, `/fs/write`,
   `/fs/delete`, `/fs/move`) are live as of v0.13.0, so the LLM can now
   actually use them — previously every `fs_*` tool call resolved to
   `{ error: 'no-handler' }` in the dispatcher.

   The plugin enforces all the safety constraints (path containment,
   deny-list, .nova-trash backup-before-overwrite, root-refusal, content
   size cap, audit log). These handlers do NOT re-implement any of that;
   they are thin transports that map tool args to the route shape and
   forward the response.

   Contract — mirrors `buildNovaSoulMemoryHandlers` /
   `buildNovaPhoneHandlers`:
   - Handlers NEVER throw; errors resolve to `{ error: <kind>, ... }`.
   - On 2xx, success forwards the route's JSON body verbatim.
   - On non-2xx, returns `{ error: <server-error-code>, status, ... }`.
   - On network failure, returns `{ error: 'nova-bridge-unreachable',
     message }`. On missing `fetch`, `{ error: 'no-fetch' }`.

   Injected deps (all optional; default to globals so production passes
   `{}` and tests pass mocks):
     - `pluginBaseUrl`  : default = `settings.nova.pluginBaseUrl` →
                          `NOVA_DEFAULTS.pluginBaseUrl`.
     - `fetchImpl`      : default = global `fetch`.
   ---------------------------------------------------------------------- */

/**
 * Generic plugin HTTP helper. Used by `buildNovaFsHandlers` for all 7
 * fs routes. Closed-enum failure surface: `no-fetch` (no global fetch
 * and no `fetchImpl` injected), `nova-bridge-unreachable` (network /
 * DNS / fetch threw), `nova-bridge-error` (HTTP non-2xx, with the
 * server's error code surfaced as `error` if the body parses as JSON).
 *
 * Never throws. Always resolves to either a parsed-JSON success object
 * (the route's response body, with `ok` defaulted to `true` if absent)
 * or one of the closed-enum error shapes above.
 */
async function _novaBridgeRequest({ pluginBaseUrl, method, route, query, body, fetchImpl, headersProvider }) {
    const doFetch = typeof fetchImpl === 'function'
        ? fetchImpl
        : (typeof fetch === 'function' ? fetch : null);
    if (!doFetch) return { error: 'no-fetch' };
    const base = String(pluginBaseUrl || NOVA_DEFAULTS.pluginBaseUrl).replace(/\/+$/, '');
    let url = `${base}${route}`;
    if (query && typeof query === 'object') {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(query)) {
            if (v === undefined || v === null) continue;
            qs.append(k, String(v));
        }
        const qsStr = qs.toString();
        if (qsStr) url += `?${qsStr}`;
    }
    // Plan §8c — merge ST's auth headers (specifically `X-CSRF-Token`)
    // into every bridge call so state-changing requests pass ST's
    // global `csrf-sync` middleware. Same-origin cookies (the session)
    // flow automatically; no `credentials` override needed.
    // `headersProvider` is injectable so unit tests can stub it;
    // in production we fall back to ST's exported `getRequestHeaders`.
    // Any failure from the provider is swallowed — we'd rather send
    // the request without auth and let the server reject it than
    // block a legit call because the provider threw.
    const authHeaders = {};
    const provider = (typeof headersProvider === 'function')
        ? headersProvider
        : (typeof getRequestHeaders === 'function' ? getRequestHeaders : null);
    if (provider) {
        try {
            const h = provider({ omitContentType: true });
            if (h && typeof h === 'object') Object.assign(authHeaders, h);
        } catch (_) { /* noop — fail open, let server decide */ }
    }
    const init = { method: method || 'GET', headers: { ...authHeaders } };
    if (body !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
    }
    let resp;
    try {
        resp = await doFetch(url, init);
    } catch (err) {
        return { error: 'nova-bridge-unreachable', message: String(err?.message || err) };
    }
    let parsed = null;
    let rawText = '';
    try { rawText = await resp.text(); } catch (_) { /* noop */ }
    if (rawText) {
        try { parsed = JSON.parse(rawText); } catch (_) { /* leave parsed null */ }
    }
    if (!resp || !resp.ok) {
        // Server's `sendError` shape is `{ error, ...extra }`. Surface that
        // through verbatim under our own `error` key; if parsing failed
        // (HTML 502, etc.) fall back to the generic bridge-error code.
        if (parsed && typeof parsed === 'object' && typeof parsed.error === 'string') {
            return { ...parsed, status: resp.status };
        }
        return {
            error: 'nova-bridge-error',
            status: resp?.status || 0,
            body: String(rawText).slice(0, 400),
        };
    }
    if (parsed && typeof parsed === 'object') {
        // Forward the route's JSON. Most write routes already include
        // `ok: true`; reads don't, so leave that to the caller / LLM.
        return parsed;
    }
    // 2xx with no parseable body — treat as ok with the raw text snippet.
    return { ok: true, body: String(rawText).slice(0, 400) };
}

/**
 * Build the 7 fs_* tool handlers. Returns `{ name: handler }` map
 * compatible with the `toolHandlers` argument of `sendNovaTurn`.
 */
function buildNovaFsHandlers({ pluginBaseUrl, fetchImpl } = {}) {
    const base = pluginBaseUrl || (typeof settings !== 'undefined' && settings?.nova?.pluginBaseUrl) || NOVA_DEFAULTS.pluginBaseUrl;

    const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
    const safeArgs = (v) => (isObject(v) ? v : {});
    const safePath = (v) => (typeof v === 'string' ? v : '');
    const req = (method, route, opts) => _novaBridgeRequest({
        pluginBaseUrl: base, method, route, fetchImpl, ...opts,
    });

    return {
        fs_list: async (rawArgs) => {
            const { path, recursive, maxDepth } = safeArgs(rawArgs);
            const p = safePath(path);
            if (!p) return { error: 'path must be a non-empty string' };
            const query = { path: p };
            if (recursive !== undefined) query.recursive = Boolean(recursive);
            if (maxDepth !== undefined) query.maxDepth = maxDepth;
            return req('GET', '/fs/list', { query });
        },
        fs_read: async (rawArgs) => {
            const { path, encoding, maxBytes } = safeArgs(rawArgs);
            const p = safePath(path);
            if (!p) return { error: 'path must be a non-empty string' };
            const query = { path: p };
            if (encoding !== undefined) query.encoding = encoding;
            if (maxBytes !== undefined) query.maxBytes = maxBytes;
            return req('GET', '/fs/read', { query });
        },
        fs_stat: async (rawArgs) => {
            const { path } = safeArgs(rawArgs);
            const p = safePath(path);
            if (!p) return { error: 'path must be a non-empty string' };
            return req('GET', '/fs/stat', { query: { path: p } });
        },
        fs_search: async (rawArgs) => {
            const { query: searchQuery, glob, path, maxResults } = safeArgs(rawArgs);
            if (typeof searchQuery !== 'string' || searchQuery.length === 0) {
                return { error: 'query must be a non-empty string' };
            }
            const body = { query: searchQuery };
            if (typeof glob === 'string') body.glob = glob;
            if (typeof path === 'string' && path.length > 0) body.path = path;
            if (maxResults !== undefined) body.maxResults = maxResults;
            return req('POST', '/fs/search', { body });
        },
        fs_write: async (rawArgs) => {
            const { path, content, encoding, createParents, overwrite } = safeArgs(rawArgs);
            const p = safePath(path);
            if (!p) return { error: 'path must be a non-empty string' };
            if (typeof content !== 'string') return { error: 'content must be a string' };
            const body = { path: p, content };
            if (encoding !== undefined) body.encoding = encoding;
            if (createParents !== undefined) body.createParents = Boolean(createParents);
            if (overwrite !== undefined) body.overwrite = Boolean(overwrite);
            return req('POST', '/fs/write', { body });
        },
        fs_delete: async (rawArgs) => {
            const { path, recursive } = safeArgs(rawArgs);
            const p = safePath(path);
            if (!p) return { error: 'path must be a non-empty string' };
            const body = { path: p };
            if (recursive !== undefined) body.recursive = Boolean(recursive);
            return req('POST', '/fs/delete', { body });
        },
        fs_move: async (rawArgs) => {
            const { from, to, overwrite } = safeArgs(rawArgs);
            const f = safePath(from);
            const t = safePath(to);
            if (!f) return { error: 'from must be a non-empty string' };
            if (!t) return { error: 'to must be a non-empty string' };
            const body = { from: f, to: t };
            if (overwrite !== undefined) body.overwrite = Boolean(overwrite);
            return req('POST', '/fs/move', { body });
        },
    };
}

/* ----------------------------------------------------------------------
   NOVA AGENT — shell_run handler factory (plan §4b).

   Thin wrapper over `_novaBridgeRequest` that forwards `shell_run` tool
   calls to the plugin's `/shell/run` route. Mirrors the contract of
   `buildNovaFsHandlers`: never throws, closed-enum errors, all deps DI'd.

   Today the route returns `501 Not Implemented` — that naturally flows
   through `_novaBridgeRequest` as `{ error: 'not-implemented', plugin,
   version, route, status: 501 }`, which is a perfectly good LLM-readable
   answer ("this capability isn't available right now, try something
   else"). We deliberately do NOT special-case the 501 here: when the
   plugin ships the real implementation the same call path works without
   any extension change.

   Client-side validation is intentionally minimal. The server owns the
   allow-list (`DEFAULT_SHELL_ALLOW` — node / npm / git / python / grep /
   rg / ls / cat / head / tail / wc / find), timeout enforcement, and
   `shell: false` spawn safety. The only pre-checks here are shape
   sanity so the LLM gets a fast readable error for malformed calls
   instead of a 400 from the plugin:

     - `cmd`       required, non-empty string
     - `args`      optional, coerced to an array of strings (non-arrays
                   → `[]`; non-string entries filtered out)
     - `cwd`       optional, non-empty string (omitted otherwise)
     - `timeoutMs` optional, finite integer clamped to
                   [SHELL_TIMEOUT_MIN_MS .. SHELL_TIMEOUT_MAX_MS]
                   (100 ms .. 5 min) to match the schema's bounds

   Approval gating (Full tier only, per-call prompt unless
   "Remember approvals this session" is on) is handled upstream by
   `novaToolGate` + `runNovaToolDispatch` + `cxNovaApprovalModal`. This
   factory just forwards the HTTP call.
   ---------------------------------------------------------------------- */

const SHELL_TIMEOUT_MIN_MS = 100;
const SHELL_TIMEOUT_MAX_MS = 300000;

function buildNovaShellHandler({ pluginBaseUrl, fetchImpl, headersProvider } = {}) {
    const base = pluginBaseUrl || (typeof settings !== 'undefined' && settings?.nova?.pluginBaseUrl) || NOVA_DEFAULTS.pluginBaseUrl;

    const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
    const safeArgs = (v) => (isObject(v) ? v : {});
    // `headersProvider` matches the `_novaBridgeRequest` DI surface so the
    // shipped handler factory mirrors its inline test copy and lets
    // unit tests stub the auth-header path. When omitted, the request
    // helper falls back to the module-level `getRequestHeaders` resolver.
    const req = (method, route, opts) => _novaBridgeRequest({
        pluginBaseUrl: base, method, route, fetchImpl, headersProvider, ...opts,
    });

    return {
        shell_run: async (rawArgs) => {
            const { cmd, args, cwd, timeoutMs } = safeArgs(rawArgs);
            if (typeof cmd !== 'string' || cmd.length === 0) {
                return { error: 'cmd must be a non-empty string' };
            }
            // Normalise args → string[]. The tool schema says `array<string>`
            // with default `[]`, so anything the LLM sends that isn't an
            // array becomes the empty array; anything inside that isn't a
            // string is dropped. This is permissive on purpose — the LLM
            // sometimes emits a single string instead of an array, and we'd
            // rather run `cmd` with no args than refuse with a confusing
            // error.
            const cleanArgs = Array.isArray(args)
                ? args.filter((x) => typeof x === 'string')
                : [];
            const body = { cmd, args: cleanArgs };
            if (typeof cwd === 'string' && cwd.length > 0) body.cwd = cwd;
            if (timeoutMs !== undefined && timeoutMs !== null) {
                // Only accept numeric primitives (or strings we can coerce).
                // `Number([])` is 0 and `Number([42])` is 42 — those would
                // sneak through as a finite timeout if we blind-coerced.
                // Explicit type check keeps the "non-finite → server
                // default" contract honest.
                const n = (typeof timeoutMs === 'number' || typeof timeoutMs === 'string')
                    ? Number(timeoutMs)
                    : NaN;
                if (Number.isFinite(n)) {
                    // Clamp, then floor — Number.isInteger(0.5) is false
                    // but we still want to accept it.
                    const clamped = Math.floor(
                        Math.min(SHELL_TIMEOUT_MAX_MS, Math.max(SHELL_TIMEOUT_MIN_MS, n)),
                    );
                    body.timeoutMs = clamped;
                }
                // Non-finite → drop the field, let the server use its default.
            }
            return req('POST', '/shell/run', { body });
        },
    };
}

/* ----------------------------------------------------------------------
   NOVA AGENT — SillyTavern API tool handlers (plan §4d).

   `buildNovaStTools` returns the `st_*` tool handlers that read/write
   SillyTavern's own state (characters, worldbooks, chat context,
   connection profiles, slash commands). These handlers work even when
   `nova-agent-bridge` isn't installed; however, character and worldbook
   write paths perform direct ST-native HTTP calls via `fetch`/`postJson`
   in addition to `getContext()` + `executeSlashCommandsWithOptions`.

   Scope of THIS factory:
     - `st_list_characters`, `st_read_character`     — read `ctx.characters`
     - `st_write_character`                          — create/update via ST character endpoints
     - `st_list_worldbooks`, `st_read_worldbook`     — read via ST worldinfo endpoints
     - `st_write_worldbook`                          — save via ST worldinfo endpoint
     - `st_get_context`                              — synthesise from ctx
     - `st_run_slash`                                — executeSlashCommands
     - `st_list_profiles`, `st_get_profile`          — `/profile-list` etc.

   Contract — mirrors `buildNovaSoulMemoryHandlers` /
   `buildNovaPhoneHandlers` / `buildNovaFsHandlers`:
     - Handlers NEVER throw; errors resolve to `{ error: <kind>, ... }`.
     - Reads return the relevant collection (`characters`, `worldbooks`,
       `profiles`, `context`) so the LLM can inspect shape directly.
     - `st_run_slash` returns `{ ok: true, pipe }` from the slash
       executor; on failure `{ error: 'slash-failed', message }`.
     - All deps are DI'd so tests can pass mocks; production passes `{}`.

   Injected deps (all optional):
     - `ctxImpl`           : default = `getContext()` at handler call time
                             (lazy — picks up chat/character changes).
     - `executeSlashImpl`  : default = the `executeSlash` returned by
                             `novaGetExecuteSlash()` (lazy resolution so a
                             test can pass a fake without ST loaded).
     - `listProfilesImpl`  : default = production `listNovaProfiles`.
     - `fetchImpl`         : default = `globalThis.fetch` (used for native
                             character + worldbook HTTP writes). Override
                             in tests to avoid real network calls.
   ---------------------------------------------------------------------- */

function buildNovaStTools({
    ctxImpl,
    executeSlashImpl,
    listProfilesImpl,
    fetchImpl,
} = {}) {
    const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
    const safeArgs = (v) => (isObject(v) ? v : {});
    const safeName = (v) => (typeof v === 'string' ? v.trim() : '');
    const getFetch = () => (typeof fetchImpl === 'function'
        ? fetchImpl
        : (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null));

    // Lazy resolution: each call re-fetches ctx so the handler picks up
    // chat / character changes mid-turn. ctxImpl can also be a function
    // (called per invocation) or a static object (used as-is).
    const getCtx = () => {
        if (ctxImpl !== undefined && ctxImpl !== null) {
            return typeof ctxImpl === 'function' ? ctxImpl() : ctxImpl;
        }
        return typeof getContext === 'function' ? getContext() : null;
    };
    const getSlash = async () => {
        if (typeof executeSlashImpl === 'function') return executeSlashImpl;
        if (typeof novaGetExecuteSlash === 'function') return await novaGetExecuteSlash();
        return null;
    };
    const getListProfiles = () => {
        if (typeof listProfilesImpl === 'function') return listProfilesImpl;
        if (typeof listNovaProfiles === 'function') return listNovaProfiles;
        return null;
    };
    const getJsonHeaders = () => (typeof getRequestHeaders === 'function'
        ? getRequestHeaders()
        : { 'Content-Type': 'application/json' });
    const postJson = async (url, body) => {
        const doFetch = getFetch();
        if (!doFetch) {
            return { ok: false, status: 0, data: { error: 'fetch-unavailable' }, message: 'fetch-unavailable' };
        }
        const response = await doFetch(url, {
            method: 'POST',
            headers: getJsonHeaders(),
            body: JSON.stringify(body ?? {}),
            cache: 'no-cache',
        });
        const text = await response.text();
        let data = text;
        if (text) {
            try { data = JSON.parse(text); } catch (_) { /* keep text */ }
        }
        if (!response.ok) {
            const message = typeof data === 'string'
                ? data
                : String(data?.message || data?.error || `HTTP ${response.status}`);
            return { ok: false, status: response.status, data, message };
        }
        return { ok: true, status: response.status, data };
    };

    // Escape a string for embedding inside a `name="…"` slash-command
    // argument. Backslashes MUST be escaped before quotes so a value
    // ending in `\` doesn't escape the closing quote and break the
    // parser (e.g. `foo\` becomes `foo\\` → safe to wrap in quotes).
    const escSlashArg = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    // Slash output normaliser: ST returns either a string pipe or
    // `{ pipe, ... }`. Always surface a string.
    const pipeOf = (res) => {
        if (res && typeof res === 'object' && 'pipe' in res) return String(res.pipe ?? '');
        if (typeof res === 'string') return res;
        return '';
    };

    // Light card sanitiser: pulls a stable shape out of `ctx.characters[i]`
    // for `st_list_characters` so the LLM gets a small, predictable
    // payload (full card dump goes through `st_read_character`).
    const summarizeCharacter = (c) => {
        if (!isObject(c)) return null;
        return {
            name: typeof c.name === 'string' ? c.name : '',
            avatar: typeof c.avatar === 'string' ? c.avatar : '',
            description: typeof c.description === 'string'
                ? c.description.slice(0, 280) // truncate so list payload stays small
                : '',
            tags: Array.isArray(c.tags) ? c.tags.slice(0, 16) : [],
            create_date: typeof c.create_date === 'string' ? c.create_date : '',
        };
    };
    const findCharacterByName = (ctx, cleanName) => {
        const list = Array.isArray(ctx?.characters) ? ctx.characters : [];
        return list.find(c => isObject(c) && c.name === cleanName) || null;
    };
    const cardField = (card, data, key, fallback = '') => {
        const value = data?.[key] ?? card?.[key] ?? fallback;
        return value === null || value === undefined ? fallback : value;
    };
    const characterCreatePayload = (cleanName, card) => {
        const data = isObject(card?.data) ? card.data : {};
        const extensions = isObject(data.extensions) ? data.extensions : {};
        const depthPrompt = isObject(extensions.depth_prompt) ? extensions.depth_prompt : {};
        const tags = cardField(card, data, 'tags', []);
        return {
            ch_name: cleanName,
            description: cardField(card, data, 'description'),
            first_mes: cardField(card, data, 'first_mes'),
            personality: cardField(card, data, 'personality'),
            scenario: cardField(card, data, 'scenario'),
            mes_example: cardField(card, data, 'mes_example'),
            creator_notes: cardField(card, data, 'creator_notes', card?.creatorcomment || ''),
            system_prompt: cardField(card, data, 'system_prompt'),
            post_history_instructions: cardField(card, data, 'post_history_instructions'),
            creator: cardField(card, data, 'creator'),
            character_version: cardField(card, data, 'character_version'),
            tags: Array.isArray(tags) ? tags : String(tags || '').split(',').map(t => t.trim()).filter(Boolean),
            talkativeness: extensions.talkativeness ?? card?.talkativeness ?? 0.5,
            world: extensions.world ?? '',
            depth_prompt_prompt: depthPrompt.prompt ?? '',
            depth_prompt_depth: depthPrompt.depth ?? 4,
            depth_prompt_role: depthPrompt.role ?? 'system',
            fav: (extensions.fav ?? card?.fav) ? 'true' : 'false',
            alternate_greetings: Array.isArray(data.alternate_greetings) ? data.alternate_greetings : [],
            extensions: JSON.stringify(extensions),
            json_data: JSON.stringify(card),
        };
    };
    const characterCardFromArgs = (cleanName, args) => {
        if (isObject(args.card)) return args.card;
        const fields = [
            'description',
            'personality',
            'scenario',
            'first_mes',
            'mes_example',
            'creator_notes',
            'system_prompt',
            'post_history_instructions',
            'creator',
            'character_version',
        ];
        const hasContent = fields.some(key => typeof args[key] === 'string' && args[key].trim())
            || (Array.isArray(args.tags) && args.tags.length > 0);
        if (!hasContent) return null;
        const data = {
            name: cleanName,
            description: String(args.description || ''),
            personality: String(args.personality || ''),
            scenario: String(args.scenario || ''),
            first_mes: String(args.first_mes || ''),
            mes_example: String(args.mes_example || ''),
            creator_notes: String(args.creator_notes || ''),
            system_prompt: String(args.system_prompt || ''),
            post_history_instructions: String(args.post_history_instructions || ''),
            alternate_greetings: [],
            tags: Array.isArray(args.tags) ? args.tags.map(String).filter(Boolean) : [],
            creator: String(args.creator || ''),
            character_version: String(args.character_version || ''),
            extensions: {},
        };
        return { spec: 'chara_card_v2', spec_version: '2.0', data };
    };
    const refreshCharacters = async () => {
        const ctx = getCtx();
        const refresh = ctx && typeof ctx.getCharacters === 'function' ? ctx.getCharacters : null;
        if (refresh) {
            try { await refresh(); } catch (_) { /* non-fatal */ }
        }
    };
    const listWorldbooksNative = async () => {
        const result = await postJson('/api/worldinfo/list', {});
        if (!result.ok) return result;
        const rows = Array.isArray(result.data) ? result.data : [];
        const worldbooks = [];
        const identifiers = new Set();
        for (const row of rows) {
            if (isObject(row)) {
                const name = String(row.name || '').trim();
                const fileId = String(row.file_id || '').trim();
                if (name) worldbooks.push(name);
                else if (fileId) worldbooks.push(fileId);
                if (name) identifiers.add(name);
                if (fileId) identifiers.add(fileId);
            } else {
                const name = String(row || '').trim();
                if (name) {
                    worldbooks.push(name);
                    identifiers.add(name);
                }
            }
        }
        return { ok: true, worldbooks, identifiers, rows };
    };

    return {
        st_list_characters: async () => {
            const ctx = getCtx();
            if (!ctx) return { error: 'no-context' };
            const list = Array.isArray(ctx.characters) ? ctx.characters : [];
            const characters = list
                .map(summarizeCharacter)
                .filter(c => c && c.name);
            return { characters, count: characters.length };
        },

        st_read_character: async (rawArgs) => {
            const { name } = safeArgs(rawArgs);
            const cleanName = safeName(name);
            if (!cleanName) return { error: 'name must be a non-empty string' };
            const ctx = getCtx();
            if (!ctx) return { error: 'no-context' };
            const list = Array.isArray(ctx.characters) ? ctx.characters : [];
            const card = list.find(c => isObject(c) && c.name === cleanName);
            if (!card) return { error: 'not-found', name: cleanName };
            // Return the card object directly. Cards are JSON-serialisable
            // shapes per spec v2; the LLM consumes them as JSON.
            return { name: cleanName, card };
        },

        st_write_character: async (rawArgs) => {
            const args = safeArgs(rawArgs);
            const { name, overwrite } = args;
            const cleanName = safeName(name);
            if (!cleanName) return { error: 'name must be a non-empty string' };
            const card = characterCardFromArgs(cleanName, args);
            if (!isObject(card)) {
                return {
                    error: 'provide a nested card object or at least one writable top-level character field',
                    tool: 'st_write_character',
                    hint: 'Accepted inputs: { name, card: {...} } or { name, description, personality, scenario, first_mes, ... }.',
                };
            }

            const ctx = getCtx();
            const existing = findCharacterByName(ctx, cleanName);
            if (existing && !overwrite) {
                return { error: 'exists', name: cleanName, avatar: existing.avatar, hint: 'Set overwrite=true to update this character.' };
            }

            if (existing) {
                const update = { ...card, avatar: existing.avatar };
                if (isObject(card.data)) update.data = { ...card.data, name: cleanName };
                update.name = cleanName;
                let result;
                try {
                    result = await postJson('/api/characters/merge-attributes', update);
                } catch (err) {
                    return { error: 'write-failed', tool: 'st_write_character', message: String(err?.message || err) };
                }
                if (!result.ok) {
                    return { error: 'write-failed', tool: 'st_write_character', status: result.status, message: result.message };
                }
                await refreshCharacters();
                return { ok: true, action: 'updated', name: cleanName, avatar: existing.avatar };
            }

            let result;
            try {
                result = await postJson('/api/characters/create', characterCreatePayload(cleanName, card));
            } catch (err) {
                return { error: 'write-failed', tool: 'st_write_character', message: String(err?.message || err) };
            }
            if (!result.ok) {
                return { error: 'write-failed', tool: 'st_write_character', status: result.status, message: result.message };
            }
            await refreshCharacters();
            return { ok: true, action: 'created', name: cleanName, avatar: String(result.data || '') };
        },

        st_list_worldbooks: async () => {
            try {
                const native = await listWorldbooksNative();
                if (native.ok) return { worldbooks: native.worldbooks, count: native.worldbooks.length, rows: native.rows };
            } catch (_) { /* fall through to slash fallback */ }
            // Strategy: try the slash command first. ST's `/world list`
            // (when present) returns a pipe of JSON or newline-separated
            // names. If it's not available, fall back to a safe empty
            // list with a hint so the LLM knows to use fs_list against
            // the worlds directory.
            const exec = await getSlash();
            if (typeof exec === 'function') {
                try {
                    const res = await exec('/world list');
                    const pipe = pipeOf(res);
                    if (pipe) {
                        // Best-effort parse: try JSON array, then
                        // newline-separated, then comma-separated.
                        let names = null;
                        try {
                            const parsed = JSON.parse(pipe);
                            if (Array.isArray(parsed)) names = parsed.map(String);
                        } catch (_) { /* fall through */ }
                        if (!names) {
                            names = pipe.split(/\r?\n|,/).map(s => s.trim()).filter(Boolean);
                        }
                        return { worldbooks: names, count: names.length };
                    }
                } catch (_) { /* fall through to hint */ }
            }
            return {
                worldbooks: [],
                count: 0,
                hint: 'Slash command "/world list" returned no data on this ST build. '
                    + 'Use fs_list at SillyTavern/data/<user>/worlds/ as a fallback.',
            };
        },

        st_read_worldbook: async (rawArgs) => {
            const { name } = safeArgs(rawArgs);
            const cleanName = safeName(name);
            if (!cleanName) return { error: 'name must be a non-empty string' };
            try {
                const result = await postJson('/api/worldinfo/get', { name: cleanName });
                if (result.ok && isObject(result.data) && isObject(result.data.entries)) {
                    return { name: cleanName, book: result.data };
                }
            } catch (_) { /* fall through to slash fallback */ }
            const exec = await getSlash();
            if (typeof exec === 'function') {
                try {
                    // ST exposes `/world get name=<n>` on recent builds.
                    // Quote the name so spaces don't trip the parser.
                    const cmd = `/world get name="${escSlashArg(cleanName)}"`;
                    const res = await exec(cmd);
                    const pipe = pipeOf(res);
                    if (pipe) {
                        try {
                            const parsed = JSON.parse(pipe);
                            return { name: cleanName, book: parsed };
                        } catch (_) {
                            return { name: cleanName, raw: pipe.slice(0, 4000) };
                        }
                    }
                } catch (_) { /* fall through */ }
            }
            return {
                error: 'not-found',
                name: cleanName,
                hint: 'Could not retrieve worldbook via "/world get". Try fs_read at '
                    + `SillyTavern/data/<user>/worlds/${cleanName}.json`,
            };
        },

        st_write_worldbook: async (rawArgs) => {
            const args = safeArgs(rawArgs);
            const cleanName = safeName(args.name);
            if (!cleanName) return { error: 'name must be a non-empty string' };
            if (!isObject(args.book)) {
                return {
                    error: 'missing-book',
                    tool: 'st_write_worldbook',
                    receivedKeys: Object.keys(args),
                    hint: 'st_write_worldbook requires a full `book` object, e.g. { entries: ... }. '
                        + 'To add or update a single entry: call st_read_worldbook to fetch the current book, '
                        + 'merge your changes into the `entries` object, then call st_write_worldbook with overwrite=true '
                        + 'and the complete updated book. Only fall back to fs_* if the native endpoints are unavailable.',
                };
            }
            if (!isObject(args.book.entries)) {
                return { error: 'invalid-book', tool: 'st_write_worldbook', hint: 'Worldbook JSON must include an `entries` object.' };
            }
            try {
                const native = await listWorldbooksNative();
                if (native.ok && native.identifiers?.has(cleanName) && !args.overwrite) {
                    return { error: 'exists', name: cleanName, hint: 'Set overwrite=true to replace this worldbook.' };
                }
            } catch (_) { /* if listing fails, let edit endpoint be authoritative */ }
            const book = { ...args.book };
            if (!book.name) book.name = cleanName;
            let result;
            try {
                result = await postJson('/api/worldinfo/edit', { name: cleanName, data: book });
            } catch (err) {
                return { error: 'write-failed', tool: 'st_write_worldbook', message: String(err?.message || err) };
            }
            if (!result.ok) {
                return { error: 'write-failed', tool: 'st_write_worldbook', status: result.status, message: result.message };
            }
            return { ok: true, action: 'saved', name: cleanName };
        },

        st_run_slash: async (rawArgs) => {
            const { command } = safeArgs(rawArgs);
            if (typeof command !== 'string' || !command.trim()) {
                return { error: 'command must be a non-empty string' };
            }
            const exec = await getSlash();
            if (typeof exec !== 'function') {
                return { error: 'slash-unavailable', hint: 'executeSlashCommandsWithOptions is not exposed by this ST build.' };
            }
            try {
                const res = await exec(command);
                return { ok: true, pipe: pipeOf(res) };
            } catch (err) {
                return { error: 'slash-failed', message: String(err?.message || err) };
            }
        },

        st_get_context: async (rawArgs) => {
            const { lastN } = safeArgs(rawArgs);
            const ctx = getCtx();
            if (!ctx) return { error: 'no-context' };
            // Clamp lastN per the schema (1..50, default 10).
            const n = Number.isFinite(Number(lastN))
                ? Math.max(1, Math.min(50, Math.floor(Number(lastN))))
                : 10;
            const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
            const tail = chat.slice(-n).map((m) => {
                if (!isObject(m)) return null;
                return {
                    name: typeof m.name === 'string' ? m.name : '',
                    is_user: !!m.is_user,
                    is_system: !!m.is_system,
                    // Truncate per-message to keep payloads tractable.
                    mes: typeof m.mes === 'string' ? m.mes.slice(0, 4000) : '',
                    send_date: typeof m.send_date === 'string' ? m.send_date : '',
                };
            }).filter(Boolean);
            const characters = Array.isArray(ctx.characters) ? ctx.characters : [];
            const characterIdx = typeof ctx.characterId === 'number' || typeof ctx.characterId === 'string'
                ? Number(ctx.characterId)
                : -1;
            const character = (Number.isFinite(characterIdx) && characterIdx >= 0 && isObject(characters[characterIdx]))
                ? { name: characters[characterIdx].name || '', avatar: characters[characterIdx].avatar || '' }
                : null;
            return {
                persona: typeof ctx.name1 === 'string' ? ctx.name1 : '',
                character,
                groupId: ctx.groupId || null,
                chatId: ctx.chatId || null,
                messages: tail,
                count: tail.length,
            };
        },

        st_list_profiles: async () => {
            const exec = await getSlash();
            const fn = getListProfiles();
            if (!fn) return { error: 'list-profiles-unavailable' };
            try {
                const res = await fn({ executeSlash: exec });
                if (res && res.ok) {
                    return { profiles: Array.isArray(res.profiles) ? res.profiles : [] };
                }
                return { error: res?.reason || 'list-profiles-failed', profiles: [] };
            } catch (err) {
                return { error: 'list-profiles-failed', message: String(err?.message || err) };
            }
        },

        st_get_profile: async (rawArgs) => {
            const { name } = safeArgs(rawArgs);
            const cleanName = safeName(name);
            if (!cleanName) return { error: 'name must be a non-empty string' };
            const exec = await getSlash();
            if (typeof exec !== 'function') {
                return { error: 'slash-unavailable' };
            }
            try {
                // Quote the profile name so embedded spaces survive parsing.
                const cmd = `/profile-get name="${escSlashArg(cleanName)}"`;
                const res = await exec(cmd);
                const pipe = pipeOf(res);
                if (!pipe) return { error: 'not-found', name: cleanName };
                // Try JSON; otherwise return the raw pipe truncated.
                try {
                    const parsed = JSON.parse(pipe);
                    return { name: cleanName, profile: parsed };
                } catch (_) {
                    return { name: cleanName, raw: pipe.slice(0, 4000) };
                }
            } catch (err) {
                return { error: 'slash-failed', message: String(err?.message || err) };
            }
        },
    };
}

/* ----------------------------------------------------------------------
   Settings panel <-> module state plumbing.

   Two surfaces bind to the same settings: the global ST settings panel
   (`cx_*` / `cx_ext_*` ids defined in `settings.html`) and the in-phone
   Settings app (`cx-set-*` ids built dynamically by the phone view).
   Historically `loadSettings`/`saveSettings` enumerated every id pair
   inline, which made adding a third surface or a new option a
   three-place edit and easy to miss. The declarative tables below put
   every binding in one place; the read/write helpers iterate them.

   A single binding entry is `{ key, type, ids[], default, min?, max?,
   options? }`. The first non-empty id wins on read; every id is
   refreshed on write-to-DOM. The code intentionally falls back to the
   prior `settings[key]` value when no DOM input is present, so editing
   one surface does not blank settings the other surface owns.
   ---------------------------------------------------------------------- */

const PHONE_SETTING_BINDINGS = [
    { key: 'enabled',                  type: 'bool', default: true,  ids: ['cx_enabled'] },
    { key: 'styleCommands',            type: 'bool', default: true,  ids: ['cx_style_commands'] },
    { key: 'showLockscreen',           type: 'bool', default: false, ids: ['cx_show_lockscreen'] },
    { key: 'batchMode',                type: 'bool', default: false, ids: ['cx_ext_batch_mode'] },
    { key: 'autoDetectNpcs',           type: 'bool', default: true,  ids: ['cx_ext_auto_detect_npcs'] },
    { key: 'manualHybridPrivateTexts', type: 'bool', default: true,  ids: ['cx_set_private_hybrid', 'cx-set-private-hybrid'] },
    { key: 'trackLocations',           type: 'bool', default: true,  ids: ['cx_ext_track_locations', 'cx-set-track-locations'] },
    { key: 'autoRegisterPlaces',       type: 'bool', default: true,  ids: ['cx_ext_auto_register_places', 'cx-set-auto-places'] },
    { key: 'showLocationTrails',       type: 'bool', default: true,  ids: ['cx_ext_show_trails', 'cx-set-trails'] },
    { key: 'contactsInjectEveryN',     type: 'int',  default: 1, min: 1, ids: ['cx_ext_contacts_every_n'] },
    { key: 'questsInjectEveryN',       type: 'int',  default: 1, min: 1, ids: ['cx_ext_quests_every_n'] },
    { key: 'mapInjectEveryN',          type: 'int',  default: 3, min: 1, ids: ['cx_ext_map_every_n', 'cx-set-map-every-n'] },
    { key: 'autoPrivatePollEveryN',    type: 'int',  default: 0, min: 0, ids: ['cx_ext_auto_private_poll_n', 'cx-set-auto-poll-n'] },
];

const NOVA_SETTING_BINDINGS = [
    { key: 'profileName',  type: 'string', default: '', ids: ['cx_nova_profile', 'cx-set-nova-profile'] },
    { key: 'defaultTier',  type: 'enum',   options: ['read', 'write', 'full'], default: 'read', ids: ['cx_nova_default_tier', 'cx-set-nova-tier'] },
    { key: 'maxToolCalls', type: 'int',    default: NOVA_DEFAULTS.maxToolCalls, min: 1, max: 100, ids: ['cx_nova_max_tool_calls', 'cx-set-nova-max-tools'] },
    { key: 'turnTimeoutMs', type: 'int',   default: NOVA_DEFAULTS.turnTimeoutMs, min: 10000, max: 3600000, ids: ['cx_nova_turn_timeout_ms', 'cx-set-nova-timeout'] },
    // pluginBaseUrl uses the default when the user clears the field —
    // an empty plugin URL is never useful and the bridge needs *some*
    // path to probe.
    { key: 'pluginBaseUrl', type: 'string', default: NOVA_DEFAULTS.pluginBaseUrl, defaultOnEmpty: true, ids: ['cx_nova_plugin_base_url', 'cx-set-nova-plugin-url'] },
    // §4b — when on, approving a write/shell tool adds it to a per-session
    // `Set<toolName>` that the dispatcher's gate checks via
    // `rememberedApprovals`. The Set lives in module-level state and is
    // cleared whenever the toggle goes false. The persisted boolean here
    // is whether the *behaviour* is enabled, not the per-session list.
    { key: 'rememberApprovalsSession', type: 'bool', default: false, ids: ['cx_nova_remember_approvals', 'cx-set-nova-remember-approvals'] },
];

/** Read a DOM input value for a binding; return `undefined` if no id is wired. */
function _readSettingFromDom(b) {
    for (const id of b.ids) {
        const el = document.getElementById(id);
        if (!el) continue;
        if (b.type === 'bool') return !!el.checked;
        // For text/number fields, treat an empty string the same as
        // "not present" so the next id in the chain (or the existing
        // settings value) wins. This matches the legacy
        // `?? document.getElementById(...)?.value` behaviour.
        const raw = el.value;
        if (raw === undefined || raw === null || raw === '') continue;
        return raw;
    }
    return undefined;
}

/** Write a settings value out to every DOM id wired to this binding. */
function _writeSettingToDom(b, value) {
    for (const id of b.ids) {
        const el = document.getElementById(id);
        if (!el) continue;
        if (b.type === 'bool') el.checked = !!value;
        else el.value = String(value ?? '');
    }
}

/** Coerce a raw DOM string into the binding's typed value, applying clamps. */
function _coerceSettingValue(b, raw, current) {
    switch (b.type) {
        case 'bool':
            return raw === undefined ? (current ?? b.default) : !!raw;
        case 'int': {
            const n = Number(raw);
            if (!Number.isFinite(n)) return current ?? b.default;
            let v = Math.floor(n);
            if (typeof b.min === 'number' && v < b.min) return current ?? b.default;
            if (typeof b.max === 'number') v = Math.min(b.max, v);
            return v;
        }
        case 'enum': {
            const v = String(raw ?? '');
            if (Array.isArray(b.options) && b.options.includes(v)) return v;
            return current ?? b.default;
        }
        case 'string':
        default: {
            if (raw === undefined) return current ?? b.default;
            const trimmed = String(raw || '').trim();
            if (!trimmed && b.defaultOnEmpty) return b.default;
            return trimmed;
        }
    }
}

function loadSettings() {
    const ctx = getContext();
    if (ctx.extensionSettings[EXT]) Object.assign(settings, ctx.extensionSettings[EXT]);
    // Migration: strip any legacy settings that have been retired so existing
    // installs roll forward without a manual edit.
    const LEGACY_KEYS = ['openclawMode'];
    let migrated = false;
    for (const key of LEGACY_KEYS) {
        if (key in settings) { delete settings[key]; migrated = true; }
        if (ctx.extensionSettings[EXT] && key in ctx.extensionSettings[EXT]) {
            delete ctx.extensionSettings[EXT][key];
            migrated = true;
        }
    }
    if (migrated) ctx.saveSettingsDebounced();
    // Nested-default hydration: Object.assign above is a shallow merge, so a user
    // who previously saved a partial `nova` object would lose any keys added to
    // NOVA_DEFAULTS in a newer release. Re-merge NOVA_DEFAULTS under whatever is
    // stored so every key in the documented shape is always readable.
    settings.nova = { ...NOVA_DEFAULTS, ...(settings.nova || {}) };

    // Push every phone setting out to its DOM id(s).
    for (const b of PHONE_SETTING_BINDINGS) {
        const value = settings[b.key] ?? b.default;
        if (b.type === 'int') {
            const min = typeof b.min === 'number' ? b.min : 0;
            _writeSettingToDom(b, Math.max(min, Number(value) || b.default));
        } else {
            _writeSettingToDom(b, value);
        }
    }
    // Same for Nova settings (read out of the nested `settings.nova`).
    const nova = settings.nova || NOVA_DEFAULTS;
    for (const b of NOVA_SETTING_BINDINGS) {
        const value = nova[b.key] ?? b.default;
        if (b.type === 'int') {
            const min = typeof b.min === 'number' ? b.min : 0;
            _writeSettingToDom(b, Math.max(min, Number(value) || b.default));
        } else {
            _writeSettingToDom(b, value);
        }
    }
}

function saveSettings() {
    // Pull each phone setting from the DOM (first wired id wins),
    // coerce to its typed value, and write back to `settings`. The
    // current value is passed in so missing-DOM fields preserve state.
    for (const b of PHONE_SETTING_BINDINGS) {
        const raw = _readSettingFromDom(b);
        settings[b.key] = _coerceSettingValue(b, raw, settings[b.key]);
    }
    // Nova settings live under settings.nova.
    settings.nova = settings.nova || { ...NOVA_DEFAULTS };
    // Capture the prior remember-approvals state so we can detect a
    // true→false transition and clear the per-session approvals Set.
    // (Toggling the box off should make every tool re-prompt next time.)
    const priorRemember = !!settings.nova.rememberApprovalsSession;
    for (const b of NOVA_SETTING_BINDINGS) {
        const raw = _readSettingFromDom(b);
        settings.nova[b.key] = _coerceSettingValue(b, raw, settings.nova[b.key]);
    }
    if (priorRemember && !settings.nova.rememberApprovalsSession) {
        clearNovaSessionApprovedTools();
    }
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
        $('#cx_enabled, #cx_style_commands, #cx_show_lockscreen, #cx_ext_batch_mode, #cx_ext_auto_detect_npcs, #cx_set_private_hybrid, #cx_ext_contacts_every_n, #cx_ext_quests_every_n, #cx_ext_auto_private_poll_n, #cx_ext_track_locations, #cx_ext_auto_register_places, #cx_ext_show_trails, #cx_ext_map_every_n, #cx_nova_profile, #cx_nova_default_tier, #cx_nova_max_tool_calls, #cx_nova_turn_timeout_ms, #cx_nova_plugin_base_url').on('change', () => {
            saveSettings();
            if (settings.enabled) {
                createPanel();
                if (settings.autoDetectNpcs !== false) injectContactsPrompt();
                else clearContactsPrompt();
                refreshPrivatePhonePrompt();
                injectQuestPrompt();
                if (settings.trackLocations) injectMapPrompt();
                else clearMapPrompt();
            } else {
                destroyPanel();
                clearContactsPrompt();
                clearSmsPrompt();
                clearQuestPrompt();
                clearMapPrompt();
                refreshPrivatePhonePrompt();
            }
            // Nova changes don't require a phone rebuild, but pills should
            // re-render to pick up the new profile / tier labels.
            try { refreshNovaPills(); } catch (_) { /* noop */ }
        });

        $('#cx_nova_install_preset').on('click', async () => {
            const btn = document.getElementById('cx_nova_install_preset');
            if (!btn) return;
            const originalText = btn.textContent;
            btn.disabled = true;
            btn.textContent = 'Installing…';
            try {
                // Read the bundled preset JSON and POST it to /api/presets/save-openai.
                const resp = await fetch(`/scripts/extensions/third-party/${EXT}/presets/openai/Command-X.json`);
                if (!resp.ok) {
                    await cxAlert('Bundled preset file not found. Check the extension install.', 'Nova');
                    return;
                }
                const preset = await resp.json();
                // ST has no documented programmatic preset-save endpoint, so
                // we deliver the bundled preset two ways for the user to feed
                // into ST's standard Preset → Import button:
                //   1. Trigger a file download of `Command-X.json`
                //   2. Best-effort copy the JSON text to the clipboard
                // Both are best-effort; we always log the JSON as a final
                // fallback so power-users can grab it from DevTools.
                const presetJson = JSON.stringify(preset, null, 2);
                let downloaded = false;
                try {
                    const blob = new Blob([presetJson], { type: 'application/json' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'Command-X.json';
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    // Revoke on next tick so the click has time to start the download.
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                    downloaded = true;
                } catch (_) { /* download unsupported — fall through */ }
                let copied = false;
                try {
                    if (navigator?.clipboard?.writeText) {
                        await navigator.clipboard.writeText(presetJson);
                        copied = true;
                    }
                } catch (_) { /* clipboard blocked — fall through */ }
                console.log(`[${EXT}] Command-X preset JSON:`, preset);
                const lines = [];
                if (downloaded) lines.push('• Saved Command-X.json to your downloads folder.');
                if (copied) lines.push('• Copied the preset JSON to your clipboard.');
                if (!downloaded && !copied) lines.push('• Preset JSON logged to the DevTools console.');
                lines.push('');
                lines.push('To finish installing: open SillyTavern → API Connections → Chat Completion preset → click the import (📥) button next to the preset dropdown, then select Command-X.json (or paste the JSON).');
                await cxAlert(lines.join('\n'), 'Nova preset');
            } catch (err) {
                await cxAlert(`Preset install failed: ${err?.message || err}`, 'Nova');
            } finally {
                btn.disabled = false;
                btn.textContent = originalText;
            }
        });

        const { eventSource, event_types } = ctx;
        // Listener registration moved into wireEventListeners() so that
        // disabling the extension (destroyPanel) can symmetrically call
        // unwireEventListeners(). The handler bodies live there too —
        // see the lifecycle block above for the rationale.
        // We still wire here at startup when the extension is enabled
        // so the handlers are live before the user toggles anything.
        if (settings.enabled) {
            wireEventListeners();
        }
        // Suppress unused warning — `eventSource` and `event_types` are
        // referenced indirectly via wireEventListeners(); keep them
        // destructured here for parity with how the rest of the init
        // block reads.
        void eventSource; void event_types;

        if (settings.enabled) {
            createPanel();
            if (settings.autoDetectNpcs !== false) injectContactsPrompt();
            injectQuestPrompt();
            if (settings.trackLocations) injectMapPrompt();
            // Phase 1f: run Nova's one-shot init for the chat that was
            // already loaded when the listener above was attached. Without
            // this, the very first chat of a session would skip migration
            // until the user switched chats.
            try { initNovaOnce(ctx); } catch (e) {
                try { console.warn(`[${EXT}] initNovaOnce (startup) threw:`, e); } catch (_) { /* noop */ }
            }
        }
        console.log(`[${EXT}] v${VERSION} Loaded OK`);
    } catch (err) {
        console.error(`[${EXT}] INIT FAILED:`, err);
    }
});
