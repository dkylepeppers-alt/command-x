/**
 * Unit tests for Nova ST-API tool handlers (plan §4d).
 * Run with: node --test test/nova-st-tools.test.mjs
 *
 * Inline-copies `buildNovaStTools` from `index.js` under the
 * `/* === NOVA AGENT === *\/` section (right after `buildNovaFsHandlers`).
 * Per AGENT_MEMORY inline-copy convention: when the production helper
 * changes, update this copy.
 *
 * The handlers do NOT touch the plugin or localStorage. ST-native writes
 * route through an injected fetch harness in these tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// -------- Inline copy of production helper --------

function buildNovaStTools({
    ctxImpl,
    executeSlashImpl,
    listProfilesImpl,
    fetchImpl,
    worldInfoCacheImpl,
    eventSourceImpl,
    eventTypesImpl,
    updateWorldInfoListImpl,
    reloadWorldInfoEditorImpl,
} = {}) {
    const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
    const safeArgs = (v) => (isObject(v) ? v : {});
    const safeName = (v) => (typeof v === 'string' ? v.trim() : '');
    const getFetch = () => (typeof fetchImpl === 'function'
        ? fetchImpl
        : (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null));

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
    const postJson = async (url, body) => {
        const doFetch = getFetch();
        if (!doFetch) {
            return { ok: false, status: 0, data: { error: 'fetch-unavailable' }, message: 'fetch-unavailable' };
        }
        const response = await doFetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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
    const findCharacterByName = (ctx, cleanName) => {
        const list = Array.isArray(ctx?.characters) ? ctx.characters : [];
        return list.find(c => isObject(c) && c.name === cleanName) || null;
    };
    const stringArray = (value) => {
        if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
        if (typeof value === 'string') return value.split(',').map(v => v.trim()).filter(Boolean);
        return [];
    };
    const cardField = (card, data, key, fallback = '') => {
        const value = data?.[key] ?? card?.[key] ?? fallback;
        return value === null || value === undefined ? fallback : value;
    };
    const normalizeTavernCard = (cleanName, card) => {
        if (!isObject(card)) return null;
        const srcData = isObject(card.data) ? card.data : {};
        const data = { ...srcData };
        for (const key of [
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
        ]) {
            const fallback = key === 'creator_notes' ? (card?.creatorcomment || '') : '';
            data[key] = String(cardField(card, srcData, key, fallback) || '');
        }
        data.name = cleanName;
        data.alternate_greetings = Array.isArray(srcData.alternate_greetings)
            ? srcData.alternate_greetings.map(v => String(v))
            : [];
        data.tags = stringArray(cardField(card, srcData, 'tags', []));
        data.extensions = isObject(srcData.extensions)
            ? { ...srcData.extensions }
            : (isObject(card.extensions) ? { ...card.extensions } : {});
        return {
            ...card,
            spec: 'chara_card_v2',
            spec_version: String(card.spec_version || '2.0'),
            data,
        };
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
        if (isObject(args.card)) return normalizeTavernCard(cleanName, args.card);
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
        return normalizeTavernCard(cleanName, { spec: 'chara_card_v2', spec_version: '2.0', data });
    };
    const normalizeWorldbookEntry = (entry, uid) => {
        if (!isObject(entry)) return null;
        const out = { ...entry, uid };
        out.key = stringArray(out.key);
        out.keysecondary = stringArray(out.keysecondary);
        out.comment = typeof out.comment === 'string' ? out.comment : '';
        out.content = typeof out.content === 'string' ? out.content : '';
        if (out.constant === undefined) out.constant = false;
        if (out.selective === undefined) out.selective = false;
        if (out.selectiveLogic === undefined) out.selectiveLogic = 0;
        if (out.addMemo === undefined) out.addMemo = true;
        if (out.order === undefined) out.order = 100;
        if (out.position === undefined) out.position = 0;
        if (out.disable === undefined) out.disable = false;
        if (out.excludeRecursion === undefined) out.excludeRecursion = false;
        if (out.preventRecursion === undefined) out.preventRecursion = false;
        if (out.probability === undefined) out.probability = 100;
        if (out.useProbability === undefined) out.useProbability = true;
        if (out.vectorized === undefined) out.vectorized = false;
        return out;
    };
    const normalizeWorldbookEntries = (entries) => {
        const source = Array.isArray(entries)
            ? entries.map((entry, idx) => [String(isObject(entry) && Number.isFinite(Number(entry.uid)) ? Number(entry.uid) : idx), entry])
            : (isObject(entries) ? Object.entries(entries) : []);
        const out = {};
        const used = new Set();
        let nextUid = 0;
        for (const [rawKey, rawEntry] of source) {
            if (!isObject(rawEntry)) continue;
            let uid = Number.isFinite(Number(rawEntry.uid)) ? Math.trunc(Number(rawEntry.uid)) : Number(rawKey);
            if (!Number.isFinite(uid) || used.has(uid)) {
                while (used.has(nextUid)) nextUid++;
                uid = nextUid;
            }
            used.add(uid);
            const normalized = normalizeWorldbookEntry(rawEntry, uid);
            if (normalized) out[String(uid)] = normalized;
        }
        return out;
    };
    const normalizeWorldbookBook = (cleanName, book) => {
        if (!isObject(book)) return null;
        const entries = normalizeWorldbookEntries(book.entries);
        return {
            ...book,
            name: book.name || cleanName,
            entries,
        };
    };
    const normalizeWorldbookRows = (rows) => {
        const out = [];
        if (!Array.isArray(rows)) return out;
        for (const row of rows) {
            if (isObject(row)) {
                const fileId = String(row.file_id || '').trim();
                const name = String(row.name || fileId || '').trim();
                if (!fileId && !name) continue;
                const clean = { file_id: fileId || name, name: name || fileId };
                if (isObject(row.extensions)) clean.extensions = row.extensions;
                out.push(clean);
            } else {
                const name = String(row || '').trim();
                if (name) out.push({ file_id: name, name });
            }
        }
        return out;
    };
    const resolveWorldbookIdentifier = (native, requested) => {
        if (!native?.ok) return null;
        const rows = Array.isArray(native.rows) ? native.rows : [];
        const byFileId = rows.find(row => row.file_id === requested);
        if (byFileId) return { status: 'found', row: byFileId };
        const byName = rows.filter(row => row.name === requested);
        if (byName.length === 1) return { status: 'found', row: byName[0] };
        if (byName.length > 1) return { status: 'ambiguous', rows: byName };
        return { status: 'not-found' };
    };
    const refreshWorldbooks = async (fileId, data) => {
        let refreshed = false;
        const ctx = getCtx() || {};
        const cache = worldInfoCacheImpl;
        if (cache && typeof cache.set === 'function') {
            try { cache.set(fileId, data); refreshed = true; } catch (_) { /* non-fatal */ }
        }
        const events = eventSourceImpl || ctx.eventSource;
        const types = eventTypesImpl || ctx.eventTypes || ctx.event_types;
        if (events && typeof events.emit === 'function' && types?.WORLDINFO_UPDATED) {
            try { await events.emit(types.WORLDINFO_UPDATED, fileId, data); refreshed = true; } catch (_) { /* non-fatal */ }
        }
        const updateList = updateWorldInfoListImpl || (typeof ctx.updateWorldInfoList === 'function' ? ctx.updateWorldInfoList : null);
        if (typeof updateList === 'function') {
            try { await updateList(); refreshed = true; } catch (_) { /* non-fatal */ }
        }
        const reloadEditor = reloadWorldInfoEditorImpl || (typeof ctx.reloadWorldInfoEditor === 'function' ? ctx.reloadWorldInfoEditor : null);
        if (typeof reloadEditor === 'function') {
            try { await reloadEditor(fileId); refreshed = true; } catch (_) { /* non-fatal */ }
        }
        return refreshed;
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
        const rows = normalizeWorldbookRows(result.data);
        const worldbooks = rows.map(row => row.name || row.file_id).filter(Boolean);
        const canonicalIds = rows.map(row => row.file_id).filter(Boolean);
        const identifiers = new Set(canonicalIds);
        for (const row of rows) {
            if (row.name) identifiers.add(row.name);
        }
        return { ok: true, worldbooks, canonicalIds, identifiers, rows };
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
                if (!result.ok) return { error: 'write-failed', tool: 'st_write_character', status: result.status, message: result.message };
                await refreshCharacters();
                return { ok: true, action: 'updated', name: cleanName, avatar: existing.avatar };
            }
            let result;
            try {
                result = await postJson('/api/characters/create', characterCreatePayload(cleanName, card));
            } catch (err) {
                return { error: 'write-failed', tool: 'st_write_character', message: String(err?.message || err) };
            }
            if (!result.ok) return { error: 'write-failed', tool: 'st_write_character', status: result.status, message: result.message };
            await refreshCharacters();
            return { ok: true, action: 'created', name: cleanName, avatar: String(result.data || '') };
        },
        st_list_worldbooks: async () => {
            try {
                const native = await listWorldbooksNative();
                if (native.ok) return { worldbooks: native.worldbooks, count: native.worldbooks.length, rows: native.rows, canonicalIds: native.canonicalIds };
            } catch (_) { /* fall through to slash fallback */ }
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
            let resolvedName = cleanName;
            let displayName = cleanName;
            try {
                const native = await listWorldbooksNative();
                if (native.ok) {
                    const resolved = resolveWorldbookIdentifier(native, cleanName);
                    if (resolved?.status === 'not-found') return { error: 'not-found', name: cleanName };
                    if (resolved?.status === 'ambiguous') return { error: 'ambiguous', name: cleanName, matches: resolved.rows };
                    if (resolved?.status === 'found') {
                        resolvedName = resolved.row.file_id;
                        displayName = resolved.row.name || resolved.row.file_id;
                    }
                }
            } catch (_) { /* old ST build or fetch unavailable: fall through to direct get/slash */ }
            try {
                const result = await postJson('/api/worldinfo/get', { name: resolvedName });
                if (result.ok && isObject(result.data) && isObject(result.data.entries)) {
                    return { name: displayName, file_id: resolvedName, book: result.data };
                }
            } catch (_) { /* fall through to slash fallback */ }
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
            const args = safeArgs(rawArgs);
            const { name } = args;
            const cleanName = safeName(name);
            if (!cleanName) return { error: 'name must be a non-empty string' };
            if (!isObject(args.book)) return { error: 'missing-book', tool: 'st_write_worldbook' };
            if (!isObject(args.book.entries) && !Array.isArray(args.book.entries)) return { error: 'invalid-book', tool: 'st_write_worldbook', hint: 'Worldbook JSON must include an `entries` object.' };
            let fileId = cleanName;
            let displayName = cleanName;
            let existed = false;
            try {
                const native = await listWorldbooksNative();
                if (native.ok) {
                    const resolved = resolveWorldbookIdentifier(native, cleanName);
                    if (resolved?.status === 'ambiguous') return { error: 'ambiguous', name: cleanName, matches: resolved.rows };
                    if (resolved?.status === 'found') {
                        existed = true;
                        fileId = resolved.row.file_id;
                        displayName = resolved.row.name || resolved.row.file_id;
                        if (!args.overwrite) {
                            return { error: 'exists', name: displayName, file_id: fileId, hint: 'Set overwrite=true to replace this worldbook.' };
                        }
                    }
                }
            } catch (_) { /* if listing fails, let edit endpoint be authoritative */ }
            const book = normalizeWorldbookBook(displayName, args.book);
            let result;
            try {
                result = await postJson('/api/worldinfo/edit', { name: fileId, data: book });
            } catch (err) {
                return { error: 'write-failed', tool: 'st_write_worldbook', message: String(err?.message || err) };
            }
            if (!result.ok) return { error: 'write-failed', tool: 'st_write_worldbook', status: result.status, message: result.message };
            const refreshed = await refreshWorldbooks(fileId, book);
            return { ok: true, action: existed ? 'updated' : 'created', name: displayName, file_id: fileId, ...(refreshed ? {} : { uiRefreshRequired: true }) };
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
        st_read_persona: async () => {
            const ctx = getCtx();
            if (!ctx) return { error: 'no-context' };
            const powerUser = isObject(ctx.powerUserSettings) ? ctx.powerUserSettings
                : (isObject(ctx.power_user) ? ctx.power_user
                    : (isObject(ctx.powerUser) ? ctx.powerUser : {}));
            const personas = isObject(powerUser.personas) ? powerUser.personas : {};
            const activeName = typeof ctx.name1 === 'string' ? ctx.name1 : '';
            const matchedAvatar = Object.entries(personas)
                .find(([, personaName]) => String(personaName || '') === activeName)?.[0] || '';
            const avatarId = typeof ctx.user_avatar === 'string' ? ctx.user_avatar
                : (typeof ctx.userAvatar === 'string' ? ctx.userAvatar
                    : (typeof powerUser.user_avatar === 'string' ? powerUser.user_avatar
                        : (matchedAvatar || (typeof powerUser.default_persona === 'string' ? powerUser.default_persona : ''))));
            const personaDescriptions = isObject(powerUser.persona_descriptions) ? powerUser.persona_descriptions : {};
            const savedMeta = avatarId && isObject(personaDescriptions[avatarId]) ? personaDescriptions[avatarId] : {};
            return {
                name: activeName,
                avatar: avatarId || null,
                savedName: avatarId && typeof personas[avatarId] === 'string' ? personas[avatarId] : '',
                description: typeof powerUser.persona_description === 'string' ? powerUser.persona_description : '',
                savedDescription: typeof savedMeta.description === 'string' ? savedMeta.description : '',
                title: typeof savedMeta.title === 'string' ? savedMeta.title : '',
                position: powerUser.persona_description_position ?? savedMeta.position ?? null,
                role: powerUser.persona_description_role ?? savedMeta.role ?? null,
                depth: powerUser.persona_description_depth ?? savedMeta.depth ?? null,
                lorebook: typeof powerUser.persona_description_lorebook === 'string' ? powerUser.persona_description_lorebook : '',
                defaultPersona: typeof powerUser.default_persona === 'string' ? powerUser.default_persona : null,
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
        user_avatar: 'user.png',
        powerUserSettings: {
            personas: { 'user.png': 'User' },
            persona_descriptions: { 'user.png': { description: 'A careful adventurer.', title: 'The Player', position: 0, role: 0, depth: 2 } },
            persona_description: 'Current prompt persona.',
            persona_description_position: 0,
            persona_description_role: 0,
            persona_description_depth: 2,
            persona_description_lorebook: 'User Lore',
            default_persona: 'user.png',
        },
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

function mockResponse(data, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => typeof data === 'string' ? data : JSON.stringify(data),
    };
}

// -------- Tests --------

describe('buildNovaStTools — handler shape', () => {
    it('returns all 11 named handlers', () => {
        const handlers = buildNovaStTools({});
        for (const n of [
            'st_list_characters', 'st_read_character', 'st_write_character',
            'st_list_worldbooks', 'st_read_worldbook', 'st_write_worldbook',
            'st_run_slash', 'st_get_context', 'st_read_persona',
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

describe('st_write_character', () => {
    it('creates a new character through the native create endpoint', async () => {
        const calls = [];
        const fetchImpl = async (url, init) => {
            calls.push({ url, body: JSON.parse(init.body) });
            return mockResponse('Nova.png');
        };
        let refreshed = false;
        const ctx = makeCtx({ getCharacters: async () => { refreshed = true; } });
        const r = await buildNovaStTools({ ctxImpl: () => ctx, fetchImpl }).st_write_character({
            name: 'Nova',
            card: {
                spec: 'chara_card_v2',
                data: {
                    name: 'Nova',
                    description: 'An agent.',
                    first_mes: 'Ready.',
                    tags: ['agent'],
                    extensions: { talkativeness: 0.7, world: 'Nova Lore' },
                },
            },
        });
        assert.equal(r.ok, true);
        assert.equal(r.action, 'created');
        assert.equal(r.avatar, 'Nova.png');
        assert.equal(calls[0].url, '/api/characters/create');
        assert.equal(calls[0].body.ch_name, 'Nova');
        assert.equal(calls[0].body.description, 'An agent.');
        assert.deepEqual(calls[0].body.tags, ['agent']);
        assert.equal(calls[0].body.world, 'Nova Lore');
        const json = JSON.parse(calls[0].body.json_data);
        assert.equal(json.spec, 'chara_card_v2');
        assert.equal(json.spec_version, '2.0');
        assert.equal(json.data.name, 'Nova');
        assert.equal(refreshed, true);
    });

    it('normalizes nested card JSON to Tavern Card v2 before create', async () => {
        const calls = [];
        const fetchImpl = async (url, init) => {
            calls.push({ url, body: JSON.parse(init.body) });
            return mockResponse('Correct.png');
        };
        await buildNovaStTools({ fetchImpl }).st_write_character({
            name: 'Correct',
            card: {
                data: {
                    name: 'Wrong',
                    description: 'Uses the requested name on disk.',
                    tags: 'one, two',
                },
            },
        });
        const json = JSON.parse(calls[0].body.json_data);
        assert.equal(json.spec, 'chara_card_v2');
        assert.equal(json.spec_version, '2.0');
        assert.equal(json.data.name, 'Correct');
        assert.deepEqual(json.data.tags, ['one', 'two']);
        assert.deepEqual(json.data.alternate_greetings, []);
        assert.equal(calls[0].body.ch_name, 'Correct');
    });

    it('creates a character from top-level fields when no nested card is supplied', async () => {
        const calls = [];
        const fetchImpl = async (url, init) => {
            calls.push({ url, body: JSON.parse(init.body) });
            return mockResponse('Sisi.png');
        };
        const r = await buildNovaStTools({ fetchImpl }).st_write_character({
            name: 'Sisi',
            description: 'A precise archive diver.',
            personality: 'Curious, direct, and stubborn.',
            scenario: 'Sisi is hired to recover a forbidden record.',
            first_mes: 'The archive door is already open.',
            tags: ['investigator', 'archive'],
            creator: 'Nova',
        });
        assert.equal(r.ok, true);
        assert.equal(r.action, 'created');
        assert.equal(calls[0].url, '/api/characters/create');
        assert.equal(calls[0].body.ch_name, 'Sisi');
        assert.equal(calls[0].body.description, 'A precise archive diver.');
        assert.equal(calls[0].body.personality, 'Curious, direct, and stubborn.');
        assert.deepEqual(calls[0].body.tags, ['investigator', 'archive']);
        const json = JSON.parse(calls[0].body.json_data);
        assert.equal(json.spec, 'chara_card_v2');
        assert.equal(json.data.name, 'Sisi');
    });

    it('refuses to update an existing character unless overwrite=true', async () => {
        const r = await buildNovaStTools({ ctxImpl: () => makeCtx() }).st_write_character({
            name: 'Alice',
            card: { data: { name: 'Alice' } },
        });
        assert.equal(r.error, 'exists');
        assert.equal(r.avatar, 'a.png');
    });

    it('updates an existing character through merge-attributes when overwrite=true', async () => {
        const calls = [];
        const fetchImpl = async (url, init) => {
            calls.push({ url, body: JSON.parse(init.body) });
            return mockResponse('');
        };
        const r = await buildNovaStTools({ ctxImpl: () => makeCtx(), fetchImpl }).st_write_character({
            name: 'Alice',
            overwrite: true,
            card: { data: { name: 'Alice', description: 'Updated.' } },
        });
        assert.equal(r.ok, true);
        assert.equal(r.action, 'updated');
        assert.equal(calls[0].url, '/api/characters/merge-attributes');
        assert.equal(calls[0].body.avatar, 'a.png');
        assert.equal(calls[0].body.data.description, 'Updated.');
    });

    it('rejects empty name', async () => {
        const r = await buildNovaStTools({}).st_write_character({ name: '' });
        assert.match(r.error, /non-empty string/);
    });

    it('rejects missing card objects', async () => {
        const r = await buildNovaStTools({}).st_write_character({ name: 'Nova' });
        assert.match(r.error, /nested card object/);
    });

    it('returns write-failed when fetch is unavailable', async () => {
        const originalFetch = globalThis.fetch;
        try {
            delete globalThis.fetch;
            const r = await buildNovaStTools({}).st_write_character({
                name: 'Nova',
                card: { data: { name: 'Nova' } },
            });
            assert.equal(r.error, 'write-failed');
            assert.equal(r.message, 'fetch-unavailable');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('returns write-failed when the native endpoint rejects the write', async () => {
        const fetchImpl = async () => mockResponse({ message: 'bad card' }, 400);
        const r = await buildNovaStTools({ fetchImpl }).st_write_character({
            name: 'Nova',
            card: { data: { name: 'Nova' } },
        });
        assert.equal(r.error, 'write-failed');
        assert.equal(r.status, 400);
        assert.equal(r.message, 'bad card');
    });
});

describe('st_list_worldbooks', () => {
    it('uses the native worldinfo list endpoint when available', async () => {
        const fetchImpl = async (url) => {
            assert.equal(url, '/api/worldinfo/list');
            return mockResponse([{ file_id: 'world-a', name: 'World A' }, { file_id: 'world-b' }]);
        };
        const r = await buildNovaStTools({ fetchImpl }).st_list_worldbooks();
        assert.deepEqual(r.worldbooks, ['World A', 'world-b']);
        assert.deepEqual(r.canonicalIds, ['world-a', 'world-b']);
        assert.deepEqual(r.rows, [
            { file_id: 'world-a', name: 'World A' },
            { file_id: 'world-b', name: 'world-b' },
        ]);
        assert.equal(r.count, 2);
    });

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
    it('uses the native worldinfo get endpoint when available', async () => {
        const calls = [];
        const fetchImpl = async (url, init) => {
            calls.push({ url, body: JSON.parse(init.body) });
            if (url === '/api/worldinfo/list') return mockResponse([{ file_id: 'my-world', name: 'My World' }]);
            if (url === '/api/worldinfo/get') return mockResponse({ entries: { 0: { uid: 0, key: ['k'] } } });
            throw new Error(`unexpected url ${url}`);
        };
        const r = await buildNovaStTools({ fetchImpl }).st_read_worldbook({ name: 'My World' });
        assert.equal(r.name, 'My World');
        assert.equal(r.file_id, 'my-world');
        assert.deepEqual(calls[1].body, { name: 'my-world' });
        assert.equal(r.book.entries[0].key[0], 'k');
    });

    it('returns not-found when list does not include the requested worldbook even if get would return a dummy book', async () => {
        const calls = [];
        const fetchImpl = async (url) => {
            calls.push(url);
            if (url === '/api/worldinfo/list') return mockResponse([{ file_id: 'other', name: 'Other' }]);
            if (url === '/api/worldinfo/get') return mockResponse({ entries: {} });
            throw new Error(`unexpected url ${url}`);
        };
        const r = await buildNovaStTools({ fetchImpl }).st_read_worldbook({ name: 'Missing' });
        assert.deepEqual(r, { error: 'not-found', name: 'Missing' });
        assert.deepEqual(calls, ['/api/worldinfo/list']);
    });

    it('resolves a unique display name to file_id before reading', async () => {
        const calls = [];
        const fetchImpl = async (url, init) => {
            calls.push({ url, body: JSON.parse(init.body) });
            if (url === '/api/worldinfo/list') return mockResponse([{ file_id: 'lore-file', name: 'Pretty Lore' }]);
            if (url === '/api/worldinfo/get') return mockResponse({ entries: { 3: { uid: 3, key: ['lore'] } } });
            throw new Error(`unexpected url ${url}`);
        };
        const r = await buildNovaStTools({ fetchImpl }).st_read_worldbook({ name: 'Pretty Lore' });
        assert.equal(r.name, 'Pretty Lore');
        assert.equal(r.file_id, 'lore-file');
        assert.deepEqual(calls[1].body, { name: 'lore-file' });
    });

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

describe('st_write_worldbook', () => {
    it('saves a valid worldbook through the native edit endpoint', async () => {
        const calls = [];
        const fetchImpl = async (url, init) => {
            calls.push({ url, body: JSON.parse(init.body) });
            if (url === '/api/worldinfo/list') return mockResponse([]);
            if (url === '/api/worldinfo/edit') return mockResponse({ ok: true });
            throw new Error(`unexpected url ${url}`);
        };
        const book = { entries: { 0: { uid: 0, key: ['nova'], content: 'Nova lore' } } };
        const r = await buildNovaStTools({ fetchImpl }).st_write_worldbook({ name: 'Lore', book });
        assert.equal(r.ok, true);
        assert.equal(r.action, 'created');
        assert.equal(r.uiRefreshRequired, true);
        assert.equal(calls[1].url, '/api/worldinfo/edit');
        assert.equal(calls[1].body.name, 'Lore');
        assert.equal(calls[1].body.data.name, 'Lore');
        assert.equal(calls[1].body.data.entries[0].content, 'Nova lore');
    });

    it('normalizes array entries to ST world-info entries keyed by uid', async () => {
        const calls = [];
        const fetchImpl = async (url, init) => {
            calls.push({ url, body: JSON.parse(init.body) });
            if (url === '/api/worldinfo/list') return mockResponse([]);
            if (url === '/api/worldinfo/edit') return mockResponse({ ok: true });
            throw new Error(`unexpected url ${url}`);
        };
        const book = {
            entries: [
                { key: 'nova, agent', keysecondary: 'bridge', content: 'Nova lore' },
                { uid: 7, key: ['lore'], content: 'Second entry', disable: true },
            ],
        };
        await buildNovaStTools({ fetchImpl }).st_write_worldbook({ name: 'Lore', book });
        const saved = calls[1].body.data;
        assert.equal(saved.name, 'Lore');
        assert.deepEqual(Object.keys(saved.entries), ['0', '7']);
        assert.equal(saved.entries[0].uid, 0);
        assert.deepEqual(saved.entries[0].key, ['nova', 'agent']);
        assert.deepEqual(saved.entries[0].keysecondary, ['bridge']);
        assert.equal(saved.entries[0].constant, false);
        assert.equal(saved.entries[7].uid, 7);
        assert.equal(saved.entries[7].disable, true);
    });

    it('refuses to replace an existing worldbook unless overwrite=true', async () => {
        const fetchImpl = async () => mockResponse([{ file_id: 'Lore', name: 'Lore' }]);
        const r = await buildNovaStTools({ fetchImpl }).st_write_worldbook({
            name: 'Lore',
            book: { entries: {} },
        });
        assert.equal(r.error, 'exists');
    });

    it('treats file_id as an existing worldbook identifier even when display name differs', async () => {
        const fetchImpl = async () => mockResponse([{ file_id: 'lore-file', name: 'Pretty Lore' }]);
        const r = await buildNovaStTools({ fetchImpl }).st_write_worldbook({
            name: 'lore-file',
            book: { entries: {} },
        });
        assert.equal(r.error, 'exists');
        assert.equal(r.file_id, 'lore-file');
        assert.equal(r.name, 'Pretty Lore');
    });

    it('overwrites existing worldbooks by canonical file_id, not display name', async () => {
        const calls = [];
        const fetchImpl = async (url, init) => {
            calls.push({ url, body: JSON.parse(init.body) });
            if (url === '/api/worldinfo/list') return mockResponse([{ file_id: 'lore-file', name: 'Pretty Lore' }]);
            if (url === '/api/worldinfo/edit') return mockResponse({ ok: true });
            throw new Error(`unexpected url ${url}`);
        };
        const r = await buildNovaStTools({ fetchImpl }).st_write_worldbook({
            name: 'Pretty Lore',
            overwrite: true,
            book: { entries: {} },
        });
        assert.equal(r.ok, true);
        assert.equal(r.action, 'updated');
        assert.equal(r.name, 'Pretty Lore');
        assert.equal(r.file_id, 'lore-file');
        assert.equal(calls[1].body.name, 'lore-file');
        assert.equal(calls[1].body.data.name, 'Pretty Lore');
    });

    it('refreshes worldbook cache, update event, list, and editor hooks after a successful write', async () => {
        const calls = [];
        const cacheSets = [];
        const emitted = [];
        const fetchImpl = async (url, init) => {
            calls.push({ url, body: JSON.parse(init.body) });
            if (url === '/api/worldinfo/list') return mockResponse([]);
            if (url === '/api/worldinfo/edit') return mockResponse({ ok: true });
            throw new Error(`unexpected url ${url}`);
        };
        let listRefreshed = false;
        let editorReloaded = '';
        const r = await buildNovaStTools({
            fetchImpl,
            worldInfoCacheImpl: { set: (name, data) => cacheSets.push({ name, data }) },
            eventSourceImpl: { emit: async (...args) => emitted.push(args) },
            eventTypesImpl: { WORLDINFO_UPDATED: 'worldinfo_updated' },
            updateWorldInfoListImpl: async () => { listRefreshed = true; },
            reloadWorldInfoEditorImpl: async (name) => { editorReloaded = name; },
        }).st_write_worldbook({ name: 'Lore', book: { entries: {} } });
        assert.equal(r.ok, true);
        assert.equal(r.uiRefreshRequired, undefined);
        assert.equal(cacheSets[0].name, 'Lore');
        assert.deepEqual(emitted[0].slice(0, 2), ['worldinfo_updated', 'Lore']);
        assert.equal(listRefreshed, true);
        assert.equal(editorReloaded, 'Lore');
    });

    it('rejects missing and invalid books', async () => {
        const missing = await buildNovaStTools({}).st_write_worldbook({ name: 'Lore' });
        assert.equal(missing.error, 'missing-book');
        const invalid = await buildNovaStTools({}).st_write_worldbook({ name: 'Lore', book: {} });
        assert.equal(invalid.error, 'invalid-book');
    });

    it('returns write-failed when the native edit endpoint rejects the save', async () => {
        const fetchImpl = async (url) => {
            if (url === '/api/worldinfo/list') return mockResponse([]);
            if (url === '/api/worldinfo/edit') return mockResponse({ error: 'bad world' }, 400);
            throw new Error(`unexpected url ${url}`);
        };
        const r = await buildNovaStTools({ fetchImpl }).st_write_worldbook({
            name: 'Lore',
            book: { entries: {} },
        });
        assert.equal(r.error, 'write-failed');
        assert.equal(r.status, 400);
        assert.equal(r.message, 'bad world');
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

describe('st_read_persona', () => {
    it('returns active persona metadata from ST context and power_user', async () => {
        const handlers = buildNovaStTools({ ctxImpl: () => makeCtx() });
        const r = await handlers.st_read_persona();
        assert.equal(r.name, 'User');
        assert.equal(r.avatar, 'user.png');
        assert.equal(r.savedName, 'User');
        assert.equal(r.description, 'Current prompt persona.');
        assert.equal(r.savedDescription, 'A careful adventurer.');
        assert.equal(r.title, 'The Player');
        assert.equal(r.lorebook, 'User Lore');
    });

    it('returns no-context when ctx unavailable', async () => {
        const r = await buildNovaStTools({}).st_read_persona();
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
        await handlers.st_read_persona();
        assert.equal(count, 3);
    });

    it('ctxImpl as a static object is reused', async () => {
        const ctx = makeCtx();
        const handlers = buildNovaStTools({ ctxImpl: ctx });
        const r1 = await handlers.st_list_characters();
        const r2 = await handlers.st_list_characters();
        assert.equal(r1.count, r2.count);
    });
});
