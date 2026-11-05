/**
 * @fileoverview Tests for the get-top-commodities tool.
 * @module tests/tools/get-top-commodities.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTopCommoditiesTool } from '@/mcp-server/tools/definitions/get-top-commodities.tool.js';
import {
  ComtradeDataService,
  initComtradeDataService,
  periodFailureError,
  TRADE_DATA_DEADLINE_MS,
} from '@/services/comtrade-data/comtrade-data-service.js';
import {
  ComtradeReferenceService,
  initComtradeReferenceService,
} from '@/services/comtrade-reference/comtrade-reference-service.js';
import type { ReporterStatus } from '@/services/comtrade-reference/types.js';

const mockConfig = {} as Parameters<typeof initComtradeDataService>[0];
const mockStorage = {} as Parameters<typeof initComtradeDataService>[1];

const COMMODITY_RECORDS = [
  {
    reporterCode: 840,
    reporterDesc: 'United States of America',
    partnerCode: 0,
    partnerDesc: 'World',
    flowCode: 'X',
    cmdCode: '84',
    cmdDesc: 'Machinery',
    period: '2022',
    primaryValue: 200_000_000,
    aggrLevel: 2,
  },
  {
    reporterCode: 840,
    reporterDesc: 'United States of America',
    partnerCode: 0,
    partnerDesc: 'World',
    flowCode: 'X',
    cmdCode: '27',
    cmdDesc: 'Mineral fuels',
    period: '2022',
    primaryValue: 500_000_000,
    aggrLevel: 2,
  },
  {
    // TOTAL row — should be filtered out
    reporterCode: 840,
    reporterDesc: 'United States of America',
    partnerCode: 0,
    partnerDesc: 'World',
    flowCode: 'X',
    cmdCode: 'TOTAL',
    cmdDesc: 'Total (all commodities)',
    period: '2022',
    primaryValue: 700_000_000,
    aggrLevel: 2,
  },
];

const args = { reporter_code: 840, flow_code: 'X', period: '2022' };

/** Serve `codes` as the matching edition's catalog at one aggregation level. */
function useCatalog(codes: string[], aggrLevel: 2 | 4) {
  vi.spyOn(ComtradeReferenceService.prototype, 'getCommodityCodes').mockResolvedValue(
    new Map(
      codes.map((id) => [id, { id, text: id, aggrLevel, isLeaf: false, recommendedQueryCode: id }]),
    ),
  );
}

