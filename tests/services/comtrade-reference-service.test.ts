/**
 * @fileoverview Reference loading, country identity, and classification discovery regressions.
 * @module tests/services/comtrade-reference-service.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { logger } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { countriesResource } from '@/mcp-server/resources/definitions/countries.resource.js';
import { hsClassificationResource } from '@/mcp-server/resources/definitions/hs-classification.resource.js';
import { listServiceCategoriesTool } from '@/mcp-server/tools/definitions/list-service-categories.tool.js';
import { lookupCountriesTool } from '@/mcp-server/tools/definitions/lookup-countries.tool.js';
import { searchCommoditiesTool } from '@/mcp-server/tools/definitions/search-commodities.tool.js';
import { initComtradeReferenceService } from '@/services/comtrade-reference/comtrade-reference-service.js';

const config = {} as Parameters<typeof initComtradeReferenceService>[0];
const storage = {} as Parameters<typeof initComtradeReferenceService>[1];
type ReferenceService = ReturnType<typeof initComtradeReferenceService>;

/** A Reporters.json row: upstream writes identity twice, as id/text and reporterCode/reporterDesc. */
function reporterRow(
  id: number,
  text: string,
  iso2: string,
  iso3: string,
  effective: string,
  expired?: string,
) {
  return {
    id,
    text,
    reporterCode: id,
    reporterDesc: text,
    reporterCodeIsoAlpha2: iso2,
    reporterCodeIsoAlpha3: iso3,
    entryEffectiveDate: `${effective}T00:00:00`,
    ...(expired && { entryExpiredDate: `${expired}T00:00:00` }),
    isGroup: false,
  };
}

/** A partnerAreas.json row: id/text plus PartnerCode/PartnerDesc; World carries no ISO-2. */
function partnerRow(
  id: number,
  text: string,
  iso2: string | undefined,
  iso3: string,
  effective: string,
  expired?: string,
) {
  return {
    id,
    text,
    PartnerCode: id,
    PartnerDesc: text,
    ...(iso2 && { PartnerCodeIsoAlpha2: iso2 }),
    PartnerCodeIsoAlpha3: iso3,
    entryEffectiveDate: `${effective}T00:00:00`,
    ...(expired && { entryExpiredDate: `${expired}T00:00:00` }),
    isGroup: false,
  };
}

