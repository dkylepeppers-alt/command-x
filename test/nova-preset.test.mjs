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
        'openai_max_tokens', 'stream_openai', 'names_behavior',
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
    assert.equal(preset.openai_max_tokens, 800);
    assert.equal(preset.stream_openai, true);
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

test('preset ships main/nsfw/jailbreak system prompts', async () => {
    const { preset } = await loadPreset();
    const byId = new Map(preset.prompts.map(p => [p.identifier, p]));
    for (const id of ['main', 'nsfw', 'jailbreak']) {
        const p = byId.get(id);
        assert.ok(p, `missing system prompt: ${id}`);
        assert.equal(p.system_prompt, true);
        assert.equal(p.role, 'system');
    }
});

test('Main Prompt teaches all four Command-X tag grammars', async () => {
    const { preset } = await loadPreset();
    const main = preset.prompts.find(p => p.identifier === 'main');
    assert.ok(main, 'Main Prompt missing');
    const c = main.content;
    // Each of the four side-channel tag families must be documented.
    assert.match(c, /\[sms from=/, 'main prompt missing [sms from=...] grammar');
    assert.match(c, /\[\/sms\]/);
    assert.match(c, /\[status\]/);
    assert.match(c, /\[\/status\]/);
    assert.match(c, /\[quests\]/);
    assert.match(c, /\[\/quests\]/);
    assert.match(c, /\[place\]/);
    assert.match(c, /\[\/place\]/);
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
