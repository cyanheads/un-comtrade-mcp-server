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
      'partner_only_reporter',
      'rate_limited',
      'deadline_exceeded',
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
      { referenceStatus: 'partner_only', name: 'Metropolitan France', suggestedReporterCode: 251 },
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
});
