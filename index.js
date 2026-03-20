/**
 * Command-X Phone — SillyTavern Extension v0.8
 *
 * Approach: inject a system prompt that tells the LLM to wrap the
 * character's text/neural reply in [sms]…[/sms] tags. The extension
 * extracts that block for the phone UI and hides it from ST chat.
 * Message history is stored in localStorage (phone owns its own log).
 *
 * v0.8: Unified messaging (Messages + Command-X merged into one app),
 *        user persona filtered from contacts, neural commands are
 *        now subliminal (targets unaware of command influence).
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
const DEFAULTS = { enabled: true, styleCommands: true, showLockscreen: false, panelOpen: false };
let settings = { ...DEFAULTS };
let phoneContainer = null;
let commandMode = null; // null | 'COMMAND' | 'FORGET' | 'BELIEVE' | 'COMPEL'
let neuralMode = false; // toggled via ⚡ button in chat header

/* ======================================================================
   SMS TAG PARSING
   We instruct the LLM to wrap phone replies in [sms]…[/sms].
   ====================================================================== */

const SMS_TAG_RE = /\[sms\]([\s\S]*?)\[\/sms\]/gi;

/**
 * Extract all [sms]…[/sms] blocks from a message string.
 * Returns the concatenated inner text, or null if no tags found.
 */
function extractSmsContent(raw) {
    if (!raw) return null;
    const parts = [];
    let m;
    SMS_TAG_RE.lastIndex = 0;
    while ((m = SMS_TAG_RE.exec(raw)) !== null) {
        const t = m[1].trim();
        if (t) parts.push(t);
    }
    return parts.length ? parts.join('\n') : null;
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
        el.innerHTML = el.innerHTML.replace(SMS_TAG_RE, (_, inner) =>
            `<span class="cx-sms-inline" title="${inner.trim().replace(/"/g, '&quot;')}">📱 <em>${inner.trim().slice(0, 50)}${inner.trim().length > 50 ? '…' : ''}</em></span>`
        );
    }
}

/* ======================================================================
   NPC CONTACT STORE — localStorage-backed, keyed per chat
   ====================================================================== */

const CONTACTS_TAG_RE = /\[contacts\]([\s\S]*?)\[\/contacts\]/gi;

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
 * Parse [contacts] JSON from a message. Expected format:
 * [contacts][{"name":"Sarah","emoji":"👩","status":"online"}, ...][/contacts]
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
        }));
    } catch (e) {
        console.warn('[command-x] failed to parse [contacts] JSON:', e);
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
        `[System: At the end of each response, include a [contacts] block listing NPCs currently present or available in the scene. Format: [contacts][{"name":"Name","emoji":"👩","status":"online"}][/contacts] — status can be "online", "offline", or "nearby". Only include side characters/NPCs who could plausibly be contacted. Do NOT include ${excludeNote || 'the user or the main character'}. If no NPCs are relevant, omit the [contacts] block entirely.]`,
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

function injectSmsPrompt(contactName, isNeural, cmdType) {
    let instruction;
    if (isNeural && cmdType) {
        const cmdContext = {
            COMMAND: `The neural command takes effect subliminally — ${contactName} is completely unaware any command was sent. They simply feel an irresistible compulsion to comply, as if it were their own idea. They do NOT see, read, or acknowledge the command itself.`,
            FORGET: `The neural command takes effect subliminally — ${contactName} is completely unaware their memory is being altered. The specified memory or knowledge simply fades away. They do NOT see, read, or acknowledge any command.`,
            BELIEVE: `The neural command takes effect subliminally — ${contactName} is completely unaware their perception is being rewritten. They now genuinely believe the stated thing as absolute truth, as if they always believed it. They do NOT see, read, or acknowledge any command.`,
            COMPEL: `The neural command takes effect subliminally — ${contactName} is completely unaware of any external influence. They feel an overwhelming urge driving them toward the specified behavior, but it feels entirely like their own desire. They do NOT see, read, or acknowledge any command.`,
        }[cmdType] || '';
        instruction = `[System: A subliminal ${cmdType} neural command was just activated targeting ${contactName}. ${cmdContext} In their next text message reply, ${contactName} should respond naturally — their behavior/thoughts are influenced but they have NO awareness of Command-X or any neural command. They just text back normally, reflecting the command's effect through their actions and words. Wrap ${contactName}'s text reply in [sms]...[/sms] tags. Example: *She suddenly felt the urge to head over.* [sms]hey omw to your place rn[/sms] *She grabbed her keys without questioning why.* — The [sms] block is the phone text content only. Always include [sms] tags.]`;
    } else if (isNeural) {
        instruction = `[System: A subliminal neural command was just activated targeting ${contactName}. The command takes effect without ${contactName}'s awareness — they do NOT see or acknowledge any command. They respond naturally via text, with their behavior subtly influenced. Wrap ${contactName}'s text reply in [sms]...[/sms] tags. Example: *She felt a sudden impulse.* [sms]hey, coming over[/sms] *She didn't question the urge.* — Always include [sms] tags.]`;
    } else {
        instruction = `[System: The user just texted ${contactName} via phone. ${contactName} should text back naturally. Wrap ${contactName}'s text reply in [sms]...[/sms] tags. Example: *She glanced at her phone and typed back.* [sms]lol yeah I'll be there in 10[/sms] *She set the phone down.* — The [sms] block is the phone text content only. Keep the text reply natural and in-character. Always include [sms] tags when responding to phone texts.]`;
    }

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

function pushMessage(contactName, type, text) {
    const msgs = loadMessages(contactName);
    msgs.push({ type, text, time: now() });
    saveMessages(contactName, msgs);
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
    // ST characters — filter out user persona
    const contacts = chars
        .filter(c => (c.name || '').toLowerCase() !== userName)
        .map((c, i) => ({
            id: c.avatar || `char_${i}`,
            name: c.name || `Character ${i + 1}`,
            emoji: emojis[i % emojis.length],
            gradient: gradients[i % gradients.length],
            online: true,
            isNpc: false,
        }));
    // Merge stored NPCs (skip duplicates by name + skip user persona)
    const existingNames = new Set(contacts.map(c => c.name.toLowerCase()));
    const npcs = loadNpcs().filter(n => (n.name || '').toLowerCase() !== userName);
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
        });
    }
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

