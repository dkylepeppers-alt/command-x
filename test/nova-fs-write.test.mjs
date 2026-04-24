/**
 * Tests for nova-agent-bridge write routes (plan §8b).
 * Run with: node --test test/nova-fs-write.test.mjs
 *
 * Drives the write handler factories against real tempdirs. Each test
 * seeds a fresh subdir under ROOT so concurrent runs don't clobber each
 * other. The audit logger is wired through a noop capture so we can also
 * assert on what gets logged.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import fsPromises from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const write = require(path.resolve(__dirname, '../server-plugin/nova-agent-bridge/routes-fs-write.js'));
const { normalizeNovaPath } = require(path.resolve(__dirname, '../server-plugin/nova-agent-bridge/paths.js'));

const {
    createFsWriteHandler,
    createFsDeleteHandler,
    createFsMoveHandler,
    _internal,
} = write;

function mockRes() {
    const state = { statusCode: 200, body: null };
    const res = {
        status(code) { state.statusCode = code; return res; },
        json(payload) { state.body = payload; return res; },
        get _state() { return state; },
    };
    return res;
}

function mockAudit() {
    const entries = [];
    return {
        entries,
        append: async (e) => { entries.push(e); return { ok: true }; },
        close: async () => {},
    };
}

let ROOT;
let audit;
before(async () => {
    ROOT = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'nova-fswrite-'));
});
after(async () => { if (ROOT) await fsPromises.rm(ROOT, { recursive: true, force: true }); });

beforeEach(async () => {
    // Wipe children of ROOT (but keep ROOT itself) between tests so each
    // starts from an empty tree. The .nova-trash bucket also resets.
    const entries = await fsPromises.readdir(ROOT);
    await Promise.all(entries.map(e =>
        fsPromises.rm(path.join(ROOT, e), { recursive: true, force: true })));
    audit = mockAudit();
});

const deps = (extra = {}) => ({
    root: ROOT,
    normalizePath: normalizeNovaPath,
    auditLogger: audit,
    ...extra,
});

/* ====================================================================== */

