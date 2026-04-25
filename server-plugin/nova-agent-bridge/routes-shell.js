/**
 * nova-agent-bridge — shell run route handler (plan §4b / §8b).
 *
 * Pure CommonJS. Like the fs route modules, the handler is a factory
 * returning an Express-shaped `(req, res) => Promise<void>` so tests
 * can drive it without Express.
 *
 * Route:
 *   POST /shell/run — body: { cmd, args?, cwd?, timeoutMs? }
 *
 * Safety model (plan §8c):
 *   - **Allow-list**. `cmd` must be a key in the resolved `allowList`
 *     map (`name → absolutePath`). The handler spawns the absolute
 *     path, NOT the bare name, so a later PATH change can't redirect
 *     us to a malicious binary mid-session. The plugin resolves the
 *     allow-list once at init time (`resolveAllowList` in `index.js`).
 *   - **No shell**. `child_process.spawn(absPath, args, { shell: false })`
 *     so shell metacharacters in `args` are passed through as literal
 *     arguments rather than interpreted by `/bin/sh`.
 *   - **stdin closed**. `stdio: ['ignore', 'pipe', 'pipe']` — the agent
 *     can't feed prompts to interactive programs. Shell tools should
 *     be one-shot, not interactive.
 *   - **cwd contained**. `cwd` (if provided) goes through the same
 *     `resolveRequestPath` pipeline as fs routes — symlinks out of
 *     root and the deny-list both apply. Default cwd is the root.
 *   - **Hard timeout**. Default 60s, hard cap 5min, hard min 100ms.
 *     SIGTERM first, SIGKILL after a short grace period if the child
 *     ignores SIGTERM.
 *   - **Output caps**. stdout/stderr are each truncated at
 *     `SHELL_OUTPUT_CAP_BYTES` (1 MB) — the response carries a
 *     `truncated: { stdout, stderr }` flag and the audit entry records
 *     the byte counts.
 *
 * Audit:
 *   - One entry per call. Outcome is one of:
 *     `refused-not-allowed`, `refused-bad-arg`, `refused-cwd`,
 *     `spawn-failed`, `completed`, `timed-out`.
 *   - `argsSummary` carries `cmd` (the bare name, not the absolute
 *     path) and `argsCount`. Actual arg values are NEVER logged —
 *     they could carry user data the same way `content` does for
 *     `fs_write`.
 *   - `stdoutBytes` / `stderrBytes` / `truncated` / `exitCode` /
 *     `signal` / `durationMs` are recorded for forensics.
 *
 * Response shape (200):
 *   { ok: true, exitCode, signal, stdout, stderr,
 *     timedOut, durationMs, truncated: { stdout, stderr } }
 *
 * The current `_novaBridgeRequest` (extension side) is JSON-only, so we
 * return a single JSON object rather than NDJSON-streaming the chunks.
 * Streaming is a UX nice-to-have called out in the plan; it can land
 * later without changing this handler's input shape.
 */

'use strict';

const childProcess = require('node:child_process');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const { resolveRequestPath, sendError } = require('./routes-fs-read.js');

// Plan §4b — shell timeouts. Min/max mirror the schema bounds enforced
// by `buildNovaShellHandler` on the extension side.
const SHELL_TIMEOUT_MIN_MS = 100;
const SHELL_TIMEOUT_MAX_MS = 5 * 60 * 1000;
const SHELL_TIMEOUT_DEFAULT_MS = 60 * 1000;

// 1 MB cap per stream. Any single command that emits more than this is
// almost certainly producing data that should be written to a file via
// `fs_write` and read back through `fs_read` instead.
const SHELL_OUTPUT_CAP_BYTES = 1 * 1024 * 1024;

// SIGTERM grace period before SIGKILL on timeout.
const SHELL_KILL_GRACE_MS = 500;

/**
 * Append a safe audit entry. If `audit` is falsy, no-op. Errors from the
 * audit layer are swallowed — the handler's contract to the user is not
 * affected by audit-log failures (mirrors the fs-route pattern).
 */
