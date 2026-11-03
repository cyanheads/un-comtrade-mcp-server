/**
 * @fileoverview Reference loading, country identity, and classification discovery regressions.
 * @module tests/services/comtrade-reference-service.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { countriesResource } from '@/mcp-server/resources/definitions/countries.resource.js';
import { hsClassificationResource } from '@/mcp-server/resources/definitions/hs-classification.resource.js';
import { listServiceCategoriesTool } from '@/mcp-server/tools/definitions/list-service-categories.tool.js';
import { lookupCountriesTool } from '@/mcp-server/tools/definitions/lookup-countries.tool.js';
import { searchCommoditiesTool } from '@/mcp-server/tools/definitions/search-commodities.tool.js';
import { initComtradeReferenceService } from '@/services/comtrade-reference/comtrade-reference-service.js';

const config = {} as Parameters<typeof initComtradeReferenceService>[0];
const storage = {} as Parameters<typeof initComtradeReferenceService>[1];
// Selected records from the captured UN Comtrade reference files; spellings are upstream's.
const bodies = new Map<string, unknown>([
  [
    'Reporters.json',
    {
      results: [
        {
          reporterCode: 842,
          reporterDesc: 'USA',
          reporterCodeIsoAlpha2: 'US',
          reporterCodeIsoAlpha3: 'USA',
        },
        {
          reporterCode: 36,
          reporterDesc: 'Australia',
          reporterCodeIsoAlpha2: 'AU',
          reporterCodeIsoAlpha3: 'AUS',
        },
      ],
    },
  ],
  [
    'partnerAreas.json',
    {
      results: [
        {
          PartnerCode: 840,
          PartnerDesc: 'United States of America',
          PartnerCodeIsoAlpha2: 'US',
          PartnerCodeIsoAlpha3: 'USA',
        },
        {
          PartnerCode: 841,
          PartnerDesc: 'USA and Puerto Rico (...1980)',
          PartnerCodeIsoAlpha2: 'US',
          PartnerCodeIsoAlpha3: 'USA',
        },
        { PartnerCode: 0, PartnerDesc: 'World', PartnerCodeIsoAlpha3: 'W00', isGroup: true },
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
        { id: 'SA', text: 'Manufacturing services on physical inputs owned by', parent: 'S' },
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

describe('ComtradeReferenceService', () => {
  let ref: ReturnType<typeof initComtradeReferenceService>;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  beforeEach(async () => {
    ref = initComtradeReferenceService(config, storage);
    fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const body = bodies.get(String(url).split('/').at(-1)!);
      if (!body) return new Response('missing', { status: 404 });
      return Response.json(body);
    });
    vi.stubGlobal('fetch', fetchMock);
    await ref.initialize();
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
          { id: 842, name: 'USA', iso2: 'US', iso3: 'USA', isGroup: false, validAsReporter: true },
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
});
