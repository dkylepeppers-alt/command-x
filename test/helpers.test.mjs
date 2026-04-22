/**
 * Unit tests for Command-X pure helper functions.
 * Run with: node --test test/helpers.test.mjs
 *
 * These are inline test copies/adaptations of helper logic from index.js.
 * They live here because the extension file imports SillyTavern runtime
 * modules (getContext, setExtensionPrompt, etc.) that are unavailable in a
 * plain Node.js environment.
 *
 * When helper behavior in index.js changes, review these test copies and
 * update them as needed so the tests continue to reflect production logic.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/* ===== Helpers under test (inline copies) ===== */

function escHtml(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>'); }
function escAttr(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function normalizeContactName(name) {
    return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function slugifyQuestTitle(value) {
    const slug = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return slug || 'quest';
}

function normalizeQuestKey(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
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
    const text = String(value ?? '').trim();
    if (!text && field === 'title') return 'Untitled Quest';
    return text || null;
}

const SMS_TAG_RE = /\[sms([^\]]*)\]([\s\S]*?)\[\/sms\]/gi;
const SMS_ATTR_RE = /(\w+)="([^"]*)"/g;

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

const CONTACTS_TAG_RE = /\[(?:contacts|status)\]([\s\S]*?)\[\/(?:contacts|status)\]/gi;

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
    } catch {
        return null;
    }
}

const QUESTS_TAG_RE = /\[quests\]([\s\S]*?)\[\/quests\]/gi;

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
            .filter(q => String(q.title || '').trim());
    } catch {
        return null;
    }
}

/* ===== Tests ===== */

describe('escHtml', () => {
    it('escapes ampersand', () => assert.equal(escHtml('a&b'), 'a&amp;b'));
    it('escapes angle brackets', () => assert.equal(escHtml('<script>'), '&lt;script&gt;'));
    it('converts newline to <br>', () => assert.equal(escHtml('a\nb'), 'a<br>b'));
    it('coerces null to empty string', () => assert.equal(escHtml(null), ''));
    it('coerces undefined to empty string', () => assert.equal(escHtml(undefined), ''));
    it('coerces number', () => assert.equal(escHtml(42), '42'));
    it('escapes already-escaped ampersands again (non-idempotent for entities)', () => assert.equal(escHtml('&amp;'), '&amp;amp;'));
});

describe('escAttr', () => {
    it('escapes double-quote', () => assert.equal(escAttr('"hello"'), '&quot;hello&quot;'));
    it('escapes ampersand', () => assert.equal(escAttr('a&b'), 'a&amp;b'));
    it('escapes angle brackets', () => assert.equal(escAttr('<b>'), '&lt;b&gt;'));
    it('coerces null', () => assert.equal(escAttr(null), ''));
    it('coerces undefined', () => assert.equal(escAttr(undefined), ''));
});

describe('normalizeContactName', () => {
    it('lowercases and trims', () => assert.equal(normalizeContactName('  Sarah  '), 'sarah'));
    it('collapses inner whitespace', () => assert.equal(normalizeContactName('Dr  Who'), 'dr who'));
    it('handles empty string', () => assert.equal(normalizeContactName(''), ''));
    it('handles null', () => assert.equal(normalizeContactName(null), ''));
});

describe('slugifyQuestTitle', () => {
    it('lowercases and hyphenates', () => assert.equal(slugifyQuestTitle('Find the Key'), 'find-the-key'));
    it('strips leading/trailing hyphens', () => assert.equal(slugifyQuestTitle('!!quest!!'), 'quest'));
    it('falls back to "quest" on empty', () => assert.equal(slugifyQuestTitle(''), 'quest'));
    it('strips non-alphanumeric', () => assert.equal(slugifyQuestTitle('Quest: Part 1!'), 'quest-part-1'));
});

describe('normalizeQuestKey', () => {
    it('lowercases and trims', () => assert.equal(normalizeQuestKey('  My Quest  '), 'my quest'));
    it('collapses inner whitespace', () => assert.equal(normalizeQuestKey('a  b'), 'a b'));
    it('handles empty string', () => assert.equal(normalizeQuestKey(''), ''));
    it('handles null', () => assert.equal(normalizeQuestKey(null), ''));
    it('does not strip punctuation (unlike slugify)', () => assert.equal(normalizeQuestKey('Quest: Part 1!'), 'quest: part 1!'));
});

