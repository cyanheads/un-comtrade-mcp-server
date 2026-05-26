/**
 * @fileoverview Tests for the get-trade-balance tool.
 * @module tests/tools/get-trade-balance.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTradeBalanceTool } from '@/mcp-server/tools/definitions/get-trade-balance.tool.js';
import {
  ComtradeDataService,
  initComtradeDataService,
} from '@/services/comtrade-data/comtrade-data-service.js';

const mockConfig = {} as Parameters<typeof initComtradeDataService>[0];
const mockStorage = {} as Parameters<typeof initComtradeDataService>[1];

const EXPORT_RECORD = {
  reporterCode: 840,
  reporterDesc: 'United States of America',
  partnerCode: 0,
  partnerDesc: 'World',
  flowCode: 'X',
  cmdCode: 'TOTAL',
  cmdDesc: 'Total (all commodities)',
  period: '2022',
  primaryValue: 2_000_000_000,
};

const IMPORT_RECORD = {
  ...EXPORT_RECORD,
  flowCode: 'M',
  primaryValue: 3_000_000_000,
};

describe('getTradeBalanceTool', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    initComtradeDataService(mockConfig, mockStorage);
    fetchMock = vi
      .spyOn(ComtradeDataService.prototype, 'fetchTradeData')
      .mockImplementation(({ flowCode }: { flowCode: string }) =>
        Promise.resolve({
          records: [flowCode === 'X' ? EXPORT_RECORD : IMPORT_RECORD],
          totalCount: 1,
          truncated: false,
        }),
      );
  });

  it('computes trade balance (exports minus imports)', async () => {
    const ctx = createMockContext({ errors: getTradeBalanceTool.errors });
    const input = getTradeBalanceTool.input.parse({
      reporter_code: 840,
      period: ['2022'],
    });
    const result = await getTradeBalanceTool.handler(input, ctx);
    const p = result.periods[0]!;
    expect(p.exportsUsd).toBe(2_000_000_000);
    expect(p.importsUsd).toBe(3_000_000_000);
    expect(p.balanceUsd).toBe(-1_000_000_000); // deficit
    expect(p.coverageRatio).toBeCloseTo(2 / 3, 3);
  });

  it('marks surplus when exports > imports', async () => {
    fetchMock.mockImplementation(({ flowCode }: { flowCode: string }) =>
      Promise.resolve({
        records: [
          flowCode === 'X'
            ? { ...EXPORT_RECORD, primaryValue: 5_000_000_000 }
            : { ...IMPORT_RECORD, primaryValue: 1_000_000_000 },
        ],
        totalCount: 1,
        truncated: false,
      }),
    );
    const ctx = createMockContext({ errors: getTradeBalanceTool.errors });
    const input = getTradeBalanceTool.input.parse({
      reporter_code: 840,
      period: ['2022'],
    });
    const result = await getTradeBalanceTool.handler(input, ctx);
    expect(result.periods[0]?.balanceUsd).toBe(4_000_000_000);
  });

  it('handles multiple periods', async () => {
    fetchMock.mockImplementation(({ flowCode, period }: { flowCode: string; period: string }) => {
      const periods = period.split(',');
      const records = periods.map((p) => ({
        ...(flowCode === 'X' ? EXPORT_RECORD : IMPORT_RECORD),
        period: p,
        primaryValue: flowCode === 'X' ? 1_000_000_000 : 2_000_000_000,
      }));
      return Promise.resolve({ records, totalCount: records.length, truncated: false });
    });
    const ctx = createMockContext({ errors: getTradeBalanceTool.errors });
    const input = getTradeBalanceTool.input.parse({
      reporter_code: 840,
      period: ['2021', '2022'],
    });
    const result = await getTradeBalanceTool.handler(input, ctx);
    expect(result.periods).toHaveLength(2);
  });

  it('throws ctx.fail("no_data") when both export and import return no data', async () => {
    fetchMock.mockResolvedValue({ records: [], totalCount: 0, truncated: false });
    const ctx = createMockContext({ errors: getTradeBalanceTool.errors });
    const input = getTradeBalanceTool.input.parse({
      reporter_code: 999,
      period: ['1900'],
    });
    await expect(getTradeBalanceTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_data' },
    });
  });

  it('adds note when only export data exists', async () => {
    fetchMock.mockImplementation(({ flowCode }: { flowCode: string }) =>
      Promise.resolve({
        records: flowCode === 'X' ? [EXPORT_RECORD] : [],
        totalCount: flowCode === 'X' ? 1 : 0,
        truncated: false,
      }),
    );
    const ctx = createMockContext({ errors: getTradeBalanceTool.errors });
    const input = getTradeBalanceTool.input.parse({
      reporter_code: 840,
      period: ['2022'],
    });
    const result = await getTradeBalanceTool.handler(input, ctx);
    expect(result.periods[0]?.note).toContain('Export data only');
  });

  it('includes mirrorCaveat in output', async () => {
    const ctx = createMockContext({ errors: getTradeBalanceTool.errors });
    const input = getTradeBalanceTool.input.parse({
      reporter_code: 840,
      period: ['2022'],
    });
    const result = await getTradeBalanceTool.handler(input, ctx);
    expect(result.mirrorCaveat).toBeTruthy();
    expect(result.mirrorCaveat.toLowerCase()).toContain('mirror');
  });

  it('formats output with period, exports, imports, balance, coverage ratio, and mirror caveat', () => {
    const output = {
      periods: [
        {
          period: '2022',
          exportsUsd: 2_000_000_000,
          importsUsd: 3_000_000_000,
          balanceUsd: -1_000_000_000,
          coverageRatio: 0.667,
        },
      ],
      reporterCode: 840,
      reporterDesc: 'United States of America',
      mirrorCaveat:
        'Balance reflects values as reported by this country. Mirror asymmetry is common.',
    };
    const blocks = getTradeBalanceTool.format!(output);
    expect(blocks[0].type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('2022');
    expect(text).toContain('Exports');
    expect(text).toContain('Imports');
    expect(text).toContain('Balance');
    expect(text).toContain('Deficit');
    expect(text).toContain('Coverage Ratio');
    expect(text.toLowerCase()).toContain('mirror');
  });
});
