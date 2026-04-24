/**
 * nova-agent-bridge — read-only filesystem route handlers (plan §8b).
 *
 * Pure CommonJS module. Every handler is a factory that takes `{ root,
 * normalizePath, fsImpl?, realpathImpl? }` and returns an Express-shaped
 * `(req, res) => Promise<void>`. This split lets the unit tests drive the
 * handlers with a mock fs and a deterministic root instead of spinning up
 * Express or touching the real filesystem.
 *
 * Routes implemented here:
 *   GET  /fs/list    — { path, recursive?, maxDepth? }
 *   GET  /fs/read    — { path, encoding?, maxBytes? }
 *   GET  /fs/stat    — { path }
 *   POST /fs/search  — { query, glob?, path?, maxResults? }
 *
 * Shared contract:
 *   - Requests use querystring for GETs, JSON body for POSTs.
 *   - Every request runs through `normalizePath` first (path safety +
 *     deny-list). On failure → 400 `{ error: 'invalid-path', reason }`.
 *   - After normalisation, `fs.realpath` is called and re-checked against
 *     the root to catch symlink escapes (plan §8c). On failure → 400
 *     `{ error: 'symlink-escape' }`.
 *   - Missing paths (ENOENT) → 404 `{ error: 'not-found' }`.
 *   - Any other fs error → 500 `{ error: 'fs-error', detail }`.
 *
 * Writes (`/fs/write`, `/fs/delete`, `/fs/move`) and shell are NOT in this
 * file — they need audit logging + trash-move mechanics and ship in a
 * separate sprint.
 */

'use strict';

const path = require('node:path');
const fsPromises = require('node:fs/promises');

// Plan §4a — hard cap on a single fs_read response body. The tool schema
// already clamps the client-supplied maxBytes to 10 MB; this is the plugin
// side of the same fence so a malformed or probing client can't bypass it.
const FS_READ_HARD_CAP_BYTES = 10 * 1024 * 1024;

// Plan §4a — fs_list recursion clamps. Mirror the tool schema defaults so
// a missing / malformed value still lands on a sane bound.
const FS_LIST_DEFAULT_MAX_DEPTH = 3;
const FS_LIST_MAX_MAX_DEPTH = 10;
const FS_LIST_HARD_CAP_ENTRIES = 5000;

// Plan §4a — fs_search clamps. Default 50; hard cap 500 matches the tool
// schema. Per-file read cap keeps a single giant file from wedging the loop.
const FS_SEARCH_DEFAULT_MAX_RESULTS = 50;
const FS_SEARCH_HARD_CAP_RESULTS = 500;
const FS_SEARCH_PER_FILE_READ_CAP_BYTES = 1 * 1024 * 1024; // 1 MB
const FS_SEARCH_PREVIEW_CHARS = 200;

/**
 * Small helper for sending error responses in a consistent shape.
 */
function sendError(res, status, error, extra = {}) {
    res.status(status).json({ error, ...extra });
}

/**
 * Resolve + realpath-and-recheck a request-supplied path. Returns a
 * discriminated union the handlers branch on.
 *
 * `realpathImpl` is injected for testability. Defaults to the real
 * `fs.promises.realpath`. On ENOENT we fall back to the non-realpath'd
 * absolute path and return `{ ok: true, exists: false, absolute, relative }`
 * so handlers like `/fs/stat` can return 404 instead of re-normalising.
 */