describe('sanitizeContactValue', () => {
    it('normalizes known status values', () => {
        assert.equal(sanitizeContactValue('status', 'Online'), 'online');
        assert.equal(sanitizeContactValue('status', 'OFFLINE'), 'offline');
        assert.equal(sanitizeContactValue('status', 'nearby'), 'nearby');
    });
    it('falls back to "nearby" for unknown status', () => {
        assert.equal(sanitizeContactValue('status', 'invisible'), 'nearby');
        assert.equal(sanitizeContactValue('status', null), 'nearby');
    });
    it('returns fallback emoji when emoji is empty', () => {
        assert.equal(sanitizeContactValue('emoji', ''), '🧑');
        assert.equal(sanitizeContactValue('emoji', '  '), '🧑');
    });
    it('returns emoji value when provided', () => {
        assert.equal(sanitizeContactValue('emoji', '👩'), '👩');
    });
    it('returns null for empty text fields', () => {
        assert.equal(sanitizeContactValue('mood', ''), null);
        assert.equal(sanitizeContactValue('thoughts', '  '), null);
    });
    it('returns trimmed value for non-empty text fields', () => {
        assert.equal(sanitizeContactValue('mood', '  happy  '), 'happy');
    });
});

describe('sanitizeQuestValue', () => {
    it('normalizes valid status values', () => {
        for (const s of ['active', 'waiting', 'blocked', 'completed', 'failed']) {
            assert.equal(sanitizeQuestValue('status', s), s);
        }
    });
    it('defaults status to "active" for unknown', () => {
        assert.equal(sanitizeQuestValue('status', 'in-progress'), 'active');
        assert.equal(sanitizeQuestValue('status', null), 'active');
    });
    it('normalizes priority', () => {
        assert.equal(sanitizeQuestValue('priority', 'HIGH'), 'high');
        assert.equal(sanitizeQuestValue('priority', 'unknown'), 'normal');
    });
    it('normalizes urgency', () => {
        assert.equal(sanitizeQuestValue('urgency', 'urgent'), 'urgent');
        assert.equal(sanitizeQuestValue('urgency', 'asap'), 'none');
    });
    it('coerces "focused" to boolean', () => {
        assert.equal(sanitizeQuestValue('focused', true), true);
        assert.equal(sanitizeQuestValue('focused', 'true'), true);
        assert.equal(sanitizeQuestValue('focused', 'false'), false);
        assert.equal(sanitizeQuestValue('focused', false), false);
    });
    it('falls back title to "Untitled Quest"', () => {
        assert.equal(sanitizeQuestValue('title', ''), 'Untitled Quest');
        assert.equal(sanitizeQuestValue('title', '   '), 'Untitled Quest');
    });
    it('returns null for empty freetext fields', () => {
        assert.equal(sanitizeQuestValue('summary', ''), null);
    });
    it('trims freetext fields', () => {
        assert.equal(sanitizeQuestValue('summary', '  Find the key  '), 'Find the key');
    });
});

describe('parseSmsAttrs', () => {
    it('parses from and to', () => {
        const a = parseSmsAttrs(' from="Sarah" to="user"');
        assert.equal(a.from, 'Sarah');
        assert.equal(a.to, 'user');
    });
    it('returns empty object for empty string', () => {
        assert.deepEqual(parseSmsAttrs(''), {});
    });
    it('is case-insensitive for attr names', () => {
        const a = parseSmsAttrs('FROM="Alice"');
        assert.equal(a.from, 'Alice');
    });
});

