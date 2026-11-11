/**
 * @fileoverview Tests for the list-service-categories tool.
 * @module tests/tools/list-service-categories.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import {
  createMockContext,
  getEnrichment,
  type MockContextLogger,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listServiceCategoriesTool } from '@/mcp-server/tools/definitions/list-service-categories.tool.js';
import { initComtradeReferenceService } from '@/services/comtrade-reference/comtrade-reference-service.js';

const mockConfig = {} as Parameters<typeof initComtradeReferenceService>[0];
const mockStorage = {} as Parameters<typeof initComtradeReferenceService>[1];

interface EbRow {
  id: string;
  parent: string;
  text: string;
}

/** Combined EB.json rows; upstream parents EB10's top level under TOTAL, an id EB.json lacks. */
const EB_ROWS: EbRow[] = [
  { id: '200', text: 'Total EBOPS 2002/2010 Services', parent: '#' },
  { id: '3', text: '3 Transport', parent: 'TOTAL' },
  { id: '3.1', text: '3.1 Sea transport', parent: '3' },
  { id: '3.2', text: '3.2 Air transport', parent: '3' },
  { id: '4', text: '4 Travel', parent: 'TOTAL' },
  { id: '7', text: '7 Financial services', parent: 'TOTAL' },
  { id: '205', text: '1. Transportation', parent: '200' },
  { id: '260', text: '6. Financial services', parent: '200' },
  { id: 'S', text: 'Total EBOPS 2010 SDMX Services', parent: '#' },
  { id: 'SG', text: 'Financial services', parent: 'S' },
  { id: '3a.3.1', text: '3a.3.1  Postal and courier services', parent: '3a.3' },
];

/** Per-scheme catalogs by reference file name. */
const SCHEME_FILES: Record<string, EbRow[]> = {
  'EB10.json': [
    { id: '200', text: 'Total EBOPS 2010 Services', parent: '#' },
    { id: '3', text: '3 Transport', parent: '200' },
    { id: '3.1', text: '3.1 Sea transport', parent: '3' },
    { id: '3.2', text: '3.2 Air transport', parent: '3' },
    { id: '4', text: '4 Travel', parent: '200' },
    { id: '7', text: '7 Financial services', parent: '200' },
  ],
  'EB10S.json': [
    { id: 'S', text: 'Total EBOPS 2010 SDMX Services', parent: '#' },
    { id: 'SG', text: 'Financial services', parent: 'S' },
  ],
  'EB02.json': [
    { id: '200', text: 'TOTAL - Total EBOPS 2002 Services', parent: '#' },
    { id: '205', text: '1. Transportation', parent: '200' },
    { id: '260', text: '6. Financial services', parent: '200' },
  ],
};

function seedReferenceService(rows: EbRow[] = EB_ROWS): void {
  const svc = initComtradeReferenceService(mockConfig, mockStorage);
  // @ts-expect-error — seeding private map
  svc.ebopsByCode = new Map(rows.map((row) => [row.id, row]));
}