describe('getTopCommoditiesTool', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    initComtradeDataService(mockConfig, mockStorage);
    initComtradeReferenceService(mockConfig, mockStorage);
    vi.spyOn(ComtradeReferenceService.prototype, 'getCommodityCodes').mockResolvedValue(
      new Map(
        ['27', '84'].map((id) => [
          id,
          { id, text: id, aggrLevel: 2, isLeaf: false, recommendedQueryCode: id },
        ]),
      ),
    );
    fetchMock = vi.spyOn(ComtradeDataService.prototype, 'fetchTradeData').mockResolvedValue({
      records: COMMODITY_RECORDS.map((row) => ({ ...row, classificationCode: 'H6' })),
      totalCount: 3,
      truncated: false,
    });
  });
  afterEach(() => vi.useRealTimers());

  it('ranks commodities by descending trade value', async () => {
    const ctx = createMockContext({ errors: getTopCommoditiesTool.errors });
    const input = getTopCommoditiesTool.input.parse({
      reporter_code: 840,
      flow_code: 'X',
      period: '2022',
    });
    const result = await getTopCommoditiesTool.handler(input, ctx);
    expect(result.commodities[0]?.cmdCode).toBe('27'); // Mineral fuels has higher value
    expect(result.commodities[0]?.rank).toBe(1);
    expect(result.commodities[1]?.cmdCode).toBe('84');
    expect(result.commodities[1]?.rank).toBe(2);
  });

  it('returns every retrieved category when limit exceeds the total', async () => {
    const input = getTopCommoditiesTool.input.parse({
      reporter_code: 840,
      flow_code: 'X',
      period: '2022',
      limit: 51,
    });
    const result = await getTopCommoditiesTool.handler(input, createMockContext());
    expect(result.commodities.map((row) => row.cmdCode)).toEqual(['27', '84']);
    expect(result.totalValueUsd).toBe(700_000_000);
  });

  it('routes a trimmed monthly period to monthly retrieval', async () => {
    const input = getTopCommoditiesTool.input.parse({
      reporter_code: 840,
      flow_code: 'X',
      period: ' 202201 ',
    });
    await getTopCommoditiesTool.handler(input, createMockContext());
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ period: '202201', freqCode: 'M' }),
      expect.any(AbortSignal),
      expect.any(Number),
    );
  });

  it('normalizes flow casing before ranking requests', async () => {
    const input = getTopCommoditiesTool.input.parse({
      reporter_code: 840,
      flow_code: ' x ',
      period: '2022',
    });
    const result = await getTopCommoditiesTool.handler(input, createMockContext());
    expect(result.flowCode).toBe('X');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ flowCode: 'X' }),
      expect.any(AbortSignal),
      expect.any(Number),
    );
  });

  it('retrieves explicit codes and uses TOTAL rather than the retrieved sum for shares', async () => {
    fetchMock.mockImplementation(async (params) => ({
      records:
        params.cmdCode === 'TOTAL'
          ? [{ ...COMMODITY_RECORDS[2], classificationCode: 'H0', primaryValue: 1_000_000_000 }]
          : COMMODITY_RECORDS.slice(0, 2),
      totalCount: 2,
      truncated: false,
    }));
    const result = await getTopCommoditiesTool.handler(
      getTopCommoditiesTool.input.parse({ reporter_code: 840, flow_code: 'X', period: '2022' }),
      createMockContext(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ cmdCode: '27,84', classificationCode: 'HS' }),
      expect.any(AbortSignal),
      expect.any(Number),
    );
    expect(result.commodities[0]?.sharePercent).toBe(50);
  });

  it('excludes TOTAL rows', async () => {
    const ctx = createMockContext({ errors: getTopCommoditiesTool.errors });
    const input = getTopCommoditiesTool.input.parse({
      reporter_code: 840,
      flow_code: 'X',
      period: '2022',
    });
    const result = await getTopCommoditiesTool.handler(input, ctx);
    expect(result.commodities.every((c) => c.cmdCode !== 'TOTAL')).toBe(true);
  });

  it('calculates share percentages', async () => {
    const ctx = createMockContext({ errors: getTopCommoditiesTool.errors });
    const input = getTopCommoditiesTool.input.parse({
      reporter_code: 840,
      flow_code: 'X',
      period: '2022',
    });
    const result = await getTopCommoditiesTool.handler(input, ctx);
    expect(result.commodities[0]?.sharePercent).toBe(71.43);
  });

  it('respects limit parameter', async () => {
    const ctx = createMockContext({ errors: getTopCommoditiesTool.errors });
    const input = getTopCommoditiesTool.input.parse({
      reporter_code: 840,
      flow_code: 'X',
      period: '2022',
      limit: 1,
    });
    const result = await getTopCommoditiesTool.handler(input, ctx);
    expect(result.commodities).toHaveLength(1);
    expect(result.totalCommodities).toBe(2);
  });

  it('returns notice when no data found', async () => {
    fetchMock.mockResolvedValue({ records: [], totalCount: 0, truncated: false });
    const ctx = createMockContext({ errors: getTopCommoditiesTool.errors });
    const input = getTopCommoditiesTool.input.parse({
      reporter_code: 999,
      flow_code: 'X',
      period: '1900',
    });
    const result = await getTopCommoditiesTool.handler(input, ctx);
    expect(result.commodities).toHaveLength(0);
    expect(getEnrichment(ctx).notice).toBeDefined();
  });

  it('returns exactly limit categories above 50 while totalCommodities counts every category', async () => {
    const codes = Array.from({ length: 60 }, (_, i) => String(10 + i));
    useCatalog(codes, 2);
    fetchMock.mockImplementation(async (params) => ({
      records:
        params.cmdCode === 'TOTAL'
          ? [{ ...COMMODITY_RECORDS[2], classificationCode: 'H6', primaryValue: 60_000 }]
          : codes.map((cmdCode, i) => ({
              ...COMMODITY_RECORDS[0],
              cmdCode,
              cmdDesc: `Chapter ${cmdCode}`,
              primaryValue: (60 - i) * 10,
            })),
      totalCount: 60,
      truncated: false,
    }));
    for (const [limit, shown] of [
      [51, 51],
      [70, 60],
    ] as const) {
      const result = await runToolContract(getTopCommoditiesTool, { ...args, limit });
      expect(result.isError).not.toBe(true);
      const output = getTopCommoditiesTool.output.parse(result.structuredContent);
      expect(output.commodities).toHaveLength(shown);
      expect(output.commodities.at(-1)).toMatchObject({ rank: shown });
      expect(output.totalCommodities).toBe(60);
      const text = JSON.stringify(result.content);
      expect(text).toContain(`**#${shown}. ${codes[shown - 1]}**`);
      expect(text).not.toContain(`**#${shown + 1}.`);
      expect(text).toContain('**Total Categories:** 60');
    }
  });

  it.each([
    [
      250,
      { referenceStatus: 'partner_only', name: 'Metropolitan France', suggestedReporterCode: 251 },
      'Reporter 250 (Metropolitan France) is a partner-only code in UN Comtrade reference data; reporter 251 shares its ISO-3 identity. Retry with reporter_code 251.',
    ],
    [
      0,
      { referenceStatus: 'partner_only', name: 'World' },
      'Reporter 0 (World) is a partner-only code in UN Comtrade reference data and has no reporter-valid counterpart. Find a reporter with comtrade_lookup_countries using role "reporter".',
    ],
    [
      999,
      { referenceStatus: 'unknown' },
      'Use comtrade_get_data_availability to verify data exists.',
    ],
    [
      842,
      { referenceStatus: 'reporter', name: 'USA' },
      'Use comtrade_get_data_availability to verify data exists.',
    ],
  ] as const)(
    'answers reporter %i with an empty TOTAL as an empty, untruncated ranking',
    async (code, status, sentence) => {
      fetchMock.mockResolvedValue({ records: [], totalCount: 0, truncated: false });
      vi.spyOn(ComtradeReferenceService.prototype, 'getReporterStatus').mockReturnValue(
        status as ReporterStatus,
      );
      const result = await runToolContract(getTopCommoditiesTool, { ...args, reporter_code: code });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        commodities: [],
        totalCommodities: 0,
        truncated: false,
        coverageComplete: true,
        missingCodes: [],
        coverageNotice:
          'Matching TOTAL returned no rows, so no commodity has data for this reporter, partner, flow and period.',
        notice: `No commodity data found for reporter ${code}, flow=X, period=2022. ${sentence}`,
        // A known code is named as the reference data names it; an unknown one keeps its code.
        reporterDesc: 'name' in status ? status.name : String(code),
      });
      const text = JSON.stringify(result.content);
      expect(text).toContain('Coverage complete: true; truncated: false.');
      expect(text).toContain(JSON.stringify(sentence).slice(1, -1));
      expect(text).not.toContain('did not identify');
      expect(fetchMock.mock.calls.map(([params]) => params.cmdCode)).toEqual(['TOTAL']);
    },
  );

  it('keeps the aggregate fallback when upstream TOTAL rows hold no aggregate row', async () => {
    fetchMock.mockImplementation(async (params) => ({
      records: params.cmdCode === 'TOTAL' ? [] : COMMODITY_RECORDS.slice(0, 2),
      totalCount: 2,
      truncated: false,
    }));
    const result = await getTopCommoditiesTool.handler(
      getTopCommoditiesTool.input.parse(args),
      createMockContext(),
    );
    expect(fetchMock.mock.calls.map(([params]) => params.cmdCode)).toEqual(['TOTAL', 'AG2']);
    expect(result.coverageNotice).toContain('did not identify one complete HS edition');
    expect(result.truncated).toBe(true);
    expect(result.commodities).toHaveLength(2);
  });

  it('shares one deadline across every request and issues no chunk once it has passed', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-05T00:00:00Z') });
    const start = Date.now();
    const codes = Array.from({ length: 1229 }, (_, i) => String(1000 + i));
    useCatalog(codes, 4);
    fetchMock.mockImplementation(async (params) => {
      // Each request takes 20 s of the call's budget: TOTAL ends at 20 s, chunks at 40 s and 60 s.
      vi.setSystemTime(Date.now() + 20_000);
      const requested: string[] = params.cmdCode.split(',');
      return params.cmdCode === 'TOTAL'
        ? {
            records: [{ ...COMMODITY_RECORDS[2], classificationCode: 'H6' }],
            totalCount: 1,
            truncated: false,
          }
        : {
            records: requested.map((cmdCode) => ({
              ...COMMODITY_RECORDS[0],
              cmdCode,
              aggrLevel: 4,
            })),
            totalCount: requested.length,
            truncated: false,
          };
    });
    const result = await getTopCommoditiesTool.handler(
      getTopCommoditiesTool.input.parse({ ...args, aggr_level: 4, limit: 2000 }),
      createMockContext(),
    );
    expect(fetchMock.mock.calls.map(([params]) => params.cmdCode.split(',').length)).toEqual([
      1, 400, 400,
    ]);
    expect(fetchMock.mock.calls.map((call) => call[2])).toEqual(
      Array(3).fill(start + TRADE_DATA_DEADLINE_MS),
    );
    expect(result.missingCodes).toEqual(codes.slice(800));
    expect(result.coverageComplete).toBe(false);
    expect(result.commodities).toHaveLength(800);
    expect(result.commodities.every((row) => row.rank === undefined)).toBe(true);
  });

  it('leaves the halves of a capped chunk missing when they would start after the deadline', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-05T00:00:00Z') });
    const codes = ['0101', '0102', '0103', '9999'];
    useCatalog(codes, 4);
    fetchMock.mockImplementation(async (params) => {
      vi.setSystemTime(Date.now() + (params.cmdCode === 'TOTAL' ? 20_000 : 40_000));
      return params.cmdCode === 'TOTAL'
        ? {
            records: [{ ...COMMODITY_RECORDS[2], classificationCode: 'H6' }],
            totalCount: 1,
            truncated: false,
          }
        : {
            records: [{ ...COMMODITY_RECORDS[0], cmdCode: '0101', aggrLevel: 4 }],
            totalCount: 500,
            truncated: true,
          };
    });
    const result = await getTopCommoditiesTool.handler(
      getTopCommoditiesTool.input.parse({ ...args, aggr_level: 4 }),
      createMockContext(),
    );
    expect(fetchMock.mock.calls.map(([params]) => params.cmdCode)).toEqual([
      'TOTAL',
      '0101,0102,0103,9999',
    ]);
    expect(result.missingCodes).toEqual(codes);
    expect(result.commodities.map((row) => row.cmdCode)).toEqual(['0101']);
  });

  it('cuts the HS catalog load off at the shared deadline', async () => {
    vi.useFakeTimers();
    let catalogSignal: AbortSignal | undefined;
    vi.spyOn(ComtradeReferenceService.prototype, 'getCommodityCodes').mockImplementation(
      (_edition, signal) => {
        catalogSignal = signal;
        return new Promise((_resolve, reject) =>
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true }),
        );
      },
    );
    fetchMock.mockImplementation(async (params, _signal, deadlineAt) => {
      if (params.cmdCode === 'TOTAL')
        return {
          records: [{ ...COMMODITY_RECORDS[2], classificationCode: 'H6' }],
          totalCount: 1,
          truncated: false,
        };
      // The data service sends nothing once the call's deadline has passed.
      if (Date.now() >= Number(deadlineAt))
        throw periodFailureError([{ period: params.period, reason: 'deadline_exceeded' }]);
      throw new Error('Unexpected request before the deadline');
    });
    const pending = runToolContract(getTopCommoditiesTool, args);
    await vi.advanceTimersByTimeAsync(TRADE_DATA_DEADLINE_MS - 1);
    expect(catalogSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(catalogSignal?.aborted).toBe(true);
    const result = await pending;
    const declared = getTopCommoditiesTool.errors?.find((e) => e.reason === 'deadline_exceeded');
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.Timeout,
        data: { reason: 'deadline_exceeded', recovery: { hint: declared?.recovery } },
      },
    });
    expect(JSON.stringify(result)).not.toContain('fewer periods');
    expect(fetchMock.mock.calls.map(([params]) => params.cmdCode)).toEqual(['TOTAL', 'AG2']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('tells a rate-limited ranking how long to wait when nothing could be retrieved', async () => {
    fetchMock.mockRejectedValue(
      periodFailureError([{ period: '2022', reason: 'rate_limited', retryAfterSeconds: 6 }]),
    );
    const result = await runToolContract(getTopCommoditiesTool, args);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.RateLimited,
        data: {
          reason: 'rate_limited',
          retryAfter: 6,
          recovery: { hint: 'Wait 6 seconds, then retry.' },
        },
      },
    });
    expect(JSON.stringify(result.content)).toContain('Wait 6 seconds, then retry.');
    expect(JSON.stringify(result)).not.toContain('fewer periods');
    // TOTAL's failure falls back to the aggregate selector, whose failure ends the call.
    expect(fetchMock.mock.calls.map(([params]) => params.cmdCode)).toEqual(['TOTAL', 'AG2']);
  });

  it.each([-1, 99999, 1.5])('rejects M49 code %d for reporter and partner before work', (code) => {
    expect(getTopCommoditiesTool.input.safeParse({ ...args, reporter_code: code }).success).toBe(
      false,
    );
    expect(getTopCommoditiesTool.input.safeParse({ ...args, partner_code: code }).success).toBe(
      false,
    );
  });

  it.each([0, 999])('accepts M49 boundary code %d for reporter and partner', (code) => {
    expect(
      getTopCommoditiesTool.input.safeParse({ ...args, reporter_code: code, partner_code: code })
        .success,
    ).toBe(true);
  });

  it('formats output with reporterCode, flowCode, aggrLevel, and ranked commodities', () => {
    const output = {
      commodities: [
        {
          rank: 1,
          cmdCode: '27',
          cmdDesc: 'Mineral fuels',
          aggrLevel: 2,
          primaryValueUsd: 500_000_000,
          sharePercent: 71.4,
        },
        {
          rank: 2,
          cmdCode: '84',
          cmdDesc: 'Machinery',
          aggrLevel: 2,
          primaryValueUsd: 200_000_000,
          sharePercent: 28.6,
        },
      ],
      reporterCode: 840,
      reporterDesc: 'United States of America',
      period: '2022',
      flowCode: 'X',
      aggrLevel: 2,
      totalCommodities: 2,
      totalValueUsd: 700_000_000,
      truncated: false,
      coverageComplete: true,
      coverageNotice: 'All codes queried.',
      missingCodes: [],
      classificationCode: 'H6',
      denominatorValueUsd: 700_000_000,
    };
    const blocks = getTopCommoditiesTool.format!(output);
    expect(blocks[0].type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('reporterCode: 840');
    expect(text).toContain('flowCode: X');
    expect(text).toContain('aggrLevel: 2');
    expect(text).toContain('27');
    expect(text).toContain('Mineral fuels');
    expect(text).toContain('#1');
    expect(text).toContain('71.4%');
    expect(text).toContain('Coverage complete: true; truncated: false');
    expect(text).toContain('All codes queried.');
    expect(text).toContain('Missing codes: none identified');
    expect(text).toContain('HS edition: H6');
    expect(text).toContain('TOTAL denominator: $700,000,000 USD');
  });

  it.each(['202213', '202200', '2022\n01', '2022,2023', '20220101', '202'])(
    'rejects invalid single period %j',
    (period) => {
      expect(
        getTopCommoditiesTool.input.safeParse({ reporter_code: 840, flow_code: 'X', period })
          .success,
      ).toBe(false);
    },
  );

  it('subdivides capped requests beyond the first split and keeps empty children complete', async () => {
    const codes = ['0101', '0102', '0103', '9999'];
    vi.spyOn(ComtradeReferenceService.prototype, 'getCommodityCodes').mockResolvedValue(
      new Map(
        codes.map((id) => [
          id,
          { id, aggrLevel: 4, text: id, isLeaf: false, recommendedQueryCode: id },
        ]),
      ),
    );
    fetchMock.mockImplementation(async (params) => {
      if (params.cmdCode === 'TOTAL')
        return {
          records: [{ ...COMMODITY_RECORDS[2], classificationCode: 'H6' }],
          totalCount: 1,
          truncated: false,
        };
      const requested = params.cmdCode.split(',');
      return {
        records: requested
          .filter((code: string) => code !== '0102')
          .map((cmdCode: string) => ({
            ...COMMODITY_RECORDS[0],
            cmdCode,
            aggrLevel: 4,
            primaryValue: cmdCode === '9999' ? 500_000_000 : 100_000_000,
          })),
        totalCount: requested.length > 1 ? 500 : 1,
        truncated: requested.length > 1,
      };
    });
    const result = await getTopCommoditiesTool.handler(
      getTopCommoditiesTool.input.parse({
        reporter_code: 840,
        flow_code: 'X',
        period: '2022',
        aggr_level: 4,
      }),
      createMockContext(),
    );
    expect(result.coverageComplete).toBe(true);
    expect(result.missingCodes).toEqual([]);
    expect(result.commodities.map((row) => row.cmdCode)).toEqual(['9999', '0101', '0103']);
    expect(fetchMock.mock.calls.map(([params]) => params.cmdCode)).toEqual([
      'TOTAL',
      '0101,0102,0103,9999',
      '0101,0102',
      '0101',
      '0102',
      '0103,9999',
      '0103',
      '9999',
    ]);
  });

  it('preserves capped single-code data without ranks or shares and names missing codes', async () => {
    fetchMock.mockImplementation(async (params) =>
      params.cmdCode === 'TOTAL'
        ? {
            records: [{ ...COMMODITY_RECORDS[2], classificationCode: 'H6' }],
            totalCount: 1,
            truncated: false,
          }
        : { records: COMMODITY_RECORDS.slice(0, 2), totalCount: 500, truncated: true },
    );
    const result = await getTopCommoditiesTool.handler(
      getTopCommoditiesTool.input.parse({ reporter_code: 840, flow_code: 'X', period: '2022' }),
      createMockContext(),
    );
    expect(result.coverageComplete).toBe(false);
    expect(result.missingCodes).toEqual(['27', '84']);
    expect(result.commodities).toHaveLength(2);
    expect(result.commodities[0]?.rank).toBeUndefined();
    expect(result.commodities[0]?.sharePercent).toBeUndefined();
    const text = JSON.stringify(getTopCommoditiesTool.format!(result));
    expect(text).toContain('27, 84');
    expect(text).toContain('ranks and shares are withheld');
    expect(text).not.toContain('#1');
  });

  it('preserves fallback data when the reference catalog fails', async () => {
    vi.spyOn(ComtradeReferenceService.prototype, 'getCommodityCodes').mockRejectedValue(
      new Error('Reference unavailable'),
    );
    const result = await getTopCommoditiesTool.handler(
      getTopCommoditiesTool.input.parse({ reporter_code: 840, flow_code: 'X', period: '2022' }),
      createMockContext(),
    );
    expect(result.coverageComplete).toBe(false);
    expect(result.commodities).toHaveLength(2);
    expect(result.commodities[0]?.rank).toBeUndefined();
    expect(result.denominatorValueUsd).toBe(700_000_000);
    expect(result.coverageNotice).toContain('unavailable');
    expect(fetchMock.mock.calls.map(([params]) => params.cmdCode)).toEqual(['TOTAL', 'AG2']);
  });

  it('preserves zero values and omits an unknown retrieved sum', async () => {
    fetchMock.mockImplementation(async (params) => ({
      records:
        params.cmdCode === 'TOTAL'
          ? [{ ...COMMODITY_RECORDS[2], classificationCode: 'H6', primaryValue: 0 }]
          : [
              { ...COMMODITY_RECORDS[0], primaryValue: 0 },
              { ...COMMODITY_RECORDS[1], primaryValue: undefined },
            ],
      totalCount: 2,
      truncated: false,
    }));
    const result = await getTopCommoditiesTool.handler(
      getTopCommoditiesTool.input.parse({ reporter_code: 840, flow_code: 'X', period: '2022' }),
      createMockContext(),
    );
    expect(result.denominatorValueUsd).toBe(0);
    expect(result.totalValueUsd).toBeUndefined();
    expect(result.commodities.find((row) => row.cmdCode === '84')?.primaryValueUsd).toBe(0);
    expect(result.commodities.every((row) => row.rank === undefined)).toBe(true);
    expect(JSON.stringify(getTopCommoditiesTool.format!(result))).toContain(
      'TOTAL denominator: $0 USD',
    );
  });

  it('bounds the uncapped 1229-code case to TOTAL plus four trade requests', async () => {
    const codes = Array.from({ length: 1229 }, (_, index) => String(1000 + index));
    vi.spyOn(ComtradeReferenceService.prototype, 'getCommodityCodes').mockResolvedValue(
      new Map(
        codes.map((id) => [
          id,
          { id, aggrLevel: 4, text: id, isLeaf: false, recommendedQueryCode: id },
        ]),
      ),
    );
    fetchMock.mockImplementation(async (params) => ({
      records:
        params.cmdCode === 'TOTAL'
          ? [{ ...COMMODITY_RECORDS[2], classificationCode: 'H6' }]
          : params.cmdCode.split(',').map((cmdCode: string) => ({
              ...COMMODITY_RECORDS[0],
              cmdCode,
              aggrLevel: 4,
              primaryValue: 0,
            })),
      totalCount: 0,
      truncated: false,
    }));
    const result = await getTopCommoditiesTool.handler(
      getTopCommoditiesTool.input.parse({
        reporter_code: 840,
        flow_code: 'X',
        period: '2022',
        aggr_level: 4,
        limit: 51,
      }),
      createMockContext(),
    );
    expect(fetchMock.mock.calls.map(([params]) => params.cmdCode.split(',').length)).toEqual([
      1, 400, 400, 400, 29,
    ]);
    expect(result.commodities).toHaveLength(51);
    expect(result.totalCommodities).toBe(1229);
    expect(result.totalValueUsd).toBe(0);
    expect(result.coverageComplete).toBe(true);
    const signals = fetchMock.mock.calls.map(([, signal]) => signal);
    expect(new Set(signals).size).toBe(1);
  });

  it('retains partial data when a nested code request fails', async () => {
    fetchMock.mockImplementation(async (params) => {
      if (params.cmdCode === 'TOTAL')
        return {
          records: [{ ...COMMODITY_RECORDS[2], classificationCode: 'H6' }],
          totalCount: 1,
          truncated: false,
        };
      if (params.cmdCode === '27')
        throw new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Unavailable');
      return {
        records: COMMODITY_RECORDS.slice(0, 2),
        totalCount: 500,
        truncated: params.cmdCode.includes(','),
      };
    });
    const result = await getTopCommoditiesTool.handler(
      getTopCommoditiesTool.input.parse({ reporter_code: 840, flow_code: 'X', period: '2022' }),
      createMockContext(),
    );
    expect(result.missingCodes).toEqual(['27']);
    expect(result.commodities).toHaveLength(2);
    expect(result.coverageComplete).toBe(false);
  });

  it.each([
    [JsonRpcErrorCode.RateLimited, 'rate_limited'],
    [JsonRpcErrorCode.Timeout, 'deadline_exceeded'],
  ] as const)(
    'reports a chunk failing with code %s (%s) as missing codes',
    async (code, reason) => {
      fetchMock.mockImplementation(async (params) => {
        if (params.cmdCode === 'TOTAL')
          return {
            records: [{ ...COMMODITY_RECORDS[2], classificationCode: 'H6' }],
            totalCount: 1,
            truncated: false,
          };
        throw new McpError(code, 'No requested period was served.', { reason, retryable: true });
      });
      const result = await getTopCommoditiesTool.handler(
        getTopCommoditiesTool.input.parse({ reporter_code: 840, flow_code: 'X', period: '2022' }),
        createMockContext(),
      );
      expect(result.commodities).toEqual([]);
      expect(result.missingCodes).toEqual(['27', '84']);
      expect(result.coverageComplete).toBe(false);
      expect(result.truncated).toBe(true);
      expect(result.denominatorValueUsd).toBe(700_000_000);
    },
  );

  it.each([
    JsonRpcErrorCode.InvalidParams,
    JsonRpcErrorCode.ValidationError,
    JsonRpcErrorCode.RequestCancelled,
  ])('rethrows caller-input and cancellation error %s', async (code) => {
    const error = new McpError(code, 'Rejected');
    fetchMock.mockRejectedValue(error);
    await expect(
      getTopCommoditiesTool.handler(
        getTopCommoditiesTool.input.parse({ reporter_code: 840, flow_code: 'X', period: '2022' }),
        createMockContext(),
      ),
    ).rejects.toBe(error);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rethrows caller cancellation rather than returning partial data', async () => {
    const controller = new AbortController();
    const reason = new DOMException('Caller cancelled', 'AbortError');
    fetchMock.mockImplementation(async () => {
      controller.abort(reason);
      throw reason;
    });
    await expect(
      getTopCommoditiesTool.handler(
        getTopCommoditiesTool.input.parse({ reporter_code: 840, flow_code: 'X', period: '2022' }),
        createMockContext({ signal: controller.signal }),
      ),
    ).rejects.toBe(reason);
  });

  it('rejects a mismatching TOTAL edition and preserves truthful AG data', async () => {
    fetchMock.mockImplementation(async (params) => ({
      records:
        params.cmdCode === 'TOTAL'
          ? [{ ...COMMODITY_RECORDS[2], classificationCode: 'H6', partnerCode: 999 }]
          : COMMODITY_RECORDS.slice(0, 2),
      totalCount: 2,
      truncated: false,
    }));
    const result = await getTopCommoditiesTool.handler(
      getTopCommoditiesTool.input.parse({ reporter_code: 840, flow_code: 'X', period: '2022' }),
      createMockContext(),
    );
    expect(result.coverageComplete).toBe(false);
    expect(result.denominatorValueUsd).toBeUndefined();
    expect(result.classificationCode).toBeUndefined();
    expect(result.commodities[0]?.rank).toBeUndefined();
    expect(result.commodities[0]?.sharePercent).toBeUndefined();
  });
});
