/**
 * Structural tests for the Nova app UI scaffolding (plan §2).
 *
 * These are static source-text checks against `index.js` and `style.css`.
 * Full DOM rendering would require the SillyTavern runtime (window, jQuery,
 * st-context imports), so we assert the scaffolding contract by grepping the
 * rendered template literal inside `buildPhone()` plus the routing guard in
 * `wirePhone()` and the CSS classes the subsequent sprints will target.
 *
 * If these break it means the Nova shell moved or a later sprint dropped a
 * hook that Phase 3+ depends on — surface that in the PR.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

async function loadSources() {
    const [js, css] = await Promise.all([
        readFile(resolve(repoRoot, 'index.js'), 'utf8'),
        readFile(resolve(repoRoot, 'style.css'), 'utf8'),
    ]);
    return { js, css };
}

test('home screen renders a Nova app tile with the correct data-app', async () => {
    const { js } = await loadSources();
    assert.match(js, /data-app="nova"[^>]*aria-label="Open Nova agent"/);
    assert.match(js, /cx-icon-nova/);
    assert.match(js, /<div class="cx-icon-label">Nova<\/div>/);
});

test('Nova view shell exists with all scaffolding anchors', async () => {
    const { js } = await loadSources();
    // View container
    assert.match(js, /<div class="cx-view" data-view="nova">/);
    // Header + three pills (profile / skill / tier) — IDs must be stable
    // since Phase 2c will swap these for chooser modals.
    assert.match(js, /id="cx-nova-pill-profile"/);
    assert.match(js, /id="cx-nova-pill-skill"/);
    assert.match(js, /id="cx-nova-pill-tier"/);
    // Transcript region (live-region for a11y)
    assert.match(js, /id="cx-nova-transcript"[^>]*role="log"[^>]*aria-live="polite"/);
    // Composer inputs — IDs Phase 3's agent loop will wire up
    assert.match(js, /id="cx-nova-input"/);
    assert.match(js, /id="cx-nova-send"/);
    assert.match(js, /id="cx-nova-cancel"/);
    // Nav footer back to home
    assert.match(js, /<div class="cx-view" data-view="nova">[\s\S]*?data-goto="home"[\s\S]*?<\/div>\s*<\/div>/);
});

test('Nova scaffolding starts inert (disabled composer + hidden cancel)', async () => {
    // Phase 2 ships scaffolding only. Agent loop lands in Phase 3.
    // Composer must be disabled and Cancel hidden until the loop wires in,
    // otherwise users can spam a no-op Send button.
    const { js } = await loadSources();
    const novaBlock = js.match(/<!-- Nova Agent View[^]*?<!-- Settings View -->/);
    assert.ok(novaBlock, 'Nova view block not found between its sentinel comments');
    const block = novaBlock[0];
    assert.match(block, /id="cx-nova-input"[^>]*disabled/);
    assert.match(block, /id="cx-nova-send"[^>]*disabled/);
    assert.match(block, /class="[^"]*cx-hidden[^"]*"[^>]*id="cx-nova-cancel"/);
});

test('wirePhone() app-routing guard accepts "nova"', async () => {
    // This is the gate that turns a home-screen tile click into a switchView
    // call. Missing "nova" here means the tile is dead even if the view DOM
    // is correct.
    const { js } = await loadSources();
    const guard = js.match(/if \(app === 'cmdx'[^)]+\) \{/);
    assert.ok(guard, 'wirePhone app-routing guard not found');
    assert.match(guard[0], /app === 'nova'/);
});

test('style.css exposes the cx-nova-* CSS contract used by later phases', async () => {
    const { css } = await loadSources();
    // Shell classes the scaffolding renders right now
    const required = [
        '.cx-icon-nova',
        '.cx-nova-header',
        '.cx-nova-title',
        '.cx-nova-pills',
        '.cx-nova-pill',
        '.cx-nova-transcript',
        '.cx-nova-empty',
        '.cx-nova-composer',
        '.cx-nova-input',
        // Tool-call card class — reserved now so Phase 3 doesn't have to
        // restyle the shell when it starts rendering cards.
        '.cx-nova-toolcard',
    ];
    for (const cls of required) {
        assert.ok(css.includes(cls), `style.css missing Nova class: ${cls}`);
    }
});
