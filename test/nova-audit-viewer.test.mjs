/**
 * Unit tests for the Nova audit-log viewer (plan §2b / §7b).
 * Run with: node --test test/nova-audit-viewer.test.mjs
 *
 * The DOM wrapper `openNovaAuditLogViewer` is not covered here (no
 * JSDOM); the pure body builder + outcome classifier carry the
 * escape-safety + ordering contracts.
 *
 * Inline-copy convention per AGENT_MEMORY: when production helpers
 * change, mirror them here. The source-shape assertion at the end
 * fails fast if the production signatures drift.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// -------- Inline copies of pure helpers from index.js --------

function escHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
}
function escAttr(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function classifyNovaAuditOutcome(outcome) {
    let s;
    try { s = String(outcome ?? '').trim(); } catch (_) { return 'info'; }
    if (!s) return 'info';
    if (s === 'ok') return 'ok';
    if (s === 'cap-hit') return 'warn';
    if (s === 'aborted') return 'warn';
    if (s.startsWith('denied:')) return 'warn';
    if (s.startsWith('error:')) return 'error';
    return 'info';
}

function _novaFormatAuditTimestamp(ts, { nowImpl } = {}) {
    const n = Number(ts);
    if (!Number.isFinite(n)) return String(ts ?? '');
    try {
        const d = new Date(n);
        const pad = (v) => String(v).padStart(2, '0');
        const hh = pad(d.getHours());
        const mm = pad(d.getMinutes());
        const ss = pad(d.getSeconds());
        const now = (typeof nowImpl === 'function' ? nowImpl() : Date.now());
        const today = new Date(now);
        const sameDay = d.getFullYear() === today.getFullYear()
            && d.getMonth() === today.getMonth()
            && d.getDate() === today.getDate();
        if (sameDay) return `${hh}:${mm}:${ss}`;
        return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${hh}:${mm}:${ss}`;
    } catch (_) {
        return String(ts);
    }
}

function buildNovaAuditLogModalBody(entries, { now, limit = 200 } = {}) {
    const list = Array.isArray(entries) ? entries.slice() : [];
    const total = list.length;
    list.reverse();
    let lim = Number(limit);
    if (!Number.isFinite(lim) || lim <= 0) lim = 200;
    const cap = Math.max(1, Math.min(Math.floor(lim), 500));
    const shown = list.slice(0, cap);
    const truncated = total > shown.length;
    const nowImpl = Number.isFinite(now) ? () => now : undefined;

    const header = `<div class="cx-nova-audit-summary">${
        total === 0
            ? 'No tool calls recorded yet for this chat.'
            : `Showing ${shown.length} of ${total} tool call${total === 1 ? '' : 's'} (newest first).`
    }</div>`;

    if (total === 0) {
        return [
            header,
            `<div class="cx-nova-audit-empty">When Nova dispatches a tool, an entry lands here with the outcome — including denials and errors. The log is capped at 500 entries per chat.</div>`,
        ].join('\n');
    }

    const rows = shown.map((raw) => {
        const e = raw && typeof raw === 'object' ? raw : {};
        const sev = classifyNovaAuditOutcome(e.outcome);
        const ts = _novaFormatAuditTimestamp(e.ts, { nowImpl });
        const tool = String(e.tool || 'unknown');
        const args = String(e.argsSummary ?? '');
        const outcome = String(e.outcome ?? '');
        return `<div class="cx-nova-audit-row" data-sev="${escAttr(sev)}">`
            + `<div class="cx-nova-audit-row-head">`
            + `<span class="cx-nova-audit-ts">${escHtml(ts)}</span>`
            + `<span class="cx-nova-audit-tool">${escHtml(tool)}</span>`
            + `<span class="cx-nova-audit-outcome">${escHtml(outcome)}</span>`
            + `</div>`
            + (args ? `<div class="cx-nova-audit-args">${escHtml(args)}</div>` : '')
            + `</div>`;
    }).join('\n');

    const footer = truncated
        ? `<div class="cx-nova-audit-truncated">…${total - shown.length} older entries hidden.</div>`
        : '';

    return [header, `<div class="cx-nova-audit-list">${rows}</div>`, footer].filter(Boolean).join('\n');
}

// -------- Tests --------

describe('classifyNovaAuditOutcome', () => {
    it('classifies the closed-enum dispatcher outcomes', () => {
        assert.equal(classifyNovaAuditOutcome('ok'), 'ok');
        assert.equal(classifyNovaAuditOutcome('cap-hit'), 'warn');
        assert.equal(classifyNovaAuditOutcome('aborted'), 'warn');
        assert.equal(classifyNovaAuditOutcome('denied:tier-too-low'), 'warn');
        assert.equal(classifyNovaAuditOutcome('denied:user-rejected'), 'warn');
        assert.equal(classifyNovaAuditOutcome('denied:unknown-tool'), 'warn');
        assert.equal(classifyNovaAuditOutcome('denied:malformed-arguments'), 'warn');
        assert.equal(classifyNovaAuditOutcome('denied:no-confirmer'), 'warn');
        assert.equal(classifyNovaAuditOutcome('denied:confirmer-error:boom'), 'warn');
        assert.equal(classifyNovaAuditOutcome('error:no-handler'), 'error');
        assert.equal(classifyNovaAuditOutcome('error:Boom'), 'error');
        assert.equal(classifyNovaAuditOutcome('error:'), 'error');
    });

    it('falls back to "info" for blank / unknown / non-string outcomes', () => {
        assert.equal(classifyNovaAuditOutcome(''), 'info');
        assert.equal(classifyNovaAuditOutcome('   '), 'info');
        assert.equal(classifyNovaAuditOutcome(null), 'info');
        assert.equal(classifyNovaAuditOutcome(undefined), 'info');
        assert.equal(classifyNovaAuditOutcome(42), 'info');
        assert.equal(classifyNovaAuditOutcome('something-else'), 'info');
    });

    it('never throws on hostile input', () => {
        assert.doesNotThrow(() => classifyNovaAuditOutcome({}));
        assert.doesNotThrow(() => classifyNovaAuditOutcome([]));
        assert.doesNotThrow(() => classifyNovaAuditOutcome(Object.create(null)));
    });
});

describe('_novaFormatAuditTimestamp', () => {
    it('renders HH:MM:SS for same-day timestamps', () => {
        const now = new Date(2026, 3, 25, 14, 30, 0).getTime();
        const earlier = new Date(2026, 3, 25, 9, 5, 7).getTime();
        const out = _novaFormatAuditTimestamp(earlier, { nowImpl: () => now });
        assert.equal(out, '09:05:07');
    });

    it('prefixes month/day for older entries', () => {
        const now = new Date(2026, 3, 25, 14, 30, 0).getTime();
        const earlier = new Date(2026, 2, 9, 23, 1, 2).getTime();
        const out = _novaFormatAuditTimestamp(earlier, { nowImpl: () => now });
        assert.equal(out, '03/09 23:01:02');
    });

    it('returns input string for non-finite timestamps', () => {
        assert.equal(_novaFormatAuditTimestamp('nope'), 'nope');
        assert.equal(_novaFormatAuditTimestamp(NaN), 'NaN');
        assert.equal(_novaFormatAuditTimestamp(undefined), '');
    });
});

describe('buildNovaAuditLogModalBody — empty state', () => {
    it('renders a friendly placeholder when no entries', () => {
        const html = buildNovaAuditLogModalBody([]);
        assert.match(html, /cx-nova-audit-summary/);
        assert.match(html, /No tool calls recorded yet/);
        assert.match(html, /cx-nova-audit-empty/);
        assert.doesNotMatch(html, /cx-nova-audit-list/);
        assert.doesNotMatch(html, /cx-nova-audit-row\b/);
    });

    it('treats non-array input as empty (never throws)', () => {
        for (const bad of [null, undefined, 'string', 42, {}]) {
            const html = buildNovaAuditLogModalBody(bad);
            assert.match(html, /No tool calls recorded yet/, `should treat ${typeof bad} as empty`);
        }
    });
});

describe('buildNovaAuditLogModalBody — rendering', () => {
    const NOW = new Date(2026, 3, 25, 14, 30, 0).getTime();

    it('renders entries newest-first and reports total', () => {
        const entries = [
            { ts: NOW - 3000, tool: 'fs_read', argsSummary: 'path=a', outcome: 'ok' },
            { ts: NOW - 2000, tool: 'fs_write', argsSummary: 'path=b', outcome: 'denied:user-rejected' },
            { ts: NOW - 1000, tool: 'st_run_slash', argsSummary: 'command=/echo', outcome: 'error:Boom' },
        ];
        const html = buildNovaAuditLogModalBody(entries, { now: NOW });
        // Newest-first: st_run_slash should appear before fs_read in the HTML.
        const idxLatest = html.indexOf('st_run_slash');
        const idxMiddle = html.indexOf('fs_write');
        const idxOldest = html.indexOf('fs_read');
        assert.ok(idxLatest > -1 && idxMiddle > -1 && idxOldest > -1, 'all entries rendered');
        assert.ok(idxLatest < idxMiddle && idxMiddle < idxOldest, 'newest-first order');
        assert.match(html, /Showing 3 of 3 tool calls/);
    });

    it('classifies severity per row via data-sev attribute', () => {
        const entries = [
            { ts: NOW - 3000, tool: 't1', argsSummary: '', outcome: 'ok' },
            { ts: NOW - 2000, tool: 't2', argsSummary: '', outcome: 'denied:tier-too-low' },
            { ts: NOW - 1000, tool: 't3', argsSummary: '', outcome: 'error:Boom' },
            { ts: NOW - 500, tool: 't4', argsSummary: '', outcome: 'cap-hit' },
            { ts: NOW - 100, tool: 't5', argsSummary: '', outcome: 'mystery' },
        ];
        const html = buildNovaAuditLogModalBody(entries, { now: NOW });
        // Match in newest-first order
        const sevs = [...html.matchAll(/data-sev="([^"]+)"/g)].map(m => m[1]);
        assert.deepEqual(sevs, ['info', 'warn', 'error', 'warn', 'ok']);
    });

    it('omits the args block when argsSummary is empty', () => {
        const entries = [{ ts: NOW, tool: 'foo', argsSummary: '', outcome: 'ok' }];
        const html = buildNovaAuditLogModalBody(entries, { now: NOW });
        assert.doesNotMatch(html, /cx-nova-audit-args/);
    });

    it('renders the args block when argsSummary present', () => {
        const entries = [{ ts: NOW, tool: 'foo', argsSummary: 'tier=read', outcome: 'ok' }];
        const html = buildNovaAuditLogModalBody(entries, { now: NOW });
        assert.match(html, /cx-nova-audit-args">tier=read</);
    });

    it('singularises "tool call" when total === 1', () => {
        const entries = [{ ts: NOW, tool: 'foo', argsSummary: '', outcome: 'ok' }];
        const html = buildNovaAuditLogModalBody(entries, { now: NOW });
        assert.match(html, /Showing 1 of 1 tool call \(/);
    });

    it('handles non-object entries gracefully (no throw, sane defaults)', () => {
        const entries = [null, 42, 'oops', { ts: NOW, tool: 'real', argsSummary: '', outcome: 'ok' }];
        const html = buildNovaAuditLogModalBody(entries, { now: NOW });
        // 4 entries total reported even though 3 are junk; junk renders as "unknown"
        assert.match(html, /Showing 4 of 4 tool calls/);
        assert.match(html, /cx-nova-audit-tool">unknown</);
        assert.match(html, /cx-nova-audit-tool">real</);
    });
});

describe('buildNovaAuditLogModalBody — limit / truncation', () => {
    const NOW = new Date(2026, 3, 25, 14, 30, 0).getTime();
    const makeEntries = (n) => Array.from({ length: n }, (_, i) => ({
        ts: NOW - (n - i) * 1000,
        tool: `t${i}`,
        argsSummary: '',
        outcome: 'ok',
    }));

    it('caps display rows at the requested limit and shows a footer', () => {
        const html = buildNovaAuditLogModalBody(makeEntries(10), { now: NOW, limit: 4 });
        const rowCount = (html.match(/class="cx-nova-audit-row"/g) || []).length;
        assert.equal(rowCount, 4);
        assert.match(html, /…6 older entries hidden\./);
        // Summary still reports the true total
        assert.match(html, /Showing 4 of 10 tool calls/);
    });

    it('omits the truncated footer when nothing was hidden', () => {
        const html = buildNovaAuditLogModalBody(makeEntries(3), { now: NOW, limit: 100 });
        assert.doesNotMatch(html, /older entries hidden/);
    });

    it('clamps limit to the [1, 500] range', () => {
        const html0 = buildNovaAuditLogModalBody(makeEntries(5), { now: NOW, limit: 0 });
        // 0 clamps to 200 (default fallback path)
        assert.match(html0, /Showing 5 of 5/);

        const htmlNeg = buildNovaAuditLogModalBody(makeEntries(5), { now: NOW, limit: -10 });
        assert.match(htmlNeg, /Showing 5 of 5/);

        const htmlBig = buildNovaAuditLogModalBody(makeEntries(5), { now: NOW, limit: 99999 });
        assert.match(htmlBig, /Showing 5 of 5/);
    });
});

describe('buildNovaAuditLogModalBody — escape safety', () => {
    const NOW = new Date(2026, 3, 25, 14, 30, 0).getTime();

    it('escapes HTML in tool / args / outcome', () => {
        const entries = [{
            ts: NOW,
            tool: '<script>alert(1)</script>',
            argsSummary: 'path="<img src=x onerror=alert(1)>"',
            outcome: 'error:</span><script>alert(2)</script>',
        }];
        const html = buildNovaAuditLogModalBody(entries, { now: NOW });
        // No raw `<script>` or `</span>` tags should leak through — escHtml
        // turns `<` and `>` into entities, neutralising injection. Case-
        // insensitive matches so a future hostile-input test using
        // `<SCRIPT>` still trips this guard.
        assert.doesNotMatch(html, /<script\b/i);
        assert.doesNotMatch(html, /<\/script>/i);
        assert.doesNotMatch(html, /<img\s/i);
        assert.doesNotMatch(html, /<\/span><script\b/i);
        // Verify each user string survives in escaped form
        assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
        assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
        assert.match(html, /&lt;\/span&gt;&lt;script&gt;alert\(2\)/);
    });

    it('escapes severity attribute (defense in depth)', () => {
        // The classifier output is closed-enum, but escAttr is applied
        // unconditionally and the `outcome` text content goes through
        // escHtml. Verify hostile outcome strings cannot break out of
        // the surrounding span (no raw `<`, `>`, `"=` patterns inside
        // the rendered body).
        const html = buildNovaAuditLogModalBody(
            [{ ts: NOW, tool: 't', argsSummary: '', outcome: 'denied:"><script>x</script>' }],
            { now: NOW },
        );
        // Raw markup must not leak (case-insensitive)
        assert.doesNotMatch(html, /<script\b/i);
        assert.doesNotMatch(html, /"><script\b/i);
        // Severity attribute is from a closed enum; outcome was 'denied:*'
        assert.match(html, /data-sev="warn"/);
    });
});

describe('source-shape contract', () => {
    it('production index.js contains expected exports + wiring', async () => {
        const here = dirname(fileURLToPath(import.meta.url));
        const src = await readFile(resolve(here, '..', 'index.js'), 'utf8');
        assert.match(src, /function classifyNovaAuditOutcome\(outcome\)/);
        assert.match(src, /function buildNovaAuditLogModalBody\(entries,/);
        assert.match(src, /function openNovaAuditLogViewer\(\)/);
        assert.match(src, /id="cx-set-nova-audit"/);
        assert.match(src, /#cx-set-nova-audit'\)\?\.addEventListener/);
        // The viewer must invoke the pure builder (don't drift)
        assert.match(src, /buildNovaAuditLogModalBody\(entries\)/);
    });
});