describe('/fs/write', () => {
    it('creates a new file and audits outcome=created', async () => {
        const h = createFsWriteHandler(deps());
        const res = mockRes();
        await h({ body: { path: 'hello.txt', content: 'hi there' } }, res);
        assert.equal(res._state.statusCode, 200);
        assert.equal(res._state.body.overwrote, false);
        assert.equal(res._state.body.bytes, 8);
        assert.equal(res._state.body.backup, null);
        const written = await fsPromises.readFile(path.join(ROOT, 'hello.txt'), 'utf8');
        assert.equal(written, 'hi there');
        assert.equal(audit.entries.length, 1);
        assert.equal(audit.entries[0].outcome, 'created');
        assert.equal(audit.entries[0].bytes, 8);
    });

    it('refuses to overwrite without overwrite:true (409 exists)', async () => {
        await fsPromises.writeFile(path.join(ROOT, 'f.txt'), 'orig');
        const h = createFsWriteHandler(deps());
        const res = mockRes();
        await h({ body: { path: 'f.txt', content: 'new' } }, res);
        assert.equal(res._state.statusCode, 409);
        assert.equal(res._state.body.error, 'exists');
        const unchanged = await fsPromises.readFile(path.join(ROOT, 'f.txt'), 'utf8');
        assert.equal(unchanged, 'orig');
        assert.equal(audit.entries[0].outcome, 'refused-exists');
    });

    it('overwrites on overwrite:true and moves the original to .nova-trash', async () => {
        await fsPromises.writeFile(path.join(ROOT, 'f.txt'), 'v1');
        const h = createFsWriteHandler(deps({ nowImpl: () => 1700000000000 }));
        const res = mockRes();
        await h({ body: { path: 'f.txt', content: 'v2', overwrite: true } }, res);
        assert.equal(res._state.statusCode, 200);
        assert.equal(res._state.body.overwrote, true);
        assert.ok(res._state.body.backup, 'backup path must be reported');
        assert.ok(res._state.body.backup.startsWith('.nova-trash/'));
        // v2 is live, v1 is preserved under .nova-trash/.
        assert.equal(await fsPromises.readFile(path.join(ROOT, 'f.txt'), 'utf8'), 'v2');
        const trashed = await fsPromises.readFile(path.join(ROOT, res._state.body.backup), 'utf8');
        assert.equal(trashed, 'v1');
        assert.equal(audit.entries[0].outcome, 'overwrote');
    });

    it('creates parent directories by default', async () => {
        const h = createFsWriteHandler(deps());
        const res = mockRes();
        await h({ body: { path: 'a/b/c/deep.txt', content: 'x' } }, res);
        assert.equal(res._state.statusCode, 200);
        const written = await fsPromises.readFile(path.join(ROOT, 'a/b/c/deep.txt'), 'utf8');
        assert.equal(written, 'x');
    });

    it('refuses to write to a directory path (is-directory)', async () => {
        await fsPromises.mkdir(path.join(ROOT, 'dir'));
        const h = createFsWriteHandler(deps());
        const res = mockRes();
        await h({ body: { path: 'dir', content: 'nope' } }, res);
        assert.equal(res._state.statusCode, 400);
        assert.equal(res._state.body.error, 'is-directory');
    });

    it('enforces the 20 MB hard cap (413 content-too-large)', async () => {
        const big = 'x'.repeat(_internal.FS_WRITE_HARD_CAP_BYTES + 1);
        const h = createFsWriteHandler(deps());
        const res = mockRes();
        await h({ body: { path: 'too-big.bin', content: big } }, res);
        assert.equal(res._state.statusCode, 413);
        assert.equal(res._state.body.error, 'content-too-large');
        assert.equal(res._state.body.cap, _internal.FS_WRITE_HARD_CAP_BYTES);
    });

    it('base64 content round-trips to the right bytes', async () => {
        const h = createFsWriteHandler(deps());
        const res = mockRes();
        const raw = Buffer.from([1, 2, 3, 255, 0, 42]);
        await h({ body: { path: 'bin.dat', content: raw.toString('base64'), encoding: 'base64' } }, res);
        assert.equal(res._state.statusCode, 200);
        const read = await fsPromises.readFile(path.join(ROOT, 'bin.dat'));
        assert.deepEqual(Array.from(read), Array.from(raw));
    });

    it('rejects deny-listed paths (.git/)', async () => {
        const h = createFsWriteHandler(deps());
        const res = mockRes();
        await h({ body: { path: '.git/HEAD', content: 'ref: ...' } }, res);
        assert.equal(res._state.statusCode, 400);
        assert.equal(res._state.body.error, 'invalid-path');
        assert.equal(res._state.body.reason, 'denied');
    });

    it('rejects path-escape attempts', async () => {
        const h = createFsWriteHandler(deps());
        const res = mockRes();
        await h({ body: { path: '../oops.txt', content: 'bad' } }, res);
        assert.equal(res._state.statusCode, 400);
        assert.equal(res._state.body.error, 'invalid-path');
        assert.equal(res._state.body.reason, 'escape');
    });
});

/* ====================================================================== */

