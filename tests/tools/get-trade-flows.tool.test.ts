/**
 * @fileoverview Tests for the get-trade-flows tool.
 * @module tests/tools/get-trade-flows.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTradeFlowsTool } from '@/mcp-server/tools/definitions/get-trade-flows.tool.js';
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
    // An unloaded index classifies every code as unknown, leaving empty-result notices unchanged.
    initComtradeReferenceService(mockConfig, mockStorage);
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

  it('lists failed served periods, then periods past the keyless cap, with the failure notice on both surfaces', async () => {
    const periods = Array.from({ length: 10 }, (_, i) => String(2016 + i));
    fetchMock.mockResolvedValue({
      records: ['2016', '2018', '2020', '2021', '2022', '2023'].map((period) => ({
        ...RECORD_USA_DEU,
        period,
      })),
      totalCount: 6,
      truncated: false,
      failedPeriods: [
        { period: '2017', reason: 'rate_limited', retryAfterSeconds: 6 },
        { period: '2019', reason: 'deadline_exceeded' },
      ],
    });
    const result = await runToolContract(getTradeFlowsTool, {
      reporter_code: 840,
      flow_code: 'X',
      period: periods,
    });
    const notice =
      "Period 2017 was rate-limited; wait 6 seconds before requesting it again. Period 2019 was not completed within the call's time budget.";
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ period: periods.slice(0, 8).join(',') }),
      expect.anything(),
    );
    expect(result.structuredContent).toMatchObject({
      shown: 6,
      unservedPeriods: ['2017', '2019', '2024', '2025'],
      notice,
    });
    const text = textOf(result);
    expect(text).toContain('**Unserved periods:** 2017, 2019, 2024, 2025. Query them separately.');
    expect(text).toContain(`> ${notice}`);
    expect(text).not.toContain('No trade flow records found');
  });

  it('joins the failure notice with the empty-result notice, which names only answered periods', async () => {
    fetchMock.mockResolvedValue({
      records: [],
      totalCount: 0,
      truncated: false,
      failedPeriods: [{ period: '2023', reason: 'rate_limited', retryAfterSeconds: 9 }],
    });
    const result = await runToolContract(getTradeFlowsTool, {
      reporter_code: 842,
      flow_code: 'X',
      period: ['2022', '2023'],
    });
    const notice =
      'Period 2023 was rate-limited; wait 9 seconds before requesting it again. No trade flow records found for reporter 842, flow=X, periods=[2022]. Use comtrade_get_data_availability to check if data exists for this period.';
    expect(result.structuredContent).toMatchObject({
      records: [],
      unservedPeriods: ['2023'],
      notice,
    });
    expect(textOf(result)).toContain(`> ${notice}`);
    expect(textOf(result)).toContain('**Unserved periods:** 2023. Query them separately.');
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

/** Reference classifications the reporter tests rely on; any other code is in neither catalog. */
const REPORTER_STATUSES = new Map<number, ReporterStatus>([
  [4, { referenceStatus: 'reporter', name: 'Afghanistan' }],
  [276, { referenceStatus: 'reporter', name: 'Germany' }],
  [842, { referenceStatus: 'reporter', name: 'USA' }],
  [
    250,
    { referenceStatus: 'partner_only', name: 'Metropolitan France', suggestedReporterCode: 251 },
  ],
  [0, { referenceStatus: 'partner_only', name: 'World' }],
]);

