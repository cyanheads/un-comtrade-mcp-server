/**
 * @fileoverview Tests for the get-data-availability tool.
 * @module tests/tools/get-data-availability.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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
  firstReleased: '2023-03-15',
  lastReleased: '2024-05-20',
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

  it('preserves blank classification defaults and independent release fields on both surfaces', async () => {
    for (const [type_code, classificationCode] of [
      ['C', 'HS'],
      ['S', 'EB10'],
    ] as const) {
      availMock.mockResolvedValue([{ ...AVAILABILITY_RECORD, firstReleased: undefined }]);
      const run = await runToolContract(getDataAvailabilityTool, { type_code, classification: '' });
      expect(run.isError).not.toBe(true);
      expect(availMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ classificationCode }),
        expect.anything(),
      );
      expect(run.structuredContent).toMatchObject({ datasets: [{ lastReleased: '2024-05-20' }] });
      expect(JSON.stringify(run.content)).toContain('2024-05-20');
      expect(JSON.stringify(run.content)).not.toContain('2023-03-15');
    }
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

  it('walks stable pages across reordered upstream rows and distinguishes past-end from no matches', async () => {
    const rows = [5, 1, 4, 2, 3].map((reporterCode) => ({ ...AVAILABILITY_RECORD, reporterCode }));
    const seen: number[] = [];
    for (const [offset, expected, nextOffset] of [
      [0, [1, 2], 2],
      [2, [3, 4], 4],
      [4, [5], undefined],
      [8, [], undefined],
    ] as const) {
      availMock.mockResolvedValue(offset % 4 === 0 ? rows : rows.toReversed());
      const run = await runToolContract(getDataAvailabilityTool, { limit: 2, offset });
      expect(run.isError).not.toBe(true);
      expect(run.structuredContent).toMatchObject({
        totalDatasets: 5,
        offset,
        shown: expected.length,
      });
      const page = getDataAvailabilityTool.output.parse(run.structuredContent);
      expect(page.datasets.map((row) => row.reporterCode)).toEqual(expected);
      expect(page.nextOffset).toBe(nextOffset);
      seen.push(...page.datasets.map((row) => row.reporterCode));
      const text = JSON.stringify(run.content);
      expect(text).toContain(`**Offset:** ${offset}`);
      expect(text).toContain(`**Shown:** ${expected.length}`);
      expect(text).not.toContain('No data availability records found');
      if (nextOffset !== undefined) expect(text).toContain(`offset=${nextOffset}`);
      else expect(text).not.toContain('Continue with');
      if (offset === 8) expect(text).toContain('past the end');
    }
    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });

  it('defaults to 50 rows and permits a requested limit beyond the default', async () => {
    availMock.mockResolvedValue(
      Array.from({ length: 51 }, (_, reporterCode) => ({ ...AVAILABILITY_RECORD, reporterCode })),
    );
    for (const [args, shown, truncated] of [
      [{}, 50, true],
      [{ limit: 1000 }, 51, false],
    ] as const) {
      const run = await runToolContract(getDataAvailabilityTool, args);
      expect(run.structuredContent).toMatchObject({
        totalDatasets: 51,
        offset: 0,
        shown,
        truncated,
      });
      expect(JSON.stringify(run.content)).toContain(`**Partial page:** ${truncated}`);
      expect(getDataAvailabilityTool.output.parse(run.structuredContent).datasets).toHaveLength(
        shown,
      );
      expect(JSON.stringify(run.content)).toContain(`**Shown:** ${shown}`);
    }
    expect(getDataAvailabilityTool.annotations?.openWorldHint).toBe(true);
  });

  it('orders tied reporters by period, classification, trade type, then frequency', async () => {
    const variations = [
      { period: '2023', classificationCode: 'HS', typeCode: 'C', freqCode: 'A' },
      { period: '2022', classificationCode: 'HS', typeCode: 'S', freqCode: 'M' },
      { period: '2022', classificationCode: 'HS', typeCode: 'S', freqCode: 'A' },
      { period: '2022', classificationCode: 'HS', typeCode: 'C', freqCode: 'A' },
      { period: '2022', classificationCode: 'H6', typeCode: 'C', freqCode: 'A' },
    ] as const;
    const rows = variations.map((values) => ({ ...AVAILABILITY_RECORD, ...values }));
    const seen: string[] = [];
    for (const offset of [0, 2, 4]) {
      availMock.mockResolvedValue(offset === 2 ? rows.toReversed() : rows);
      const run = await runToolContract(getDataAvailabilityTool, { limit: 2, offset });
      const page = getDataAvailabilityTool.output.parse(run.structuredContent);
      expect(page.datasets.length).toBeGreaterThan(0);
      for (const row of page.datasets) {
        const key = `${row.period}/${row.classificationCode}/${row.typeCode}/${row.freqCode}`;
        seen.push(key);
        expect(JSON.stringify(run.content)).toContain(row.classificationCode);
      }
    }
    expect(seen).toEqual([
      '2022/H6/C/A',
      '2022/HS/C/A',
      '2022/HS/S/A',
      '2022/HS/S/M',
      '2023/HS/C/A',
    ]);
  });

  it.each([{ limit: 0 }, { limit: -1 }, { limit: 1.5 }, { offset: -1 }, { offset: 0.5 }])(
    'rejects invalid page input %j on both surfaces',
    async (args) => {
      const run = await runToolContract(getDataAvailabilityTool, args);
      expect(run.isError).toBe(true);
      expect(run.structuredContent).toMatchObject({ error: { code: -32602 } });
      expect(JSON.stringify(run.content)).toContain('error');
      expect(availMock).not.toHaveBeenCalled();
    },
  );

  it('returns the no-match recovery notice on both surfaces without continuation', async () => {
    availMock.mockResolvedValue([]);
    const run = await runToolContract(getDataAvailabilityTool, { reporter_code: 999 });
    expect(run.structuredContent).toMatchObject({
      datasets: [],
      totalDatasets: 0,
      offset: 0,
      shown: 0,
      notice: expect.stringContaining('Try a different reporter'),
    });
    expect(JSON.stringify(run.content)).toContain('Try a different reporter');
    expect(JSON.stringify(run.content)).not.toContain('Continue with');
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
        // Counts and release dates omitted
      },
    ]);
    const ctx = createMockContext({ errors: getDataAvailabilityTool.errors });
    const input = getDataAvailabilityTool.input.parse({ reporter_code: 840 });
    const result = await getDataAvailabilityTool.handler(input, ctx);
    expect(result.datasets[0]).not.toHaveProperty('totalRecords');
    expect(result.datasets[0]).not.toHaveProperty('publicationDate');
    expect(result.datasets[0]).not.toHaveProperty('firstReleased');
    expect(result.datasets[0]).not.toHaveProperty('lastReleased');
  });

  it('formats output with all key fields', () => {
    const output = {
      datasets: [AVAILABILITY_RECORD],
      totalDatasets: 1,
      truncated: false,
      offset: 0,
      shown: 1,
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
    expect(text).toContain('2024-05-20');
  });
});
