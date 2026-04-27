/**
 * Unit tests for Nova tool-registry + skills schema (plan §4, §5, §10).
 * Run with: node --test test/nova-tool-args.test.mjs
 *
 * These tests validate the STRUCTURAL invariants of NOVA_TOOLS and
 * NOVA_SKILLS so that Phase 3b/3c can rely on the schemas being
 * well-formed before any LLM sees them. They do NOT execute tools.
 *
 * Mirrors the arrays from index.js by parsing the source and extracting
 * the literal arrays — this avoids duplicating ~400 lines of tool metadata
 * in the test file and keeps a single source of truth. If the arrays ever
 * drift out of the simple `const NAME = [ ... ];` top-level form, this
 * loader will have to be adapted.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(__dirname, '..', 'index.js'), 'utf8');

/**
 * Pull the text of a top-level `const NAME = [ ... ];` array literal out of
 * the source and eval it in an isolated Function scope.
 *
 * Safety notes:
 * - The source is `index.js` from THIS repository, read by the test harness
 *   at test time. It is not user input, not fetched over the network, and
 *   not controlled by any attacker-reachable channel.
 * - The eval'd scope is a fresh Function closure with no `this` binding;
 *   the literal can only reference global identifiers that would already
 *   be available to any `node --test` file (Object, Array, RegExp, etc.).
 * - If a future `NOVA_TOOLS` entry ever holds a live function reference
 *   (e.g. a real `handler`), this loader will explode at eval time — that
 *   is the signal to split the registry into a JSON-serialisable metadata
 *   array (read by this test) and a separate handlers map (runtime-only).
 */
function extractArrayLiteral(name) {
    const needle = `const ${name} = [`;
    const start = SOURCE.indexOf(needle);
    assert.ok(start !== -1, `could not find ${name} in index.js`);
    // Walk forward counting brackets to find the matching ];
    let depth = 0;
    let i = start + needle.length - 1; // position of '['
    for (; i < SOURCE.length; i++) {
        const ch = SOURCE[i];
        if (ch === '[') depth++;
        else if (ch === ']') {
            depth--;
            if (depth === 0) { i++; break; }
        }
    }
    const literal = SOURCE.slice(start + `const ${name} = `.length, i);
    // eslint-disable-next-line no-new-func
    return Function(`"use strict"; return (${literal});`)();
}

const NOVA_TOOLS = extractArrayLiteral('NOVA_TOOLS');
const NOVA_SKILLS = extractArrayLiteral('NOVA_SKILLS');
const NOVA_TOOL_NAMES = new Set(NOVA_TOOLS.map(t => t.name));

const VALID_PERMISSIONS = new Set(['read', 'write', 'shell']);
const VALID_BACKENDS = new Set(['plugin', 'st-api', 'phone']);
const VALID_TIERS = new Set(['read', 'write', 'full']);

