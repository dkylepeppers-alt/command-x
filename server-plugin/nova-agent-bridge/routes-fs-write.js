/**
 * nova-agent-bridge — write + delete + move route handlers (plan §8b).
 *
 * Pure CommonJS. Like `routes-fs-read.js`, every handler is a factory
 * returning an Express-shaped `(req, res) => Promise<void>` so tests
 * can drive handlers against real tempdirs without Express.
 *
 * Routes implemented here:
 *   POST /fs/write   — { path, content, encoding?, createParents?, overwrite? }
 *   POST /fs/delete  — { path, recursive? }
 *   POST /fs/move    — { from, to, overwrite? }
 *
 * Safety model (plan §8c/§4a):
 *   - Every path runs through `resolveRequestPath` (imported from
 *     `routes-fs-read.js`), which does `normalizeNovaPath` → `fs.realpath`
 *     → re-normalise → re-run deny-list. Symlink-escapes and .git /
 *     node_modules / plugin-self paths are refused.
 *   - `fs_write` hard-caps `content` at 20 MB (base64-encoded length is
 *     decoded first so the check is on the actual byte count).
 *   - On overwrite: existing file is moved to `<trashRoot>/<ts>/<relPath>`
 *     FIRST, and only then does the write proceed. If the backup fails
 *     the write is refused.
 *   - `fs_delete` NEVER hard-unlinks. It is always a move-to-trash, so
 *     an agent mistake is always recoverable until the user empties the
 *     trash themselves.
 *   - `fs_move` refuses if `to` exists and `overwrite:false`; on
 *     `overwrite:true` it backs up `to` to trash first.
 *
 * Audit:
 *   - The factory signature takes an optional `{ audit }` — when present,
 *     every completed handler call appends a JSONL entry via
 *     `audit.append({ ts, route, argsSummary, outcome, bytes? })`.
 *   - Raw content is NEVER included in the audit entry. The write handler
 *     logs `bytes` + `overwrote` instead.
 */

'use strict';

const path = require('node:path');
const fsPromises = require('node:fs/promises');
const { resolveRequestPath, sendError } = require('./routes-fs-read.js');

// Plan §8c — 20 MB write cap. A base64 string of N bytes decodes to
// floor(N*3/4) bytes; the handler decodes to a Buffer and checks .length,
// so this ceiling applies to the on-disk size.
const FS_WRITE_HARD_CAP_BYTES = 20 * 1024 * 1024;

// Name of the trash directory under the root. Must match what the
// read-side deny-list recognises so the agent cannot accidentally
// read/write inside the trash (it is not on the deny-list today, but
// landing in a predictable dir makes backup/cleanup trivial).
const TRASH_DIR_NAME = '.nova-trash';

/**
 * Generate a trash bucket identifier for this request. Uses ISO-ish
 * UTC timestamp with colons and dots stripped so it is a valid
 * path segment on every OS. Deterministic-via-DI for tests.
 */
function trashBucket(nowImpl) {
    const now = typeof nowImpl === 'function' ? nowImpl : Date.now;
    return new Date(now()).toISOString().replace(/[:.]/g, '-');
}

/**
 * Move `absPath` (inside root) to `<root>/<TRASH_DIR_NAME>/<bucket>/<relPath>`.
 * Creates parent directories under the trash bucket as needed. On failure
 * returns `{ ok: false, error }` rather than throwing.
 *
 * Returns `{ ok: true, trashAbs, trashRel }` on success, where `trashRel`
 * is the POSIX-style relative path the entry now lives at under the
 * trash root.
 */
