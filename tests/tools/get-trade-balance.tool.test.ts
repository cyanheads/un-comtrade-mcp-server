/**
 * @fileoverview Tests for the get-trade-balance tool.
 * @module tests/tools/get-trade-balance.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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

  it.each([undefined, 0, 276])(
    'forwards bilateral partner %s to both flows and echoes it on both surfaces',
    async (partner_code) => {
      const partnerCode = partner_code ?? 0;
      const partnerDesc = partnerCode === 0 ? 'World' : 'Germany';
      fetchMock.mockImplementation(({ flowCode }: { flowCode: string }) =>
        Promise.resolve({
          records: [
            { ...(flowCode === 'X' ? EXPORT_RECORD : IMPORT_RECORD), partnerCode, partnerDesc },
          ],
          totalCount: 1,
          truncated: false,
        }),
      );
      const result = await runToolContract(getTradeBalanceTool, {
        reporter_code: 840,
        partner_code,
        period: ['2022'],
      });
      expect(result.isError).not.toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      for (const [params] of fetchMock.mock.calls) expect(params).toMatchObject({ partnerCode });
      expect(fetchMock.mock.calls[0]?.[1]).toBe(fetchMock.mock.calls[1]?.[1]);
      expect(result.structuredContent).toMatchObject({
        partnerCode,
        partnerDesc,
        periods: [{ balanceUsd: -1_000_000_000 }],
      });
      expect(JSON.stringify(result.content)).toContain(
        `**Partner:** ${partnerDesc} (code ${partnerCode})`,
      );
    },
  );

  it('keeps commodity sums and partial-flow period alignment for a bilateral query', async () => {
    fetchMock.mockImplementation(({ flowCode }: { flowCode: string }) =>
      Promise.resolve({
        records:
          flowCode === 'X'
            ? [
                {
                  ...EXPORT_RECORD,
                  partnerCode: 276,
                  partnerDesc: 'Germany',
                  cmdCode: '84',
                  primaryValue: 30,
                },
                {
                  ...EXPORT_RECORD,
                  partnerCode: 276,
                  partnerDesc: 'Germany',
                  cmdCode: '85',
                  primaryValue: 20,
                },
              ]
            : [
                {
                  ...IMPORT_RECORD,
                  partnerCode: 276,
                  partnerDesc: 'Germany',
                  cmdCode: '84',
                  primaryValue: 10,
                  period: '2023',
                },
              ],
        totalCount: flowCode === 'X' ? 2 : 1,
        truncated: false,
      }),
    );
    const result = await runToolContract(getTradeBalanceTool, {
      reporter_code: 840,
      partner_code: 276,
      period: ['2022', '2023'],
      cmd_code: ['84', '85'],
    });
    expect(result.structuredContent).toMatchObject({
      partnerCode: 276,
      cmdCodes: ['84', '85'],
      periods: [
        {
          period: '2022',
          exportsUsd: 50,
          balanceUsd: 50,
          note: 'Export data only; no import data found for this period.',
        },
        {
          period: '2023',
          importsUsd: 10,
          balanceUsd: -10,
          note: 'Import data only; no export data found for this period.',
        },
      ],
    });
    for (const text of ['2022', '2023', 'Export data only', 'Import data only', '84, 85'])
      expect(JSON.stringify(result.content)).toContain(text);
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

  it('advertises only the reasons a code path can produce', () => {
    expect(getTradeBalanceTool.errors?.map((e) => e.reason)).toEqual([
      'keyless_hs_edition_unsupported',
      'invalid_reporter_filter',
      'upstream_validation',
      'invalid_upstream_response',
      'no_data',
    ]);
  });

  it('carries the declared no_data recovery hint on both consumption surfaces', async () => {
    fetchMock.mockResolvedValue({ records: [], totalCount: 0, truncated: false });
    const declaredHint = getTradeBalanceTool.errors?.find((e) => e.reason === 'no_data')?.recovery;

    const result = await runToolContract(getTradeBalanceTool, {
      reporter_code: 999,
      period: ['1900'],
    });

    expect(result.isError).toBe(true);
    // structuredContent — what Claude Code reads
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'no_data', recovery: { hint: declaredHint } },
      },
    });
    // content[] — what Claude Desktop reads
    const block = result.content?.[0];
    expect(block).toMatchObject({ type: 'text' });
    const text = (block as { text: string }).text;
    expect(text).toContain('No trade data found for reporter 999');
    expect(text).toContain(declaredHint);
    expect(text).toContain('reason no_data');
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

  it('preserves distinct reference notices from both trade directions', async () => {
    fetchMock.mockImplementation(({ flowCode }: { flowCode: string }) =>
      Promise.resolve({
        records: [flowCode === 'X' ? EXPORT_RECORD : IMPORT_RECORD],
        totalCount: 1,
        truncated: false,
        referenceNotice:
          flowCode === 'X' ? 'H0 descriptions unavailable.' : 'Quantity units unavailable.',
      }),
    );
    const result = await runToolContract(getTradeBalanceTool, {
      reporter_code: 840,
      period: ['2022'],
    });
    expect(result.structuredContent).toMatchObject({
      referenceNotice: 'H0 descriptions unavailable. Quantity units unavailable.',
    });
    expect(JSON.stringify(result.content)).toContain(
      'H0 descriptions unavailable. Quantity units unavailable.',
    );
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
      partnerCode: 0,
      partnerDesc: 'World',
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
