/**
 * @fileoverview Tests for ranking partners of one reported or converted services series.
 * @module tests/tools/get-top-services-partners.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getTopServicesPartnersTool } from '@/mcp-server/tools/definitions/get-top-services-partners.tool.js';
import {
  ComtradeDataService,
  getComtradeDataService,
  initComtradeDataService,
  periodFailureError,
} from '@/services/comtrade-data/comtrade-data-service.js';
import {
  getComtradeReferenceService,
  initComtradeReferenceService,
} from '@/services/comtrade-reference/comtrade-reference-service.js';
import type { CountryEntry } from '@/services/comtrade-reference/types.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({ apiBaseUrl: 'https://comtradeapi.un.org', subscriptionKey: '' }),
}));

const config = {} as Parameters<typeof initComtradeDataService>[0];
const storage = {} as Parameters<typeof initComtradeDataService>[1];
const args = { reporter_code: 826, flow_code: 'X', period: '2019' };
const areas: CountryEntry[] = [
  { id: 97, name: 'European Union', isGroup: true, validAsReporter: true },
  { id: 490, name: 'Other Asia, nes', isGroup: true, validAsReporter: true },
  { id: 826, name: 'United Kingdom', isGroup: false, validAsReporter: true },
  { id: 842, name: 'USA', isGroup: false, validAsReporter: true },
];

function tradeRow(partnerCode: number, primaryValue?: number) {
  return {
    reporterCode: 826,
    partnerCode,
    flowCode: 'X',
    period: 2019,
    cmdCode: 'S',
    classificationCode: 'EB10S',
    isOriginalClassification: true,
    primaryValue,
    motCode: 0,
    customsCode: 'C00',
    partner2Code: 0,
  };
}

function stubTrade(data: object[], count = data.length) {
  const fetch = vi.fn(async (_url: string) => Response.json({ count, data }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

function resultText(result: Awaited<ReturnType<typeof runToolContract>>) {
  return result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
}

async function runRanking(input: Record<string, unknown> = args) {
  const result = await runToolContract(getTopServicesPartnersTool, input);
  expect(result.isError).not.toBe(true);
  return {
    output: getTopServicesPartnersTool.output.parse(result.structuredContent),
    text: resultText(result),
  };
}

beforeEach(() => {
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

it('includes fractional trade values in the total before limiting the ranked partners', async () => {
  stubTrade([tradeRow(842, 120.125), tradeRow(372, 0.25)]);
  const { output, text } = await runRanking({ ...args, limit: 1 });
  expect(output.totalValueUsd).toBe(120.375);
  expect(text).toContain('Total value of retrieved partners:** 120.375 USD');
});

it('adds decimal source values without rounding the inputs or display', async () => {
  stubTrade([tradeRow(842, 1234.10001), tradeRow(372, 0.20002)]);
  const { output, text } = await runRanking();
  expect(output.totalValueUsd).toBe(1234.30003);
  expect(text).toContain('Total value of retrieved partners:** 1,234.30003 USD');
  expect(text).toContain('Value: 1,234.10001 USD');
});

it('adds reported tenths as decimals', async () => {
  stubTrade([tradeRow(842, 0.1), tradeRow(372, 0.2)]);
  const { output, text } = await runRanking();
  expect(output.totalValueUsd).toBe(0.3);
  expect(text).toContain('Total value of retrieved partners:** 0.3 USD');
});

it('queries both total codes once and ranks the supported series before applying the limit', async () => {
  const fetch = stubTrade([
    tradeRow(0, 400),
    tradeRow(97, 200),
    tradeRow(842, 60),
    tradeRow(842, 60),
    tradeRow(490, 40),
    tradeRow(372, 0),
    { ...tradeRow(276, 500), cmdCode: 'SG' },
    { ...tradeRow(276, 600), cmdCode: '200' },
    { ...tradeRow(276, 700), period: '2020' },
  ]);
  const { output, text } = await runRanking({ ...args, limit: 1 });
  expect(fetch).toHaveBeenCalledOnce();
  const url = new URL(String(fetch.mock.calls[0]?.[0]));
  expect(url.pathname).toBe('/public/v1/preview/S/A/EB');
  expect(Object.fromEntries(url.searchParams)).toEqual({
    reporterCode: '826',
    flowCode: 'X',
    period: '2019',
    cmdCode: '200,S',
  });
  expect(output).toMatchObject({
    reporterCode: 826,
    reporterDesc: 'United Kingdom',
    period: '2019',
    flowCode: 'X',
    serviceCode: 'S',
    classification: 'EB',
    classificationCode: 'EB10S',
    isOriginalClassification: true,
    totalPartners: 3,
    totalValueUsd: 100,
    truncated: false,
    partners: [
      { partnerCode: 842, partnerDesc: 'USA', primaryValueUsd: 60, rank: 1, sharePercent: 60 },
    ],
  });
  expect(text).toContain('United Kingdom (reporterCode: 826) | 2019 | flowCode: X');
  expect(text).toContain('Classification requested:** EB');
  expect(text).toContain('Service code:** S');
  expect(text).toContain('Classification served:** EB10S');
  expect(text).toContain('Original classification:** Yes (as reported)');
  expect(text).toContain('Retrieved partners:** 3');
  expect(text).toContain('Upstream truncated:** false');
  expect(text).toContain('Total value of retrieved partners:** 100 USD');
  expect(text).toContain('**USA** (code 842)\n- Value: 60 USD\n- Rank: 1\n- Share: 60%');
  expect(text).toContain(output.coverageNotice);
  expect(text).not.toContain('European Union');
  expect(text).not.toContain('Other Asia, nes');
});

it.each([
  ['EB', 'EB10', true],
  ['EB', 'EB02', true],
  [' eb10 ', 'EB10', false],
  ['eb02', 'EB02', false],
  ['EB10', 'EB10', true],
] as const)('selects %s totals served as %s, original %s', async (request, code, original) => {
  const fetch = stubTrade([
    {
      ...tradeRow(842, 60),
      classificationCode: code,
      cmdCode: '200',
      isOriginalClassification: original,
    },
  ]);
  const { output, text } = await runRanking({ ...args, classification: request });
  expect(new URL(String(fetch.mock.calls[0]?.[0])).pathname).toBe(
    `/public/v1/preview/S/A/${request.trim().toUpperCase()}`,
  );
  expect(output).toMatchObject({
    serviceCode: '200',
    classificationCode: code,
    isOriginalClassification: original,
    partners: [{ rank: 1, partnerCode: 842, sharePercent: 100 }],
  });
  expect(text).toContain(original ? 'Yes (as reported)' : 'No (converted by UN Comtrade)');
});

it('ranks explicit category codes without a World total and preserves absent provenance', async () => {
  const fetch = stubTrade([
    { ...tradeRow(372, 0), cmdCode: '3a.3.1', isOriginalClassification: null },
    { ...tradeRow(842, 0), cmdCode: '3A.3.1', isOriginalClassification: null },
    { ...tradeRow(276, 900), cmdCode: 'S' },
  ]);
  const { output, text } = await runRanking({ ...args, service_code: ' 3a.3.1 ' });
  expect(new URL(String(fetch.mock.calls[0]?.[0])).searchParams.get('cmdCode')).toBe('3A.3.1');
  expect(output).toMatchObject({
    serviceCode: '3A.3.1',
    classificationCode: 'EB10S',
    totalPartners: 2,
    totalValueUsd: 0,
    partners: [
      { partnerCode: 372, primaryValueUsd: 0, rank: 1 },
      { partnerCode: 842, primaryValueUsd: 0, rank: 2 },
    ],
  });
  expect(output).not.toHaveProperty('isOriginalClassification');
  expect(output.partners[0]).not.toHaveProperty('sharePercent');
  expect(text).not.toContain('Original classification');
  expect(text).toContain('Value: 0 USD');
  expect(text).not.toContain('- Share:');
});

it('keeps a standalone area marked as a group and displays a zero-value partner', async () => {
  stubTrade([tradeRow(490, 40), tradeRow(842, 0)]);
  const { output, text } = await runRanking();
  expect(output.partners).toMatchObject([
    { partnerCode: 490, rank: 1, primaryValueUsd: 40, sharePercent: 100 },
    { partnerCode: 842, rank: 2, primaryValueUsd: 0, sharePercent: 0 },
  ]);
  expect(text).toContain('**Other Asia, nes** (code 490)');
  expect(text).toContain('Share: 0%');
});

it('returns an empty breakdown when only World was returned', async () => {
  stubTrade([tradeRow(0, 400)]);
  const { output, text } = await runRanking();
  expect(output).toMatchObject({
    partners: [],
    totalPartners: 0,
    serviceCode: 'S',
    classificationCode: 'EB10S',
    truncated: false,
  });
  expect(output).not.toHaveProperty('totalValueUsd');
  expect(text).toContain('No eligible partner breakdown was returned');
});

it('uses services availability guidance when the default conversion has no totals', async () => {
  const fetch = stubTrade([{ ...tradeRow(0, 400), cmdCode: 'SG' }]);
  const result = await runToolContract(getTopServicesPartnersTool, {
    ...args,
    classification: 'EB02',
  });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({
    partners: [],
    totalPartners: 0,
    truncated: false,
    notice: expect.stringContaining('EB02 serves UN Comtrade'),
  });
  expect(result.structuredContent).not.toHaveProperty('serviceCode');
  expect(resultText(result)).toContain('classification="EB" to check coverage');
  expect(resultText(result)).toContain('No matching total services rows were returned.');
  expect(fetch).toHaveBeenCalledOnce();
});

it('explains an empty explicit code using its reference scheme', async () => {
  stubTrade([]);
  vi.spyOn(getComtradeReferenceService(), 'getServiceCategories').mockResolvedValue({
    status: 'tagged',
    categories: [{ id: '7', text: 'Financial services', schemes: ['EB10'] }],
  });
  const result = await runToolContract(getTopServicesPartnersTool, { ...args, service_code: '7' });
  expect(result.structuredContent).toMatchObject({
    serviceCode: '7',
    notice: expect.stringContaining('Service code 7 belongs to EB10'),
  });
  expect(resultText(result)).toContain('Set classification to "EB10"');
});

it.each([
  { classificationCode: 'EB10', cmdCode: '200' },
  { isOriginalClassification: false },
  { classificationCode: null },
])('withholds mixed or unverifiable series (%o)', async (ambiguous) => {
  stubTrade([tradeRow(842, 60), { ...tradeRow(372, 40), ...ambiguous }]);
  const { output, text } = await runRanking();
  expect(output.partners).toEqual([]);
  expect(output).not.toHaveProperty('totalValueUsd');
  expect(output).not.toHaveProperty('isOriginalClassification');
  expect(text).toContain('do not identify one compatible services series');
  expect(text).toContain('Ranks and shares are withheld.');
});

it('keeps one unresolved row for conflicting duplicates without summing missing values', async () => {
  stubTrade([
    tradeRow(842, 60),
    tradeRow(842, 50),
    tradeRow(842, 60),
    tradeRow(490, 0),
    tradeRow(372),
  ]);
  const { output, text } = await runRanking();
  expect(output.totalPartners).toBe(3);
  expect(output.totalValueUsd).toBeUndefined();
  expect(output.partners).toEqual([
    { partnerCode: 490, partnerDesc: 'Other Asia, nes', primaryValueUsd: 0 },
    { partnerCode: 372, partnerDesc: '372' },
    { partnerCode: 842, partnerDesc: 'USA' },
  ]);
  expect(text).toContain('missing or conflicting trade values');
  expect(text).not.toContain('- Rank:');
  expect(text).not.toContain('- Share:');
});

it('withholds ranks and shares at the raw preview cap even after filtering', async () => {
  const entries = Array.from({ length: 499 }, () => tradeRow(0, 400));
  stubTrade([...entries, tradeRow(842, 60)]);
  const { output, text } = await runRanking();
  expect(output).toMatchObject({ totalPartners: 1, totalValueUsd: 60, truncated: true });
  expect(output.partners).toEqual([{ partnerCode: 842, partnerDesc: 'USA', primaryValueUsd: 60 }]);
  expect(text).toContain('reached 500 records');
  expect(text).toContain('Ranks and shares are withheld.');
});

it.each([
  { period: '201901' },
  { period: ['2019'] },
  { classification: 'EB10S' },
  { classification: 'HS' },
  { service_code: 'S,200' },
  { service_code: 'ag2' },
  { flow_code: 'RX' },
  { limit: 0 },
  { offset: 1000 },
  { reporter_code: undefined },
])('rejects invalid inputs before retrieval (%o)', async (invalid) => {
  const fetch = stubTrade([]);
  const result = await runToolContract(getTopServicesPartnersTool, { ...args, ...invalid });
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    error: { code: JsonRpcErrorCode.InvalidParams },
  });
  expect(resultText(result)).not.toBe('');
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  [400, '{}', 'upstream_validation'],
  [200, '<html>Invalid response</html>', 'invalid_upstream_response'],
] as const)('preserves HTTP %i failure reasons and recovery', async (status, body, reason) => {
  const fetch = vi.fn(async () => new Response(body, { status }));
  vi.stubGlobal('fetch', fetch);
  const result = await runToolContract(getTopServicesPartnersTool, args);
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    error: { data: { reason, recovery: { hint: expect.any(String) } } },
  });
  expect(resultText(result)).toContain(reason);
  expect(fetch).toHaveBeenCalledOnce();
});

it('retains Retry-After on both surfaces without suggesting fewer periods', async () => {
  const fetch = vi.fn(
    async () => new Response('{}', { status: 429, headers: { 'Retry-After': '120' } }),
  );
  vi.stubGlobal('fetch', fetch);
  const result = await runToolContract(getTopServicesPartnersTool, args);
  const hint = 'Wait 120 seconds, then retry.';
  expect(result.structuredContent).toMatchObject({
    error: { data: { reason: 'rate_limited', recovery: { hint }, retryAfter: 120 } },
  });
  expect(resultText(result)).toContain(hint);
  expect(resultText(result)).not.toContain('fewer periods');
  expect(fetch).toHaveBeenCalledOnce();
});

it('reports the final server error after multiple preview attempts', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async () => new Response('{}', { status: 503 }));
  vi.stubGlobal('fetch', fetch);
  const pending = runToolContract(getTopServicesPartnersTool, args);
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
  expect(resultText(result)).toContain(hint);
});

it('adapts a deadline failure to a single-period query on both surfaces', async () => {
  vi.spyOn(ComtradeDataService.prototype, 'fetchTradeData').mockRejectedValue(
    periodFailureError([{ period: '2019', reason: 'deadline_exceeded' }]),
  );
  const result = await runToolContract(getTopServicesPartnersTool, args);
  const hint = 'Retry the same ranking after a few seconds.';
  expect(result.structuredContent).toMatchObject({
    error: {
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'deadline_exceeded', recovery: { hint } },
    },
  });
  expect(resultText(result)).toContain(hint);
  expect(resultText(result)).not.toContain('fewer periods');
});

it('propagates cancellation during upstream retrieval', async () => {
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
  const pending = runToolContract(getTopServicesPartnersTool, args, {
    context: { signal: controller.signal },
  });
  await started.promise;
  controller.abort();
  const result = await pending;
  expect(result.structuredContent).toMatchObject({
    error: { code: JsonRpcErrorCode.RequestCancelled },
  });
  expect(resultText(result).toLowerCase()).toMatch(/abort|cancel/);
  expect(fetch).toHaveBeenCalledOnce();
});
