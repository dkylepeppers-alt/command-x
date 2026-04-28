// Tests for the shipped Chat Completion preset at presets/openai/Command-X.json
// See docs/nova-agent-plan.md §10 + §11 for what this enforces.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PRESET_PATH = resolve(HERE, '..', 'presets', 'openai', 'Command-X.json');

async function loadPreset() {
    const raw = await readFile(PRESET_PATH, 'utf8');
    return { raw, preset: JSON.parse(raw) };
}

test('preset file parses as JSON', async () => {
    const { preset } = await loadPreset();
    assert.equal(typeof preset, 'object');
    assert.ok(preset !== null);
});

test('preset declares required top-level Chat Completion fields', async () => {
    const { preset } = await loadPreset();
    const REQUIRED = [
        'chat_completion_source', 'openai_model', 'temperature', 'top_p',
        'frequency_penalty', 'presence_penalty', 'openai_max_context',
        'openai_max_tokens', 'stream_openai', 'function_calling',
        'custom_prompt_post_processing', 'names_behavior',
        'send_if_empty', 'impersonation_prompt', 'new_chat_prompt',
        'new_group_chat_prompt', 'new_example_chat_prompt',
        'continue_nudge_prompt', 'wi_format', 'scenario_format',
        'personality_format', 'group_nudge_prompt', 'prompts', 'prompt_order',
    ];
    for (const key of REQUIRED) {
        assert.ok(key in preset, `missing required field: ${key}`);
    }
});

test('preset tuning values match the documented intent', async () => {
    const { preset } = await loadPreset();
    assert.equal(preset.chat_completion_source, 'openai');
    assert.equal(preset.temperature, 0.85);
    assert.equal(preset.top_p, 1);
    assert.equal(preset.frequency_penalty, 0.1);
    assert.equal(preset.presence_penalty, 0.1);
    assert.equal(preset.openai_max_context, 32768);
    assert.equal(preset.openai_max_tokens, 1200);
    assert.equal(preset.stream_openai, true);
    assert.equal(preset.function_calling, true);
    assert.equal(preset.custom_prompt_post_processing, '');
    assert.equal(preset.names_behavior, 2);
});

test('preset ships all required marker prompts', async () => {
    const { preset } = await loadPreset();
    const MARKERS = [
        'chatHistory', 'dialogueExamples', 'worldInfoAfter', 'worldInfoBefore',
        'charDescription', 'charPersonality', 'scenario', 'personaDescription',
    ];
    const byId = new Map(preset.prompts.map(p => [p.identifier, p]));
    for (const id of MARKERS) {
        const p = byId.get(id);
        assert.ok(p, `missing marker prompt: ${id}`);
        assert.equal(p.marker, true, `marker prompt ${id} must have marker:true`);
    }
});

test('preset ships main/side-channel/nsfw/jailbreak system prompts', async () => {
    const { preset } = await loadPreset();
    const byId = new Map(preset.prompts.map(p => [p.identifier, p]));
    for (const id of ['main', 'commandXSideChannels', 'nsfw', 'jailbreak']) {
        const p = byId.get(id);
        assert.ok(p, `missing system prompt: ${id}`);
        assert.equal(p.system_prompt, true);
        assert.equal(p.role, 'system');
    }
});

test('Main Prompt focuses roleplay style and delegates hidden phone data to side-channel instructions', async () => {
    const { preset } = await loadPreset();
    const main = preset.prompts.find(p => p.identifier === 'main');
    assert.ok(main, 'Main Prompt missing');
    const c = main.content;
    assert.match(c, /live roleplay/, 'main prompt should establish RP mode');
    assert.match(c, /Do not speak, decide, feel, or act for \{\{user\}\}/,
        'main prompt should avoid controlling the user');
    assert.match(c, /Command-X may add separate side-channel instructions/,
        'main prompt should delegate machine data to the dedicated prompt');
});

