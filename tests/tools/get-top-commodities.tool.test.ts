/**
 * @fileoverview Tests for the get-top-commodities tool.
 * @module tests/tools/get-top-commodities.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTopCommoditiesTool } from '@/mcp-server/tools/definitions/get-top-commodities.tool.js';
import {
  ComtradeDataService,
  initComtradeDataService,
} from '@/services/comtrade-data/comtrade-data-service.js';
import {
  ComtradeReferenceService,
  initComtradeReferenceService,
} from '@/services/comtrade-reference/comtrade-reference-service.js';

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

describe('getTopCommoditiesTool', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
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

  it('returns every retrieved category when limit exceeds 50', async () => {
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
    expect(result.commodities).toHaveLength(1229);
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
