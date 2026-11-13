/**
 * @fileoverview Tests for goods reporter rankings.
 * @module tests/tools/get-top-reporters.tool.test
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getTopReportersTool } from '@/mcp-server/tools/definitions/get-top-reporters.tool.js';
import {
  ComtradeDataService,
  getComtradeDataService,
  initComtradeDataService,
  periodFailureError,
} from '@/services/comtrade-data/comtrade-data-service.js';
import { initComtradeReferenceService } from '@/services/comtrade-reference/comtrade-reference-service.js';
import type { CountryEntry } from '@/services/comtrade-reference/types.js';

const settings = vi.hoisted(() => ({
  apiBaseUrl: 'https://comtradeapi.un.org',
  subscriptionKey: '',
}));
vi.mock('@/config/server-config.js', () => ({ getServerConfig: () => settings }));

const config = {} as Parameters<typeof initComtradeDataService>[0];
const storage = {} as Parameters<typeof initComtradeDataService>[1];
const args = { flow_code: 'X', period: '2023', cmd_code: '1201' };
const areas: CountryEntry[] = [
  { id: 0, name: 'World', isGroup: true, validAsReporter: false },
  { id: 76, name: 'Brazil', isGroup: false, validAsReporter: true },
  { id: 97, name: 'European Union', isGroup: true, validAsReporter: true },
  { id: 158, name: 'Taiwan, Province of China', isGroup: false, validAsReporter: false },
  { id: 490, name: 'Other Asia, nes', isGroup: true, validAsReporter: true },
  { id: 600, name: 'Paraguay', isGroup: false, validAsReporter: true },
  { id: 842, name: 'USA', isGroup: false, validAsReporter: true },
  { id: 975, name: 'ASEAN', isGroup: true, validAsReporter: true },
];

function aggregate(reporterCode: number, primaryValue?: number) {
  return {
    reporterCode,
    primaryValue,
    partnerCode: 0,
    period: 2023,
    flowCode: 'X',
    cmdCode: '1201',
    cmdDesc: 'Soya beans',
    classificationCode: 'H6',
    motCode: 0,
    customsCode: 'C00',
    partner2Code: 0,
  };
}

function stubTrade(data: object[]) {
  const fetch = vi.fn().mockImplementation(async () => Response.json({ count: data.length, data }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

beforeEach(() => {
  settings.subscriptionKey = '';
  const reference = initComtradeReferenceService(config, storage);
  vi.spyOn(reference, 'getCountryByCode').mockImplementation((code) =>
    areas.find((area) => area.id === code),
  );
  initComtradeDataService(config, storage);
});

afterEach(() => {
  getComtradeDataService().dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('keeps the aggregate per reporter and preserves zero and missing values on explicit World queries', async () => {
  const fetch = stubTrade([aggregate(76, 0), aggregate(490), { ...aggregate(76, 99), motCode: 3 }]);
  const result = await getComtradeDataService().fetchTradeData({
    flowCode: 'X',
    period: '2023',
    partnerCode: 0,
    classificationCode: 'HS',
    cmdCode: '1201',
    freqCode: 'A',
  });
  expect(fetch).toHaveBeenCalledOnce();
  const url = new URL(String(fetch.mock.calls[0]?.[0]));
  expect(url.pathname).toBe('/public/v1/preview/C/A/HS');
  expect(url.searchParams.has('reporterCode')).toBe(false);
  expect(url.searchParams.get('partnerCode')).toBe('0');
  expect(result.records.map((row) => [row.reporterCode, row.primaryValue])).toEqual([
    [76, 0],
    [490, undefined],
  ]);
});

async function runRanking(input: Record<string, unknown> = args) {
  const result = await runToolContract(getTopReportersTool, input);
  expect(result.isError).not.toBe(true);
  return {
    output: getTopReportersTool.output.parse(result.structuredContent),
    text: result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n'),
  };
}

it('excludes overlapping groups, keeps 490, collapses duplicates, and ranks before limiting', async () => {
  const fetch = stubTrade([
    aggregate(0, 9999),
    aggregate(97, 999),
    aggregate(975, 999),
    aggregate(490, 10),
    aggregate(842, 40),
    aggregate(76, 40),
    aggregate(76, 40),
    aggregate(600, 0),
    { ...aggregate(76, 300), motCode: 3 },
  ]);
  const { output, text } = await runRanking({ ...args, limit: 3 });
  expect(fetch).toHaveBeenCalledOnce();
  expect(output).toMatchObject({
    period: '2023',
    classification: 'HS',
    cmdCode: '1201',
    flowCode: 'X',
    partnerCode: 0,
    totalReporters: 4,
    totalValueUsd: 90,
    truncated: false,
    reporters: [
      {
        reporterCode: 76,
        reporterDesc: 'Brazil',
        primaryValueUsd: 40,
        rank: 1,
        sharePercent: 44.44,
      },
      { reporterCode: 842, reporterDesc: 'USA', primaryValueUsd: 40, rank: 2, sharePercent: 44.44 },
      {
        reporterCode: 490,
        reporterDesc: 'Other Asia, nes',
        primaryValueUsd: 10,
        rank: 3,
        sharePercent: 11.11,
      },
    ],
  });
  expect(text).toContain('2023 | HS 1201 | flowCode: X | partnerCode: 0');
  expect(text).toContain('**Retrieved reporting areas:** 4 | **Upstream truncated:** false');
  expect(text).toContain('**Total value of retrieved reporting areas:** 90 USD');
  expect(text).toContain(
    '**Other Asia, nes** (code 490)\n- Value: 10 USD\n- Rank: 3\n- Share: 11.11%',
  );
  expect(text).toContain(output.coverageNotice);
  expect(text).toContain('Mirror trade is a separate view');
  expect(text).not.toContain('Paraguay');
});

it('withholds ranking when unknown or partner-only identities may affect eligibility', async () => {
  stubTrade([
    aggregate(76, 10),
    aggregate(158, 20),
    { ...aggregate(999, 30), reporterDesc: 'Unlisted area' },
  ]);
  const { output, text } = await runRanking();
  expect(output.totalValueUsd).toBe(60);
  expect(output.reporters).toEqual([
    {
      reporterCode: 999,
      reporterDesc: 'Unlisted area',
      primaryValueUsd: 30,
      referenceCaveat: 'This code is absent from UN Comtrade reporter and partner reference data.',
    },
    {
      reporterCode: 158,
      reporterDesc: 'Taiwan, Province of China',
      primaryValueUsd: 20,
      referenceCaveat: 'This code is listed as a partner only in UN Comtrade reference data.',
    },
    { reporterCode: 76, reporterDesc: 'Brazil', primaryValueUsd: 10 },
  ]);
  expect(text).toContain('**Unlisted area** (code 999)');
  expect(text).toContain('listed as a partner only');
  expect(text).toContain('Ranks and shares are withheld.');
  expect(text).not.toContain('- Rank:');
});

it('keeps conflicting and missing values unresolved even when a later duplicate agrees with the first', async () => {
  stubTrade([
    aggregate(76, 99),
    aggregate(842),
    aggregate(76, 77),
    aggregate(76, 99),
    aggregate(490, 0),
  ]);
  const { output, text } = await runRanking();
  expect(output.totalValueUsd).toBeUndefined();
  expect(output.reporters).toEqual([
    { reporterCode: 490, reporterDesc: 'Other Asia, nes', primaryValueUsd: 0 },
    { reporterCode: 76, reporterDesc: 'Brazil' },
    { reporterCode: 842, reporterDesc: 'USA' },
  ]);
  expect(text).toContain('**Other Asia, nes** (code 490)\n- Value: 0 USD');
  expect(text).toContain('missing or conflicting trade values');
  expect(text).not.toContain('99 USD');
  expect(text).not.toContain('Total value');
  expect(text).not.toContain('- Share:');
});

it('preserves a measured total of zero and omits shares', async () => {
  stubTrade([aggregate(76, 0)]);
  const { output, text } = await runRanking({ ...args, limit: 99 });
  expect(output.totalValueUsd).toBe(0);
  expect(output.reporters).toEqual([
    { reporterCode: 76, reporterDesc: 'Brazil', primaryValueUsd: 0, rank: 1 },
  ]);
  expect(text).toContain('**Total value of retrieved reporting areas:** 0 USD');
  expect(text).not.toContain('- Share:');
});

it('withholds ranks and shares when raw preview reached its cap before filtering', async () => {
  stubTrade([aggregate(76, 40), ...Array.from({ length: 499 }, () => aggregate(97, 900))]);
  const { output, text } = await runRanking();
  expect(output).toMatchObject({
    totalReporters: 1,
    totalValueUsd: 40,
    truncated: true,
    reporters: [{ reporterCode: 76, primaryValueUsd: 40 }],
  });
  expect(output.reporters[0]).not.toHaveProperty('rank');
  expect(output.reporters[0]).not.toHaveProperty('sharePercent');
  expect(text).toContain('public preview response reached 500 records');
  expect(text).toContain('**Total value of retrieved reporting areas:** 40 USD');
  expect(text).not.toContain('- Rank:');
});

it('serves a monthly bilateral SITC ranking and filters nonmatching trade dimensions', async () => {
  const match = {
    ...aggregate(76, 40),
    partnerCode: 276,
    period: 202301,
    classificationCode: 'S4',
    cmdCode: '071',
    cmdDesc: 'Coffee',
  };
  const fetch = stubTrade([
    match,
    { ...match, reporterCode: 842, period: 202302 },
    { ...match, reporterCode: 842, partnerCode: 0 },
    { ...match, reporterCode: 842, flowCode: 'M' },
    { ...match, reporterCode: 842, cmdCode: '072' },
    { ...match, reporterCode: 842, classificationCode: 'S3' },
  ]);
  const { output, text } = await runRanking({
    flow_code: ' x ',
    period: ' 202301 ',
    classification: 's4',
    cmd_code: '071',
    partner_code: 276,
  });
  expect(fetch).toHaveBeenCalledOnce();
  const url = new URL(String(fetch.mock.calls[0]?.[0]));
  expect(url.pathname).toBe('/public/v1/preview/C/M/S4');
  expect(Object.fromEntries(url.searchParams)).toEqual({
    flowCode: 'X',
    period: '202301',
    partnerCode: '276',
    cmdCode: '071',
  });
  expect(output.reporters).toEqual([
    { reporterCode: 76, reporterDesc: 'Brazil', primaryValueUsd: 40, rank: 1, sharePercent: 100 },
  ]);
  expect(text).toContain('202301 | S4 071 | flowCode: X | partnerCode: 276');
});

it('accepts explicit revisions returned for an SS as-reported query', async () => {
  const historical = { ...aggregate(76, 40), period: 1985, cmdCode: 'TOTAL' };
  const fetch = stubTrade([
    { ...historical, classificationCode: 'S1' },
    { ...historical, reporterCode: 842, classificationCode: 'S2' },
    { ...historical, reporterCode: 600, classificationCode: 'H0' },
  ]);
  const { output, text } = await runRanking({
    flow_code: 'X',
    period: '1985',
    classification: 'SS',
  });
  expect(new URL(String(fetch.mock.calls[0]?.[0])).pathname).toBe('/public/v1/preview/C/A/SS');
  expect(output.reporters.map(({ reporterCode, rank }) => [reporterCode, rank])).toEqual([
    [76, 1],
    [842, 2],
  ]);
  expect(text).toContain('1985 | SS TOTAL');
  expect(text).toContain('**USA** (code 842)\n- Value: 40 USD\n- Rank: 2\n- Share: 50%');
});

it('retains usable trade values when a row omits classification, with uncertain ranking coverage', async () => {
  stubTrade([{ ...aggregate(76, 40), classificationCode: null }]);
  const { output, text } = await runRanking();
  expect(output.totalValueUsd).toBe(40);
  expect(output.reporters).toEqual([
    { reporterCode: 76, reporterDesc: 'Brazil', primaryValueUsd: 40 },
  ]);
  expect(output.coverageNotice).toContain('lack a classification code');
  expect(text).toContain(output.coverageNotice);
  expect(text).not.toContain('- Rank:');
});

it('returns an empty ranking for no matching classification or period and applies a blank TOTAL default', async () => {
  settings.subscriptionKey = 'fixture-key';
  const fetch = stubTrade([
    { ...aggregate(76, 333), cmdCode: 'TOTAL', classificationCode: 'H5' },
    { ...aggregate(76, 333), cmdCode: 'TOTAL', period: 2022 },
  ]);
  const { output, text } = await runRanking({ ...args, classification: 'H6', cmd_code: '' });
  const url = new URL(String(fetch.mock.calls[0]?.[0]));
  expect(url.pathname).toBe('/data/v1/get/C/A/H6');
  expect(url.searchParams.get('cmdCode')).toBe('TOTAL');
  expect(output).toMatchObject({ reporters: [], totalReporters: 0, truncated: false });
  expect(output.totalValueUsd).toBeUndefined();
  expect(text).toContain(
    'No matching reporting areas were returned. Use comtrade_get_data_availability',
  );
  expect(text).not.toContain('Total value');
});

it.each([
  { cmd_code: 'AG2' },
  { cmd_code: 'AG3', classification: 'S4' },
  { cmd_code: '1201,1202' },
  { cmd_code: '071' },
  { period: '202313' },
  { period: ['2023', '2024'] },
  { flow_code: 'RX' },
  { limit: 0 },
  { partner_code: -1 },
  { reporter_code: 76 },
  { offset: 100 },
])('rejects invalid input before sending a request (%o)', async (invalid) => {
  const fetch = stubTrade([]);
  const result = await runToolContract(getTopReportersTool, { ...args, ...invalid });
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    error: { code: JsonRpcErrorCode.InvalidParams },
  });
  expect(result.content.length).toBeGreaterThan(0);
  expect(fetch).not.toHaveBeenCalled();
});

it('reports the authenticated-access constraint for explicit HS editions on both surfaces', async () => {
  const fetch = stubTrade([]);
  const result = await runToolContract(getTopReportersTool, { ...args, classification: 'H6' });
  expect(result.isError).toBe(true);
  const hint =
    'Use classification HS for as-reported data, or configure COMTRADE_SUBSCRIPTION_KEY to request an explicit edition.';
  expect(result.structuredContent).toMatchObject({
    error: { data: { reason: 'keyless_hs_edition_unsupported', recovery: { hint } } },
  });
  expect(JSON.stringify(result.content)).toContain(hint);
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  [400, '{}', 'upstream_validation'],
  [200, '<html>Invalid response</html>', 'invalid_upstream_response'],
] as const)(
  'preserves upstream HTTP %i failure reasons and guidance',
  async (status, body, reason) => {
    const fetch = vi.fn().mockImplementation(async () => new Response(body, { status }));
    vi.stubGlobal('fetch', fetch);
    const result = await runToolContract(getTopReportersTool, args);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason, recovery: { hint: expect.any(String) } } },
    });
    expect(JSON.stringify(result.content)).toContain(reason);
    expect(fetch).toHaveBeenCalledOnce();
  },
);

it.each([
  [429, 'rate_limited', 'Wait 120 seconds, then retry.'],
  [503, 'upstream_unavailable', 'Wait 120 seconds and retry the same call.'],
] as const)(
  'maps HTTP %i and its stated wait through the single-period contract',
  async (status, reason, hint) => {
    const fetch = vi
      .fn()
      .mockImplementation(
        async () => new Response('{}', { status, headers: { 'Retry-After': '120' } }),
      );
    vi.stubGlobal('fetch', fetch);
    const result = await runToolContract(getTopReportersTool, args);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason, recovery: { hint }, retryAfter: 120 } },
    });
    expect(JSON.stringify(result.content)).toContain(hint);
    expect(JSON.stringify(result)).not.toContain('fewer periods');
    expect(fetch).toHaveBeenCalledOnce();
  },
);

it('adapts the shared deadline error to a single period on both surfaces', async () => {
  vi.spyOn(ComtradeDataService.prototype, 'fetchTradeData').mockRejectedValue(
    periodFailureError([{ period: '2023', reason: 'deadline_exceeded' }]),
  );
  const result = await runToolContract(getTopReportersTool, args);
  const hint = 'Retry the ranking in a few seconds after the time budget expires.';
  expect(result.structuredContent).toMatchObject({
    error: {
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'deadline_exceeded', recovery: { hint } },
    },
  });
  expect(JSON.stringify(result.content)).toContain(hint);
  expect(JSON.stringify(result)).not.toContain('fewer periods');
});

it('propagates cancellation during a real service request', async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const fetch = vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        started.resolve();
      }),
  );
  vi.stubGlobal('fetch', fetch);
  const pending = runToolContract(getTopReportersTool, args, {
    context: { signal: controller.signal },
  });
  await started.promise;
  controller.abort();
  const result = await pending;
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    error: { code: JsonRpcErrorCode.RequestCancelled },
  });
  expect(JSON.stringify(result.content).toLowerCase()).toMatch(/abort|cancel/);
  expect(fetch).toHaveBeenCalledOnce();
});

it('preserves the final failure after multiple preview attempts', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockImplementation(async () => new Response('{}', { status: 503 }));
  vi.stubGlobal('fetch', fetch);
  const pending = runToolContract(getTopReportersTool, args);
  await vi.runAllTimersAsync();
  const result = await pending;
  const hint = 'Wait a minute and retry the same call.';
  expect(fetch.mock.calls.length).toBeGreaterThan(2);
  expect(result.structuredContent).toMatchObject({
    error: {
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unavailable', recovery: { hint } },
    },
  });
  expect(JSON.stringify(result.content)).toContain(hint);
});
