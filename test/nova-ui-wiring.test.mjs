/**
 * Static source-contract tests for the Nova UI wiring (plan §2c, §9)
 * that landed in v0.13.0.
 * Run with: node --test test/nova-ui-wiring.test.mjs
 *
 * These tests grep index.js for the symbols + wiring that downstream
 * phases depend on, without spinning up a browser. They complement
 * nova-ui-scaffolding.test.mjs (which asserts the DOM shell) and the
 * unit tests that cover the helpers themselves.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

async function loadSources() {
    const [js, css, manifestRaw] = await Promise.all([
        readFile(resolve(repoRoot, 'index.js'), 'utf8'),
        readFile(resolve(repoRoot, 'style.css'), 'utf8'),
        readFile(resolve(repoRoot, 'manifest.json'), 'utf8'),
    ]);
    return { js, css, manifest: JSON.parse(manifestRaw) };
}

test('manifest.json and index.js VERSION agree on 0.13.0', async () => {
    const { js, manifest } = await loadSources();
    assert.equal(manifest.version, '0.13.0', 'manifest.json version must be 0.13.0');
    const m = js.match(/const VERSION = '([^']+)';/);
    assert.ok(m, 'VERSION constant not found in index.js');
    assert.equal(m[1], '0.13.0', 'index.js VERSION must match manifest');
});

test('Nova UI wiring functions are declared', async () => {
    const { js } = await loadSources();
    for (const name of [
        'function wireNovaView(',
        'function refreshNovaPills(',
        'function renderNovaTranscript(',
        'function appendNovaTranscriptLine(',
        'function buildNovaSendRequest(',
        'function novaPickProfile(',
        'function novaPickSkill(',
        'function novaPickTier(',
        'function novaHandleSend(',
        'function novaHandleCancel(',
        'function setNovaInFlight(',
        'function cxPickList(',
    ]) {
        assert.ok(js.includes(name), `Expected declaration: ${name}`);
    }
});

test('wirePhone calls wireNovaView so Nova is live after rebuild', async () => {
    const { js } = await loadSources();
    // Must appear INSIDE wirePhone, not just anywhere in the file.
    const wirePhoneBody = js.match(/function wirePhone\(\)[^{]*\{([\s\S]*?)\n\}\s*\n/);
    assert.ok(wirePhoneBody, 'wirePhone body not found');
    assert.match(wirePhoneBody[1], /wireNovaView\(\s*\)/,
        'wirePhone must call wireNovaView() to wire the Nova view on every rebuild');
});

test('Nova self-edit tool handlers factory is exported in source', async () => {
    const { js } = await loadSources();
    assert.match(js, /function buildNovaSoulMemoryHandlers\(/);
    // Handler keys must match the schema entries.
    for (const name of [
        'nova_read_soul',
        'nova_read_memory',
        'nova_write_soul',
        'nova_append_memory',
        'nova_overwrite_memory',
    ]) {
        assert.match(js, new RegExp(`\\b${name}\\b`), `Missing handler key ${name}`);
    }
});

test('Nova phone-internal tool handlers factory is exported and wired', async () => {
    const { js } = await loadSources();
    assert.match(js, /function buildNovaPhoneHandlers\(/);
    for (const name of [
        'phone_list_npcs',
        'phone_write_npc',
        'phone_list_quests',
        'phone_write_quest',
        'phone_list_places',
        'phone_write_place',
        'phone_list_messages',
        'phone_inject_message',
    ]) {
        assert.match(js, new RegExp(`\\b${name}\\b`), `Missing phone handler key ${name}`);
    }
    // novaHandleSend must merge the phone handlers into the tool handler set.
    const novaHandleSend = js.match(/async function novaHandleSend\([\s\S]*?\n\}/);
    assert.ok(novaHandleSend, 'novaHandleSend body not found');
    assert.match(novaHandleSend[0], /buildNovaPhoneHandlers\(/,
        'novaHandleSend must compose buildNovaPhoneHandlers into the toolHandlers map');
});

test('Profile-swap helpers are wired to the slash executor', async () => {
    const { js } = await loadSources();
    assert.match(js, /function listNovaProfiles\(/);
    assert.match(js, /function parseNovaProfileListPipe\(/);
    assert.match(js, /function withNovaProfileMutex\(/);
    // The mutex must actually be invoked from novaHandleSend.
    const novaHandleSend = js.match(/async function novaHandleSend\([\s\S]*?\n\}/);
    assert.ok(novaHandleSend, 'novaHandleSend body not found');
    assert.match(novaHandleSend[0], /withNovaProfileMutex\(/,
        'novaHandleSend must serialise through withNovaProfileMutex');
});

test('Nova settings appear in settings.html', async () => {
    const html = await readFile(resolve(repoRoot, 'settings.html'), 'utf8');
    for (const id of [
        'cx_nova_profile',
        'cx_nova_default_tier',
        'cx_nova_max_tool_calls',
        'cx_nova_turn_timeout_ms',
        'cx_nova_plugin_base_url',
        'cx_nova_install_preset',
    ]) {
        assert.ok(html.includes(`id="${id}"`), `settings.html missing input#${id}`);
    }
});

test('In-phone Nova settings rows exist in buildPhone', async () => {
    const { js } = await loadSources();
    for (const id of [
        'cx-set-nova-profile',
        'cx-set-nova-tier',
        'cx-set-nova-max-tools',
        'cx-set-nova-timeout',
        'cx-set-nova-plugin-url',
    ]) {
        assert.ok(js.includes(`id="${id}"`), `Missing in-phone Nova setting #${id}`);
    }
});

test('saveSettings reads both settings-panel and in-phone Nova IDs', async () => {
    const { js } = await loadSources();
    // Both IDs must be referenced in saveSettings' nullish chain.
    assert.match(js, /cx_nova_profile[\s\S]{0,200}cx-set-nova-profile/);
    assert.match(js, /cx_nova_default_tier[\s\S]{0,200}cx-set-nova-tier/);
    assert.match(js, /cx_nova_max_tool_calls[\s\S]{0,200}cx-set-nova-max-tools/);
});

test('style.css includes Nova message bubble + picker-modal classes', async () => {
    const { css } = await loadSources();
    for (const cls of [
        '.cx-nova-msg',
        '.cx-nova-msg-user',
        '.cx-nova-msg-assistant',
        '.cx-nova-msg-system',
        '.cx-nova-msg-notice',
        '.cx-pick-box',
        '.cx-pick-row',
        '.cx-pick-active',
        '.cx-settings-text-input',
    ]) {
        assert.ok(css.includes(cls), `style.css missing ${cls}`);
    }
});

test('Nova transcript renderer handles the documented roles', async () => {
    const { js } = await loadSources();
    const fn = js.match(/function _novaRenderMessageNode\([\s\S]*?\n\}/);
    assert.ok(fn, '_novaRenderMessageNode not found');
    for (const role of ['user', 'assistant', 'tool', 'system', 'notice', 'user-preview']) {
        assert.match(fn[0], new RegExp(`'${role}'`), `Missing role handling: ${role}`);
    }
});

test('buildNovaSendRequest prefers ConnectionManagerRequestService then generateRaw', async () => {
    const { js } = await loadSources();
    const fn = js.match(/function buildNovaSendRequest\([\s\S]*?\n\}\n/);
    assert.ok(fn, 'buildNovaSendRequest not found');
    // Both dispatch paths must be present.
    assert.match(fn[0], /ConnectionManagerRequestService/);
    assert.match(fn[0], /generateRaw/);
});