describe('extractSmsBlocks', () => {
    it('returns null for empty input', () => assert.equal(extractSmsBlocks(''), null));
    it('returns null when no tags', () => assert.equal(extractSmsBlocks('No phone here.'), null));
    it('extracts a single block', () => {
        const blocks = extractSmsBlocks('[sms from="Sarah" to="user"]hey[/sms]');
        assert.equal(blocks?.length, 1);
        assert.equal(blocks[0].from, 'Sarah');
        assert.equal(blocks[0].to, 'user');
        assert.equal(blocks[0].text, 'hey');
    });
    it('extracts multiple blocks', () => {
        const raw = '[sms from="A" to="user"]hi[/sms] [sms from="B" to="user"]bye[/sms]';
        const blocks = extractSmsBlocks(raw);
        assert.equal(blocks?.length, 2);
        assert.equal(blocks[0].from, 'A');
        assert.equal(blocks[1].from, 'B');
    });
    it('trims whitespace in text', () => {
        const blocks = extractSmsBlocks('[sms from="X" to="user"]  hello  [/sms]');
        assert.equal(blocks[0].text, 'hello');
    });
    it('returns null for blocks with empty text', () => {
        assert.equal(extractSmsBlocks('[sms from="X" to="user"]   [/sms]'), null);
    });
    it('is case-insensitive for tag', () => {
        // Tag regex is /gi — matches uppercase too
        const blocks = extractSmsBlocks('[SMS from="X" to="user"]hello[/SMS]');
        assert.equal(blocks?.length, 1);
    });
    it('handles multiline text', () => {
        const blocks = extractSmsBlocks('[sms from="A" to="user"]line1\nline2[/sms]');
        assert.ok(blocks[0].text.includes('line1'));
    });
    it('sets from and to null when attributes missing', () => {
        const blocks = extractSmsBlocks('[sms]no attrs[/sms]');
        assert.equal(blocks[0].from, null);
        assert.equal(blocks[0].to, null);
    });
});

describe('extractContacts', () => {
    it('returns null for empty input', () => assert.equal(extractContacts(''), null));
    it('returns null when no tag', () => assert.equal(extractContacts('plain text'), null));
    it('parses [status] JSON array', () => {
        const raw = '[status][{"name":"Sarah","emoji":"👩","status":"online","mood":"happy","location":"café","relationship":"friendly","thoughts":"hmm"}][/status]';
        const result = extractContacts(raw);
        assert.equal(result?.length, 1);
        assert.equal(result[0].name, 'Sarah');
        assert.equal(result[0].emoji, '👩');
        assert.equal(result[0].status, 'online');
        assert.equal(result[0].mood, 'happy');
        assert.equal(result[0].location, 'café');
        assert.equal(result[0].relationship, 'friendly');
        assert.equal(result[0].thoughts, 'hmm');
    });
    it('accepts legacy [contacts] tag', () => {
        const raw = '[contacts][{"name":"Bob"}][/contacts]';
        const result = extractContacts(raw);
        assert.equal(result?.length, 1);
        assert.equal(result[0].name, 'Bob');
    });
    it('filters entries without a string name', () => {
        const raw = '[status][{"name":"Valid"},{"other":"field"},null][/status]';
        const result = extractContacts(raw);
        assert.equal(result?.length, 1);
    });
    it('fills missing optional fields with null/defaults', () => {
        const raw = '[status][{"name":"X"}][/status]';
        const result = extractContacts(raw);
        assert.equal(result[0].mood, null);
        assert.equal(result[0].emoji, '🧑');
        assert.equal(result[0].status, 'nearby');
    });
    it('returns null on invalid JSON', () => {
        assert.equal(extractContacts('[status]not-json[/status]'), null);
    });
    it('returns null when JSON is not an array', () => {
        assert.equal(extractContacts('[status]{"name":"X"}[/status]'), null);
    });
});

describe('extractQuests', () => {
    it('returns null for empty input', () => assert.equal(extractQuests(''), null));
    it('returns null when no tag', () => assert.equal(extractQuests('no quests here'), null));
    it('parses a valid quest array', () => {
        const raw = '[quests][{"id":"q1","title":"Find the key","status":"active"}][/quests]';
        const result = extractQuests(raw);
        assert.equal(result?.length, 1);
        assert.equal(result[0].title, 'Find the key');
    });
    it('accepts wrapped { quests: [...] } format', () => {
        const raw = '[quests]{"quests":[{"title":"A quest"}]}[/quests]';
        const result = extractQuests(raw);
        assert.equal(result?.length, 1);
    });
    it('filters quests without a title', () => {
        const raw = '[quests][{"title":"Valid"},{"summary":"no title"},null][/quests]';
        const result = extractQuests(raw);
        assert.equal(result?.length, 1);
        assert.equal(result[0].title, 'Valid');
    });
    it('returns null on invalid JSON', () => {
        assert.equal(extractQuests('[quests]bad[/quests]'), null);
    });
    it('returns empty array when JSON is not an array or wrapped array', () => {
        const result = extractQuests('[quests]42[/quests]');
        // Not null — code produces empty list; title-filter removes nothing
        assert.deepEqual(result, []);
    });
});

