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
import { readFile, readdir, stat } from 'node:fs/promises';
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

test('manifest.json and index.js VERSION agree', async () => {
    const { js, manifest } = await loadSources();
    assert.ok(manifest.version, 'manifest.json must have a version field');
    assert.equal(manifest.author, 'dkylepeppers');
    assert.equal(manifest.minimum_client_version, '1.17.0');
    assert.equal('requires' in manifest, false, 'empty deprecated requires field should not be present');
    assert.equal('optional' in manifest, false, 'empty deprecated optional field should not be present');
    const m = js.match(/const VERSION = '([^']+)';/);
    assert.ok(m, 'VERSION constant not found in index.js');
    assert.equal(m[1], manifest.version, 'index.js VERSION must match manifest.json version');
});

test('vendored SillyTavern docs snapshot is not present or referenced', async () => {
    const docsDir = ['st', 'docs'].join('-');
    const forbiddenRef = `${docsDir}/`;
    await assert.rejects(() => stat(resolve(repoRoot, docsDir)), /ENOENT/);
    const ignored = new Set(['node_modules', '.git']);
    const hits = [];
    async function walk(dir) {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            if (ignored.has(entry.name)) continue;
            const full = resolve(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(full);
            } else {
                const text = await readFile(full, 'utf8').catch(() => '');
                if (text.includes(forbiddenRef)) hits.push(full);
            }
        }
    }
    await walk(repoRoot);
    assert.deepEqual(hits, []);
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
        'function novaHandleClearContext(',
        'function setNovaInFlight(',
        'function cxPickList(',
        'function openNovaAuditLogViewer(',
        'function buildNovaAuditLogModalBody(',
        'function classifyNovaAuditOutcome(',
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

test('Nova filesystem tool handlers factory is exported and wired', async () => {
    const { js } = await loadSources();
    assert.match(js, /function buildNovaFsHandlers\(/);
    assert.match(js, /async function _novaBridgeRequest\(/,
        'buildNovaFsHandlers depends on the _novaBridgeRequest helper');
    for (const name of [
        'fs_list',
        'fs_read',
        'fs_stat',
        'fs_search',
        'fs_write',
        'fs_delete',
        'fs_move',
    ]) {
        assert.match(js, new RegExp(`\\b${name}\\b`), `Missing fs handler key ${name}`);
    }
    // novaHandleSend must merge the fs handlers into the tool handler set.
    const novaHandleSend = js.match(/async function novaHandleSend\([\s\S]*?\n\}/);
    assert.ok(novaHandleSend, 'novaHandleSend body not found');
    assert.match(novaHandleSend[0], /buildNovaFsHandlers\(/,
        'novaHandleSend must compose buildNovaFsHandlers into the toolHandlers map');
});

test('Nova ST-API tool handlers factory is exported and wired', async () => {
    const { js } = await loadSources();
    assert.match(js, /function buildNovaStTools\(/);
    for (const name of [
        'st_list_characters',
        'st_read_character',
        'st_write_character',
        'st_list_worldbooks',
        'st_read_worldbook',
        'st_write_worldbook',
        'st_run_slash',
        'st_get_context',
        'st_list_profiles',
        'st_get_profile',
    ]) {
        assert.match(js, new RegExp(`\\b${name}\\b`), `Missing st handler key ${name}`);
    }
    // novaHandleSend must merge the st handlers into the tool handler set.
    const novaHandleSend = js.match(/async function novaHandleSend\([\s\S]*?\n\}/);
    assert.ok(novaHandleSend, 'novaHandleSend body not found');
    assert.match(novaHandleSend[0], /buildNovaStTools\(/,
        'novaHandleSend must compose buildNovaStTools into the toolHandlers map');
});

test('fs_write diff preview is composed into the approval modal (plan §4c)', async () => {
    const { js } = await loadSources();
    // The pure composer helper must exist.
    assert.match(js, /async function buildFsWriteDiffPreview\(/,
        'buildFsWriteDiffPreview helper not declared in index.js');
    // Must be invoked from novaHandleSend's confirmApproval arrow.
    const novaHandleSend = js.match(/async function novaHandleSend\([\s\S]*?\n\}/);
    assert.ok(novaHandleSend, 'novaHandleSend body not found');
    assert.match(novaHandleSend[0], /buildFsWriteDiffPreview\(/,
        'novaHandleSend.confirmApproval must call buildFsWriteDiffPreview');
    // diffText must flow into cxNovaApprovalModal.
    assert.match(novaHandleSend[0], /cxNovaApprovalModal\([\s\S]*?diffText[\s\S]*?\)/,
        'cxNovaApprovalModal must receive diffText from confirmApproval');
    // The composer must get the fs_read handler from the in-scope toolHandlers.
    assert.match(novaHandleSend[0], /fsRead:\s*toolHandlers\.fs_read/,
        'buildFsWriteDiffPreview call must pass toolHandlers.fs_read as fsRead');
});

test('shell_run handler is declared and wired into the dispatcher (plan §4b)', async () => {
    const { js } = await loadSources();
    // Factory must exist under NOVA AGENT.
    assert.match(js, /function buildNovaShellHandler\(/,
        'buildNovaShellHandler factory not declared in index.js');
    // Timeout bounds surfaced as named constants (matches the schema).
    assert.match(js, /const\s+SHELL_TIMEOUT_MIN_MS\s*=\s*100\b/,
        'SHELL_TIMEOUT_MIN_MS must be declared');
    assert.match(js, /const\s+SHELL_TIMEOUT_MAX_MS\s*=\s*300000\b/,
        'SHELL_TIMEOUT_MAX_MS must be declared');
    // The factory must ship a shell_run key.
    const factoryBody = js.match(/function buildNovaShellHandler\([\s\S]*?\n\}\s*\n/);
    assert.ok(factoryBody, 'buildNovaShellHandler body not found');
    assert.match(factoryBody[0], /shell_run:\s*async/,
        'buildNovaShellHandler must export a shell_run handler');
    assert.match(factoryBody[0], /['"]\/shell\/run['"]/,
        'shell_run must POST to /shell/run');
    // §8c: production factory must accept and forward `headersProvider`
    // so unit tests stub the same auth-header path the shipped code uses.
    assert.match(factoryBody[0], /headersProvider/,
        'buildNovaShellHandler must accept and forward headersProvider');
    // novaHandleSend must merge the shell handler into the dispatch map.
    const novaHandleSend = js.match(/async function novaHandleSend\([\s\S]*?\n\}/);
    assert.ok(novaHandleSend, 'novaHandleSend body not found');
    assert.match(novaHandleSend[0], /buildNovaShellHandler\(/,
        'novaHandleSend must compose buildNovaShellHandler into the toolHandlers map');
});

test('bridge requests carry ST auth headers (plan §8c)', async () => {
    const { js } = await loadSources();
    // getRequestHeaders must be imported from script.js so the module-level
    // fallback in _novaBridgeRequest / _novaBridgeWrite has a live
    // reference at runtime.
    assert.match(js, /import\s*\{[^}]*\bgetRequestHeaders\b[^}]*\}\s*from\s*['"][^'"]*script\.js['"]/,
        'getRequestHeaders must be imported from ST script.js');
    // _novaBridgeRequest must accept headersProvider and merge it into init.headers.
    const reqBody = js.match(/async function _novaBridgeRequest\([\s\S]*?\n\}/);
    assert.ok(reqBody, '_novaBridgeRequest body not found');
    assert.match(reqBody[0], /headersProvider/,
        '_novaBridgeRequest must accept headersProvider');
    assert.match(reqBody[0], /omitContentType:\s*true/,
        '_novaBridgeRequest must call the headers provider with omitContentType: true');
    // _novaBridgeWrite (soul/memory path) must also thread the auth header.
    const writeBody = js.match(/async function _novaBridgeWrite\([\s\S]*?\n\}/);
    assert.ok(writeBody, '_novaBridgeWrite body not found');
    assert.match(writeBody[0], /headersProvider/,
        '_novaBridgeWrite must accept headersProvider');
    assert.match(writeBody[0], /omitContentType:\s*true/,
        '_novaBridgeWrite must call the headers provider with omitContentType: true');
    // _novaBridgeReadText (soul/memory live disk reads) must use the same
    // module-level fallback so read-before-write and editor reload requests
    // carry ST auth headers in production.
    const readBody = js.match(/async function _novaBridgeReadText\([\s\S]*?\n\}/);
    assert.ok(readBody, '_novaBridgeReadText body not found');
    assert.match(readBody[0], /headersProvider/,
        '_novaBridgeReadText must accept headersProvider');
    assert.match(readBody[0], /getRequestHeaders/,
        '_novaBridgeReadText must fall back to imported getRequestHeaders');
    assert.match(readBody[0], /omitContentType:\s*true/,
        '_novaBridgeReadText must call the headers provider with omitContentType: true');
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

test('Tool capability filter gates the NOVA_TOOLS registry per turn (plan §4f)', async () => {
    const { js } = await loadSources();
    // The pure helper must exist alongside the probe.
    assert.match(js, /function filterNovaToolsByCapabilities\(/,
        'filterNovaToolsByCapabilities helper not declared in index.js');
    // Bridge-prefix allow list declared as a constant so the contract
    // is visible at a glance.
    assert.match(js, /const\s+NOVA_BRIDGE_TOOL_PREFIXES\s*=\s*Object\.freeze\(\[/,
        'NOVA_BRIDGE_TOOL_PREFIXES must be declared as a frozen array');
    // novaHandleSend must await the probe and feed it into the filter
    // BEFORE calling sendNovaTurn.
    const novaHandleSend = js.match(/async function novaHandleSend\([\s\S]*?\n\}/);
    assert.ok(novaHandleSend, 'novaHandleSend body not found');
    assert.match(novaHandleSend[0], /await\s+probeNovaBridge\(/,
        'novaHandleSend must await probeNovaBridge before the turn starts');
    assert.match(novaHandleSend[0], /filterNovaToolsByCapabilities\(\s*\{/,
        'novaHandleSend must call filterNovaToolsByCapabilities');
    // The filtered output must be what gets passed as `tools:`.
    assert.match(novaHandleSend[0], /tools:\s*effectiveTools/,
        'sendNovaTurn must receive the filtered tool list (effectiveTools)');
    assert.match(novaHandleSend[0], /if\s*\(\s*!textOnlyFallback\s*\)\s*\{[\s\S]*listUnavailableNovaSkillTools/,
        'skill missing-tool warnings must be skipped in text-only fallback mode');
    // A transcript notice must be emitted when bridge is absent.
    assert.match(novaHandleSend[0], /Nova bridge plugin not detected/,
        'novaHandleSend must warn the user when the bridge is missing');
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
    assert.match(js, /function syncNovaSettingInputs\(/,
        'Nova duplicate settings surfaces must have a sync helper');
    assert.match(js, /novaPickProfile[\s\S]*syncNovaSettingInputs\('profileName'/,
        'profile picker must sync both profile inputs before later saves');
    assert.match(js, /const novaBinding = NOVA_SETTING_BINDINGS\.find/,
        'Nova settings change handlers must update the changed binding before saveSettings reads duplicate ids');
    assert.match(js, /profileName:\s*''/,
        'Nova must not default to a hardcoded profile that can overwrite the user selection');
});

test('creator skills have deterministic fallback when models return empty tool frames', async () => {
    const { js } = await loadSources();
    assert.match(js, /function getNovaCreatorWriteToolName\(/,
        'creator write-tool mapping helper is missing');
    assert.match(js, /worldbook-creator[\s\S]*st_write_worldbook/,
        'worldbook creator must map to st_write_worldbook');
    assert.match(js, /character-creator[\s\S]*st_write_character/,
        'character creator must map to st_write_character');
    assert.match(js, /empty-response-retry-forced-\$\{creatorWriteToolName\}/,
        'empty creator responses must retry with the creator write tool forced');
    assert.match(js, /empty-response-json-fallback-\$\{creatorWriteToolName\}/,
        'empty creator responses must fall back to JSON arguments and a synthetic tool call');
    assert.match(js, /makeNovaSyntheticToolCall\(creatorWriteToolName, fallbackArgs\)/,
        'validated JSON fallback args must enter the normal approval-gated dispatcher');
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

test('generic modals are floating, draggable, and topmost on iPad', async () => {
    const { js, css } = await loadSources();
    const overlay = css.match(/\.cx-modal-overlay\s*\{([\s\S]*?)\n\}/);
    const box = css.match(/\.cx-modal-box\s*\{([\s\S]*?)\n\}/);
    const title = css.match(/\.cx-modal-title\s*\{([\s\S]*?)\n\}/);
    assert.ok(overlay, 'style.css missing .cx-modal-overlay block');
    assert.ok(box, 'style.css missing .cx-modal-box block');
    assert.ok(title, 'style.css missing .cx-modal-title block');
    assert.match(overlay[1], /z-index:\s*2147483000/,
        'modal layer must sit above the floating phone and ST panels');
    assert.match(overlay[1], /pointer-events:\s*none/,
        'modal layer must not behave like a fullscreen blocking sheet');
    assert.match(overlay[1], /overflow:\s*visible/,
        'modal layer must allow the floating box to be positioned freely');
    assert.match(box[1], /position:\s*fixed/,
        'modal box must be a floating viewport-positioned dialog');
    assert.match(box[1], /pointer-events:\s*auto/,
        'modal box must remain interactive when the layer ignores pointer events');
    assert.match(box[1], /max-height:\s*calc\(100dvh\s*-\s*24px\)/,
        'modal box must be constrained to the visual viewport');
    assert.match(box[1], /overflow-y:\s*auto/,
        'modal box must scroll its own long content');
    assert.match(title[1], /touch-action:\s*none/,
        'modal drag handle must disable browser touch panning while dragging on iPad');
    assert.match(js, /function enableCxModalDrag\(/,
        'shared modal drag helper must exist');
    assert.match(js, /addEventListener\('touchstart'/,
        'modal drag helper must use explicit Touch Events for iPad Safari support');
    assert.match(js, /addEventListener\('touchmove'[\s\S]*?passive:\s*false/,
        'modal drag helper must be able to prevent iPad viewport panning while dragging');
    assert.match(js, /addEventListener\('mousedown'/,
        'modal drag helper must keep mouse drag support for desktop browsers');
    const appendCount = (js.match(/document\.body\.appendChild\(overlay\);/g) || []).length;
    const dragCount = (js.match(/enableCxModalDrag\(overlay\);/g) || []).length;
    assert.equal(dragCount, appendCount,
        'every modal overlay appended to document.body must enable dragging');
});

test('main phone shell is floating and draggable on touch devices', async () => {
    const { js, css } = await loadSources();
    const wrapper = css.match(/#cx-panel-wrapper\s*\{([\s\S]*?)\n\}/);
    const statusbar = css.match(/\.cx-statusbar\s*\{([\s\S]*?)\n\}/);
    assert.ok(wrapper, 'style.css missing #cx-panel-wrapper block');
    assert.ok(statusbar, 'style.css missing .cx-statusbar block');
    assert.doesNotMatch(wrapper[1], /width:\s*100vw/,
        'phone wrapper must not consume the full viewport width');
    assert.doesNotMatch(wrapper[1], /(?:^|\n)\s*height:\s*100d?vh/,
        'phone wrapper must not consume the full viewport height');
    assert.doesNotMatch(wrapper[1], /background:\s*rgba\(0,\s*0,\s*0,\s*\.85\)/,
        'phone wrapper must not render a fullscreen dark backdrop');
    assert.match(wrapper[1], /right:\s*max\(/,
        'floating phone should default to a viewport edge instead of centered overlay layout');
    assert.match(statusbar[1], /touch-action:\s*none/,
        'phone drag handle must suppress iPad viewport panning while dragging');
    assert.match(js, /phonePosition:\s*null/,
        'phone drag position must be persisted in extension settings');
    assert.match(js, /function enableCxPhoneDrag\(/,
        'shared phone drag helper must exist');
    assert.match(js, /addEventListener\('touchmove'[\s\S]*?passive:\s*false/,
        'phone drag helper must use non-passive touchmove for iPad Safari');
    assert.match(js, /addEventListener\('mousedown'/,
        'phone drag helper must keep mouse drag support');
    assert.match(js, /enableCxPhoneDrag\(wrapper\);/,
        'panel creation and rebuild must wire phone dragging');
});

test('style.css keeps Command-X and Nova transcript text selectable', async () => {
    const { css } = await loadSources();
    const selectableBlock = css.match(/\.cx-messages,[\s\S]*?-webkit-touch-callout:\s*default;[\s\S]*?\}/);
    assert.ok(selectableBlock, 'selectable text override block not found');
    const block = selectableBlock[0];
    for (const selector of [
        '.cx-messages',
        '.cx-sms',
        '.cx-sms-body',
        '.cx-nova-transcript',
        '.cx-nova-msg',
        '.cx-nova-msg-body',
        '.cx-nova-toolcard',
    ]) {
        assert.ok(block.includes(selector), `selectable block missing ${selector}`);
    }
    assert.match(block, /user-select:\s*text/, 'selectable block must override phone shell user-select:none');
    assert.match(block, /-webkit-user-select:\s*text/, 'selectable block must support WebKit selection');
});

test('Nova transcript renderer handles the documented roles', async () => {
    const { js } = await loadSources();
    const fn = js.match(/function _novaRenderMessageNode\([\s\S]*?\n\}/);
    assert.ok(fn, '_novaRenderMessageNode not found');
    for (const role of ['user', 'assistant', 'tool', 'system', 'notice', 'user-preview']) {
        assert.match(fn[0], new RegExp(`'${role}'`), `Missing role handling: ${role}`);
    }
});

test('Nova context-clear control is wired', async () => {
    const { js } = await loadSources();
    assert.ok(js.includes('id="cx-nova-clear"'), 'Nova view missing Clear button');
    const fn = js.match(/function wireNovaView\([\s\S]*?\n\}/);
    assert.ok(fn, 'wireNovaView not found');
    assert.match(fn[0], /#cx-nova-clear/);
    assert.match(fn[0], /novaHandleClearContext\(\)/);
});

test('buildNovaSendRequest prefers ConnectionManagerRequestService then generateRaw', async () => {
    const { js } = await loadSources();
    const fn = js.match(/function buildNovaSendRequest\([\s\S]*?\n\}\n/);
    assert.ok(fn, 'buildNovaSendRequest not found');
    // Both dispatch paths must be present.
    assert.match(fn[0], /ConnectionManagerRequestService/);
    assert.match(fn[0], /generateRaw/);
});
