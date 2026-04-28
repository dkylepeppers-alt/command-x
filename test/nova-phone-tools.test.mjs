/**
 * Unit tests for Nova phone-internal tool handlers (plan §4e).
 * Run with: node --test test/nova-phone-tools.test.mjs
 *
 * Inline-copies `buildNovaPhoneHandlers` from `index.js` under the
 * `/* === NOVA AGENT === *\/` section (right after
 * `buildNovaSoulMemoryHandlers`). Per AGENT_MEMORY inline-copy
 * convention: when the production helper changes, update this copy.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// -------- Inline copy of production helper --------

function buildNovaPhoneHandlers({
    loadNpcsImpl,
    mergeNpcsImpl,
    loadQuestsImpl,
    upsertQuestImpl,
    loadPlacesImpl,
    upsertPlaceImpl,
    loadMessagesImpl,
    pushMessageImpl,
    diagnoseImpl,
    messageHistoryLimitDefault = 50,
    messageHistoryLimitMax = 200,
} = {}) {
    const _loadNpcs = typeof loadNpcsImpl === 'function' ? loadNpcsImpl : () => [];
    const _mergeNpcs = typeof mergeNpcsImpl === 'function' ? mergeNpcsImpl : null;
    const _loadQuests = typeof loadQuestsImpl === 'function' ? loadQuestsImpl : () => [];
    const _upsertQuest = typeof upsertQuestImpl === 'function' ? upsertQuestImpl : null;
    const _loadPlaces = typeof loadPlacesImpl === 'function' ? loadPlacesImpl : () => [];
    const _upsertPlace = typeof upsertPlaceImpl === 'function' ? upsertPlaceImpl : null;
    const _loadMessages = typeof loadMessagesImpl === 'function' ? loadMessagesImpl : () => [];
    const _pushMessage = typeof pushMessageImpl === 'function' ? pushMessageImpl : null;
    const _diagnose = typeof diagnoseImpl === 'function' ? diagnoseImpl : (() => ({ ok: true }));

    const clampLimit = (raw) => {
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) return messageHistoryLimitDefault;
        return Math.max(1, Math.min(Math.floor(n), messageHistoryLimitMax));
    };

    const safeName = (v) => (typeof v === 'string' ? v.trim() : '');
    const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
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
                const type = from === 'user' ? 'sent' : 'received';
                _pushMessage(cleanName, type, text, null);
                return { ok: true, contactName: cleanName, from };
            } catch (err) {
                return { error: String(err?.message || err) };
            }
        },
        phone_diagnose: async () => {
            try {
                const report = _diagnose();
                if (!isObject(report)) return { error: 'diagnostics unavailable' };
                return report;
            } catch (err) {
                return { error: String(err?.message || err) };
            }
        },
    };
}

// -------- Test helpers --------

/** Build a test harness with recording stubs for every injected dep.
 *
 *  Sentinels:
 *  - `undefined` (i.e. omit the override key)   → harness supplies a default
 *    recording stub to the factory, exercising the success path.
 *  - `null`                                      → harness passes `undefined`
 *    to the factory so the factory's own fallback (`null`) kicks in — this is
 *    the "no impl supplied" branch that makes write handlers return
 *    `{ error: '<name> unavailable' }`. Do NOT simplify `=== null ? undefined`
 *    to `|| defaultStub`; that would coerce the null sentinel into the stub
 *    and break the "reports unavailable" test for every write handler.
 *  - a function                                   → use it verbatim.
 */
