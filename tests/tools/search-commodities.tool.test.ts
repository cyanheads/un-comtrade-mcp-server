/**
 * @fileoverview Tests for the search-commodities tool.
 * @module tests/tools/search-commodities.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { searchCommoditiesTool } from '@/mcp-server/tools/definitions/search-commodities.tool.js';
import {
  type ComtradeReferenceService,
  initComtradeReferenceService,
} from '@/services/comtrade-reference/comtrade-reference-service.js';

const mockConfig = {} as Parameters<typeof initComtradeReferenceService>[0];
const mockStorage = {} as Parameters<typeof initComtradeReferenceService>[1];

function seedReferenceService(): ComtradeReferenceService {
  const svc = initComtradeReferenceService(mockConfig, mockStorage);
  // @ts-expect-error — seeding private map
  svc.hsByCode = new Map([
    [
      '84',
      {
        id: '84',
        text: 'Nuclear reactors, boilers, machinery and mechanical appliances; parts thereof',
        aggrLevel: 2 as const,
        isLeaf: false,
        recommendedQueryCode: '84',
      },
    ],
    [
      '8471',
      {
        id: '8471',
        text: 'Automatic data processing machines and units thereof',
        aggrLevel: 4 as const,
        parent: '84',
        isLeaf: false,
        recommendedQueryCode: '8471',
      },
    ],
    [
      '847130',
      {
        id: '847130',
        text: 'Portable automatic data processing machines, weighing not more than 10 kg',
        aggrLevel: 6 as const,
        parent: '8471',
        isLeaf: true,
        recommendedQueryCode: '847130',
      },
    ],
    [
      '09',
      {
        id: '09',
        text: 'Coffee, tea, mate and spices',
        aggrLevel: 2 as const,
        isLeaf: false,
        recommendedQueryCode: '09',
      },
    ],
  ]);
  return svc;
}

describe('searchCommoditiesTool', () => {
  beforeEach(() => {
    seedReferenceService();
  });

  it('finds commodities by keyword', () => {
    const ctx = createMockContext();
    const input = searchCommoditiesTool.input.parse({ query: 'coffee' });
    const result = searchCommoditiesTool.handler(input, ctx);
    expect(result.totalMatches).toBeGreaterThanOrEqual(1);
    expect(result.matches.some((m) => m.id === '09')).toBe(true);
  });

  it('finds by HS code prefix', () => {
    const ctx = createMockContext();
    const input = searchCommoditiesTool.input.parse({ query: '847' });
    const result = searchCommoditiesTool.handler(input, ctx);
    expect(result.totalMatches).toBeGreaterThanOrEqual(1);
    const ids = result.matches.map((m) => m.id);
    expect(ids.some((id) => id.startsWith('847'))).toBe(true);
  });

  it('filters by aggr_level 2 (chapters only)', () => {
    const ctx = createMockContext();
    const input = searchCommoditiesTool.input.parse({ query: 'machinery', aggr_level: 2 });
    const result = searchCommoditiesTool.handler(input, ctx);
    expect(result.matches.every((m) => m.aggrLevel === 2)).toBe(true);
  });

  it('filters by aggr_level 6 (subheadings)', () => {
    const ctx = createMockContext();
    const input = searchCommoditiesTool.input.parse({ query: 'portable', aggr_level: 6 });
    const result = searchCommoditiesTool.handler(input, ctx);
    expect(result.matches.every((m) => m.aggrLevel === 6)).toBe(true);
    if (result.matches.length > 0) {
      expect(result.matches[0]?.id).toBe('847130');
    }
  });

  it('returns empty result with notice for unknown keyword', () => {
    const ctx = createMockContext();
    const input = searchCommoditiesTool.input.parse({ query: 'xyzzy_nonexistent_commodity' });
    const result = searchCommoditiesTool.handler(input, ctx);
    expect(result.totalMatches).toBe(0);
    expect(result.matches).toHaveLength(0);
    expect(result.truncated).toBe(false);
    expect(getEnrichment(ctx).notice).toContain('xyzzy_nonexistent_commodity');
  });

  it('applies limit and adds truncation notice', () => {
    const ctx = createMockContext();
    // Seed produces 2 "machinery/data" entries at level 4 and 6 — limit to 1
    const input = searchCommoditiesTool.input.parse({ query: 'data processing', limit: 1 });
    const result = searchCommoditiesTool.handler(input, ctx);
    expect(result.shown).toBeLessThanOrEqual(1);
    if (result.totalMatches > 1) {
      expect(result.truncated).toBe(true);
      expect(getEnrichment(ctx).notice).toBeDefined();
      expect(getEnrichment(ctx).notice).toContain('Showing');
    }
  });

  it('includes recommendedQueryCode in output', () => {
    const ctx = createMockContext();
    const input = searchCommoditiesTool.input.parse({ query: '8471' });
    const result = searchCommoditiesTool.handler(input, ctx);
    for (const m of result.matches) {
      expect(m.recommendedQueryCode).toBeDefined();
      expect(m.recommendedQueryCode.length).toBeGreaterThan(0);
    }
  });

  it('formats output with code, description, level, and recommendedQueryCode', () => {
    const output = {
      matches: [
        {
          id: '84',
          description: 'Machinery',
          aggrLevel: 2,
          isLeaf: false,
          recommendedQueryCode: '84',
        },
      ],
      totalMatches: 1,
      shown: 1,
      truncated: false,
    };
    const blocks = searchCommoditiesTool.format!(output);
    expect(blocks[0].type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('84');
    expect(text).toContain('Machinery');
    expect(text).toContain('aggrLevel');
    expect(text).toContain('Use in queries');
  });
});