describe('/fs/delete', () => {
    it('moves a file to .nova-trash and reports the backup path', async () => {
        await fsPromises.writeFile(path.join(ROOT, 'gone.txt'), 'bye');
        const h = createFsDeleteHandler(deps({ nowImpl: () => 1700000000000 }));
        const res = mockRes();
        await h({ body: { path: 'gone.txt' } }, res);
        assert.equal(res._state.statusCode, 200);
        assert.equal(res._state.body.type, 'file');
        assert.ok(res._state.body.backup.startsWith('.nova-trash/'));
        // Original gone; trash copy present.
        await assert.rejects(() => fsPromises.stat(path.join(ROOT, 'gone.txt')));
        const trashed = await fsPromises.readFile(path.join(ROOT, res._state.body.backup), 'utf8');
        assert.equal(trashed, 'bye');
        assert.equal(audit.entries[0].outcome, 'trashed');
    });

    it('refuses non-empty directory without recursive:true (409 not-empty)', async () => {
        await fsPromises.mkdir(path.join(ROOT, 'full'));
        await fsPromises.writeFile(path.join(ROOT, 'full', 'c.txt'), 'c');
        const h = createFsDeleteHandler(deps());
        const res = mockRes();
        await h({ body: { path: 'full' } }, res);
        assert.equal(res._state.statusCode, 409);
        assert.equal(res._state.body.error, 'not-empty');
        // Still there on disk.
        await fsPromises.stat(path.join(ROOT, 'full', 'c.txt'));
    });

    it('accepts a non-empty directory with recursive:true', async () => {
        await fsPromises.mkdir(path.join(ROOT, 'tree', 'sub'), { recursive: true });
        await fsPromises.writeFile(path.join(ROOT, 'tree', 'a.txt'), 'a');
        await fsPromises.writeFile(path.join(ROOT, 'tree', 'sub', 'b.txt'), 'b');
        const h = createFsDeleteHandler(deps());
        const res = mockRes();
        await h({ body: { path: 'tree', recursive: true } }, res);
        assert.equal(res._state.statusCode, 200);
        assert.equal(res._state.body.type, 'directory');
        await assert.rejects(() => fsPromises.stat(path.join(ROOT, 'tree')));
        // Contents are preserved under trash.
        const backupRoot = path.join(ROOT, res._state.body.backup);
        await fsPromises.stat(path.join(backupRoot, 'a.txt'));
        await fsPromises.stat(path.join(backupRoot, 'sub', 'b.txt'));
    });

    it('never hard-unlinks — file is always recoverable from .nova-trash', async () => {
        await fsPromises.writeFile(path.join(ROOT, 'important.txt'), 'saved');
        const h = createFsDeleteHandler(deps());
        const res = mockRes();
        await h({ body: { path: 'important.txt' } }, res);
        const recovered = await fsPromises.readFile(path.join(ROOT, res._state.body.backup), 'utf8');
        assert.equal(recovered, 'saved');
    });

    it('refuses to delete the root itself', async () => {
        const h = createFsDeleteHandler(deps());
        const res = mockRes();
        await h({ body: { path: '.' } }, res);
        assert.equal(res._state.statusCode, 400);
        assert.equal(res._state.body.error, 'refused-root');
    });

    it('404 when target does not exist', async () => {
        const h = createFsDeleteHandler(deps());
        const res = mockRes();
        await h({ body: { path: 'ghost.txt' } }, res);
        assert.equal(res._state.statusCode, 404);
    });
});

/* ====================================================================== */

