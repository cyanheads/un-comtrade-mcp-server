/**
 * @fileoverview Tests for the get-trade-flows tool.
 * @module tests/tools/get-trade-flows.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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
  it('preserves quantity and classification metadata on both surfaces', async () => {
    const values = {
      classificationCode: 'H0',
      qty: 0,
      qtyUnitCode: 8,
      qtyUnitAbbr: 'kg',
      altQty: 0,
      altQtyUnitCode: 5,
      altQtyUnitAbbr: 'u',
      isQtyEstimated: false,
      isNetWgtEstimated: false,
    };
    vi.spyOn(ComtradeDataService.prototype, 'fetchTradeData').mockResolvedValue({
      records: [{ ...RECORD_USA_DEU, ...values }],
      totalCount: 1,
      truncated: false,
    });
    const result = await runToolContract(getTradeFlowsTool, {
      reporter_code: 840,
      flow_code: 'X',
      period: ['2022'],
    });
    expect(result.structuredContent).toMatchObject({ records: [expect.objectContaining(values)] });
    for (const value of [
      'H0',
      'qtyUnitCode: 8',
      'kg',
      'altQty: 0',
      'altQtyUnitCode: 5',
      'altQtyUnitAbbr: u',
      'isQtyEstimated: false',
      'isNetWgtEstimated: false',
    ])
      expect(JSON.stringify(result.content)).toContain(value);
  });
  it('deduplicates reporters, serves 20, and discloses unserved reporters', async () => {
    const spy = vi
      .spyOn(ComtradeDataService.prototype, 'fetchTradeData')
      .mockResolvedValue({ records: [RECORD_USA_DEU], totalCount: 1, truncated: false });
    const result = await runToolContract(getTradeFlowsTool, {
      reporter_code: [1, 1, ...Array.from({ length: 20 }, (_, i) => i + 2)],
      flow_code: 'X',
      period: ['2022'],
    });
    expect(result.isError).not.toBe(true);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ reporterCode: Array.from({ length: 20 }, (_, i) => i + 1) }),
      expect.anything(),
    );
    expect(result.structuredContent).toMatchObject({ unservedReporters: [21] });
    expect(JSON.stringify(result.content)).toContain('21');
    expect(JSON.stringify(result.content)).toContain('Query them separately');
  });
  it('allows reporter omission only with explicit partner', async () => {
    const spy = vi
      .spyOn(ComtradeDataService.prototype, 'fetchTradeData')
      .mockResolvedValue({ records: [], totalCount: 0, truncated: false });
    expect(getTradeFlowsTool.input.safeParse({ flow_code: 'X', period: ['2022'] }).success).toBe(
      false,
    );
    const result = await runToolContract(getTradeFlowsTool, {
      partner_code: 0,
      flow_code: 'X',
      period: ['2022'],
    });
    expect(result.isError).not.toBe(true);
    expect(spy.mock.calls[0]?.[0]).not.toHaveProperty('reporterCode');
    expect(JSON.stringify(result.structuredContent)).not.toContain('undefined');
    expect(JSON.stringify(result.content)).not.toContain('undefined');
    expect(
      getTradeFlowsTool.input.safeParse({ reporter_code: [], flow_code: 'X', period: ['2022'] })
        .success,
    ).toBe(false);
    expect(
      getTradeFlowsTool.input.safeParse({
        reporter_code: Array(201).fill(1),
        flow_code: 'X',
        period: ['2022'],
      }).success,
    ).toBe(false);
  });
  it('does not disclose unserved reporters when duplicates reduce an input to the served bound', async () => {
    const spy = vi
      .spyOn(ComtradeDataService.prototype, 'fetchTradeData')
      .mockResolvedValue({ records: [], totalCount: 0, truncated: false });
    const result = await runToolContract(getTradeFlowsTool, {
      reporter_code: Array(200).fill(842),
      flow_code: 'X',
      period: ['2022'],
      cmd_code: [' ', ''],
    });
    expect(result.isError).not.toBe(true);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ reporterCode: [842], cmdCode: 'TOTAL' }),
      expect.anything(),
    );
    expect(result.structuredContent).not.toHaveProperty('unservedReporters');
    expect(JSON.stringify(result.content)).not.toContain('Unserved reporters');
  });
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

  it.each([undefined, [], ['TOTAL']])(
    'defaults omitted and empty commodity arrays to TOTAL (%j)',
    async (cmd_code) => {
      await getTradeFlowsTool.handler(
        getTradeFlowsTool.input.parse({
          reporter_code: 840,
          flow_code: 'X',
          period: ['2022'],
          cmd_code,
        }),
        createMockContext(),
      );
      expect(fetchMock).toHaveBeenCalledWith(
        expect.objectContaining({ cmdCode: 'TOTAL' }),
        expect.anything(),
      );
    },
  );
  it.each(['S1', 'S2', 'S3', 'S4', 'SS'])('accepts and forwards %s', async (classification) => {
    await getTradeFlowsTool.handler(
      getTradeFlowsTool.input.parse({
        reporter_code: 840,
        flow_code: 'X',
        period: ['2022'],
        classification,
      }),
      createMockContext(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ classificationCode: classification, typeCode: 'C' }),
      expect.anything(),
    );
  });
  it('retains raw cap metadata on empty filtered output', async () => {
    fetchMock.mockResolvedValue({
      records: [],
      totalCount: 500,
      truncated: true,
      truncationHint: 'may be incomplete',
    });
    const result = await getTradeFlowsTool.handler(
      getTradeFlowsTool.input.parse({ reporter_code: 840, flow_code: 'X', period: ['2022'] }),
      createMockContext(),
    );
    expect(result).toMatchObject({
      shown: 0,
      totalCount: 500,
      truncated: true,
      truncationHint: 'may be incomplete',
    });
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
    expect(getEnrichment(ctx).notice).toBeDefined();
    expect(getEnrichment(ctx).notice).toContain('999');
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