/* ===== Overseer operate-envelope parser ===== */

function parseOverseerOperateEnvelope(reply, envelopeFromBridge = null) {
    const raw = envelopeFromBridge || (() => {
        const match = String(reply || '').match(/\[command-x-operate\]\s*([\s\S]*?)\s*\[\/command-x-operate\]/i);
        if (!match) return null;
        try { return JSON.parse(match[1]); } catch { return null; }
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

describe('parseOverseerOperateEnvelope', () => {
    it('returns null when no envelope is present', () => {
        assert.equal(parseOverseerOperateEnvelope('just a plain reply, nothing here'), null);
    });
    it('parses a valid envelope with a single slash.run action', () => {
        const reply = [
            'Here is my plan.',
            '[command-x-operate]',
            JSON.stringify({
                kind: 'command-x/operate/v1',
                summary: 'Echo hello',
                actions: [
                    { id: 'a1', type: 'slash.run', title: 'Echo', command: '/echo hello', reason: 'demo' },
                ],
            }),
            '[/command-x-operate]',
        ].join('\n');
        const env = parseOverseerOperateEnvelope(reply);
        assert.ok(env);
        assert.equal(env.kind, 'command-x/operate/v1');
        assert.equal(env.summary, 'Echo hello');
        assert.equal(env.actions.length, 1);
        assert.equal(env.actions[0].command, '/echo hello');
        assert.equal(env.actions[0].status, 'pending');
    });
    it('drops actions that do not start with a slash', () => {
        const env = parseOverseerOperateEnvelope('[command-x-operate]' +
            JSON.stringify({
                kind: 'command-x/operate/v1',
                actions: [
                    { id: 'a1', type: 'slash.run', command: 'echo hi' },
                    { id: 'a2', type: 'slash.run', command: '/echo ok' },
                ],
            }) + '[/command-x-operate]');
        assert.ok(env);
        assert.equal(env.actions.length, 1);
        assert.equal(env.actions[0].id, 'a2');
    });
    it('returns null when kind is wrong', () => {
        const env = parseOverseerOperateEnvelope('[command-x-operate]' +
            JSON.stringify({ kind: 'other', actions: [{ type: 'slash.run', command: '/echo' }] }) +
            '[/command-x-operate]');
        assert.equal(env, null);
    });
    it('returns null when all actions are filtered out', () => {
        const env = parseOverseerOperateEnvelope('[command-x-operate]' +
            JSON.stringify({
                kind: 'command-x/operate/v1',
                actions: [{ id: 'a1', type: 'http.get', command: 'https://example.com' }],
            }) + '[/command-x-operate]');
        assert.equal(env, null);
    });
    it('returns null on malformed JSON in the envelope', () => {
        assert.equal(parseOverseerOperateEnvelope('[command-x-operate]not json[/command-x-operate]'), null);
    });
});

/* ===== MCP FS helpers (v0.14.0) — pure trust-boundary tests ===== */

function normalizeAbsolutePath(input) {
    if (typeof input !== 'string') return null;
    if (input.length === 0) return null;
    if (input.includes('\0')) return null;
    if (/%2e%2e|%2f%2e%2e|%5c%2e%2e/i.test(input)) return null;
    let p = input.replace(/\\/g, '/').trim();
    if (p.length === 0) return null;
    let prefix = '';
    const driveMatch = /^([a-zA-Z]):(\/?)/.exec(p);
    if (driveMatch) {
        prefix = driveMatch[1].toLowerCase() + ':';
        p = p.slice(driveMatch[0].length);
        if (driveMatch[2] !== '/') return null;
        p = '/' + p;
    } else if (p.startsWith('//')) {
        const parts = p.slice(2).split('/');
        if (parts.length < 2 || !parts[0] || !parts[1]) return null;
        prefix = '//' + parts[0] + '/' + parts[1];
        p = '/' + parts.slice(2).join('/');
    } else if (!p.startsWith('/')) {
        return null;
    }
    const segments = p.split('/').filter(Boolean);
    const out = [];
    for (const seg of segments) {
        if (seg === '.') continue;
        if (seg === '..') return null;
        if (seg.includes(':')) return null;
        if (/[ .]$/.test(seg) && seg.length > 1) return null;
        out.push(seg);
    }
    const normalized = prefix + '/' + out.join('/');
    return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

function pathAllowed(normalizedPath, allowList) {
    if (typeof normalizedPath !== 'string' || !normalizedPath) return false;
    if (!Array.isArray(allowList) || allowList.length === 0) return false;
    const isWindows = /^[a-z]:\//.test(normalizedPath) || normalizedPath.startsWith('//');
    const target = isWindows ? normalizedPath.toLowerCase() : normalizedPath;
    for (const raw of allowList) {
        const entry = normalizeAbsolutePath(raw);
        if (!entry) continue;
        const candidate = isWindows ? entry.toLowerCase() : entry;
        if (target === candidate) return true;
        if (target.startsWith(candidate === '/' ? '/' : candidate + '/')) return true;
    }
    return false;
}

function policyFor(toolKind, fsPolicy = {}) {
    const kind = String(toolKind || '').toLowerCase();
    const defaults = { read: 'auto', list: 'auto', write: 'confirm', delete: 'confirm' };
    const allowedValues = new Set(['auto', 'confirm', 'deny']);
    const raw = fsPolicy && allowedValues.has(fsPolicy[kind]) ? fsPolicy[kind] : defaults[kind];
    if (!raw) return 'deny';
    if (kind === 'delete' && raw === 'auto') return 'confirm';
    return raw;
}

function computeUnifiedDiff(before, after, { maxLines = 200 } = {}) {
    const a = String(before ?? '').split('\n');
    const b = String(after ?? '').split('\n');
    const rows = [];
    let i = 0, j = 0;
    while (i < a.length || j < b.length) {
        if (i < a.length && j < b.length && a[i] === b[j]) {
            rows.push({ kind: 'ctx', line: a[i], oldNo: i + 1, newNo: j + 1 });
            i++; j++;
            continue;
        }
        let sync = 0;
        for (let k = 1; k <= 20 && (i + k <= a.length || j + k <= b.length); k++) {
            if (i + k < a.length && a[i + k] === b[j]) { sync = k; break; }
            if (j + k < b.length && a[i] === b[j + k]) { sync = -k; break; }
        }
        if (sync > 0) {
            for (let k = 0; k < sync; k++) rows.push({ kind: 'del', line: a[i + k], oldNo: i + k + 1 });
            i += sync;
        } else if (sync < 0) {
            for (let k = 0; k < -sync; k++) rows.push({ kind: 'add', line: b[j + k], newNo: j + k + 1 });
            j += -sync;
        } else if (i < a.length && j < b.length) {
            rows.push({ kind: 'del', line: a[i], oldNo: i + 1 });
            rows.push({ kind: 'add', line: b[j], newNo: j + 1 });
            i++; j++;
        } else if (i < a.length) {
            rows.push({ kind: 'del', line: a[i], oldNo: i + 1 });
            i++;
        } else {
            rows.push({ kind: 'add', line: b[j], newNo: j + 1 });
            j++;
        }
    }
    if (rows.length > maxLines) {
        const head = rows.slice(0, Math.floor(maxLines / 2));
        const tail = rows.slice(rows.length - Math.floor(maxLines / 2));
        return [...head, { kind: 'ctx', line: `... (${rows.length - head.length - tail.length} lines elided) ...` }, ...tail];
    }
    return rows;
}

describe('normalizeAbsolutePath (security trust boundary)', () => {
    it('accepts simple POSIX absolute paths', () => {
        assert.equal(normalizeAbsolutePath('/home/user/x'), '/home/user/x');
        assert.equal(normalizeAbsolutePath('/'), '/');
    });
    it('collapses redundant slashes and resolves "." segments', () => {
        assert.equal(normalizeAbsolutePath('/home//user/./x/'), '/home/user/x');
        assert.equal(normalizeAbsolutePath('/a/./b/./c'), '/a/b/c');
    });
    it('rejects relative paths', () => {
        assert.equal(normalizeAbsolutePath('home/user'), null);
        assert.equal(normalizeAbsolutePath('./x'), null);
        assert.equal(normalizeAbsolutePath('../x'), null);
        assert.equal(normalizeAbsolutePath(''), null);
    });
    it('rejects any ".." segments, anywhere', () => {
        assert.equal(normalizeAbsolutePath('/a/../b'), null);
        assert.equal(normalizeAbsolutePath('/..'), null);
        assert.equal(normalizeAbsolutePath('/a/b/../../c'), null);
        assert.equal(normalizeAbsolutePath('/a/b/..'), null);
    });
    it('rejects percent-encoded traversal sequences', () => {
        assert.equal(normalizeAbsolutePath('/a/%2e%2e/b'), null);
        assert.equal(normalizeAbsolutePath('/a/%2f%2e%2e/b'), null);
    });
    it('rejects NUL bytes', () => {
        assert.equal(normalizeAbsolutePath('/a/\0/b'), null);
    });
    it('rejects non-string input', () => {
        assert.equal(normalizeAbsolutePath(null), null);
        assert.equal(normalizeAbsolutePath(undefined), null);
        assert.equal(normalizeAbsolutePath(42), null);
        assert.equal(normalizeAbsolutePath({}), null);
    });
    it('normalizes Windows drive letters to lowercase and forward slashes', () => {
        assert.equal(normalizeAbsolutePath('C:\\Users\\Alice\\scratch'), 'c:/Users/Alice/scratch');
        assert.equal(normalizeAbsolutePath('C:/Users/Alice'), 'c:/Users/Alice');
    });
    it('rejects drive-relative Windows paths (no slash after drive)', () => {
        assert.equal(normalizeAbsolutePath('C:foo'), null);
    });
    it('rejects segments containing ":" (ADS / drive-confusion)', () => {
        assert.equal(normalizeAbsolutePath('/a/b:foo/c'), null);
    });
    it('rejects trailing dot/space on segments (Windows name-stripping tricks)', () => {
        assert.equal(normalizeAbsolutePath('/a/foo./b'), null);
        assert.equal(normalizeAbsolutePath('/a/foo /b'), null);
    });
    it('accepts UNC paths with host + share and normalizes the tail', () => {
        assert.equal(normalizeAbsolutePath('//host/share/dir'), '//host/share/dir');
        assert.equal(normalizeAbsolutePath('//host/share/'), '//host/share');
    });
    it('rejects UNC paths missing host or share', () => {
        assert.equal(normalizeAbsolutePath('//host/'), null);
        assert.equal(normalizeAbsolutePath('//'), null);
    });
    it('strips trailing slashes from non-root paths', () => {
        assert.equal(normalizeAbsolutePath('/home/user/'), '/home/user');
    });
});

describe('pathAllowed (allow-list matcher)', () => {
    const allow = ['/home/alice/scratch', '/tmp'];
    it('denies everything when allow-list is empty or missing', () => {
        assert.equal(pathAllowed('/home/alice/scratch/x', []), false);
        assert.equal(pathAllowed('/home/alice/scratch/x', null), false);
        assert.equal(pathAllowed('/home/alice/scratch/x', undefined), false);
    });
    it('allows exact match', () => {
        assert.equal(pathAllowed('/home/alice/scratch', allow), true);
        assert.equal(pathAllowed('/tmp', allow), true);
    });
    it('allows descendants of an allow-list entry', () => {
        assert.equal(pathAllowed('/home/alice/scratch/nested/file.txt', allow), true);
        assert.equal(pathAllowed('/tmp/foo.log', allow), true);
    });
    it('denies sibling paths with a shared prefix (no partial matches)', () => {
        assert.equal(pathAllowed('/home/alice/scratchpad', allow), false);
        assert.equal(pathAllowed('/tmpfoo', allow), false);
    });
    it('denies anything outside the list', () => {
        assert.equal(pathAllowed('/etc/passwd', allow), false);
        assert.equal(pathAllowed('/home/bob/x', allow), false);
    });
    it('is case-insensitive on Windows paths', () => {
        assert.equal(pathAllowed('c:/Users/Alice/scratch/x', ['C:/Users/Alice/Scratch']), true);
    });
    it('is case-sensitive on POSIX paths', () => {
        assert.equal(pathAllowed('/Home/Alice', ['/home/alice']), false);
    });
    it('silently ignores malformed allow-list entries', () => {
        assert.equal(pathAllowed('/tmp/x', ['not-absolute', '/tmp']), true);
    });
    it('rejects the malformed target itself', () => {
        assert.equal(pathAllowed('', allow), false);
        assert.equal(pathAllowed(null, allow), false);
    });
});

describe('policyFor (per-tool policy resolver)', () => {
    it('returns sensible defaults for unknown policy objects', () => {
        assert.equal(policyFor('read'), 'auto');
        assert.equal(policyFor('list'), 'auto');
        assert.equal(policyFor('write'), 'confirm');
        assert.equal(policyFor('delete'), 'confirm');
    });
    it('honors user-configured values when valid', () => {
        assert.equal(policyFor('read', { read: 'deny' }), 'deny');
        assert.equal(policyFor('write', { write: 'auto' }), 'auto');
    });
    it('ignores invalid values and falls back to defaults', () => {
        assert.equal(policyFor('read', { read: 'yolo' }), 'auto');
        assert.equal(policyFor('write', { write: null }), 'confirm');
    });
    it('NEVER allows delete to be auto (safety invariant)', () => {
        assert.equal(policyFor('delete', { delete: 'auto' }), 'confirm');
    });
    it('accepts deny for delete', () => {
        assert.equal(policyFor('delete', { delete: 'deny' }), 'deny');
    });
    it('normalizes case of the tool name', () => {
        assert.equal(policyFor('READ'), 'auto');
        assert.equal(policyFor('Delete', { delete: 'auto' }), 'confirm');
    });
});

describe('computeUnifiedDiff', () => {
    it('returns all context rows for identical inputs', () => {
        const rows = computeUnifiedDiff('a\nb\nc', 'a\nb\nc');
        assert.equal(rows.every(r => r.kind === 'ctx'), true);
        assert.equal(rows.length, 3);
    });
    it('marks added lines at the end', () => {
        const rows = computeUnifiedDiff('a\nb', 'a\nb\nc');
        const kinds = rows.map(r => r.kind).join(',');
        assert.ok(kinds.includes('add'));
    });
    it('marks deleted lines at the end', () => {
        const rows = computeUnifiedDiff('a\nb\nc', 'a\nb');
        const kinds = rows.map(r => r.kind).join(',');
        assert.ok(kinds.includes('del'));
    });
    it('marks a line replacement as del+add pair', () => {
        const rows = computeUnifiedDiff('a\nOLD\nc', 'a\nNEW\nc');
        const kinds = rows.map(r => r.kind);
        assert.ok(kinds.includes('del') && kinds.includes('add'));
    });
    it('truncates very large diffs with an elision marker', () => {
        const before = Array.from({ length: 300 }, (_, i) => `old-${i}`).join('\n');
        const after = Array.from({ length: 300 }, (_, i) => `new-${i}`).join('\n');
        const rows = computeUnifiedDiff(before, after, { maxLines: 50 });
        assert.ok(rows.length <= 51); // 50 rows + 1 marker
        assert.ok(rows.some(r => typeof r.line === 'string' && r.line.includes('elided')));
    });
    it('handles empty before (new file write)', () => {
        const rows = computeUnifiedDiff('', 'hello\nworld');
        // Empty string splits to [''] — one empty line — so the result includes
        // one del of that empty line and adds for the new content. Every line
        // from `after` must appear as an add.
        assert.ok(rows.filter(r => r.kind === 'add').length >= 2);
        assert.ok(rows.every(r => r.kind === 'add' || r.kind === 'del' || r.kind === 'ctx'));
    });
    it('handles empty after (full delete)', () => {
        const rows = computeUnifiedDiff('hello\nworld', '');
        assert.ok(rows.some(r => r.kind === 'del'));
    });
});