function makeHarness(overrides = {}) {
    const state = {
        npcs: overrides.npcs || [],
        quests: overrides.quests || [],
        places: overrides.places || [],
        messagesByContact: overrides.messagesByContact || new Map(),
        mergeCalls: [],
        upsertQuestCalls: [],
        upsertPlaceCalls: [],
        pushMessageCalls: [],
        diagnoseCalls: 0,
    };
    const handlers = buildNovaPhoneHandlers({
        loadNpcsImpl: overrides.loadNpcsImpl || (() => state.npcs),
        mergeNpcsImpl: overrides.mergeNpcsImpl === null ? undefined : (overrides.mergeNpcsImpl || ((list) => {
            state.mergeCalls.push(list);
            for (const incoming of list) {
                const idx = state.npcs.findIndex(n => n.name === incoming.name);
                if (idx >= 0) state.npcs[idx] = { ...state.npcs[idx], ...incoming };
                else state.npcs.push({ ...incoming });
            }
        })),
        loadQuestsImpl: overrides.loadQuestsImpl || (() => state.quests),
        upsertQuestImpl: overrides.upsertQuestImpl === null ? undefined : (overrides.upsertQuestImpl || ((q) => {
            state.upsertQuestCalls.push(q);
            const idx = state.quests.findIndex(existing => existing.id === q.id);
            const clean = { ...q, updatedAt: 12345 };
            if (idx >= 0) state.quests[idx] = { ...state.quests[idx], ...clean };
            else state.quests.push(clean);
            return clean;
        })),
        loadPlacesImpl: overrides.loadPlacesImpl || (() => state.places),
        upsertPlaceImpl: overrides.upsertPlaceImpl === null ? undefined : (overrides.upsertPlaceImpl || ((p) => {
            state.upsertPlaceCalls.push(p);
            const clean = { ...p, id: `place_${p.name}` };
            state.places.push(clean);
            return clean;
        })),
        loadMessagesImpl: overrides.loadMessagesImpl || ((name) => state.messagesByContact.get(name) || []),
        pushMessageImpl: overrides.pushMessageImpl === null ? undefined : (overrides.pushMessageImpl || ((name, type, text, mesId) => {
            state.pushMessageCalls.push({ name, type, text, mesId });
            const arr = state.messagesByContact.get(name) || [];
            arr.push({ type, text, mesId });
            state.messagesByContact.set(name, arr);
        })),
        diagnoseImpl: overrides.diagnoseImpl || (() => {
            state.diagnoseCalls += 1;
            return {
                ok: true,
                stores: {
                    npcs: state.npcs.length,
                    quests: state.quests.length,
                    places: state.places.length,
                },
            };
        }),
        ...(overrides.factoryOpts || {}),
    });
    return { state, handlers };
}

// -------- Tests --------

describe('buildNovaPhoneHandlers — factory shape', () => {
    it('returns all 9 phone_* handlers as async functions', () => {
        const { handlers } = makeHarness();
        const expected = [
            'phone_list_npcs', 'phone_write_npc',
            'phone_list_quests', 'phone_write_quest',
            'phone_list_places', 'phone_write_place',
            'phone_list_messages', 'phone_inject_message',
            'phone_diagnose',
        ];
        for (const name of expected) {
            assert.equal(typeof handlers[name], 'function', `${name} is a function`);
            const result = handlers[name]({});
            assert.ok(result && typeof result.then === 'function', `${name} returns a Promise`);
        }
    });

    it('factory with no opts does not throw and returns handlers', () => {
        const h = buildNovaPhoneHandlers();
        assert.equal(typeof h.phone_list_npcs, 'function');
    });
});

describe('phone_diagnose', () => {
    it('returns the diagnostic report from the injected implementation', async () => {
        const { state, handlers } = makeHarness({
            npcs: [{ name: 'Aria' }],
            quests: [{ id: 'q1' }],
            places: [{ name: 'Cafe' }, { name: 'Library' }],
        });
        const result = await handlers.phone_diagnose();
        assert.equal(state.diagnoseCalls, 1);
        assert.deepEqual(result, {
            ok: true,
            stores: { npcs: 1, quests: 1, places: 2 },
        });
    });

    it('returns an error instead of throwing when diagnostics throw', async () => {
        const { handlers } = makeHarness({ diagnoseImpl: () => { throw new Error('diagnose boom'); } });
        const result = await handlers.phone_diagnose();
        assert.equal(result.error, 'diagnose boom');
    });

    it('rejects non-object diagnostic reports', async () => {
        const { handlers } = makeHarness({ diagnoseImpl: () => null });
        const result = await handlers.phone_diagnose();
        assert.equal(result.error, 'diagnostics unavailable');
    });
});

describe('phone_list_npcs', () => {
    it('returns stored NPCs verbatim', async () => {
        const { handlers } = makeHarness({ npcs: [{ name: 'Aria' }, { name: 'Bren' }] });
        const result = await handlers.phone_list_npcs();
        assert.deepEqual(result, { npcs: [{ name: 'Aria' }, { name: 'Bren' }] });
    });

    it('returns empty array when store is empty', async () => {
        const { handlers } = makeHarness();
        const result = await handlers.phone_list_npcs();
        assert.deepEqual(result, { npcs: [] });
    });

    it('coerces non-array store to []', async () => {
        const { handlers } = makeHarness({ loadNpcsImpl: () => null });
        const result = await handlers.phone_list_npcs();
        assert.deepEqual(result, { npcs: [] });
    });

    it('never throws when load throws', async () => {
        const { handlers } = makeHarness({ loadNpcsImpl: () => { throw new Error('boom'); } });
        const result = await handlers.phone_list_npcs();
        assert.equal(result.error, 'boom');
    });
});

