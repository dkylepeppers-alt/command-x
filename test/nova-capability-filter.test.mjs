/**
 * Unit tests for the Nova tool-capability filter (plan §4f).
 * Run with: node --test test/nova-capability-filter.test.mjs
 *
 * Inline-copies the pure helper per the repo's standing convention
 * (see AGENT_MEMORY) — `index.js` is an ST-bound module that cannot
 * be imported from node:test.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ------- Inline helper copy (mirrors index.js NOVA AGENT section) -------

const NOVA_BRIDGE_TOOL_PREFIXES = Object.freeze(['fs_', 'shell_']);

function _isBridgeBackedToolName(name) {
    if (typeof name !== 'string') return false;
    for (const p of NOVA_BRIDGE_TOOL_PREFIXES) {
        if (name.startsWith(p)) return true;
    }
    return false;
}

function filterNovaToolsByCapabilities({ tools, probe } = {}) {
    if (!Array.isArray(tools)) return [];
    if (!probe || typeof probe !== 'object' || Array.isArray(probe)) {
        return tools.slice();
    }
    if (probe.present === false) {
        return tools.filter((t) => !_isBridgeBackedToolName(t && t.name));
    }
    const caps = (probe.capabilities && typeof probe.capabilities === 'object' && !Array.isArray(probe.capabilities))
        ? probe.capabilities
        : null;
    if (!caps) return tools.slice();
    return tools.filter((t) => {
        const name = t && t.name;
        if (typeof name !== 'string') return false;
        if (!_isBridgeBackedToolName(name)) return true;
        return caps[name] !== false;
    });
}

// Representative tool-registry shape (matches NOVA_TOOLS keys we care about).
const SAMPLE_TOOLS = Object.freeze([
    { name: 'nova_write_soul' },
    { name: 'nova_append_memory' },
    { name: 'phone_list_npcs' },
    { name: 'phone_write_quest' },
    { name: 'st_list_characters' },
    { name: 'st_get_context' },
    { name: 'fs_list' },
    { name: 'fs_read' },
    { name: 'fs_write' },
    { name: 'fs_delete' },
    { name: 'fs_search' },
    { name: 'shell_run' },
]);

// ------- Tests --------------------------------------------------------

describe('filterNovaToolsByCapabilities — no probe / fail-open', () => {
    it('returns the input list unchanged when probe is undefined', () => {
        const out = filterNovaToolsByCapabilities({ tools: SAMPLE_TOOLS });
        assert.equal(out.length, SAMPLE_TOOLS.length);
        assert.deepEqual(out.map(t => t.name), SAMPLE_TOOLS.map(t => t.name));
    });

    it('returns unchanged when probe is null', () => {
        const out = filterNovaToolsByCapabilities({ tools: SAMPLE_TOOLS, probe: null });
        assert.equal(out.length, SAMPLE_TOOLS.length);
    });

    it('returns unchanged when probe is not an object (primitive, array)', () => {
        for (const bad of [42, 'str', true, false, []]) {
            const out = filterNovaToolsByCapabilities({ tools: SAMPLE_TOOLS, probe: bad });
            assert.equal(out.length, SAMPLE_TOOLS.length,
                `probe=${JSON.stringify(bad)} must fail open`);
        }
    });

    it('returns a fresh array (input not mutated; reference differs)', () => {
        const out = filterNovaToolsByCapabilities({ tools: SAMPLE_TOOLS });
        assert.notEqual(out, SAMPLE_TOOLS);
        assert.equal(SAMPLE_TOOLS.length, 12, 'input length must not change');
    });
});

describe('filterNovaToolsByCapabilities — probe.present: false', () => {
    it('drops every fs_* and shell_* tool', () => {
        const out = filterNovaToolsByCapabilities({
            tools: SAMPLE_TOOLS, probe: { present: false },
        });
        const names = out.map(t => t.name);
        assert.deepEqual(names, [
            'nova_write_soul',
            'nova_append_memory',
            'phone_list_npcs',
            'phone_write_quest',
            'st_list_characters',
            'st_get_context',
        ]);
        for (const n of names) {
            assert.ok(!n.startsWith('fs_') && !n.startsWith('shell_'),
                `leaked bridge-backed tool: ${n}`);
        }
    });

    it('keeps all non-bridge tools even if a stale capabilities map is present', () => {
        // Real-world shape from the extension's `_coerceNovaCapabilities`
        // — the probe might carry a capabilities map even after marking
        // present: false (e.g. after a network flake). present: false
        // is authoritative.
        const out = filterNovaToolsByCapabilities({
            tools: SAMPLE_TOOLS,
            probe: { present: false, capabilities: { fs_list: true } },
        });
        assert.ok(out.every(t => !t.name.startsWith('fs_')));
        assert.ok(out.every(t => !t.name.startsWith('shell_')));
        assert.ok(out.some(t => t.name === 'nova_write_soul'));
    });

    it('returns [] when every tool is bridge-backed', () => {
        const onlyBridge = [{ name: 'fs_list' }, { name: 'shell_run' }];
        const out = filterNovaToolsByCapabilities({
            tools: onlyBridge, probe: { present: false },
        });
        assert.deepEqual(out, []);
    });

    it('returns everything when no tool is bridge-backed', () => {
        const onlyLocal = [{ name: 'nova_write_soul' }, { name: 'phone_list_npcs' }];
        const out = filterNovaToolsByCapabilities({
            tools: onlyLocal, probe: { present: false },
        });
        assert.deepEqual(out.map(t => t.name), ['nova_write_soul', 'phone_list_npcs']);
    });
});

describe('filterNovaToolsByCapabilities — probe.present: true with capabilities', () => {
    it('drops only tools whose capability key is explicitly false', () => {
        const out = filterNovaToolsByCapabilities({
            tools: SAMPLE_TOOLS,
            probe: {
                present: true,
                capabilities: {
                    fs_list: true, fs_read: true, fs_write: true,
                    fs_delete: true, fs_search: true,
                    shell_run: false, // shell disabled on this install
                },
            },
        });
        const names = out.map(t => t.name);
        assert.ok(names.includes('fs_list'));
        assert.ok(names.includes('fs_read'));
        assert.ok(!names.includes('shell_run'), 'shell_run must be filtered when capability is false');
        assert.ok(names.includes('nova_write_soul'));
    });

    it('unknown bridge-backed tools pass through (forward-compat: capabilities-light plugin)', () => {
        // The installed plugin is older than the extension and doesn't
        // know about `fs_search` / `fs_delete`. The extension must not
        // strip them — let the plugin return 404/501 if it really
        // doesn't implement them. This keeps upgrade order flexible.
        const out = filterNovaToolsByCapabilities({
            tools: SAMPLE_TOOLS,
            probe: {
                present: true,
                capabilities: {
                    fs_list: true, fs_read: true, fs_write: true,
                    // fs_search, fs_delete, shell_run not mentioned
                },
            },
        });
        const names = out.map(t => t.name);
        assert.ok(names.includes('fs_search'), 'unlisted fs_search must pass through');
        assert.ok(names.includes('fs_delete'), 'unlisted fs_delete must pass through');
        assert.ok(names.includes('shell_run'), 'unlisted shell_run must pass through');
    });

    it('capabilities with all-false values drops everything bridge-backed', () => {
        const out = filterNovaToolsByCapabilities({
            tools: SAMPLE_TOOLS,
            probe: {
                present: true,
                capabilities: {
                    fs_list: false, fs_read: false, fs_write: false,
                    fs_delete: false, fs_search: false, shell_run: false,
                },
            },
        });
        const names = out.map(t => t.name);
        assert.ok(!names.some(n => n.startsWith('fs_')));
        assert.ok(!names.some(n => n.startsWith('shell_')));
        assert.ok(names.includes('nova_write_soul'));
        assert.ok(names.includes('st_list_characters'));
    });

    it('non-bridge tools are never gated by capabilities map', () => {
        // Even if the plugin (wrongly) advertises phone_foo: false, we
        // ignore it — phone_* / nova_* / st_* run in-process and the
        // plugin has no jurisdiction over them.
        const out = filterNovaToolsByCapabilities({
            tools: SAMPLE_TOOLS,
            probe: {
                present: true,
                capabilities: {
                    nova_write_soul: false,
                    phone_list_npcs: false,
                    st_list_characters: false,
                },
            },
        });
        const names = out.map(t => t.name);
        assert.ok(names.includes('nova_write_soul'));
        assert.ok(names.includes('phone_list_npcs'));
        assert.ok(names.includes('st_list_characters'));
    });

    it('no capabilities map but present: true → fail open (return all)', () => {
        // Older plugin version that doesn't include the capabilities
        // block. Trust it and let individual routes answer 404/501 if
        // they're not implemented.
        const out = filterNovaToolsByCapabilities({
            tools: SAMPLE_TOOLS, probe: { present: true },
        });
        assert.equal(out.length, SAMPLE_TOOLS.length);
    });

    it('capabilities must be a plain object; arrays and primitives are ignored', () => {
        for (const bad of [null, [], [1, 2], 42, 'str']) {
            const out = filterNovaToolsByCapabilities({
                tools: SAMPLE_TOOLS, probe: { present: true, capabilities: bad },
            });
            assert.equal(out.length, SAMPLE_TOOLS.length,
                `capabilities=${JSON.stringify(bad)} must not shrink the list`);
        }
    });

    it('truthy non-true probe.present still takes the "present" branch (liberal accept)', () => {
        const out = filterNovaToolsByCapabilities({
            tools: SAMPLE_TOOLS,
            probe: { present: 1, capabilities: { shell_run: false } },
        });
        const names = out.map(t => t.name);
        assert.ok(!names.includes('shell_run'), 'truthy non-true present should still filter');
        assert.equal(names.length, SAMPLE_TOOLS.length - 1);
    });
});

describe('filterNovaToolsByCapabilities — defensive / never-throws', () => {
    it('returns [] for non-array tools', () => {
        for (const bad of [null, undefined, 'str', 42, {}, true]) {
            assert.deepEqual(
                filterNovaToolsByCapabilities({ tools: bad, probe: { present: false } }),
                [],
                `tools=${JSON.stringify(bad)} must normalise to []`,
            );
        }
    });

    it('tolerates malformed tool entries without crashing', () => {
        const junk = [
            null, undefined, 'string', 42, [], true,
            {}, { name: null }, { name: 42 }, { name: [] },
            { name: 'fs_list' }, { name: 'nova_ok' },
        ];
        // Contract: the call never throws. Malformed entries pass
        // through the present:false branch (their name isn't a string
        // so `_isBridgeBackedToolName` returns false and they're kept)
        // — only the well-formed fs_list is stripped. The LLM tool-
        // schema validator downstream will reject the junk entries,
        // but this helper's job is only "don't crash, don't advertise
        // bridge tools when bridge is absent".
        const out = filterNovaToolsByCapabilities({
            tools: junk, probe: { present: false },
        });
        // fs_list removed; nova_ok retained; malformed entries kept as-is.
        const names = out.map(t => (t && typeof t === 'object' && 'name' in t) ? t.name : '<malformed>');
        assert.ok(names.includes('nova_ok'));
        assert.ok(!names.includes('fs_list'));
        assert.equal(out.length, junk.length - 1,
            'exactly one entry (fs_list) should be filtered; malformed pass through');
    });

    it('handles extreme fuzz input for probe without throwing', () => {
        const probes = [
            undefined, null, {}, [], 'string', 42, true, false,
            { present: true }, { present: false }, { present: null },
            { capabilities: null }, { capabilities: 'str' },
            { present: true, capabilities: { fs_list: 'yes' } },
            { present: true, capabilities: { fs_list: 0, shell_run: '' } },
            Object.freeze({ present: true, capabilities: Object.freeze({ fs_list: true }) }),
        ];
        for (const p of probes) {
            assert.doesNotThrow(() => {
                const r = filterNovaToolsByCapabilities({ tools: SAMPLE_TOOLS, probe: p });
                assert.ok(Array.isArray(r));
            }, `probe=${JSON.stringify(p)} must not throw`);
        }
    });

    it('truthy (non-boolean) capability values are treated as "present" (only explicit false strips)', () => {
        // Spec: the filter strips only on `caps[name] === false`. So
        // caps[name] = 0, '', null, undefined (missing), or any
        // non-false value keeps the tool. This matches the "forward-
        // compat / fail open" stance.
        const out = filterNovaToolsByCapabilities({
            tools: [{ name: 'fs_list' }, { name: 'fs_read' }, { name: 'fs_write' }],
            probe: {
                present: true,
                capabilities: { fs_list: 0, fs_read: '', fs_write: null },
            },
        });
        // 0, '', null are all !== false → all three pass.
        assert.equal(out.length, 3);
    });

    it('empty tool array → empty result for any probe', () => {
        for (const p of [undefined, { present: false }, { present: true, capabilities: {} }]) {
            assert.deepEqual(filterNovaToolsByCapabilities({ tools: [], probe: p }), []);
        }
    });
});
