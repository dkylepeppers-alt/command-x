/**
 * Tests for the §4b "Remember approvals this session" plumbing.
 * Run with: node --test test/nova-remember-approvals.test.mjs
 *
 * Verifies:
 *   1. The `rememberApprovalsSession` boolean is declared in
 *      `NOVA_SETTING_BINDINGS` and `NOVA_DEFAULTS`.
 *   2. Both DOM surfaces (settings.html + in-phone Settings → NOVA)
 *      expose a checkbox wired to one of the binding's `ids`.
 *   3. `novaHandleSend` threads a `Set<toolName>` through to
 *      `sendNovaTurn` via `rememberedApprovals`, and the approval
 *      composer mutates that Set on user approval.
 *   4. `saveSettings` clears the per-session approvals Set on a
 *      true→false toggle transition.
 *   5. `clearNovaSessionApprovedTools` and
 *      `getNovaSessionApprovedTools` exist as documented module-level
 *      helpers.
 *
 * Source-text assertions (not behavioural) per the AGENT_MEMORY
 * convention — `index.js` is browser-only and cannot be imported into
 * Node, so we read it as text and assert the wiring is in place.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

async function readRepo(rel) {
    return readFile(resolve(repoRoot, rel), 'utf8');
}

describe('§4b: rememberApprovalsSession setting wiring', () => {
    it('NOVA_DEFAULTS declares rememberApprovalsSession:false', async () => {
        const src = await readRepo('index.js');
        // The NOVA_DEFAULTS literal lives near the top of NOVA AGENT
        // section; we only need to confirm the key appears with a
        // boolean default.
        assert.match(src, /rememberApprovalsSession:\s*false/);
    });

    it('NOVA_SETTING_BINDINGS includes rememberApprovalsSession with both DOM ids', async () => {
        const src = await readRepo('index.js');
        const bindingsMatch = src.match(/const NOVA_SETTING_BINDINGS = \[[\s\S]*?\];/);
        assert.ok(bindingsMatch, 'NOVA_SETTING_BINDINGS array not found');
        const block = bindingsMatch[0];
        assert.match(block, /key:\s*'rememberApprovalsSession'/);
        assert.match(block, /type:\s*'bool'/);
        // Both surfaces must be wired (ST settings panel + in-phone Settings).
        assert.match(block, /'cx_nova_remember_approvals'/);
        assert.match(block, /'cx-set-nova-remember-approvals'/);
    });

    it('settings.html exposes a checkbox with the ST-side id', async () => {
        const src = await readRepo('settings.html');
        assert.match(src, /id="cx_nova_remember_approvals"/);
        assert.match(src, /type="checkbox"/);
    });

    it('in-phone Settings → NOVA exposes a toggle with the in-phone id', async () => {
        const src = await readRepo('index.js');
        // The in-phone toggle uses the cx-toggle pattern.
        assert.match(src, /id="cx-set-nova-remember-approvals"/);
        // And it lives under the NOVA section header.
        const novaSectionIdx = src.indexOf('<div class="cx-settings-section">NOVA</div>');
        assert.ok(novaSectionIdx > 0, 'NOVA settings section not found');
        const aboutSectionIdx = src.indexOf('<div class="cx-settings-section">ABOUT</div>', novaSectionIdx);
        assert.ok(aboutSectionIdx > novaSectionIdx, 'ABOUT section after NOVA not found');
        const novaSlice = src.slice(novaSectionIdx, aboutSectionIdx);
        assert.match(novaSlice, /id="cx-set-nova-remember-approvals"/);
    });

    it('the in-phone toggle is wired as a change listener', async () => {
        const src = await readRepo('index.js');
        assert.match(
            src,
            /querySelector\('#cx-set-nova-remember-approvals'\)\?\.addEventListener\('change'/,
        );
    });
});

describe('§4b: per-session approvals Set wiring', () => {
    it('module-level Set + accessor + clearer are declared', async () => {
        const src = await readRepo('index.js');
        assert.match(src, /const novaSessionApprovedTools = new Set\(\)/);
        assert.match(src, /function getNovaSessionApprovedTools\(\)/);
        assert.match(src, /function clearNovaSessionApprovedTools\(\)/);
    });

    it('novaHandleSend passes rememberedApprovals to sendNovaTurn', async () => {
        const src = await readRepo('index.js');
        // Find the novaHandleSend function and confirm rememberedApprovals
        // is passed to sendNovaTurn (gated by the setting).
        const fnStart = src.indexOf('async function novaHandleSend(');
        assert.ok(fnStart > 0, 'novaHandleSend not found');
        // Grab a generous slice to cover the full function.
        const slice = src.slice(fnStart, fnStart + 8000);
        assert.match(
            slice,
            /rememberedApprovals:\s*nova\.rememberApprovalsSession\s*\?\s*novaSessionApprovedTools\s*:\s*null/,
        );
    });

    it('the confirmApproval composer mutates the Set on user approval', async () => {
        const src = await readRepo('index.js');
        const fnStart = src.indexOf('async function novaHandleSend(');
        const slice = src.slice(fnStart, fnStart + 8000);
        // The composer should add the tool name only when (a) the user
        // clicked OK, (b) the toggle is on, and (c) the tool has a name.
        assert.match(slice, /novaSessionApprovedTools\.add\(String\(tool\.name\)\)/);
        assert.match(slice, /nova\.rememberApprovalsSession/);
    });

    it('saveSettings clears the Set on true→false toggle', async () => {
        const src = await readRepo('index.js');
        const fnStart = src.indexOf('function saveSettings()');
        assert.ok(fnStart > 0, 'saveSettings not found');
        const fnEnd = src.indexOf('\n}\n', fnStart);
        const slice = src.slice(fnStart, fnEnd);
        // Capture prior, then call the clearer when prior was true and
        // the new value is false.
        assert.match(slice, /priorRemember/);
        assert.match(slice, /clearNovaSessionApprovedTools\(\)/);
    });
});

describe('§4b: gate behavioural contract (inline copy)', () => {
    // Inline copy of the production gate helper (mirrors
    // `nova-tool-gate.test.mjs` convention) — verifies the Set
    // populated by the composer actually short-circuits approval.
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
        if (permission == null) return { allowed: false, requiresApproval: false, reason: 'missing-permission' };
        if (!NOVA_PERMISSIONS.includes(permission)) return { allowed: false, requiresApproval: false, reason: 'unknown-permission' };
        const allows = _NOVA_TIER_ALLOWS[safeTier];
        if (!allows.has(permission)) return { allowed: false, requiresApproval: false, reason: 'tier-too-low' };
        if (permission === 'read') return { allowed: true, requiresApproval: false };
        if (_novaRememberedApprovalsHas(rememberedApprovals, toolName)) {
            return { allowed: true, requiresApproval: false };
        }
        return { allowed: true, requiresApproval: true };
    }

    it('a tool present in the Set bypasses the approval modal', () => {
        const session = new Set(['fs_write']);
        const result = novaToolGate({
            permission: 'write',
            tier: 'write',
            toolName: 'fs_write',
            rememberedApprovals: session,
        });
        assert.equal(result.allowed, true);
        assert.equal(result.requiresApproval, false);
    });

    it('a tool absent from the Set still requires approval', () => {
        const session = new Set(['fs_write']);
        const result = novaToolGate({
            permission: 'write',
            tier: 'write',
            toolName: 'fs_delete',
            rememberedApprovals: session,
        });
        assert.equal(result.allowed, true);
        assert.equal(result.requiresApproval, true);
    });

    it('an empty / null Set acts like no remembered approvals', () => {
        const empty = novaToolGate({
            permission: 'shell',
            tier: 'full',
            toolName: 'shell_run',
            rememberedApprovals: new Set(),
        });
        assert.equal(empty.requiresApproval, true);
        const nul = novaToolGate({
            permission: 'shell',
            tier: 'full',
            toolName: 'shell_run',
            rememberedApprovals: null,
        });
        assert.equal(nul.requiresApproval, true);
    });

    it('reads never require approval, even with the Set empty', () => {
        const result = novaToolGate({
            permission: 'read',
            tier: 'read',
            toolName: 'fs_read',
            rememberedApprovals: null,
        });
        assert.equal(result.requiresApproval, false);
    });

    it('the Set does NOT bypass tier-too-low denial', () => {
        // Even if "fs_write" was previously approved, dropping the tier
        // back to 'read' must still deny the call.
        const session = new Set(['fs_write']);
        const result = novaToolGate({
            permission: 'write',
            tier: 'read',
            toolName: 'fs_write',
            rememberedApprovals: session,
        });
        assert.equal(result.allowed, false);
        assert.equal(result.reason, 'tier-too-low');
    });
});
