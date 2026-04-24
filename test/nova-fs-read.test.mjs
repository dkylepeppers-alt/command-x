/**
 * Unit tests for nova-agent-bridge read-only fs handlers (plan §8b).
 * Run with: node --test test/nova-fs-read.test.mjs
 *
 * Drives the exported handler factories against real temp directories so
 * the full path-safety + realpath + readdir + stat + read pipeline is
 * exercised end-to-end. Each test creates its own tempdir under
 * `os.tmpdir()` so runs are isolated and tempdirs are always cleaned up.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import fsPromises from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const routes = require(path.resolve(__dirname, '../server-plugin/nova-agent-bridge/routes-fs-read.js'));
const { normalizeNovaPath } = require(path.resolve(__dirname, '../server-plugin/nova-agent-bridge/paths.js'));

const {
    createFsListHandler,
    createFsReadHandler,
    createFsStatHandler,
    createFsSearchHandler,
    _internal,
} = routes;

function mockRes() {
    const state = { statusCode: 200, body: null };
    const res = {
        status(code) { state.statusCode = code; return res; },
        json(payload) { state.body = payload; return res; },
        get _state() { return state; },
    };
    return res;
}

async function seedTree(root) {
    // Build a deterministic tree under `root` used across tests.
    //   root/
    //     a.txt       ("hello world\nsecond line\nthird hello line\n")
    //     sub/
    //       b.txt     ("nested file content")
    //       c.log     ("ignore me")
    //     .git/
    //       HEAD      ("ref: refs/heads/main")
    //     big.bin     (~2 KB of zeros to exercise truncation)
    //     binary.dat  (contains many null bytes — search should skip)
    await fsPromises.writeFile(path.join(root, 'a.txt'), 'hello world\nsecond line\nthird hello line\n', 'utf8');
    await fsPromises.mkdir(path.join(root, 'sub'), { recursive: true });
    await fsPromises.writeFile(path.join(root, 'sub', 'b.txt'), 'nested file content', 'utf8');
    await fsPromises.writeFile(path.join(root, 'sub', 'c.log'), 'ignore me', 'utf8');
    await fsPromises.mkdir(path.join(root, '.git'), { recursive: true });
    await fsPromises.writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main', 'utf8');
    await fsPromises.writeFile(path.join(root, 'big.bin'), Buffer.alloc(2048));
    const binary = Buffer.alloc(32);
    for (let i = 0; i < 10; i++) binary[i] = 0; // trip the null-byte heuristic in /fs/search
    binary.write('hello', 10, 'utf8');
    await fsPromises.writeFile(path.join(root, 'binary.dat'), binary);
}

let ROOT;
before(async () => {
    ROOT = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'nova-fsread-'));
    await seedTree(ROOT);
});
after(async () => {
    if (ROOT) await fsPromises.rm(ROOT, { recursive: true, force: true });
});

const deps = () => ({ root: ROOT, normalizePath: normalizeNovaPath });

/* ====================================================================== */

