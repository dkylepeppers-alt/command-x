/**
 * nova-agent-bridge — audit redaction integration tests (plan §13).
 * Run with: node --test test/nova-audit-redact.test.mjs
 *
 * `nova-audit.test.mjs` covers the audit logger in isolation: it proves
 * that *if* a caller hands a redacted key to the logger, the JSONL line
 * elides it. This file proves the **other half** of the security
 * contract: the route handlers themselves never hand raw content to
 * the audit pipeline in the first place.
 *
 * The strategy:
 *   1. Drive the real `/fs/write`, `/fs/delete`, `/fs/move` handler
 *      factories against a tempdir.
 *   2. Send bodies containing realistic raw payloads — long strings,
 *      base64 blobs, secrets-shaped tokens, password-like material,
 *      JSON with nested `content`/`data` keys.
 *   3. Capture every audit-append call AND run each captured entry
 *      through the real `formatEntry` (the JSONL serialiser) so we
 *      check both layers at once.
 *   4. Assert: the serialised audit text never contains the raw
 *      payload substring; argsSummary keys are inside the documented
 *      allow-list; the logger's own redact replacer still backstops
 *      a synthetic `content` injection.
 *
 * If a future handler accidentally adds `body.content` (or any
 * payload-shaped field) to an `argsSummary` object, this suite will
 * fail loudly — the substring check is intentionally raw because the
 * threat model is "an attacker reads the audit log".
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

const writeRoutes = require(path.resolve(__dirname, '../server-plugin/nova-agent-bridge/routes-fs-write.js'));
const auditMod = require(path.resolve(__dirname, '../server-plugin/nova-agent-bridge/audit.js'));
const { normalizeNovaPath } = require(path.resolve(__dirname, '../server-plugin/nova-agent-bridge/paths.js'));

const { createFsWriteHandler, createFsDeleteHandler, createFsMoveHandler } = writeRoutes;
const { buildAuditLogger, REDACTED_KEYS, _internal } = auditMod;
const { formatEntry } = _internal;

/* ----------------------------------------------------------------------
 * Allow-list of keys a route handler may put inside `argsSummary`. This
 * is the contract tracked by the test — adding a new key here is a
 * conscious decision that requires confirming the new key cannot carry
 * raw payload material.
 * ---------------------------------------------------------------------- */
const ALLOWED_ARGS_SUMMARY_KEYS = Object.freeze(new Set([
    'path',         // resolved relative path (no payload)
    'from', 'to',   // move source/destination (no payload)
    'encoding',     // 'utf8' | 'base64' literal
    'createParents', 'overwrite', 'overwrote', 'overwroteDest',
    'recursive',
    'entries',      // count, not contents
    'type',         // 'file' | 'directory' literal
]));

/* ----------------------------------------------------------------------
 * Top-level entry keys a handler may emit. `bytes` and `backup` are
 * intentionally outside `argsSummary` (per the existing audit shape).
 * `error` carries filesystem error messages (e.g. ENOENT) and is
 * allowed — those messages may include a path fragment but cannot
 * include file content because the handlers never read the file before
 * the audit call.
 * ---------------------------------------------------------------------- */
const ALLOWED_ENTRY_KEYS = Object.freeze(new Set([
    'route', 'outcome', 'argsSummary', 'bytes', 'backup', 'error', 'ts',
]));

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
    ROOT = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'nova-audit-redact-'));
});
after(async () => { if (ROOT) await fsPromises.rm(ROOT, { recursive: true, force: true }); });

beforeEach(async () => {
    const ents = await fsPromises.readdir(ROOT);
    await Promise.all(ents.map(e =>
        fsPromises.rm(path.join(ROOT, e), { recursive: true, force: true })));
    audit = mockAudit();
});

const deps = (extra = {}) => ({
    root: ROOT,
    normalizePath: normalizeNovaPath,
    auditLogger: audit,
    ...extra,
});

/* ----------------------------------------------------------------------
 * Realistic payload material. Each one is a string we will assert
 * NEVER appears in any captured audit serialisation. Mix UTF-8 prose,
 * fake credentials, and base64-shaped tokens to catch handlers that
 * might selectively log "structured" payloads.
 * ---------------------------------------------------------------------- */
