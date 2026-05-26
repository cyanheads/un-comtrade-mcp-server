/**
 * @fileoverview Tests for the get-top-commodities tool.
 * @module tests/tools/get-top-commodities.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTopCommoditiesTool } from '@/mcp-server/tools/definitions/get-top-commodities.tool.js';
import {
  ComtradeDataService,
  initComtradeDataService,
} from '@/services/comtrade-data/comtrade-data-service.js';

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
    fetchMock = vi
      .spyOn(ComtradeDataService.prototype, 'fetchTradeData')
      .mockResolvedValue({ records: COMMODITY_RECORDS, totalCount: 3, truncated: false });
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
    if (result.commodities[0]?.sharePercent != null) {
      expect(result.commodities[0].sharePercent).toBeCloseTo((500_000_000 / 700_000_000) * 100, 1);
    }
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
    expect(result.notice).toBeDefined();
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
  });
});