async function moveToTrash({ root, absPath, relPath, bucket, fsImpl }) {
    const fsp = fsImpl || fsPromises;
    if (typeof relPath !== 'string' || relPath.length === 0) {
        return { ok: false, error: 'empty-rel-path' };
    }
    // The trash entry keeps the original layout so a user can eyeball
    // what got moved and where. If an identical path was trashed earlier
    // in the same bucket (same millisecond — extremely unlikely with the
    // `bucket` granularity but still possible under DI clocks), we
    // disambiguate with a `.1` / `.2` suffix.
    const trashRoot = path.join(root, TRASH_DIR_NAME, bucket);
    let candidate = path.join(trashRoot, relPath);
    try {
        await fsp.mkdir(path.dirname(candidate), { recursive: true });
    } catch (e) {
        return { ok: false, error: e?.message || String(e) };
    }
    // Collision-avoidance loop. Stop at 100 attempts so a pathological
    // case can't spin forever.
    for (let attempt = 0; attempt < 100; attempt++) {
        try {
            await fsp.rename(absPath, candidate);
            return {
                ok: true,
                trashAbs: candidate,
                trashRel: path.posix.join(TRASH_DIR_NAME, bucket, relPath.split(path.sep).join('/'))
                    + (attempt > 0 ? `.${attempt}` : ''),
            };
        } catch (e) {
            if (e?.code === 'EEXIST') {
                candidate = path.join(trashRoot, `${relPath}.${attempt + 1}`);
                continue;
            }
            // rename across devices falls back to copy+unlink
            if (e?.code === 'EXDEV') {
                try {
                    await fsp.cp(absPath, candidate, { recursive: true, errorOnExist: true });
                    await fsp.rm(absPath, { recursive: true, force: true });
                    return {
                        ok: true,
                        trashAbs: candidate,
                        trashRel: path.posix.join(TRASH_DIR_NAME, bucket, relPath.split(path.sep).join('/')),
                    };
                } catch (e2) {
                    return { ok: false, error: e2?.message || String(e2) };
                }
            }
            return { ok: false, error: e?.message || String(e) };
        }
    }
    return { ok: false, error: 'trash-name-collision' };
}

/**
 * Reject a request that targets the root itself. The write/delete/move
 * handlers all share this guard — the path-safety layer treats "." as a
 * valid contained path, so it must be checked by the operation layer.
 */
function refuseRoot(relPath, res, auditLogger, entry) {
    if (relPath && relPath !== '' && relPath !== '.') return false;
    if (auditLogger) audit(auditLogger, entry).catch(() => {}); // best-effort
    sendError(res, 400, 'refused-root');
    return true;
}

/**
 * Append a safe audit entry. If `audit` is falsy, no-op. Errors from the
 * audit layer are swallowed — the handler's contract to the user is not
 * affected by audit-log failures (see `audit.js` for rationale).
 */
async function audit(auditLogger, entry) {
    if (!auditLogger || typeof auditLogger.append !== 'function') return;
    try { await auditLogger.append(entry); } catch { /* swallow */ }
}

/* =====================================================================
 * POST /fs/write
 * Body: { path, content, encoding?, createParents?, overwrite? }
 * ===================================================================== */
function createFsWriteHandler({ root, normalizePath, fsImpl, realpathImpl, auditLogger, nowImpl }) {
    const fsp = fsImpl || fsPromises;
    return async function fsWriteHandler(req, res) {
        const body = req?.body || {};
        const requestPath = typeof body.path === 'string' ? body.path : '';
        const encoding = body.encoding === 'base64' ? 'base64' : 'utf8';
        const createParents = body.createParents !== false; // default true
        const overwrite = Boolean(body.overwrite);

        if (typeof body.content !== 'string') {
            return sendError(res, 400, 'content-required');
        }

        let buffer;
        try {
            buffer = Buffer.from(body.content, encoding);
        } catch (e) {
            return sendError(res, 400, 'invalid-content', { detail: e?.message || String(e) });
        }
        if (buffer.length > FS_WRITE_HARD_CAP_BYTES) {
            return sendError(res, 413, 'content-too-large', { cap: FS_WRITE_HARD_CAP_BYTES, bytes: buffer.length });
        }

        const resolved = await resolveRequestPath({ root, normalizePath, requestPath, realpathImpl });
        if (!resolved.ok) return sendError(res, resolved.status, resolved.error,
            resolved.reason ? { reason: resolved.reason, detail: resolved.detail } : {});

        // Check existence + overwrite semantics BEFORE we touch anything.
        const targetAbs = resolved.absolute;
        const relPath = resolved.relative || path.basename(targetAbs);
        let existed = false;
        try {
            const st = await fsp.stat(targetAbs);
            if (st.isDirectory()) {
                await audit(auditLogger, {
                    route: '/fs/write', outcome: 'refused-is-directory',
                    argsSummary: { path: relPath },
                });
                return sendError(res, 400, 'is-directory');
            }
            existed = true;
        } catch (e) {
            if (e?.code !== 'ENOENT') {
                return sendError(res, 500, 'fs-error', { detail: e?.message || String(e) });
            }
        }
        if (existed && !overwrite) {
            await audit(auditLogger, {
                route: '/fs/write', outcome: 'refused-exists',
                argsSummary: { path: relPath, overwrite: false },
            });
            return sendError(res, 409, 'exists', { detail: 'file exists and overwrite=false' });
        }

        // Back up existing to trash before overwrite.
        let backup = null;
        if (existed) {
            const bucket = trashBucket(nowImpl);
            backup = await moveToTrash({ root, absPath: targetAbs, relPath, bucket, fsImpl });
            if (!backup.ok) {
                await audit(auditLogger, {
                    route: '/fs/write', outcome: 'error-backup',
                    argsSummary: { path: relPath }, error: backup.error,
                });
                return sendError(res, 500, 'backup-failed', { detail: backup.error });
            }
        }

        if (createParents) {
            try { await fsp.mkdir(path.dirname(targetAbs), { recursive: true }); }
            catch (e) {
                await audit(auditLogger, {
                    route: '/fs/write', outcome: 'error-mkdir',
                    argsSummary: { path: relPath }, error: e?.message,
                });
                return sendError(res, 500, 'mkdir-failed', { detail: e?.message || String(e) });
            }
        }

        try {
            await fsp.writeFile(targetAbs, buffer);
        } catch (e) {
            await audit(auditLogger, {
                route: '/fs/write', outcome: 'error-write',
                argsSummary: { path: relPath }, error: e?.message,
            });
            return sendError(res, 500, 'write-failed', { detail: e?.message || String(e) });
        }

        await audit(auditLogger, {
            route: '/fs/write',
            outcome: existed ? 'overwrote' : 'created',
            argsSummary: { path: relPath, encoding, createParents, overwrite, overwrote: existed },
            bytes: buffer.length,
            backup: backup?.trashRel || null,
        });

        res.json({
            ok: true,
            path: relPath,
            bytes: buffer.length,
            overwrote: existed,
            backup: backup?.trashRel || null,
        });
    };
}