async function audit(auditLogger, entry) {
    if (!auditLogger || typeof auditLogger.append !== 'function') return;
    try { await auditLogger.append(entry); } catch { /* swallow */ }
}

/**
 * Coerce `timeoutMs` from the request body. Mirrors the extension-side
 * clamping in `buildNovaShellHandler` — only numeric primitives accepted,
 * clamped to `[SHELL_TIMEOUT_MIN_MS, SHELL_TIMEOUT_MAX_MS]`, default
 * `SHELL_TIMEOUT_DEFAULT_MS` when missing/invalid.
 *
 * `Number([])` is 0 and `Number([42])` is 42 — both finite. Explicit
 * type-check first so an array-shaped timeout can't sneak through as
 * a finite value.
 */
function coerceTimeout(raw) {
    if (raw === undefined || raw === null) return SHELL_TIMEOUT_DEFAULT_MS;
    if (typeof raw !== 'number' && typeof raw !== 'string') return SHELL_TIMEOUT_DEFAULT_MS;
    const n = Number(raw);
    if (!Number.isFinite(n)) return SHELL_TIMEOUT_DEFAULT_MS;
    return Math.floor(Math.min(SHELL_TIMEOUT_MAX_MS, Math.max(SHELL_TIMEOUT_MIN_MS, n)));
}

/**
 * Coerce `args` from the request body to a string[]. Non-array → `[]`;
 * non-string entries are dropped. Permissive on purpose so the LLM
 * sometimes-emitting `args: "single"` becomes `[]` rather than a 400.
 */
function coerceArgs(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter((x) => typeof x === 'string');
}

/**
 * Capture a child process's stdout + stderr into bounded buffers. Returns
 * a Promise resolving to `{ stdout, stderr, truncatedStdout, truncatedStderr }`
 * when both streams close. Each stream stops appending once it has
 * collected `cap` bytes; further data is silently dropped (we still
 * have to drain the stream so the child doesn't block on backpressure,
 * but `data` events past the cap don't grow the buffer).
 */
function captureBoundedStreams(child, cap) {
    const state = {
        stdout: '', stderr: '',
        stdoutBytes: 0, stderrBytes: 0,
        truncatedStdout: false, truncatedStderr: false,
    };
    function attach(stream, key, bytesKey, truncKey) {
        if (!stream) return Promise.resolve();
        stream.setEncoding('utf8');
        return new Promise((resolve) => {
            stream.on('data', (chunk) => {
                state[bytesKey] += Buffer.byteLength(chunk, 'utf8');
                if (state[truncKey]) return;
                if (state[key].length + chunk.length > cap) {
                    const remaining = cap - state[key].length;
                    if (remaining > 0) state[key] += chunk.slice(0, remaining);
                    state[truncKey] = true;
                } else {
                    state[key] += chunk;
                }
            });
            stream.on('end', resolve);
            stream.on('error', resolve);
        });
    }
    return Promise.all([
        attach(child.stdout, 'stdout', 'stdoutBytes', 'truncatedStdout'),
        attach(child.stderr, 'stderr', 'stderrBytes', 'truncatedStderr'),
    ]).then(() => state);
}

/**
 * Wait for the child to exit. Resolves with `{ code, signal }`. Never
 * rejects — `error` events from `spawn` are surfaced upstream by the
 * caller, not here.
 */
function waitForExit(child) {
    return new Promise((resolve) => {
        let done = false;
        child.once('exit', (code, signal) => {
            if (done) return; done = true;
            resolve({ code, signal });
        });
        child.once('error', (err) => {
            if (done) return; done = true;
            resolve({ code: null, signal: null, error: err });
        });
    });
}

