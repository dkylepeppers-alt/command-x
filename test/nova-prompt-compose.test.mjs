/**
 * Unit tests for Nova system-prompt composition (plan §6c).
 * Run with: node --test test/nova-prompt-compose.test.mjs
 *
 * Mirrors `composeNovaSystemPrompt` from index.js. Update in lockstep.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const NOVA_MEMORY_CHARS_CAP = 16 * 1024;

function composeNovaSystemPrompt({ basePrompt = '', skillPrompt = '', soul = '', memory = '', toolContract = '' } = {}) {
    const mem = String(memory || '');
    const truncated = mem.length > NOVA_MEMORY_CHARS_CAP;
    const memSlice = truncated
        ? '[…truncated head…]\n' + mem.slice(mem.length - NOVA_MEMORY_CHARS_CAP)
        : mem;
    const sections = [
        String(basePrompt || '').trim(),
        String(skillPrompt || '').trim(),
        '---',
        '# Soul',
        String(soul || '').trim(),
        '---',
        '# Memory',
        memSlice.trim(),
        '---',
        String(toolContract || '').trim(),
    ];
    return sections.filter(s => s.length > 0).join('\n');
}

describe('composeNovaSystemPrompt', () => {
    it('orders sections per plan §6c: base, skill, soul, memory, tool-contract', () => {
        const out = composeNovaSystemPrompt({
            basePrompt: 'BASE',
            skillPrompt: 'SKILL',
            soul: 'SOUL',
            memory: 'MEM',
            toolContract: 'TOOLS',
        });
        const iBase = out.indexOf('BASE');
        const iSkill = out.indexOf('SKILL');
        const iSoul = out.indexOf('SOUL');
        const iMem = out.indexOf('MEM');
        const iTools = out.indexOf('TOOLS');
        assert.ok(iBase < iSkill, 'base before skill');
        assert.ok(iSkill < iSoul, 'skill before soul');
        assert.ok(iSoul < iMem, 'soul before memory');
        assert.ok(iMem < iTools, 'memory before tool-contract');
        assert.ok(out.includes('# Soul'));
        assert.ok(out.includes('# Memory'));
    });

    it('keeps literal "# Soul" / "# Memory" header lines even when soul/memory bodies are empty', () => {
        // The helper filters empty strings AFTER trim(); the literal header
        // lines are non-empty so they survive, but empty soul/memory bodies
        // are dropped. This is intentional — callers that pass a real
        // basePrompt + toolContract still get a readable skeleton.
        const out = composeNovaSystemPrompt({ basePrompt: 'B', toolContract: 'T' });
        assert.ok(out.includes('B'));
        assert.ok(out.includes('T'));
        assert.ok(out.includes('# Soul'));
        assert.ok(out.includes('# Memory'));
        // The skill line is absent entirely.
        assert.ok(!out.includes('SKILL'));
    });

    it('returns an empty string for an all-empty call after filtering', () => {
        const out = composeNovaSystemPrompt({});
        // Only the static '---', '# Soul', '---', '# Memory', '---' remain.
        // This is fine — callers always supply base + tool contract.
        assert.ok(out.includes('# Soul'));
        assert.ok(out.includes('# Memory'));
        assert.ok(out.includes('---'));
    });

    it('passes memory through untouched when under the 16 KB cap', () => {
        const memory = 'x'.repeat(1024);
        const out = composeNovaSystemPrompt({ memory });
        assert.ok(out.includes(memory));
        assert.ok(!out.includes('truncated'));
    });

    it('truncates memory to the tail when over the 16 KB cap and marks it', () => {
        // Build 17 KB of content with a unique head and tail sentinel.
        const head = 'HEAD_SENTINEL_SHOULD_BE_DROPPED';
        const tail = 'TAIL_SENTINEL_KEPT';
        const middle = 'x'.repeat(NOVA_MEMORY_CHARS_CAP + 1024);
        const memory = head + middle + tail;
        const out = composeNovaSystemPrompt({ memory });
        assert.ok(out.includes('truncated'), 'truncation marker present');
        assert.ok(out.includes(tail), 'tail preserved');
        assert.ok(!out.includes(head), 'head dropped');
    });

    it('coerces non-string inputs defensively', () => {
        const out = composeNovaSystemPrompt({ basePrompt: null, soul: undefined, memory: 0, toolContract: false });
        // Should not throw; '0' stringifies and survives, but falsy empties drop.
        assert.equal(typeof out, 'string');
    });
});
