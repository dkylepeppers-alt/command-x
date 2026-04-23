/**
 * Unit tests for Nova unified-diff preview helper (plan §4c).
 * Run with: node --test test/nova-diff.test.mjs
 *
 * Mirrors `buildNovaUnifiedDiff` in index.js under the
 * `/* === NOVA AGENT === *\/` section. Update in lockstep if the production
 * copy changes — this file is an inline copy per the AGENT_MEMORY convention
 * (index.js can't be `import`-ed from plain Node because of ST runtime deps).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const NOVA_DIFF_MAX_LINES_DEFAULT = 2000;
const NOVA_DIFF_MAX_DP_CELLS = 4_000_000;
const NOVA_DIFF_MAX_LINES_HARD = 10_000;

function buildNovaUnifiedDiff(oldContent, newContent, { path = '', maxLines = NOVA_DIFF_MAX_LINES_DEFAULT, isNewFile: isNewFileOpt } = {}) {
    const safePath = String(path || 'file').replace(/[\r\n]/g, ' ');
    const newStr = String(newContent ?? '');
    const isNewFile = typeof isNewFileOpt === 'boolean'
        ? isNewFileOpt
        : (oldContent === null || oldContent === undefined);
    const oldStr = isNewFile && (oldContent === null || oldContent === undefined)
        ? ''
        : String(oldContent ?? '');

    if (oldStr === newStr) return '';

    const oldLines = oldStr === '' ? [] : oldStr.split('\n');
    const newLines = newStr.split('\n');
    const m = oldLines.length, n = newLines.length;

    const fromHeader = isNewFile ? '--- /dev/null' : `--- a/${safePath}`;
    const toHeader = `+++ b/${safePath}`;

    if (m > NOVA_DIFF_MAX_LINES_HARD || n > NOVA_DIFF_MAX_LINES_HARD || m * n > NOVA_DIFF_MAX_DP_CELLS) {
        return [
            fromHeader,
            toHeader,
            `… diff too large to preview (old=${m} line${m === 1 ? '' : 's'}, new=${n} line${n === 1 ? '' : 's'}) …`,
        ].join('\n');
    }

    const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
            dp[i][j] = oldLines[i] === newLines[j]
                ? dp[i + 1][j + 1] + 1
                : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }

    const body = [];
    let i = 0, j = 0;
    while (i < m && j < n) {
        if (oldLines[i] === newLines[j]) { body.push(' ' + oldLines[i]); i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) { body.push('-' + oldLines[i]); i++; }
        else { body.push('+' + newLines[j]); j++; }
    }
    while (i < m) body.push('-' + oldLines[i++]);
    while (j < n) body.push('+' + newLines[j++]);

    const cap = Math.max(1, Number.isFinite(maxLines) ? Math.floor(maxLines) : NOVA_DIFF_MAX_LINES_DEFAULT);
    let bodyOut;
    if (body.length > cap) {
        const hidden = body.length - cap;
        bodyOut = body.slice(0, cap);
        bodyOut.push(`… diff truncated (${hidden} more line${hidden === 1 ? '' : 's'}) …`);
    } else {
        bodyOut = body;
    }

    return [fromHeader, toHeader, ...bodyOut].join('\n');
}

describe('buildNovaUnifiedDiff', () => {
    it('returns empty string when contents are identical', () => {
        assert.equal(buildNovaUnifiedDiff('a\nb\nc', 'a\nb\nc', { path: 'x.txt' }), '');
    });

    it('returns empty string for null-old and empty-new (both treated empty)', () => {
        assert.equal(buildNovaUnifiedDiff(null, '', { path: 'x.txt' }), '');
    });

    it('emits /dev/null from-header when old content is null (new file)', () => {
        const diff = buildNovaUnifiedDiff(null, 'hello\nworld', { path: 'greet.txt' });
        const lines = diff.split('\n');
        assert.equal(lines[0], '--- /dev/null');
        assert.equal(lines[1], '+++ b/greet.txt');
        assert.equal(lines[2], '+hello');
        assert.equal(lines[3], '+world');
    });

    it('emits /dev/null from-header when old content is undefined (new file)', () => {
        const diff = buildNovaUnifiedDiff(undefined, 'x', { path: 'x.txt' });
        assert.match(diff, /^--- \/dev\/null\n\+\+\+ b\/x\.txt\n\+x$/);
    });

    it('treats empty-string old content as an existing empty file being modified (NOT a new file)', () => {
        // Semantic fix from review: an existing 0-byte file is a modify,
        // not a create. Callers that truly mean "no prior file" must pass
        // `null` / `undefined` or set `isNewFile: true` explicitly.
        const diff = buildNovaUnifiedDiff('', 'x', { path: 'x.txt' });
        assert.match(diff, /^--- a\/x\.txt\n\+\+\+ b\/x\.txt\n\+x$/);
    });

    it('respects an explicit isNewFile: true override', () => {
        // If caller knows the file did not exist (e.g. fs_stat ENOENT) they
        // can force the /dev/null header even when they happen to hand us
        // the empty string for the "old" side.
        const diff = buildNovaUnifiedDiff('', 'x', { path: 'x.txt', isNewFile: true });
        assert.match(diff, /^--- \/dev\/null\n\+\+\+ b\/x\.txt\n\+x$/);
    });

    it('respects an explicit isNewFile: false override against null old', () => {
        // Inverse case: caller knows the file existed but just can't read
        // it (permission denied). Force modify headers.
        const diff = buildNovaUnifiedDiff(null, 'x', { path: 'x.txt', isNewFile: false });
        assert.match(diff, /^--- a\/x\.txt\n\+\+\+ b\/x\.txt\n\+x$/);
    });

    it('emits a/<path> from-header for modified files', () => {
        const diff = buildNovaUnifiedDiff('a\nb', 'a\nc', { path: 'dir/x.txt' });
        const lines = diff.split('\n');
        assert.equal(lines[0], '--- a/dir/x.txt');
        assert.equal(lines[1], '+++ b/dir/x.txt');
    });

    it('marks added lines with +', () => {
        const diff = buildNovaUnifiedDiff('a\nb', 'a\nb\nc', { path: 'x' });
        assert.ok(diff.includes('+c'), diff);
    });

    it('marks removed lines with -', () => {
        const diff = buildNovaUnifiedDiff('a\nb\nc', 'a\nc', { path: 'x' });
        // LCS should keep a and c; b is removed.
        assert.ok(diff.includes('-b'), diff);
        // a and c should appear as context-unchanged.
        assert.ok(diff.includes(' a'), diff);
        assert.ok(diff.includes(' c'), diff);
    });

    it('handles a pure-replacement hunk (no common lines)', () => {
        const diff = buildNovaUnifiedDiff('a\nb', 'c\nd', { path: 'x' });
        assert.ok(diff.includes('-a'));
        assert.ok(diff.includes('-b'));
        assert.ok(diff.includes('+c'));
        assert.ok(diff.includes('+d'));
    });

    it('preserves line order in mixed changes', () => {
        const diff = buildNovaUnifiedDiff('one\ntwo\nthree', 'one\nTWO\nthree', { path: 'x' });
        const body = diff.split('\n').slice(2); // drop two headers
        assert.deepEqual(body, [' one', '-two', '+TWO', ' three']);
    });

    it('truncates when body exceeds maxLines and appends a singular/plural sentinel', () => {
        const oldC = Array.from({ length: 10 }, (_, i) => `old${i}`).join('\n');
        const newC = Array.from({ length: 10 }, (_, i) => `new${i}`).join('\n');
        const diff = buildNovaUnifiedDiff(oldC, newC, { path: 'big', maxLines: 5 });
        const lines = diff.split('\n');
        // 2 headers + 5 body + 1 sentinel = 8
        assert.equal(lines.length, 8);
        assert.match(lines[lines.length - 1], /^… diff truncated \(\d+ more lines?\) …$/);
    });

    it('uses singular "line" in truncation sentinel when exactly 1 line hidden', () => {
        const oldC = 'a\nb\nc';
        const newC = 'd\ne\nf';
        // 6 diff lines total, cap at 5 → 1 hidden
        const diff = buildNovaUnifiedDiff(oldC, newC, { path: 'x', maxLines: 5 });
        assert.ok(diff.endsWith('… diff truncated (1 more line) …'), diff);
    });

    it('scrubs CR/LF from path to keep headers single-line', () => {
        const diff = buildNovaUnifiedDiff('a', 'b', { path: 'bad\npath\rname' });
        const lines = diff.split('\n');
        assert.equal(lines[0], '--- a/bad path name');
        assert.equal(lines[1], '+++ b/bad path name');
    });

    it('defaults path to "file" when empty', () => {
        const diff = buildNovaUnifiedDiff('a', 'b');
        assert.match(diff, /^--- a\/file\n\+\+\+ b\/file\n/);
    });

    it('coerces non-string newContent via String()', () => {
        const diff = buildNovaUnifiedDiff(null, 42, { path: 'n' });
        // 42 → "42", single line, new file
        assert.equal(diff, '--- /dev/null\n+++ b/n\n+42');
    });

    it('returns diff when old has trailing newline and new does not', () => {
        const diff = buildNovaUnifiedDiff('a\n', 'a', { path: 'x' });
        assert.notEqual(diff, '');
        // Old split: ['a', '']; New split: ['a']. The empty trailing line is removed.
        assert.ok(diff.includes('-'));
    });

    it('returns a bounded "diff too large" sentinel when line count exceeds hard cap', () => {
        // Exceeds NOVA_DIFF_MAX_LINES_HARD on the new side. Building the
        // strings with a simple `.repeat()` keeps the test cheap — we're
        // verifying the guard fires, not LCS correctness for huge inputs.
        const oldC = 'a';
        const newC = (`line\n`).repeat(10_001) + 'last';
        const diff = buildNovaUnifiedDiff(oldC, newC, { path: 'huge.txt' });
        const lines = diff.split('\n');
        assert.equal(lines.length, 3, 'expected 3 lines (2 headers + 1 sentinel)');
        assert.equal(lines[0], '--- a/huge.txt');
        assert.equal(lines[1], '+++ b/huge.txt');
        assert.match(lines[2], /^… diff too large to preview \(old=1 line, new=\d+ lines\) …$/);
    });

    it('returns "diff too large" sentinel when m*n exceeds the DP-cell budget', () => {
        // Both sides individually under the per-side hard cap (10k), but
        // their product exceeds NOVA_DIFF_MAX_DP_CELLS (4M). 2500 * 2500 =
        // 6.25M — over the budget.
        const oldC = Array.from({ length: 2500 }, (_, i) => `o${i}`).join('\n');
        const newC = Array.from({ length: 2500 }, (_, i) => `n${i}`).join('\n');
        const diff = buildNovaUnifiedDiff(oldC, newC, { path: 'med.txt' });
        assert.match(diff, /^--- a\/med\.txt\n\+\+\+ b\/med\.txt\n… diff too large to preview \(old=2500 lines, new=2500 lines\) …$/);
    });

    it('large-diff sentinel still uses /dev/null header for new-file creates', () => {
        const newC = 'line\n'.repeat(10_001) + 'last';
        const diff = buildNovaUnifiedDiff(null, newC, { path: 'huge.txt' });
        assert.match(diff, /^--- \/dev\/null\n\+\+\+ b\/huge\.txt\n… diff too large to preview/);
    });
});