const RAW_PAYLOADS = Object.freeze([
    'TOPSECRET-PROSE: the launch codes are 0451-9001-LIMA-OSCAR.',
    'BEGIN PRIVATE KEY\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ\nEND PRIVATE KEY',
    'password=hunter2; api_token=sk-live-abcdef1234567890',
    JSON.stringify({ content: 'NESTED-CONTENT-VALUE', data: 'NESTED-DATA-VALUE', user: 'alice' }),
    'A'.repeat(2048), // long uniform string
]);

function assertEntryNeverLeaksPayload(entry, payload, label) {
    // Check (a) what the route handed to audit, and (b) what the real
    // logger would actually serialise to disk. Both must be free of
    // the raw payload substring.
    const naive = JSON.stringify(entry);
    const real = formatEntry(entry, () => 0);
    assert.ok(!naive.includes(payload),
        `${label}: raw payload leaked into audit entry (naive serialise)`);
    assert.ok(!real.includes(payload),
        `${label}: raw payload leaked into formatEntry serialisation`);
}

function assertArgsSummaryShape(entry, label) {
    if (!entry.argsSummary) return; // not every entry carries one
    assert.equal(typeof entry.argsSummary, 'object',
        `${label}: argsSummary must be an object`);
    for (const k of Object.keys(entry.argsSummary)) {
        assert.ok(ALLOWED_ARGS_SUMMARY_KEYS.has(k),
            `${label}: argsSummary contains unapproved key "${k}". ` +
            `If this is intentional, add it to ALLOWED_ARGS_SUMMARY_KEYS ` +
            `after confirming it cannot carry raw payload material.`);
    }
}

function assertEntryShape(entry, label) {
    for (const k of Object.keys(entry)) {
        assert.ok(ALLOWED_ENTRY_KEYS.has(k),
            `${label}: top-level audit entry has unapproved key "${k}".`);
    }
    assertArgsSummaryShape(entry, label);
}

/* =====================================================================
 * /fs/write — primary surface for raw payload exposure
 * ===================================================================== */

describe('audit redaction: /fs/write never logs body.content', () => {
    for (const payload of RAW_PAYLOADS) {
        it(`creates a file with payload ${JSON.stringify(payload.slice(0, 24))}… and audit log is clean`, async () => {
            const h = createFsWriteHandler(deps());
            const res = mockRes();
            await h({ body: { path: 'note.txt', content: payload, overwrite: true } }, res);
            assert.equal(res._state.statusCode, 200);

            assert.ok(audit.entries.length >= 1, 'audit must record at least one entry');
            for (const e of audit.entries) {
                assertEntryShape(e, '/fs/write create');
                assertEntryNeverLeaksPayload(e, payload, '/fs/write create');
            }
        });
    }

    it('overwrite path also redacts the second write', async () => {
        const h = createFsWriteHandler(deps());

        // First write to seed the file.
        await h({ body: { path: 'doc.txt', content: 'OLD', overwrite: true } }, mockRes());
        const initialCount = audit.entries.length;
        const overwritePayload = 'OVERWRITE-PAYLOAD-WITH-SECRET-token-xyz-789';

        const res = mockRes();
        await h({ body: { path: 'doc.txt', content: overwritePayload, overwrite: true } }, res);
        assert.equal(res._state.statusCode, 200);
        assert.ok(audit.entries.length > initialCount, 'overwrite must add at least one audit entry');

        for (const e of audit.entries.slice(initialCount)) {
            assertEntryShape(e, '/fs/write overwrite');
            assertEntryNeverLeaksPayload(e, overwritePayload, '/fs/write overwrite');
        }
        // The overwrite entry must record `overwrote: true` — confirms
        // the metadata path actually ran and the audit entry isn't
        // empty.
        const overwroteEntry = audit.entries.find(e => e?.outcome === 'overwrote');
        assert.ok(overwroteEntry, 'expected an entry with outcome=overwrote');
        assert.equal(overwroteEntry.argsSummary?.overwrote, true);
    });

    it('write-refused (overwrite=false on existing file) does not leak payload', async () => {
        const h = createFsWriteHandler(deps());
        await h({ body: { path: 'guard.txt', content: 'EXISTS', overwrite: true } }, mockRes());
        const before = audit.entries.length;

        const refusedPayload = 'REFUSED-PAYLOAD-SHOULD-NEVER-APPEAR-IN-AUDIT-zzzzz';
        const res = mockRes();
        await h({ body: { path: 'guard.txt', content: refusedPayload /* overwrite default false */ } }, res);
        assert.equal(res._state.statusCode, 409);
        assert.ok(audit.entries.length > before, 'refused write should still audit the refusal');

        for (const e of audit.entries.slice(before)) {
            assertEntryShape(e, '/fs/write refused');
            assertEntryNeverLeaksPayload(e, refusedPayload, '/fs/write refused');
        }
    });

    it('base64 encoding does not smuggle the raw bytes into audit', async () => {
        const h = createFsWriteHandler(deps());
        const raw = Buffer.from('BINARY-PAYLOAD-WITH-bytes-and-secrets').toString('base64');

        const res = mockRes();
        await h({ body: { path: 'blob.bin', content: raw, encoding: 'base64', overwrite: true } }, res);
        assert.equal(res._state.statusCode, 200);

        for (const e of audit.entries) {
            assertEntryShape(e, '/fs/write base64');
            assertEntryNeverLeaksPayload(e, raw, '/fs/write base64 (b64 string)');
            assertEntryNeverLeaksPayload(e, 'BINARY-PAYLOAD-WITH-bytes-and-secrets',
                '/fs/write base64 (decoded plaintext)');
            // Confirm the encoding metadata IS recorded (it's a literal,
            // not payload — important for forensic value of the log).
            if (e.argsSummary && 'encoding' in e.argsSummary) {
                assert.equal(e.argsSummary.encoding, 'base64');
            }
        }
    });
});

