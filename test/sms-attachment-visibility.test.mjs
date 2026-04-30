/**
 * Static source-contract tests for SMS photo attachment visibility.
 * Run with: node --test test/sms-attachment-visibility.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

async function loadSources() {
    const [js, manifestRaw] = await Promise.all([
        readFile(resolve(repoRoot, 'index.js'), 'utf8'),
        readFile(resolve(repoRoot, 'manifest.json'), 'utf8'),
    ]);
    return { js, manifest: JSON.parse(manifestRaw) };
}

test('manifest registers the SMS attachment generation interceptor', async () => {
    const { manifest } = await loadSources();
    assert.equal(manifest.generate_interceptor, 'commandXSmsAttachmentInterceptor');
});

test('instant and batch SMS photo sends stage attachments before generation', async () => {
    const { js } = await loadSources();

    const sendToChatStart = js.indexOf('async function sendToChat(');
    const interceptorStart = js.indexOf('globalThis.commandXSmsAttachmentInterceptor');
    assert.ok(sendToChatStart > -1 && interceptorStart > sendToChatStart, 'sendToChat/interceptor section not found');
    const sendToChatSection = js.slice(sendToChatStart, interceptorStart);
    assert.match(sendToChatSection, /stageSmsVisionAttachments\(!isCommand \? cleanAttachment : null\);/);

    const flushQueueStart = js.indexOf('function flushQueue()');
    const smsParsingStart = js.indexOf('/* ======================================================================\n   SMS TAG PARSING', flushQueueStart);
    assert.ok(flushQueueStart > -1 && smsParsingStart > flushQueueStart, 'flushQueue section not found');
    const flushQueueSection = js.slice(flushQueueStart, smsParsingStart);
    const stageIndex = flushQueueSection.indexOf('stageSmsVisionAttachments(composeQueue');
    const sendClickIndex = flushQueueSection.indexOf('sendBtn.click()');
    assert.ok(stageIndex > -1, 'flushQueue must stage queued SMS photo attachments');
    assert.ok(sendClickIndex > stageIndex, 'flushQueue must stage attachments before clicking ST send');
    assert.match(flushQueueSection, /\.filter\(q => !q\.cmdType && !q\.isNeural\)\s*\.map\(q => q\.attachment\)/,
        'batch staging must skip neural/command entries and stage only queued attachments');
});

test('generation interceptor injects every staged image as list media and clears the one-shot queue', async () => {
    const { js } = await loadSources();
    const interceptorStart = js.indexOf('globalThis.commandXSmsAttachmentInterceptor');
    assert.ok(interceptorStart > -1, 'interceptor not found');
    const interceptorSection = js.slice(interceptorStart, js.indexOf('/** Send immediately', interceptorStart));

    assert.match(interceptorSection, /const pendingAttachments = Array\.isArray\(pendingSmsVisionAttachments\) \? pendingSmsVisionAttachments\.slice\(\) : \[\];/);
    assert.match(interceptorSection, /for \(const attachment of attachments\) \{\s*last\.extra\.media\.push\(\{ type: 'image', url: attachment\.dataUrl \}\);/);
    assert.match(interceptorSection, /last\.extra\.media_display = 'list';/);
    assert.match(interceptorSection, /pendingSmsVisionAttachments = \[\];/);
});
