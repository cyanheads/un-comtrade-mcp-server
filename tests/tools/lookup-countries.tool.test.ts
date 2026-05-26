/**
 * @fileoverview Tests for the lookup-countries tool.
 * @module tests/tools/lookup-countries.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { lookupCountriesTool } from '@/mcp-server/tools/definitions/lookup-countries.tool.js';
import {
  type ComtradeReferenceService,
  initComtradeReferenceService,
} from '@/services/comtrade-reference/comtrade-reference-service.js';

const mockConfig = {} as Parameters<typeof initComtradeReferenceService>[0];
const mockStorage = {} as Parameters<typeof initComtradeReferenceService>[1];

/** Seed the reference service with in-memory fixture data (no network). */
function seedReferenceService(): ComtradeReferenceService {
  const svc = initComtradeReferenceService(mockConfig, mockStorage);
  // @ts-expect-error — accessing private map for test seeding
  svc.countriesByCode = new Map([
    [
      840,
      {
        id: 840,
        name: 'United States of America',
        iso3: 'USA',
        iso2: 'US',
        validAsReporter: true,
        isGroup: false,
      },
    ],
    [
      276,
      {
        id: 276,
        name: 'Germany',
        iso3: 'DEU',
        iso2: 'DE',
        validAsReporter: true,
        isGroup: false,
      },
    ],
    [
      0,
      {
        id: 0,
        name: 'World',
        iso3: undefined,
        iso2: undefined,
        validAsReporter: false,
        isGroup: true,
      },
    ],
    [
      97,
      {
        id: 97,
        name: 'European Union',
        iso3: undefined,
        iso2: undefined,
        validAsReporter: false,
        isGroup: true,
      },
    ],
  ]);
  return svc;
}

describe('lookupCountriesTool', () => {
  beforeEach(() => {
    seedReferenceService();
  });

  it('finds a country by full name (case-insensitive)', async () => {
    const ctx = createMockContext();
    const input = lookupCountriesTool.input.parse({ query: 'united states', role: 'any' });
    const result = await lookupCountriesTool.handler(input, ctx);
    expect(result.totalMatches).toBe(1);
    expect(result.matches[0]).toMatchObject({
      id: 840,
      name: 'United States of America',
      iso3: 'USA',
      iso2: 'US',
      validAsReporter: true,
      isGroup: false,
    });
  });

  it('finds a country by ISO alpha-3 code', async () => {
    const ctx = createMockContext();
    const input = lookupCountriesTool.input.parse({ query: 'DEU' });
    const result = await lookupCountriesTool.handler(input, ctx);
    expect(result.totalMatches).toBe(1);
    expect(result.matches[0]?.id).toBe(276);
    expect(result.matches[0]?.iso3).toBe('DEU');
  });

  it('filters by role=reporter (excludes non-reporter groups)', async () => {
    const ctx = createMockContext();
    const input = lookupCountriesTool.input.parse({ query: 'world', role: 'reporter' });
    const result = await lookupCountriesTool.handler(input, ctx);
    expect(result.totalMatches).toBe(0);
    expect(result.notice).toBeDefined();
  });

  it('excludes groups when include_groups=false', async () => {
    const ctx = createMockContext();
    const input = lookupCountriesTool.input.parse({
      query: 'european',
      include_groups: false,
    });
    const result = await lookupCountriesTool.handler(input, ctx);
    expect(result.totalMatches).toBe(0);
  });

  it('includes groups when include_groups=true (default)', async () => {
    const ctx = createMockContext();
    const input = lookupCountriesTool.input.parse({ query: 'european' });
    const result = await lookupCountriesTool.handler(input, ctx);
    expect(result.totalMatches).toBe(1);
    expect(result.matches[0]?.isGroup).toBe(true);
  });

  it('returns notice when no matches found', async () => {
    const ctx = createMockContext();
    const input = lookupCountriesTool.input.parse({ query: 'Zzyzxland' });
    const result = await lookupCountriesTool.handler(input, ctx);
    expect(result.totalMatches).toBe(0);
    expect(result.matches).toHaveLength(0);
    expect(result.notice).toContain('Zzyzxland');
  });

  it('returns results sorted by name', async () => {
    const ctx = createMockContext();
    const input = lookupCountriesTool.input.parse({ query: 'e' }); // matches Germany, United States, European Union, World
    const result = await lookupCountriesTool.handler(input, ctx);
    const names = result.matches.map((m) => m.name);
    expect(names).toEqual([...names].sort());
  });

  it('formats output with codes, ISO identifiers, and reporter flag', () => {
    const output = {
      matches: [
        {
          id: 840,
          name: 'United States of America',
          iso3: 'USA',
          iso2: 'US',
          validAsReporter: true,
          isGroup: false,
        },
      ],
      totalMatches: 1,
    };
    const blocks = lookupCountriesTool.format!(output);
    expect(blocks[0].type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('840');
    expect(text).toContain('USA');
    expect(text).toContain('reporter ✓');
  });

  it('formats empty result with notice', () => {
    const output = {
      matches: [],
      totalMatches: 0,
      notice: 'No matches for "xyz".',
    };
    const blocks = lookupCountriesTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No matches for "xyz".');
  });
});
