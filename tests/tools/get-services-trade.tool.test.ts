/**
 * @fileoverview Tests for the get-services-trade tool.
 * @module tests/tools/get-services-trade.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getServicesTradeTool } from '@/mcp-server/tools/definitions/get-services-trade.tool.js';
import {
  ComtradeDataService,
  initComtradeDataService,
} from '@/services/comtrade-data/comtrade-data-service.js';

const mockConfig = {} as Parameters<typeof initComtradeDataService>[0];
const mockStorage = {} as Parameters<typeof initComtradeDataService>[1];

const SERVICES_RECORD = {
  reporterCode: 840,
  reporterDesc: 'United States of America',
  partnerCode: 0,
  partnerDesc: 'World',
  flowCode: 'X',
  cmdCode: 'SA',
  cmdDesc: 'Transport services',
  period: '2022',
  primaryValue: 80_000_000_000,
  isReported: true,
};

describe('getServicesTradeTool', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    initComtradeDataService(mockConfig, mockStorage);
    fetchMock = vi
      .spyOn(ComtradeDataService.prototype, 'fetchTradeData')
      .mockResolvedValue({ records: [SERVICES_RECORD], totalCount: 1, truncated: false });
  });

  it('returns services trade records for valid input', async () => {
    const ctx = createMockContext({ errors: getServicesTradeTool.errors });
    const input = getServicesTradeTool.input.parse({
      reporter_code: 840,
      flow_code: 'X',
      period: ['2022'],
    });
    const result = await getServicesTradeTool.handler(input, ctx);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.cmdCode).toBe('SA');
    expect(result.shown).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it('passes typeCode=S and classificationCode=EB10 to the service', async () => {
    const ctx = createMockContext({ errors: getServicesTradeTool.errors });
    const input = getServicesTradeTool.input.parse({
      reporter_code: 840,
      flow_code: 'X',
      period: ['2022'],
      service_code: 'SA',
    });
    await getServicesTradeTool.handler(input, ctx);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        typeCode: 'S',
        classificationCode: 'EB10',
        cmdCode: 'SA',
      }),
      expect.anything(),
    );
  });

  it('passes multiple periods as CSV', async () => {
    const ctx = createMockContext({ errors: getServicesTradeTool.errors });
    const input = getServicesTradeTool.input.parse({
      reporter_code: 840,
      flow_code: 'X',
      period: ['2021', '2022'],
    });
    await getServicesTradeTool.handler(input, ctx);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ period: '2021,2022' }),
      expect.anything(),
    );
  });

  it('returns notice when no records found', async () => {
    fetchMock.mockResolvedValue({ records: [], totalCount: 0, truncated: false });
    const ctx = createMockContext({ errors: getServicesTradeTool.errors });
    const input = getServicesTradeTool.input.parse({
      reporter_code: 999,
      flow_code: 'X',
      period: ['1900'],
    });
    const result = await getServicesTradeTool.handler(input, ctx);
    expect(result.records).toHaveLength(0);
    expect(getEnrichment(ctx).notice).toBeDefined();
    expect(getEnrichment(ctx).notice).toContain('999');
  });

  it('propagates truncation', async () => {
    fetchMock.mockResolvedValue({
      records: [SERVICES_RECORD],
      totalCount: 600,
      truncated: true,
      truncationHint: 'Set COMTRADE_SUBSCRIPTION_KEY',
    });
    const ctx = createMockContext({ errors: getServicesTradeTool.errors });
    const input = getServicesTradeTool.input.parse({
      reporter_code: 840,
      flow_code: 'X',
      period: ['2022'],
    });
    const result = await getServicesTradeTool.handler(input, ctx);
    expect(result.truncated).toBe(true);
    expect(result.truncationHint).toContain('COMTRADE_SUBSCRIPTION_KEY');
  });

  it('formats output with reporterCode, partnerCode, period, flowCode, cmdCode, and value', () => {
    const output = {
      records: [SERVICES_RECORD],
      totalCount: 1,
      shown: 1,
      truncated: false,
    };
    const blocks = getServicesTradeTool.format!(output);
    expect(blocks[0].type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('840');
    expect(text).toContain('0');
    expect(text).toContain('United States of America');
    expect(text).toContain('World');
    expect(text).toContain('2022');
    expect(text).toContain('X');
    expect(text).toContain('SA');
    expect(text).toContain('Transport services');
    expect(text).toContain('80,000,000,000');
  });

  it('formats sparse record without fabricating isReported when absent', () => {
    const sparseRecord = {
      reporterCode: 840,
      reporterDesc: 'United States of America',
      partnerCode: 276,
      partnerDesc: 'Germany',
      flowCode: 'X',
      cmdCode: 'SB',
      cmdDesc: 'Travel',
      period: '2022',
      // primaryValue and isReported omitted
    };
    const output = { records: [sparseRecord], totalCount: 1, shown: 1, truncated: false };
    const blocks = getServicesTradeTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Germany');
    // isReported should not appear since it's absent
    expect(text).not.toContain('Reported:');
  });
});
