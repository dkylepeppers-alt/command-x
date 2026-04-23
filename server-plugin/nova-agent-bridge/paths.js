/**
 * nova-agent-bridge — path safety helpers.
 *
 * Pure CommonJS module (no Express, no fs, no side-effects on require). This
 * is the gatekeeper for every filesystem route in the plugin — resolve a
 * user-supplied path against the configured root, verify it doesn't escape,
 * and check it against the static deny-list. Symlink-escape protection (which
 * needs `fs.realpath`) is layered on top at request-time, not here.
 *
 * Mirrors plan §8c. Exports:
 *   - DEFAULT_DENY_SEGMENTS / DEFAULT_DENY_PAIRS
 *   - normalizeNovaPath({ root, requestPath, denyList? })
 *
 * Kept dependency-free so it can be inline-copied into
 * `test/nova-paths.test.mjs` without pulling the whole plugin surface.
 */

'use strict';

const path = require('node:path');

/**
 * Default deny-list (plan §8c). Single-name segments: if any path component
 * equals one of these, the request is denied regardless of depth.
 */
const DEFAULT_DENY_SEGMENTS = Object.freeze([
    '.git',
    'node_modules',
]);

/**
 * Two-segment pairs: only denied when the two names appear consecutively.
 * Used for the plugin-folder self-protection rule without locking out
 * unrelated directories that happen to be named `plugins` somewhere else.
 */
const DEFAULT_DENY_PAIRS = Object.freeze([
    ['plugins', 'nova-agent-bridge'],
]);

/**
 * Normalise and validate a request-supplied path against a root directory.
 *
 * Returns an object; callers branch on `ok`:
 *   { ok: true,  absolute: string, relative: string }
 *   { ok: false, reason: 'empty' | 'escape' | 'denied' | 'invalid', detail?: string }
 *
 * `absolute` is a clean, OS-native path ready for fs ops. `relative` is
 * POSIX-style ('/'-separated) so it can be returned to the browser
 * regardless of host OS.
 *
 * Behaviour:
 * - Empty / non-string input → `{ ok: false, reason: 'empty' }`.
 * - `requestPath` may be POSIX or Windows style; both separators accepted.
 * - Leading `/` stripped so `"/foo"` is treated as relative-to-root.
 * - `..` segments permitted as long as the final resolution stays inside
 *   the root. Escape attempts return `{ ok: false, reason: 'escape' }`.
 * - A Windows drive-letter path that resolves outside the root also
 *   returns `escape` via the containment check.
 * - Null bytes → `invalid`.
 * - Deny-list runs on the resolved relative path split on '/'.
 */
function normalizeNovaPath({ root, requestPath, denyList } = {}) {
    if (typeof root !== 'string' || root.length === 0) {
        return { ok: false, reason: 'invalid', detail: 'root-required' };
    }
    if (typeof requestPath !== 'string' || requestPath.length === 0) {
        return { ok: false, reason: 'empty' };
    }
    if (requestPath.indexOf('\0') !== -1) {
        return { ok: false, reason: 'invalid', detail: 'null-byte' };
    }

    const stripped = requestPath.replace(/\\/g, '/').replace(/^\/+/, '');
    const rootAbs = path.resolve(root);
    const absolute = path.resolve(rootAbs, stripped);

    const relNative = path.relative(rootAbs, absolute);
    if (relNative === '') {
        return { ok: true, absolute, relative: '' };
    }
    if (relNative.startsWith('..') || path.isAbsolute(relNative)) {
        return { ok: false, reason: 'escape' };
    }

    const relPosix = relNative.split(path.sep).join('/');
    const segments = relPosix.split('/');
    const denySegments = Array.isArray(denyList?.segments) && denyList.segments.length > 0
        ? denyList.segments
        : DEFAULT_DENY_SEGMENTS;
    const denyPairs = Array.isArray(denyList?.pairs) && denyList.pairs.length > 0
        ? denyList.pairs
        : DEFAULT_DENY_PAIRS;

    for (const seg of segments) {
        if (denySegments.includes(seg)) {
            return { ok: false, reason: 'denied', detail: seg };
        }
    }
    for (const pair of denyPairs) {
        if (!Array.isArray(pair) || pair.length !== 2) continue;
        for (let i = 0; i <= segments.length - 2; i++) {
            if (segments[i] === pair[0] && segments[i + 1] === pair[1]) {
                return { ok: false, reason: 'denied', detail: pair.join('/') };
            }
        }
    }

    return { ok: true, absolute, relative: relPosix };
}

module.exports = {
    DEFAULT_DENY_SEGMENTS,
    DEFAULT_DENY_PAIRS,
    normalizeNovaPath,
};
