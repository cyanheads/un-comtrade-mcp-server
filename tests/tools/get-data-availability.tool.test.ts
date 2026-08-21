/**
 * @fileoverview Tests for the get-data-availability tool.
 * @module tests/tools/get-data-availability.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDataAvailabilityTool } from '@/mcp-server/tools/definitions/get-data-availability.tool.js';
import {
  ComtradeMetaService,
  initComtradeMetaService,
} from '@/services/comtrade-meta/comtrade-meta-service.js';

const mockConfig = {} as Parameters<typeof initComtradeMetaService>[0];
const mockStorage = {} as Parameters<typeof initComtradeMetaService>[1];

const AVAILABILITY_RECORD = {
  reporterCode: 840,
  reporterDesc: 'United States of America',
  period: '2022',
  freqCode: 'A' as const,
  classificationCode: 'HS',
  typeCode: 'C' as const,
  totalRecords: 250_000,
  publicationDate: '2023-03-15',
};

describe('getDataAvailabilityTool', () => {
  let availMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    initComtradeMetaService(mockConfig, mockStorage);
    availMock = vi
      .spyOn(ComtradeMetaService.prototype, 'getDataAvailability')
      .mockResolvedValue([AVAILABILITY_RECORD]);
  });

  it('returns availability records for valid input', async () => {
    const ctx = createMockContext({ errors: getDataAvailabilityTool.errors });
    const input = getDataAvailabilityTool.input.parse({
      reporter_code: 840,
      period: '2022',
    });
    const result = await getDataAvailabilityTool.handler(input, ctx);
    expect(result.datasets).toHaveLength(1);
    expect(result.datasets[0]?.reporterCode).toBe(840);
    expect(result.datasets[0]?.period).toBe('2022');
    expect(result.totalDatasets).toBe(1);
  });

  it('passes type_code and classification to the service', async () => {
    const ctx = createMockContext({ errors: getDataAvailabilityTool.errors });
    const input = getDataAvailabilityTool.input.parse({
      type_code: 'S',
      classification: 'EB10',
    });
    await getDataAvailabilityTool.handler(input, ctx);
    expect(availMock).toHaveBeenCalledWith(
      expect.objectContaining({
        typeCode: 'S',
        classificationCode: 'EB10',
      }),
      expect.anything(),
    );
  });

  it('returns notice when no records found', async () => {
    availMock.mockResolvedValue([]);
    const ctx = createMockContext({ errors: getDataAvailabilityTool.errors });
    const input = getDataAvailabilityTool.input.parse({
      reporter_code: 999,
      period: '1900',
    });
    const result = await getDataAvailabilityTool.handler(input, ctx);
    expect(result.datasets).toHaveLength(0);
    expect(result.totalDatasets).toBe(0);
    expect(getEnrichment(ctx).notice).toBeDefined();
    expect(getEnrichment(ctx).notice).toContain('999');
  });

  it('omits optional fields when absent in upstream response', async () => {
    availMock.mockResolvedValue([
      {
        reporterCode: 840,
        reporterDesc: 'United States of America',
        period: '2022',
        freqCode: 'A' as const,
        classificationCode: 'HS',
        typeCode: 'C' as const,
        // totalRecords and publicationDate omitted
      },
    ]);
    const ctx = createMockContext({ errors: getDataAvailabilityTool.errors });
    const input = getDataAvailabilityTool.input.parse({ reporter_code: 840 });
    const result = await getDataAvailabilityTool.handler(input, ctx);
    expect(result.datasets[0]).not.toHaveProperty('totalRecords');
    expect(result.datasets[0]).not.toHaveProperty('publicationDate');
  });

  it('formats output with all key fields', () => {
    const output = {
      datasets: [AVAILABILITY_RECORD],
      totalDatasets: 1,
    };
    const blocks = getDataAvailabilityTool.format!(output);
    expect(blocks[0].type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('840');
    expect(text).toContain('United States of America');
    expect(text).toContain('2022');
    expect(text).toContain('HS');
    expect(text).toContain('C');
    expect(text).toContain('250,000');
    expect(text).toContain('2023-03-15');
  });
});