async function resolveRequestPath({ root, normalizePath, requestPath, realpathImpl }) {
    const norm = normalizePath({ root, requestPath });
    if (!norm.ok) {
        return { ok: false, status: 400, error: 'invalid-path', reason: norm.reason, detail: norm.detail };
    }
    const realpath = typeof realpathImpl === 'function' ? realpathImpl : fsPromises.realpath;
    let realAbs;
    try {
        realAbs = await realpath(norm.absolute);
    } catch (e) {
        if (e && e.code === 'ENOENT') {
            // The path is syntactically valid + contained but doesn't
            // exist yet. For read handlers this is a 404; the caller
            // decides the status from `exists: false`.
            return { ok: true, exists: false, absolute: norm.absolute, relative: norm.relative };
        }
        return { ok: false, status: 500, error: 'fs-error', detail: e?.message || String(e) };
    }
    // Symlink-escape check: re-normalise the resolved real path against the
    // root. If the realpath is outside root OR hits the deny-list we refuse.
    const rootReal = await (async () => {
        try { return await realpath(path.resolve(root)); }
        catch { return path.resolve(root); }
    })();
    const rel = path.relative(rootReal, realAbs);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
        return { ok: false, status: 400, error: 'symlink-escape' };
    }
    // Re-run the deny-list on the real relative path so a symlink into
    // `plugins/nova-agent-bridge/...` or `.git/...` is still denied even if
    // the original request didn't name it.
    const reNorm = normalizePath({ root: rootReal, requestPath: rel || '.' });
    if (!reNorm.ok) {
        return { ok: false, status: 400, error: 'invalid-path', reason: reNorm.reason, detail: reNorm.detail };
    }
    return { ok: true, exists: true, absolute: realAbs, relative: reNorm.relative };
}

/**
 * Coerce a query/body parameter to boolean. Accepts the common
 * browser/curl representations. Any other truthy value → true; any other
 * falsy value → false. Matches the convention used by ST's own routes.
 */
function toBool(v, fallback = false) {
    if (v === undefined || v === null || v === '') return fallback;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') {
        const s = v.toLowerCase();
        if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
        if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
    }
    return Boolean(v);
}

function toPositiveInt(v, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    const asInt = Math.trunc(n);
    if (asInt < min) return min;
    if (asInt > max) return max;
    return asInt;
}

/**
 * Convert a classic shell glob (as accepted by `fs_search.glob`) into a
 * RegExp. Supports `*` (non-slash), `**` (any incl. slash), `?`
 * (single non-slash), and character classes `[abc]`. Unsupported syntax
 * is escaped literally. Deliberately conservative so a malformed glob
 * downgrades to a no-op match rather than an unpredictable pattern.
 */
function globToRegExp(glob) {
    if (typeof glob !== 'string' || glob.length === 0) return null;
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') {
                re += '.*';
                i++;
            } else {
                re += '[^/]*';
            }
        } else if (c === '?') {
            re += '[^/]';
        } else if (c === '[') {
            // Consume until ']'. No attempt at class-negation sugar.
            let j = i + 1;
            while (j < glob.length && glob[j] !== ']') j++;
            if (j < glob.length) {
                re += glob.substring(i, j + 1);
                i = j;
            } else {
                re += '\\[';
            }
        } else if (/[.+^${}()|\\]/.test(c)) {
            re += '\\' + c;
        } else {
            re += c;
        }
    }
    return new RegExp('^' + re + '$');
}

/* =====================================================================
 * GET /fs/list
 *
 * Query: path (required), recursive (boolean), maxDepth (integer)
 * Response: { path, entries: [{ name, relative, type, size, mtimeMs, isSymlink }] }
 *
 * `type` is `'file' | 'directory' | 'other'`. Symlinks are reported with
 * `isSymlink: true` and their *target* type — the realpath check in
 * resolveRequestPath already refuses the whole listing if the directory
 * itself is a symlink escape, but individual children are shown as-is so
 * the agent can make an informed choice.
 * =====================================================================*/