describe('getTradeFlowsTool reporter coverage and frequency inference', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    initComtradeDataService(mockConfig, mockStorage);
    initComtradeReferenceService(mockConfig, mockStorage);
    vi.spyOn(ComtradeReferenceService.prototype, 'getReporterStatus').mockImplementation(
      (code) => REPORTER_STATUSES.get(code) ?? { referenceStatus: 'unknown' },
    );
    fetchMock = vi
      .spyOn(ComtradeDataService.prototype, 'fetchTradeData')
      .mockResolvedValue({ records: [], totalCount: 0, truncated: false });
  });
  afterEach(() => vi.restoreAllMocks());

  it('names served array reporters with no records in any served period, still sending every code', async () => {
    const records = [
      { ...RECORD_USA_DEU, reporterCode: 842, period: '2022' },
      { ...RECORD_USA_DEU, reporterCode: 276, reporterDesc: 'Germany', period: '2023' },
    ];
    fetchMock.mockResolvedValue({ records, totalCount: 2, truncated: false });
    const result = await runToolContract(getTradeFlowsTool, {
      reporter_code: [842, 4, 250, 999, 276, 4],
      flow_code: 'X',
      period: ['2022', '2023'],
      partner_code: 0,
    });
    expect(result.isError).not.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ reporterCode: [842, 4, 250, 999, 276] }),
      expect.anything(),
    );
    const output = getTradeFlowsTool.output.parse(result.structuredContent);
    expect(output.records).toEqual(records);
    expect(result.structuredContent).toMatchObject({
      reportersWithoutRecords: [
        { reporterCode: 4, referenceStatus: 'reporter', name: 'Afghanistan' },
        {
          reporterCode: 250,
          referenceStatus: 'partner_only',
          name: 'Metropolitan France',
          suggestedReporterCode: 251,
        },
        { reporterCode: 999, referenceStatus: 'unknown' },
      ],
    });
    const [, , unknown] = (
      result.structuredContent as { reportersWithoutRecords: Record<string, unknown>[] }
    ).reportersWithoutRecords;
    expect(Object.keys(unknown ?? {})).toEqual(['reporterCode', 'referenceStatus']);
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(result.structuredContent).not.toHaveProperty('unservedReporters');
    expect(textOf(result)).toContain(
      '**Reporters without records:** 4 Afghanistan (reporter); 250 Metropolitan France (partner_only, suggestedReporterCode 251); 999 (unknown).',
    );
  });

  it('lists only the 20 served reporters when the reporter cap is exceeded, beside unservedReporters', async () => {
    const reporters = Array.from({ length: 21 }, (_, i) => i + 1);
    const result = await runToolContract(getTradeFlowsTool, {
      reporter_code: reporters,
      flow_code: 'X',
      period: ['2022'],
      partner_code: 0,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ reporterCode: reporters.slice(0, 20) }),
      expect.anything(),
    );
    const { reportersWithoutRecords, unservedReporters } = result.structuredContent as {
      reportersWithoutRecords: { reporterCode: number }[];
      unservedReporters: number[];
    };
    expect(reportersWithoutRecords.map((entry) => entry.reporterCode)).toEqual(
      reporters.slice(0, 20),
    );
    expect(unservedReporters).toEqual([21]);
    expect(textOf(result)).toContain('**Unserved reporters:** 21.');
    expect(getTradeFlowsTool.output.parse(result.structuredContent).records).toEqual([]);
  });

  it.each([
    ['a truncated response', true, [{ ...RECORD_USA_DEU, reporterCode: 842 }]],
    [
      'every reporter answering',
      false,
      [
        { ...RECORD_USA_DEU, reporterCode: 842 },
        { ...RECORD_USA_DEU, reporterCode: 4 },
      ],
    ],
  ])('omits reportersWithoutRecords for %s', async (_case, truncated, records) => {
    fetchMock.mockResolvedValue({ records, totalCount: records.length, truncated });
    const result = await runToolContract(getTradeFlowsTool, {
      reporter_code: [842, 4],
      flow_code: 'X',
      period: ['2022'],
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).not.toHaveProperty('reportersWithoutRecords');
    expect(textOf(result)).not.toContain('Reporters without records');
  });

  it('joins the period-failure notice with the partner-only notice for a scalar code with no records', async () => {
    fetchMock.mockResolvedValue({
      records: [],
      totalCount: 0,
      truncated: false,
      failedPeriods: [{ period: '2023', reason: 'rate_limited', retryAfterSeconds: 9 }],
    });
    const result = await runToolContract(getTradeFlowsTool, {
      reporter_code: 250,
      flow_code: 'X',
      period: ['2022', '2023'],
    });
    const notice =
      'Period 2023 was rate-limited; wait 9 seconds before requesting it again. No trade flow records found for reporter 250, flow=X, periods=[2022]. Reporter 250 (Metropolitan France) is a partner-only code in UN Comtrade reference data; reporter 251 shares its ISO-3 identity. Retry with reporter_code 251.';
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ reporterCode: 250 }),
      expect.anything(),
    );
    expect(result.structuredContent).toMatchObject({ records: [], notice });
    expect(result.structuredContent).not.toHaveProperty('reportersWithoutRecords');
    expect(textOf(result)).toContain(`> ${notice}`);
  });

  it('says reporter 0 has no reporter-valid counterpart', async () => {
    const result = await runToolContract(getTradeFlowsTool, {
      reporter_code: 0,
      flow_code: 'X',
      period: ['2022'],
    });
    const notice =
      'No trade flow records found for reporter 0, flow=X, periods=[2022]. Reporter 0 (World) is a partner-only code in UN Comtrade reference data and has no reporter-valid counterpart. Find a reporter with comtrade_lookup_countries using role "reporter".';
    expect(result.structuredContent).toMatchObject({ notice });
    expect(textOf(result)).toContain(`> ${notice}`);
  });

  it.each([
    [842, 'reporter'],
    [999, 'unknown'],
  ])('keeps the availability pointer for a %s code that is %s', async (reporter_code) => {
    const result = await runToolContract(getTradeFlowsTool, {
      reporter_code,
      flow_code: 'X',
      period: ['2022'],
    });
    expect(result.structuredContent).toMatchObject({
      notice: `No trade flow records found for reporter ${reporter_code}, flow=X, periods=[2022]. Use comtrade_get_data_availability to check if data exists for this period.`,
    });
  });

  it('serves rows for a partner-only code unchanged and without a notice', async () => {
    const record = { ...RECORD_USA_DEU, reporterCode: 250, reporterDesc: 'France' };
    fetchMock.mockResolvedValue({ records: [record], totalCount: 1, truncated: false });
    const result = await runToolContract(getTradeFlowsTool, {
      reporter_code: 250,
      flow_code: 'X',
      period: ['2022'],
    });
    expect(getTradeFlowsTool.output.parse(result.structuredContent).records).toEqual([record]);
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('infers monthly frequency from YYYYMM periods, matching an explicit freq "M" request', async () => {
    const args = { reporter_code: 842, flow_code: 'X', period: ['202401'], partner_code: 0 };
    const inferred = await runToolContract(getTradeFlowsTool, args);
    const explicit = await runToolContract(getTradeFlowsTool, { ...args, freq: 'M' });
    expect(inferred.isError).not.toBe(true);
    expect(explicit.isError).not.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toMatchObject({ freqCode: 'M', period: '202401' });
    expect(fetchMock.mock.calls[0]?.[0]).toEqual(fetchMock.mock.calls[1]?.[0]);
  });

  it('rejects mixed period lengths on both surfaces before any request', async () => {
    const result = await runToolContract(getTradeFlowsTool, {
      reporter_code: 842,
      flow_code: 'X',
      period: ['2023', '202401'],
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(textOf(result)).toContain(
      'Use only YYYY (annual) or only YYYYMM (monthly) periods in one call; an explicit freq must match them.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('getTradeFlowsTool on the keyless data service', () => {
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
  /** Answers UN Comtrade preview requests with `respond`; any other request is unexpected. */
  function previewFake(respond: (period: string, init?: RequestInit) => Promise<Response>) {
    fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname !== 'comtradeapi.un.org' || !url.pathname.startsWith('/public/v1/preview/'))
        throw new Error(`Unexpected fetch ${url.pathname}`);
      return respond(url.searchParams.get('period') ?? '', init);
    });
  }
  async function run(args: Record<string, unknown>) {
    const result = runToolContract(getTradeFlowsTool, args);
    await vi.runAllTimersAsync();
    return result;
  }
  it.each([
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      respond: async () =>
        new Response('{"statusCode":429,"message":"Rate limit is exceeded."}', {
          status: 429,
          headers: { 'Retry-After': '6' },
        }),
      message:
        'No requested period was served. Periods 2022, 2023 were rate-limited; wait 6 seconds before requesting them again.',
      data: { retryAfter: 6, recovery: { hint: 'Wait 6 seconds, then retry with fewer periods.' } },
    },
    {
      reason: 'deadline_exceeded',
      code: JsonRpcErrorCode.Timeout,
      respond: (_period: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          }),
        ),
      message:
        "No requested period was served. Periods 2022, 2023 were not completed within the call's time budget.",
      data: {
        recovery: {
          hint: 'Retry with fewer periods per call, or retry later if UN Comtrade is responding slowly.',
        },
      },
    },
  ])(
    'fails with $reason and its recovery on both surfaces when no period is served',
    async ({ reason, code, respond, message, data }) => {
      previewFake(respond);
      const result = await run({ reporter_code: 842, flow_code: 'X', period: ['2022', '2023'] });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code, message, data: { reason, retryable: true, ...data } },
      });
      const text = textOf(result);
      expect(text).toContain(message);
      expect(text).toContain(data.recovery.hint);
      expect(text).toContain(`reason ${reason}`);
    },
  );
  it('omits zero placeholders beside real measurements and keeps zeros in real units (#36)', async () => {
    const aggregate = { motCode: 0, customsCode: 'C00', partner2Code: 0 };
    const row = {
      ...aggregate,
      reporterCode: 704,
      reporterDesc: 'Viet Nam',
      partnerCode: 0,
      partnerDesc: 'World',
      flowCode: 'X',
      period: '2023',
      classificationCode: 'H6',
    };
    previewFake(async () =>
      Response.json({
        count: 2,
        data: [
          {
            ...row,
            cmdCode: '0901',
            cmdDesc: 'Coffee',
            primaryValue: 3_183_873_274.422,
            fobvalue: 3_183_873_274.422,
            qty: 1_077_072_475.819,
            qtyUnitCode: 8,
            qtyUnitAbbr: 'kg',
            altQty: 0,
            altQtyUnitCode: -1,
            altQtyUnitAbbr: 'N/A',
            netWgt: 1_077_072_475.819,
            grossWgt: 0,
            isQtyEstimated: true,
            isNetWgtEstimated: true,
          },
          {
            ...row,
            cmdCode: '0902',
            cmdDesc: 'Tea',
            primaryValue: 0,
            qty: 0,
            qtyUnitCode: 8,
            qtyUnitAbbr: 'kg',
            altQty: 0,
            altQtyUnitCode: 5,
            altQtyUnitAbbr: 'u',
            netWgt: 0,
            grossWgt: 0,
          },
        ],
      }),
    );
    const result = await run({
      reporter_code: 704,
      flow_code: 'X',
      period: ['2023'],
      partner_code: 0,
      cmd_code: ['0901', '0902'],
    });
    const [coffee, tea] = (result.structuredContent as { records: object[] }).records;
    expect(coffee).toMatchObject({
      qty: 1_077_072_475.819,
      qtyUnitCode: 8,
      netWgt: 1_077_072_475.819,
      altQtyUnitCode: -1,
      altQtyUnitAbbr: 'N/A',
      isQtyEstimated: true,
      isNetWgtEstimated: true,
    });
    expect(coffee).not.toHaveProperty('altQty');
    expect(coffee).not.toHaveProperty('grossWgt');
    expect(tea).toMatchObject({
      primaryValue: 0,
      qty: 0,
      qtyUnitCode: 8,
      altQty: 0,
      altQtyUnitCode: 5,
      netWgt: 0,
      grossWgt: 0,
    });
    const [, coffeeText, teaText] = textOf(result).split('\n\n**');
    for (const line of [
      'Quantity: 1,077,072,475.819',
      'Net Weight: 1,077,072,475.819 kg',
      'altQtyUnitCode: -1',
      'isQtyEstimated: true',
    ])
      expect(coffeeText).toContain(line);
    expect(coffeeText).not.toContain('altQty: ');
    expect(coffeeText).not.toContain('Gross Weight');
    for (const line of ['Quantity: 0', 'altQty: 0', 'Net Weight: 0 kg', 'Gross Weight: 0 kg'])
      expect(teaText).toContain(line);
  });
});
