/**
 * @fileoverview Tests for the get-trade-balance tool.
 * @module tests/tools/get-trade-balance.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTradeBalanceTool } from '@/mcp-server/tools/definitions/get-trade-balance.tool.js';
import {
  ComtradeDataService,
  getComtradeDataService,
  initComtradeDataService,
} from '@/services/comtrade-data/comtrade-data-service.js';
import {
  ComtradeReferenceService,
  initComtradeReferenceService,
} from '@/services/comtrade-reference/comtrade-reference-service.js';
import type { ReporterStatus } from '@/services/comtrade-reference/types.js';

const mockConfig = {} as Parameters<typeof initComtradeDataService>[0];
const mockStorage = {} as Parameters<typeof initComtradeDataService>[1];

/** Every text block of a tool result, as one string. */
function textOf(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return (result.content ?? []).map((block) => (block as { text: string }).text).join('\n');
}

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
    // An unloaded index classifies every code as unknown, so empty results stay no_data.
    initComtradeReferenceService(mockConfig, mockStorage);
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
          note: 'Export data only; no import data found for this period.',
        },
        {
          period: '2023',
          importsUsd: 10,
          note: 'Import data only; no export data found for this period.',
        },
      ],
    });
    // A missing flow is not zero, so neither period has a balance or coverage ratio.
    for (const period of (result.structuredContent as { periods: object[] }).periods) {
      expect(period).not.toHaveProperty('balanceUsd');
      expect(period).not.toHaveProperty('coverageRatio');
    }
    for (const text of ['2022', '2023', 'Export data only', 'Import data only', '84, 85'])
      expect(JSON.stringify(result.content)).toContain(text);
    for (const text of ['**Balance:**', 'Surplus', 'Deficit'])
      expect(JSON.stringify(result.content)).not.toContain(text);
  });

  it('balances only periods with both flows, notes a served period with neither, and leaves out a failed one', async () => {
    fetchMock.mockImplementation(({ flowCode }: { flowCode: string }) =>
      Promise.resolve(
        flowCode === 'X'
          ? {
              records: [EXPORT_RECORD, { ...EXPORT_RECORD, period: '2023' }],
              totalCount: 2,
              truncated: false,
            }
          : {
              records: [IMPORT_RECORD],
              totalCount: 1,
              truncated: false,
              failedPeriods: [{ period: '2025', reason: 'rate_limited', retryAfterSeconds: 5 }],
            },
      ),
    );
    const result = await runToolContract(getTradeBalanceTool, {
      reporter_code: 840,
      period: ['2022', '2023', '2024', '2025'],
    });
    const neither = 'No export or import data found for this period.';
    const notice =
      'Period 2025 was rate-limited; wait 5 seconds before requesting it again. Period 2024 returned no export or import data; use comtrade_get_data_availability to check whether it is published.';
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      periods: [
        {
          period: '2022',
          exportsUsd: 2_000_000_000,
          importsUsd: 3_000_000_000,
          balanceUsd: -1_000_000_000,
        },
        {
          period: '2023',
          exportsUsd: 2_000_000_000,
          note: 'Export data only; no import data found for this period.',
        },
        { period: '2024', note: neither },
      ],
      unservedPeriods: ['2025'],
      notice,
    });
    const { periods } = result.structuredContent as { periods: object[] };
    expect(periods[1]).not.toHaveProperty('balanceUsd');
    expect(periods[2]).toEqual({ period: '2024', note: neither });
    const text = textOf(result);
    expect(text).toContain(`### Period: 2024\n> Note: ${neither}`);
    expect(text).toContain('**Balance:** $1,000,000,000 USD (Deficit)');
    expect(text.match(/\*\*Balance:\*\*|Surplus|Deficit/g)).toEqual(['**Balance:**', 'Deficit']);
    expect(text).not.toContain('Period: 2025');
    expect(text).toContain(`> ${notice}`);
  });

  it('names every served period with neither flow in one notice sentence', async () => {
    fetchMock.mockImplementation(({ flowCode }: { flowCode: string }) =>
      Promise.resolve({
        records: [{ ...(flowCode === 'X' ? EXPORT_RECORD : IMPORT_RECORD), period: '2021' }],
        totalCount: 1,
        truncated: false,
      }),
    );
    const result = await runToolContract(getTradeBalanceTool, {
      reporter_code: 840,
      period: ['2021', '2025', '2026'],
    });
    const notice =
      'Periods 2025, 2026 returned no export or import data; use comtrade_get_data_availability to check whether they are published.';
    expect(result.structuredContent).toMatchObject({
      periods: [
        { period: '2021', balanceUsd: -1_000_000_000 },
        { period: '2025', note: 'No export or import data found for this period.' },
        { period: '2026', note: 'No export or import data found for this period.' },
      ],
      notice,
    });
    expect(textOf(result)).toContain(`> ${notice}`);
  });

  it('labels a positive balance Surplus, a negative one Deficit, and a zero balance neither', () => {
    const blocks = getTradeBalanceTool.format!({
      periods: [
        { period: '2021', exportsUsd: 5, importsUsd: 3, balanceUsd: 2, coverageRatio: 5 / 3 },
        { period: '2022', exportsUsd: 3, importsUsd: 5, balanceUsd: -2, coverageRatio: 0.6 },
        { period: '2023', exportsUsd: 4, importsUsd: 4, balanceUsd: 0, coverageRatio: 1 },
      ],
      reporterCode: 840,
      reporterDesc: 'United States of America',
      partnerCode: 0,
      partnerDesc: 'World',
      mirrorCaveat: 'Mirror asymmetry is common.',
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**Balance:** $2 USD (Surplus)');
    expect(text).toContain('**Balance:** $2 USD (Deficit)');
    expect(text).toContain('**Balance:** $0 USD\n**Coverage Ratio:** 1\n');
    expect(text.match(/Surplus|Deficit/g)).toEqual(['Surplus', 'Deficit']);
  });

  it('renders the coverage ratio at the precision structuredContent carries', async () => {
    fetchMock.mockImplementation(({ flowCode }: { flowCode: string }) =>
      Promise.resolve({
        records: [
          flowCode === 'X'
            ? { ...EXPORT_RECORD, primaryValue: 5_000_000 }
            : { ...IMPORT_RECORD, primaryValue: 3_000_000 },
        ],
        totalCount: 1,
        truncated: false,
      }),
    );
    const result = await runToolContract(getTradeBalanceTool, {
      reporter_code: 840,
      period: ['2022'],
    });
    const ratio = (result.structuredContent as { periods: { coverageRatio: number }[] }).periods[0]
      ?.coverageRatio;
    expect(ratio).toBe(5 / 3);
    expect(textOf(result)).toContain(`**Coverage Ratio:** ${5 / 3}\n`);
  });

  it('balances a period whose import rows sum to zero, leaving out the coverage ratio', async () => {
    fetchMock.mockImplementation(({ flowCode }: { flowCode: string }) =>
      Promise.resolve({
        records: [
          flowCode === 'X'
            ? { ...EXPORT_RECORD, primaryValue: 5_000_000 }
            : { ...IMPORT_RECORD, primaryValue: 0 },
        ],
        totalCount: 1,
        truncated: false,
      }),
    );
    const result = await runToolContract(getTradeBalanceTool, {
      reporter_code: 840,
      period: ['2022'],
    });
    expect(result.isError).not.toBe(true);
    expect((result.structuredContent as { periods: object[] }).periods).toEqual([
      { period: '2022', exportsUsd: 5_000_000, importsUsd: 0, balanceUsd: 5_000_000 },
    ]);
    const text = textOf(result);
    expect(text).toContain('**Balance:** $5,000,000 USD (Surplus)');
    expect(text).not.toContain('Coverage Ratio');
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
      'overlapping_cmd_codes',
      'upstream_validation',
      'invalid_upstream_response',
      'no_data',
      'partner_only_reporter',
      'rate_limited',
      'upstream_unavailable',
      'deadline_exceeded',
    ]);
  });

  it.each([
    ['HS', ['27', '2709'], '27', '2709'],
    ['HS', ['2709', '27'], '2709', '27'],
    ['HS', ['TOTAL', '27'], 'TOTAL', '27'],
    ['HS', ['TOTAL', 'AG2'], 'TOTAL', 'AG2'],
    ['HS', ['ag2', '2709'], 'AG2', '2709'],
    ['HS', ['AG2', 'AG4'], 'AG2', 'AG4'],
    ['HS', ['AG4', '27'], 'AG4', '27'],
    ['HS', ['9999', '9999AA'], '9999', '9999AA'],
    ['S4', ['33', '333'], '33', '333'],
    ['S4', ['AG1', 'AG2'], 'AG1', 'AG2'],
    // Every AG selector is three characters, so AG3 overlaps another selector on the AG rule alone.
    ['S4', ['AG3', 'AG1'], 'AG3', 'AG1'],
    ['S4', ['AG3', '33'], 'AG3', '33'],
    ['S4', ['93', '93X'], '93', '93X'],
    // The earliest entry that overlaps a later one, with the first entry it overlaps.
    ['HS', ['01', '27', '2709', '0101'], '01', '0101'],
    // Codes past the 20-code cap count: a caller adds their follow-up balances to this one.
    [
      'HS',
      [...Array.from({ length: 20 }, (_, i) => String(i).padStart(2, '0')), '27', '2709'],
      '27',
      '2709',
    ],
  ] as const)(
    'rejects %s cmd_code %j naming %s and %s before any request',
    async (classification, cmd_code, first, second) => {
      const hint = getTradeBalanceTool.errors?.find(
        (e) => e.reason === 'overlapping_cmd_codes',
      )?.recovery;
      const message = `cmd_code entries ${first} and ${second} overlap, so the balance would count their shared trade twice.`;
      const result = await runToolContract(getTradeBalanceTool, {
        reporter_code: 842,
        period: ['2023'],
        classification,
        cmd_code,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(hint).toEqual(expect.any(String));
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          message,
          data: { reason: 'overlapping_cmd_codes', recovery: { hint } },
        },
      });
      const text = textOf(result);
      expect(text).toContain(message);
      expect(text).toContain(hint);
      expect(text).toContain('reason overlapping_cmd_codes');
    },
  );

  it.each([
    ['HS', undefined, 'TOTAL'],
    ['HS', ['TOTAL'], 'TOTAL'],
    ['HS', ['ag2'], 'AG2'],
    ['S4', ['AG3'], 'AG3'],
    ['HS', ['27', '84'], '27,84'],
    ['HS', ['2709', '2710'], '2709,2710'],
    ['HS', ['AG2', '27'], 'AG2,27'],
    ['HS', ['AG6', '9999AA'], 'AG6,9999AA'],
    ['S4', ['AG3', '333'], 'AG3,333'],
    ['S4', ['333', '334'], '333,334'],
  ] as const)(
    'accepts %s cmd_code %j and requests %s for both flows',
    async (classification, cmd_code, cmdCode) => {
      const result = await runToolContract(getTradeBalanceTool, {
        reporter_code: 840,
        period: ['2022'],
        classification,
        ...(cmd_code && { cmd_code }),
      });
      expect(result.isError).not.toBe(true);
      expect(fetchMock.mock.calls.map(([params]) => params.cmdCode)).toEqual([cmdCode, cmdCode]);
    },
  );

  it('drops exact duplicates before the 20-code cap, so served and unserved codes are distinct', async () => {
    const twoDigit = Array.from({ length: 20 }, (_, i) => String(i).padStart(2, '0'));
    const served = ['27', ...twoDigit.slice(0, 19)];
    const result = await runToolContract(getTradeBalanceTool, {
      reporter_code: 840,
      period: ['2022'],
      cmd_code: ['27', ' 27 ', ...twoDigit, '00'],
    });
    expect(result.isError).not.toBe(true);
    expect(fetchMock.mock.calls.map(([params]) => params.cmdCode)).toEqual([
      served.join(','),
      served.join(','),
    ]);
    expect(result.structuredContent).toMatchObject({ cmdCodes: served, unservedCmdCodes: ['19'] });
    const text = textOf(result);
    expect(text).toContain(`**Commodities:** ${served.join(', ')}`);
    expect(text).toContain('**Unserved commodity codes:** 19. Query them separately.');
  });

  it('drops repeated periods before the period cap, so served and unserved periods are distinct', async () => {
    const result = await runToolContract(getTradeBalanceTool, {
      reporter_code: 840,
      period: ['2022', '2023', '2022', '2024', '2025', '2023', '2026'],
    });
    expect(result.isError).not.toBe(true);
    // Keyless serves 4 periods per call, each flow requesting all of them.
    expect(fetchMock.mock.calls.map(([params]) => params.period)).toEqual([
      '2022,2023,2024,2025',
      '2022,2023,2024,2025',
    ]);
    expect(result.structuredContent).toMatchObject({ unservedPeriods: ['2026'] });
    expect(textOf(result)).toContain('**Unserved periods:** 2026. Query them separately.');
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

  it('leaves out a period whose import request failed, keeping "Export data only" for an import that answered with no rows', async () => {
    fetchMock.mockImplementation(({ flowCode }: { flowCode: string }) =>
      Promise.resolve(
        flowCode === 'X'
          ? {
              records: ['2022', '2023', '2024'].map((period) => ({ ...EXPORT_RECORD, period })),
              totalCount: 500,
              truncated: true,
            }
          : {
              records: [IMPORT_RECORD],
              totalCount: 1,
              truncated: false,
              failedPeriods: [{ period: '2023', reason: 'rate_limited', retryAfterSeconds: 5 }],
            },
      ),
    );
    const result = await runToolContract(getTradeBalanceTool, {
      reporter_code: 840,
      period: ['2022', '2023', '2024'],
    });
    const notice =
      'Period 2023 was rate-limited; wait 5 seconds before requesting it again. A preview response reached 500 records; balance values may be incomplete. Narrow the commodity query.';
    expect(result.structuredContent).toMatchObject({
      periods: [
        { period: '2022', exportsUsd: 2_000_000_000, importsUsd: 3_000_000_000 },
        {
          period: '2024',
          exportsUsd: 2_000_000_000,
          note: 'Export data only; no import data found for this period.',
        },
      ],
      unservedPeriods: ['2023'],
      notice,
    });
    const text = textOf(result);
    expect(text).not.toContain('Period: 2023');
    expect(text.split('Export data only')).toHaveLength(2);
    expect(text).toContain('**Unserved periods:** 2023. Query them separately.');
    expect(text).toContain(`> ${notice}`);
  });

  it('fails with the period failure when the two flows completed disjoint periods', async () => {
    fetchMock.mockImplementation(({ flowCode }: { flowCode: string }) =>
      Promise.resolve(
        flowCode === 'X'
          ? {
              records: [EXPORT_RECORD],
              totalCount: 1,
              truncated: false,
              failedPeriods: [
                { period: '2023', reason: 'deadline_exceeded' },
                { period: '2024', reason: 'deadline_exceeded' },
              ],
            }
          : {
              records: [{ ...IMPORT_RECORD, period: '2023' }],
              totalCount: 1,
              truncated: false,
              failedPeriods: [
                { period: '2022', reason: 'rate_limited', retryAfterSeconds: 9 },
                { period: '2024', reason: 'rate_limited', retryAfterSeconds: 7 },
              ],
            },
      ),
    );
    const result = await runToolContract(getTradeBalanceTool, {
      reporter_code: 840,
      period: ['2022', '2023', '2024'],
    });
    const message =
      "No requested period was served. Periods 2022, 2024 were rate-limited; wait 9 seconds before requesting them again. Period 2023 was not completed within the call's time budget.";
    const hint = 'Wait 9 seconds, then retry with fewer periods.';
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.RateLimited,
        message,
        data: { reason: 'rate_limited', retryable: true, retryAfter: 9, recovery: { hint } },
      },
    });
    const text = textOf(result);
    expect(text).toContain(message);
    expect(text).toContain(hint);
    expect(text).toContain('reason rate_limited');
  });

  it('fails with upstream_unavailable when each period failed in one flow on a server error', async () => {
    fetchMock.mockImplementation(({ flowCode }: { flowCode: string }) =>
      Promise.resolve({
        records: [
          {
            ...(flowCode === 'X' ? EXPORT_RECORD : IMPORT_RECORD),
            period: flowCode === 'X' ? '2023' : '2022',
          },
        ],
        totalCount: 1,
        truncated: false,
        failedPeriods: [
          { period: flowCode === 'X' ? '2022' : '2023', reason: 'upstream_unavailable' },
        ],
      }),
    );
    const result = await runToolContract(getTradeBalanceTool, {
      reporter_code: 840,
      period: ['2022', '2023'],
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: expect.stringMatching(/^No requested period was served\. .*2022.*2023/),
        data: {
          reason: 'upstream_unavailable',
          retryable: true,
          recovery: { hint: expect.any(String) },
        },
      },
    });
    expect(textOf(result)).toContain('reason upstream_unavailable');
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

describe('getTradeBalanceTool partner-only reporters and frequency inference', () => {
  const statuses = new Map<number, ReporterStatus>([
    [840, { referenceStatus: 'reporter', name: 'USA' }],
    [
      250,
      {
        referenceStatus: 'partner_only',
        name: 'Metropolitan France',
        suggestedReporterCode: 251,
        suggestionBasis: 'iso3',
      },
    ],
    [
      158,
      {
        referenceStatus: 'partner_only',
        name: 'Taiwan, Province of China',
        suggestedReporterCode: 490,
        suggestionBasis: 'published_under',
        suggestedReporterName: 'Other Asia, nes',
      },
    ],
    [0, { referenceStatus: 'partner_only', name: 'World' }],
  ]);
  let fetchMock: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    initComtradeDataService(mockConfig, mockStorage);
    initComtradeReferenceService(mockConfig, mockStorage);
    vi.spyOn(ComtradeReferenceService.prototype, 'getReporterStatus').mockImplementation(
      (code) => statuses.get(code) ?? { referenceStatus: 'unknown' },
    );
    fetchMock = vi
      .spyOn(ComtradeDataService.prototype, 'fetchTradeData')
      .mockResolvedValue({ records: [], totalCount: 0, truncated: false });
  });
  afterEach(() => vi.restoreAllMocks());

  it('fails with partner_only_reporter naming the suggested reporter on both surfaces', async () => {
    const result = await runToolContract(getTradeBalanceTool, {
      reporter_code: 250,
      period: ['2022'],
    });
    const message =
      'No trade data found for reporter 250, periods [2022]. Reporter 250 (Metropolitan France) is a partner-only code in UN Comtrade reference data; reporter 251 shares its ISO-3 identity. Retry with reporter_code 251.';
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [params] of fetchMock.mock.calls)
      expect(params).toMatchObject({ reporterCode: 250 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        message,
        data: {
          reason: 'partner_only_reporter',
          suggestedReporterCode: 251,
          recovery: { hint: 'Retry with reporter_code 251.' },
        },
      },
    });
    const text = textOf(result);
    expect(text).toContain(
      'Reporter 250 (Metropolitan France) is a partner-only code in UN Comtrade reference data; reporter 251 shares its ISO-3 identity. Retry with reporter_code 251.',
    );
    expect(text).toContain('reason partner_only_reporter');
  });

  it('fails with partner_only_reporter and the lookup recovery for reporter 0', async () => {
    const result = await runToolContract(getTradeBalanceTool, {
      reporter_code: 0,
      period: ['2022'],
    });
    const hint = 'Find a reporter with comtrade_lookup_countries using role "reporter".';
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        message:
          'No trade data found for reporter 0, periods [2022]. Reporter 0 (World) is a partner-only code in UN Comtrade reference data and has no reporter-valid counterpart. Find a reporter with comtrade_lookup_countries using role "reporter".',
        data: { reason: 'partner_only_reporter', recovery: { hint } },
      },
    });
    expect((result.structuredContent as { error: { data: object } }).error.data).not.toHaveProperty(
      'suggestedReporterCode',
    );
    expect(textOf(result)).toContain(hint);
  });

  it('fails with partner_only_reporter naming the code UN Comtrade publishes reporter 158 under', async () => {
    const result = await runToolContract(getTradeBalanceTool, {
      reporter_code: 158,
      period: ['2023'],
    });
    const sentence =
      'Reporter 158 (Taiwan, Province of China) is a partner-only code in UN Comtrade reference data; UN Comtrade publishes its trade under reporter 490 (Other Asia, nes). Retry with reporter_code 490.';
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        message: `No trade data found for reporter 158, periods [2023]. ${sentence}`,
        data: {
          reason: 'partner_only_reporter',
          suggestedReporterCode: 490,
          recovery: { hint: 'Retry with reporter_code 490.' },
        },
      },
    });
    expect(textOf(result)).toContain(sentence);
  });

  it('names partner_code 490 in no_data for partner 158, replacing the availability hint', async () => {
    const result = await runToolContract(getTradeBalanceTool, {
      reporter_code: 840,
      partner_code: 158,
      period: ['2023'],
    });
    const sentence =
      'UN Comtrade publishes the trade of partner 158 (Taiwan, Province of China) under 490 (Other Asia, nes). Retry with partner_code 490.';
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        message: `No trade data found for reporter 840 and partner 158, periods [2023]. ${sentence}`,
        data: {
          reason: 'no_data',
          suggestedPartnerCode: 490,
          recovery: { hint: 'Retry with partner_code 490.' },
        },
      },
    });
    const text = textOf(result);
    expect(text).toContain(sentence);
    expect(text).not.toContain('comtrade_get_data_availability');
  });

  it('names both counterparts when the reporter and the partner each have one', async () => {
    const result = await runToolContract(getTradeBalanceTool, {
      reporter_code: 158,
      partner_code: 250,
      period: ['2023'],
    });
    expect(result.structuredContent).toMatchObject({
      error: {
        message:
          'No trade data found for reporter 158 and partner 250, periods [2023]. Reporter 158 (Taiwan, Province of China) is a partner-only code in UN Comtrade reference data; UN Comtrade publishes its trade under reporter 490 (Other Asia, nes). Retry with reporter_code 490. Partner 250 (Metropolitan France) shares its ISO-3 identity with 251. Retry with partner_code 251.',
        data: {
          reason: 'partner_only_reporter',
          suggestedReporterCode: 490,
          suggestedPartnerCode: 251,
          recovery: { hint: 'Retry with reporter_code 490 and partner_code 251.' },
        },
      },
    });
  });

  it.each([
    [842, 'No trade data found for reporter 842 and partner 10, periods [2022, 2023]', 'no_data'],
    [
      250,
      'No trade data found for reporter 250 and partner 10, periods [2022, 2023]. Reporter 250 (Metropolitan France) is a partner-only code in UN Comtrade reference data; reporter 251 shares its ISO-3 identity. Retry with reporter_code 251.',
      'partner_only_reporter',
    ],
  ] as const)(
    'names a bilateral partner in the empty-result message for reporter %d',
    async (reporter_code, message, reason) => {
      const result = await runToolContract(getTradeBalanceTool, {
        reporter_code,
        partner_code: 10,
        period: ['2022', '2023'],
      });
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.NotFound, message, data: { reason } },
      });
      expect(textOf(result)).toContain(`reporter ${reporter_code} and partner 10`);
    },
  );

  it('names served periods that answered empty when the others failed', async () => {
    fetchMock.mockImplementation(({ flowCode }: { flowCode: string }) =>
      Promise.resolve({
        records: [],
        totalCount: 0,
        truncated: false,
        ...(flowCode === 'X' && {
          failedPeriods: [{ period: '2022', reason: 'rate_limited', retryAfterSeconds: 7 }],
        }),
      }),
    );
    const result = await runToolContract(getTradeBalanceTool, {
      reporter_code: 842,
      period: ['2022', '2023'],
    });
    const message =
      'Served period 2023 returned no trade data. Period 2022 was rate-limited; wait 7 seconds before requesting it again.';
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RateLimited, message, data: { reason: 'rate_limited' } },
    });
    expect(textOf(result)).toContain(message);
  });

  it('keeps the period failure when a partner-only reporter has nothing served', async () => {
    fetchMock.mockImplementation(({ flowCode }: { flowCode: string }) =>
      Promise.resolve({
        records: [],
        totalCount: 0,
        truncated: false,
        ...(flowCode === 'M' && {
          failedPeriods: [{ period: '2022', reason: 'rate_limited', retryAfterSeconds: 7 }],
        }),
      }),
    );
    const result = await runToolContract(getTradeBalanceTool, {
      reporter_code: 250,
      period: ['2022'],
    });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.RateLimited,
        data: { reason: 'rate_limited', retryAfter: 7 },
      },
    });
  });

  it('computes a balance for a partner-only code that returns rows', async () => {
    fetchMock.mockImplementation(({ flowCode }: { flowCode: string }) =>
      Promise.resolve({
        records: [{ ...(flowCode === 'X' ? EXPORT_RECORD : IMPORT_RECORD), reporterCode: 250 }],
        totalCount: 1,
        truncated: false,
      }),
    );
    const result = await runToolContract(getTradeBalanceTool, {
      reporter_code: 250,
      period: ['2022'],
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      reporterCode: 250,
      periods: [{ period: '2022', balanceUsd: -1_000_000_000 }],
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('sends both flows on the monthly frequency inferred from YYYYMM periods', async () => {
    fetchMock.mockImplementation(({ flowCode }: { flowCode: string }) =>
      Promise.resolve({
        records: [{ ...(flowCode === 'X' ? EXPORT_RECORD : IMPORT_RECORD), period: '202401' }],
        totalCount: 1,
        truncated: false,
      }),
    );
    const result = await runToolContract(getTradeBalanceTool, {
      reporter_code: 840,
      period: ['202401'],
    });
    expect(result.isError).not.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([params]) => [params.flowCode, params.freqCode])).toEqual([
      ['X', 'M'],
      ['M', 'M'],
    ]);
    expect(result.structuredContent).toMatchObject({ periods: [{ period: '202401' }] });
  });
});