describe('NOVA_TOOLS — structural invariants', () => {
    it('is a non-empty array', () => {
        assert.ok(Array.isArray(NOVA_TOOLS));
        assert.ok(NOVA_TOOLS.length > 0);
    });

    it('every tool has the required top-level shape', () => {
        for (const tool of NOVA_TOOLS) {
            assert.equal(typeof tool.name, 'string', `name: ${JSON.stringify(tool)}`);
            assert.ok(tool.name.length > 0);
            assert.equal(typeof tool.displayName, 'string');
            assert.equal(typeof tool.description, 'string');
            assert.ok(VALID_PERMISSIONS.has(tool.permission), `invalid permission on ${tool.name}: ${tool.permission}`);
            assert.ok(VALID_BACKENDS.has(tool.backend), `invalid backend on ${tool.name}: ${tool.backend}`);
            assert.equal(typeof tool.parameters, 'object');
        }
    });

    it('tool names are unique (no collisions)', () => {
        const seen = new Set();
        for (const tool of NOVA_TOOLS) {
            assert.ok(!seen.has(tool.name), `duplicate tool name: ${tool.name}`);
            seen.add(tool.name);
        }
    });

    it('tool names use snake_case and start with a letter', () => {
        const re = /^[a-z][a-z0-9_]*$/;
        for (const tool of NOVA_TOOLS) {
            assert.match(tool.name, re, `bad name format: ${tool.name}`);
        }
    });

    it('every parameter schema is a JSON-Schema object with properties', () => {
        for (const tool of NOVA_TOOLS) {
            const p = tool.parameters;
            assert.equal(p.type, 'object', `${tool.name}: parameters.type must be 'object'`);
            assert.equal(typeof p.properties, 'object', `${tool.name}: parameters.properties missing`);
            // additionalProperties must be explicitly false to prevent LLM hallucination.
            assert.equal(p.additionalProperties, false, `${tool.name}: set additionalProperties:false`);
        }
    });

    it('required fields in each schema actually exist in properties', () => {
        for (const tool of NOVA_TOOLS) {
            const p = tool.parameters;
            if (!Array.isArray(p.required)) continue;
            for (const key of p.required) {
                assert.ok(
                    Object.prototype.hasOwnProperty.call(p.properties, key),
                    `${tool.name}: required key '${key}' missing from properties`
                );
            }
        }
    });

    it('every property has a type, and enum/default values agree with type', () => {
        const validJsonTypes = new Set(['string', 'integer', 'number', 'boolean', 'object', 'array']);
        for (const tool of NOVA_TOOLS) {
            for (const [key, schema] of Object.entries(tool.parameters.properties)) {
                assert.ok(validJsonTypes.has(schema.type), `${tool.name}.${key}: bad type ${schema.type}`);
                if (schema.enum) {
                    assert.ok(Array.isArray(schema.enum) && schema.enum.length > 0);
                    if (schema.default !== undefined) {
                        assert.ok(schema.enum.includes(schema.default), `${tool.name}.${key}: default not in enum`);
                    }
                }
                if (schema.type === 'integer' && schema.default !== undefined) {
                    assert.equal(typeof schema.default, 'number');
                    assert.ok(Number.isInteger(schema.default));
                }
            }
        }
    });

    it('only "shell" permission is used by backend:"plugin" shell tools', () => {
        for (const tool of NOVA_TOOLS) {
            if (tool.permission === 'shell') {
                assert.equal(tool.backend, 'plugin', `${tool.name}: shell permission must be plugin-backed`);
            }
        }
    });
});