describe('/fs/list', () => {
    it('lists top-level entries', async () => {
        const handler = createFsListHandler(deps());
        const res = mockRes();
        await handler({ query: { path: '.' } }, res);
        assert.equal(res._state.statusCode, 200);
        const names = res._state.body.entries.map(e => e.name).sort();
        // `.git` is a deny-listed segment. The deny-list is checked
        // against each child path, so a child literally named `.git`
        // matches a denied segment and is filtered out of the listing.
        // Explicitly assert that `.git` is not present.
        assert.ok(!names.includes('.git'), 'deny-listed .git should not appear');
        assert.ok(names.includes('a.txt'));
        assert.ok(names.includes('sub'));
    });

    it('recursive listing respects maxDepth', async () => {
        const handler = createFsListHandler(deps());
        const res = mockRes();
        await handler({ query: { path: '.', recursive: 'true', maxDepth: '2' } }, res);
        assert.equal(res._state.statusCode, 200);
        const relatives = res._state.body.entries.map(e => e.relative);
        assert.ok(relatives.includes('sub'));
        assert.ok(relatives.includes('sub/b.txt'), 'depth-2 child should be included');
    });

    it('returns 404 for a missing path', async () => {
        const handler = createFsListHandler(deps());
        const res = mockRes();
        await handler({ query: { path: 'does-not-exist' } }, res);
        assert.equal(res._state.statusCode, 404);
        assert.equal(res._state.body.error, 'not-found');
    });

    it('returns 400 not-a-directory when pointed at a file', async () => {
        const handler = createFsListHandler(deps());
        const res = mockRes();
        await handler({ query: { path: 'a.txt' } }, res);
        assert.equal(res._state.statusCode, 400);
        assert.equal(res._state.body.error, 'not-a-directory');
    });

    it('rejects path-escape (.. into parent)', async () => {
        const handler = createFsListHandler(deps());
        const res = mockRes();
        await handler({ query: { path: '../..' } }, res);
        assert.equal(res._state.statusCode, 400);
        assert.equal(res._state.body.error, 'invalid-path');
        assert.equal(res._state.body.reason, 'escape');
    });
});

/* ====================================================================== */

describe('/fs/read', () => {
    it('reads a utf8 file', async () => {
        const handler = createFsReadHandler(deps());
        const res = mockRes();
        await handler({ query: { path: 'a.txt' } }, res);
        assert.equal(res._state.statusCode, 200);
        assert.equal(res._state.body.encoding, 'utf8');
        assert.equal(res._state.body.truncated, false);
        assert.match(res._state.body.content, /hello world/);
    });

    it('honours maxBytes and reports truncated: true', async () => {
        const handler = createFsReadHandler(deps());
        const res = mockRes();
        await handler({ query: { path: 'big.bin', maxBytes: '100' } }, res);
        assert.equal(res._state.statusCode, 200);
        assert.equal(res._state.body.truncated, true);
        assert.equal(res._state.body.bytes, 100);
    });

    it('hard-caps maxBytes at FS_READ_HARD_CAP_BYTES', async () => {
        // Request a higher maxBytes than the hard cap; handler must silently
        // clamp so a misbehaving caller can't exfiltrate >10 MB in one round.
        const handler = createFsReadHandler(deps());
        const res = mockRes();
        await handler({ query: { path: 'a.txt', maxBytes: String(_internal.FS_READ_HARD_CAP_BYTES * 2) } }, res);
        assert.equal(res._state.statusCode, 200);
        // The file is tiny, so `bytes` is just the file size — what we
        // verify is that the handler *didn't* reject on the oversized
        // maxBytes. The clamp itself is exercised by inspecting the
        // internal `toPositiveInt` below.
        const clamped = _internal.toPositiveInt(_internal.FS_READ_HARD_CAP_BYTES * 2, 262144, {
            min: 1, max: _internal.FS_READ_HARD_CAP_BYTES,
        });
        assert.equal(clamped, _internal.FS_READ_HARD_CAP_BYTES);
    });

    it('base64 encoding round-trips binary content', async () => {
        const handler = createFsReadHandler(deps());
        const res = mockRes();
        await handler({ query: { path: 'big.bin', encoding: 'base64', maxBytes: '2048' } }, res);
        assert.equal(res._state.statusCode, 200);
        assert.equal(res._state.body.encoding, 'base64');
        const decoded = Buffer.from(res._state.body.content, 'base64');
        assert.equal(decoded.length, 2048);
    });

    it('returns 404 for a missing file', async () => {
        const handler = createFsReadHandler(deps());
        const res = mockRes();
        await handler({ query: { path: 'nope.txt' } }, res);
        assert.equal(res._state.statusCode, 404);
    });

    it('returns 400 not-a-file for a directory', async () => {
        const handler = createFsReadHandler(deps());
        const res = mockRes();
        await handler({ query: { path: 'sub' } }, res);
        assert.equal(res._state.statusCode, 400);
        assert.equal(res._state.body.error, 'not-a-file');
    });

    it('refuses deny-listed paths (.git)', async () => {
        const handler = createFsReadHandler(deps());
        const res = mockRes();
        await handler({ query: { path: '.git/HEAD' } }, res);
        assert.equal(res._state.statusCode, 400);
        assert.equal(res._state.body.error, 'invalid-path');
        assert.equal(res._state.body.reason, 'denied');
    });
});