/**
 * Build the `POST /shell/run` handler.
 *
 * Required deps:
 *   - `root`: absolute filesystem root the plugin is allowed to touch.
 *     Used by `resolveRequestPath` to validate `cwd`.
 *   - `normalizePath`: the `normalizeNovaPath` helper.
 *   - `allowList`: `{ [name: string]: absolutePath }` — allow-listed
 *     binaries resolved at init. Empty / missing → every request is
 *     refused with `refused-not-allowed` (closed enum).
 *
 * Optional deps:
 *   - `auditLogger`: audit-log append API; same shape as fs-write.
 *   - `spawnImpl`: defaults to `child_process.spawn`. Tests inject a
 *     mock that returns a fake child with `stdout`/`stderr`/`kill`
 *     and emits `exit`/`error` synthetically.
 *   - `nowImpl`: defaults to `Date.now`. Used for `durationMs`.
 *   - `realpathImpl`: forwarded to `resolveRequestPath`.
 */
function createShellRunHandler({
    root, normalizePath, allowList,
    auditLogger, spawnImpl, nowImpl, realpathImpl,
}) {
    const spawn = typeof spawnImpl === 'function' ? spawnImpl : childProcess.spawn;
    const now = typeof nowImpl === 'function' ? nowImpl : Date.now;
    const allow = (allowList && typeof allowList === 'object') ? allowList : {};

    return async function shellRunHandler(req, res) {
        const body = req?.body || {};
        const cmd = typeof body.cmd === 'string' ? body.cmd : '';
        if (!cmd) {
            await audit(auditLogger, {
                route: '/shell/run', outcome: 'refused-bad-arg',
                argsSummary: { cmd: '', argsCount: 0 },
                error: 'cmd-required',
            });
            return sendError(res, 400, 'cmd-required');
        }

        const absPath = allow[cmd];
        if (typeof absPath !== 'string' || absPath.length === 0) {
            await audit(auditLogger, {
                route: '/shell/run', outcome: 'refused-not-allowed',
                argsSummary: { cmd, argsCount: 0 },
            });
            return sendError(res, 403, 'command-not-allowed', {
                detail: `'${cmd}' is not on the configured allow-list`,
            });
        }

        const args = coerceArgs(body.args);
        const timeoutMs = coerceTimeout(body.timeoutMs);

        // Resolve cwd against root using the same path-safety pipeline as
        // fs routes. Default cwd = root. An explicitly-supplied cwd that
        // doesn't exist is refused (we don't auto-create a directory just
        // to run a command in it).
        let cwdAbs = root;
        let cwdRel = '.';
        if (typeof body.cwd === 'string' && body.cwd.length > 0) {
            const resolved = await resolveRequestPath({
                root, normalizePath, requestPath: body.cwd, realpathImpl,
            });
            if (!resolved.ok) {
                await audit(auditLogger, {
                    route: '/shell/run', outcome: 'refused-cwd',
                    argsSummary: { cmd, argsCount: args.length, cwd: body.cwd },
                    error: resolved.error,
                });
                return sendError(res, resolved.status, resolved.error,
                    resolved.reason ? { reason: resolved.reason, detail: resolved.detail } : {});
            }
            if (!resolved.exists) {
                await audit(auditLogger, {
                    route: '/shell/run', outcome: 'refused-cwd',
                    argsSummary: { cmd, argsCount: args.length, cwd: resolved.relative },
                    error: 'cwd-not-found',
                });
                return sendError(res, 400, 'cwd-not-found');
            }
            // Verify it's actually a directory.
            try {
                const st = await fsPromises.stat(resolved.absolute);
                if (!st.isDirectory()) {
                    await audit(auditLogger, {
                        route: '/shell/run', outcome: 'refused-cwd',
                        argsSummary: { cmd, argsCount: args.length, cwd: resolved.relative },
                        error: 'cwd-not-a-directory',
                    });
                    return sendError(res, 400, 'cwd-not-a-directory');
                }
            } catch (e) {
                await audit(auditLogger, {
                    route: '/shell/run', outcome: 'refused-cwd',
                    argsSummary: { cmd, argsCount: args.length, cwd: resolved.relative },
                    error: e?.message || String(e),
                });
                return sendError(res, 500, 'fs-error', { detail: e?.message || String(e) });
            }
            cwdAbs = resolved.absolute;
            cwdRel = resolved.relative;
        }

        // Spawn. `shell: false` is critical — it disables shell-metachar
        // interpretation. `stdio: ['ignore', 'pipe', 'pipe']` closes
        // stdin so interactive prompts immediately EOF.
        const t0 = now();
        let child;
        try {
            child = spawn(absPath, args, {
                cwd: cwdAbs,
                shell: false,
                stdio: ['ignore', 'pipe', 'pipe'],
                // Inherit the plugin's environment. The plugin is itself
                // sandboxed by ST's process; the agent doesn't get extra
                // privileges by inheriting env.
                env: process.env,
            });
        } catch (e) {
            await audit(auditLogger, {
                route: '/shell/run', outcome: 'spawn-failed',
                argsSummary: { cmd, argsCount: args.length, cwd: cwdRel, timeoutMs },
                error: e?.message || String(e),
            });
            return sendError(res, 500, 'spawn-failed', { detail: e?.message || String(e) });
        }

        // Set up the timeout. SIGTERM first, then SIGKILL after the
        // grace window. The `timedOut` flag flips once we've sent
        // SIGTERM so the response can carry that signal.
        let timedOut = false;
        const timeoutHandle = setTimeout(() => {
            timedOut = true;
            try { child.kill('SIGTERM'); } catch { /* best-effort */ }
            setTimeout(() => {
                try { child.kill('SIGKILL'); } catch { /* best-effort */ }
            }, SHELL_KILL_GRACE_MS).unref?.();
        }, timeoutMs);
        timeoutHandle.unref?.();

        const captureP = captureBoundedStreams(child, SHELL_OUTPUT_CAP_BYTES);
        const exitInfo = await waitForExit(child);
        clearTimeout(timeoutHandle);

        // Wait for stream-end events to flush — `exit` can fire before
        // the streams emit `end`, especially under fast-exiting commands.
        const captured = await captureP;

        const durationMs = now() - t0;

        // `error` from the spawn lifecycle (ENOENT etc.) was captured
        // during waitForExit — surface it as spawn-failed.
        if (exitInfo.error) {
            await audit(auditLogger, {
                route: '/shell/run', outcome: 'spawn-failed',
                argsSummary: { cmd, argsCount: args.length, cwd: cwdRel, timeoutMs },
                error: exitInfo.error?.message || String(exitInfo.error),
                durationMs,
            });
            return sendError(res, 500, 'spawn-failed', {
                detail: exitInfo.error?.message || String(exitInfo.error),
            });
        }

        const truncated = {
            stdout: captured.truncatedStdout,
            stderr: captured.truncatedStderr,
        };

        await audit(auditLogger, {
            route: '/shell/run',
            outcome: timedOut ? 'timed-out' : 'completed',
            argsSummary: { cmd, argsCount: args.length, cwd: cwdRel, timeoutMs },
            exitCode: exitInfo.code,
            signal: exitInfo.signal,
            stdoutBytes: captured.stdoutBytes,
            stderrBytes: captured.stderrBytes,
            truncated,
            durationMs,
        });

        res.json({
            ok: true,
            exitCode: exitInfo.code,
            signal: exitInfo.signal,
            stdout: captured.stdout,
            stderr: captured.stderr,
            timedOut,
            durationMs,
            truncated,
        });
    };
}

module.exports = {
    createShellRunHandler,
    _internal: {
        coerceArgs,
        coerceTimeout,
        captureBoundedStreams,
        SHELL_TIMEOUT_MIN_MS,
        SHELL_TIMEOUT_MAX_MS,
        SHELL_TIMEOUT_DEFAULT_MS,
        SHELL_OUTPUT_CAP_BYTES,
        SHELL_KILL_GRACE_MS,
    },
};
