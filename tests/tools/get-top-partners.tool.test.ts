/**
 * @fileoverview Tests for the get-top-partners tool.
 * @module tests/tools/get-top-partners.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTopPartnersTool } from '@/mcp-server/tools/definitions/get-top-partners.tool.js';
import {
  ComtradeDataService,
  initComtradeDataService,
  periodFailureError,
} from '@/services/comtrade-data/comtrade-data-service.js';
import {
  ComtradeReferenceService,
  initComtradeReferenceService,
} from '@/services/comtrade-reference/comtrade-reference-service.js';
import type { ReporterStatus } from '@/services/comtrade-reference/types.js';

const settings = vi.hoisted(() => ({
  apiBaseUrl: 'https://comtradeapi.un.org',
  subscriptionKey: '',
}));
vi.mock('@/config/server-config.js', () => ({ getServerConfig: () => settings }));

const mockConfig = {} as Parameters<typeof initComtradeDataService>[0];
const mockStorage = {} as Parameters<typeof initComtradeDataService>[1];

/** Sample disaggregated records by partner. */
const PARTNER_RECORDS = [
  {
    reporterCode: 840,
    reporterDesc: 'United States of America',
    partnerCode: 276,
    partnerDesc: 'Germany',
    flowCode: 'X',
    cmdCode: 'TOTAL',
    cmdDesc: 'Total (all commodities)',
    period: '2022',
    primaryValue: 120_000_000,
  },
  {
    reporterCode: 840,
    reporterDesc: 'United States of America',
    partnerCode: 156,
    partnerDesc: 'China',
    flowCode: 'X',
    cmdCode: 'TOTAL',
    cmdDesc: 'Total (all commodities)',
    period: '2022',
    primaryValue: 300_000_000,
  },
  {
    // World aggregate — should be filtered out
    reporterCode: 840,
    reporterDesc: 'United States of America',
    partnerCode: 0,
    partnerDesc: 'World',
    flowCode: 'X',
    cmdCode: 'TOTAL',
    cmdDesc: 'Total (all commodities)',
    period: '2022',
    primaryValue: 420_000_000,
  },
];

/** `count` distinct partners with strictly descending values. */
function rankedPartners(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    ...PARTNER_RECORDS[0]!,
    partnerCode: i + 1,
    partnerDesc: `Partner ${i + 1}`,
    primaryValue: (count - i) * 1000,
  }));
}

const args = { reporter_code: 840, flow_code: 'X', period: '2022' };

