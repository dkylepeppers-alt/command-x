/**
 * Unit tests for Nova ST-API tool handlers (plan §4d).
 * Run with: node --test test/nova-st-tools.test.mjs
 *
 * Inline-copies `buildNovaStTools` from `index.js` under the
 * `/* === NOVA AGENT === *\/` section (right after `buildNovaFsHandlers`).
 * Per AGENT_MEMORY inline-copy convention: when the production helper
 * changes, update this copy.
 *
 * The handlers do NOT touch the network, the plugin, or localStorage —
 * everything routes through `getContext()` + an `executeSlash` function
 * that we mock here. So no fetch harness is needed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// -------- Inline copy of production helper --------

function buildNovaStTools({
    ctxImpl,
    executeSlashImpl,
    listProfilesImpl,
} = {}) {
    const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
    const safeArgs = (v) => (isObject(v) ? v : {});
    const safeName = (v) => (typeof v === 'string' ? v.trim() : '');

    const getCtx = () => {
        if (ctxImpl !== undefined && ctxImpl !== null) {
            return typeof ctxImpl === 'function' ? ctxImpl() : ctxImpl;
        }
        return null;
    };
    const getSlash = async () => {
        if (typeof executeSlashImpl === 'function') return executeSlashImpl;
        return null;
    };
    const getListProfiles = () => {
        if (typeof listProfilesImpl === 'function') return listProfilesImpl;
        return null;
    };

    const escSlashArg = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    const pipeOf = (res) => {
        if (res && typeof res === 'object' && 'pipe' in res) return String(res.pipe ?? '');
        if (typeof res === 'string') return res;
        return '';
    };

    const summarizeCharacter = (c) => {
        if (!isObject(c)) return null;
        return {
            name: typeof c.name === 'string' ? c.name : '',
            avatar: typeof c.avatar === 'string' ? c.avatar : '',
            description: typeof c.description === 'string' ? c.description.slice(0, 280) : '',
            tags: Array.isArray(c.tags) ? c.tags.slice(0, 16) : [],
            create_date: typeof c.create_date === 'string' ? c.create_date : '',
        };
    };

    return {
        st_list_characters: async () => {
            const ctx = getCtx();
            if (!ctx) return { error: 'no-context' };
            const list = Array.isArray(ctx.characters) ? ctx.characters : [];
            const characters = list.map(summarizeCharacter).filter(c => c && c.name);
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
            return { name: cleanName, card };
        },
        st_write_character: async (rawArgs) => {
            const { name } = safeArgs(rawArgs);
            const cleanName = safeName(name);
            if (!cleanName) return { error: 'name must be a non-empty string' };
            return {
                error: 'not-implemented',
                tool: 'st_write_character',
                hint: 'st_write_character is not wired in this build. As a workaround, '
                    + `use fs_write at SillyTavern/data/<user>/characters/${cleanName}.json `
                    + 'with the full character-card JSON. Note: this bypasses ST\'s PNG '
                    + 'metadata re-embed and chat-index update; restart ST or use '
                    + '/character-list to refresh the UI.',
            };
        },
        st_list_worldbooks: async () => {
            const exec = await getSlash();
            if (typeof exec === 'function') {
                try {
                    const res = await exec('/world list');
                    const pipe = pipeOf(res);
                    if (pipe) {
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
            const exec = await getSlash();
            if (typeof exec === 'function') {
                try {
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
            const { name } = safeArgs(rawArgs);
            const cleanName = safeName(name);
            if (!cleanName) return { error: 'name must be a non-empty string' };
            return {
                error: 'not-implemented',
                tool: 'st_write_worldbook',
                hint: 'st_write_worldbook is not wired in this build. As a workaround, '
                    + `use fs_write at SillyTavern/data/<user>/worlds/${cleanName}.json `
                    + 'with the full worldbook JSON. Note: this bypasses ST\'s uid '
                    + 'normalisation; restart ST or run /world list to refresh the UI.',
            };
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
                const cmd = `/profile-get name="${escSlashArg(cleanName)}"`;
                const res = await exec(cmd);
                const pipe = pipeOf(res);
                if (!pipe) return { error: 'not-found', name: cleanName };
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

// -------- Helpers for tests --------

function makeCtx(over = {}) {
    return {
        name1: 'User',
        characterId: 0,
        groupId: null,
        chatId: 'chat-001',
        characters: [
            { name: 'Alice', avatar: 'a.png', description: 'A.', tags: ['friend'], create_date: '2024-01-01' },
            { name: 'Bob', avatar: 'b.png', description: 'B.', tags: ['rival'], create_date: '2024-02-02' },
        ],
        chat: [
            { name: 'User', is_user: true, is_system: false, mes: 'hi', send_date: 't1' },
            { name: 'Alice', is_user: false, is_system: false, mes: 'hello', send_date: 't2' },
            { name: 'system', is_user: false, is_system: true, mes: 'sysmsg', send_date: 't3' },
        ],
        ...over,
    };
}

// -------- Tests --------

describe('buildNovaStTools — handler shape', () => {
    it('returns all 10 named handlers', () => {
        const handlers = buildNovaStTools({});
        for (const n of [
            'st_list_characters', 'st_read_character', 'st_write_character',
            'st_list_worldbooks', 'st_read_worldbook', 'st_write_worldbook',
            'st_run_slash', 'st_get_context',
            'st_list_profiles', 'st_get_profile',
        ]) {
            assert.equal(typeof handlers[n], 'function', `${n} should be a function`);
        }
    });

    it('handlers never throw on undefined / null / primitive args (fuzz)', async () => {
        const handlers = buildNovaStTools({
            ctxImpl: () => makeCtx(),
            executeSlashImpl: async () => ({ pipe: '' }),
            listProfilesImpl: async () => ({ ok: true, profiles: [] }),
        });
        const inputs = [undefined, null, 0, 1, '', 'a', true, false, NaN, [], ['x'], {}, { name: null }, { name: 0 }];
        for (const [name, h] of Object.entries(handlers)) {
            for (const arg of inputs) {
                const r = await h(arg);
                assert.ok(r && typeof r === 'object', `${name}(${JSON.stringify(arg)}) returned non-object`);
                // Each result must be either a closed-enum error or a known-shape success.
                const okShape = ('error' in r)
                    || ('ok' in r) || ('characters' in r) || ('worldbooks' in r)
                    || ('profiles' in r) || ('character' in r) || ('book' in r)
                    || ('persona' in r) || ('count' in r) || ('messages' in r)
                    || ('card' in r) || ('profile' in r) || ('raw' in r) || ('name' in r);
                assert.ok(okShape, `${name}: unexpected result shape ${JSON.stringify(r)}`);
            }
        }
    });
});

describe('st_list_characters', () => {
    it('returns a stable summary shape from ctx.characters', async () => {
        const handlers = buildNovaStTools({ ctxImpl: () => makeCtx() });
        const r = await handlers.st_list_characters();
        assert.equal(r.count, 2);
        assert.deepEqual(r.characters[0].name, 'Alice');
        assert.equal(r.characters[0].tags[0], 'friend');
        // Description is truncated to 280 chars even if the source is longer.
        const big = 'x'.repeat(1000);
        const ctx = makeCtx({ characters: [{ name: 'Big', description: big }] });
        const r2 = await buildNovaStTools({ ctxImpl: () => ctx }).st_list_characters();
        assert.equal(r2.characters[0].description.length, 280);
    });

    it('returns no-context when getContext is unavailable', async () => {
        const r = await buildNovaStTools({}).st_list_characters();
        assert.equal(r.error, 'no-context');
    });

    it('skips non-object / unnamed entries', async () => {
        const ctx = makeCtx({ characters: [null, 0, { name: 'Real' }, { description: 'no-name' }, 'str'] });
        const r = await buildNovaStTools({ ctxImpl: () => ctx }).st_list_characters();
        assert.equal(r.count, 1);
        assert.equal(r.characters[0].name, 'Real');
    });
});

describe('st_read_character', () => {
    it('returns the full card on match', async () => {
        const handlers = buildNovaStTools({ ctxImpl: () => makeCtx() });
        const r = await handlers.st_read_character({ name: 'Alice' });
        assert.equal(r.name, 'Alice');
        assert.equal(r.card.avatar, 'a.png');
    });

    it('returns not-found on miss', async () => {
        const handlers = buildNovaStTools({ ctxImpl: () => makeCtx() });
        const r = await handlers.st_read_character({ name: 'Nobody' });
        assert.equal(r.error, 'not-found');
        assert.equal(r.name, 'Nobody');
    });

    it('rejects empty name', async () => {
        const handlers = buildNovaStTools({ ctxImpl: () => makeCtx() });
        const r = await handlers.st_read_character({ name: '' });
        assert.match(r.error, /non-empty string/);
    });

    it('returns no-context when ctx unavailable but name present', async () => {
        const r = await buildNovaStTools({}).st_read_character({ name: 'Alice' });
        assert.equal(r.error, 'no-context');
    });
});

describe('st_write_character — deferred not-implemented surface', () => {
    it('returns closed-enum not-implemented with fs_write hint when name valid', async () => {
        const handlers = buildNovaStTools({});
        const r = await handlers.st_write_character({ name: 'Alice', card: {} });
        assert.equal(r.error, 'not-implemented');
        assert.equal(r.tool, 'st_write_character');
        assert.match(r.hint, /fs_write/);
        assert.match(r.hint, /Alice\.json/);
    });

    it('rejects empty name BEFORE returning the not-implemented hint', async () => {
        const r = await buildNovaStTools({}).st_write_character({ name: '' });
        assert.match(r.error, /non-empty string/);
        assert.notEqual(r.error, 'not-implemented');
    });
});

describe('st_list_worldbooks', () => {
    it('parses a JSON array pipe', async () => {
        const exec = async () => ({ pipe: JSON.stringify(['World A', 'World B']) });
        const r = await buildNovaStTools({ executeSlashImpl: exec }).st_list_worldbooks();
        assert.deepEqual(r.worldbooks, ['World A', 'World B']);
        assert.equal(r.count, 2);
    });

    it('parses a newline-separated pipe', async () => {
        const exec = async () => ({ pipe: 'World A\nWorld B\nWorld C' });
        const r = await buildNovaStTools({ executeSlashImpl: exec }).st_list_worldbooks();
        assert.deepEqual(r.worldbooks, ['World A', 'World B', 'World C']);
    });

    it('parses a comma-separated pipe', async () => {
        const exec = async () => ({ pipe: 'A, B, C' });
        const r = await buildNovaStTools({ executeSlashImpl: exec }).st_list_worldbooks();
        assert.deepEqual(r.worldbooks, ['A', 'B', 'C']);
    });

    it('returns an empty list with hint when no slash exec is available', async () => {
        const r = await buildNovaStTools({}).st_list_worldbooks();
        assert.deepEqual(r.worldbooks, []);
        assert.equal(r.count, 0);
        assert.match(r.hint, /fs_list/);
    });

    it('returns an empty list with hint when slash returns empty pipe', async () => {
        const exec = async () => ({ pipe: '' });
        const r = await buildNovaStTools({ executeSlashImpl: exec }).st_list_worldbooks();
        assert.deepEqual(r.worldbooks, []);
        assert.match(r.hint, /fs_list/);
    });

    it('survives a slash executor that throws', async () => {
        const exec = async () => { throw new Error('boom'); };
        const r = await buildNovaStTools({ executeSlashImpl: exec }).st_list_worldbooks();
        assert.deepEqual(r.worldbooks, []);
        assert.match(r.hint, /fs_list/);
    });
});

describe('st_read_worldbook', () => {
    it('returns parsed JSON when the slash returns JSON', async () => {
        const exec = async (cmd) => {
            assert.match(cmd, /^\/world get name="My World"$/);
            return { pipe: JSON.stringify({ entries: [{ uid: 0, key: ['k'] }] }) };
        };
        const r = await buildNovaStTools({ executeSlashImpl: exec }).st_read_worldbook({ name: 'My World' });
        assert.equal(r.name, 'My World');
        assert.equal(r.book.entries[0].key[0], 'k');
    });

    it('quotes embedded double-quotes in the name', async () => {
        let captured = '';
        const exec = async (cmd) => { captured = cmd; return { pipe: '{}' }; };
        await buildNovaStTools({ executeSlashImpl: exec }).st_read_worldbook({ name: 'Has "quotes"' });
        assert.match(captured, /name="Has \\"quotes\\""/);
    });

    it('escapes backslashes BEFORE quotes (no closing-quote escape attack)', async () => {
        // A name ending in `\` would, with naive `.replace(/"/g, '\\"')`,
        // produce `name="foo\"` — escaping the closing quote and breaking
        // the slash parser. With backslash-first escaping it becomes
        // `name="foo\\"` which is safe.
        let captured = '';
        const exec = async (cmd) => { captured = cmd; return { pipe: '{}' }; };
        await buildNovaStTools({ executeSlashImpl: exec }).st_read_worldbook({ name: 'foo\\' });
        // The captured command should have the trailing backslash doubled.
        assert.ok(captured.endsWith('name="foo\\\\"'),
            `Expected backslash to be doubled, got: ${captured}`);
        // Mixed: backslash + quote in the same string.
        captured = '';
        await buildNovaStTools({ executeSlashImpl: exec }).st_read_worldbook({ name: 'a\\"b' });
        // Source string: a \ " b → escape \\ first → a \\ " b → then escape " → a \\ \" b
        assert.ok(captured.endsWith('name="a\\\\\\"b"'),
            `Expected backslash-then-quote escaping, got: ${captured}`);
    });

    it('returns raw truncated pipe when not parseable as JSON', async () => {
        const big = 'x'.repeat(5000);
        const exec = async () => ({ pipe: big });
        const r = await buildNovaStTools({ executeSlashImpl: exec }).st_read_worldbook({ name: 'X' });
        assert.equal(r.raw.length, 4000);
    });

    it('rejects empty name', async () => {
        const r = await buildNovaStTools({ executeSlashImpl: async () => '{}' }).st_read_worldbook({ name: '' });
        assert.match(r.error, /non-empty string/);
    });

    it('returns not-found when slash unavailable', async () => {
        const r = await buildNovaStTools({}).st_read_worldbook({ name: 'X' });
        assert.equal(r.error, 'not-found');
        assert.match(r.hint, /fs_read/);
    });
});

describe('st_write_worldbook — deferred not-implemented surface', () => {
    it('returns closed-enum not-implemented with fs_write hint', async () => {
        const r = await buildNovaStTools({}).st_write_worldbook({ name: 'Lore', book: {} });
        assert.equal(r.error, 'not-implemented');
        assert.equal(r.tool, 'st_write_worldbook');
        assert.match(r.hint, /fs_write/);
        assert.match(r.hint, /Lore\.json/);
    });
});

describe('st_run_slash', () => {
    it('forwards the command and returns a string pipe', async () => {
        let captured = '';
        const exec = async (cmd) => { captured = cmd; return { pipe: 'ok' }; };
        const r = await buildNovaStTools({ executeSlashImpl: exec }).st_run_slash({ command: '/echo hi' });
        assert.equal(captured, '/echo hi');
        assert.equal(r.ok, true);
        assert.equal(r.pipe, 'ok');
    });

    it('handles a string-pipe response (no .pipe field)', async () => {
        const exec = async () => 'plain string';
        const r = await buildNovaStTools({ executeSlashImpl: exec }).st_run_slash({ command: '/x' });
        assert.equal(r.pipe, 'plain string');
    });

    it('rejects empty command', async () => {
        const r = await buildNovaStTools({ executeSlashImpl: async () => '' }).st_run_slash({ command: '' });
        assert.match(r.error, /non-empty/);
    });

    it('rejects whitespace-only command', async () => {
        const r = await buildNovaStTools({ executeSlashImpl: async () => '' }).st_run_slash({ command: '   ' });
        assert.match(r.error, /non-empty/);
    });

    it('returns slash-unavailable when no executor is wired', async () => {
        const r = await buildNovaStTools({}).st_run_slash({ command: '/echo' });
        assert.equal(r.error, 'slash-unavailable');
    });

    it('returns slash-failed when the executor throws', async () => {
        const exec = async () => { throw new Error('parser exploded'); };
        const r = await buildNovaStTools({ executeSlashImpl: exec }).st_run_slash({ command: '/bad' });
        assert.equal(r.error, 'slash-failed');
        assert.match(r.message, /parser exploded/);
    });
});

describe('st_get_context', () => {
    it('returns a compact snapshot with default lastN=10', async () => {
        const handlers = buildNovaStTools({ ctxImpl: () => makeCtx() });
        const r = await handlers.st_get_context();
        assert.equal(r.persona, 'User');
        assert.equal(r.character.name, 'Alice');
        assert.equal(r.chatId, 'chat-001');
        assert.equal(r.count, 3); // we only have 3 chat entries
        assert.equal(r.messages[2].is_system, true);
    });

    it('clamps lastN to [1..50]', async () => {
        const longChat = Array.from({ length: 100 }, (_, i) => ({ name: 'X', mes: `m${i}` }));
        const ctx = makeCtx({ chat: longChat });
        const handlers = buildNovaStTools({ ctxImpl: () => ctx });
        const big = await handlers.st_get_context({ lastN: 999 });
        assert.equal(big.count, 50);
        const tiny = await handlers.st_get_context({ lastN: -5 });
        assert.equal(tiny.count, 1); // clamps to 1, not to default 10
        const float = await handlers.st_get_context({ lastN: 3.9 });
        assert.equal(float.count, 3); // floor
    });

    it('falls back to default 10 on non-numeric lastN', async () => {
        const longChat = Array.from({ length: 30 }, (_, i) => ({ name: 'X', mes: `m${i}` }));
        const ctx = makeCtx({ chat: longChat });
        const r = await buildNovaStTools({ ctxImpl: () => ctx }).st_get_context({ lastN: 'abc' });
        assert.equal(r.count, 10);
    });

    it('truncates per-message text to 4000 chars', async () => {
        const big = 'y'.repeat(5000);
        const ctx = makeCtx({ chat: [{ name: 'X', mes: big }] });
        const r = await buildNovaStTools({ ctxImpl: () => ctx }).st_get_context();
        assert.equal(r.messages[0].mes.length, 4000);
    });

    it('returns null character when characterId is out of range', async () => {
        const ctx = makeCtx({ characterId: 99 });
        const r = await buildNovaStTools({ ctxImpl: () => ctx }).st_get_context();
        assert.equal(r.character, null);
    });

    it('returns no-context when ctx unavailable', async () => {
        const r = await buildNovaStTools({}).st_get_context();
        assert.equal(r.error, 'no-context');
    });
});

describe('st_list_profiles', () => {
    it('forwards to listProfilesImpl and unwraps the success shape', async () => {
        const fn = async ({ executeSlash }) => {
            assert.equal(typeof executeSlash, 'function');
            return { ok: true, profiles: ['default', 'gpt'] };
        };
        const r = await buildNovaStTools({
            executeSlashImpl: async () => ({ pipe: '' }),
            listProfilesImpl: fn,
        }).st_list_profiles();
        assert.deepEqual(r.profiles, ['default', 'gpt']);
    });

    it('forwards the failure reason verbatim', async () => {
        const fn = async () => ({ ok: false, reason: 'no-executor', profiles: [] });
        const r = await buildNovaStTools({ listProfilesImpl: fn }).st_list_profiles();
        assert.equal(r.error, 'no-executor');
        assert.deepEqual(r.profiles, []);
    });

    it('returns list-profiles-unavailable when no helper is wired', async () => {
        const r = await buildNovaStTools({}).st_list_profiles();
        assert.equal(r.error, 'list-profiles-unavailable');
    });

    it('catches throws from the helper', async () => {
        const fn = async () => { throw new Error('rpc dead'); };
        const r = await buildNovaStTools({ listProfilesImpl: fn }).st_list_profiles();
        assert.equal(r.error, 'list-profiles-failed');
        assert.match(r.message, /rpc dead/);
    });
});

describe('st_get_profile', () => {
    it('parses a JSON profile from the slash pipe', async () => {
        let captured = '';
        const exec = async (cmd) => { captured = cmd; return { pipe: JSON.stringify({ name: 'gpt', api: 'openai' }) }; };
        const r = await buildNovaStTools({ executeSlashImpl: exec }).st_get_profile({ name: 'gpt' });
        assert.match(captured, /^\/profile-get name="gpt"$/);
        assert.equal(r.profile.api, 'openai');
    });

    it('returns raw pipe when not JSON', async () => {
        const exec = async () => ({ pipe: 'name: gpt' });
        const r = await buildNovaStTools({ executeSlashImpl: exec }).st_get_profile({ name: 'gpt' });
        assert.equal(r.raw, 'name: gpt');
    });

    it('returns not-found on empty pipe', async () => {
        const exec = async () => ({ pipe: '' });
        const r = await buildNovaStTools({ executeSlashImpl: exec }).st_get_profile({ name: 'gpt' });
        assert.equal(r.error, 'not-found');
    });

    it('rejects empty name', async () => {
        const r = await buildNovaStTools({ executeSlashImpl: async () => '' }).st_get_profile({ name: '' });
        assert.match(r.error, /non-empty/);
    });

    it('returns slash-unavailable when no exec', async () => {
        const r = await buildNovaStTools({}).st_get_profile({ name: 'x' });
        assert.equal(r.error, 'slash-unavailable');
    });

    it('returns slash-failed when exec throws', async () => {
        const exec = async () => { throw new Error('boom'); };
        const r = await buildNovaStTools({ executeSlashImpl: exec }).st_get_profile({ name: 'gpt' });
        assert.equal(r.error, 'slash-failed');
    });
});

describe('DI / lazy resolution', () => {
    it('ctxImpl as a function is called per invocation (picks up changes)', async () => {
        let count = 0;
        const handlers = buildNovaStTools({ ctxImpl: () => { count++; return makeCtx(); } });
        await handlers.st_list_characters();
        await handlers.st_get_context();
        assert.equal(count, 2);
    });

    it('ctxImpl as a static object is reused', async () => {
        const ctx = makeCtx();
        const handlers = buildNovaStTools({ ctxImpl: ctx });
        const r1 = await handlers.st_list_characters();
        const r2 = await handlers.st_list_characters();
        assert.equal(r1.count, r2.count);
    });
});