// Selected records from the captured UN Comtrade reference files; spellings are upstream's.
const bodies = new Map<string, unknown>([
  [
    'Reporters.json',
    {
      results: [
        reporterRow(842, 'USA', 'US', 'USA', '1981-01-01'),
        reporterRow(36, 'Australia', 'AU', 'AUS', '1900-01-01'),
        reporterRow(276, 'Germany', 'DE', 'DEU', '1991-01-01'),
        reporterRow(280, 'Fed. Rep. of Germany (...1990)', 'DE', 'DEU', '1900-01-01', '1990-12-31'),
        reporterRow(278, 'Dem. Rep. of Germany (...1990)', 'DD', 'DDR', '1900-01-01', '1990-12-31'),
        reporterRow(704, 'Viet Nam', 'VN', 'VNM', '1975-01-01'),
        reporterRow(866, 'Dem. Rep. of Vietnam (...1974)', 'VD', 'VDR', '1900-01-01', '1974-12-31'),
        reporterRow(868, 'Rep. of Vietnam (...1974)', 'VN', 'VNM', '1900-01-01', '1974-12-31'),
        reporterRow(251, 'France', 'FR', 'FRA', '1900-01-01'),
        reporterRow(579, 'Norway', 'NO', 'NOR', '1900-01-01'),
        reporterRow(757, 'Switzerland', 'CH', 'CHE', '1900-01-01'),
        reporterRow(200, 'Czechoslovakia (...1992)', 'CS', 'CSK', '1900-01-01', '1992-12-31'),
        reporterRow(
          891,
          'Serbia and Montenegro (...2005)',
          'CS',
          'SCG',
          '1992-01-01',
          '2006-05-31',
        ),
        reporterRow(535, 'Bonaire', 'BQ', 'BES', '2010-11-01'),
      ],
    },
  ],
  [
    'partnerAreas.json',
    {
      results: [
        partnerRow(840, 'United States of America', 'US', 'USA', '1900-01-01'),
        partnerRow(841, 'USA and Puerto Rico (...1980)', 'US', 'USA', '1900-01-01', '1980-12-31'),
        { ...partnerRow(0, 'World', undefined, 'W00', '1901-01-01'), isGroup: true },
        partnerRow(250, 'Metropolitan France', 'FR', 'FRA', '1900-01-01'),
        partnerRow(578, 'Norway, excluding Svalbard and Jan Mayen', 'NO', 'NOR', '1900-01-01'),
        partnerRow(756, 'Switzerland', 'CH', 'CHE', '1900-01-01'),
        partnerRow(80, 'Br. Antarctic Terr.', 'BQ', 'ATB', '1900-01-01'),
        partnerRow(276, 'Germany', 'DE', 'DEU', '1991-01-01'),
      ],
    },
  ],
  [
    'HS.json',
    {
      results: [
        {
          id: '85',
          text: '85 - Electrical machinery and equipment and parts thereof; sound recorders and reproducers; television image and sound recorders and reproducers, parts and accessories of such articles',
          parent: 'TOTAL',
          aggrLevel: 2,
          isLeaf: '0',
        },
        {
          id: '8524',
          text: '8524 - Flat panel display modules, whether or not incorporating touch-sensitive screens',
          parent: '85',
          aggrLevel: 4,
          isLeaf: '0',
        },
        {
          id: '852411',
          text: '852411 - Flat panel display modules, whether or not incorporating touch-sensitive screens; of liquid crystals, without drivers or control circuits',
          parent: '8524',
          aggrLevel: 6,
          isLeaf: '1',
        },
      ],
    },
  ],
  [
    'H0.json',
    {
      results: [
        {
          id: '85',
          text: '85 - Electrical mchy equip parts thereof;  sound recorder etc',
          parent: 'TOTAL',
          aggrlevel: 2,
          isLeaf: '0',
        },
        {
          id: '8524',
          text: '8524 - Records, tapes and other recorded media for sound or other similarly recorded phenomena, including matrices and masters for the production of records, but excluding products of Chapter 37.',
          parent: '85',
          aggrlevel: 4,
          isLeaf: '0',
        },
        {
          id: '852410',
          text: '852410 - Gramophone records',
          parent: '8524',
          aggrlevel: 6,
          isLeaf: '1',
        },
      ],
    },
  ],
  [
    'EB10.json',
    {
      results: [
        { id: '200', text: 'Total EBOPS 2010 Services', parent: '#' },
        { id: '3', text: '3 Transport', parent: '200' },
        { id: '3.1', text: '3.1 Sea transport', parent: '3' },
        { id: '3.1.1', text: '3.1.1 Passenger', parent: '3.1' },
        { id: '7', text: '7 Financial services', parent: '200' },
      ],
    },
  ],
  [
    'EB10S.json',
    {
      results: [
        { id: 'S', text: 'Total EBOPS 2010 SDMX Services', parent: '#' },
        { id: 'SA', text: 'Manufacturing services on physical inputs owned by', parent: 'S' },
        { id: 'SG', text: 'Financial services', parent: 'S' },
      ],
    },
  ],
  [
    'EB02.json',
    {
      results: [
        { id: '200', text: 'TOTAL - Total EBOPS 2002 Services', parent: '#' },
        { id: '260', text: '6. Financial services', parent: '200' },
      ],
    },
  ],
  [
    'EB.json',
    {
      results: [
        { id: '200', text: 'Total EBOPS 2002/2010 Services', parent: '#' },
        { id: '3', text: '3 Transport', parent: 'TOTAL' },
        { id: '3.1', text: '3.1 Sea transport', parent: '3' },
        { id: '3.1.1', text: '3.1.1 Passenger', parent: '3.1' },
        { id: '7', text: '7 Financial services', parent: 'TOTAL' },
        { id: 'S', text: 'Total EBOPS 2010 SDMX Services', parent: '#' },
        { id: 'SA', text: 'Manufacturing services on physical inputs owned by', parent: 'S' },
        { id: 'SG', text: 'Financial services', parent: 'S' },
        { id: '260', text: '6. Financial services', parent: '200' },
        { id: '3a.3.1', text: '3a.3.1  Postal and courier services', parent: '3a.3' },
        { id: 'TOEB02', text: 'All EBOPS 2002 Commodities', parent: 'ALLEB' },
      ],
    },
  ],
  [
    'QuantityUnits.json',
    {
      results: [
        {
          qtyCode: -1,
          qtyAbbr: 'N/A',
          qtyDescription: 'Not available or not specified or no quantity.',
        },
        { qtyCode: 5, qtyAbbr: 'u', qtyDescription: 'Number of items' },
        { qtyCode: 8, qtyAbbr: 'kg', qtyDescription: 'Weight in kilograms' },
      ],
    },
  ],
]);

/** Reference file name a stubbed fetch call requested. */
function requestedFile(input: Parameters<typeof fetch>[0]): string {
  return new URL(String(input)).pathname.split('/').at(-1)!;
}

/**
 * Serve the captured catalogs, with per-file overrides (a string body is sent raw), from the
 * reference host only; anything else is rejected so no test reaches the rate-limited upstream.
 */