/* ====================================================================== */

describe('/fs/stat', () => {
    it('returns file metadata', async () => {
        const handler = createFsStatHandler(deps());
        const res = mockRes();
        await handler({ query: { path: 'a.txt' } }, res);
        assert.equal(res._state.statusCode, 200);
        assert.equal(res._state.body.type, 'file');
        assert.equal(typeof res._state.body.size, 'number');
        assert.equal(typeof res._state.body.mtimeMs, 'number');
        assert.equal(res._state.body.isSymlink, false);
    });

    it('returns directory metadata', async () => {
        const handler = createFsStatHandler(deps());
        const res = mockRes();
        await handler({ query: { path: 'sub' } }, res);
        assert.equal(res._state.statusCode, 200);
        assert.equal(res._state.body.type, 'directory');
    });

    it('returns 404 for missing path', async () => {
        const handler = createFsStatHandler(deps());
        const res = mockRes();
        await handler({ query: { path: 'ghost' } }, res);
        assert.equal(res._state.statusCode, 404);
    });

    it('refuses symlink escapes', async () => {
        // Create a symlink inside ROOT pointing outside ROOT. The handler
        // should detect the escape via realpath and refuse.
        const outsideRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'nova-outside-'));
        try {
            const linkPath = path.join(ROOT, 'escape-link');
            try { await fsPromises.symlink(outsideRoot, linkPath); }
            catch (e) {
                // Some CI containers (e.g. Windows without dev-mode) refuse
                // symlink creation. Skip rather than fail — the real code
                // path is still covered by the realpath re-normalise logic.
                if (e.code === 'EPERM' || e.code === 'EACCES') return;
                throw e;
            }
            const handler = createFsStatHandler(deps());
            const res = mockRes();
            await handler({ query: { path: 'escape-link' } }, res);
            assert.equal(res._state.statusCode, 400);
            assert.equal(res._state.body.error, 'symlink-escape');
            await fsPromises.unlink(linkPath);
        } finally {
            await fsPromises.rm(outsideRoot, { recursive: true, force: true });
        }
    });
});

/* ====================================================================== */

describe('/fs/search', () => {
    it('finds substring matches and reports line + preview', async () => {
        const handler = createFsSearchHandler(deps());
        const res = mockRes();
        await handler({ body: { query: 'hello' } }, res);
        assert.equal(res._state.statusCode, 200);
        const results = res._state.body.results;
        assert.ok(results.length >= 2, 'expected at least two matches in a.txt');
        const aHits = results.filter(r => r.path === 'a.txt');
        assert.ok(aHits.some(r => r.line === 1));
        assert.ok(aHits.some(r => r.line === 3));
        assert.ok(aHits.every(r => r.preview.includes('hello')));
    });

    it('skips binary-looking files (null-byte heuristic)', async () => {
        const handler = createFsSearchHandler(deps());
        const res = mockRes();
        await handler({ body: { query: 'hello' } }, res);
        assert.equal(res._state.statusCode, 200);
        const results = res._state.body.results;
        assert.ok(
            !results.some(r => r.path === 'binary.dat'),
            'binary.dat should be skipped by the null-byte guard',
        );
    });

    it('glob filter restricts to matching paths', async () => {
        const handler = createFsSearchHandler(deps());
        const res = mockRes();
        await handler({ body: { query: 'hello', glob: '*.txt' } }, res);
        assert.equal(res._state.statusCode, 200);
        for (const r of res._state.body.results) {
            assert.ok(r.path.endsWith('.txt'), `glob mismatch: ${r.path}`);
        }
    });

    it('maxResults caps the result list and marks truncated', async () => {
        const handler = createFsSearchHandler(deps());
        const res = mockRes();
        await handler({ body: { query: 'hello', maxResults: 1 } }, res);
        assert.equal(res._state.statusCode, 200);
        assert.equal(res._state.body.results.length, 1);
        assert.equal(res._state.body.truncated, true);
    });

    it('query-required when query is missing', async () => {
        const handler = createFsSearchHandler(deps());
        const res = mockRes();
        await handler({ body: {} }, res);
        assert.equal(res._state.statusCode, 400);
        assert.equal(res._state.body.error, 'query-required');
    });

    it('search does not traverse deny-listed subtrees', async () => {
        // We have `.git/HEAD` containing the literal "refs". It must not
        // appear in search results.
        const handler = createFsSearchHandler(deps());
        const res = mockRes();
        await handler({ body: { query: 'refs' } }, res);
        assert.equal(res._state.statusCode, 200);
        assert.ok(
            !res._state.body.results.some(r => r.path.startsWith('.git/')),
            '.git subtree should be excluded from search',
        );
    });
});

