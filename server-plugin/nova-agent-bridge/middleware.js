/**
 * nova-agent-bridge — security middleware (plan §8c).
 *
 * Reproduces SillyTavern's built-in CSRF + session checks at the
 * plugin-router level as belt-and-suspenders. ST already mounts
 * `csrf-sync`'s `csrfSynchronisedProtection` globally *before* plugin
 * routers are registered (see `src/server-main.js`), so in the happy
 * path this middleware is redundant. But:
 *
 *   - If ST is run with `--disableCsrf` the plugin is still exposed
 *     to any authenticated browser tab (and any same-origin XHR from
 *     a malicious extension's content script), so we refuse writes
 *     without a valid token.
 *   - If a future ST release changes middleware ordering and mounts
 *     plugins before the global CSRF check, this middleware still
 *     enforces the contract.
 *   - If the plugin is ever used from a non-ST host (tests,
 *     standalone script) we fail closed instead of open.
 *
 * Contract:
 *   - Reads the session token from `req.session.csrfToken` — exactly
 *     the same slot ST's `csrfSync` writes to via its
 *     `storeTokenInState` callback. Same slot means a legitimate
 *     token minted by ST is accepted without any handshake change.
 *   - Reads the request token from the `x-csrf-token` header, same
 *     as ST's `getTokenFromRequest` callback. Same header name means
 *     the extension's existing `getRequestHeaders()` output works.
 *   - Only gates state-changing methods by default (POST / PUT /
 *     PATCH / DELETE). GETs pass through as long as the session
 *     looks authenticated, matching ST's own policy.
 *
 * The middleware is a pure factory so unit tests can drive it with
 * mock `req` / `res` / `next` objects. It never throws: malformed
 * inputs always resolve to a closed-enum error response.
 */

'use strict';

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Build the plugin security middleware.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.csrfRequired=true]    — Enforce CSRF on
 *   state-changing methods. Keep on; the opt-out exists only for
 *   automated tests that can't mint a valid token.
 * @param {boolean} [opts.sessionRequired=true] — Require a populated
 *   `req.session`. Opt-out exists for self-tests that hit `/health`
 *   before a user has signed in.
 * @param {Set<string>|string[]} [opts.skip] — Exact route paths
 *   (relative to the plugin mount point, so `/health` not
 *   `/api/plugins/.../health`) that bypass both checks. Matched with
 *   `Set.prototype.has`, so this is exact-string equality — *not* a
 *   prefix match. Defaults to `['/health', '/manifest']` which match
 *   the extension's capability probe — those are read-only
 *   advertisements and must work before any user context is wired up.
 * @returns {function(req, res, next): void} Express middleware.
 */
function buildNovaSecurityMiddleware(opts) {
    const options = (opts && typeof opts === 'object') ? opts : {};
    const csrfRequired = options.csrfRequired !== false;
    const sessionRequired = options.sessionRequired !== false;

    const skipRaw = options.skip;
    let skipSet;
    if (skipRaw instanceof Set) {
        skipSet = skipRaw;
    } else if (Array.isArray(skipRaw)) {
        skipSet = new Set(skipRaw.filter((x) => typeof x === 'string' && x.length > 0));
    } else {
        skipSet = new Set(['/health', '/manifest']);
    }

    const sendError = (res, status, code, extra) => {
        try {
            if (res && typeof res.status === 'function' && typeof res.json === 'function') {
                res.status(status).json({ error: code, ...(extra || {}) });
                return;
            }
        } catch (_) { /* fall through */ }
        // Best-effort fallback for unusual res shapes in tests.
        try { res && typeof res.end === 'function' && res.end(); } catch (_) {}
    };

    return function novaSecurityMiddleware(req, res, next) {
        // Unknown/malformed req → defensive pass-through rather than
        // poisoning the Express error path. The downstream handlers
        // have their own guards.
        if (!req || typeof req !== 'object') {
            if (typeof next === 'function') next();
            return;
        }

        // `req.path` is the path relative to the router's mount point
        // when Express invokes the middleware, which is exactly what
        // the skip list uses. Fall back to `req.url` + strip query for
        // robustness against synthetic test requests.
        let relPath = typeof req.path === 'string' ? req.path : '';
        if (!relPath && typeof req.url === 'string') {
            relPath = req.url.split('?')[0] || '';
        }
        if (skipSet.has(relPath)) {
            if (typeof next === 'function') next();
            return;
        }

        // --- Session check ---
        if (sessionRequired) {
            const session = req.session;
            const headers = (req.headers && typeof req.headers === 'object') ? req.headers : {};
            const authHeader = typeof headers.authorization === 'string' ? headers.authorization : '';
            // SillyTavern mounts its Basic Auth middleware before cookie-session.
            // In that mode a request can be fully authenticated by ST but still
            // have no session handle/csrf slot yet. Because this middleware runs
            // after ST's Basic Auth gate, the presence of a Basic header here
            // means the request already passed the configured credential check.
            const hasBasicAuthPassThrough = /^Basic\s+/i.test(authHeader);
            const isValidSession = session
                && typeof session === 'object'
                // At least one of the slots ST populates must be present.
                // `handle` is ST's per-user slot; `csrfToken` exists after
                // the first GET that passed through csrf-sync. Either is
                // enough to prove the browser already holds a live ST
                // session cookie.
                && (typeof session.handle === 'string' || typeof session.csrfToken === 'string');
            if (!isValidSession && !hasBasicAuthPassThrough) {
                sendError(res, 401, 'nova-unauthorized', { hint: 'No valid SillyTavern session cookie or Basic Auth context on request.' });
                return;
            }
        }

        // --- CSRF check ---
        const method = typeof req.method === 'string' ? req.method.toUpperCase() : 'GET';
        if (csrfRequired && STATE_CHANGING_METHODS.has(method)) {
            const headers = (req.headers && typeof req.headers === 'object') ? req.headers : {};
            // Header names are case-insensitive in HTTP; Node normalises
            // them to lowercase on `req.headers`. Accept either the raw
            // header value or an array shape (some proxies coalesce).
            let headerToken = headers['x-csrf-token'];
            if (Array.isArray(headerToken)) headerToken = headerToken[0];
            const headerOk = typeof headerToken === 'string' && headerToken.length > 0;

            const sessionToken = req.session && typeof req.session.csrfToken === 'string'
                ? req.session.csrfToken
                : '';

            if (!headerOk) {
                sendError(res, 403, 'nova-csrf-missing', { hint: 'Missing x-csrf-token header.' });
                return;
            }
            if (!sessionToken) {
                // ST's csrfSync writes the token on first GET. If we
                // have a header but no session slot, the session is
                // stale — force a refresh.
                sendError(res, 403, 'nova-csrf-stale-session', { hint: 'No csrfToken in session; reload ST to mint a new one.' });
                return;
            }
            // Constant-time comparison guards against timing oracles.
            if (!constantTimeStringEqual(headerToken, sessionToken)) {
                sendError(res, 403, 'nova-csrf-mismatch', { hint: 'CSRF token does not match the session.' });
                return;
            }
        }

        if (typeof next === 'function') next();
    };
}

/**
 * Constant-time string equality. Not cryptographically perfect (V8
 * still makes length-dependent allocations), but good enough to
 * prevent the obvious "leak the token byte-by-byte via response
 * timing" attack. Never throws; returns false for any non-string
 * input to match the strict-equality fallback callers expect.
 */
function constantTimeStringEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}

module.exports = {
    buildNovaSecurityMiddleware,
    STATE_CHANGING_METHODS,
    // Exposed for unit tests.
    _internal: { constantTimeStringEqual },
};