/* =====================================================================
 * POST /fs/delete
 * Body: { path, recursive? }
 * Always moves to trash. Never hard-unlinks.
 * ===================================================================== */
function createFsDeleteHandler({ root, normalizePath, fsImpl, realpathImpl, auditLogger, nowImpl }) {
    const fsp = fsImpl || fsPromises;
    return async function fsDeleteHandler(req, res) {
        const body = req?.body || {};
        const requestPath = typeof body.path === 'string' ? body.path : '';
        const recursive = Boolean(body.recursive);

        const resolved = await resolveRequestPath({ root, normalizePath, requestPath, realpathImpl });
        if (!resolved.ok) return sendError(res, resolved.status, resolved.error,
            resolved.reason ? { reason: resolved.reason, detail: resolved.detail } : {});
        if (!resolved.exists) return sendError(res, 404, 'not-found');

        // Extra safety: refuse to delete the root itself.
        const relPath = resolved.relative;
        if (refuseRoot(relPath, res, auditLogger, {
            route: '/fs/delete', outcome: 'refused-root', argsSummary: { path: '.' },
        })) return;

        let st;
        try { st = await fsp.stat(resolved.absolute); }
        catch (e) { return sendError(res, 500, 'fs-error', { detail: e?.message || String(e) }); }

        if (st.isDirectory() && !recursive) {
            // Refuse non-empty directory without recursive flag.
            let entries;
            try { entries = await fsp.readdir(resolved.absolute); }
            catch (e) { return sendError(res, 500, 'fs-error', { detail: e?.message || String(e) }); }
            if (entries.length > 0) {
                await audit(auditLogger, {
                    route: '/fs/delete', outcome: 'refused-not-empty',
                    argsSummary: { path: relPath, recursive: false, entries: entries.length },
                });
                return sendError(res, 409, 'not-empty', { detail: 'directory not empty and recursive=false' });
            }
        }

        const bucket = trashBucket(nowImpl);
        const moved = await moveToTrash({ root, absPath: resolved.absolute, relPath, bucket, fsImpl });
        if (!moved.ok) {
            await audit(auditLogger, {
                route: '/fs/delete', outcome: 'error-trash',
                argsSummary: { path: relPath }, error: moved.error,
            });
            return sendError(res, 500, 'trash-failed', { detail: moved.error });
        }

        await audit(auditLogger, {
            route: '/fs/delete', outcome: 'trashed',
            argsSummary: { path: relPath, recursive, type: st.isDirectory() ? 'directory' : 'file' },
            backup: moved.trashRel,
        });

        res.json({
            ok: true,
            path: relPath,
            type: st.isDirectory() ? 'directory' : 'file',
            backup: moved.trashRel,
        });
    };
}