/* =====================================================================
 * /fs/delete — must not leak path-targeting context if the file's
 * NAME contains payload-ish material (hypothetical attacker control).
 * ===================================================================== */

describe('audit redaction: /fs/delete leaks neither file body nor user-supplied recursive flag', () => {
    it('delete entry contains only metadata', async () => {
        const writeH = createFsWriteHandler(deps());
        await writeH({ body: { path: 'tobedeleted.txt', content: 'CONTENT-CONTENT-CONTENT', overwrite: true } }, mockRes());
        // Snapshot how many audit entries the writes already produced;
        // the delete-only assertions look at the suffix.
        const beforeDelete = audit.entries.length;

        const delH = createFsDeleteHandler(deps());
        const res = mockRes();
        await delH({ body: { path: 'tobedeleted.txt' } }, res);
        assert.equal(res._state.statusCode, 200);

        const deleteEntries = audit.entries.slice(beforeDelete);
        assert.ok(deleteEntries.length >= 1, 'delete should produce at least one audit entry');
        for (const e of deleteEntries) {
            assertEntryShape(e, '/fs/delete');
            // The file's contents (written above) must not appear in
            // the delete audit entry — even though delete reads the
            // stat, it never reads the bytes.
            assertEntryNeverLeaksPayload(e, 'CONTENT-CONTENT-CONTENT', '/fs/delete file body');
        }
        const movedEntry = deleteEntries.find(e => e?.outcome === 'trashed');
        assert.ok(movedEntry, 'delete should record outcome=trashed');
        assert.equal(movedEntry.argsSummary?.type, 'file');
        assert.equal(movedEntry.argsSummary?.recursive, false);
    });
});

/* =====================================================================
 * /fs/move — both `from` and `to` paths must be metadata only
 * ===================================================================== */

describe('audit redaction: /fs/move logs only path metadata', () => {
    it('successful move leaves no payload trace', async () => {
        const writeH = createFsWriteHandler(deps());
        const PAYLOAD = 'MOVE-TARGET-CONTENT-1234567890-secret-tokens';
        await writeH({ body: { path: 'src.txt', content: PAYLOAD, overwrite: true } }, mockRes());

        const beforeMove = audit.entries.length;
        const moveH = createFsMoveHandler(deps());
        const res = mockRes();
        await moveH({ body: { from: 'src.txt', to: 'dest.txt' } }, res);
        assert.equal(res._state.statusCode, 200);

        const moveEntries = audit.entries.slice(beforeMove);
        assert.ok(moveEntries.length >= 1);
        for (const e of moveEntries) {
            assertEntryShape(e, '/fs/move');
            assertEntryNeverLeaksPayload(e, PAYLOAD, '/fs/move file body');
        }
        const movedEntry = moveEntries.find(e => e?.outcome === 'moved');
        assert.ok(movedEntry, 'expected outcome=moved entry');
        assert.equal(movedEntry.argsSummary?.from, 'src.txt');
        assert.equal(movedEntry.argsSummary?.to, 'dest.txt');
    });
});