describe('getTopPartnersTool', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    initComtradeDataService(mockConfig, mockStorage);
    initComtradeReferenceService(mockConfig, mockStorage);
    fetchMock = vi
      .spyOn(ComtradeDataService.prototype, 'fetchTradeData')
      .mockResolvedValue({ records: PARTNER_RECORDS, totalCount: 3, truncated: false });
  });

  it('returns exactly limit partners above 50 while totalPartners counts every partner', async () => {
    fetchMock.mockResolvedValue({ records: rankedPartners(60), totalCount: 60, truncated: false });
    const result = await runToolContract(getTopPartnersTool, { ...args, limit: 51 });
    expect(result.isError).not.toBe(true);
    const output = getTopPartnersTool.output.parse(result.structuredContent);
    expect(output.partners).toHaveLength(51);
    expect(output.partners.at(-1)).toMatchObject({ rank: 51, partnerCode: 51 });
    expect(output.totalPartners).toBe(60);
    const text = JSON.stringify(result.content);
    expect(text).toContain('**#51. Partner 51**');
    expect(text).not.toContain('**#52.');
    expect(text).toContain('**Total Partners:** 60');
  });

  it('returns every partner when limit exceeds the total', async () => {
    fetchMock.mockResolvedValue({ records: rankedPartners(60), totalCount: 60, truncated: false });
    const result = await runToolContract(getTopPartnersTool, { ...args, limit: 70 });
    const output = getTopPartnersTool.output.parse(result.structuredContent);
    expect(output.partners).toHaveLength(60);
    expect(output.totalPartners).toBe(60);
    expect(JSON.stringify(result.content)).toContain('**#60. Partner 60**');
  });

  it.each([
    [
      250,
      { referenceStatus: 'partner_only', name: 'Metropolitan France', suggestedReporterCode: 251 },
      'Reporter 250 (Metropolitan France) is a partner-only code in UN Comtrade reference data; reporter 251 shares its ISO-3 identity. Retry with reporter_code 251.',
    ],
    [
      0,
      { referenceStatus: 'partner_only', name: 'World' },
      'Reporter 0 (World) is a partner-only code in UN Comtrade reference data and has no reporter-valid counterpart. Find a reporter with comtrade_lookup_countries using role "reporter".',
    ],
  ] as const)(
    'names partner-only reporter %i and its suggested reporter on both surfaces',
    async (code, status, sentence) => {
      fetchMock.mockResolvedValue({ records: [], totalCount: 0, truncated: false });
      const lookup = vi
        .spyOn(ComtradeReferenceService.prototype, 'getReporterStatus')
        .mockReturnValue(status as ReporterStatus);
      const result = await runToolContract(getTopPartnersTool, { ...args, reporter_code: code });
      expect(lookup).toHaveBeenCalledWith(code);
      expect(result.isError).not.toBe(true);
      const notice = (result.structuredContent as { notice?: string }).notice;
      expect(notice).toBe(
        `No partner data found for reporter ${code}, flow=X, period=2022. ${sentence}`,
      );
      expect(JSON.stringify(result.content)).toContain(JSON.stringify(sentence).slice(1, -1));
      expect(notice).not.toContain('comtrade_get_data_availability');
      // The empty ranking names the reporter as the reference data does, not by its bare code.
      expect(result.structuredContent).toMatchObject({ reporterDesc: status.name });
      expect(JSON.stringify(result.content)).toContain(`${status.name} (reporterCode: ${code})`);
    },
  );

  it.each([
    [999, { referenceStatus: 'unknown' }],
    [842, { referenceStatus: 'reporter', name: 'USA' }],
  ] as const)(
    'keeps the availability notice for an empty %i that is not partner-only',
    async (code, status) => {
      fetchMock.mockResolvedValue({ records: [], totalCount: 0, truncated: false });
      vi.spyOn(ComtradeReferenceService.prototype, 'getReporterStatus').mockReturnValue(
        status as ReporterStatus,
      );
      const result = await runToolContract(getTopPartnersTool, { ...args, reporter_code: code });
      expect((result.structuredContent as { notice?: string }).notice).toBe(
        `No partner data found for reporter ${code}, flow=X, period=2022. Use comtrade_get_data_availability to verify data exists.`,
      );
    },
  );

  it('serves rows a partner-only reporter returns unchanged and without a notice', async () => {
    vi.spyOn(ComtradeReferenceService.prototype, 'getReporterStatus').mockReturnValue({
      referenceStatus: 'partner_only',
      name: 'Metropolitan France',
      suggestedReporterCode: 251,
    });
    const ctx = createMockContext({ errors: getTopPartnersTool.errors });
    const result = await getTopPartnersTool.handler(
      getTopPartnersTool.input.parse({ ...args, reporter_code: 250 }),
      ctx,
    );
    expect(result.partners.map((p) => p.partnerCode)).toEqual([156, 276]);
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('tells a rate-limited ranking how long to wait, without a period lever', async () => {
    fetchMock.mockRejectedValue(
      periodFailureError([{ period: '2022', reason: 'rate_limited', retryAfterSeconds: 6 }]),
    );
    const result = await runToolContract(getTopPartnersTool, args);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.RateLimited,
        data: {
          reason: 'rate_limited',
          retryable: true,
          retryAfter: 6,
          recovery: { hint: 'Wait 6 seconds, then retry.' },
        },
      },
    });
    expect(JSON.stringify(result.content)).toContain('Wait 6 seconds, then retry.');
    expect(JSON.stringify(result)).not.toContain('fewer periods');
  });

  it('answers a missed deadline with the declared recovery, without a period lever', async () => {
    fetchMock.mockRejectedValue(
      periodFailureError([{ period: '2022', reason: 'deadline_exceeded' }]),
    );
    const declared = getTopPartnersTool.errors?.find((e) => e.reason === 'deadline_exceeded');
    const result = await runToolContract(getTopPartnersTool, args);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.Timeout,
        data: { reason: 'deadline_exceeded', recovery: { hint: declared?.recovery } },
      },
    });
    expect(JSON.stringify(result.content)).toContain(String(declared?.recovery));
    expect(JSON.stringify(result)).not.toContain('fewer periods');
  });

  it('ranks partners by descending trade value', async () => {
    const ctx = createMockContext({ errors: getTopPartnersTool.errors });
    const input = getTopPartnersTool.input.parse({
      reporter_code: 840,
      flow_code: 'X',
      period: '2022',
    });
    const result = await getTopPartnersTool.handler(input, ctx);
    expect(result.partners[0]?.partnerCode).toBe(156); // China has higher value
    expect(result.partners[0]?.rank).toBe(1);
    expect(result.partners[1]?.partnerCode).toBe(276);
    expect(result.partners[1]?.rank).toBe(2);
  });

  it('excludes World aggregate (partnerCode 0)', async () => {
    const ctx = createMockContext({ errors: getTopPartnersTool.errors });
    const input = getTopPartnersTool.input.parse({
      reporter_code: 840,
      flow_code: 'X',
      period: '2022',
    });
    const result = await getTopPartnersTool.handler(input, ctx);
    expect(result.partners.every((p) => p.partnerCode !== 0)).toBe(true);
  });

  it('calculates share percentages', async () => {
    const ctx = createMockContext({ errors: getTopPartnersTool.errors });
    const input = getTopPartnersTool.input.parse({
      reporter_code: 840,
      flow_code: 'X',
      period: '2022',
      limit: 2,
    });
    const result = await getTopPartnersTool.handler(input, ctx);
    expect(result.totalValueUsd).toBe(420_000_000);
    expect(result.partners[0]?.sharePercent).toBe(71.43);
  });

  it('respects the limit parameter', async () => {
    const ctx = createMockContext({ errors: getTopPartnersTool.errors });
    const input = getTopPartnersTool.input.parse({
      reporter_code: 840,
      flow_code: 'X',
      period: '2022',
      limit: 1,
    });
    const result = await getTopPartnersTool.handler(input, ctx);
    expect(result.partners).toHaveLength(1);
    expect(result.totalPartners).toBe(2); // China + Germany (World filtered out)
  });

  it('returns notice when no data found', async () => {
    fetchMock.mockResolvedValue({ records: [], totalCount: 0, truncated: false });
    const ctx = createMockContext({ errors: getTopPartnersTool.errors });
    const input = getTopPartnersTool.input.parse({
      reporter_code: 999,
      flow_code: 'X',
      period: '1900',
    });
    const result = await getTopPartnersTool.handler(input, ctx);
    expect(result.partners).toHaveLength(0);
    expect(getEnrichment(ctx).notice).toBeDefined();
  });

  it('formats output with reporterCode, flowCode, period, cmdCode, and ranks', () => {
    const output = {
      partners: [
        {
          rank: 1,
          partnerCode: 156,
          partnerDesc: 'China',
          primaryValueUsd: 300_000_000,
          sharePercent: 71.43,
        },
        {
          rank: 2,
          partnerCode: 276,
          partnerDesc: 'Germany',
          primaryValueUsd: 120_000_000,
          sharePercent: 28.57,
        },
      ],
      reporterCode: 840,
      reporterDesc: 'United States of America',
      period: '2022',
      flowCode: 'X',
      cmdCode: 'TOTAL',
      classification: 'HS',
      totalPartners: 2,
      totalValueUsd: 420_000_000,
      truncated: false,
    };
    const blocks = getTopPartnersTool.format!(output);
    expect(blocks[0].type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('| 2022 | HS TOTAL |');
    expect(text).toContain('reporterCode: 840');
    expect(text).toContain('flowCode: X');
    expect(text).toContain('China');
    expect(text).toContain('Germany');
    expect(text).toContain('#1');
    expect(text).toContain('#2');
    expect(text).toContain('71.43%');
  });
});