describe('phone_write_npc', () => {
    it('merges an NPC with fields and reports ok', async () => {
        const { state, handlers } = makeHarness();
        const result = await handlers.phone_write_npc({ name: 'Aria', fields: { mood: '😊', status: 'online' } });
        assert.deepEqual(result, { ok: true, name: 'Aria' });
        assert.equal(state.mergeCalls.length, 1);
        assert.deepEqual(state.mergeCalls[0], [{ name: 'Aria', mood: '😊', status: 'online' }]);
    });

    it('passes name from the top-level arg even if fields.name differs (name is authoritative)', async () => {
        const { state, handlers } = makeHarness();
        await handlers.phone_write_npc({ name: 'Aria', fields: { name: 'WRONG', mood: 'x' } });
        assert.equal(state.mergeCalls[0][0].name, 'Aria');
    });

    it('rejects empty name', async () => {
        const { handlers } = makeHarness();
        assert.match((await handlers.phone_write_npc({ name: '', fields: {} })).error, /name must be/);
        assert.match((await handlers.phone_write_npc({ name: '   ', fields: {} })).error, /name must be/);
        assert.match((await handlers.phone_write_npc({ fields: {} })).error, /name must be/);
    });

    it('rejects non-object fields', async () => {
        const { handlers } = makeHarness();
        assert.match((await handlers.phone_write_npc({ name: 'A' })).error, /fields must be/);
        assert.match((await handlers.phone_write_npc({ name: 'A', fields: 'nope' })).error, /fields must be/);
        assert.match((await handlers.phone_write_npc({ name: 'A', fields: [] })).error, /fields must be/);
        assert.match((await handlers.phone_write_npc({ name: 'A', fields: null })).error, /fields must be/);
    });

    it('surfaces merge errors without throwing', async () => {
        const { handlers } = makeHarness({ mergeNpcsImpl: () => { throw new Error('merge-fail'); } });
        const r = await handlers.phone_write_npc({ name: 'A', fields: { mood: 'x' } });
        assert.equal(r.error, 'merge-fail');
    });

    it('reports unavailable when no mergeNpcs implementation is supplied', async () => {
        const { handlers } = makeHarness({ mergeNpcsImpl: null });
        const r = await handlers.phone_write_npc({ name: 'A', fields: {} });
        assert.match(r.error, /mergeNpcs unavailable/);
    });

    it('handles missing args object by defaulting to {}', async () => {
        const { handlers } = makeHarness();
        const r = await handlers.phone_write_npc();
        assert.match(r.error, /name must be/);
    });
});

describe('phone_list_quests', () => {
    it('returns stored quests', async () => {
        const { handlers } = makeHarness({ quests: [{ id: 'q1', title: 'Find Aria' }] });
        const result = await handlers.phone_list_quests();
        assert.equal(result.quests.length, 1);
        assert.equal(result.quests[0].id, 'q1');
    });

    it('never throws', async () => {
        const { handlers } = makeHarness({ loadQuestsImpl: () => { throw new Error('x'); } });
        const r = await handlers.phone_list_quests();
        assert.equal(r.error, 'x');
    });
});

describe('phone_write_quest', () => {
    it('upserts a quest and returns the canonical result', async () => {
        const { state, handlers } = makeHarness();
        const result = await handlers.phone_write_quest({ id: 'q1', fields: { title: 'Deliver', status: 'active' } });
        assert.equal(result.ok, true);
        assert.equal(result.id, 'q1');
        assert.equal(result.quest.title, 'Deliver');
        assert.equal(state.upsertQuestCalls.length, 1);
        assert.equal(state.upsertQuestCalls[0].id, 'q1');
    });

    it('id is authoritative even when fields.id differs', async () => {
        const { state, handlers } = makeHarness();
        await handlers.phone_write_quest({ id: 'q1', fields: { id: 'WRONG', title: 'x' } });
        assert.equal(state.upsertQuestCalls[0].id, 'q1');
    });

    it('rejects empty id and non-object fields', async () => {
        const { handlers } = makeHarness();
        assert.match((await handlers.phone_write_quest({ id: '', fields: {} })).error, /id must be/);
        assert.match((await handlers.phone_write_quest({ id: 'q' })).error, /fields must be/);
        assert.match((await handlers.phone_write_quest({ id: 'q', fields: 42 })).error, /fields must be/);
    });

    it('surfaces upsert errors', async () => {
        const { handlers } = makeHarness({ upsertQuestImpl: () => { throw new Error('ufail'); } });
        const r = await handlers.phone_write_quest({ id: 'q', fields: {} });
        assert.equal(r.error, 'ufail');
    });

    it('tolerates null return from upsertQuest (fields.quest = null)', async () => {
        const { handlers } = makeHarness({ upsertQuestImpl: () => null });
        const r = await handlers.phone_write_quest({ id: 'q', fields: {} });
        assert.equal(r.ok, true);
        assert.equal(r.quest, null);
    });
});