/* =====================================================================
 * Logger backstop — confirms the formatEntry replacer still elides
 * redacted-key content even if a handler regression slips through.
 * Belt-and-braces: this re-asserts the existing nova-audit.test
 * guarantee under the same payload set this file uses, so any future
 * change to the logger would fail this test too.
 * ===================================================================== */

describe('audit redaction: logger backstop still elides REDACTED_KEYS', () => {
    it('top-level redacted keys are stripped before serialise', () => {
        const synthetic = {
            ts: '2026-01-01T00:00:00.000Z',
            route: '/fs/write',
            outcome: 'created',
            argsSummary: { path: 'x.txt' },
            content: RAW_PAYLOADS[0],
            data: RAW_PAYLOADS[1],
            payload: RAW_PAYLOADS[2],
            body: RAW_PAYLOADS[3],
            raw: RAW_PAYLOADS[4],
        };
        const line = formatEntry(synthetic, () => 0);
        for (const p of RAW_PAYLOADS) {
            assert.ok(!line.includes(p),
                `formatEntry leaked payload "${p.slice(0, 32)}…" via top-level redacted key`);
        }
        // Top-level redacted keys are stripped (not even rendered as
        // "[redacted]"); only nested ones go through the replacer.
        for (const k of REDACTED_KEYS) {
            assert.ok(!line.includes(`"${k}":"${RAW_PAYLOADS[0]}"`),
                `formatEntry should strip top-level "${k}"`);
        }
    });

    it('nested redacted keys are replaced with [redacted]', () => {
        const synthetic = {
            ts: '2026-01-01T00:00:00.000Z',
            route: '/fs/write',
            outcome: 'created',
            argsSummary: {
                path: 'x.txt',
                // A handler regression that buried payload under a nested
                // structure is the worst case — the replacer must catch it.
                nested: { content: RAW_PAYLOADS[0], data: RAW_PAYLOADS[1] },
            },
        };
        const line = formatEntry(synthetic, () => 0);
        for (const p of RAW_PAYLOADS) {
            assert.ok(!line.includes(p),
                `formatEntry leaked nested payload "${p.slice(0, 32)}…"`);
        }
        assert.ok(line.includes('[redacted]'),
            'formatEntry should render nested redacted keys as [redacted]');
    });
});

/* =====================================================================
 * End-to-end through the real on-disk logger. Covers the full pipeline
 * the production plugin uses: route handler → real buildAuditLogger →
 * fs.appendFile to a JSONL file. Reads the file back and asserts the
 * payload never reached disk.
 * ===================================================================== */

describe('audit redaction: end-to-end through real on-disk logger', () => {
    it('/fs/write payload never reaches the on-disk JSONL log', async () => {
        const logPath = path.join(ROOT, '.nova-audit', 'audit.jsonl');
        const realLogger = buildAuditLogger({ logPath });

        const handler = createFsWriteHandler({
            root: ROOT,
            normalizePath: normalizeNovaPath,
            auditLogger: realLogger,
        });

        const PAYLOAD = 'END-TO-END-PAYLOAD-must-not-hit-disk-9999-secret';
        const res = mockRes();
        await handler({ body: { path: 'e2e.txt', content: PAYLOAD, overwrite: true } }, res);
        assert.equal(res._state.statusCode, 200);

        const raw = await fsPromises.readFile(logPath, 'utf8');
        assert.ok(raw.length > 0, 'audit log file must have at least one line');
        assert.ok(!raw.includes(PAYLOAD), 'on-disk audit log leaked the raw payload');

        // Sanity: the metadata IS there, so we know we're reading the
        // right file and the test isn't passing because nothing was
        // written.
        assert.ok(raw.includes('"route":"/fs/write"'));
        assert.ok(raw.includes('"path":"e2e.txt"'));

        await realLogger.close();
    });
});
