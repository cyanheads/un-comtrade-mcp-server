/**
 * @fileoverview Tests for the lookup-countries tool.
 * @module tests/tools/lookup-countries.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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

  it('renders country matches, empty results, and invalid-input errors', async () => {
    const result = await runToolContract(lookupCountriesTool, { query: 'DEU' });
    expect(result.structuredContent).toMatchObject({
      matches: [
        {
          id: 276,
          name: 'Germany',
          iso3: 'DEU',
          iso2: 'DE',
          validAsReporter: true,
          isGroup: false,
        },
      ],
      totalMatches: 1,
    });
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('Germany') }]);
    const empty = await runToolContract(lookupCountriesTool, { query: 'Zzyzxland' });
    expect(empty.structuredContent).toMatchObject({ matches: [], totalMatches: 0 });
    expect(JSON.stringify(empty.content)).toContain('Zzyzxland');
    const invalid = await runToolContract(lookupCountriesTool, { query: false });
    expect(invalid.isError).toBe(true);
    expect(JSON.stringify(invalid.content)).toContain('query');
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
    expect(getEnrichment(ctx).notice).toBeDefined();
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

  it('says only groupings matched when include_groups=false leaves no match', async () => {
    const ctx = createMockContext();
    const input = lookupCountriesTool.input.parse({ query: 'european', include_groups: false });
    await lookupCountriesTool.handler(input, ctx);
    expect(getEnrichment(ctx).notice).toBe(
      'Only groupings matched "european" with role="any"; include_groups is false, so they are left out. Retry with include_groups true to list them.',
    );
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
    expect(getEnrichment(ctx).notice).toContain('Zzyzxland');
  });

  it('orders reporter-valid entries first, breaking ties by name', async () => {
    const ctx = createMockContext();
    const input = lookupCountriesTool.input.parse({ query: 'e' }); // matches Germany, United States, European Union, World
    const result = await lookupCountriesTool.handler(input, ctx);
    const names = result.matches.map((m) => m.name);
    expect(names).toEqual(['Germany', 'United States of America', 'European Union']);
  });

  it('ranks a current entity before an expired one and carries validity dates on both surfaces', async () => {
    const svc = seedReferenceService();
    // @ts-expect-error — accessing private map for test seeding
    svc.countriesByCode = new Map([
      [
        280,
        {
          id: 280,
          name: 'Fed. Rep. of Germany (...1990)',
          iso3: 'DEU',
          iso2: 'DE',
          validAsReporter: true,
          isGroup: false,
          entryEffectiveDate: '1900-01-01',
          entryExpiredDate: '1990-12-31',
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
          entryEffectiveDate: '1991-01-01',
        },
      ],
    ]);
    const result = await runToolContract(lookupCountriesTool, { query: 'Germany' });
    expect(result.structuredContent).toEqual({
      matches: [
        {
          id: 276,
          name: 'Germany',
          iso3: 'DEU',
          iso2: 'DE',
          validAsReporter: true,
          isGroup: false,
          entryEffectiveDate: '1991-01-01',
        },
        {
          id: 280,
          name: 'Fed. Rep. of Germany (...1990)',
          iso3: 'DEU',
          iso2: 'DE',
          validAsReporter: true,
          isGroup: false,
          entryEffectiveDate: '1900-01-01',
          entryExpiredDate: '1990-12-31',
        },
      ],
      totalMatches: 2,
    });
    const text = JSON.stringify(result.content);
    expect(text).toContain(
      '(code: 276) | ISO3: DEU | ISO2: DE | reporter ✓ | valid from 1991-01-01',
    );
    expect(text).toContain('valid 1900-01-01 to 1990-12-31');
    expect(text.indexOf('(code: 276)')).toBeLessThan(text.indexOf('(code: 280)'));
  });

  it('formats a sparse validity range without inventing the missing bound', () => {
    const blocks = lookupCountriesTool.format!({
      matches: [
        { id: 2, name: 'No dates', validAsReporter: false, isGroup: false },
        {
          id: 1,
          name: 'Only expired',
          validAsReporter: false,
          isGroup: false,
          entryExpiredDate: '1990-12-31',
        },
      ],
      totalMatches: 2,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**No dates** (code: 2) | reporter ✗\n');
    expect(text).toContain('**Only expired** (code: 1) | reporter ✗ | valid until 1990-12-31');
    expect(text).not.toContain('valid from');
  });

  it('carries the catalog note of a match on both surfaces, and none when the entry has none', async () => {
    const svc = seedReferenceService();
    // @ts-expect-error — accessing private map for test seeding
    svc.countriesByCode = new Map([
      [
        251,
        {
          id: 251,
          name: 'France',
          iso3: 'FRA',
          iso2: 'FR',
          note: 'France, Monaco',
          validAsReporter: true,
          isGroup: false,
        },
      ],
      [
        250,
        {
          id: 250,
          name: 'Metropolitan France',
          iso3: 'FRA',
          iso2: 'FR',
          validAsReporter: false,
          isGroup: false,
        },
      ],
    ]);
    const result = await runToolContract(lookupCountriesTool, { query: 'Monaco' });
    expect(result.structuredContent).toEqual({
      matches: [
        {
          id: 251,
          name: 'France',
          iso3: 'FRA',
          iso2: 'FR',
          note: 'France, Monaco',
          validAsReporter: true,
          isGroup: false,
        },
        {
          id: 250,
          name: 'Metropolitan France',
          iso3: 'FRA',
          iso2: 'FR',
          validAsReporter: false,
          isGroup: false,
        },
      ],
      totalMatches: 2,
    });
    const text = JSON.stringify(result.content);
    expect(text).toContain(
      '(code: 251) | ISO3: FRA | ISO2: FR | reporter ✓ | note: France, Monaco',
    );
    expect(text.match(/note: /g)).toHaveLength(1);
  });

  it('renders a catalog note after the validity range, escaping its Markdown', () => {
    const blocks = lookupCountriesTool.format!({
      matches: [
        {
          id: 3,
          name: 'Noted',
          note: 'A_*B*_',
          validAsReporter: true,
          isGroup: false,
          entryEffectiveDate: '1900-01-01',
        },
      ],
      totalMatches: 1,
    });
    expect((blocks[0] as { text: string }).text).toContain(
      '**Noted** (code: 3) | reporter ✓ | valid from 1900-01-01 | note: A\\_\\*B\\*\\_',
    );
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

  it.each([
    ['spaces', '   '],
    ['a tab and newline', '\t\n'],
    ['one space', ' '],
    ['a no-break space', String.fromCodePoint(0xa0)],
    ['an empty string', ''],
  ])('rejects a blank query (%s) with a request for a name or ISO code', async (_label, query) => {
    const result = await runToolContract(lookupCountriesTool, { query });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      'Enter a country or area name or an ISO alpha-2/alpha-3 code',
    );
  });

  it('trims the query before matching and echoes the trimmed query', async () => {
    const padded = await runToolContract(lookupCountriesTool, { query: ' Germany ' });
    const plain = await runToolContract(lookupCountriesTool, { query: 'Germany' });
    expect(padded.structuredContent).toEqual(plain.structuredContent);
    expect(padded.structuredContent).toMatchObject({ matches: [{ id: 276 }], totalMatches: 1 });
    const ctx = createMockContext();
    const input = lookupCountriesTool.input.parse({ query: '\t Zzyzxland  ' });
    expect(input.query).toBe('Zzyzxland');
    await lookupCountriesTool.handler(input, ctx);
    expect(getEnrichment(ctx).notice).toContain('No countries or areas matched "Zzyzxland" with');
  });

  it('escapes Markdown in the echoed query of the no-match notice', async () => {
    const ctx = createMockContext();
    const input = lookupCountriesTool.input.parse({ query: '**Zzyzx**](x)' });
    await lookupCountriesTool.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('No countries or areas matched "\\*\\*Zzyzx\\*\\*\\](x)" with');
    expect(notice).not.toContain('"**Zzyzx**](x)"');
  });

  it('leads a common name with its alias target on both surfaces', async () => {
    const svc = seedReferenceService();
    // @ts-expect-error — accessing private map for test seeding
    svc.countriesByCode = new Map([
      [
        804,
        {
          id: 804,
          name: 'Ukraine',
          iso3: 'UKR',
          iso2: 'UA',
          validAsReporter: true,
          isGroup: false,
        },
      ],
      [
        826,
        {
          id: 826,
          name: 'United Kingdom',
          iso3: 'GBR',
          iso2: 'GB',
          validAsReporter: true,
          isGroup: false,
        },
      ],
    ]);
    const result = await runToolContract(lookupCountriesTool, { query: 'UK' });
    expect(result.structuredContent).toMatchObject({
      matches: [{ id: 826, name: 'United Kingdom' }, { id: 804 }],
      totalMatches: 2,
    });
    const text = JSON.stringify(result.content);
    expect(text.indexOf('(code: 826)')).toBeGreaterThan(-1);
    expect(text.indexOf('(code: 826)')).toBeLessThan(text.indexOf('(code: 804)'));
  });
});