describe('NOVA_SKILLS — structural invariants', () => {
    it('is a non-empty array', () => {
        assert.ok(Array.isArray(NOVA_SKILLS));
        assert.ok(NOVA_SKILLS.length >= 4, 'expect at least the 4 plan skills');
    });

    it('every skill has the required shape', () => {
        for (const skill of NOVA_SKILLS) {
            assert.equal(typeof skill.id, 'string');
            assert.ok(skill.id.length > 0);
            assert.equal(typeof skill.label, 'string');
            assert.equal(typeof skill.icon, 'string');
            assert.equal(typeof skill.description, 'string');
            assert.ok(skill.description.length > 0, `${skill.id}: missing picker description`);
            assert.equal(typeof skill.systemPrompt, 'string');
            assert.ok(skill.systemPrompt.length > 0);
            assert.ok(VALID_TIERS.has(skill.defaultTier), `bad tier on ${skill.id}: ${skill.defaultTier}`);
            assert.equal(typeof skill.allowTierEscalation, 'boolean');
        }
    });

    it('skill ids are unique', () => {
        const seen = new Set();
        for (const skill of NOVA_SKILLS) {
            assert.ok(!seen.has(skill.id), `duplicate skill id: ${skill.id}`);
            seen.add(skill.id);
        }
    });

    it('defaultTools is either "all" or an array of known tool names', () => {
        for (const skill of NOVA_SKILLS) {
            if (skill.defaultTools === 'all') continue;
            assert.ok(Array.isArray(skill.defaultTools), `${skill.id}: bad defaultTools`);
            for (const toolName of skill.defaultTools) {
                assert.ok(
                    NOVA_TOOL_NAMES.has(toolName),
                    `${skill.id} references unknown tool: ${toolName}`
                );
            }
        }
    });

    it('every plan-specified skill id is present', () => {
        const ids = new Set(NOVA_SKILLS.map(s => s.id));
        for (const required of [
            'character-creator',
            'worldbook-creator',
            'stscript-regex',
            'image-prompter',
            'quest-designer',
            'npc-contact-manager',
            'map-location-designer',
            'lore-auditor',
            'prompt-doctor',
            'freeform',
        ]) {
            assert.ok(ids.has(required), `missing required skill: ${required}`);
        }
    });

    it('runtime filters exposed tools through each skill defaultTools list', () => {
        assert.match(SOURCE, /function filterNovaToolsBySkill\(/,
            'filterNovaToolsBySkill helper must exist');
        assert.match(SOURCE, /effectiveTools\s*=\s*filterNovaToolsBySkill\(\s*\{\s*tools:\s*effectiveTools,\s*skill:\s*activeSkill\s*\}\s*\)/,
            'novaHandleSend must apply active-skill tool filtering after capability filtering');

        const allToolNames = NOVA_TOOLS.map(t => t.name);
        for (const skill of NOVA_SKILLS) {
            const exposed = skill.defaultTools === 'all'
                ? allToolNames
                : allToolNames.filter(name => skill.defaultTools.includes(name));
            if (skill.defaultTools !== 'all') {
                assert.deepEqual(new Set(exposed), new Set(skill.defaultTools),
                    `${skill.id}: exposed tools must exactly match defaultTools`);
            }
        }
    });

    it('skill prompts include the current safety and quality requirements', () => {
        // Intentional source-contract test: these prompt phrases are brittle by
        // design so a future semantic rewrite forces a conscious test update.
        const byId = Object.fromEntries(NOVA_SKILLS.map(s => [s.id, s.systemPrompt]));
        const requirements = {
            'character-creator': ['st_list_characters', 'alternate greetings', 'mes_example', 'avatar_prompt', 'duplicate'],
            'worldbook-creator': ['read → merge → validate → write', 'keysecondary', 'token budget', 'constant entries', 'selective'],
            'stscript-regex': ['mandatory before any save', 'Quick Reply', 'lookarounds', 'catastrophically backtrack'],
            'image-prompter': ['scene_summary', 'SDXL', 'Flux', 'Illustrious', 'negative'],
            'quest-designer': ['phone_list_quests', 'phone_write_quest', 'subtasks'],
            'npc-contact-manager': ['phone_list_npcs', 'phone_write_npc', 'phone_inject_message'],
            'map-location-designer': ['phone_list_places', 'phone_write_place', 'occupants'],
            'lore-auditor': ['contradictions', 'worldbooks', 'Do not write'],
            'prompt-doctor': ['conflicting instructions', 'smallest safe improvement', 'approval diff'],
        };
        for (const [id, needles] of Object.entries(requirements)) {
            assert.ok(byId[id], `missing skill prompt for ${id}`);
            for (const needle of needles) {
                assert.ok(byId[id].includes(needle), `${id}: missing prompt requirement ${needle}`);
            }
        }
    });
});

describe('SKILLS_VERSION', () => {
    it('is declared as the current skill prompt generation', () => {
        const m = SOURCE.match(/const SKILLS_VERSION\s*=\s*(\d+)\s*;/);
        assert.ok(m, 'SKILLS_VERSION constant not found');
        const v = Number(m[1]);
        assert.ok(Number.isInteger(v) && v > 0);
        assert.equal(v, 3, 'bump SKILLS_VERSION when skill prompts, defaultTools, or defaultTier change');
    });
});
