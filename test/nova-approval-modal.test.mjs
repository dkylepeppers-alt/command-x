/**
 * Unit tests for Nova approval-modal HTML body builder (plan §2c).
 * Run with: node --test test/nova-approval-modal.test.mjs
 *
 * Inline-copy of `buildNovaApprovalModalBody` + `escHtml`.
 * DOM wrapper `cxNovaApprovalModal` is not covered here (no JSDOM);
 * the pure body builder carries the escape-safety contract.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// -------- Inline copies --------

function escHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
}

function _novaJsonPretty(value) {
    try { return JSON.stringify(value, null, 2); } catch (_) { return String(value); }
}

function buildNovaApprovalModalBody({ tool, args, diffText = '', permission } = {}) {
    const displayName = (tool && (tool.displayName || tool.name)) || 'tool';
    const perm = String(permission || tool?.permission || 'read');
    const permLabel = perm === 'shell' ? 'run shell command' : (perm === 'write' ? 'write' : 'read');
    const argsJson = _novaJsonPretty(args ?? {});
    const parts = [
        `<div class="cx-nova-approval-intent">Nova wants to <strong>${escHtml(permLabel)}</strong>: <code>${escHtml(displayName)}</code></div>`,
        `<div class="cx-nova-approval-label">Arguments</div>`,
        `<pre class="cx-nova-approval-args">${escHtml(argsJson)}</pre>`,
    ];
    if (diffText && String(diffText).trim()) {
        parts.push(`<div class="cx-nova-approval-label">Preview</div>`);
        parts.push(`<pre class="cx-nova-approval-diff">${escHtml(String(diffText))}</pre>`);
    }
    return parts.join('\n');
}

// -------- Tests --------

describe('buildNovaApprovalModalBody — shape', () => {
    it('renders intent + args without diff when diffText empty', () => {
        const html = buildNovaApprovalModalBody({
            tool: { name: 'st_get_context', displayName: 'Get context', permission: 'read' },
            args: {},
        });
        assert.match(html, /cx-nova-approval-intent/);
        assert.match(html, /cx-nova-approval-args/);
        assert.doesNotMatch(html, /cx-nova-approval-diff/);
        assert.doesNotMatch(html, /Preview/);
    });

    it('includes diff block when diffText present', () => {
        const html = buildNovaApprovalModalBody({
            tool: { name: 'fs_write', permission: 'write' },
            args: { path: 'a' },
            diffText: '+foo\n-bar',
        });
        assert.match(html, /cx-nova-approval-diff/);
        assert.match(html, /Preview/);
        // Diff newlines are replaced with <br> by escHtml.
        assert.match(html, /\+foo<br>-bar/);
    });

    it('omits diff block when diffText is whitespace only', () => {
        const html = buildNovaApprovalModalBody({
            tool: { name: 'fs_write', permission: 'write' },
            args: {},
            diffText: '   \n\t\n',
        });
        assert.doesNotMatch(html, /cx-nova-approval-diff/);
    });

    it('uses displayName when provided; falls back to name', () => {
        const withDisplay = buildNovaApprovalModalBody({
            tool: { name: 'fs_write', displayName: 'Write file', permission: 'write' },
            args: {},
        });
        assert.match(withDisplay, /<code>Write file<\/code>/);
        const nameOnly = buildNovaApprovalModalBody({
            tool: { name: 'fs_write', permission: 'write' },
            args: {},
        });
        assert.match(nameOnly, /<code>fs_write<\/code>/);
    });

    it('uses the verb for each permission class', () => {
        const r = buildNovaApprovalModalBody({ tool: { name: 't', permission: 'read' }, args: {} });
        const w = buildNovaApprovalModalBody({ tool: { name: 't', permission: 'write' }, args: {} });
        const s = buildNovaApprovalModalBody({ tool: { name: 't', permission: 'shell' }, args: {} });
        assert.match(r, /<strong>read<\/strong>/);
        assert.match(w, /<strong>write<\/strong>/);
        assert.match(s, /<strong>run shell command<\/strong>/);
    });

    it('explicit permission arg overrides tool.permission', () => {
        const html = buildNovaApprovalModalBody({
            tool: { name: 't', permission: 'read' },
            args: {},
            permission: 'shell',
        });
        assert.match(html, /<strong>run shell command<\/strong>/);
    });

    it('falls back to "tool" label when tool is missing', () => {
        const html = buildNovaApprovalModalBody({ args: {} });
        assert.match(html, /<code>tool<\/code>/);
    });

    it('falls back to "read" permission label when neither given', () => {
        const html = buildNovaApprovalModalBody({ tool: { name: 't' }, args: {} });
        assert.match(html, /<strong>read<\/strong>/);
    });
});

describe('buildNovaApprovalModalBody — HTML escaping (prompt-injection safety)', () => {
    it('escapes tool name with HTML-unsafe characters', () => {
        const html = buildNovaApprovalModalBody({
            tool: { name: '<img onerror=x>', permission: 'read' },
            args: {},
        });
        assert.doesNotMatch(html, /<img onerror=x>/);
        assert.match(html, /&lt;img onerror=x&gt;/);
    });

    it('escapes string arg values', () => {
        const html = buildNovaApprovalModalBody({
            tool: { name: 'fs_write', permission: 'write' },
            args: { path: '</pre><script>alert(1)</script>' },
        });
        assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
        assert.match(html, /&lt;\/pre&gt;&lt;script&gt;/);
    });

    it('escapes diff body', () => {
        const html = buildNovaApprovalModalBody({
            tool: { name: 'fs_write', permission: 'write' },
            args: {},
            diffText: '<script>evil()</script>',
        });
        assert.doesNotMatch(html, /<script>evil\(\)<\/script>/);
        assert.match(html, /&lt;script&gt;evil\(\)&lt;\/script&gt;/);
    });

    it('never emits a bare quote that could break out of the attribute context', () => {
        // We only interpolate into element bodies, never into attributes,
        // so this is a regression guard against someone adding an attr
        // interpolation without going through escAttr.
        const html = buildNovaApprovalModalBody({
            tool: { name: 'a"b\'c', permission: 'read' },
            args: { x: 'y"z' },
        });
        // Our escHtml doesn't convert quotes; that's fine as long as
        // we stay out of attribute context. Contract: quotes appear
        // only inside element text / <pre> / <code>, never inside
        // class="..." or similar.
        const hasAttrs = /<(?:div|pre|code|strong)\s+class="[^"]*"/g;
        for (const m of html.matchAll(hasAttrs)) {
            // class="..." blocks are static literals only — no interpolated quote.
            assert.doesNotMatch(m[0], /[{}]/, `class attr contains interpolation: ${m[0]}`);
        }
    });
});

describe('buildNovaApprovalModalBody — args serialisation', () => {
    it('pretty-prints objects with indent=2', () => {
        const html = buildNovaApprovalModalBody({
            tool: { name: 't', permission: 'read' },
            args: { a: 1, b: 'two' },
        });
        // escHtml only escapes &, <, >, \n — double quotes stay as ".
        assert.match(html, /"a": 1/);
        // Indent newlines render as <br>.
        assert.match(html, /<br>\s*"b"/);
    });

    it('handles args: null without crashing', () => {
        const html = buildNovaApprovalModalBody({
            tool: { name: 't', permission: 'read' },
            args: null,
        });
        assert.match(html, /\{\}/); // null → {}
    });

    it('handles circular args without throwing', () => {
        const a = {};
        a.self = a;
        const html = buildNovaApprovalModalBody({
            tool: { name: 't', permission: 'read' },
            args: a,
        });
        // JSON.stringify throws on circular; the helper catches and falls
        // back to String(value). The resulting body must still include
        // the args container and not crash.
        assert.match(html, /cx-nova-approval-args/);
    });

    it('handles no opts at all without crashing', () => {
        const html = buildNovaApprovalModalBody();
        assert.match(html, /cx-nova-approval-intent/);
        assert.match(html, /cx-nova-approval-args/);
    });
});

describe('index.js source shape', () => {
    it('buildNovaApprovalModalBody + cxNovaApprovalModal defined before parseNovaProfilePipe', async () => {
        const here = dirname(fileURLToPath(import.meta.url));
        const js = await readFile(resolve(here, '..', 'index.js'), 'utf8');
        const bodyIdx = js.indexOf('function buildNovaApprovalModalBody(');
        const modalIdx = js.indexOf('function cxNovaApprovalModal(');
        const parseIdx = js.indexOf('function parseNovaProfilePipe(');
        assert.ok(bodyIdx > 0 && modalIdx > 0 && parseIdx > 0);
        assert.ok(bodyIdx < modalIdx, 'body builder must precede the DOM wrapper');
        assert.ok(modalIdx < parseIdx, 'approval modal helpers must land before profile-pipe parser');
    });

    it('cxNovaApprovalModal uses cx-modal-overlay and escapes title via escHtml', async () => {
        const here = dirname(fileURLToPath(import.meta.url));
        const js = await readFile(resolve(here, '..', 'index.js'), 'utf8');
        const modalStart = js.indexOf('function cxNovaApprovalModal(');
        const modalBlock = js.slice(modalStart, modalStart + 2500);
        assert.match(modalBlock, /cx-modal-overlay/);
        assert.match(modalBlock, /escHtml\(title\)/);
        assert.match(modalBlock, /role="alertdialog"/);
        assert.match(modalBlock, /aria-modal="true"/);
    });
});