function createFsListHandler({ root, normalizePath, fsImpl, realpathImpl }) {
    const fsp = fsImpl || fsPromises;
    return async function fsListHandler(req, res) {
        const q = req?.query || {};
        const requestPath = typeof q.path === 'string' ? q.path : '';
        const recursive = toBool(q.recursive, false);
        const maxDepth = toPositiveInt(q.maxDepth, FS_LIST_DEFAULT_MAX_DEPTH, {
            min: 1, max: FS_LIST_MAX_MAX_DEPTH,
        });

        const resolved = await resolveRequestPath({ root, normalizePath, requestPath, realpathImpl });
        if (!resolved.ok) return sendError(res, resolved.status, resolved.error,
            resolved.reason ? { reason: resolved.reason, detail: resolved.detail } : {});
        if (!resolved.exists) return sendError(res, 404, 'not-found');

        let rootStat;
        try { rootStat = await fsp.stat(resolved.absolute); }
        catch (e) { return sendError(res, 500, 'fs-error', { detail: e?.message || String(e) }); }
        if (!rootStat.isDirectory()) {
            return sendError(res, 400, 'not-a-directory');
        }

        const entries = [];
        async function walk(absDir, relDir, depth) {
            if (entries.length >= FS_LIST_HARD_CAP_ENTRIES) return;
            let dirents;
            try { dirents = await fsp.readdir(absDir, { withFileTypes: true }); }
            catch (e) {
                // Don't hard-fail the entire listing on a permissions error deep
                // in the tree — emit an error-shaped entry so the agent sees it.
                entries.push({ name: relDir || '.', relative: relDir || '.', type: 'error', error: e?.code || 'read-failed' });
                return;
            }
            for (const dirent of dirents) {
                if (entries.length >= FS_LIST_HARD_CAP_ENTRIES) return;
                const childRel = relDir ? `${relDir}/${dirent.name}` : dirent.name;
                const childAbs = path.join(absDir, dirent.name);
                // Deny-list check per child: reject `.git`, `node_modules`,
                // and the plugin subtree so they never appear in results.
                const childNorm = normalizePath({ root, requestPath: childRel });
                if (!childNorm.ok) continue;

                let type = 'other';
                let size = null;
                let mtimeMs = null;
                const isSymlink = dirent.isSymbolicLink?.() ?? false;
                try {
                    const st = await fsp.stat(childAbs);
                    if (st.isDirectory()) type = 'directory';
                    else if (st.isFile()) type = 'file';
                    size = st.size;
                    mtimeMs = st.mtimeMs;
                } catch {
                    // Broken symlink — keep the entry but mark the type.
                    type = 'broken-symlink';
                }
                entries.push({ name: dirent.name, relative: childRel, type, size, mtimeMs, isSymlink });

                if (recursive && type === 'directory' && depth < maxDepth) {
                    await walk(childAbs, childRel, depth + 1);
                }
            }
        }
        await walk(resolved.absolute, resolved.relative || '', 1);

        const truncated = entries.length >= FS_LIST_HARD_CAP_ENTRIES;
        res.json({
            path: resolved.relative || '.',
            recursive,
            maxDepth,
            truncated,
            entries,
        });
    };
}

/* =====================================================================
 * GET /fs/read
 *
 * Query: path (required), encoding ('utf8'|'base64'), maxBytes (integer)
 * Response: { path, encoding, bytes, truncated, content }
 *
 * `bytes` is the number of bytes actually read off disk. `truncated` is
 * true when the file was larger than `maxBytes`. The `content` field is
 * the encoded slice. Hard-caps maxBytes at FS_READ_HARD_CAP_BYTES so no
 * single response can exceed 10 MB.
 * =====================================================================*/
function createFsReadHandler({ root, normalizePath, fsImpl, realpathImpl }) {
    const fsp = fsImpl || fsPromises;
    return async function fsReadHandler(req, res) {
        const q = req?.query || {};
        const requestPath = typeof q.path === 'string' ? q.path : '';
        const encoding = q.encoding === 'base64' ? 'base64' : 'utf8';
        const maxBytes = toPositiveInt(q.maxBytes, 262144, {
            min: 1, max: FS_READ_HARD_CAP_BYTES,
        });

        const resolved = await resolveRequestPath({ root, normalizePath, requestPath, realpathImpl });
        if (!resolved.ok) return sendError(res, resolved.status, resolved.error,
            resolved.reason ? { reason: resolved.reason, detail: resolved.detail } : {});
        if (!resolved.exists) return sendError(res, 404, 'not-found');

        let st;
        try { st = await fsp.stat(resolved.absolute); }
        catch (e) { return sendError(res, 500, 'fs-error', { detail: e?.message || String(e) }); }
        if (!st.isFile()) {
            return sendError(res, 400, 'not-a-file');
        }

        const toRead = Math.min(st.size, maxBytes);
        const truncated = st.size > maxBytes;
        let buffer;
        try {
            // Read at most `toRead` bytes — never the whole file if it's
            // over the cap. Using an explicit fd + read avoids a read of
            // the full file only to throw away the tail.
            const fh = await fsp.open(resolved.absolute, 'r');
            try {
                const { bytesRead, buffer: buf } = await fh.read({
                    buffer: Buffer.alloc(toRead),
                    position: 0,
                });
                buffer = buf.subarray(0, bytesRead);
            } finally {
                await fh.close();
            }
        } catch (e) {
            return sendError(res, 500, 'fs-error', { detail: e?.message || String(e) });
        }

        res.json({
            path: resolved.relative || '.',
            encoding,
            bytes: buffer.length,
            size: st.size,
            truncated,
            content: encoding === 'base64' ? buffer.toString('base64') : buffer.toString('utf8'),
        });
    };
}

