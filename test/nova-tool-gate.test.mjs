/**
 * Unit tests for Nova tool tier + approval gate (plan §3c precursor).
 * Run with: node --test test/nova-tool-gate.test.mjs
 *
 * Mirrors `novaToolGate` + `NOVA_TIERS` + `NOVA_PERMISSIONS` +
 * `_NOVA_TIER_ALLOWS` + `_novaRememberedApprovalsHas` from `index.js`
 * under the `/* === NOVA AGENT === *\/` section. Inline-copy
 * convention per AGENT_MEMORY — update this copy when the production
 * helper changes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// -------- Inline copy of the production helper --------

const NOVA_TIERS = Object.freeze(['read', 'write', 'full']);
const NOVA_PERMISSIONS = Object.freeze(['read', 'write', 'shell']);

const _NOVA_TIER_ALLOWS = {
    read: new Set(['read']),
    write: new Set(['read', 'write']),
    full: new Set(['read', 'write', 'shell']),
};

function _novaRememberedApprovalsHas(container, toolName) {
    if (!container || typeof toolName !== 'string' || !toolName) return false;
    if (container instanceof Set) return container.has(toolName);
    if (Array.isArray(container)) return container.includes(toolName);
    return false;
}

function novaToolGate({ permission, tier, toolName, rememberedApprovals } = {}) {
    const safeTier = NOVA_TIERS.includes(tier) ? tier : 'read';

    if (permission == null) {
        return { allowed: false, requiresApproval: false, reason: 'missing-permission' };
    }
    if (!NOVA_PERMISSIONS.includes(permission)) {
        return { allowed: false, requiresApproval: false, reason: 'unknown-permission' };
    }

    const allows = _NOVA_TIER_ALLOWS[safeTier];
    if (!allows.has(permission)) {
        return { allowed: false, requiresApproval: false, reason: 'tier-too-low' };
    }

    if (permission === 'read') {
        return { allowed: true, requiresApproval: false };
    }

    const preApproved = _novaRememberedApprovalsHas(rememberedApprovals, toolName);
    return { allowed: true, requiresApproval: !preApproved };
}

// -------- Tier × permission matrix (9 cells) --------

describe('novaToolGate — tier × permission matrix', () => {
    it('tier=read allows only read tools', () => {
        assert.deepEqual(novaToolGate({ permission: 'read', tier: 'read' }), { allowed: true, requiresApproval: false });
        assert.deepEqual(novaToolGate({ permission: 'write', tier: 'read' }), { allowed: false, requiresApproval: false, reason: 'tier-too-low' });
        assert.deepEqual(novaToolGate({ permission: 'shell', tier: 'read' }), { allowed: false, requiresApproval: false, reason: 'tier-too-low' });
    });

    it('tier=write allows read + write, denies shell', () => {
        assert.equal(novaToolGate({ permission: 'read', tier: 'write' }).allowed, true);
        assert.equal(novaToolGate({ permission: 'write', tier: 'write' }).allowed, true);
        const shell = novaToolGate({ permission: 'shell', tier: 'write' });
        assert.equal(shell.allowed, false);
        assert.equal(shell.reason, 'tier-too-low');
    });

    it('tier=full allows everything', () => {
        assert.equal(novaToolGate({ permission: 'read', tier: 'full' }).allowed, true);
        assert.equal(novaToolGate({ permission: 'write', tier: 'full' }).allowed, true);
        assert.equal(novaToolGate({ permission: 'shell', tier: 'full' }).allowed, true);
    });
});

// -------- Approval gating --------

describe('novaToolGate — approval gating', () => {
    it('read permission never requires approval', () => {
        for (const tier of NOVA_TIERS) {
            const out = novaToolGate({ permission: 'read', tier });
            assert.equal(out.allowed, true);
            assert.equal(out.requiresApproval, false, `tier=${tier}`);
        }
    });

    it('write permission requires approval by default', () => {
        const out = novaToolGate({ permission: 'write', tier: 'write', toolName: 'fs_write' });
        assert.deepEqual(out, { allowed: true, requiresApproval: true });
    });

    it('shell permission requires approval by default', () => {
        const out = novaToolGate({ permission: 'shell', tier: 'full', toolName: 'shell_run' });
        assert.deepEqual(out, { allowed: true, requiresApproval: true });
    });

    it('write permission skips approval when remembered via Set', () => {
        const remembered = new Set(['fs_write']);
        const out = novaToolGate({ permission: 'write', tier: 'write', toolName: 'fs_write', rememberedApprovals: remembered });
        assert.deepEqual(out, { allowed: true, requiresApproval: false });
    });

    it('write permission skips approval when remembered via Array', () => {
        const out = novaToolGate({ permission: 'write', tier: 'write', toolName: 'fs_write', rememberedApprovals: ['fs_write'] });
        assert.deepEqual(out, { allowed: true, requiresApproval: false });
    });

    it('shell permission skips approval when remembered', () => {
        const out = novaToolGate({ permission: 'shell', tier: 'full', toolName: 'shell_run', rememberedApprovals: new Set(['shell_run']) });
        assert.deepEqual(out, { allowed: true, requiresApproval: false });
    });

    it('remembered set for a DIFFERENT tool does not skip approval', () => {
        const out = novaToolGate({ permission: 'write', tier: 'write', toolName: 'fs_write', rememberedApprovals: new Set(['fs_delete']) });
        assert.equal(out.requiresApproval, true);
    });

    it('tier-denied tools never need approval (they won\'t run)', () => {
        // Even with a remembered pre-approval, a tier-denied call stays denied
        // and reports `requiresApproval:false` because the gate never gets
        // past the tier check.
        const out = novaToolGate({ permission: 'shell', tier: 'read', toolName: 'shell_run', rememberedApprovals: new Set(['shell_run']) });
        assert.deepEqual(out, { allowed: false, requiresApproval: false, reason: 'tier-too-low' });
    });

    it('missing toolName defeats the remembered-approvals bypass', () => {
        // Defensive: if the caller forgot to pass toolName, the gate must
        // fall back to "needs approval" rather than silently bypass.
        const out = novaToolGate({ permission: 'write', tier: 'write', rememberedApprovals: new Set(['fs_write']) });
        assert.equal(out.requiresApproval, true);
    });

    it('empty-string toolName defeats the remembered-approvals bypass', () => {
        const out = novaToolGate({ permission: 'write', tier: 'write', toolName: '', rememberedApprovals: new Set(['']) });
        assert.equal(out.requiresApproval, true);
    });
});

// -------- Defensive input handling --------

describe('novaToolGate — defensive inputs', () => {
    it('missing permission → denied with missing-permission', () => {
        const out = novaToolGate({ tier: 'full' });
        assert.deepEqual(out, { allowed: false, requiresApproval: false, reason: 'missing-permission' });
    });

    it('null permission → denied with missing-permission (not unknown-permission)', () => {
        const out = novaToolGate({ permission: null, tier: 'full' });
        assert.equal(out.reason, 'missing-permission');
    });

    it('unknown permission string → denied with unknown-permission', () => {
        const out = novaToolGate({ permission: 'nuclear', tier: 'full' });
        assert.deepEqual(out, { allowed: false, requiresApproval: false, reason: 'unknown-permission' });
    });

    it('malformed tier defaults to read (strictest)', () => {
        // tier 'FULL' (wrong case) must NOT be interpreted as 'full'
        const out = novaToolGate({ permission: 'write', tier: 'FULL' });
        assert.equal(out.allowed, false);
        assert.equal(out.reason, 'tier-too-low');
    });

    it('missing tier defaults to read', () => {
        const shell = novaToolGate({ permission: 'shell' });
        assert.equal(shell.allowed, false);
        assert.equal(shell.reason, 'tier-too-low');
        const read = novaToolGate({ permission: 'read' });
        assert.equal(read.allowed, true);
    });

    it('no opts at all → denied with missing-permission', () => {
        const out = novaToolGate();
        assert.deepEqual(out, { allowed: false, requiresApproval: false, reason: 'missing-permission' });
    });

    it('rememberedApprovals of wrong type is ignored (no crash, no bypass)', () => {
        for (const bad of [{}, 'fs_write', 42, true, Symbol('x')]) {
            const out = novaToolGate({ permission: 'write', tier: 'write', toolName: 'fs_write', rememberedApprovals: bad });
            assert.equal(out.allowed, true);
            assert.equal(out.requiresApproval, true, `rememberedApprovals=${String(bad)}`);
        }
    });

    it('rememberedApprovals null/undefined is fine', () => {
        assert.equal(novaToolGate({ permission: 'write', tier: 'write', toolName: 'fs_write', rememberedApprovals: null }).requiresApproval, true);
        assert.equal(novaToolGate({ permission: 'write', tier: 'write', toolName: 'fs_write', rememberedApprovals: undefined }).requiresApproval, true);
    });
});

// -------- Contract: no exceptions on any production tool × any tier --------

describe('novaToolGate — closed enum contract', () => {
    it('every (permission, tier) pair resolves to a well-shaped result', () => {
        for (const permission of NOVA_PERMISSIONS) {
            for (const tier of NOVA_TIERS) {
                const out = novaToolGate({ permission, tier, toolName: 'x' });
                assert.equal(typeof out.allowed, 'boolean');
                assert.equal(typeof out.requiresApproval, 'boolean');
                if (out.allowed) {
                    assert.equal(out.reason, undefined, `no reason when allowed; pair=(${permission},${tier})`);
                } else {
                    assert.equal(typeof out.reason, 'string', `reason required when denied; pair=(${permission},${tier})`);
                    assert.ok(['tier-too-low', 'unknown-permission', 'missing-permission'].includes(out.reason));
                }
            }
        }
    });

    it('NOVA_TIERS and NOVA_PERMISSIONS are frozen', () => {
        assert.ok(Object.isFrozen(NOVA_TIERS));
        assert.ok(Object.isFrozen(NOVA_PERMISSIONS));
    });
});

// -------- Integration: every registered NOVA_TOOLS permission is handled --------

describe('novaToolGate — NOVA_TOOLS coverage', () => {
    it('every permission value used in the NOVA_TOOLS registry is in NOVA_PERMISSIONS', async () => {
        const here = dirname(fileURLToPath(import.meta.url));
        const js = await readFile(resolve(here, '..', 'index.js'), 'utf8');
        // Match every `permission: '...'` inside NOVA_TOOLS entries.
        // We scope by extracting the NOVA_TOOLS block and then grabbing the string literals.
        const start = js.indexOf('const NOVA_TOOLS = [');
        assert.ok(start > 0, 'NOVA_TOOLS block must exist');
        // End heuristic: next top-level `];` after start.
        const rest = js.slice(start);
        const end = rest.indexOf('\n];');
        assert.ok(end > 0, 'NOVA_TOOLS block must close');
        const block = rest.slice(0, end);
        const found = new Set();
        for (const m of block.matchAll(/permission:\s*'([^']+)'/g)) {
            found.add(m[1]);
        }
        assert.ok(found.size > 0, 'NOVA_TOOLS must declare at least one tool with a permission');
        for (const p of found) {
            assert.ok(NOVA_PERMISSIONS.includes(p), `permission '${p}' used by NOVA_TOOLS but missing from NOVA_PERMISSIONS`);
        }
    });
});

// -------- Source-shape contract --------

describe('index.js source shape', () => {
    it('declares novaToolGate + NOVA_TIERS + NOVA_PERMISSIONS in the NOVA AGENT section', async () => {
        const here = dirname(fileURLToPath(import.meta.url));
        const js = await readFile(resolve(here, '..', 'index.js'), 'utf8');
        assert.match(js, /function\s+novaToolGate\s*\(/);
        assert.match(js, /const\s+NOVA_TIERS\s*=\s*Object\.freeze\(/);
        assert.match(js, /const\s+NOVA_PERMISSIONS\s*=\s*Object\.freeze\(/);
        assert.match(js, /const\s+_NOVA_TIER_ALLOWS\s*=/);
        assert.match(js, /function\s+_novaRememberedApprovalsHas\s*\(/);
    });

    it('gate helper lives between soul/memory loader and diff helper', async () => {
        const here = dirname(fileURLToPath(import.meta.url));
        const js = await readFile(resolve(here, '..', 'index.js'), 'utf8');
        const loaderIdx = js.indexOf('async function loadNovaSoulMemory(');
        const gateIdx = js.indexOf('function novaToolGate(');
        const diffIdx = js.indexOf('function buildNovaUnifiedDiff(');
        assert.ok(loaderIdx > 0 && gateIdx > 0 && diffIdx > 0);
        assert.ok(gateIdx > loaderIdx, 'gate must come after soul/memory loader');
        assert.ok(gateIdx < diffIdx, 'gate must come before diff helper');
    });
});