describe('phone_list_places', () => {
    it('returns stored places', async () => {
        const { handlers } = makeHarness({ places: [{ id: 'p1', name: 'Café' }] });
        const r = await handlers.phone_list_places();
        assert.equal(r.places.length, 1);
    });
});

describe('phone_write_place', () => {
    it('upserts a place and returns it', async () => {
        const { state, handlers } = makeHarness();
        const r = await handlers.phone_write_place({ name: 'Café', fields: { emoji: '☕' } });
        assert.equal(r.ok, true);
        assert.equal(r.place.name, 'Café');
        assert.equal(r.place.emoji, '☕');
        assert.equal(state.upsertPlaceCalls.length, 1);
    });

    it('returns error when upsertPlace returns null (invalid place)', async () => {
        const { handlers } = makeHarness({ upsertPlaceImpl: () => null });
        const r = await handlers.phone_write_place({ name: 'Café', fields: {} });
        assert.match(r.error, /upsert rejected/);
    });

    it('validates inputs', async () => {
        const { handlers } = makeHarness();
        assert.match((await handlers.phone_write_place({ name: '', fields: {} })).error, /name must be/);
        assert.match((await handlers.phone_write_place({ name: 'x' })).error, /fields must be/);
    });
});

describe('phone_list_messages', () => {
    it('returns messages for a contact with total count', async () => {
        const messagesByContact = new Map([
            ['Aria', [{ type: 'sent', text: 'hi' }, { type: 'received', text: 'hey' }]],
        ]);
        const { handlers } = makeHarness({ messagesByContact });
        const r = await handlers.phone_list_messages({ contactName: 'Aria' });
        assert.equal(r.contactName, 'Aria');
        assert.equal(r.total, 2);
        assert.equal(r.messages.length, 2);
    });

    it('applies default limit when none supplied', async () => {
        const long = Array.from({ length: 75 }, (_, i) => ({ type: 'sent', text: `m${i}` }));
        const { handlers } = makeHarness({ messagesByContact: new Map([['A', long]]) });
        const r = await handlers.phone_list_messages({ contactName: 'A' });
        assert.equal(r.total, 75);
        assert.equal(r.messages.length, 50); // default cap
        assert.equal(r.messages[0].text, 'm25'); // last 50
        assert.equal(r.messages[49].text, 'm74');
    });

    it('caps custom limit at max (200)', async () => {
        const long = Array.from({ length: 300 }, (_, i) => ({ type: 'sent', text: `m${i}` }));
        const { handlers } = makeHarness({ messagesByContact: new Map([['A', long]]) });
        const r = await handlers.phone_list_messages({ contactName: 'A', limit: 500 });
        assert.equal(r.messages.length, 200);
        assert.equal(r.total, 300);
    });

    it('clamps limit floor to 1', async () => {
        const { handlers } = makeHarness({ messagesByContact: new Map([['A', [{ text: 'x' }, { text: 'y' }]]]) });
        const r1 = await handlers.phone_list_messages({ contactName: 'A', limit: 0 });
        // 0 falls through to default (50), per spec — non-positive → default
        assert.equal(r1.messages.length, 2);
        const r2 = await handlers.phone_list_messages({ contactName: 'A', limit: 1 });
        assert.equal(r2.messages.length, 1);
    });

    it('rejects missing or empty contactName', async () => {
        const { handlers } = makeHarness();
        assert.match((await handlers.phone_list_messages({ contactName: '' })).error, /contactName must be/);
        assert.match((await handlers.phone_list_messages({})).error, /contactName must be/);
    });

    it('returns empty messages array with total=0 when contact has no history', async () => {
        const { handlers } = makeHarness();
        const r = await handlers.phone_list_messages({ contactName: 'Nobody' });
        assert.deepEqual(r.messages, []);
        assert.equal(r.total, 0);
    });

    it('respects custom messageHistoryLimit options', async () => {
        const long = Array.from({ length: 10 }, (_, i) => ({ text: `m${i}` }));
        const { handlers } = makeHarness({
            messagesByContact: new Map([['A', long]]),
            factoryOpts: { messageHistoryLimitDefault: 3, messageHistoryLimitMax: 5 },
        });
        const rDef = await handlers.phone_list_messages({ contactName: 'A' });
        assert.equal(rDef.messages.length, 3);
        const rCap = await handlers.phone_list_messages({ contactName: 'A', limit: 99 });
        assert.equal(rCap.messages.length, 5);
    });
});

