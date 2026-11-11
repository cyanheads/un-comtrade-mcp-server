/**
 * @fileoverview Tests for the search-commodities tool.
 * @module tests/tools/search-commodities.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  getEnrichment,
  type MockContextLogger,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchCommoditiesTool } from '@/mcp-server/tools/definitions/search-commodities.tool.js';
import {
  ComtradeReferenceService,
  initComtradeReferenceService,
} from '@/services/comtrade-reference/comtrade-reference-service.js';

const mockConfig = {} as Parameters<typeof initComtradeReferenceService>[0];
const mockStorage = {} as Parameters<typeof initComtradeReferenceService>[1];

type ToolCall = Awaited<ReturnType<typeof runToolContract>>;

/** Every text block a tool call rendered into content[]. */
function contentText(result: ToolCall): string {
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

/** structuredContent parsed through the declared output schema (enrichment keys stripped). */
function page(result: ToolCall) {
  return searchCommoditiesTool.output.parse(result.structuredContent);
}

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

/** Seed `count` HS headings described as widgets; returns their ids in catalog order. */
function seedHeadings(count: number): string[] {
  const svc = initComtradeReferenceService(mockConfig, mockStorage);
  const ids = Array.from({ length: count }, (_, i) => String(1000 + i));
  // @ts-expect-error — seeding private map
  svc.hsByCode = new Map(
    ids.map((id) => [
      id,
      {
        id,
        text: `${id} - Widget heading`,
        aggrLevel: 4 as const,
        parent: id.slice(0, 2),
        isLeaf: false,
        recommendedQueryCode: id,
      },
    ]),
  );
  return ids;
}

/** Seed HS headings whose "tea" matches are whole words and embedded ones, in catalog order. */
function seedTeaHeadings(): void {
  const svc = initComtradeReferenceService(mockConfig, mockStorage);
  // @ts-expect-error — seeding private map
  svc.hsByCode = new Map(
    [
      '1000 - Teapots',
      '1001 - Green tea',
      '1002 - Teaspoons',
      '1003 - Tea',
      '1004 - Steamers',
      '1005 - Black tea leaves',
      '1006 - Instead of tea',
    ].map((text) => {
      const id = text.slice(0, 4);
      return [id, { id, text, aggrLevel: 4, isLeaf: false, recommendedQueryCode: id }];
    }),
  );
}

const QUERY_MESSAGE =
  'Provide a keyword or commodity code with at least one letter or digit, such as "coffee" or "0901.11".';

describe('searchCommoditiesTool', () => {
  beforeEach(() => {
    seedReferenceService();
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockRejectedValue(new Error('Unexpected live fetch')),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('finds commodities by keyword', async () => {
    const ctx = createMockContext();
    const input = searchCommoditiesTool.input.parse({ query: 'coffee' });
    const result = await searchCommoditiesTool.handler(input, ctx);
    expect(result.totalMatches).toBeGreaterThanOrEqual(1);
    expect(result.matches.some((m) => m.id === '09')).toBe(true);
  });

  it('finds by HS code prefix', async () => {
    const ctx = createMockContext();
    const input = searchCommoditiesTool.input.parse({ query: '847' });
    const result = await searchCommoditiesTool.handler(input, ctx);
    expect(result.totalMatches).toBeGreaterThanOrEqual(1);
    const ids = result.matches.map((m) => m.id);
    expect(ids.some((id) => id.startsWith('847'))).toBe(true);
  });

  it('filters by aggr_level 2 (chapters only)', async () => {
    const ctx = createMockContext();
    const input = searchCommoditiesTool.input.parse({ query: 'machinery', aggr_level: 2 });
    const result = await searchCommoditiesTool.handler(input, ctx);
    expect(result.matches.every((m) => m.aggrLevel === 2)).toBe(true);
  });

  it('filters by aggr_level 6 (subheadings)', async () => {
    const ctx = createMockContext();
    const input = searchCommoditiesTool.input.parse({ query: 'portable', aggr_level: 6 });
    const result = await searchCommoditiesTool.handler(input, ctx);
    expect(result.matches.every((m) => m.aggrLevel === 6)).toBe(true);
    if (result.matches.length > 0) {
      expect(result.matches[0]?.id).toBe('847130');
    }
  });

  it('returns empty result with notice for unknown keyword', async () => {
    const ctx = createMockContext();
    const input = searchCommoditiesTool.input.parse({ query: 'xyzzy_nonexistent_commodity' });
    const result = await searchCommoditiesTool.handler(input, ctx);
    expect(result.totalMatches).toBe(0);
    expect(result.matches).toHaveLength(0);
    expect(result.truncated).toBe(false);
    expect(getEnrichment(ctx).notice).toContain('xyzzy_nonexistent_commodity');
  });

  it('escapes Markdown in the echoed query of the no-match notice', async () => {
    const ctx = createMockContext();
    const input = searchCommoditiesTool.input.parse({ query: '**xyzzy**' });
    await searchCommoditiesTool.handler(input, ctx);
    expect(getEnrichment(ctx).notice).toContain('matched "\\*\\*xyzzy\\*\\*"');
  });

  it('applies limit and adds truncation notice', async () => {
    const ctx = createMockContext();
    // Seed produces 2 "machinery/data" entries at level 4 and 6 — limit to 1
    const input = searchCommoditiesTool.input.parse({ query: 'data processing', limit: 1 });
    const result = await searchCommoditiesTool.handler(input, ctx);
    expect(result.shown).toBeLessThanOrEqual(1);
    if (result.totalMatches > 1) {
      expect(result.truncated).toBe(true);
      expect(getEnrichment(ctx).notice).toBeDefined();
      expect(getEnrichment(ctx).notice).toContain('Showing');
    }
  });

  it('includes recommendedQueryCode in output', async () => {
    const ctx = createMockContext();
    const input = searchCommoditiesTool.input.parse({ query: '8471' });
    const result = await searchCommoditiesTool.handler(input, ctx);
    for (const m of result.matches) {
      expect(m.recommendedQueryCode).toBeDefined();
      expect(m.recommendedQueryCode.length).toBeGreaterThan(0);
    }
  });

  it('lists the level-0 HS TOTAL as the total unfiltered and drops it from level filters', async () => {
    const svc = seedReferenceService();
    // @ts-expect-error — seeding private map
    svc.hsByCode.set('TOTAL', {
      id: 'TOTAL',
      text: 'Total - All H6 commodities',
      parent: '#',
      aggrLevel: 0,
      isLeaf: false,
      recommendedQueryCode: 'TOTAL',
    });
    const unfiltered = await runToolContract(searchCommoditiesTool, { query: 'total' });
    expect(unfiltered.structuredContent).toEqual({
      classification: 'HS',
      matches: [
        {
          id: 'TOTAL',
          description: 'Total - All H6 commodities',
          aggrLevel: 0,
          parent: '#',
          isLeaf: false,
          recommendedQueryCode: 'TOTAL',
        },
      ],
      totalMatches: 1,
      shown: 1,
      truncated: false,
      offset: 0,
    });
    expect(JSON.stringify(unfiltered.content)).toContain('aggrLevel: 0 (Total) | Parent: #');
    for (const aggr_level of [2, 4, 6]) {
      const filtered = await runToolContract(searchCommoditiesTool, { query: 'total', aggr_level });
      expect(filtered.structuredContent).toMatchObject({ matches: [], totalMatches: 0 });
      expect(JSON.stringify(filtered.content)).not.toContain('TOTAL');
    }
  });

  it('characterizes the default 50-match first page in catalog order', async () => {
    const codes = seedHeadings(51);
    const ctx = createMockContext();
    const result = await searchCommoditiesTool.handler(
      searchCommoditiesTool.input.parse({ query: 'widget' }),
      ctx,
    );
    expect(result).toMatchObject({ totalMatches: 51, shown: 50, truncated: true });
    expect(result.matches.map((m) => m.id)).toEqual(codes.slice(0, 50));
    expect(getEnrichment(ctx).notice).toContain('Showing 50 of 51 matches.');
  });

  it('caps the default page at 50 and points the truncation notice at offset 50', async () => {
    const ids = seedHeadings(51);
    const first = await runToolContract(searchCommoditiesTool, { query: 'widget' });
    expect(page(first)).toMatchObject({
      totalMatches: 51,
      shown: 50,
      truncated: true,
      offset: 0,
      nextOffset: 50,
    });
    const notice =
      'Showing 50 of 51 matches. Continue with offset=50 and the same query, classification and aggr_level, or narrow the query.';
    expect(first.structuredContent).toMatchObject({ notice });
    expect(contentText(first)).toContain(notice);
    expect(contentText(first)).toContain('**Offset:** 0 | **Next offset:** 50');
    const last = await runToolContract(searchCommoditiesTool, { query: 'widget', offset: 50 });
    expect(page(last)).toStrictEqual({
      classification: 'HS',
      matches: [expect.objectContaining({ id: ids[50] })],
      totalMatches: 51,
      shown: 1,
      truncated: true,
      offset: 50,
    });
    expect(last.structuredContent).not.toHaveProperty('notice');
    expect(contentText(last)).not.toContain('Next offset');
  });

  it.each([201, 500])(
    'returns exactly limit %i matches past the old 200 threshold',
    async (limit) => {
      const ids = seedHeadings(520);
      const result = await runToolContract(searchCommoditiesTool, { query: 'widget', limit });
      const out = page(result);
      expect(out).toMatchObject({ totalMatches: 520, shown: limit, offset: 0, nextOffset: limit });
      expect(out.matches.map((m) => m.id)).toEqual(ids.slice(0, limit));
      expect(contentText(result)).toContain(`**${ids[limit - 1]}** —`);
      expect(contentText(result)).not.toContain(`**${ids[limit]}** —`);
      expect(contentText(result)).toContain(`**Next offset:** ${limit}`);
    },
  );

  it('pages by nextOffset to the full ordered match list without overlap or gap', async () => {
    const ids = seedHeadings(7);
    const all = page(await runToolContract(searchCommoditiesTool, { query: 'widget' }));
    expect(all.matches.map((m) => m.id)).toEqual(ids);
    const walked: string[] = [];
    const pageSizes: number[] = [];
    let offset = 0;
    for (;;) {
      const result = await runToolContract(searchCommoditiesTool, {
        query: 'widget',
        limit: 3,
        offset,
      });
      const out = page(result);
      expect(out).toMatchObject({ offset, totalMatches: 7 });
      walked.push(...out.matches.map((m) => m.id));
      pageSizes.push(out.shown);
      if (out.nextOffset === undefined) break;
      expect(out.nextOffset).toBe(offset + out.shown);
      expect(contentText(result)).toContain(`offset=${out.nextOffset}`);
      offset = out.nextOffset;
    }
    expect(walked).toEqual(ids);
    expect(pageSizes).toEqual([3, 3, 1]);
  });

  it.each([7, 40])(
    'returns an empty page with the true total at offset %i (at or past the end)',
    async (offset) => {
      seedHeadings(7);
      const result = await runToolContract(searchCommoditiesTool, { query: 'widget', offset });
      expect(page(result)).toStrictEqual({
        classification: 'HS',
        matches: [],
        totalMatches: 7,
        shown: 0,
        truncated: true,
        offset,
      });
      const notice = `Offset ${offset} is past the end of the 7 matching codes. Use an offset below 7.`;
      expect(result.structuredContent).toMatchObject({ notice });
      expect(contentText(result)).toContain(notice);
      expect(contentText(result)).not.toContain('commodity codes matched');
    },
  );

  it('keeps the no-match notice for a query without matches at any offset', async () => {
    const result = await runToolContract(searchCommoditiesTool, { query: 'xyzzy', offset: 10 });
    expect(page(result)).toStrictEqual({
      classification: 'HS',
      matches: [],
      totalMatches: 0,
      shown: 0,
      truncated: false,
      offset: 10,
    });
    const notice =
      'No HS commodity codes matched "xyzzy". Try a different keyword, a shorter prefix, or remove the aggr_level filter.';
    expect(result.structuredContent).toMatchObject({ notice });
    expect(contentText(result)).toContain(notice);
  });

  it('trims and uppercases classification before searching and checking SITC levels', async () => {
    const search = vi
      .spyOn(ComtradeReferenceService.prototype, 'searchCommodityCodes')
      .mockResolvedValue([]);
    const hs = await runToolContract(searchCommoditiesTool, {
      query: '01',
      classification: ' h3 ',
    });
    expect(search).toHaveBeenLastCalledWith('01', 'H3', undefined, expect.anything());
    expect(page(hs).classification).toBe('H3');
    expect(contentText(hs)).toContain('Commodity Code Search — H3');
    const sitc = await runToolContract(searchCommoditiesTool, {
      query: '01',
      classification: 's4',
      aggr_level: 5,
    });
    expect(sitc.isError).not.toBe(true);
    expect(search).toHaveBeenLastCalledWith('01', 'S4', 5, expect.anything());
    const rejected = await runToolContract(searchCommoditiesTool, {
      query: '01',
      classification: 'H7',
    });
    expect(rejected.isError).toBe(true);
    expect(rejected.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(search).toHaveBeenCalledTimes(2);
  });

  it.each(['   ', '\t\n', ' ', '', '-', '.', ' - '])(
    'rejects query %j, which holds no letter or digit, without searching',
    async (query) => {
      const search = vi.spyOn(ComtradeReferenceService.prototype, 'searchCommodityCodes');
      const result = await runToolContract(searchCommoditiesTool, { query });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
      expect(JSON.stringify(result.structuredContent)).toContain(
        JSON.stringify(QUERY_MESSAGE).slice(1, -1),
      );
      // A blank query stops at the length check, so the message is reported once, not twice.
      expect(
        (result.structuredContent as { error: { data: { issues: unknown[] } } }).error.data.issues,
      ).toHaveLength(1);
      expect(contentText(result)).toContain(QUERY_MESSAGE);
      expect(search).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['0901.', 'HS'],
    ['09-01', 'HS'],
    ['001X', 'S4'],
    // A letter of any script counts, not only ASCII.
    ['咖啡', 'HS'],
  ])('still searches %s in %s', async (query, classification) => {
    const search = vi
      .spyOn(ComtradeReferenceService.prototype, 'searchCommodityCodes')
      .mockResolvedValue([]);
    const result = await runToolContract(searchCommoditiesTool, { query, classification });
    expect(result.isError).not.toBe(true);
    expect(search).toHaveBeenCalledWith(query, classification, undefined, expect.anything());
  });

  it('searches a padded query as its trimmed form', async () => {
    const padded = await runToolContract(searchCommoditiesTool, { query: '  coffee ' });
    const plain = await runToolContract(searchCommoditiesTool, { query: 'coffee' });
    expect(page(padded)).toStrictEqual(page(plain));
    expect(page(plain).matches.map((m) => m.id)).toEqual(['09']);
  });

  it('echoes the trimmed query in the no-match notice and the log', async () => {
    const ctx = createMockContext({ errors: searchCommoditiesTool.errors });
    await searchCommoditiesTool.handler(
      searchCommoditiesTool.input.parse({ query: '  xyzzy\t' }),
      ctx,
    );
    expect(getEnrichment(ctx).notice).toBe(
      'No HS commodity codes matched "xyzzy". Try a different keyword, a shorter prefix, or remove the aggr_level filter.',
    );
    expect((ctx.log as MockContextLogger).calls).toContainEqual(
      expect.objectContaining({
        msg: 'comtrade_search_commodities',
        data: expect.objectContaining({ query: 'xyzzy' }),
      }),
    );
  });

  it('advertises query as a non-empty string, unchanged by trimming and the refinement', () => {
    const schema = z.toJSONSchema(searchCommoditiesTool.input, { io: 'input' });
    expect(schema.properties?.query).toStrictEqual({
      type: 'string',
      minLength: 1,
      description: expect.stringContaining('"0901.11"'),
    });
  });

  it('finds a dotted code by its exact code through the tool on both surfaces', async () => {
    const result = await runToolContract(searchCommoditiesTool, { query: '8471.30' });
    expect(page(result).matches.map((m) => m.id)).toEqual(['847130']);
    expect(contentText(result)).toContain('**847130** — Portable automatic data processing');
  });

  it('pages by nextOffset through the ranked order without overlap or gap', async () => {
    seedTeaHeadings();
    const ranked = ['1001', '1003', '1005', '1006', '1000', '1002', '1004'];
    const all = page(await runToolContract(searchCommoditiesTool, { query: 'tea' }));
    expect(all.matches.map((m) => m.id)).toEqual(ranked);
    const walked: string[] = [];
    let offset = 0;
    for (;;) {
      const result = await runToolContract(searchCommoditiesTool, {
        query: 'tea',
        limit: 3,
        offset,
      });
      const out = page(result);
      expect(out).toMatchObject({ offset, totalMatches: 7 });
      expect(contentText(result).match(/\n\*\*([^*]+)\*\* — /)?.[1]).toBe(out.matches[0]?.id);
      walked.push(...out.matches.map((m) => m.id));
      if (out.nextOffset === undefined) break;
      expect(out.nextOffset).toBe(offset + out.shown);
      offset = out.nextOffset;
    }
    expect(walked).toEqual(ranked);
  });

  it('describes matches as ranked rather than in catalog order', () => {
    const { description } = searchCommoditiesTool.output.shape.matches;
    expect(description).not.toContain('in catalog order');
    expect(description).toContain(
      'ranked exact code, code prefix, whole-word description match, then other description matches',
    );
  });

  it('formats output with code, description, level, recommendedQueryCode, and paging', () => {
    const output = {
      classification: 'HS',
      matches: [
        {
          id: '84',
          description: 'Machinery',
          aggrLevel: 2,
          isLeaf: false,
          recommendedQueryCode: '84',
        },
      ],
      totalMatches: 3,
      shown: 1,
      truncated: true,
      offset: 1,
      nextOffset: 2,
    };
    const blocks = searchCommoditiesTool.format!(output);
    expect(blocks[0]?.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('84');
    expect(text).toContain('Machinery');
    expect(text).toContain('aggrLevel');
    expect(text).toContain('Use in queries');
    expect(text).toContain(
      '**Matches:** 3 | **Shown:** 1 | **Truncated:** yes\n**Offset:** 1 | **Next offset:** 2',
    );
  });
});
