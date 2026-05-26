/**
 * @fileoverview Tests for the list-service-categories tool.
 * @module tests/tools/list-service-categories.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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
    ['SA', { id: 'SA', text: 'Transport services', parent: undefined }],
    ['SAA', { id: 'SAA', text: 'Sea transport', parent: 'SA' }],
    ['SAB', { id: 'SAB', text: 'Air transport', parent: 'SA' }],
    ['SB', { id: 'SB', text: 'Travel services', parent: undefined }],
    ['SC', { id: 'SC', text: 'Financial services', parent: undefined }],
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
    expect(result.categories.some((c) => c.id === 'SA')).toBe(true);
  });

  it('filters by parent_code', () => {
    const ctx = createMockContext();
    const input = listServiceCategoriesTool.input.parse({ parent_code: 'SA' });
    const result = listServiceCategoriesTool.handler(input, ctx);
    expect(result.totalMatches).toBe(2);
    expect(result.categories.every((c) => c.parent === 'SA')).toBe(true);
  });

  it('applies limit', () => {
    const ctx = createMockContext();
    const input = listServiceCategoriesTool.input.parse({ limit: 2 });
    const result = listServiceCategoriesTool.handler(input, ctx);
    expect(result.shown).toBe(2);
    expect(result.totalMatches).toBe(5);
    expect(result.notice).toContain('Showing');
  });

  it('returns notice for no-match query', () => {
    const ctx = createMockContext();
    const input = listServiceCategoriesTool.input.parse({ query: 'zzz_nonexistent' });
    const result = listServiceCategoriesTool.handler(input, ctx);
    expect(result.totalMatches).toBe(0);
    expect(result.notice).toBeDefined();
    expect(result.notice).toContain('zzz_nonexistent');
  });

  it('returns notice when parent_code has no children', () => {
    const ctx = createMockContext();
    const input = listServiceCategoriesTool.input.parse({ parent_code: 'XYZ_MISSING' });
    const result = listServiceCategoriesTool.handler(input, ctx);
    expect(result.totalMatches).toBe(0);
    expect(result.notice).toContain('XYZ_MISSING');
  });

  it('formats output with category IDs, descriptions, and parent codes', () => {
    const output = {
      categories: [
        { id: 'SA', description: 'Transport services' },
        { id: 'SAA', description: 'Sea transport', parent: 'SA' },
      ],
      totalMatches: 2,
      shown: 2,
    };
    const blocks = listServiceCategoriesTool.format!(output);
    expect(blocks[0].type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('SA');
    expect(text).toContain('Transport services');
    expect(text).toContain('Sea transport');
    expect(text).toContain('SAA');
    expect(text).toContain('Parent:');
  });
});
