/**
 * Unit tests for Command-X pure helper functions.
 * Run with: node --test test/helpers.test.mjs
 *
 * These functions are copied verbatim from index.js because the extension
 * file imports SillyTavern runtime modules (getContext, setExtensionPrompt,
 * etc.) that are unavailable in a plain Node.js environment.
 *
 * When the helpers in index.js change, keep these copies in sync.
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
    it('double-escapes are not applied (idempotent input)', () => assert.equal(escHtml('&amp;'), '&amp;amp;'));
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
    it('collapses whitespace', () => assert.equal(normalizeQuestKey('a  b'), 'a b'));
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