/** Upstream requests the real data service sends, through a fetch fake that rejects other hosts. */
describe('getTopPartnersTool upstream requests', () => {
  let requests: URL[];
  let fetchFake: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    vi.restoreAllMocks();
    settings.subscriptionKey = '';
    initComtradeDataService(mockConfig, mockStorage);
    initComtradeReferenceService(mockConfig, mockStorage);
    requests = [];
    fetchFake = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname !== 'comtradeapi.un.org')
        throw new Error(`Unexpected fetch to ${url.origin}`);
      requests.push(url);
      return Response.json({
        count: 1,
        data: [{ ...PARTNER_RECORDS[1], period: '2022', motCode: 0, customsCode: 'C00' }],
      });
    });
    vi.stubGlobal('fetch', fetchFake);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('requests the as-reported HS preview route across all partners when classification is omitted', async () => {
    const result = await getTopPartnersTool.handler(
      getTopPartnersTool.input.parse({ reporter_code: 842, flow_code: 'X', period: '2022' }),
      createMockContext(),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.pathname).toBe('/public/v1/preview/C/A/HS');
    expect(requests[0]?.searchParams.get('cmdCode')).toBe('TOTAL');
    expect(requests[0]?.searchParams.has('partnerCode')).toBe(false);
    expect(result.partners.map((p) => p.partnerCode)).toEqual([156]);
  });

  it('ranks partners for a normalized SITC classification and a SITC code', async () => {
    const result = await runToolContract(getTopPartnersTool, {
      ...args,
      reporter_code: 842,
      classification: ' s4 ',
      cmd_code: '071',
    });
    expect(result.isError).not.toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.pathname).toBe('/public/v1/preview/C/A/S4');
    expect(requests[0]?.searchParams.get('cmdCode')).toBe('071');
    expect(result.structuredContent).toMatchObject({
      cmdCode: '071',
      classification: 'S4',
      totalPartners: 1,
    });
    // "07" is an HS chapter under HS and a SITC division under S4; both surfaces say which.
    expect(JSON.stringify(result.content)).toContain('| 2022 | S4 071 |');
  });

  it('forwards an explicit HS edition with authenticated access', async () => {
    settings.subscriptionKey = 'test-key';
    await runToolContract(getTopPartnersTool, { ...args, classification: 'h6' });
    expect(requests[0]?.pathname).toBe('/data/v1/get/C/A/H6');
  });

  it('rejects an explicit HS edition keyless with its declared reason and no request', async () => {
    const result = await runToolContract(getTopPartnersTool, { ...args, classification: 'H6' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'keyless_hs_edition_unsupported' },
      },
    });
    expect(JSON.stringify(result.content)).toContain('keyless_hs_edition_unsupported');
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it('accepts SITC codes only under a SITC classification', () => {
    const rejected = getTopPartnersTool.input.safeParse({ ...args, cmd_code: '071' });
    expect(rejected.success).toBe(false);
    // The rejection names the lever: a SITC code needs a SITC classification.
    expect(rejected.error?.issues[0]?.message).toContain('need classification S1–S4 or SS');
    expect(
      getTopPartnersTool.input.safeParse({ ...args, classification: 'S4', cmd_code: '071' })
        .success,
    ).toBe(true);
    expect(getTopPartnersTool.input.safeParse({ ...args, classification: 'X9' }).success).toBe(
      false,
    );
  });
});
