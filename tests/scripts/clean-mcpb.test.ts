/**
 * @fileoverview Preserve dependency runtime skill modules while stripping package-root author docs.
 * @module tests/scripts/clean-mcpb.test
 */
import { describe, expect, it } from 'vitest';
import { filterAgentDocEntries } from '../../scripts/clean-mcpb.js';
import { AGENT_DOC_ENTRY } from '../../scripts/lint-packaging.js';

describe('bundle agent documentation selectors', () => {
  const docs = [
    'node_modules/example/skills/example/SKILL.md',
    'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
    'node_modules/example/.claude/config.json',
    'node_modules/example/node_modules/other/skills/read/SKILL.md',
    'node_modules/@scope/example/node_modules/@other/package/skills/read/SKILL.md',
  ];
  const runtime = [
    'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.js',
    'node_modules/@modelcontextprotocol/server/dist/ext/skills/loader.js',
    'node_modules/example/dist/skills/runtime.js',
    'skills/trade-workflow/SKILL.md',
  ];

  it('strips author docs and preserves runtime modules in the cleaner', () => {
    expect(filterAgentDocEntries([...docs, ...runtime])).toEqual(docs);
  });

  it('checks the same author-doc boundary in packaging lint', () => {
    expect([...docs, ...runtime].filter((entry) => AGENT_DOC_ENTRY.test(entry))).toEqual(docs);
  });
});
