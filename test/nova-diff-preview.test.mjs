/**
 * Unit tests for the fs_write approval diff-preview composer (plan §4c).
 * Run with: node --test test/nova-diff-preview.test.mjs
 *
 * Inline-copies `buildFsWriteDiffPreview` from `index.js` under the
 * `/* === NOVA AGENT === *\/` section (right after
 * `buildNovaUnifiedDiff`). Per AGENT_MEMORY inline-copy convention:
 * when the production helper changes, update this copy.
 *
 * The helper is pure — no DOM, no network, no localStorage — so it's
 * fully unit-testable with function stubs for `fsRead` and `buildDiff`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// -------- Inline copy of production helper --------

async function buildFsWriteDiffPreview(opts) {
    const { tool, args, fsRead, buildDiff } = (opts && typeof opts === 'object') ? opts : {};
    if (!tool || tool.name !== 'fs_write') return '';
    const a = (args && typeof args === 'object') ? args : {};
    if (typeof a.path !== 'string' || !a.path) return '';
    if (typeof a.content !== 'string') return '';
    const diffFn = typeof buildDiff === 'function' ? buildDiff : null;
    if (!diffFn) return '';
    const readFn = typeof fsRead === 'function' ? fsRead : null;

    let oldContent = null;
    if (readFn) {
        let readRes;
        try {
            readRes = await readFn({ path: a.path });
        } catch (_) {
            return '';
        }
        if (readRes && typeof readRes === 'object') {
            if (readRes.error === 'not-found') {
                oldContent = null;
            } else if (typeof readRes.error === 'string') {
                return '';
            } else if (typeof readRes.content === 'string') {
                oldContent = readRes.content;
            } else {
                return '';
            }
        } else {
            return '';
        }
    }
    try {
        return String(diffFn(oldContent, a.content, { path: a.path }) || '');
    } catch (_) {
        return '';
    }
}

// -------- Minimal stub buildDiff that captures its inputs --------

function makeDiffStub() {
    const calls = [];
    const fn = (oldContent, newContent, opts) => {
        calls.push({ oldContent, newContent, opts });
        if (oldContent === null || oldContent === undefined) {
            return `--- /dev/null\n+++ b/${opts?.path || 'file'}\n+${newContent}`;
        }
        if (oldContent === newContent) return '';
        return `--- a/${opts?.path || 'file'}\n+++ b/${opts?.path || 'file'}\n-${oldContent}\n+${newContent}`;
    };
    return { fn, calls };
}

const fs_write_tool = { name: 'fs_write', permission: 'write' };

// -------- Tests --------

describe('buildFsWriteDiffPreview — short-circuits (no diff rendered)', () => {
    it('non-fs_write tool → empty string', async () => {
        const { fn } = makeDiffStub();
        const r = await buildFsWriteDiffPreview({
            tool: { name: 'fs_read', permission: 'read' },
            args: { path: 'x', content: 'y' },
            fsRead: async () => ({ content: 'old' }),
            buildDiff: fn,
        });
        assert.equal(r, '');
    });

    it('missing tool → empty string', async () => {
        const { fn } = makeDiffStub();
        const r = await buildFsWriteDiffPreview({ tool: null, args: { path: 'x', content: 'y' }, buildDiff: fn });
        assert.equal(r, '');
    });

    it('tool without .name → empty string', async () => {
        const { fn } = makeDiffStub();
        const r = await buildFsWriteDiffPreview({ tool: {}, args: { path: 'x', content: 'y' }, buildDiff: fn });
        assert.equal(r, '');
    });

    it('missing args.path → empty string', async () => {
        const { fn } = makeDiffStub();
        const r = await buildFsWriteDiffPreview({ tool: fs_write_tool, args: { content: 'y' }, buildDiff: fn });
        assert.equal(r, '');
    });

    it('empty args.path → empty string', async () => {
        const { fn } = makeDiffStub();
        const r = await buildFsWriteDiffPreview({ tool: fs_write_tool, args: { path: '', content: 'y' }, buildDiff: fn });
        assert.equal(r, '');
    });

    it('non-string args.path → empty string', async () => {
        const { fn } = makeDiffStub();
        const r = await buildFsWriteDiffPreview({ tool: fs_write_tool, args: { path: 42, content: 'y' }, buildDiff: fn });
        assert.equal(r, '');
    });

    it('non-string args.content → empty string', async () => {
        const { fn } = makeDiffStub();
        const r = await buildFsWriteDiffPreview({
            tool: fs_write_tool,
            args: { path: 'x', content: { foo: 'bar' } },
            buildDiff: fn,
        });
        assert.equal(r, '');
    });

    it('null args → empty string', async () => {
        const { fn } = makeDiffStub();
        const r = await buildFsWriteDiffPreview({ tool: fs_write_tool, args: null, buildDiff: fn });
        assert.equal(r, '');
    });

    it('undefined args → empty string', async () => {
        const { fn } = makeDiffStub();
        const r = await buildFsWriteDiffPreview({ tool: fs_write_tool, buildDiff: fn });
        assert.equal(r, '');
    });

    it('missing buildDiff → empty string (no diff function to render with)', async () => {
        const r = await buildFsWriteDiffPreview({
            tool: fs_write_tool,
            args: { path: 'x', content: 'y' },
            fsRead: async () => ({ content: 'old' }),
        });
        assert.equal(r, '');
    });

    it('non-function buildDiff → empty string', async () => {
        const r = await buildFsWriteDiffPreview({
            tool: fs_write_tool,
            args: { path: 'x', content: 'y' },
            fsRead: async () => ({ content: 'old' }),
            buildDiff: 'not-a-function',
        });
        assert.equal(r, '');
    });
});

describe('buildFsWriteDiffPreview — happy paths', () => {
    it('existing file: fetches via fs_read and forwards to buildDiff', async () => {
        const { fn, calls } = makeDiffStub();
        const r = await buildFsWriteDiffPreview({
            tool: fs_write_tool,
            args: { path: 'notes.md', content: 'new text' },
            fsRead: async ({ path }) => {
                assert.equal(path, 'notes.md', 'fsRead must get the write path');
                return { content: 'old text', path, encoding: 'utf8', bytes: 8 };
            },
            buildDiff: fn,
        });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].oldContent, 'old text');
        assert.equal(calls[0].newContent, 'new text');
        assert.equal(calls[0].opts.path, 'notes.md');
        assert.match(r, /^--- a\/notes\.md/);
        assert.match(r, /\+new text/);
    });

    it('new file (fs_read returns not-found): diffs against null (new-file path)', async () => {
        const { fn, calls } = makeDiffStub();
        const r = await buildFsWriteDiffPreview({
            tool: fs_write_tool,
            args: { path: 'new.txt', content: 'hello' },
            fsRead: async () => ({ error: 'not-found', status: 404 }),
            buildDiff: fn,
        });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].oldContent, null, 'new-file must pass null so buildNovaUnifiedDiff picks the /dev/null header');
        assert.equal(calls[0].newContent, 'hello');
        assert.match(r, /^--- \/dev\/null/);
    });

    it('unchanged content: returns "" when diff helper returns "" (no-op write)', async () => {
        const { fn } = makeDiffStub();
        const r = await buildFsWriteDiffPreview({
            tool: fs_write_tool,
            args: { path: 'x', content: 'same' },
            fsRead: async () => ({ content: 'same' }),
            buildDiff: fn,
        });
        assert.equal(r, '');
    });

    it('content may be an empty string (valid empty-file write)', async () => {
        const { fn, calls } = makeDiffStub();
        const r = await buildFsWriteDiffPreview({
            tool: fs_write_tool,
            args: { path: 'empty.txt', content: '' },
            fsRead: async () => ({ content: 'prev' }),
            buildDiff: fn,
        });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].newContent, '');
        assert.notEqual(r, '');
    });
});

describe('buildFsWriteDiffPreview — fs_read failure paths', () => {
    it('fs_read throws → empty string (modal still shows args, no diff)', async () => {
        const { fn, calls } = makeDiffStub();
        const r = await buildFsWriteDiffPreview({
            tool: fs_write_tool,
            args: { path: 'x', content: 'y' },
            fsRead: async () => { throw new Error('bridge-unreachable'); },
            buildDiff: fn,
        });
        assert.equal(r, '');
        assert.equal(calls.length, 0, 'buildDiff must not run when fs_read exploded');
    });

    it('fs_read returns a non-not-found error → empty string', async () => {
        const errors = [
            { error: 'nova-bridge-unreachable', message: 'ECONNREFUSED' },
            { error: 'nova-bridge-error', status: 500, body: '<html>oops</html>' },
            { error: 'forbidden', status: 403 },
            { error: 'content-too-large', cap: 1048576 },
        ];
        for (const res of errors) {
            const { fn, calls } = makeDiffStub();
            const r = await buildFsWriteDiffPreview({
                tool: fs_write_tool,
                args: { path: 'x', content: 'y' },
                fsRead: async () => res,
                buildDiff: fn,
            });
            assert.equal(r, '', `Expected empty diff for ${res.error}`);
            assert.equal(calls.length, 0, `buildDiff must not run for ${res.error}`);
        }
    });

    it('fs_read returns an unexpected shape (no content, no error) → empty string', async () => {
        const weird = [
            {},
            { path: 'x' },
            { content: 12345 },
            { content: null },
        ];
        for (const res of weird) {
            const { fn, calls } = makeDiffStub();
            const r = await buildFsWriteDiffPreview({
                tool: fs_write_tool,
                args: { path: 'x', content: 'y' },
                fsRead: async () => res,
                buildDiff: fn,
            });
            assert.equal(r, '', `Expected empty diff for ${JSON.stringify(res)}`);
            assert.equal(calls.length, 0, `buildDiff must not run for unexpected fs_read shape ${JSON.stringify(res)}`);
        }
    });

    it('fs_read returns a non-object (string, number, null) → empty string', async () => {
        for (const res of ['string', 42, null, undefined, true]) {
            const { fn } = makeDiffStub();
            const r = await buildFsWriteDiffPreview({
                tool: fs_write_tool,
                args: { path: 'x', content: 'y' },
                fsRead: async () => res,
                buildDiff: fn,
            });
            assert.equal(r, '', `Expected empty diff for fs_read returning ${JSON.stringify(res)}`);
        }
    });

    it('no fsRead provided → treats as new file (null oldContent)', async () => {
        const { fn, calls } = makeDiffStub();
        const r = await buildFsWriteDiffPreview({
            tool: fs_write_tool,
            args: { path: 'x', content: 'y' },
            buildDiff: fn,
            // fsRead omitted
        });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].oldContent, null);
        assert.match(r, /^--- \/dev\/null/);
    });
});

describe('buildFsWriteDiffPreview — robustness', () => {
    it('buildDiff throws → empty string (never propagates)', async () => {
        const r = await buildFsWriteDiffPreview({
            tool: fs_write_tool,
            args: { path: 'x', content: 'y' },
            fsRead: async () => ({ content: 'old' }),
            buildDiff: () => { throw new Error('diff exploded'); },
        });
        assert.equal(r, '');
    });

    it('buildDiff returns non-string → coerced or empty', async () => {
        // Documented contract: we String()-coerce. null/undefined → '' via the
        // `|| ''` fallback. Numbers → their string form.
        const r1 = await buildFsWriteDiffPreview({
            tool: fs_write_tool, args: { path: 'x', content: 'y' },
            fsRead: async () => ({ content: 'z' }),
            buildDiff: () => null,
        });
        assert.equal(r1, '');

        const r2 = await buildFsWriteDiffPreview({
            tool: fs_write_tool, args: { path: 'x', content: 'y' },
            fsRead: async () => ({ content: 'z' }),
            buildDiff: () => undefined,
        });
        assert.equal(r2, '');

        const r3 = await buildFsWriteDiffPreview({
            tool: fs_write_tool, args: { path: 'x', content: 'y' },
            fsRead: async () => ({ content: 'z' }),
            buildDiff: () => 42,
        });
        assert.equal(r3, '42');
    });

    it('fuzz: never throws for garbage inputs', async () => {
        const garbage = [
            undefined,
            null,
            {},
            { tool: null },
            { tool: 'string' },
            { tool: fs_write_tool, args: 'string' },
            { tool: fs_write_tool, args: 42 },
            { tool: fs_write_tool, args: [] },
            { tool: fs_write_tool, args: { path: 'x', content: 'y' }, fsRead: 'not-a-function' },
            { tool: fs_write_tool, args: { path: 'x', content: 'y' }, fsRead: async () => { throw 'str throw'; } },
            { tool: fs_write_tool, args: { path: 'x', content: 'y' }, buildDiff: 'not-a-function' },
        ];
        for (const g of garbage) {
            const r = await buildFsWriteDiffPreview(g);
            assert.equal(typeof r, 'string', `Returned non-string for ${JSON.stringify(g)}`);
        }
    });
});

describe('buildFsWriteDiffPreview — integration with real buildNovaUnifiedDiff', () => {
    // Inline mini-diff helper matching the production shape enough to
    // assert the composer threads inputs correctly through it. We don't
    // re-test the full diff helper here (that's nova-diff.test.mjs).
    const realish = (oldContent, newContent, { path = 'file' } = {}) => {
        const isNew = oldContent === null || oldContent === undefined;
        const head = isNew
            ? `--- /dev/null\n+++ b/${path}`
            : `--- a/${path}\n+++ b/${path}`;
        return String(oldContent ?? '') === String(newContent ?? '')
            ? ''
            : `${head}\n-${oldContent ?? ''}\n+${newContent}`;
    };

    it('modify: output carries the write path in the diff header', async () => {
        const r = await buildFsWriteDiffPreview({
            tool: fs_write_tool,
            args: { path: 'src/deep/nested/file.js', content: 'new' },
            fsRead: async () => ({ content: 'old' }),
            buildDiff: realish,
        });
        assert.match(r, /^--- a\/src\/deep\/nested\/file\.js/);
        assert.match(r, /^\+\+\+ b\/src\/deep\/nested\/file\.js$/m);
    });

    it('create: new-file header fires when fs_read returns not-found', async () => {
        const r = await buildFsWriteDiffPreview({
            tool: fs_write_tool,
            args: { path: 'brand-new.md', content: 'hi' },
            fsRead: async () => ({ error: 'not-found', status: 404 }),
            buildDiff: realish,
        });
        assert.match(r, /^--- \/dev\/null/);
        assert.match(r, /\+hi/);
    });
});