describe('getTradeBalanceTool on the keyless data service', () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    initComtradeDataService(mockConfig, mockStorage);
    initComtradeReferenceService(mockConfig, mockStorage);
    fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('Unexpected live fetch'));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    getComtradeDataService().dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it('stops the export flow when the import flow is rejected, so nothing starts after the tool settles', async () => {
    const starts: string[] = [];
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.hostname !== 'comtradeapi.un.org' || !url.pathname.startsWith('/public/v1/preview/'))
        throw new Error(`Unexpected fetch ${url.pathname}`);
      const flowCode = url.searchParams.get('flowCode');
      const period = url.searchParams.get('period');
      starts.push(`${flowCode} ${period}`);
      return flowCode === 'M'
        ? Response.json(
            {
              error: 'Invalid parameter value',
              details: [{ memberNames: ['period'], errorMessage: 'The field period is invalid' }],
            },
            { status: 400 },
          )
        : Response.json({
            data: [{ ...EXPORT_RECORD, period, motCode: 0, customsCode: 'C00', partner2Code: 0 }],
          });
    });
    let atSettle: { starts: string[]; timers: number } | undefined;
    const run = runToolContract(getTradeBalanceTool, {
      reporter_code: 840,
      period: ['2021', '2022', '2023'],
    }).then((result) => {
      atSettle = { starts: [...starts], timers: vi.getTimerCount() };
      return result;
    });
    await vi.runAllTimersAsync();
    const result = await run;
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'upstream_validation' } },
    });
    // The export flow's 2022 request was queued behind the rejected import request.
    expect(starts).toEqual(['X 2021', 'M 2021']);
    expect(atSettle).toEqual({ starts, timers: 0 });
  });

  it('serves the period both flows completed when one flow answers 503 for another, relaying none of the page', async () => {
    const page =
      '<!DOCTYPE html><html><body><h1>503</h1><p>edge-proxy-7.internal.example</p></body></html>';
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      const flowCode = url.searchParams.get('flowCode');
      const period = url.searchParams.get('period');
      if (flowCode === 'M' && period === '2022')
        return new Response(page, { status: 503, headers: { 'content-type': 'text/html' } });
      return Response.json({
        data: [
          {
            ...(flowCode === 'X' ? EXPORT_RECORD : IMPORT_RECORD),
            period,
            motCode: 0,
            customsCode: 'C00',
            partner2Code: 0,
          },
        ],
      });
    });
    const run = runToolContract(getTradeBalanceTool, {
      reporter_code: 840,
      period: ['2021', '2022'],
    });
    await vi.runAllTimersAsync();
    const result = await run;
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      periods: [{ period: '2021', balanceUsd: -1_000_000_000 }],
      unservedPeriods: ['2022'],
      notice: expect.stringMatching(/2022.*503|503.*2022/),
    });
    expect((result.structuredContent as { periods: unknown[] }).periods).toHaveLength(1);
    const text = textOf(result);
    expect(text).toContain('**Unserved periods:** 2022. Query them separately.');
    expect(text).not.toContain('Period: 2022');
    for (const fragment of ['DOCTYPE', '<h1>', 'edge-proxy-7'])
      expect(JSON.stringify(result)).not.toContain(fragment);
  });

  it.each([
    ['M', 'X'],
    ['X', 'M'],
  ])(
    'ranks the %s flow’s rate limit above the %s flow’s server error, though the server error ends first',
    async (limitedFlow) => {
      fetchMock.mockImplementation(async (input) =>
        new URL(String(input)).searchParams.get('flowCode') === limitedFlow
          ? new Response('{}', { status: 429, headers: { 'retry-after': '6' } })
          : new Response('<!DOCTYPE html><html><body>503</body></html>', {
              status: 503,
              headers: { 'content-type': 'text/html' },
            }),
      );
      const run = runToolContract(getTradeBalanceTool, { reporter_code: 840, period: ['2022'] });
      await vi.runAllTimersAsync();
      const result = await run;
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.RateLimited,
          message:
            'No requested period was served. Period 2022 was rate-limited; wait 6 seconds before requesting it again.',
          data: { reason: 'rate_limited', retryAfter: 6 },
        },
      });
    },
  );
});
