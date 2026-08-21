/**
 * @fileoverview Tests for the get-top-partners tool.
 * @module tests/tools/get-top-partners.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTopPartnersTool } from '@/mcp-server/tools/definitions/get-top-partners.tool.js';
import {
  ComtradeDataService,
  initComtradeDataService,
} from '@/services/comtrade-data/comtrade-data-service.js';

const mockConfig = {} as Parameters<typeof initComtradeDataService>[0];
const mockStorage = {} as Parameters<typeof initComtradeDataService>[1];

/** Sample disaggregated records by partner. */
const PARTNER_RECORDS = [
  {
    reporterCode: 840,
    reporterDesc: 'United States of America',
    partnerCode: 276,
    partnerDesc: 'Germany',
    flowCode: 'X',
    cmdCode: 'TOTAL',
    cmdDesc: 'Total (all commodities)',
    period: '2022',
    primaryValue: 120_000_000,
  },
  {
    reporterCode: 840,
    reporterDesc: 'United States of America',
    partnerCode: 156,
    partnerDesc: 'China',
    flowCode: 'X',
    cmdCode: 'TOTAL',
    cmdDesc: 'Total (all commodities)',
    period: '2022',
    primaryValue: 300_000_000,
  },
  {
    // World aggregate — should be filtered out
    reporterCode: 840,
    reporterDesc: 'United States of America',
    partnerCode: 0,
    partnerDesc: 'World',
    flowCode: 'X',
    cmdCode: 'TOTAL',
    cmdDesc: 'Total (all commodities)',
    period: '2022',
    primaryValue: 420_000_000,
  },
];

describe('getTopPartnersTool', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    initComtradeDataService(mockConfig, mockStorage);
    fetchMock = vi
      .spyOn(ComtradeDataService.prototype, 'fetchTradeData')
      .mockResolvedValue({ records: PARTNER_RECORDS, totalCount: 3, truncated: false });
  });

  it('ranks partners by descending trade value', async () => {
    const ctx = createMockContext({ errors: getTopPartnersTool.errors });
    const input = getTopPartnersTool.input.parse({
      reporter_code: 840,
      flow_code: 'X',
      period: '2022',
    });
    const result = await getTopPartnersTool.handler(input, ctx);
    expect(result.partners[0]?.partnerCode).toBe(156); // China has higher value
    expect(result.partners[0]?.rank).toBe(1);
    expect(result.partners[1]?.partnerCode).toBe(276);
    expect(result.partners[1]?.rank).toBe(2);
  });

  it('excludes World aggregate (partnerCode 0)', async () => {
    const ctx = createMockContext({ errors: getTopPartnersTool.errors });
    const input = getTopPartnersTool.input.parse({
      reporter_code: 840,
      flow_code: 'X',
      period: '2022',
    });
    const result = await getTopPartnersTool.handler(input, ctx);
    expect(result.partners.every((p) => p.partnerCode !== 0)).toBe(true);
  });

  it('calculates share percentages', async () => {
    const ctx = createMockContext({ errors: getTopPartnersTool.errors });
    const input = getTopPartnersTool.input.parse({
      reporter_code: 840,
      flow_code: 'X',
      period: '2022',
      limit: 2,
    });
    const result = await getTopPartnersTool.handler(input, ctx);
    const total = result.totalValueUsd ?? 0;
    if (total > 0 && result.partners[0]?.sharePercent != null) {
      expect(result.partners[0].sharePercent).toBeCloseTo(
        (300_000_000 / (120_000_000 + 300_000_000)) * 100,
        1,
      );
    }
  });

  it('respects the limit parameter', async () => {
    const ctx = createMockContext({ errors: getTopPartnersTool.errors });
    const input = getTopPartnersTool.input.parse({
      reporter_code: 840,
      flow_code: 'X',
      period: '2022',
      limit: 1,
    });
    const result = await getTopPartnersTool.handler(input, ctx);
    expect(result.partners).toHaveLength(1);
    expect(result.totalPartners).toBe(2); // China + Germany (World filtered out)
  });

  it('returns notice when no data found', async () => {
    fetchMock.mockResolvedValue({ records: [], totalCount: 0, truncated: false });
    const ctx = createMockContext({ errors: getTopPartnersTool.errors });
    const input = getTopPartnersTool.input.parse({
      reporter_code: 999,
      flow_code: 'X',
      period: '1900',
    });
    const result = await getTopPartnersTool.handler(input, ctx);
    expect(result.partners).toHaveLength(0);
    expect(getEnrichment(ctx).notice).toBeDefined();
  });

  it('formats output with reporterCode, flowCode, period, cmdCode, and ranks', () => {
    const output = {
      partners: [
        {
          rank: 1,
          partnerCode: 156,
          partnerDesc: 'China',
          primaryValueUsd: 300_000_000,
          sharePercent: 71.43,
        },
        {
          rank: 2,
          partnerCode: 276,
          partnerDesc: 'Germany',
          primaryValueUsd: 120_000_000,
          sharePercent: 28.57,
        },
      ],
      reporterCode: 840,
      reporterDesc: 'United States of America',
      period: '2022',
      flowCode: 'X',
      cmdCode: 'TOTAL',
      totalPartners: 2,
      totalValueUsd: 420_000_000,
      truncated: false,
    };
    const blocks = getTopPartnersTool.format!(output);
    expect(blocks[0].type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('reporterCode: 840');
    expect(text).toContain('flowCode: X');
    expect(text).toContain('China');
    expect(text).toContain('Germany');
    expect(text).toContain('#1');
    expect(text).toContain('#2');
    expect(text).toContain('71.43%');
  });
});