/* =====================================================================
 * POST /fs/move
 * Body: { from, to, overwrite? }
 * ===================================================================== */
function createFsMoveHandler({ root, normalizePath, fsImpl, realpathImpl, auditLogger, nowImpl }) {
    const fsp = fsImpl || fsPromises;
    return async function fsMoveHandler(req, res) {
        const body = req?.body || {};
        const fromPath = typeof body.from === 'string' ? body.from : '';
        const toPath = typeof body.to === 'string' ? body.to : '';
        const overwrite = Boolean(body.overwrite);

        const resolvedFrom = await resolveRequestPath({ root, normalizePath, requestPath: fromPath, realpathImpl });
        if (!resolvedFrom.ok) return sendError(res, resolvedFrom.status, resolvedFrom.error,
            resolvedFrom.reason ? { reason: resolvedFrom.reason, detail: resolvedFrom.detail } : {});
        if (!resolvedFrom.exists) return sendError(res, 404, 'not-found', { detail: 'from path missing' });

        // `to` is allowed to not exist yet (that's the expected case for a
        // fresh move). Use `resolveRequestPath` to normalise/contain it,
        // but don't fail on `exists:false`.
        const resolvedTo = await resolveRequestPath({ root, normalizePath, requestPath: toPath, realpathImpl });
        if (!resolvedTo.ok) return sendError(res, resolvedTo.status, resolvedTo.error,
            resolvedTo.reason ? { reason: resolvedTo.reason, detail: resolvedTo.detail } : {});

        const fromRel = resolvedFrom.relative;
        const toRel = resolvedTo.relative;

        if (refuseRoot(fromRel, res, auditLogger, {
            route: '/fs/move', outcome: 'refused-root', argsSummary: { from: '.' },
        })) return;

        if (resolvedTo.exists) {
            if (!overwrite) {
                await audit(auditLogger, {
                    route: '/fs/move', outcome: 'refused-exists',
                    argsSummary: { from: fromRel, to: toRel, overwrite: false },
                });
                return sendError(res, 409, 'destination-exists', { detail: 'to path exists and overwrite=false' });
            }
            const bucket = trashBucket(nowImpl);
            const backup = await moveToTrash({ root, absPath: resolvedTo.absolute, relPath: toRel, bucket, fsImpl });
            if (!backup.ok) {
                await audit(auditLogger, {
                    route: '/fs/move', outcome: 'error-backup',
                    argsSummary: { from: fromRel, to: toRel }, error: backup.error,
                });
                return sendError(res, 500, 'backup-failed', { detail: backup.error });
            }
        }

        // Ensure parent dir of the new location exists.
        try { await fsp.mkdir(path.dirname(resolvedTo.absolute), { recursive: true }); }
        catch (e) { return sendError(res, 500, 'mkdir-failed', { detail: e?.message || String(e) }); }

        try {
            await fsp.rename(resolvedFrom.absolute, resolvedTo.absolute);
        } catch (e) {
            if (e?.code === 'EXDEV') {
                try {
                    await fsp.cp(resolvedFrom.absolute, resolvedTo.absolute, { recursive: true, errorOnExist: true });
                    await fsp.rm(resolvedFrom.absolute, { recursive: true, force: true });
                } catch (e2) {
                    await audit(auditLogger, {
                        route: '/fs/move', outcome: 'error-move',
                        argsSummary: { from: fromRel, to: toRel }, error: e2?.message,
                    });
                    return sendError(res, 500, 'move-failed', { detail: e2?.message || String(e2) });
                }
            } else {
                await audit(auditLogger, {
                    route: '/fs/move', outcome: 'error-move',
                    argsSummary: { from: fromRel, to: toRel }, error: e?.message,
                });
                return sendError(res, 500, 'move-failed', { detail: e?.message || String(e) });
            }
        }

        await audit(auditLogger, {
            route: '/fs/move', outcome: 'moved',
            argsSummary: { from: fromRel, to: toRel, overwrite, overwroteDest: resolvedTo.exists },
        });

        res.json({
            ok: true,
            from: fromRel,
            to: toRel,
            overwroteDest: resolvedTo.exists,
        });
    };
}

module.exports = {
    createFsWriteHandler,
    createFsDeleteHandler,
    createFsMoveHandler,
    _internal: {
        moveToTrash,
        trashBucket,
        refuseRoot,
        FS_WRITE_HARD_CAP_BYTES,
        TRASH_DIR_NAME,
    },
};