/** Serve the scheme catalogs from the reference host with `missing` files as 404s; reject other hosts. */
function stubSchemeCatalogs(missing: string[] = []): ReturnType<typeof vi.fn<typeof fetch>> {
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.hostname !== 'comtradeapi.un.org') throw new Error(`Unexpected fetch to ${url.origin}`);
    const file = url.pathname.split('/').at(-1) ?? '';
    const rows = missing.includes(file) ? undefined : SCHEME_FILES[file];
    return rows ? Response.json({ results: rows }) : new Response('missing', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

type ToolCall = Awaited<ReturnType<typeof runToolContract>>;

/** Every text block a tool call rendered into content[]. */
function contentText(result: ToolCall): string {
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

/** structuredContent parsed through the declared output schema (enrichment keys stripped). */
function listing(result: ToolCall) {
  return listServiceCategoriesTool.output.parse(result.structuredContent);
}

const UNTAGGED_EB10S =
  "EB scheme catalogs unavailable (EB10S.json): categories are listed without scheme tags and with the combined EB catalog's parents, which put EB10's top-level codes under TOTAL instead of 200. Retry later for scheme tags.";

describe('listServiceCategoriesTool', () => {
  beforeEach(() => {
    seedReferenceService();
    stubSchemeCatalogs();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('lists all categories when no query or parent_code given', async () => {
    const ctx = createMockContext();
    const input = listServiceCategoriesTool.input.parse({});
    const result = await listServiceCategoriesTool.handler(input, ctx);
    expect(result.totalMatches).toBe(11);
    expect(result.shown).toBe(11);
  });

  it('filters by keyword query', async () => {
    const ctx = createMockContext();
    const input = listServiceCategoriesTool.input.parse({ query: 'transport' });
    const result = await listServiceCategoriesTool.handler(input, ctx);
    expect(result.categories.map((c) => c.id)).toEqual(['3', '3.1', '3.2', '205']);
  });

  it('filters by parent_code', async () => {
    const ctx = createMockContext();
    const input = listServiceCategoriesTool.input.parse({ parent_code: '3' });
    const result = await listServiceCategoriesTool.handler(input, ctx);
    expect(result.totalMatches).toBe(2);
    expect(result.categories.every((c) => c.parent === '3')).toBe(true);
  });

  it('applies limit', async () => {
    const ctx = createMockContext();
    const input = listServiceCategoriesTool.input.parse({ limit: 2 });
    const result = await listServiceCategoriesTool.handler(input, ctx);
    expect(result.shown).toBe(2);
    expect(result.totalMatches).toBe(11);
    expect(result.truncated).toBe(true);
    expect(getEnrichment(ctx).notice).toContain('Showing');
  });

  it('returns notice for no-match query', async () => {
    const ctx = createMockContext();
    const input = listServiceCategoriesTool.input.parse({ query: 'zzz_nonexistent' });
    const result = await listServiceCategoriesTool.handler(input, ctx);
    expect(result.totalMatches).toBe(0);
    expect(result.truncated).toBe(false);
    expect(getEnrichment(ctx).notice).toBeDefined();
    expect(getEnrichment(ctx).notice).toContain('zzz_nonexistent');
  });

  it('returns notice when parent_code has no children', async () => {
    const ctx = createMockContext();
    const input = listServiceCategoriesTool.input.parse({ parent_code: 'XYZ_MISSING' });
    const result = await listServiceCategoriesTool.handler(input, ctx);
    expect(result.totalMatches).toBe(0);
    expect(getEnrichment(ctx).notice).toContain('XYZ_MISSING');
  });

  it('escapes Markdown in the echoed query and parent code of the no-match notice', async () => {
    const ctx = createMockContext();
    const input = listServiceCategoriesTool.input.parse({
      query: '**zzz**',
      parent_code: '[x](y)',
    });
    await listServiceCategoriesTool.handler(input, ctx);
    expect(getEnrichment(ctx).notice).toContain(
      'matched "\\*\\*zzz\\*\\*" under parent "\\[x\\](y)"',
    );
  });

  it('matches a lowercase EB parent code in any casing', async () => {
    for (const parent_code of ['3a.3', '3A.3']) {
      const result = await runToolContract(listServiceCategoriesTool, { parent_code });
      expect(listing(result).categories.map((c) => c.id)).toEqual(['3a.3.1']);
    }
  });

  it('characterizes parent_code TOTAL returning the EB10 top level, case-insensitively', async () => {
    for (const parent_code of ['TOTAL', 'total']) {
      const result = await runToolContract(listServiceCategoriesTool, { parent_code });
      expect(listing(result).categories.map((c) => c.id)).toEqual(['3', '4', '7']);
    }
  });

  it('tags each code with the scheme catalogs that list it on both surfaces', async () => {
    const result = await runToolContract(listServiceCategoriesTool, {});
    const byId = new Map(listing(result).categories.map((c) => [c.id, c]));
    expect(byId.get('200')).toStrictEqual({
      id: '200',
      description: 'Total EBOPS 2002/2010 Services',
      parent: '#',
      schemes: ['EB10', 'EB02'],
    });
    expect(byId.get('7')).toStrictEqual({
      id: '7',
      description: '7 Financial services',
      parent: '200',
      ebParent: 'TOTAL',
      schemes: ['EB10'],
    });
    expect(byId.get('SG')).toStrictEqual({
      id: 'SG',
      description: 'Financial services',
      parent: 'S',
      schemes: ['EB10S'],
    });
    expect(byId.get('3a.3.1')).toStrictEqual({
      id: '3a.3.1',
      description: '3a.3.1  Postal and courier services',
      parent: '3a.3',
      schemes: [],
    });
    const text = contentText(result);
    expect(text).toContain(
      '**200** — Total EBOPS 2002/2010 Services\n  Parent: # | Schemes: EB10, EB02',
    );
    expect(text).toContain(
      '**7** — 7 Financial services\n  Parent: 200 (EB catalog parent: TOTAL) | Schemes: EB10',
    );
    expect(text).toContain('**SG** — Financial services\n  Parent: S | Schemes: EB10S');
    expect(text).toContain(
      '**3a.3.1** — 3a.3.1  Postal and courier services\n  Parent: 3a.3 | Schemes: none',
    );
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('lists the EB10 and EB02 top levels under 200 while TOTAL keeps the EB10 codes', async () => {
    const top = await runToolContract(listServiceCategoriesTool, { parent_code: '200' });
    expect(listing(top).categories.map((c) => [c.id, c.parent, c.ebParent])).toEqual([
      ['3', '200', 'TOTAL'],
      ['4', '200', 'TOTAL'],
      ['7', '200', 'TOTAL'],
      ['205', '200', undefined],
      ['260', '200', undefined],
    ]);
    expect(contentText(top)).toContain(
      '**3** — 3 Transport\n  Parent: 200 (EB catalog parent: TOTAL)',
    );
    expect(contentText(top)).toContain('**260** — 6. Financial services\n  Parent: 200 | Schemes');
    const total = await runToolContract(listServiceCategoriesTool, { parent_code: 'TOTAL' });
    expect(listing(total)).toMatchObject({
      totalMatches: 3,
      categories: [
        { id: '3', parent: '200', ebParent: 'TOTAL' },
        { id: '4', parent: '200', ebParent: 'TOTAL' },
        { id: '7', parent: '200', ebParent: 'TOTAL' },
      ],
    });
  });

  it('lists categories untagged with a notice when a scheme catalog fails to load', async () => {
    stubSchemeCatalogs(['EB10S.json']);
    const result = await runToolContract(listServiceCategoriesTool, { parent_code: 'TOTAL' });
    expect(result.isError).not.toBe(true);
    expect(listing(result).categories).toStrictEqual([
      { id: '3', description: '3 Transport', parent: 'TOTAL' },
      { id: '4', description: '4 Travel', parent: 'TOTAL' },
      { id: '7', description: '7 Financial services', parent: 'TOTAL' },
    ]);
    expect(result.structuredContent).toMatchObject({ notice: UNTAGGED_EB10S });
    expect(contentText(result)).toContain(UNTAGGED_EB10S);
    expect(contentText(result)).not.toContain('Schemes:');
    // Untagged, EB.json's parents stand: 200 reaches only the EB02 top level.
    const top = await runToolContract(listServiceCategoriesTool, { parent_code: '200' });
    expect(listing(top).categories.map((c) => c.id)).toEqual(['205', '260']);
  });

  it('sends the untagged and truncation notices in one notice', async () => {
    stubSchemeCatalogs(['EB02.json']);
    const result = await runToolContract(listServiceCategoriesTool, { limit: 2 });
    const notice =
      "EB scheme catalogs unavailable (EB02.json): categories are listed without scheme tags and with the combined EB catalog's parents, which put EB10's top-level codes under TOTAL instead of 200. Retry later for scheme tags. Showing 2 of 11 categories. Continue with offset=2 and the same query and parent_code, or narrow the query.";
    expect(result.structuredContent).toMatchObject({ notice });
    expect(contentText(result)).toContain(notice);
  });

  it('propagates cancellation during scheme catalog loading instead of listing untagged', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_input, options) => {
      const pending = new Promise<Response>((_resolve, reject) =>
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
          once: true,
        }),
      );
      controller.abort();
      return pending;
    });
    vi.stubGlobal('fetch', fetchMock);
    const ctx = createMockContext({ signal: controller.signal });
    await expect(
      (async () =>
        listServiceCategoriesTool.handler(listServiceCategoriesTool.input.parse({}), ctx))(),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalled();
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('caps the default page at 100 and pages by nextOffset to the full ordered listing', async () => {
    const rows = Array.from({ length: 101 }, (_, i) => ({
      id: `X${i}`,
      text: `Category ${i}`,
      parent: 'X',
    }));
    seedReferenceService(rows);
    const first = await runToolContract(listServiceCategoriesTool, {});
    expect(listing(first)).toMatchObject({
      totalMatches: 101,
      shown: 100,
      truncated: true,
      offset: 0,
      nextOffset: 100,
    });
    const notice =
      'Showing 100 of 101 categories. Continue with offset=100 and the same query and parent_code, or narrow the query.';
    expect(first.structuredContent).toMatchObject({ notice });
    expect(contentText(first)).toContain(notice);
    expect(contentText(first)).toContain('**Offset:** 0 | **Next offset:** 100');
    const walked: string[] = [];
    const pageSizes: number[] = [];
    let offset = 0;
    for (;;) {
      const out = listing(
        await runToolContract(listServiceCategoriesTool, { parent_code: 'x', limit: 40, offset }),
      );
      expect(out).toMatchObject({ offset, totalMatches: 101 });
      walked.push(...out.categories.map((c) => c.id));
      pageSizes.push(out.shown);
      if (out.nextOffset === undefined) break;
      expect(out.nextOffset).toBe(offset + out.shown);
      offset = out.nextOffset;
    }
    expect(walked).toEqual(rows.map((row) => row.id));
    expect(pageSizes).toEqual([40, 40, 21]);
  });

  it.each([11, 50])(
    'returns an empty page with the true total at offset %i (at or past the end)',
    async (offset) => {
      const result = await runToolContract(listServiceCategoriesTool, { offset });
      expect(listing(result)).toStrictEqual({
        categories: [],
        totalMatches: 11,
        shown: 0,
        truncated: true,
        offset,
      });
      const notice = `Offset ${offset} is past the end of the 11 matching categories. Use an offset below 11.`;
      expect(result.structuredContent).toMatchObject({ notice });
      expect(contentText(result)).toContain(notice);
      expect(contentText(result)).not.toContain('No EBOPS service categories matched');
    },
  );

  it('keeps the no-match notice for a query without matches at any offset', async () => {
    const result = await runToolContract(listServiceCategoriesTool, {
      query: 'zzz_nonexistent',
      offset: 5,
    });
    expect(listing(result)).toStrictEqual({
      categories: [],
      totalMatches: 0,
      shown: 0,
      truncated: false,
      offset: 5,
    });
    const notice =
      'No EBOPS service categories matched "zzz_nonexistent". Try a different keyword or remove the parent_code filter.';
    expect(result.structuredContent).toMatchObject({ notice });
    expect(contentText(result)).toContain(notice);
  });

  it('lists every category for a blank, empty, or omitted query', async () => {
    const omitted = listing(await runToolContract(listServiceCategoriesTool, {}));
    expect(omitted.totalMatches).toBe(11);
    for (const query of ['   ', '', '\t\n']) {
      const result = await runToolContract(listServiceCategoriesTool, { query });
      expect(result.isError).not.toBe(true);
      expect(listing(result)).toStrictEqual(omitted);
      expect(result.structuredContent).not.toHaveProperty('notice');
    }
  });

  it('echoes the trimmed query in the no-match notice and the log', async () => {
    const ctx = createMockContext();
    await listServiceCategoriesTool.handler(
      listServiceCategoriesTool.input.parse({ query: ' zzz\t' }),
      ctx,
    );
    expect(getEnrichment(ctx).notice).toBe(
      'No EBOPS service categories matched "zzz". Try a different keyword or remove the parent_code filter.',
    );
    expect((ctx.log as MockContextLogger).calls).toContainEqual(
      expect.objectContaining({
        msg: 'comtrade_list_service_categories',
        data: expect.objectContaining({ query: 'zzz' }),
      }),
    );
  });

  it('ranks the exact code and code prefixes first and pages through that order', async () => {
    const ranked = ['S', 'SG', '200', '3', '3.1', '3.2', '7', '205', '260', '3a.3.1'];
    const all = await runToolContract(listServiceCategoriesTool, { query: 's' });
    expect(listing(all).categories.map((c) => c.id)).toEqual(ranked);
    expect(contentText(all).match(/\n\*\*([^*]+)\*\* — /)?.[1]).toBe('S');
    const walked: string[] = [];
    let offset = 0;
    for (;;) {
      const out = listing(
        await runToolContract(listServiceCategoriesTool, { query: 's', limit: 4, offset }),
      );
      expect(out).toMatchObject({ offset, totalMatches: 10 });
      walked.push(...out.categories.map((c) => c.id));
      if (out.nextOffset === undefined) break;
      expect(out.nextOffset).toBe(offset + out.shown);
      offset = out.nextOffset;
    }
    expect(walked).toEqual(ranked);
  });

  it('advertises query as an optional string and categories as ranked', () => {
    const schema = z.toJSONSchema(listServiceCategoriesTool.input, { io: 'input' });
    expect(schema.properties?.query).toStrictEqual({
      type: 'string',
      description: expect.stringContaining('"3.1"'),
    });
    expect(schema.required ?? []).not.toContain('query');
    const { description } = listServiceCategoriesTool.output.shape.categories;
    expect(description).not.toContain('in catalog order');
    expect(description).toContain(
      'ranked exact code, code prefix, whole-word description match, then other description matches',
    );
  });

  it('formats output with category IDs, descriptions, parents, schemes, and paging', () => {
    const output = {
      categories: [
        {
          id: '3',
          description: '3 Transport',
          parent: '200',
          ebParent: 'TOTAL',
          schemes: ['EB10'],
        },
        { id: '3.1', description: '3.1 Sea transport', parent: '3', schemes: ['EB10'] },
        { id: 'X', description: 'Untagged root' },
      ],
      totalMatches: 5,
      shown: 3,
      truncated: true,
      offset: 0,
      nextOffset: 3,
    } satisfies Parameters<NonNullable<typeof listServiceCategoriesTool.format>>[0];
    const blocks = listServiceCategoriesTool.format!(output);
    expect(blocks[0]?.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain(
      '**Matches:** 5 | **Shown:** 3 | **Truncated:** yes\n**Offset:** 0 | **Next offset:** 3',
    );
    expect(text).toContain(
      '**3** — 3 Transport\n  Parent: 200 (EB catalog parent: TOTAL) | Schemes: EB10',
    );
    expect(text).toContain('**3.1** — 3.1 Sea transport\n  Parent: 3 | Schemes: EB10');
    expect(text).toMatch(/\*\*X\*\* — Untagged root$/);
  });
});