/* ======================================================================
   HTML BUILDERS
   ====================================================================== */

function contactRowHTML(c, i, app) {
    const msgs = loadMessages(c.name);
    const last = msgs.length ? msgs[msgs.length - 1] : null;
    const preview = last ? (last.type.startsWith('sent') ? `You: ${last.text}` : last.text) : 'Tap to chat';
    const previewTrunc = preview.length > 38 ? preview.slice(0, 38) + '…' : preview;
    const npcBadge = c.isNpc ? '<span class="cx-npc-badge">NPC</span>' : '';

    return `
    <div class="cx-contact-row" data-idx="${i}" data-app="${app}" data-cid="${c.id}" data-cname="${c.name}">
        <div class="cx-avatar" style="background:${c.gradient}">${c.emoji}</div>
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
                <div class="cx-app-icon" data-app="camera">
                    <div class="cx-icon-img cx-icon-camera">📷</div>
                    <div class="cx-icon-label">Camera</div>
                </div>
                <div class="cx-app-icon" data-app="photos">
                    <div class="cx-icon-img cx-icon-photos">🖼️</div>
                    <div class="cx-icon-label">Photos</div>
                </div>
                <div class="cx-app-icon" data-app="notes">
                    <div class="cx-icon-img cx-icon-notes">📝</div>
                    <div class="cx-icon-label">Notes</div>
                </div>
                <div class="cx-app-icon" data-app="browser">
                    <div class="cx-icon-img cx-icon-browser">🌐</div>
                    <div class="cx-icon-label">Browser</div>
                </div>
                <div class="cx-app-icon" data-app="music">
                    <div class="cx-icon-img cx-icon-music">🎵</div>
                    <div class="cx-icon-label">Music</div>
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

        <!-- Chat View -->
        <div class="cx-view" data-view="chat">
            <div class="cx-chat-header">
                <div class="cx-chat-back" id="cx-back">‹</div>
                <div class="cx-chat-header-info">
                    <div class="cx-chat-header-name" id="cx-chat-name"></div>
                    <div class="cx-chat-header-status" id="cx-chat-status"></div>
                </div>
                <div class="cx-neural-toggle" id="cx-neural-toggle" title="Toggle neural commands">⚡</div>
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
        // Legacy syntax — extract type and display cleanly
        cmdType = legacyMatch[1].toUpperCase();
        displayText = `⚡ ${cmdType}: ${legacyMatch[2]}`;
        chatText = rawText;
    } else if (cmdType) {
        // Drawer mode — wrap for display + format for RP
        displayText = `⚡ ${cmdType}: ${rawText}`;
        chatText = `{{${cmdType}}} {{${rawText}}}`;
    }

    const isCommand = !!cmdType;

    // Remove empty-state hint
    area.querySelector('.cx-chat-hint')?.remove();

    // Store + render sent bubble
    const msgType = isNeural ? 'sent-neural' : 'sent';
    pushMessage(currentContactName, msgType, displayText);
    area.appendChild(renderBubble({ type: msgType, text: displayText, time: now() }));
    input.value = '';

    // ── KEY: inject the system prompt so the LLM includes [sms] tags ──
    injectSmsPrompt(currentContactName, isNeural, cmdType);
    awaitingReply = true;

    // Typing indicator
    clearTypingIndicator();
    const typing = document.createElement('div');
    typing.id = 'cx-typing-indicator';
    typing.className = 'cx-typing-row';
    typing.innerHTML = `<div class="cx-typing-bubble"><span></span><span></span><span></span></div>`;
    area.appendChild(typing);
    area.scrollTop = area.scrollHeight;

    // Safety timeout — remove typing indicator after 30s if no response
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

    // Send the RP message to ST
    sendToChat(chatText, currentContactName, isCommand);
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
            if (app === 'cmdx') switchView(app);
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
    if (savedContact && savedApp) openChat(savedContact, savedApp, true);
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
    const cb = (id, key) => { const el = document.getElementById(id); if (el) el.checked = !!settings[key]; };
    cb('cx_enabled', 'enabled');
    cb('cx_style_commands', 'styleCommands');
    cb('cx_show_lockscreen', 'showLockscreen');
}

function saveSettings() {
    settings.enabled = document.getElementById('cx_enabled')?.checked ?? true;
    settings.styleCommands = document.getElementById('cx_style_commands')?.checked ?? true;
    settings.showLockscreen = document.getElementById('cx_show_lockscreen')?.checked ?? false;
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
        $('#cx_enabled, #cx_style_commands, #cx_show_lockscreen').on('change', () => {
            saveSettings();
            if (settings.enabled) {
                createPanel();
                injectContactsPrompt();
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

            // ── [sms] FIRST — must run before [contacts] which can trigger rebuildPhone ──
            const smsText = extractSmsContent(msg.mes);
            if (smsText) {
                // Determine which contact this SMS belongs to.
                // Priority: if we're awaiting a reply for a specific contact, attribute to them.
                // Otherwise try to match msg.name against known contacts, or fall back to
                // the currently open chat contact.
                let targetContact = null;
                if (awaitingReply && currentContactName) {
                    // We sent a message and are waiting — this reply is for that contact
                    // (even though msg.name may be the main character, not the NPC)
                    targetContact = currentContactName;
                } else {
                    // Unsolicited SMS (NPC texted first, or reply came after timeout)
                    // Try matching msg.name against our contacts list
                    const allContacts = getContactsFromContext();
                    const byName = allContacts.find(c => c.name.toLowerCase() === (msg.name || '').toLowerCase());
                    if (byName) {
                        targetContact = byName.name;
                    } else if (currentContactName) {
                        // Fallback: attribute to currently open chat
                        targetContact = currentContactName;
                    } else {
                        // Last resort: attribute to first contact
                        targetContact = allContacts.length ? allContacts[0].name : null;
                    }
                }

                if (targetContact) {
                    pushMessage(targetContact, 'received', smsText);

                    const wrapper = document.getElementById('cx-panel-wrapper');
                    const area = phoneContainer?.querySelector('#cx-msg-area');
                    // Update the phone UI if we're viewing this contact's chat
                    if (wrapper && !wrapper.classList.contains('cx-hidden') && area && currentContactName === targetContact) {
                        area.querySelector('#cx-typing-indicator')?.remove();
                        area.appendChild(renderBubble({ type: 'received', text: smsText, time: now() }));
                        area.scrollTop = area.scrollHeight;
                    }
                    // If the phone is open but on a different contact's chat, rebuild to update previews
                    else if (wrapper && !wrapper.classList.contains('cx-hidden') && currentContactName !== targetContact) {
                        // Don't rebuild full phone (would lose current view), just note it arrived
                        console.log(`[${EXT}] SMS received for ${targetContact} (currently viewing ${currentContactName})`);
                    }
                }

                if (awaitingReply) {
                    awaitingReply = false;
                    clearSmsPrompt();
                    clearTypingIndicator();
                }
            } else if (awaitingReply) {
                // No [sms] tags found but we were waiting — clear the waiting state
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
                    // If we just handled an sms, the rebuild re-renders from localStorage
                    // which already has the new message, so bubbles are correct.
                }
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
            if (settings.enabled) injectContactsPrompt();
            if (phoneContainer) rebuildPhone();
        });

        if (settings.enabled) {
            createPanel();
            injectContactsPrompt();
        }
        console.log(`[${EXT}] v0.8 Loaded OK`);
    } catch (err) {
        console.error(`[${EXT}] INIT FAILED:`, err);
    }
});