/* =====================================================================
 * GET /fs/stat
 *
 * Query: path (required)
 * Response: { path, type, size, mtimeMs, ctimeMs, birthtimeMs, isSymlink }
 * =====================================================================*/
function createFsStatHandler({ root, normalizePath, fsImpl, realpathImpl }) {
    const fsp = fsImpl || fsPromises;
    return async function fsStatHandler(req, res) {
        const q = req?.query || {};
        const requestPath = typeof q.path === 'string' ? q.path : '';

        const resolved = await resolveRequestPath({ root, normalizePath, requestPath, realpathImpl });
        if (!resolved.ok) return sendError(res, resolved.status, resolved.error,
            resolved.reason ? { reason: resolved.reason, detail: resolved.detail } : {});
        if (!resolved.exists) return sendError(res, 404, 'not-found');

        let st;
        let lst;
        try {
            st = await fsp.stat(resolved.absolute);
            try { lst = await fsp.lstat(resolved.absolute); } catch { lst = null; }
        } catch (e) {
            return sendError(res, 500, 'fs-error', { detail: e?.message || String(e) });
        }
        const type = st.isDirectory() ? 'directory' : (st.isFile() ? 'file' : 'other');
        res.json({
            path: resolved.relative || '.',
            type,
            size: st.size,
            mtimeMs: st.mtimeMs,
            ctimeMs: st.ctimeMs,
            birthtimeMs: st.birthtimeMs,
            isSymlink: lst ? (lst.isSymbolicLink?.() ?? false) : false,
        });
    };
}

/* =====================================================================
 * POST /fs/search
 *
 * Body (JSON): { query, glob?, path?, maxResults? }
 * Response: { query, glob, path, results: [{ path, line, preview }], truncated }
 *
 * Simple recursive substring search. `query` is compiled as a plain-text
 * string (no regex). Binary-looking files (large null count in first 8 KB)
 * are skipped. The result list is capped at maxResults (default 50, hard
 * max 500). Per-file read cap of 1 MB keeps a single oversized file from
 * wedging the loop.
 *
 * NOT a regex search. NOT a fuzzy search. The plan §4a description is
 * "full-text search" — this is the dumb, predictable implementation.
 * =====================================================================*/