describe('/fs/move', () => {
    it('renames a file', async () => {
        await fsPromises.writeFile(path.join(ROOT, 'before.txt'), 'hi');
        const h = createFsMoveHandler(deps());
        const res = mockRes();
        await h({ body: { from: 'before.txt', to: 'after.txt' } }, res);
        assert.equal(res._state.statusCode, 200);
        assert.equal(res._state.body.overwroteDest, false);
        await assert.rejects(() => fsPromises.stat(path.join(ROOT, 'before.txt')));
        const content = await fsPromises.readFile(path.join(ROOT, 'after.txt'), 'utf8');
        assert.equal(content, 'hi');
    });

    it('creates parent directories of the destination', async () => {
        await fsPromises.writeFile(path.join(ROOT, 'a.txt'), 'a');
        const h = createFsMoveHandler(deps());
        const res = mockRes();
        await h({ body: { from: 'a.txt', to: 'deep/sub/a.txt' } }, res);
        assert.equal(res._state.statusCode, 200);
        const moved = await fsPromises.readFile(path.join(ROOT, 'deep/sub/a.txt'), 'utf8');
        assert.equal(moved, 'a');
    });

    it('refuses to clobber existing destination without overwrite:true', async () => {
        await fsPromises.writeFile(path.join(ROOT, 'src.txt'), 's');
        await fsPromises.writeFile(path.join(ROOT, 'dst.txt'), 'd');
        const h = createFsMoveHandler(deps());
        const res = mockRes();
        await h({ body: { from: 'src.txt', to: 'dst.txt' } }, res);
        assert.equal(res._state.statusCode, 409);
        assert.equal(res._state.body.error, 'destination-exists');
        // Both still present, unchanged.
        assert.equal(await fsPromises.readFile(path.join(ROOT, 'src.txt'), 'utf8'), 's');
        assert.equal(await fsPromises.readFile(path.join(ROOT, 'dst.txt'), 'utf8'), 'd');
    });

    it('overwrites destination when overwrite:true, backing up the old dst to trash', async () => {
        await fsPromises.writeFile(path.join(ROOT, 'src.txt'), 's');
        await fsPromises.writeFile(path.join(ROOT, 'dst.txt'), 'd');
        const h = createFsMoveHandler(deps());
        const res = mockRes();
        await h({ body: { from: 'src.txt', to: 'dst.txt', overwrite: true } }, res);
        assert.equal(res._state.statusCode, 200);
        assert.equal(res._state.body.overwroteDest, true);
        assert.equal(await fsPromises.readFile(path.join(ROOT, 'dst.txt'), 'utf8'), 's');
        // The original dst must live in the trash somewhere.
        const trashRoot = path.join(ROOT, '.nova-trash');
        const buckets = await fsPromises.readdir(trashRoot);
        assert.ok(buckets.length >= 1);
        const trashed = await fsPromises.readFile(path.join(trashRoot, buckets[0], 'dst.txt'), 'utf8');
        assert.equal(trashed, 'd');
    });

    it('404 when from does not exist', async () => {
        const h = createFsMoveHandler(deps());
        const res = mockRes();
        await h({ body: { from: 'ghost.txt', to: 'nope.txt' } }, res);
        assert.equal(res._state.statusCode, 404);
    });

    it('refuses to move the root itself', async () => {
        const h = createFsMoveHandler(deps());
        const res = mockRes();
        await h({ body: { from: '.', to: 'anywhere' } }, res);
        assert.equal(res._state.statusCode, 400);
        assert.equal(res._state.body.error, 'refused-root');
    });

    it('rejects deny-listed paths (.git)', async () => {
        const h = createFsMoveHandler(deps());
        const res = mockRes();
        await h({ body: { from: '.git/HEAD', to: 'stolen' } }, res);
        assert.equal(res._state.statusCode, 400);
        assert.equal(res._state.body.error, 'invalid-path');
    });
});

/* ====================================================================== */

describe('moveToTrash internals', () => {
    it('preserves relative layout under the bucket', async () => {
        await fsPromises.mkdir(path.join(ROOT, 'nested'), { recursive: true });
        await fsPromises.writeFile(path.join(ROOT, 'nested', 'x.txt'), 'hi');
        const r = await _internal.moveToTrash({
            root: ROOT,
            absPath: path.join(ROOT, 'nested', 'x.txt'),
            relPath: 'nested/x.txt',
            bucket: 'test-bucket',
        });
        assert.equal(r.ok, true);
        assert.ok(r.trashRel.startsWith('.nova-trash/test-bucket/'));
        assert.equal(
            await fsPromises.readFile(path.join(ROOT, '.nova-trash/test-bucket/nested/x.txt'), 'utf8'),
            'hi',
        );
    });

    it('trashBucket produces a path-safe segment', () => {
        const b = _internal.trashBucket(() => 1700000000000);
        assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(b));
        assert.ok(!b.includes(':'));
        assert.ok(!b.includes('.'));
        // Fixed-timestamp DI → deterministic string. Guards against
        // someone "simplifying" the colon/dot-strip logic and breaking
        // cross-OS compatibility.
        assert.equal(b, '2023-11-14T22-13-20-000Z');
    });
});
