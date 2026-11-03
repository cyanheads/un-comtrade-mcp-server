/**
 * @fileoverview Tests for the list-service-categories tool.
 * @module tests/tools/list-service-categories.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { listServiceCategoriesTool } from '@/mcp-server/tools/definitions/list-service-categories.tool.js';
import {
  type ComtradeReferenceService,
  initComtradeReferenceService,
} from '@/services/comtrade-reference/comtrade-reference-service.js';

const mockConfig = {} as Parameters<typeof initComtradeReferenceService>[0];
const mockStorage = {} as Parameters<typeof initComtradeReferenceService>[1];

function seedReferenceService(): ComtradeReferenceService {
  const svc = initComtradeReferenceService(mockConfig, mockStorage);
  // @ts-expect-error — seeding private map
  svc.ebopsByCode = new Map([
    ['3', { id: '3', text: '3 Transport', parent: 'TOTAL' }],
    ['3.1', { id: '3.1', text: '3.1 Sea transport', parent: '3' }],
    ['3.2', { id: '3.2', text: '3.2 Air transport', parent: '3' }],
    ['4', { id: '4', text: '4 Travel', parent: 'TOTAL' }],
    ['7', { id: '7', text: '7 Financial services', parent: 'TOTAL' }],
  ]);
  return svc;
}

describe('listServiceCategoriesTool', () => {
  beforeEach(() => {
    seedReferenceService();
  });

  it('lists all categories when no query or parent_code given', () => {
    const ctx = createMockContext();
    const input = listServiceCategoriesTool.input.parse({});
    const result = listServiceCategoriesTool.handler(input, ctx);
    expect(result.totalMatches).toBe(5);
    expect(result.shown).toBeLessThanOrEqual(100);
  });

  it('filters by keyword query', () => {
    const ctx = createMockContext();
    const input = listServiceCategoriesTool.input.parse({ query: 'transport' });
    const result = listServiceCategoriesTool.handler(input, ctx);
    expect(result.totalMatches).toBeGreaterThanOrEqual(1);
    expect(result.categories.some((c) => c.id === '3')).toBe(true);
  });

  it('filters by parent_code', () => {
    const ctx = createMockContext();
    const input = listServiceCategoriesTool.input.parse({ parent_code: '3' });
    const result = listServiceCategoriesTool.handler(input, ctx);
    expect(result.totalMatches).toBe(2);
    expect(result.categories.every((c) => c.parent === '3')).toBe(true);
  });

  it('applies limit', () => {
    const ctx = createMockContext();
    const input = listServiceCategoriesTool.input.parse({ limit: 2 });
    const result = listServiceCategoriesTool.handler(input, ctx);
    expect(result.shown).toBe(2);
    expect(result.totalMatches).toBe(5);
    expect(result.truncated).toBe(true);
    expect(getEnrichment(ctx).notice).toContain('Showing');
  });

  it('returns notice for no-match query', () => {
    const ctx = createMockContext();
    const input = listServiceCategoriesTool.input.parse({ query: 'zzz_nonexistent' });
    const result = listServiceCategoriesTool.handler(input, ctx);
    expect(result.totalMatches).toBe(0);
    expect(result.truncated).toBe(false);
    expect(getEnrichment(ctx).notice).toBeDefined();
    expect(getEnrichment(ctx).notice).toContain('zzz_nonexistent');
  });

  it('returns notice when parent_code has no children', () => {
    const ctx = createMockContext();
    const input = listServiceCategoriesTool.input.parse({ parent_code: 'XYZ_MISSING' });
    const result = listServiceCategoriesTool.handler(input, ctx);
    expect(result.totalMatches).toBe(0);
    expect(getEnrichment(ctx).notice).toContain('XYZ_MISSING');
  });

  it('formats output with category IDs, descriptions, and parent codes', () => {
    const output = {
      categories: [
        { id: '3', description: '3 Transport', parent: 'TOTAL' },
        { id: '3.1', description: '3.1 Sea transport', parent: '3' },
      ],
      totalMatches: 2,
      shown: 2,
      truncated: false,
    };
    const blocks = listServiceCategoriesTool.format!(output);
    expect(blocks[0].type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('3');
    expect(text).toContain('3 Transport');
    expect(text).toContain('Sea transport');
    expect(text).toContain('3.1');
    expect(text).toContain('Parent:');
  });
});