function stubFetch(
  overrides: Record<string, unknown> = {},
): ReturnType<typeof vi.fn<typeof fetch>> {
  const served = new Map([...bodies, ...Object.entries(overrides)]);
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.hostname !== 'comtradeapi.un.org') throw new Error(`Unexpected fetch to ${url.origin}`);
    const body = served.get(requestedFile(input));
    if (body === undefined) return new Response('missing', { status: 404 });
    return typeof body === 'string' ? new Response(body) : Response.json(body);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('ComtradeReferenceService', () => {
  let ref: ReturnType<typeof initComtradeReferenceService>;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let startupFiles: string[];
  beforeEach(async () => {
    ref = initComtradeReferenceService(config, storage);
    fetchMock = stubFetch();
    await ref.initialize();
    startupFiles = fetchMock.mock.calls.map(([input]) => requestedFile(input));
    fetchMock.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('characterizes combined HS hierarchy and prefix search at nested levels', async () => {
    expect(ref.searchHsCodes('8524').map((entry) => entry.id)).toEqual(['8524', '852411']);
    for (const [level, ids] of [
      ['2', ['85']],
      ['4', ['8524']],
      ['6', ['852411']],
    ] as const) {
      const result = hsClassificationResource.handler({ level }, createMockContext());
      expect(result.codes.map((entry) => entry.id)).toEqual(ids);
    }
    const capped = await runToolContract(searchCommoditiesTool, { query: '8524', limit: 1 });
    expect(capped.structuredContent).toMatchObject({ totalMatches: 2, shown: 1, truncated: true });
    expect(JSON.stringify(capped.content)).toContain('8524');
    const all = await runToolContract(searchCommoditiesTool, { query: '8524', limit: 201 });
    expect(all.structuredContent).toMatchObject({ shown: 2, truncated: false });
  });

  it.each(['US', 'USA', 'United States'])(
    'expands ISO identity and leads with reporter USA for %s',
    async (query) => {
      const result = await runToolContract(lookupCountriesTool, { query });
      expect(result.structuredContent).toMatchObject({
        matches: [
          { id: 842, name: 'USA', iso2: 'US', validAsReporter: true },
          { id: 840, name: 'United States of America', iso2: 'US', validAsReporter: false },
          { id: 841, name: 'USA and Puerto Rico (...1980)', iso2: 'US', validAsReporter: false },
          ...(query === 'US' ? [{ id: 36 }] : []),
        ],
      });
      expect(JSON.stringify(result.content)).toContain('ISO2: US');
      const reporter = await runToolContract(lookupCountriesTool, {
        query,
        role: 'reporter',
        include_groups: false,
      });
      expect(reporter.structuredContent).toMatchObject({
        matches: expect.arrayContaining([
          {
            id: 842,
            name: 'USA',
            iso2: 'US',
            iso3: 'USA',
            isGroup: false,
            validAsReporter: true,
            entryEffectiveDate: '1981-01-01',
          },
        ]),
      });
      expect(
        countriesResource
          .handler({}, createMockContext())
          .countries.find((entry) => entry.id === 840)?.iso2,
      ).toBe('US');
    },
  );

  it('uses the selected historical edition instead of HS.json descriptions', async () => {
    const result = await runToolContract(searchCommoditiesTool, {
      query: '8524',
      classification: 'H0',
    });
    expect(result.structuredContent).toMatchObject({
      matches: [
        {
          id: '8524',
          description:
            '8524 - Records, tapes and other recorded media for sound or other similarly recorded phenomena, including matrices and masters for the production of records, but excluding products of Chapter 37.',
          aggrLevel: 4,
        },
        { id: '852410', description: '852410 - Gramophone records', aggrLevel: 6 },
      ],
    });
    expect(JSON.stringify(result.content)).toContain('Gramophone records');
  });

  it('loads service discovery from EB and preserves nested numeric category parents', async () => {
    const result = await runToolContract(listServiceCategoriesTool, {});
    expect(result.structuredContent).toMatchObject({
      categories: expect.arrayContaining([
        {
          id: 'SA',
          description: 'Manufacturing services on physical inputs owned by',
          parent: 'S',
          schemes: ['EB10S'],
        },
      ]),
    });
    for (const [parent_code, id] of [
      ['3', '3.1'],
      ['3.1', '3.1.1'],
    ]) {
      const child = await runToolContract(listServiceCategoriesTool, { parent_code });
      expect(child.structuredContent).toMatchObject({ categories: [{ id, parent: parent_code }] });
      expect(JSON.stringify(child.content)).toContain(`Parent: ${parent_code}`);
    }
  });

  it('keeps historical catalog lookups and heading enumeration separate from default HS', async () => {
    const codes = await ref.getCommodityCodes('H0');
    expect(codes.get('8524')).toMatchObject({ aggrLevel: 4, parent: '85', isLeaf: false });
    expect(codes.get('852410')).toMatchObject({ aggrLevel: 6, parent: '8524', isLeaf: true });
    expect(
      Array.from(codes.values())
        .filter((entry) => entry.aggrLevel === 4)
        .map((entry) => entry.id),
    ).toEqual(['8524']);
    expect((await ref.getCommodityCodes('H0')).get('852410')?.text).toBe(
      '852410 - Gramophone records',
    );
    expect((await ref.getCommodityCodes('HS')).get('8524')?.text).toContain('Flat panel');
    expect(codes.has('852411')).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetchMock.mock.calls[0]![0])).pathname).toBe(
      '/files/v1/app/reference/H0.json',
    );
  });

  it.each(['SS', 'S1', 'S2', 'S3', 'S4'])(
    'preserves native SITC levels and nested hierarchy for %s',
    async (classification) => {
      // Sparse adversarial catalog exercises native levels and missing metadata independently of HS.
      fetchMock.mockResolvedValue(
        Response.json({
          results: [
            { id: '1', text: 'Beverages and tobacco', aggrlevel: 1 },
            { id: '11', text: 'Beverages', parent: '1', aggrLevel: 2 },
            { id: '112', text: 'Alcoholic beverages', parent: '11', aggrlevel: 3 },
            { id: '1121', text: 'Wine', parent: '112', aggrLevel: 4 },
            { id: '11211', text: 'Wine of fresh grapes', parent: '1121', aggrlevel: 5, isLeaf: 1 },
          ],
        }),
      );
      for (const [aggr_level, id] of [
        [1, '1'],
        [3, '112'],
        [5, '11211'],
      ]) {
        const result = await runToolContract(searchCommoditiesTool, {
          classification,
          query: '1',
          aggr_level,
        });
        expect(result.structuredContent).toMatchObject({
          classification,
          matches: [{ id, aggrLevel: aggr_level }],
          shown: 1,
          truncated: false,
        });
        expect(JSON.stringify(result.content)).toContain(`aggrLevel: ${aggr_level} (SITC)`);
        expect(JSON.stringify(result.content)).toContain(id);
      }
      const codes = await ref.getCommodityCodes(classification);
      expect(codes.get('112')?.parent).toBe('11');
      expect(codes.get('11211')?.parent).toBe('1121');
      expect(codes.get('1')).not.toHaveProperty('parent');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('renders classification, no matches, and invalid level recovery on both surfaces', async () => {
    const empty = await runToolContract(searchCommoditiesTool, {
      query: 'not-found',
      classification: 'H0',
    });
    expect(empty.structuredContent).toMatchObject({
      classification: 'H0',
      matches: [],
      totalMatches: 0,
      shown: 0,
      truncated: false,
    });
    expect(JSON.stringify(empty.content)).toContain('H0');
    expect(JSON.stringify(empty.content)).toContain('not-found');
    for (const [classification, aggr_level] of [
      ['H0', 3],
      ['S4', 6],
    ] as const) {
      const invalid = await runToolContract(searchCommoditiesTool, {
        query: '1',
        classification,
        aggr_level,
      });
      expect(invalid.isError).toBe(true);
      expect(invalid.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'invalid_aggregation_level',
            recovery: { hint: 'Use HS levels 2, 4, or 6, or SITC levels 1 through 5.' },
          },
        },
      });
      expect(JSON.stringify(invalid.content)).toContain('invalid_aggregation_level');
      expect(JSON.stringify(invalid.content)).toContain('Use HS levels 2, 4, or 6');
    }
    const invalid = await runToolContract(searchCommoditiesTool, {
      query: '1',
      classification: 'not-a-catalog',
    });
    expect(invalid.isError).toBe(true);
    expect(JSON.stringify(invalid.content)).toContain('classification');
  });

  it('loads units lazily and retains unavailable and unknown codes honestly', async () => {
    expect(fetchMock).not.toHaveBeenCalled();
    const units = await ref.getQuantityUnits();
    expect(units.get(8)).toEqual({
      qtyCode: 8,
      qtyAbbr: 'kg',
      qtyDescription: 'Weight in kilograms',
    });
    expect(units.get(5)?.qtyAbbr).toBe('u');
    expect(units.get(-1)).toEqual({
      qtyCode: -1,
      qtyAbbr: 'N/A',
      qtyDescription: 'Not available or not specified or no quantity.',
    });
    expect(units.get(999)).toBeUndefined();
    expect(await ref.getQuantityUnits()).toBe(units);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['commodity', 'quantity'] as const)(
    'does not cache a failed %s load and accepts an empty successful catalog',
    async (kind) => {
      const load = () =>
        kind === 'commodity' ? ref.getCommodityCodes('H0') : ref.getQuantityUnits();
      fetchMock.mockResolvedValueOnce(new Response('missing', { status: 404 }));
      await expect(load()).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
      fetchMock.mockResolvedValueOnce(Response.json({ results: [] }));
      expect((await load()).size).toBe(0);
      expect((await load()).size).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['commodity', 'quantity'] as const)(
    'does not cache or retry malformed %s catalogs',
    async (kind) => {
      const load = () =>
        kind === 'commodity' ? ref.getCommodityCodes('H0') : ref.getQuantityUnits();
      fetchMock.mockResolvedValueOnce(Response.json({ results: [{ id: 123 }] }));
      await expect(load()).rejects.toMatchObject({ code: JsonRpcErrorCode.SerializationError });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((await load()).size).toBe(3);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['commodity', 'quantity'] as const)(
    'caller cancellation cannot poison a concurrent %s load or its completed cache',
    async (kind) => {
      const load = (signal?: AbortSignal) =>
        kind === 'commodity' ? ref.getCommodityCodes('H0', signal) : ref.getQuantityUnits(signal);
      const controller = new AbortController();
      fetchMock.mockImplementationOnce(
        async (_url, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
              once: true,
            });
          }),
      );
      const cancelled = load(controller.signal);
      const rejected = expect(cancelled).rejects.toThrow();
      const success = load();
      controller.abort();
      await rejected;
      expect((await success).size).toBe(3);
      expect((await load()).size).toBe(3);
      await expect(load(controller.signal)).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it('retries a transient failure at the real fetch seam without caching it', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(new Response('temporarily unavailable', { status: 503 }));
    const pending = ref.getQuantityUnits();
    await vi.runAllTimersAsync();
    expect((await pending).get(8)?.qtyAbbr).toBe('kg');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('bounds optional quantity lookup with a ten-second shared retry deadline', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      async (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          });
        }),
    );
    const pending = ref.getQuantityUnits();
    const rejected = expect(pending).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { deadlineMs: 10_000 },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a fully read malformed JSON catalog', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{invalid-json'));
    await expect(ref.getQuantityUnits()).rejects.toMatchObject({
      code: JsonRpcErrorCode.SerializationError,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('propagates discovery cancellation through both tool response surfaces', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementationOnce(async (_url, options) => {
      const pending = new Promise<Response>((_resolve, reject) =>
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
          once: true,
        }),
      );
      controller.abort();
      return pending;
    });
    const result = await runToolContract(
      searchCommoditiesTool,
      { query: '85', classification: 'H0' },
      { context: { signal: controller.signal } },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
    expect(JSON.stringify(result.content)).toContain('was aborted');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps HS TOTAL at level 0: listed unfiltered, excluded from levels 2, 4 and 6', async () => {
    const hs = (bodies.get('HS.json') as { results: unknown[] }).results;
    const total = {
      id: 'TOTAL',
      text: 'Total - All H6 commodities',
      parent: '#',
      isLeaf: '0',
      aggrLevel: 0,
      standardUnitAbbr: 'n/a',
    };
    stubFetch({ 'HS.json': { results: [total, ...hs] } });
    await initComtradeReferenceService(config, storage).initialize();
    const unfiltered = await runToolContract(searchCommoditiesTool, { query: 'total' });
    expect(unfiltered.structuredContent).toMatchObject({
      matches: [
        {
          id: 'TOTAL',
          description: 'Total - All H6 commodities',
          aggrLevel: 0,
          parent: '#',
          isLeaf: false,
        },
      ],
      totalMatches: 1,
    });
    expect(JSON.stringify(unfiltered.content)).toContain('aggrLevel: 0 (Total)');
    for (const aggr_level of [2, 4, 6]) {
      const filtered = await runToolContract(searchCommoditiesTool, { query: 'total', aggr_level });
      expect(filtered.structuredContent).toMatchObject({ matches: [], totalMatches: 0 });
    }
    for (const [level, ids] of [
      ['2', ['85']],
      ['4', ['8524']],
      ['6', ['852411']],
    ] as const) {
      const result = hsClassificationResource.handler({ level }, createMockContext());
      expect(result.codes.map((entry) => entry.id)).toEqual(ids);
      expect(result.totalCount).toBe(1);
    }
  });

  it('derives HS levels from the code when upstream omits the level or gives a non-HS one', async () => {
    stubFetch({
      'HS.json': {
        results: [
          { id: 'TOTAL', text: 'Total - All H6 commodities' },
          { id: '85', text: '85 - Electrical machinery' },
          { id: '8524', text: '8524 - Flat panel display modules', aggrLevel: 5 },
          { id: '852411', text: '852411 - Flat panel display modules', aggrlevel: 6 },
        ],
      },
    });
    const fresh = initComtradeReferenceService(config, storage);
    await fresh.initialize();
    expect(['TOTAL', '85', '8524', '852411'].map((id) => fresh.getHsCode(id)?.aggrLevel)).toEqual([
      0, 2, 4, 6,
    ]);
  });

  it.each([
    ['H0', 'Total - All H0 Commodities', 'Total'],
    ['S4', 'Total - All S4 Commodities', 'SITC'],
  ])('keeps the lazy %s TOTAL at level 0 with its current label', async (edition, text, label) => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        results: [
          { id: 'TOTAL', text, parent: '#', isLeaf: '0', aggrlevel: 0 },
          { id: '11', text: '11 - Beverages', parent: 'TOTAL', isLeaf: '0', aggrlevel: 2 },
        ],
      }),
    );
    const result = await runToolContract(searchCommoditiesTool, {
      query: 'total',
      classification: edition,
    });
    expect(result.structuredContent).toMatchObject({
      matches: [{ id: 'TOTAL', aggrLevel: 0 }],
      totalMatches: 1,
    });
    expect(JSON.stringify(result.content)).toContain(`aggrLevel: 0 (${label})`);
    const filtered = await runToolContract(searchCommoditiesTool, {
      query: 'total',
      classification: edition,
      aggr_level: 2,
    });
    expect(filtered.structuredContent).toMatchObject({ matches: [], totalMatches: 0 });
  });

  it.each([
    ['Germany', 'any', [276, 278, 280]],
    ['Germany', 'reporter', [276, 278, 280]],
    ['vietnam', 'any', [704, 866, 868]],
    // Exact ISO-2 first; "de" also matches the "Dem. Rep." names.
    ['DE', 'any', [276, 280, 278, 866]],
    ['Czechoslovakia', 'any', [200]],
    ['Bonaire', 'any', [535]],
  ] as const)(
    'orders %s (role %s) current before expired and expands identity by ISO-3 only',
    async (query, role, ids) => {
      const result = await runToolContract(lookupCountriesTool, { query, role });
      expect(result.structuredContent).toMatchObject({
        matches: ids.map((id) => ({ id })),
        totalMatches: ids.length,
      });
      const text = JSON.stringify(result.content);
      const positions = ids.map((id) => text.indexOf(`(code: ${id})`));
      expect(positions.every((position) => position >= 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    },
  );

  it('carries entity validity dates on lookup matches and the countries resource', async () => {
    const result = await runToolContract(lookupCountriesTool, { query: 'DEU' });
    expect(result.structuredContent).toMatchObject({
      matches: [
        { id: 276, entryEffectiveDate: '1991-01-01' },
        { id: 280, entryEffectiveDate: '1900-01-01', entryExpiredDate: '1990-12-31' },
      ],
    });
    const [current] = (result.structuredContent as { matches: object[] }).matches;
    expect(current).not.toHaveProperty('entryExpiredDate');
    const text = JSON.stringify(result.content);
    expect(text).toContain('valid from 1991-01-01');
    expect(text).toContain('valid 1900-01-01 to 1990-12-31');
    const countries = countriesResource.output!.parse(
      countriesResource.handler({}, createMockContext()),
    );
    expect(countries.countries.find((entry) => entry.id === 280)).toMatchObject({
      entryEffectiveDate: '1900-01-01',
      entryExpiredDate: '1990-12-31',
    });
    expect(countries.countries.find((entry) => entry.id === 276)).toMatchObject({
      entryEffectiveDate: '1991-01-01',
    });
    expect(countries.countries.find((entry) => entry.id === 276)).not.toHaveProperty(
      'entryExpiredDate',
    );
  });

  it.each([
    [
      250,
      { referenceStatus: 'partner_only', name: 'Metropolitan France', suggestedReporterCode: 251 },
    ],
    [
      578,
      {
        referenceStatus: 'partner_only',
        name: 'Norway, excluding Svalbard and Jan Mayen',
        suggestedReporterCode: 579,
      },
    ],
    [756, { referenceStatus: 'partner_only', name: 'Switzerland', suggestedReporterCode: 757 }],
    [
      840,
      {
        referenceStatus: 'partner_only',
        name: 'United States of America',
        suggestedReporterCode: 842,
      },
    ],
    [0, { referenceStatus: 'partner_only', name: 'World' }],
    // ISO-2 BQ also names reporter 535 Bonaire (BES); only ISO-3 identity qualifies.
    [80, { referenceStatus: 'partner_only', name: 'Br. Antarctic Terr.' }],
    [276, { referenceStatus: 'reporter', name: 'Germany' }],
    [280, { referenceStatus: 'reporter', name: 'Fed. Rep. of Germany (...1990)' }],
    [999, { referenceStatus: 'unknown' }],
  ] as const)('reports reference status for code %i', (code, status) => {
    expect(ref.getReporterStatus(code)).toStrictEqual(status);
  });

  it('suggests the current reporter before an expired one and keeps USA ranking', async () => {
    const reporters = (bodies.get('Reporters.json') as { results: unknown[] }).results;
    stubFetch({
      'Reporters.json': {
        results: [
          ...reporters,
          reporterRow(
            841,
            'USA and Puerto Rico (...1980)',
            'US',
            'USA',
            '1900-01-01',
            '1980-12-31',
          ),
        ],
      },
    });
    const fresh = initComtradeReferenceService(config, storage);
    await fresh.initialize();
    expect(fresh.getReporterStatus(840)).toStrictEqual({
      referenceStatus: 'partner_only',
      name: 'United States of America',
      suggestedReporterCode: 842,
    });
    for (const query of ['US', 'USA', 'United States']) {
      const result = await runToolContract(lookupCountriesTool, { query });
      expect(result.structuredContent).toMatchObject({
        matches: [
          { id: 842, validAsReporter: true },
          { id: 841, validAsReporter: true, entryExpiredDate: '1980-12-31' },
          { id: 840, validAsReporter: false },
          ...(query === 'US' ? [{ id: 36 }] : []),
        ],
      });
    }
  });

  it('tags EB categories with scheme catalogs loaded lazily and re-parents EB10 top level', async () => {
    expect([...startupFiles].sort()).toEqual([
      'EB.json',
      'HS.json',
      'Reporters.json',
      'partnerAreas.json',
    ]);
    const listing = await ref.getServiceCategories();
    expect(listing.status).toBe('tagged');
    const byId = new Map(listing.categories.map((category) => [category.id, category]));
    expect(byId.get('200')).toStrictEqual({
      id: '200',
      text: 'Total EBOPS 2002/2010 Services',
      parent: '#',
      schemes: ['EB10', 'EB02'],
    });
    for (const id of ['3', '7']) {
      expect(byId.get(id)).toMatchObject({ parent: '200', ebParent: 'TOTAL', schemes: ['EB10'] });
    }
    expect(byId.get('3.1')).toStrictEqual({
      id: '3.1',
      text: '3.1 Sea transport',
      parent: '3',
      schemes: ['EB10'],
    });
    expect(byId.get('SG')).toStrictEqual({
      id: 'SG',
      text: 'Financial services',
      parent: 'S',
      schemes: ['EB10S'],
    });
    expect(byId.get('260')).toStrictEqual({
      id: '260',
      text: '6. Financial services',
      parent: '200',
      schemes: ['EB02'],
    });
    // Absent from every scheme catalog: no tag, and an orphan parent no scheme catalog replaces.
    expect(byId.get('3a.3.1')).toStrictEqual({
      id: '3a.3.1',
      text: '3a.3.1  Postal and courier services',
      parent: '3a.3',
      schemes: [],
    });
    expect(byId.get('TOEB02')).toStrictEqual({
      id: 'TOEB02',
      text: 'All EBOPS 2002 Commodities',
      parent: 'ALLEB',
      schemes: [],
    });
    expect(listing.categories).toHaveLength(11);
    expect(fetchMock.mock.calls.map(([input]) => requestedFile(input)).sort()).toEqual([
      'EB02.json',
      'EB10.json',
      'EB10S.json',
    ]);
    expect(await ref.getServiceCategories('financial')).toMatchObject({
      status: 'tagged',
      categories: [
        { id: '7', parent: '200', schemes: ['EB10'] },
        { id: 'SG', schemes: ['EB10S'] },
        { id: '260', schemes: ['EB02'] },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('returns untagged EB categories when a scheme catalog fails, without caching it', async () => {
    const warning = vi.spyOn(logger, 'warning');
    const failing = stubFetch({ 'EB10S.json': undefined });
    const degraded = await ref.getServiceCategories();
    expect(degraded).toMatchObject({ status: 'untagged', unavailableCatalogs: ['EB10S.json'] });
    expect(degraded.categories.find((category) => category.id === '7')).toStrictEqual({
      id: '7',
      text: '7 Financial services',
      parent: 'TOTAL',
    });
    expect(degraded.categories).toHaveLength(11);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('EB10S.json'),
      expect.objectContaining({
        extra: expect.objectContaining({ unavailableCatalogs: ['EB10S.json'] }),
      }),
    );
    expect(failing.mock.calls.map(([input]) => requestedFile(input)).sort()).toEqual([
      'EB02.json',
      'EB10.json',
      'EB10S.json',
    ]);
    const recovered = stubFetch();
    expect((await ref.getServiceCategories()).status).toBe('tagged');
    expect(recovered.mock.calls.map(([input]) => requestedFile(input))).toEqual(['EB10S.json']);
  });

  it('treats an empty scheme catalog as unavailable rather than caching it', async () => {
    stubFetch({ 'EB10S.json': { results: [] } });
    const degraded = await ref.getServiceCategories();
    expect(degraded).toMatchObject({ status: 'untagged', unavailableCatalogs: ['EB10S.json'] });
    const recovered = stubFetch();
    expect((await ref.getServiceCategories('SG')).categories).toMatchObject([
      { id: 'SG', schemes: ['EB10S'] },
    ]);
    expect(recovered.mock.calls.map(([input]) => requestedFile(input))).toEqual(['EB10S.json']);
  });

  it('propagates caller cancellation from scheme catalog loading', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(
      async (_input, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          });
        }),
    );
    const pending = ref.getServiceCategories(undefined, controller.signal);
    const rejected = expect(pending).rejects.toThrow();
    controller.abort();
    await rejected;
    await expect(ref.getServiceCategories('financial', controller.signal)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('reference catalog row validation', () => {
  const bad = { id: null, text: null };
  const resultsOf = (file: string) => (bodies.get(file) as { results: unknown[] }).results;
  let warning: MockInstance<typeof logger.warning>;
  beforeEach(() => {
    warning = vi.spyOn(logger, 'warning');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('starts with a partner-shaped Reporters.json row and indexes it as a reporter', async () => {
    const reporters = resultsOf('Reporters.json');
    const falkland = {
      id: 238,
      text: 'Falkland Isds (Malvinas)',
      PartnerCode: 238,
      PartnerDesc: 'Falkland Isds (Malvinas)',
      PartnerCodeIsoAlpha2: 'FK',
      PartnerCodeIsoAlpha3: 'FLK',
      entryEffectiveDate: '1900-01-01T00:00:00',
      isGroup: false,
    };
    stubFetch({
      'Reporters.json': { results: [...reporters.slice(0, 2), falkland, ...reporters.slice(2)] },
    });
    await initComtradeReferenceService(config, storage).initialize();
    for (const query of ['Falkland', 'FK', 'FLK']) {
      const result = await runToolContract(lookupCountriesTool, { query, role: 'reporter' });
      expect(result.structuredContent).toMatchObject({
        matches: [
          {
            id: 238,
            name: 'Falkland Isds (Malvinas)',
            iso2: 'FK',
            iso3: 'FLK',
            validAsReporter: true,
            isGroup: false,
          },
        ],
        totalMatches: 1,
      });
      expect(JSON.stringify(result.content)).toContain('reporter ✓');
    }
    expect(warning).not.toHaveBeenCalled();
  });

  it.each<{ file: string; rows?: unknown[]; load: (ref: ReferenceService) => Promise<number> }>([
    {
      file: 'Reporters.json',
      load: async (ref) => {
        await ref.initialize();
        return ref.getAllCountries().filter((entry) => entry.validAsReporter).length;
      },
    },
    {
      file: 'H0.json',
      load: async (ref) => {
        await ref.initialize();
        return (await ref.getCommodityCodes('H0')).size;
      },
    },
    {
      file: 'S4.json',
      rows: [
        { id: '1', text: 'Beverages and tobacco', aggrlevel: 1 },
        { id: '11', text: 'Beverages', parent: '1', aggrlevel: 2 },
      ],
      load: async (ref) => {
        await ref.initialize();
        return (await ref.getCommodityCodes('S4')).size;
      },
    },
    {
      file: 'QuantityUnits.json',
      load: async (ref) => {
        await ref.initialize();
        return (await ref.getQuantityUnits()).size;
      },
    },
  ])(
    'drops an invalid $file row with a warning naming the file and row position',
    async ({ file, rows, load }) => {
      const valid = rows ?? resultsOf(file);
      stubFetch({ [file]: { results: [valid[0], bad, ...valid.slice(1)] } });
      expect(await load(initComtradeReferenceService(config, storage))).toBe(valid.length);
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining(file),
        expect.objectContaining({
          extra: expect.objectContaining({
            filename: file,
            droppedRows: [expect.objectContaining({ index: 1 })],
          }),
        }),
      );
    },
  );

  it('accepts exactly half valid rows and rejects fewer than half with the invalid-row count', async () => {
    const units = resultsOf('QuantityUnits.json');
    const h0 = resultsOf('H0.json');
    const fetchMock = stubFetch({
      'QuantityUnits.json': { results: [units[0], bad] },
      'H0.json': { results: [h0[0], bad, bad] },
    });
    const ref = initComtradeReferenceService(config, storage);
    await ref.initialize();
    fetchMock.mockClear();
    expect((await ref.getQuantityUnits()).size).toBe(1);
    await expect(ref.getCommodityCodes('H0')).rejects.toMatchObject({
      code: JsonRpcErrorCode.SerializationError,
      message: 'Comtrade returned invalid reference entries. Retry later.',
      data: { filename: 'H0.json', invalidRowCount: 2, rowCount: 3 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    stubFetch();
    expect((await ref.getCommodityCodes('H0')).size).toBe(h0.length);
  });

  it('stops startup when fewer than half the rows of a startup catalog are valid', async () => {
    stubFetch({ 'Reporters.json': { results: [resultsOf('Reporters.json')[0], bad, bad] } });
    await expect(initComtradeReferenceService(config, storage).initialize()).rejects.toMatchObject({
      code: JsonRpcErrorCode.SerializationError,
      data: { filename: 'Reporters.json', invalidRowCount: 2, rowCount: 3 },
    });
  });

  it.each(['Reporters.json', 'partnerAreas.json', 'HS.json', 'EB.json'])(
    'stops startup when %s is empty',
    async (file) => {
      stubFetch({ [file]: { results: [] } });
      await expect(
        initComtradeReferenceService(config, storage).initialize(),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.SerializationError,
        data: { filename: file },
      });
    },
  );

  it('reads a bare-array catalog and isGroup in boolean, number and string spellings', async () => {
    stubFetch({
      'partnerAreas.json': [
        { ...partnerRow(0, 'World', undefined, 'W00', '1901-01-01'), isGroup: true },
        { ...partnerRow(97, 'European Union', 'EU', 'EUR', '1900-01-01'), isGroup: 1 },
        { ...partnerRow(490, 'Other Asia, nes', undefined, 'S19', '1900-01-01'), isGroup: '1' },
        { ...partnerRow(250, 'Metropolitan France', 'FR', 'FRA', '1900-01-01'), isGroup: '0' },
      ],
    });
    const ref = initComtradeReferenceService(config, storage);
    await ref.initialize();
    expect([0, 97, 490, 250].map((code) => ref.getCountryByCode(code)?.isGroup)).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it('limits role "partner" to partnerAreas.json entries, leaving reporter-only codes out', async () => {
    stubFetch({
      'Reporters.json': {
        results: [
          { ...reporterRow(97, 'European Union', 'EU', 'EUR', '1900-01-01'), isGroup: true },
          reporterRow(251, 'France', 'FR', 'FRA', '1900-01-01'),
        ],
      },
      'partnerAreas.json': {
        results: [
          partnerRow(251, 'France', 'FR', 'FRA', '1900-01-01'),
          partnerRow(250, 'Metropolitan France', 'FR', 'FRA', '1900-01-01'),
        ],
      },
    });
    const ref = initComtradeReferenceService(config, storage);
    await ref.initialize();
    expect(ref.searchCountries('European', 'any').map((entry) => entry.id)).toEqual([97]);
    expect(ref.searchCountries('European', 'partner')).toEqual([]);
    expect(ref.searchCountries('France', 'partner').map((entry) => entry.id)).toEqual([251, 250]);
    expect(ref.searchCountries('France', 'reporter').map((entry) => entry.id)).toEqual([251]);
  });

  it('retries an HTML error page instead of parsing it as a catalog', async () => {
    const fetchMock = stubFetch();
    const ref = initComtradeReferenceService(config, storage);
    await ref.initialize();
    fetchMock.mockClear();
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(
      new Response('<!DOCTYPE html><html><body>Service Unavailable</body></html>', {
        headers: { 'content-type': 'text/html' },
      }),
    );
    const pending = ref.getQuantityUnits();
    await vi.runAllTimersAsync();
    expect((await pending).get(8)?.qtyAbbr).toBe('kg');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