function createFsSearchHandler({ root, normalizePath, fsImpl, realpathImpl }) {
    const fsp = fsImpl || fsPromises;
    return async function fsSearchHandler(req, res) {
        const body = req?.body || {};
        const query = typeof body.query === 'string' ? body.query : '';
        if (query.length === 0) return sendError(res, 400, 'query-required');
        const glob = typeof body.glob === 'string' ? body.glob : null;
        const globRe = globToRegExp(glob);
        const requestPath = typeof body.path === 'string' && body.path.length > 0 ? body.path : '.';
        const maxResults = toPositiveInt(body.maxResults, FS_SEARCH_DEFAULT_MAX_RESULTS, {
            min: 1, max: FS_SEARCH_HARD_CAP_RESULTS,
        });

        const resolved = await resolveRequestPath({ root, normalizePath, requestPath, realpathImpl });
        if (!resolved.ok) return sendError(res, resolved.status, resolved.error,
            resolved.reason ? { reason: resolved.reason, detail: resolved.detail } : {});
        if (!resolved.exists) return sendError(res, 404, 'not-found');

        let rootStat;
        try { rootStat = await fsp.stat(resolved.absolute); }
        catch (e) { return sendError(res, 500, 'fs-error', { detail: e?.message || String(e) }); }
        if (!rootStat.isDirectory()) {
            return sendError(res, 400, 'not-a-directory');
        }

        const results = [];
        let truncated = false;

        async function matchFile(absFile, relFile) {
            if (results.length >= maxResults) { truncated = true; return; }
            if (globRe && !globRe.test(relFile)) return;

            let st;
            try { st = await fsp.stat(absFile); } catch { return; }
            if (!st.isFile()) return;
            const toRead = Math.min(st.size, FS_SEARCH_PER_FILE_READ_CAP_BYTES);
            if (toRead === 0) return;

            let text;
            try {
                const fh = await fsp.open(absFile, 'r');
                try {
                    const { bytesRead, buffer } = await fh.read({
                        buffer: Buffer.alloc(toRead),
                        position: 0,
                    });
                    const slice = buffer.subarray(0, bytesRead);
                    // Binary-looking file guard: count null bytes in the head.
                    const head = slice.subarray(0, Math.min(slice.length, 8192));
                    let nullCount = 0;
                    for (let i = 0; i < head.length; i++) if (head[i] === 0) nullCount++;
                    if (nullCount > 4) return; // heuristic; mirrors ripgrep defaults
                    text = slice.toString('utf8');
                } finally {
                    await fh.close();
                }
            } catch { return; }

            let offset = 0;
            while (offset < text.length) {
                const hit = text.indexOf(query, offset);
                if (hit === -1) break;
                // Derive 1-based line number from the prefix.
                let line = 1;
                for (let i = 0; i < hit; i++) if (text.charCodeAt(i) === 10) line++;
                const lineStart = text.lastIndexOf('\n', hit - 1) + 1;
                const lineEnd = (() => {
                    const idx = text.indexOf('\n', hit);
                    return idx === -1 ? text.length : idx;
                })();
                const preview = text.substring(lineStart, Math.min(lineEnd, lineStart + FS_SEARCH_PREVIEW_CHARS));
                results.push({ path: relFile, line, preview });
                if (results.length >= maxResults) { truncated = true; return; }
                offset = hit + query.length;
            }
        }

        async function walk(absDir, relDir) {
            if (results.length >= maxResults) return;
            let dirents;
            try { dirents = await fsp.readdir(absDir, { withFileTypes: true }); }
            catch { return; }
            for (const dirent of dirents) {
                if (results.length >= maxResults) return;
                const childRel = relDir ? `${relDir}/${dirent.name}` : dirent.name;
                const childAbs = path.join(absDir, dirent.name);
                const childNorm = normalizePath({ root, requestPath: childRel });
                if (!childNorm.ok) continue;
                if (dirent.isDirectory?.()) {
                    await walk(childAbs, childRel);
                } else if (dirent.isFile?.()) {
                    await matchFile(childAbs, childRel);
                }
            }
        }
        await walk(resolved.absolute, resolved.relative || '');

        res.json({
            query,
            glob: glob || null,
            path: resolved.relative || '.',
            maxResults,
            truncated,
            results,
        });
    };
}

module.exports = {
    createFsListHandler,
    createFsReadHandler,
    createFsStatHandler,
    createFsSearchHandler,
    // Exported for unit tests.
    _internal: {
        resolveRequestPath,
        globToRegExp,
        toBool,
        toPositiveInt,
        FS_READ_HARD_CAP_BYTES,
        FS_LIST_DEFAULT_MAX_DEPTH,
        FS_LIST_MAX_MAX_DEPTH,
        FS_LIST_HARD_CAP_ENTRIES,
        FS_SEARCH_DEFAULT_MAX_RESULTS,
        FS_SEARCH_HARD_CAP_RESULTS,
        FS_SEARCH_PER_FILE_READ_CAP_BYTES,
        FS_SEARCH_PREVIEW_CHARS,
    },
};

// (Removed unused `fsSync` import — if a future sync variant of /fs/stat
// needs it, re-add alongside the handler that uses it.)
