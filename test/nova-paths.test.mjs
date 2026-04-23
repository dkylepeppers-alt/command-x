/**
 * Unit tests for nova-agent-bridge path safety (plan §8c, §13).
 * Run with: node --test test/nova-paths.test.mjs
 *
 * Mirrors `normalizeNovaPath` in `server-plugin/nova-agent-bridge/paths.js`.
 * Inline-copy per the AGENT_MEMORY convention — the plugin uses CommonJS
 * with `require('node:path')`, and while ESM can `import` CJS we keep the
 * copy inline here so the test file does not depend on the plugin directory
 * layout at load time (less test-setup surface for future agents).
 *
 * When you change `paths.js`, mirror the edit into this file or the test
 * goes stale-silently.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const DEFAULT_DENY_SEGMENTS = Object.freeze(['.git', 'node_modules']);
const DEFAULT_DENY_PAIRS = Object.freeze([['plugins', 'nova-agent-bridge']]);

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
    if (relNative === '') return { ok: true, absolute, relative: '' };
    if (relNative.startsWith('..') || path.isAbsolute(relNative)) {
        return { ok: false, reason: 'escape' };
    }

    const relPosix = relNative.split(path.sep).join('/');
    const segments = relPosix.split('/');
    const denySegments = Array.isArray(denyList?.segments) && denyList.segments.length > 0
        ? denyList.segments : DEFAULT_DENY_SEGMENTS;
    const denyPairs = Array.isArray(denyList?.pairs) && denyList.pairs.length > 0
        ? denyList.pairs : DEFAULT_DENY_PAIRS;

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

const ROOT = '/srv/sillytavern';

describe('normalizeNovaPath — input validation', () => {
    it('rejects missing root', () => {
        const r = normalizeNovaPath({ requestPath: 'a' });
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'invalid');
        assert.equal(r.detail, 'root-required');
    });

    it('rejects empty requestPath', () => {
        const r = normalizeNovaPath({ root: ROOT, requestPath: '' });
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'empty');
    });

    it('rejects non-string requestPath', () => {
        const r = normalizeNovaPath({ root: ROOT, requestPath: 123 });
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'empty');
    });

    it('rejects null-byte injection', () => {
        const r = normalizeNovaPath({ root: ROOT, requestPath: 'foo\0bar' });
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'invalid');
        assert.equal(r.detail, 'null-byte');
    });
});

describe('normalizeNovaPath — normalisation', () => {
    it('accepts a relative child path', () => {
        const r = normalizeNovaPath({ root: ROOT, requestPath: 'data/chats/foo.json' });
        assert.equal(r.ok, true);
        assert.equal(r.relative, 'data/chats/foo.json');
        assert.ok(r.absolute.endsWith(path.join('data', 'chats', 'foo.json')));
    });

    it('strips a leading / so absolute-looking paths are root-relative', () => {
        const r = normalizeNovaPath({ root: ROOT, requestPath: '/data/x.json' });
        assert.equal(r.ok, true);
        assert.equal(r.relative, 'data/x.json');
    });

    it('accepts Windows-style separators', () => {
        const r = normalizeNovaPath({ root: ROOT, requestPath: 'data\\chats\\foo.json' });
        assert.equal(r.ok, true);
        assert.equal(r.relative, 'data/chats/foo.json');
    });

    it('resolves ".." when it stays inside root', () => {
        const r = normalizeNovaPath({ root: ROOT, requestPath: 'data/chats/../characters/x.json' });
        assert.equal(r.ok, true);
        assert.equal(r.relative, 'data/characters/x.json');
    });

    it('returns empty relative for the root itself', () => {
        const r = normalizeNovaPath({ root: ROOT, requestPath: '.' });
        assert.equal(r.ok, true);
        assert.equal(r.relative, '');
    });
});

describe('normalizeNovaPath — escape detection', () => {
    it('rejects ".." that escapes root', () => {
        const r = normalizeNovaPath({ root: ROOT, requestPath: '../../etc/passwd' });
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'escape');
    });

    it('rejects deep ".." that escapes root', () => {
        const r = normalizeNovaPath({ root: ROOT, requestPath: 'data/../../etc/passwd' });
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'escape');
    });

    it('leading-/ + .. still gets escape-detected', () => {
        const r = normalizeNovaPath({ root: ROOT, requestPath: '/../other' });
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'escape');
    });
});

describe('normalizeNovaPath — deny-list', () => {
    it('denies a .git path', () => {
        const r = normalizeNovaPath({ root: ROOT, requestPath: '.git/HEAD' });
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'denied');
        assert.equal(r.detail, '.git');
    });

    it('denies a nested .git path', () => {
        const r = normalizeNovaPath({ root: ROOT, requestPath: 'data/.git/config' });
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'denied');
        assert.equal(r.detail, '.git');
    });

    it('denies node_modules subtrees', () => {
        const r = normalizeNovaPath({ root: ROOT, requestPath: 'node_modules/express/index.js' });
        assert.equal(r.ok, false);
        assert.equal(r.detail, 'node_modules');
    });

    it('denies plugins/nova-agent-bridge/** (two-segment pair)', () => {
        const r = normalizeNovaPath({ root: ROOT, requestPath: 'plugins/nova-agent-bridge/index.js' });
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'denied');
        assert.equal(r.detail, 'plugins/nova-agent-bridge');
    });

    it('allows a directory merely named "plugins" when the next segment is something else', () => {
        const r = normalizeNovaPath({ root: ROOT, requestPath: 'plugins/other-plugin/index.js' });
        assert.equal(r.ok, true);
    });

    it('does not partial-match deny segments (".gitlab" is fine)', () => {
        const r = normalizeNovaPath({ root: ROOT, requestPath: '.gitlab/file' });
        assert.equal(r.ok, true);
    });

    it('accepts a custom denyList.segments', () => {
        const r = normalizeNovaPath({
            root: ROOT,
            requestPath: 'secrets/x',
            denyList: { segments: ['secrets'] },
        });
        assert.equal(r.ok, false);
        assert.equal(r.detail, 'secrets');
    });
});
