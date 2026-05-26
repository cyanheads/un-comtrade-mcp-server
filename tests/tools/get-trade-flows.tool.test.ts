/**
 * @fileoverview Tests for the get-trade-flows tool.
 * @module tests/tools/get-trade-flows.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTradeFlowsTool } from '@/mcp-server/tools/definitions/get-trade-flows.tool.js';
import {
  ComtradeDataService,
  initComtradeDataService,
} from '@/services/comtrade-data/comtrade-data-service.js';

const mockConfig = {} as Parameters<typeof initComtradeDataService>[0];
const mockStorage = {} as Parameters<typeof initComtradeDataService>[1];

/** A complete trade flow record fixture for testing. */
const RECORD_USA_DEU = {
  reporterCode: 840,
  reporterDesc: 'United States of America',
  partnerCode: 276,
  partnerDesc: 'Germany',
  flowCode: 'X',
  cmdCode: '84',
  cmdDesc: 'Machinery',
  period: '2022',
  primaryValue: 5_000_000,
};

/** A sparse record with only required fields — simulates thin upstream payloads. */
const RECORD_SPARSE = {
  reporterCode: 840,
  reporterDesc: 'United States of America',
  partnerCode: 0,
  partnerDesc: 'World',
  flowCode: 'X',
  cmdCode: 'TOTAL',
  cmdDesc: 'Total (all commodities)',
  period: '2022',
};

describe('getTradeFlowsTool', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    initComtradeDataService(mockConfig, mockStorage);
    fetchMock = vi
      .spyOn(ComtradeDataService.prototype, 'fetchTradeData')
      .mockResolvedValue({ records: [RECORD_USA_DEU], totalCount: 1, truncated: false });
  });

  it('returns trade flow records for valid input', async () => {
    const ctx = createMockContext();
    const input = getTradeFlowsTool.input.parse({
      reporter_code: 840,
      flow_code: 'X',
      period: ['2022'],
    });
    const result = await getTradeFlowsTool.handler(input, ctx);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.reporterCode).toBe(840);
    expect(result.records[0]?.partnerCode).toBe(276);
    expect(result.shown).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it('passes correct parameters to the service', async () => {
    const ctx = createMockContext();
    const input = getTradeFlowsTool.input.parse({
      reporter_code: 840,
      flow_code: 'X',
      period: ['2022', '2023'],
      partner_code: 276,
      cmd_code: ['84'],
    });
    await getTradeFlowsTool.handler(input, ctx);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        reporterCode: 840,
        flowCode: 'X',
        period: '2022,2023',
        partnerCode: 276,
        cmdCode: '84',
      }),
      expect.anything(),
    );
  });

  it('returns notice when no records found', async () => {
    fetchMock.mockResolvedValue({ records: [], totalCount: 0, truncated: false });
    const ctx = createMockContext();
    const input = getTradeFlowsTool.input.parse({
      reporter_code: 999,
      flow_code: 'X',
      period: ['1900'],
    });
    const result = await getTradeFlowsTool.handler(input, ctx);
    expect(result.records).toHaveLength(0);
    expect(result.notice).toBeDefined();
    expect(result.notice).toContain('999');
  });

  it('propagates truncation flag and hint', async () => {
    fetchMock.mockResolvedValue({
      records: Array(500).fill(RECORD_USA_DEU),
      totalCount: 1200,
      truncated: true,
      truncationHint: 'Set COMTRADE_SUBSCRIPTION_KEY for full access.',
    });
    const ctx = createMockContext();
    const input = getTradeFlowsTool.input.parse({
      reporter_code: 840,
      flow_code: 'X',
      period: ['2022'],
    });
    const result = await getTradeFlowsTool.handler(input, ctx);
    expect(result.truncated).toBe(true);
    expect(result.truncationHint).toContain('COMTRADE_SUBSCRIPTION_KEY');
  });

  it('formats output with reporter code, partner code, period, flow, and commodity', () => {
    const output = {
      records: [RECORD_USA_DEU],
      totalCount: 1,
      shown: 1,
      truncated: false,
    };
    const blocks = getTradeFlowsTool.format!(output);
    expect(blocks[0].type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('840');
    expect(text).toContain('276');
    expect(text).toContain('United States of America');
    expect(text).toContain('Germany');
    expect(text).toContain('2022');
    expect(text).toContain('X');
    expect(text).toContain('84');
    expect(text).toContain('5,000,000');
  });

  it('formats sparse record without fabricating absent values', () => {
    const output = {
      records: [RECORD_SPARSE],
      totalCount: 1,
      shown: 1,
      truncated: false,
    };
    const blocks = getTradeFlowsTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('TOTAL');
    expect(text).toContain('World');
    // Sparse fields should not appear since format() only renders non-null fields
    expect(text).not.toContain('Primary Value:');
  });

  it('formats truncation hint when truncated', () => {
    const output = {
      records: [],
      totalCount: 500,
      shown: 0,
      truncated: true,
      truncationHint: 'Set COMTRADE_SUBSCRIPTION_KEY for full access.',
    };
    const blocks = getTradeFlowsTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Truncated');
    expect(text).toContain('COMTRADE_SUBSCRIPTION_KEY');
  });
});