describe('phone_inject_message', () => {
    it('pushes a user-origin message as type "sent"', async () => {
        const { state, handlers } = makeHarness();
        const r = await handlers.phone_inject_message({ contactName: 'Aria', from: 'user', text: 'hey' });
        assert.deepEqual(r, { ok: true, contactName: 'Aria', from: 'user' });
        assert.equal(state.pushMessageCalls.length, 1);
        assert.deepEqual(state.pushMessageCalls[0], { name: 'Aria', type: 'sent', text: 'hey', mesId: null });
    });

    it('pushes a contact-origin message as type "received"', async () => {
        const { state, handlers } = makeHarness();
        await handlers.phone_inject_message({ contactName: 'Aria', from: 'contact', text: 'hello back' });
        assert.equal(state.pushMessageCalls[0].type, 'received');
    });

    it('rejects unknown from values', async () => {
        const { handlers } = makeHarness();
        assert.match((await handlers.phone_inject_message({ contactName: 'A', from: 'bot', text: 'x' })).error, /from must be/);
        assert.match((await handlers.phone_inject_message({ contactName: 'A', from: '', text: 'x' })).error, /from must be/);
        assert.match((await handlers.phone_inject_message({ contactName: 'A', text: 'x' })).error, /from must be/);
    });

    it('rejects empty or non-string text', async () => {
        const { handlers } = makeHarness();
        assert.match((await handlers.phone_inject_message({ contactName: 'A', from: 'user', text: '' })).error, /non-empty/);
        assert.match((await handlers.phone_inject_message({ contactName: 'A', from: 'user', text: '   ' })).error, /non-empty/);
        assert.match((await handlers.phone_inject_message({ contactName: 'A', from: 'user', text: 123 })).error, /text must be a string/);
    });

    it('rejects empty contactName', async () => {
        const { handlers } = makeHarness();
        assert.match((await handlers.phone_inject_message({ contactName: '', from: 'user', text: 'x' })).error, /contactName must be/);
    });

    it('surfaces push errors without throwing', async () => {
        const { handlers } = makeHarness({ pushMessageImpl: () => { throw new Error('db-full'); } });
        const r = await handlers.phone_inject_message({ contactName: 'A', from: 'user', text: 'x' });
        assert.equal(r.error, 'db-full');
    });
});

describe('never-throws contract (arg fuzzing)', () => {
    const weirdArgs = [
        undefined, null, 0, '', 'str', [], {},
        { contactName: null, from: null, text: null },
        { name: 1234, fields: 'nope' },
        { id: {}, fields: [] },
    ];

    it('every handler resolves for every weird arg without throwing', async () => {
        const { handlers } = makeHarness();
        const names = Object.keys(handlers);
        for (const name of names) {
            for (const arg of weirdArgs) {
                const result = await handlers[name](arg);
                assert.equal(typeof result, 'object', `${name}(${JSON.stringify(arg)}) returned non-object`);
                assert.ok(result !== null, `${name}(${JSON.stringify(arg)}) returned null`);
                // Must be either a success shape or an { error: string } shape.
                if (!('ok' in result) && !('npcs' in result) && !('quests' in result) && !('places' in result) && !('messages' in result)) {
                    assert.equal(typeof result.error, 'string', `${name} returned unknown shape: ${JSON.stringify(result)}`);
                }
            }
        }
    });
});

describe('source-shape integration (guardrails against drift from index.js)', () => {
    it('handler keys exactly match NOVA_TOOLS phone_* tool names', () => {
        // Hard-coded list mirrors NOVA_TOOLS backend:'phone' entries in index.js.
        // If these diverge, the integration assertion in nova-ui-wiring.test.mjs
        // will flag it — this test fails loudly here first.
        const expected = new Set([
            'phone_list_npcs', 'phone_write_npc',
            'phone_list_quests', 'phone_write_quest',
            'phone_list_places', 'phone_write_place',
            'phone_list_messages', 'phone_inject_message',
            'phone_diagnose',
        ]);
        const { handlers } = makeHarness();
        const actual = new Set(Object.keys(handlers));
        assert.deepEqual([...actual].sort(), [...expected].sort());
    });
});
