/**
 * nova-agent-bridge — audit logger (plan §8c).
 *
 * Pure CommonJS factory. `buildAuditLogger({ logPath, fsImpl?, nowImpl? })`
 * returns `{ append(entry), close() }`. One JSON object per line, UTF-8,
 * newline-terminated, appended atomically via `fs.appendFile`.
 *
 * Entry shape (plan §8c):
 *   { ts, user, route, argsSummary, outcome, bytes? }
 *
 * Fields are not schema-enforced at this layer — the handlers decide what
 * summary text is safe to log. What IS enforced here:
 *   - The keys `content`, `data`, `payload`, `body` are stripped from the
 *     top level of `entry` before serialisation. They are the ambient names
 *     for "raw user data we promised never to log" and stripping them is
 *     a belt-and-braces guard against a careless caller.
 *   - `JSON.stringify` replacer elides nested `content` / `data` keys too.
 *   - If serialisation throws (cyclic ref etc.) we fall back to a stub
 *     entry `{ ts, route, outcome:'error', error:'json-serialise-failed' }`
 *     so we *never* drop a write silently.
 *
 * Log rotation is NOT implemented here — plan §8c doesn't require it yet.
 * The `rotate(maxBytes)` placeholder is reserved on the return object so a
 * future sprint can add rotation without changing callsites.
 */

'use strict';

const path = require('node:path');
const fsPromises = require('node:fs/promises');

const REDACTED_KEYS = Object.freeze(['content', 'data', 'payload', 'body', 'raw']);

/**
 * JSON replacer that elides values under keys we promised not to log. Used
 * both at top level (`entry.content` is also pre-stripped) and for any
 * nested `{ content: ... }` a caller forgot to flatten.
 */
function redactReplacer(key, value) {
    if (REDACTED_KEYS.includes(key)) return '[redacted]';
    return value;
}

/**
 * Sanitise a top-level entry object: shallow-clone and drop any redacted
 * keys. Returns a new object; does not mutate the input.
 */
function sanitizeEntry(entry) {
    if (!entry || typeof entry !== 'object') return {};
    const clean = {};
    for (const [k, v] of Object.entries(entry)) {
        if (REDACTED_KEYS.includes(k)) continue;
        clean[k] = v;
    }
    return clean;
}

/**
 * Serialise an entry to a newline-terminated JSONL line. On serialisation
 * failure returns a stub line instead of throwing — the audit log is a
 * best-effort record, not an atomic-guarantee store.
 */
function formatEntry(entry, nowImpl) {
    const now = typeof nowImpl === 'function' ? nowImpl : Date.now;
    const ts = entry && typeof entry.ts === 'string' ? entry.ts : new Date(now()).toISOString();
    const clean = sanitizeEntry(entry);
    clean.ts = ts;
    try {
        return JSON.stringify(clean, redactReplacer) + '\n';
    } catch {
        return JSON.stringify({
            ts,
            route: typeof entry?.route === 'string' ? entry.route : 'unknown',
            outcome: 'error',
            error: 'json-serialise-failed',
        }) + '\n';
    }
}

/**
 * Factory. `logPath` must be absolute. `fsImpl` (optional) must expose
 * `appendFile(path, data, encoding?)` and `mkdir(path, opts)`. `nowImpl`
 * (optional) is a `() => epochMs` hook for deterministic timestamps in
 * tests.
 */
function buildAuditLogger({ logPath, fsImpl, nowImpl } = {}) {
    if (typeof logPath !== 'string' || logPath.length === 0) {
        throw new Error('buildAuditLogger: logPath required');
    }
    if (!path.isAbsolute(logPath)) {
        throw new Error('buildAuditLogger: logPath must be absolute');
    }
    const fsp = fsImpl || fsPromises;
    let dirEnsured = false;

    async function ensureDir() {
        if (dirEnsured) return;
        const dir = path.dirname(logPath);
        try { await fsp.mkdir(dir, { recursive: true }); }
        catch { /* best-effort; the appendFile below will surface the real error */ }
        dirEnsured = true;
    }

    async function append(entry) {
        const line = formatEntry(entry, nowImpl);
        try {
            await ensureDir();
            await fsp.appendFile(logPath, line, 'utf8');
            return { ok: true };
        } catch (e) {
            // Swallow errors — a broken audit log must not cascade into a
            // failed user request. The handler wrapping the call receives
            // `{ ok: false, error }` and can warn-log to stderr if it
            // wants a signal.
            return { ok: false, error: e?.message || String(e) };
        }
    }

    async function close() {
        // No persistent handle to release today. Reserved for the rotation
        // sprint that may open a write-stream for batching.
    }

    return { append, close, rotate: null, _internal: { formatEntry, sanitizeEntry } };
}

module.exports = {
    buildAuditLogger,
    REDACTED_KEYS,
    // Exported for unit tests.
    _internal: { formatEntry, sanitizeEntry, redactReplacer },
};
