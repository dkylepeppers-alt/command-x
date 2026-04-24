/**
 * Tests for nova-agent-bridge audit logger (plan §8c).
 * Run with: node --test test/nova-audit.test.mjs
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
const { buildAuditLogger, REDACTED_KEYS, _internal } =
    require(path.resolve(__dirname, '../server-plugin/nova-agent-bridge/audit.js'));

let DIR;
before(async () => {
    DIR = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'nova-audit-'));
});
after(async () => { if (DIR) await fsPromises.rm(DIR, { recursive: true, force: true }); });

async function readAllLines(p) {
    const raw = await fsPromises.readFile(p, 'utf8');
    return raw.split('\n').filter(l => l.length > 0).map(l => JSON.parse(l));
}

describe('audit.buildAuditLogger argument validation', () => {
    it('throws when logPath is missing', () => {
        assert.throws(() => buildAuditLogger({}), /logPath required/);
    });
    it('throws when logPath is relative', () => {
        assert.throws(() => buildAuditLogger({ logPath: 'relative.log' }), /absolute/);
    });
});

describe('audit.append writes JSONL entries', () => {
    it('creates the log + parent dir on first append', async () => {
        const logPath = path.join(DIR, 'nested', 'audit.jsonl');
        const logger = buildAuditLogger({ logPath });
        const r = await logger.append({ route: '/fs/write', outcome: 'created', argsSummary: { path: 'x.txt' }, bytes: 42 });
        assert.equal(r.ok, true);
        const lines = await readAllLines(logPath);
        assert.equal(lines.length, 1);
        assert.equal(lines[0].route, '/fs/write');
        assert.equal(lines[0].outcome, 'created');
        assert.equal(lines[0].bytes, 42);
        assert.equal(typeof lines[0].ts, 'string');
    });

    it('appends one line per call (no interleave, newline terminator)', async () => {
        const logPath = path.join(DIR, 'multi.jsonl');
        const logger = buildAuditLogger({ logPath });
        for (let i = 0; i < 5; i++) {
            await logger.append({ route: '/fs/delete', outcome: 'trashed', argsSummary: { path: `a${i}.txt` } });
        }
        const raw = await fsPromises.readFile(logPath, 'utf8');
        assert.ok(raw.endsWith('\n'), 'log must end with newline');
        const lines = raw.split('\n').filter(l => l.length > 0);
        assert.equal(lines.length, 5);
        for (const l of lines) {
            JSON.parse(l); // must parse
        }
    });

    it('uses nowImpl for deterministic ts when not supplied on entry', async () => {
        const logPath = path.join(DIR, 'now.jsonl');
        const logger = buildAuditLogger({ logPath, nowImpl: () => 1700000000000 });
        await logger.append({ route: '/fs/write', outcome: 'created' });
        const [entry] = await readAllLines(logPath);
        assert.equal(entry.ts, new Date(1700000000000).toISOString());
    });

    it('preserves ts if the caller supplies one', async () => {
        const logPath = path.join(DIR, 'ts.jsonl');
        const logger = buildAuditLogger({ logPath, nowImpl: () => 1 });
        await logger.append({ ts: '2020-01-01T00:00:00.000Z', route: '/fs/write', outcome: 'created' });
        const [entry] = await readAllLines(logPath);
        assert.equal(entry.ts, '2020-01-01T00:00:00.000Z');
    });
});

describe('audit redaction — raw content MUST NEVER be logged', () => {
    it('strips top-level content / data / payload / body / raw keys', async () => {
        const logPath = path.join(DIR, 'redact-top.jsonl');
        const logger = buildAuditLogger({ logPath });
        await logger.append({
            route: '/fs/write', outcome: 'created',
            content: 'SUPER SECRET TOKEN abc123',
            data: { secret: true },
            payload: 'blob',
            body: '...',
            raw: '....',
            bytes: 9,
        });
        const [entry] = await readAllLines(logPath);
        for (const k of REDACTED_KEYS) {
            assert.ok(!(k in entry), `top-level ${k} must not appear in the log line`);
        }
        assert.equal(entry.bytes, 9);
    });

    it('redacts nested content / data under any key', async () => {
        const logPath = path.join(DIR, 'redact-nested.jsonl');
        const logger = buildAuditLogger({ logPath });
        await logger.append({
            route: '/fs/write', outcome: 'created',
            argsSummary: {
                path: 'secrets.env',
                content: 'API_KEY=abc',
                nested: { data: 'more secrets' },
            },
            bytes: 11,
        });
        const raw = await fsPromises.readFile(logPath, 'utf8');
        // The strongest guarantee we make is a literal substring check:
        // the sensitive values must never appear in the written bytes.
        assert.ok(!raw.includes('abc'), 'API key substring must not appear in audit log');
        assert.ok(!raw.includes('more secrets'), 'nested "data" value must not appear');
        // Non-redacted metadata MUST still be present — redaction must
        // not over-strip and destroy the legitimate audit trail.
        const entry = JSON.parse(raw.trim());
        assert.equal(entry.route, '/fs/write');
        assert.equal(entry.outcome, 'created');
        assert.equal(entry.bytes, 11);
        assert.equal(entry.argsSummary.path, 'secrets.env');
    });

    it('never includes the literal string "abc123" even when caller passes it as argsSummary.content', async () => {
        const logPath = path.join(DIR, 'redact-strict.jsonl');
        const logger = buildAuditLogger({ logPath });
        await logger.append({
            route: '/fs/write', outcome: 'overwrote',
            argsSummary: { path: 'x.txt', content: 'abc123' },
            bytes: 6,
        });
        const raw = await fsPromises.readFile(logPath, 'utf8');
        assert.ok(!raw.includes('abc123'), 'raw content substring leaked into the log');
    });
});

describe('audit failure handling', () => {
    it('returns { ok: false } instead of throwing when appendFile fails', async () => {
        const logger = buildAuditLogger({
            logPath: '/this/is/absolute/nope.jsonl',
            fsImpl: {
                mkdir: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
                appendFile: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
            },
        });
        const r = await logger.append({ route: '/fs/write', outcome: 'created' });
        assert.equal(r.ok, false);
        assert.match(r.error, /EACCES/);
    });

    it('never throws on a cyclic entry', async () => {
        const logPath = path.join(DIR, 'cyclic.jsonl');
        const logger = buildAuditLogger({ logPath });
        const cyclic = { route: '/fs/write', outcome: 'overwrote', extra: {} };
        cyclic.extra.self = cyclic;
        const r = await logger.append(cyclic);
        assert.equal(r.ok, true);
        const lines = await readAllLines(logPath);
        // Stub line on cyclic ref.
        assert.equal(lines.length, 1);
        assert.equal(lines[0].outcome, 'error');
        assert.equal(lines[0].error, 'json-serialise-failed');
    });

    it('retries mkdir on subsequent appends after a transient failure', async () => {
        // Simulate a transient EACCES on mkdir (e.g. a permissions race
        // that resolves itself). The first append should report the
        // failure; the second — once the underlying condition clears —
        // should succeed. Without the fix this would stay broken because
        // `dirEnsured` was being set even on the failure path.
        let mkdirCalls = 0;
        let mkdirShouldFail = true;
        const fakeFs = {
            mkdir: async (dir, opts) => {
                mkdirCalls += 1;
                if (mkdirShouldFail) {
                    throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
                }
                // Delegate to real fs once we're "fixed".
                return fsPromises.mkdir(dir, opts);
            },
            appendFile: async (p, data, enc) => {
                if (mkdirShouldFail) {
                    // Mirror what would happen for real if the dir is
                    // missing — appendFile would ENOENT.
                    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
                }
                return fsPromises.appendFile(p, data, enc);
            },
        };
        const logPath = path.join(DIR, 'retry-subdir', 'retry.jsonl');
        const logger = buildAuditLogger({ logPath, fsImpl: fakeFs });

        const r1 = await logger.append({ route: '/fs/write', outcome: 'created' });
        assert.equal(r1.ok, false, 'first append should report failure');
        assert.equal(mkdirCalls, 1);

        // "Fix" the underlying condition and retry.
        mkdirShouldFail = false;
        const r2 = await logger.append({ route: '/fs/write', outcome: 'created' });
        assert.equal(r2.ok, true, 'second append should succeed once mkdir is fixed');
        assert.equal(mkdirCalls, 2, 'mkdir must be retried, not memoised on failure');

        // Subsequent successful appends should not retry mkdir again.
        await logger.append({ route: '/fs/write', outcome: 'created' });
        assert.equal(mkdirCalls, 2, 'mkdir must NOT re-run after a successful ensure');
    });
});

describe('audit internals', () => {
    it('formatEntry produces a newline-terminated JSON string', () => {
        const line = _internal.formatEntry({ route: '/x', outcome: 'ok' }, () => 0);
        assert.ok(line.endsWith('\n'));
        const parsed = JSON.parse(line);
        assert.equal(parsed.route, '/x');
    });
    it('sanitizeEntry is a pure shallow clone minus redacted keys', () => {
        const input = { a: 1, content: 'secret', nested: { content: 'ok' } };
        const out = _internal.sanitizeEntry(input);
        assert.equal(out.a, 1);
        assert.ok(!('content' in out));
        assert.equal(out.nested.content, 'ok'); // shallow only; deep redaction is via the replacer
        // Input is not mutated.
        assert.equal(input.content, 'secret');
    });
});
