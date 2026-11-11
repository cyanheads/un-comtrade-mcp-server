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
    // The exact name ranks first and pulls in 280, which shares its ISO-3 code, at its rank.
    ['Germany', 'any', [276, 280, 278]],
    ['Germany', 'reporter', [276, 280, 278]],
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
      {
        referenceStatus: 'partner_only',
        name: 'Metropolitan France',
        suggestedReporterCode: 251,
        suggestionBasis: 'iso3',
      },
    ],
    [
      578,
      {
        referenceStatus: 'partner_only',
        name: 'Norway, excluding Svalbard and Jan Mayen',
        suggestedReporterCode: 579,
        suggestionBasis: 'iso3',
      },
    ],
    [
      756,
      {
        referenceStatus: 'partner_only',
        name: 'Switzerland',
        suggestedReporterCode: 757,
        suggestionBasis: 'iso3',
      },
    ],
    [
      840,
      {
        referenceStatus: 'partner_only',
        name: 'United States of America',
        suggestedReporterCode: 842,
        suggestionBasis: 'iso3',
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
      suggestionBasis: 'iso3',
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

/** Selected HS.json rows after TOTAL, in catalog order; spellings are upstream's. */
const RANKED_HS_TEXTS = [
  '0306 - Crustaceans; in shell or not, live, fresh, chilled, frozen, dried, salted or in brine; smoked, cooked or not before or during smoking; in shell, steamed or boiled, whether or not chilled, frozen, dried, salted or in brine',
  "0408 - Birds' eggs, not in shell; egg yolks, fresh, dried, cooked by steaming or boiling in water, moulded, frozen or otherwise preserved, whether or not containing added sugar or other sweetening matter",
  '0710 - Vegetables (uncooked or cooked by steaming or boiling in water); frozen',
  '0811 - Fruit and nuts; uncooked or cooked by steaming or boiling in water, frozen, whether or not containing added sugar or other sweetening matter',
  '09 - Coffee, tea, mate and spices',
  '0901 - Coffee, whether or not roasted or decaffeinated; husks and skins; coffee substitutes containing coffee in any proportion',
  '090111 - Coffee; not roasted or decaffeinated',
  '090112 - Coffee; decaffeinated, not roasted',
  '090121 - Coffee; roasted, not decaffeinated',
  '090122 - Coffee; roasted, decaffeinated',
  '090130 - Coffee husks and skins',
  '090140 - Coffee substitutes containing coffee',
  '090190 - Coffee; husks and skins, coffee substitutes containing coffee in any proportion',
  '0902 - Tea',
  '1503 - Lard stearin, lard oil, oleostearin, oleo-oil and tallow oil; not emulsified or mixed or otherwise prepared',
  '2101 - Extracts, essences, concentrates of coffee, tea or mate; preparations with a basis of these products or with a basis of coffee, tea or mate; roasted chicory and other roasted coffee substitutes and extracts, essences and concentrates thereof',
  '2526 - Natural steatite; whether or not roughly trimmed or merely cut, by sawing or otherwise, into blocks or slabs of a rectangular (including square) shape; talc',
  '4014 - Hygienic or pharmaceutical articles (including teats), of vulcanised rubber other than hard rubber, with or without fittings of hard rubber',
  '6501 - Hat-forms, hat bodies and hoods of felt, neither blocked to shape nor with made brims; plateaux and manchons (including slit manchons) of felt',
  '6503 - Felt hats and other felt headgear, made from the hat bodies, hoods or plateaux of heading 65.01, whether or not lined or trimmed.',
  '8402 - Boilers; steam or other vapour generating (other than central heating hot water boilers, capable also of producing low pressure steam), super heated water boilers',
  '8404 - Auxiliary plant for use with boilers of heading no. 8402 or 8403; e.g. economisers, super-heaters, soot removers, gas recoverers), condensers for steam or other vapour power units',
  '8406 - Turbines; steam and other vapour turbines',
  '8424 - Mechanical appliances for projecting, dispersing or spraying liquids or powders; fire extinguishers, spray guns, steam, sand blasting machines',
  '8471 - Automatic data processing machines and units thereof, magnetic or optical readers, machines for transcribing data onto data media in coded form and machines for processing such data, not elsewhere specified or included',
  '847130 - Automatic data processing machines; portable, weighing not more than 10kg, consisting of at least a central processing unit, a keyboard and a display',
  '847141 - Automatic data processing machines; comprising in the same housing at least a central processing unit and an input and output unit, whether or not combined, n.e.c. in item no. 8471.30',
  '847149 - Automatic data processing machines; presented in the form of systems, n.e.c. in item no. 8471.30 or 8471.41',
  '9602 - Vegetable, mineral carving material and articles of these materials, moulded or carved articles of wax, stearin, natural gums, resins or modelling pastes, worked unhardened gelatin (not heading no. 3503)',
];

/** Selected S4.json rows in catalog order; SITC codes carry trailing X but never a separator. */
const RANKED_S4_TEXTS = [
  '00 - Live animals other than animals of division 03',
  '001 - Live animals other than animals of division 03',
  '001X - Memorandum Item',
  '001XX - Memorandum Item',
  '07 - Coffee, tea, cocoa, spices, and manufactures thereof',
  '071 - Coffee and coffee substitutes',
  '0711 - Coffee, not roasted, whether or not decaffeinated',
  '07111 - Coffee, not roasted, not decaffeinated',
  '07112 - Coffee, not roasted, decaffeinated',
  '0711X - Memorandum Item',
];

/** Selected EB.json rows in catalog order: dotted, mixed-case codes. */
const RANKED_EB_ROWS = [
  { id: '200', text: 'Total EBOPS 2002/2010 Services', parent: '#' },
  { id: 'S', text: 'Total EBOPS 2010 SDMX Services', parent: '#' },
  { id: '215', text: '1.3.1 Passenger', parent: '214' },
  { id: '246', text: '3.1 Postal and courier services', parent: '245' },
  { id: '310', text: 'Compensation of employees', parent: '900' },
  { id: '894', text: '8. Audiovisual transactions', parent: '999' },
  {
    id: '950',
    text: '1. Freight transportation on merchandise, valued on a transaction basis',
    parent: '999',
  },
  {
    id: '10.1.1.2',
    text: '10.1.1.2 Sale of proprietary rights arising from research and development',
    parent: '10.1.1',
  },
  { id: '3', text: '3 Transport', parent: 'TOTAL' },
  { id: '3.1', text: '3.1 Sea transport', parent: '3' },
  { id: '3.1.1', text: '3.1.1 Passenger', parent: '3.1' },
  {
    id: '3.1.1.a',
    text: '3.1.1.a Of which: Payable by border, seasonal, and other short-term workers',
    parent: '3.1.1',
  },
  { id: '3.1.2', text: '3.1.2 Freight', parent: '3.1' },
  { id: 'C.1', text: 'C.1 Audio-visual transactions', parent: 'TOTAL' },
  { id: 'SA', text: 'Manufacturing services on physical inputs owned by', parent: 'S' },
  { id: 'Say', text: 'Goods for processing in reporting economy — Goods ', parent: 'SA' },
  { id: 'Saz', text: 'Goods for processing abroad — Goods sent (credits)', parent: 'SA' },
];

/** Catalog rows from `<code> - <description>` texts; levels come from the code. */
function codedRows(texts: readonly string[]): { id: string; text: string }[] {
  return texts.map((text) => ({ id: text.slice(0, text.indexOf(' - ')), text }));
}

/** The match rule before ranking: code prefix (HS ids as given) or description substring. */
function substringMatches(
  rows: readonly { id: string; text: string }[],
  query: string,
  lowercaseIds: boolean,
): string[] {
  const q = query.toLowerCase();
  return rows
    .filter(
      (row) =>
        (lowercaseIds ? row.id.toLowerCase() : row.id).startsWith(q) ||
        row.text.toLowerCase().includes(q),
    )
    .map((row) => row.id);
}

/** Least thread CPU time, in microseconds per call, over several trials of `reps` calls. */
function cpuMicrosPerCall(run: () => unknown, reps: number): number {
  let least = Number.POSITIVE_INFINITY;
  for (let trial = 0; trial < 3; trial++) {
    const start = process.threadCpuUsage();
    for (let i = 0; i < reps; i++) run();
    const used = process.threadCpuUsage(start);
    least = Math.min(least, (used.user + used.system) / reps);
  }
  return least;
}

/**
 * Asserts `callAt(size)` grows at most linearly from `base` to 64× by doubling: at each size the
 * least cost ratio over up to three pairs, each re-timing the baseline beside it, stays under four
 * times the size ratio (256 over the full span, where quadratic growth reaches 4096). Pairing
 * stops once the least ratio is under the bound, since another pair can only lower it.
 */
function expectLinearGrowth(
  callAt: (size: number) => () => unknown,
  base: number,
  baseReps: number,
): void {
  const baseline = callAt(base);
  for (let size = base * 2; size <= base * 64; size *= 2) {
    const call = callAt(size);
    const reps = Math.max(1, Math.round((baseReps * base) / size));
    const bound = 4 * (size / base);
    let least = Number.POSITIVE_INFINITY;
    for (let pair = 0; pair < 3 && least >= bound; pair++) {
      const small = cpuMicrosPerCall(baseline, baseReps);
      least = Math.min(least, cpuMicrosPerCall(call, reps) / small);
    }
    expect(least, `cost ratio at ${size} against ${base}`).toBeLessThan(bound);
  }
}

describe('catalog search ranking', () => {
  const hsRows = [
    { id: 'TOTAL', text: 'Total - All H6 commodities', aggrLevel: 0 },
    ...codedRows(RANKED_HS_TEXTS),
  ];
  const s4Rows = codedRows(RANKED_S4_TEXTS);
  let ref: ReferenceService;
  beforeEach(async () => {
    stubFetch({
      'HS.json': { results: hsRows },
      'S4.json': { results: s4Rows },
      'EB.json': { results: RANKED_EB_ROWS },
    });
    ref = initComtradeReferenceService(config, storage);
    await ref.initialize();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const ids = (entries: readonly { id: string }[]) => entries.map((entry) => entry.id);

  it('keeps the match set and count of every separator-free query', async () => {
    const hsQueries = ['tea', 'TEA', 'coffee', 'oil', 'steam', 'a', '09', '0901', '8471', 'total'];
    for (const query of hsQueries) {
      const hs = ids(ref.searchHsCodes(query));
      expect(hs, query).toHaveLength(substringMatches(hsRows, query, false).length);
      expect(new Set(hs), query).toEqual(new Set(substringMatches(hsRows, query, false)));
    }
    for (const query of ['coffee', '001X', '0711', 'memorandum', '07']) {
      const s4 = ids(await ref.searchCommodityCodes(query, 'S4'));
      expect(new Set(s4), query).toEqual(new Set(substringMatches(s4Rows, query, true)));
      expect(s4, query).toHaveLength(substringMatches(s4Rows, query, true).length);
    }
    for (const query of ['SA', 'sa', '3', '3.1', 'transport', 'passenger', '31']) {
      const eb = ids(ref.searchEbopsCategories(query));
      expect(new Set(eb), query).toEqual(new Set(substringMatches(RANKED_EB_ROWS, query, true)));
      expect(eb, query).toHaveLength(substringMatches(RANKED_EB_ROWS, query, true).length);
    }
  });

  it.each(['0901.11', '0901 11', '0901-11', '09-01-11'])(
    'compares the HS code in %s without its separators',
    (query) => {
      expect(ids(ref.searchHsCodes(query))).toEqual(['090111']);
    },
  );

  it.each(['09.01', '0901.', '.0901'])(
    'finds HS heading 0901 first and its seven subheadings for %s',
    (query) => {
      expect(ids(ref.searchHsCodes(query))).toEqual([
        '0901',
        '090111',
        '090112',
        '090121',
        '090122',
        '090130',
        '090140',
        '090190',
      ]);
    },
  );

  it('ranks the exact code of "8471.30" before the codes whose descriptions cite it', () => {
    expect(ids(ref.searchHsCodes('8471.30'))).toEqual(['847130', '847141', '847149']);
  });

  it('strips separators in SITC codes and keeps a letter-bearing SITC code as typed', async () => {
    expect(ids(await ref.searchCommodityCodes('071.1', 'S4'))).toEqual([
      '0711',
      '07111',
      '07112',
      '0711X',
    ]);
    expect(ids(await ref.searchCommodityCodes('001X', 'S4'))).toEqual(['001X', '001XX']);
    expect(ids(await ref.searchCommodityCodes('0 7 1 1', 'S4', 5))).toEqual([
      '07111',
      '07112',
      '0711X',
    ]);
  });

  it('puts whole-word "tea" headings first and keeps the 16 level-4 matches', async () => {
    const tea = ids(await ref.searchCommodityCodes('tea', 'HS', 4));
    expect(tea).toEqual([
      '0902',
      '2101',
      '0306',
      '0408',
      '0710',
      '0811',
      '1503',
      '2526',
      '4014',
      '6501',
      '6503',
      '8402',
      '8404',
      '8406',
      '8424',
      '9602',
    ]);
    expect(ids(ref.searchHsCodes('tea')).slice(0, 3)).toEqual(['09', '0902', '2101']);
  });

  it('compares HS codes case-insensitively, so "total" ranks the TOTAL code first', () => {
    const reordered = initComtradeReferenceService(config, storage);
    // @ts-expect-error — seeding private map
    reordered.hsByCode = new Map(
      [
        { id: '9031', text: '9031 - Totalizers and counters', aggrLevel: 4 as const },
        { id: 'TOTAL', text: 'Total - All H6 commodities', aggrLevel: 0 as const },
      ].map((row) => [row.id, { ...row, isLeaf: false, recommendedQueryCode: row.id }]),
    );
    expect(ids(reordered.searchHsCodes('total'))).toEqual(['TOTAL', '9031']);
    expect(ids(reordered.searchHsCodes('tot'))).toEqual(['TOTAL', '9031']);
  });

  it('ranks EB codes case-insensitively and keeps their dots', () => {
    for (const query of ['SA', 'sa']) {
      expect(ids(ref.searchEbopsCategories(query))).toEqual([
        'SA',
        'Say',
        'Saz',
        '310',
        '894',
        '950',
        '10.1.1.2',
        'C.1',
      ]);
    }
    expect(ids(ref.searchEbopsCategories('3.1'))).toEqual([
      '3.1',
      '3.1.1',
      '3.1.1.a',
      '3.1.2',
      '215',
      '246',
    ]);
    expect(ids(ref.searchEbopsCategories('31'))).toEqual(['310']);
  });

  it('tables the tiers: exact, prefix, whole word past a first embedded hit, then substring', () => {
    const tiers = initComtradeReferenceService(config, storage);
    // @ts-expect-error — seeding private map
    tiers.ebopsByCode = new Map(
      [
        { id: 'X1', text: 'Teapots and teacups' },
        { id: 'X2', text: 'Steamed tea leaves' },
        { id: 'X3', text: 'Tea-based drinks' },
        { id: 'X4', text: 'Tea2go blends' },
        { id: 'X5', text: 'Ëtea imports' },
        { id: 'X6', text: 'Cocoa' },
        { id: 'TEA.1', text: 'Herbal infusions' },
        { id: 'TEA', text: 'Infusions' },
        { id: 'X7', text: 'xa a ab' },
        { id: 'X8', text: 'xa a a' },
        { id: 'X9', text: 'Tea0 blends' },
      ].map((row) => [row.id, row]),
    );
    for (const query of ['tea', 'TEA', 'Tea']) {
      expect(ids(tiers.searchEbopsCategories(query)), query).toEqual([
        'TEA',
        'TEA.1',
        'X2',
        'X3',
        'X1',
        'X4',
        'X5',
        'X9',
      ]);
    }
    // "a a" first occurs in X8 after "x"; only the overlapping occurrence after it stands alone.
    expect(ids(tiers.searchEbopsCategories('a a'))).toEqual(['X8', 'X7']);
  });

  describe('timing', () => {
    it.each<[string, (size: number) => string]>([
      ['a digit run', (size) => '1'.repeat(size)],
      ['a dotted digit run', (size) => '1.'.repeat(size / 2)],
      ['a digit run ending in a letter', (size) => `${'1'.repeat(size - 1)}x`],
      ['one long line ending in a break', (size) => `${'§1 x'.repeat(size / 4)}\ny`],
      ['breaks throughout', (size) => '  \r\n'.repeat(size / 4)],
    ])('scales linearly in query length for %s', (_shape, queryOf) => {
      for (const search of [
        (query: string) => () => ref.searchHsCodes(query),
        (query: string) => () => ref.searchEbopsCategories(query),
      ]) {
        expectLinearGrowth((size) => search(queryOf(size)), 5_000, 32);
      }
    });

    it('scales linearly in rows and description length when every position is a hit', () => {
      /** A catalog of `rows` descriptions, each `length` letters long: "aa" occurs, never whole. */
      const searchOf = (rows: number, length: number) => {
        const svc = initComtradeReferenceService(config, storage);
        // @ts-expect-error — seeding private map
        svc.hsByCode = new Map(
          Array.from({ length: rows }, (_, i) => {
            const id = String(100_000 + i);
            const text = 'a'.repeat(length);
            return [id, { id, text, aggrLevel: 6, isLeaf: true, recommendedQueryCode: id }];
          }),
        );
        return () => svc.searchHsCodes('aa');
      };
      // Short descriptions keep per-row work small, so a cost growing with the row count shows.
      expectLinearGrowth((rows) => searchOf(rows, 4), 250, 16);
      expectLinearGrowth((length) => searchOf(64, length), 32, 16);
    });

    // The letter-or-digit refinement is a regex: shapes that reach it stay under Bun's ~80k switch.
    it.each<[string, (size: number) => string, number]>([
      ['a digit run', (size) => '1'.repeat(size), 5_000],
      ['one long line ending in a break', (size) => `${'§1 x'.repeat(size / 4)}\ny`, 1_200],
      ['breaks throughout', (size) => '  \r\n'.repeat(size / 4), 1_200],
      ['punctuation only', (size) => '.-'.repeat(size / 2), 1_200],
    ])('validates query input linearly in its length for %s', (_shape, queryOf, base) => {
      for (const definition of [searchCommoditiesTool, listServiceCategoriesTool]) {
        expectLinearGrowth(
          (size) => {
            const input = { query: queryOf(size) };
            return () => definition.input.safeParse(input);
          },
          base,
          32,
        );
      }
    });
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

describe('country lookup by common, official, and accent-free names', () => {
  // Captured rows; names, ISO codes, notes, and trailing spaces are upstream's.
  const reporters = [
    reporterRow(826, 'United Kingdom', 'GB', 'GBR', '1900-01-01'),
    reporterRow(804, 'Ukraine', 'UA', 'UKR', '1992-01-01'),
    {
      ...reporterRow(410, 'Rep. of Korea', 'KR', 'KOR', '1900-01-01'),
      reporterNote: 'Republic of Korea',
    },
    {
      ...reporterRow(408, "Dem. People's Rep. of Korea", 'KP', 'PRK', '1900-01-01'),
      reporterNote: "Democratic People's Republic of Korea",
    },
    reporterRow(792, 'Türkiye', 'TR', 'TUR', '1900-01-01'),
    reporterRow(203, 'Czechia', 'CZ', 'CZE', '1993-01-01'),
    reporterRow(384, "Côte d'Ivoire", 'CI', 'CIV', '1900-01-01'),
    reporterRow(784, 'United Arab Emirates', 'AE', 'ARE', '1900-01-01'),
    reporterRow(418, "Lao People's Dem. Rep.", 'LA', 'LAO', '1900-01-01'),
    reporterRow(104, 'Myanmar', 'MM', 'MMR', '1900-01-01'),
    {
      ...reporterRow(446, 'China, Macao SAR', 'MO', 'MAC', '1900-01-01'),
      reporterNote: 'China, Macao Special Administrative Region',
    },
    reporterRow(528, 'Netherlands', 'NL', 'NLD', '1900-01-01'),
    {
      ...reporterRow(748, 'Eswatini', 'SZ', 'SWZ', '2000-01-01'),
      reporterNote: 'the Kingdom of Eswatini',
    },
    reporterRow(132, 'Cabo Verde', 'CV', 'CPV', '1900-01-01'),
    reporterRow(626, 'Timor-Leste', 'TL', 'TLS', '2002-05-20'),
    {
      ...reporterRow(180, 'Dem. Rep. of the Congo', 'CD', 'COD', '1900-01-01'),
      reporterNote: 'Democratic Republic of the Congo',
    },
    reporterRow(324, 'Guinea', 'GN', 'GIN', '1900-01-01'),
    reporterRow(226, 'Equatorial Guinea', 'GQ', 'GNQ', '1900-01-01'),
    reporterRow(624, 'Guinea-Bissau', 'GW', 'GNB', '1900-01-01'),
    reporterRow(729, 'Sudan', 'SD', 'SDN', '2011-07-01'),
    reporterRow(728, 'South Sudan', 'SS', 'SSD', '2011-07-01'),
    {
      ...reporterRow(736, 'Sudan (...2011)', 'SD', 'SDN', '1900-01-01', '2011-06-30'),
      reporterNote: 'Former Sudan',
    },
    reporterRow(442, 'Luxembourg', 'LU', 'LUX', '1999-01-01'),
    reporterRow(56, 'Belgium', 'BE', 'BEL', '1999-01-01'),
    {
      ...reporterRow(58, 'Belgium-Luxembourg (...1998)', 'BE', 'BEL', '1900-01-01', '1998-12-31'),
      reporterNote: 'Belgium-Luxembourg',
    },
    {
      ...reporterRow(842, 'USA', 'US', 'USA', '1981-01-01'),
      reporterNote: 'USA, Puerto Rico and US Virgin Islands',
    },
    {
      ...reporterRow(841, 'USA and Puerto Rico (...1980)', 'US', 'USA', '1900-01-01', '1980-12-31'),
      reporterNote: 'USA and Puerto Rico',
    },
    reporterRow(638, 'Réunion (Overseas France)', 'RE', 'REU', '1900-01-01', '1996-12-31'),
    reporterRow(531, 'Curaçao', 'CW', 'CUW', '2010-11-01'),
    {
      ...reporterRow(214, 'Dominican Rep.', 'DO', 'DOM', '1900-01-01'),
      reporterNote: 'Dominican Republic',
    },
    { ...reporterRow(251, 'France', 'FR', 'FRA', '1900-01-01'), reporterNote: 'France, Monaco' },
    reporterRow(276, 'Germany', 'DE', 'DEU', '1991-01-01'),
    {
      ...reporterRow(
        280,
        'Fed. Rep. of Germany (...1990)',
        'DE',
        'DEU',
        '1900-01-01',
        '1990-12-31',
      ),
      reporterNote: 'Former Federal Republic of Germany',
    },
    {
      ...reporterRow(
        278,
        'Dem. Rep. of Germany (...1990)',
        'DD',
        'DDR',
        '1900-01-01',
        '1990-12-31',
      ),
      reporterNote: 'Former Democratic Republic of Germany',
    },
    reporterRow(704, 'Viet Nam', 'VN', 'VNM', '1975-01-01'),
    {
      ...reporterRow(
        866,
        'Dem. Rep. of Vietnam (...1974)',
        'VD',
        'VDR',
        '1900-01-01',
        '1974-12-31',
      ),
      reporterNote: 'Former Democratic Republic of Vietnam',
    },
    {
      ...reporterRow(868, 'Rep. of Vietnam (...1974)', 'VN', 'VNM', '1900-01-01', '1974-12-31'),
      reporterNote: 'Former Republic of Vietnam',
    },
    {
      ...reporterRow(975, 'ASEAN', 'R4', 'R4 ', '1967-08-01'),
      isGroup: true,
      reporterNote: 'ASEAN',
    },
  ];
  const partners = [
    partnerRow(826, 'United Kingdom', 'GB', 'GBR', '1900-01-01'),
    partnerRow(804, 'Ukraine', 'UA', 'UKR', '1992-01-01'),
    {
      ...partnerRow(647, 'Ryukyu Isd', undefined, '_RI', '1900-01-01', '1972-12-31'),
      partnerNote: 'Ryukyu Island',
    },
    partnerRow(840, 'United States of America', 'US', 'USA', '1900-01-01'),
    partnerRow(630, 'Puerto Rico ', 'PR', 'PRI', '1900-01-01'),
    partnerRow(438, 'Liechtenstein ', 'LI', 'LIE', '1900-01-01'),
    { ...partnerRow(837, 'Bunkers', undefined, 'X1 ', '1900-01-01'), partnerNote: 'Bunkers' },
    partnerRow(250, 'Metropolitan France', 'FR', 'FRA', '1900-01-01'),
  ];
  let ref: ReferenceService;
  const ids = (query: string, role?: 'reporter' | 'partner') =>
    ref.searchCountries(query, role).map((entry) => entry.id);

  /** Least thread CPU time per call in microseconds, over several batches of `calls` calls. */
  function leastCpuPerCallUs(run: () => void, calls: number): number {
    let least = Number.POSITIVE_INFINITY;
    for (let sample = 0; sample < 5; sample++) {
      const start = process.threadCpuUsage();
      for (let call = 0; call < calls; call++) run();
      const used = process.threadCpuUsage(start);
      least = Math.min(least, (used.user + used.system) / calls);
    }
    return least;
  }

  /**
   * Doubles a query shape from `baseLength` to 64× and, at each size before the next, asserts the
   * least growth over a re-timed baseline stays under 4× the size ratio: linear growth is the size
   * ratio itself, quadratic its square (4,096 at the full span, against a bound of 256).
   */
  function expectLinearSearch(shape: (length: number) => string, baseLength: number): void {
    const perCall = (length: number) => {
      const query = shape(length);
      const calls = Math.max(1, Math.round((16 * baseLength) / length));
      return leastCpuPerCallUs(() => ref.searchCountries(query), calls);
    };
    for (let factor = 2; factor <= 64; factor *= 2) {
      let growth = Number.POSITIVE_INFINITY;
      for (let pair = 0; pair < 3; pair++) {
        growth = Math.min(growth, perCall(baseLength * factor) / perCall(baseLength));
      }
      expect(growth, `${baseLength * factor} vs ${baseLength} characters`).toBeLessThan(4 * factor);
    }
  }

  beforeEach(async () => {
    stubFetch({
      'Reporters.json': { results: reporters },
      'partnerAreas.json': { results: partners },
    });
    ref = initComtradeReferenceService(config, storage);
    await ref.initialize();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ['UK', 826],
    ['Britain', 826],
    ['Great Britain', 826],
    ['South Korea', 410],
    ['North Korea', 408],
    ['Turkey', 792],
    ['Czech Republic', 203],
    ['Ivory Coast', 384],
    ['UAE', 784],
    ['Laos', 418],
    ['Burma', 104],
    ['Macau', 446],
    ['Holland', 528],
    ['Swaziland', 748],
    ['Cape Verde', 132],
    ['East Timor', 626],
    ['DRC', 180],
  ] as const)('leads the common name %s with %i in any case', (query, code) => {
    for (const spelling of [query, query.toLowerCase(), ` ${query.toUpperCase()} `]) {
      expect(ids(spelling)[0]).toBe(code);
    }
  });

  it('keeps partial-name hits after an alias hit, under the role filter too', () => {
    expect(ids('UK')).toEqual([826, 804, 647]);
    expect(ids('UK', 'reporter')).toEqual([826, 804]);
    expect(ids('UK', 'partner')).toEqual([826, 804, 647]);
  });

  it.each([
    ['Turkiye', 792],
    ['Türkiye', 792],
    ['TÜRKIYE', 792],
    ["Cote d'Ivoire", 384],
    ["Côte d'Ivoire", 384],
    ['Reunion', 638],
    ['Réunion', 638],
    ['Curacao', 531],
    ['Curaçao', 531],
  ] as const)(
    'folds case and accents: %s leads with %i, precomposed or decomposed',
    (query, code) => {
      for (const spelling of [query, query.normalize('NFD')]) {
        expect(ids(spelling)[0]).toBe(code);
      }
    },
  );

  it.each([
    ['Republic of Korea', [410, 408]],
    ['Dominican Republic', [214]],
    ['Democratic Republic of the Congo', [180]],
    ['Monaco', [251, 250]],
  ] as const)('matches the long-form catalog note: %s', (query, expected) => {
    expect(ids(query)).toEqual(expected);
  });

  it.each([
    ['Guinea', [324, 226, 624]],
    ['Sudan', [729, 736, 728]],
    ['Luxembourg', [442, 56, 58]],
    ['Puerto Rico', [630, 842, 841, 840]],
  ] as const)('ranks an exact name before longer names: %s', (query, expected) => {
    expect(ids(query)).toEqual(expected);
  });

  it.each(['US', 'USA', 'United States', 'United States of America'])(
    'keeps reporter 842 first for %s, ISO-3 siblings ranked with the match that pulled them in',
    (query) => {
      expect(ids(query)).toEqual([842, 841, 840]);
    },
  );

  it('keeps Germany and Viet Nam first under the role and group filters', async () => {
    expect(ids('Germany')).toEqual([276, 280, 278]);
    expect(ids('Germany', 'reporter')).toEqual([276, 280, 278]);
    expect(ids('vietnam')).toEqual([704, 866, 868]);
    const groups = await runToolContract(lookupCountriesTool, {
      query: 'ASEAN',
      include_groups: false,
    });
    expect(groups.structuredContent).toMatchObject({ matches: [], totalMatches: 0 });
  });

  it('trims catalog names and ISO codes when indexing, on lookup, rendering, and the resource', async () => {
    expect(ref.getCountryByCode(630)?.name).toBe('Puerto Rico');
    expect(ref.getCountryByCode(438)?.name).toBe('Liechtenstein');
    expect(ref.getCountryByCode(975)?.iso3).toBe('R4');
    expect(ids('X1')).toEqual([837]);
    const result = await runToolContract(lookupCountriesTool, { query: 'puerto rico' });
    expect(result.structuredContent).toMatchObject({
      matches: [
        { id: 630, name: 'Puerto Rico', iso3: 'PRI', iso2: 'PR' },
        { id: 842 },
        { id: 841 },
        { id: 840 },
      ],
    });
    expect(JSON.stringify(result.content)).toContain('**Puerto Rico** (code: 630)');
    const { countries } = countriesResource.handler({}, createMockContext());
    expect(countries.find((entry) => entry.id === 630)?.name).toBe('Puerto Rico');
    expect(countries.find((entry) => entry.id === 837)?.iso3).toBe('X1');
  });

  it('lets a catalog name, note, or ISO code equal to an alias key win over the alias', async () => {
    stubFetch({
      'Reporters.json': {
        results: [
          reporterRow(104, 'Myanmar', 'MM', 'MMR', '1900-01-01'),
          reporterRow(528, 'Netherlands', 'NL', 'NLD', '1900-01-01'),
          reporterRow(826, 'United Kingdom', 'GB', 'GBR', '1900-01-01'),
        ],
      },
      'partnerAreas.json': {
        // Hypothetical rows: no captured name, note, or ISO code equals an alias key.
        results: [
          partnerRow(901, 'Burma', undefined, 'XBU', '1900-01-01'),
          { ...partnerRow(902, 'Hollandia', 'UK', 'XHO', '1900-01-01'), partnerNote: 'Holland' },
        ],
      },
    });
    const fresh = initComtradeReferenceService(config, storage);
    await fresh.initialize();
    const found = (query: string) => fresh.searchCountries(query).map((entry) => entry.id);
    expect(found('Burma')).toEqual([901]);
    expect(found('Holland')).toEqual([902]);
    expect(found('UK')).toEqual([902]);
    // An alias whose target the catalog no longer lists resolves to nothing.
    expect(found('Laos')).toEqual([]);
  });

  it.each(['́', ' ̖́ ', '́ ́', '⃝'])(
    'matches nothing for a query that folds to empty text: %j',
    async (query) => {
      expect(ids(query)).toEqual([]);
      const result = await runToolContract(lookupCountriesTool, { query });
      expect(result.structuredContent).toMatchObject({ matches: [], totalMatches: 0 });
      expect(JSON.stringify(result.content)).toContain('**Matches:** 0');
    },
  );

  const marks = String.fromCodePoint(0x0301, 0x0316); // combining classes 230 then 220
  // One test per shape keeps each measurement campaign well inside the default test timeout.
  it.each<[string, (length: number) => string, number]>([
    // Below Bun's ~80k-character regex mode switch: one long line ending in a break, breaks
    // throughout, and an alternating combining-mark run (canonical reordering's worst case).
    ['one long line ending in a break', (length) => `${'§1 x'.repeat(length / 4)}\ny`, 1_000],
    ['breaks throughout', (length) => '  \r\n'.repeat(length / 4), 1_000],
    ['an alternating combining-mark run', (length) => `a${marks.repeat(length / 2)}`, 1_000],
    // The full 5k → 320k span, on a shape that never crosses the switch.
    ['a digit run', (length) => '7'.repeat(length), 5_000],
  ])('normalizes a caller-sized query in linear time: %s', (_shape, shape, baseLength) => {
    expectLinearSearch(shape, baseLength);
  });
});

describe('published-under counterparts and catalog notes', () => {
  // Captured 2026-11-11 rows; names, notes, groupings, and trailing spaces are upstream's.
  const otherAsia = {
    id: 490,
    text: 'Other Asia, nes',
    reporterCode: 490,
    reporterDesc: 'Other Asia, nes',
    reporterCodeIsoAlpha3: 'S19',
    reporterNote: 'Other Asia, not elsewhere specified',
    entryEffectiveDate: '1900-01-01T00:00:00',
    isGroup: true,
  };
  const reporters = [
    otherAsia,
    { ...reporterRow(251, 'France', 'FR', 'FRA', '1900-01-01'), reporterNote: 'France, Monaco' },
    { ...reporterRow(156, 'China', 'CN', 'CHN', '1900-01-01'), reporterNote: 'China' },
    {
      ...reporterRow(344, 'China, Hong Kong SAR', 'HK', 'HKG', '1900-01-01'),
      reporterNote: 'China, Hong Kong Special Administrative Region',
    },
    {
      ...reporterRow(446, 'China, Macao SAR', 'MO', 'MAC', '1900-01-01'),
      reporterNote: 'China, Macao Special Administrative Region',
    },
  ];
  const partners = [
    partnerRow(158, 'Taiwan, Province of China', 'TW', 'TWN', '1900-01-01'),
    {
      ...partnerRow(490, 'Other Asia, nes', undefined, 'S19', '1900-01-01'),
      partnerNote: 'Other Asia, not elsewhere specified',
    },
    {
      ...partnerRow(250, 'Metropolitan France', 'FR', 'FRA', '1900-01-01'),
      partnerNote: 'Metropolitan France',
    },
    { ...partnerRow(251, 'France', 'FR', 'FRA', '1900-01-01'), partnerNote: 'France, Monaco' },
    partnerRow(412, 'Kosovo', undefined, '_KS', '1900-01-01'),
    partnerRow(438, 'Liechtenstein ', 'LI', 'LIE', '1900-01-01'),
    partnerRow(630, 'Puerto Rico ', 'PR', 'PRI', '1900-01-01'),
  ];
  const TAIWAN_NOTICE =
    'UN Comtrade publishes the trade of 158 (Taiwan, Province of China) under 490 (Other Asia, nes), as reporter and as partner: query 490 as reporter_code or partner_code.';
  let ref: ReferenceService;
  const ids = (query: string, role?: 'reporter' | 'partner') =>
    ref.searchCountries(query, role).map((entry) => entry.id);
  /** The match codes and notice of a lookup, after checking the notice reached content[] too. */
  async function lookup(input: Record<string, unknown>) {
    const result = await runToolContract(lookupCountriesTool, input);
    const { matches, notice } = result.structuredContent as {
      matches: { id: number }[];
      notice?: string;
    };
    const text = (result.content ?? []).map((block) => (block as { text: string }).text).join('\n');
    if (notice !== undefined) expect(text).toContain(`> ${notice}`);
    return { codes: matches.map((match) => match.id), notice, text };
  }

  beforeEach(async () => {
    stubFetch({
      'Reporters.json': { results: reporters },
      'partnerAreas.json': { results: partners },
    });
    ref = initComtradeReferenceService(config, storage);
    await ref.initialize();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    [
      158,
      {
        referenceStatus: 'partner_only',
        name: 'Taiwan, Province of China',
        suggestedReporterCode: 490,
        suggestionBasis: 'published_under',
        suggestedReporterName: 'Other Asia, nes',
      },
    ],
    // The ISO-3 counterparts (250 → 251, 578, 756, 840) are tabled in the suite above. Kosovo
    // has no catalog link; Liechtenstein and Puerto Rico are included in a larger reporter (the
    // 757 and 842 notes), not published under one.
    [412, { referenceStatus: 'partner_only', name: 'Kosovo' }],
    [438, { referenceStatus: 'partner_only', name: 'Liechtenstein' }],
    [630, { referenceStatus: 'partner_only', name: 'Puerto Rico' }],
    [490, { referenceStatus: 'reporter', name: 'Other Asia, nes' }],
  ] as const)('names the counterpart of code %i', (code, status) => {
    expect(ref.getReporterStatus(code)).toStrictEqual(status);
  });

  it('applies the 158 row only while 490 is an indexed reporter', async () => {
    stubFetch({
      'Reporters.json': { results: reporters.filter((row) => row.id !== 490) },
      'partnerAreas.json': { results: partners },
    });
    ref = initComtradeReferenceService(config, storage);
    await ref.initialize();
    expect(ref.getReporterStatus(158)).toStrictEqual({
      referenceStatus: 'partner_only',
      name: 'Taiwan, Province of China',
    });
    // 490 is now a partner-only entry: it neither stands in for 158 nor is pulled in.
    expect(await lookup({ query: 'Taiwan' })).toMatchObject({ codes: [158], notice: undefined });
  });

  it.each(['Taiwan', 'TW', 'TWN', ' taiwan '])(
    'lists 490 before 158 for %j with a notice naming both',
    async (query) => {
      const any = await lookup({ query });
      expect(any).toMatchObject({ codes: [490, 158], notice: TAIWAN_NOTICE });
      expect(any.text.indexOf('(code: 490)')).toBeLessThan(any.text.indexOf('(code: 158)'));
      expect(await lookup({ query, role: 'partner' })).toMatchObject({
        codes: [490, 158],
        notice: TAIWAN_NOTICE,
      });
      // 158 is left out as a reporter, and the notice still names it.
      expect(await lookup({ query, role: 'reporter' })).toMatchObject({
        codes: [490],
        notice: TAIWAN_NOTICE,
      });
      // Reporters.json flags 490 a grouping; it stays because it stands in for 158.
      expect(await lookup({ query, include_groups: false })).toMatchObject({
        codes: [490, 158],
        notice: TAIWAN_NOTICE,
      });
      expect(await lookup({ query, role: 'reporter', include_groups: false })).toMatchObject({
        codes: [490],
        notice: TAIWAN_NOTICE,
      });
    },
  );

  it('ranks 490 with the partial match on 158 that pulled it in, behind an exact match', () => {
    // At 158's partial tier, reporter-valid 490 sorts by name among the other partial matches.
    expect(ids('China')).toEqual([156, 344, 446, 490, 158]);
  });

  it('treats a direct match on 490 as a grouping with no notice', async () => {
    expect(await lookup({ query: 'Other Asia' })).toMatchObject({
      codes: [490],
      notice: undefined,
    });
    expect(await lookup({ query: 'Other Asia', include_groups: false })).toMatchObject({
      codes: [],
    });
  });

  it('carries a catalog note that differs from the name on both surfaces', async () => {
    const result = await runToolContract(lookupCountriesTool, { query: 'Monaco' });
    const { matches } = result.structuredContent as { matches: Record<string, unknown>[] };
    expect(matches).toMatchObject([
      { id: 251, name: 'France', note: 'France, Monaco' },
      { id: 250, name: 'Metropolitan France' },
    ]);
    // 250's note repeats its name, so the index keeps none.
    expect(matches[1]).not.toHaveProperty('note');
    const text = JSON.stringify(result.content);
    expect(text).toContain('**France** (code: 251)');
    expect(text).toContain('note: France, Monaco');
    expect(text.match(/note: /g)).toHaveLength(1);
    expect(ref.getCountryByCode(156)).not.toHaveProperty('note');
    expect(ref.getCountryByCode(490)?.note).toBe('Other Asia, not elsewhere specified');
  });

  it('drops a note that equals the name once case and accents are folded', async () => {
    stubFetch({
      'Reporters.json': { results: reporters },
      // Hypothetical row: no captured note differs from its name only in case or accents.
      'partnerAreas.json': {
        results: [
          { ...partnerRow(531, 'Curaçao', 'CW', 'CUW', '2010-11-01'), partnerNote: 'CURACAO' },
        ],
      },
    });
    ref = initComtradeReferenceService(config, storage);
    await ref.initialize();
    expect(ref.getCountryByCode(531)).not.toHaveProperty('note');
    expect(ids('curacao')).toEqual([531]);
  });
});