test('Command-X side-channel prompt teaches all four tag grammars', async () => {
    const { preset } = await loadPreset();
    const side = preset.prompts.find(p => p.identifier === 'commandXSideChannels');
    assert.ok(side, 'Command-X Side Channels prompt missing');
    const c = side.content;
    // Each of the four side-channel tag families must be documented.
    assert.match(c, /\[sms from=/, 'main prompt missing [sms from=...] grammar');
    assert.match(c, /\[\/sms\]/);
    assert.match(c, /\[status\]/);
    assert.match(c, /\[\/status\]/);
    assert.match(c, /\[quests\]/);
    assert.match(c, /\[\/quests\]/);
    assert.match(c, /\[place\]/);
    assert.match(c, /\[\/place\]/);
    assert.match(c, /valid compact JSON/, 'main prompt should require strict JSON payloads');
    assert.match(c, /<online\|nearby\|offline>/, 'status enum must match extension sanitizer');
    assert.match(c, /<active\|waiting\|blocked\|completed\|failed>/, 'quest status enum should be documented');
    assert.match(c, /subtasks/, 'quest prompt should document richer quest fields');
    assert.match(c, /Never use side-channel tags for Nova tool calls/, 'main prompt should keep RP tags separate from Nova tools');
});

test('Post-History Instructions reinforce final Command-X formatting without changing schema', async () => {
    const { preset } = await loadPreset();
    const post = preset.prompts.find(p => p.identifier === 'jailbreak');
    assert.ok(post, 'Post-History Instructions prompt missing');
    assert.match(post.content, /visible roleplay first/);
    assert.match(post.content, /tags last/);
    assert.match(post.content, /no markdown fences/);
});

test('prompt_order references only defined prompt identifiers', async () => {
    const { preset } = await loadPreset();
    const defined = new Set(preset.prompts.map(p => p.identifier));
    assert.ok(Array.isArray(preset.prompt_order) && preset.prompt_order.length > 0);
    for (const block of preset.prompt_order) {
        assert.ok(Array.isArray(block.order));
        for (const entry of block.order) {
            assert.ok(typeof entry.identifier === 'string', 'order entry missing identifier');
            assert.ok(defined.has(entry.identifier),
                `prompt_order references undefined identifier: ${entry.identifier}`);
            assert.equal(typeof entry.enabled, 'boolean');
        }
    }
});

test('prompt_order enables Command-X side-channel prompt immediately after Main Prompt', async () => {
    const { preset } = await loadPreset();
    for (const block of preset.prompt_order) {
        const ids = block.order.map(e => e.identifier);
        const mainIdx = ids.indexOf('main');
        assert.ok(mainIdx >= 0, `prompt_order ${block.character_id} missing main`);
        assert.equal(ids[mainIdx + 1], 'commandXSideChannels',
            `prompt_order ${block.character_id} should place Command-X side-channel prompt after main`);
        assert.equal(block.order[mainIdx + 1].enabled, true);
    }
});

test('prompt_order ships both upstream default character_id entries', async () => {
    // Upstream ST Default.json ships 100000 (single-character default) AND
    // 100001 (global/group default). Missing either causes ST to fall back to
    // hard-coded defaults on import, losing our custom ordering.
    const { preset } = await loadPreset();
    const ids = preset.prompt_order.map(b => b.character_id);
    assert.ok(ids.includes(100000), 'prompt_order missing character_id: 100000');
    assert.ok(ids.includes(100001), 'prompt_order missing character_id: 100001');
});

test('schema matches upstream ST Default.json field set', async () => {
    // Fields present in upstream that ST's import code expects. If any go
    // missing the preset still imports but settings silently fall back.
    const { preset } = await loadPreset();
    const UPSTREAM_FIELDS = [
        'top_k', 'top_a', 'min_p', 'repetition_penalty',
        'bias_preset_selected', 'reverse_proxy', 'proxy_password',
        'max_context_unlocked', 'show_external_models', 'assistant_prefill',
        'assistant_impersonation', 'use_sysprompt', 'squash_system_messages',
        'media_inlining', 'bypass_status_check', 'continue_prefill',
        'continue_postfix', 'seed', 'n',
        'function_calling', 'custom_prompt_post_processing',
    ];
    for (const key of UPSTREAM_FIELDS) {
        assert.ok(key in preset, `missing upstream field: ${key}`);
    }
});