/* ====================================================================== */

describe('internals', () => {
    it('globToRegExp returns null for empty / non-string input', () => {
        assert.equal(_internal.globToRegExp(''), null);
        assert.equal(_internal.globToRegExp(null), null);
        assert.equal(_internal.globToRegExp(undefined), null);
    });

    it('globToRegExp: * does not cross slashes; ** does', () => {
        const a = _internal.globToRegExp('*.txt');
        assert.ok(a.test('a.txt'));
        assert.ok(!a.test('sub/a.txt'));
        // `**/*.txt` requires a leading directory component — this matches
        // bash's globstar semantics and ripgrep's `--glob` behaviour.
        const b = _internal.globToRegExp('**/*.txt');
        assert.ok(b.test('sub/a.txt'));
        assert.ok(b.test('deep/nested/a.txt'));
        assert.ok(!b.test('a.txt'), 'bare filename needs no-dir form like **.txt');
        // Bare-pattern `**.txt` matches anywhere.
        const c = _internal.globToRegExp('**.txt');
        assert.ok(c.test('a.txt'));
        assert.ok(c.test('sub/a.txt'));
    });

    it('globToRegExp: ? matches a single non-slash char', () => {
        const g = _internal.globToRegExp('a?.txt');
        assert.ok(g.test('ab.txt'));
        assert.ok(!g.test('a/b.txt'));
    });

    it('globToRegExp: escapes regex metacharacters literally', () => {
        const g = _internal.globToRegExp('f(1).txt');
        assert.ok(g.test('f(1).txt'));
        assert.ok(!g.test('f1.txt'));
    });

    it('toBool recognises string truthy / falsy variants', () => {
        assert.equal(_internal.toBool('true'), true);
        assert.equal(_internal.toBool('false'), false);
        assert.equal(_internal.toBool('1'), true);
        assert.equal(_internal.toBool('0'), false);
        assert.equal(_internal.toBool('on'), true);
        assert.equal(_internal.toBool('off'), false);
        assert.equal(_internal.toBool(undefined, true), true);
    });

    it('toPositiveInt clamps to min/max and falls back on NaN', () => {
        assert.equal(_internal.toPositiveInt('5', 1, { min: 1, max: 10 }), 5);
        assert.equal(_internal.toPositiveInt('50', 1, { min: 1, max: 10 }), 10);
        assert.equal(_internal.toPositiveInt('-5', 1, { min: 1, max: 10 }), 1);
        assert.equal(_internal.toPositiveInt('abc', 7), 7);
    });

    it('resolveRequestPath returns invalid-path on empty', async () => {
        const r = await _internal.resolveRequestPath({
            root: ROOT, normalizePath: normalizeNovaPath, requestPath: '',
        });
        assert.equal(r.ok, false);
        assert.equal(r.status, 400);
        assert.equal(r.error, 'invalid-path');
    });
});
