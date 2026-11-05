/**
 * @fileoverview Tests for the get-services-trade tool.
 * @module tests/tools/get-services-trade.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServicesTradeTool } from '@/mcp-server/tools/definitions/get-services-trade.tool.js';
import {
  ComtradeDataService,
  getComtradeDataService,
  initComtradeDataService,
} from '@/services/comtrade-data/comtrade-data-service.js';
import {
  ComtradeReferenceService,
  initComtradeReferenceService,
} from '@/services/comtrade-reference/comtrade-reference-service.js';

const mockConfig = {} as Parameters<typeof initComtradeDataService>[0];
const mockStorage = {} as Parameters<typeof initComtradeDataService>[1];

/** Every text block of a tool result, as one string. */
function textOf(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return (result.content ?? []).map((block) => (block as { text: string }).text).join('\n');
}

interface EbRow {
  id: string;
  parent: string;
  text: string;
}

/** Combined EB.json rows, including codes no scheme catalog lists (3a.3.1). */
const EB_ROWS: EbRow[] = [
  { id: '200', text: 'Total EBOPS 2002/2010 Services', parent: '#' },
  { id: '3', text: '3 Transport', parent: 'TOTAL' },
  { id: '3.1', text: '3.1 Sea transport', parent: '3' },
  { id: '7', text: '7 Financial services', parent: 'TOTAL' },
  { id: '205', text: '1. Transportation', parent: '200' },
  { id: '260', text: '6. Financial services', parent: '200' },
  { id: 'S', text: 'Total EBOPS 2010 SDMX Services', parent: '#' },
  { id: 'SG', text: 'Financial services', parent: 'S' },
  { id: '3a.3.1', text: '3a.3.1  Postal and courier services', parent: '3a.3' },
];

/** Per-scheme catalogs by reference file name. */
const SCHEME_FILES: Record<string, EbRow[]> = {
  'EB10.json': [
    { id: '200', text: 'Total EBOPS 2010 Services', parent: '#' },
    { id: '3', text: '3 Transport', parent: '200' },
    { id: '3.1', text: '3.1 Sea transport', parent: '3' },
    { id: '7', text: '7 Financial services', parent: '200' },
  ],
  'EB10S.json': [
    { id: 'S', text: 'Total EBOPS 2010 SDMX Services', parent: '#' },
    { id: 'SG', text: 'Financial services', parent: 'S' },
  ],
  'EB02.json': [
    { id: '200', text: 'TOTAL - Total EBOPS 2002 Services', parent: '#' },
    { id: '205', text: '1. Transportation', parent: '200' },
    { id: '260', text: '6. Financial services', parent: '200' },
  ],
};

/** A reference service whose EB.json index holds `EB_ROWS` and whose country index is empty. */
function seedReferenceService(): ComtradeReferenceService {
  const svc = initComtradeReferenceService(mockConfig, mockStorage);
  // @ts-expect-error — seeding private map
  svc.ebopsByCode = new Map(EB_ROWS.map((row) => [row.id, row]));
  return svc;
}

/** True for a request to one of the per-scheme EB reference catalogs. */
function isSchemeCatalog(input: Parameters<typeof fetch>[0]): boolean {
  const url = new URL(String(input));
  return (
    url.hostname === 'comtradeapi.un.org' &&
    url.pathname.startsWith('/files/v1/app/reference/') &&
    (url.pathname.split('/').at(-1) ?? '') in SCHEME_FILES
  );
}

/** Serve the scheme catalogs, `missing` ones as 404s; reject every other request. */
function stubSchemeCatalogs(missing: string[] = []): ReturnType<typeof vi.fn<typeof fetch>> {
  const fetchStub = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    if (!isSchemeCatalog(input)) throw new Error(`Unexpected fetch ${String(input)}`);
    const file = new URL(String(input)).pathname.split('/').at(-1) ?? '';
    const rows = missing.includes(file) ? undefined : SCHEME_FILES[file];
    return rows ? Response.json({ results: rows }) : new Response('missing', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchStub);
  return fetchStub;
}

/** Scheme catalogs that never answer; each request rejects only when its signal aborts. */
function stubHangingSchemeCatalogs(): ReturnType<typeof vi.fn<typeof fetch>> {
  const fetchStub = vi.fn<typeof fetch>().mockImplementation((input, init) => {
    if (!isSchemeCatalog(input))
      return Promise.reject(new Error(`Unexpected fetch ${String(input)}`));
    return new Promise<Response>((_resolve, reject) =>
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }),
    );
  });
  vi.stubGlobal('fetch', fetchStub);
  return fetchStub;
}

const AVAILABILITY_ROUTE =
  'Use comtrade_get_data_availability with type_code="S" and classification="EB" to check coverage and the scheme each period was reported in.';
const EB_SCHEME_EFFECT =
  'EB serves each reporter-period in the scheme it was reported in, so a period reported in another scheme has no rows for this code.';

const SERVICES_RECORD = {
  reporterCode: 840,
  reporterDesc: 'United States of America',
  partnerCode: 0,
  partnerDesc: 'World',
  flowCode: 'X',
  cmdCode: 'SA',
  cmdDesc: 'Manufacturing services on physical inputs owned by others',
  period: '2022',
  primaryValue: 80_000_000_000,
  isReported: true,
};

describe('getServicesTradeTool', () => {
  it('retains actual classification and reference failure on both surfaces', async () => {
    vi.spyOn(ComtradeDataService.prototype, 'fetchTradeData').mockResolvedValue({
      records: [
        { ...SERVICES_RECORD, classificationCode: 'EB10', primaryValue: 0, isReported: false },
      ],
      totalCount: 1,
      truncated: false,
      referenceNotice: 'Reference unavailable; values retained.',
    });
    const result = await runToolContract(getServicesTradeTool, {
      reporter_code: 840,
      flow_code: 'X',
      period: ['2022'],
    });
    expect(result.structuredContent).toMatchObject({
      records: [
        expect.objectContaining({ classificationCode: 'EB10', primaryValue: 0, isReported: false }),
      ],
      referenceNotice: 'Reference unavailable; values retained.',
    });
    expect(JSON.stringify(result.content)).toContain('EB10');
    expect(JSON.stringify(result.content)).toContain('Reference unavailable; values retained.');
  });
  let fetchMock: ReturnType<typeof vi.spyOn>;
  let catalogFetch: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    initComtradeDataService(mockConfig, mockStorage);
    seedReferenceService();
    catalogFetch = stubSchemeCatalogs();
    fetchMock = vi
      .spyOn(ComtradeDataService.prototype, 'fetchTradeData')
      .mockResolvedValue({ records: [SERVICES_RECORD], totalCount: 1, truncated: false });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns services trade records for valid input', async () => {
    const ctx = createMockContext({ errors: getServicesTradeTool.errors });
    const input = getServicesTradeTool.input.parse({
      reporter_code: 840,
      flow_code: 'X',
      period: ['2022'],
    });
    const result = await getServicesTradeTool.handler(input, ctx);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.cmdCode).toBe('SA');
    expect(result.shown).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it('passes typeCode=S and classificationCode=EB to the service', async () => {
    const ctx = createMockContext({ errors: getServicesTradeTool.errors });
    const input = getServicesTradeTool.input.parse({
      reporter_code: 840,
      flow_code: 'X',
      period: ['2022'],
      service_code: 'SA',
    });
    await getServicesTradeTool.handler(input, ctx);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        typeCode: 'S',
        classificationCode: 'EB',
        cmdCode: 'SA',
      }),
      expect.anything(),
      expect.any(Number),
    );
  });

  it.each([
    [undefined, 'EB'],
    [' ', 'EB'],
    [' eb ', 'EB'],
    [' eb10 ', 'EB10'],
    ['Eb02', 'EB02'],
  ])('requests classification %j as %s', async (classification, expected) => {
    await runToolContract(getServicesTradeTool, {
      reporter_code: 276,
      flow_code: 'X',
      period: ['2022'],
      partner_code: 0,
      service_code: '7',
      ...(classification !== undefined && { classification }),
    });
    expect(fetchMock.mock.calls.at(-1)?.[0]).toMatchObject({
      typeCode: 'S',
      freqCode: 'A',
      classificationCode: expected,
      cmdCode: '7',
    });
  });

  it.each(['EB10S', ' eb10s ', 'HS', 'S4', 'EB2010'])(
    'rejects classification %j before any request',
    async (classification) => {
      const result = await runToolContract(getServicesTradeTool, {
        reporter_code: 276,
        flow_code: 'X',
        period: ['2022'],
        classification,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
      expect(textOf(result)).toContain(
        classification.trim().toUpperCase() === 'EB10S'
          ? 'EB10S has no converted series; its rows are served only under EB. Use classification EB.'
          : 'Use EB as reported, or EB10 or EB02 for UN Comtrade',
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('relays isOriginalClassification on both surfaces', async () => {
    fetchMock.mockResolvedValue({
      records: [
        {
          ...SERVICES_RECORD,
          reporterCode: 276,
          reporterDesc: 'Germany',
          cmdCode: '7',
          cmdDesc: 'Financial services',
          classificationCode: 'EB10',
          isOriginalClassification: false,
          primaryValue: 33_757_579_931.91,
        },
        { ...SERVICES_RECORD, classificationCode: 'EB10S', isOriginalClassification: true },
      ],
      totalCount: 2,
      truncated: false,
    });
    const result = await runToolContract(getServicesTradeTool, {
      reporter_code: 276,
      flow_code: 'X',
      period: ['2022'],
      classification: 'EB10',
    });
    const output = getServicesTradeTool.output.parse(result.structuredContent);
    expect(output.records.map((record) => record.isOriginalClassification)).toEqual([false, true]);
    const text = textOf(result);
    expect(text).toContain('Original classification: No (converted by UN Comtrade)');
    expect(text).toContain('Original classification: Yes (as reported)');
  });

  it.each([
    {
      service_code: '7',
      notice: `Service code 7 belongs to EB10; ${EB_SCHEME_EFFECT} ${AVAILABILITY_ROUTE} Set classification to "EB10" for UN Comtrade's converted series.`,
    },
    {
      service_code: '200',
      notice: `Service code 200 belongs to EB10 and EB02; ${EB_SCHEME_EFFECT} ${AVAILABILITY_ROUTE} Set classification to "EB10" or "EB02" for UN Comtrade's converted series.`,
    },
    {
      service_code: 'sg',
      notice: `Service code SG belongs to EB10S; ${EB_SCHEME_EFFECT} ${AVAILABILITY_ROUTE}`,
    },
    { service_code: '3a.3.1', notice: AVAILABILITY_ROUTE },
    { service_code: 'ZZZ', notice: AVAILABILITY_ROUTE },
  ])(
    'names the EB scheme of empty service code $service_code and routes to availability under EB',
    async ({ service_code, notice }) => {
      fetchMock.mockResolvedValue({ records: [], totalCount: 0, truncated: false });
      const result = await runToolContract(getServicesTradeTool, {
        reporter_code: 276,
        flow_code: 'X',
        period: ['2022'],
        partner_code: 0,
        service_code,
      });
      const expected = `No services trade records found for reporter 276, flow=X, periods=[2022]. ${notice}`;
      expect(result.structuredContent).toMatchObject({ records: [], notice: expected });
      expect(textOf(result)).toContain(`> ${expected}`);
      expect(catalogFetch).toHaveBeenCalledTimes(3);
    },
  );

  it('says under EB10 that rows reported in EB10 itself are served under EB', async () => {
    fetchMock.mockResolvedValue({ records: [], totalCount: 0, truncated: false });
    const result = await runToolContract(getServicesTradeTool, {
      reporter_code: 842,
      flow_code: 'X',
      period: ['2022'],
      partner_code: 0,
      service_code: '7',
      classification: 'EB10',
    });
    const expected = `No services trade records found for reporter 842, flow=X, periods=[2022]. EB10 serves UN Comtrade's conversions from other schemes; rows reported in EB10 itself are served under classification "EB". Service code 7 belongs to EB10. ${AVAILABILITY_ROUTE}`;
    expect(result.structuredContent).toMatchObject({ notice: expected });
    expect(textOf(result)).toContain(`> ${expected}`);
  });

  it('discloses unavailable scheme catalogs and keeps the availability route', async () => {
    catalogFetch = stubSchemeCatalogs(['EB10S.json']);
    fetchMock.mockResolvedValue({ records: [], totalCount: 0, truncated: false });
    const result = await runToolContract(getServicesTradeTool, {
      reporter_code: 276,
      flow_code: 'X',
      period: ['2022'],
      service_code: '7',
    });
    const expected = `No services trade records found for reporter 276, flow=X, periods=[2022]. The EB scheme catalogs did not load, so service code 7 is not matched to a scheme. ${AVAILABILITY_ROUTE}`;
    expect(result.structuredContent).toMatchObject({ notice: expected });
    expect(textOf(result)).toContain(`> ${expected}`);
  });

  it('loads no scheme catalog for an empty result without a service code', async () => {
    fetchMock.mockResolvedValue({ records: [], totalCount: 0, truncated: false });
    const result = await runToolContract(getServicesTradeTool, {
      reporter_code: 276,
      flow_code: 'X',
      period: ['2022'],
      classification: 'EB02',
    });
    expect(result.structuredContent).toMatchObject({
      notice: `No services trade records found for reporter 276, flow=X, periods=[2022]. EB02 serves UN Comtrade's conversions from other schemes; rows reported in EB02 itself are served under classification "EB". ${AVAILABILITY_ROUTE}`,
    });
    expect(catalogFetch).not.toHaveBeenCalled();
  });

  it.each([
    {
      reporter_code: 250,
      status: {
        referenceStatus: 'partner_only',
        name: 'Metropolitan France',
        suggestedReporterCode: 251,
      },
      sentence:
        'Reporter 250 (Metropolitan France) is a partner-only code in UN Comtrade reference data; reporter 251 shares its ISO-3 identity. Retry with reporter_code 251.',
    },
    {
      reporter_code: 0,
      status: { referenceStatus: 'partner_only', name: 'World' },
      sentence:
        'Reporter 0 (World) is a partner-only code in UN Comtrade reference data and has no reporter-valid counterpart. Find a reporter with comtrade_lookup_countries using role "reporter".',
    },
    {
      reporter_code: 842,
      status: { referenceStatus: 'reporter', name: 'USA' },
      sentence: `Service code 7 belongs to EB10; ${EB_SCHEME_EFFECT} ${AVAILABILITY_ROUTE} Set classification to "EB10" for UN Comtrade's converted series.`,
    },
  ] as const)(
    'ends the empty notice for reporter $reporter_code with its reference status',
    async ({ reporter_code, status, sentence }) => {
      vi.spyOn(ComtradeReferenceService.prototype, 'getReporterStatus').mockReturnValue(status);
      fetchMock.mockResolvedValue({ records: [], totalCount: 0, truncated: false });
      const result = await runToolContract(getServicesTradeTool, {
        reporter_code,
        flow_code: 'X',
        period: ['2022'],
        partner_code: 0,
        service_code: '7',
      });
      const expected = `No services trade records found for reporter ${reporter_code}, flow=X, periods=[2022]. ${sentence}`;
      expect(fetchMock).toHaveBeenCalledWith(
        expect.objectContaining({ reporterCode: reporter_code }),
        expect.anything(),
        expect.any(Number),
      );
      expect(result.structuredContent).toMatchObject({ records: [], notice: expected });
      expect(textOf(result)).toContain(`> ${expected}`);
    },
  );

  it('serves the rows a partner-only reporter returns without a notice', async () => {
    vi.spyOn(ComtradeReferenceService.prototype, 'getReporterStatus').mockReturnValue({
      referenceStatus: 'partner_only',
      name: 'Metropolitan France',
      suggestedReporterCode: 251,
    });
    fetchMock.mockResolvedValue({
      records: [{ ...SERVICES_RECORD, reporterCode: 250 }],
      totalCount: 1,
      truncated: false,
    });
    const result = await runToolContract(getServicesTradeTool, {
      reporter_code: 250,
      flow_code: 'X',
      period: ['2022'],
    });
    expect(result.structuredContent).toMatchObject({ shown: 1 });
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('joins a period failure, the EB10 conversion note, and the scheme into one notice', async () => {
    fetchMock.mockResolvedValue({
      records: [],
      totalCount: 0,
      truncated: false,
      failedPeriods: [{ period: '2023', reason: 'deadline_exceeded' }],
    });
    const result = await runToolContract(getServicesTradeTool, {
      reporter_code: 842,
      flow_code: 'X',
      period: ['2022', '2023'],
      service_code: 'SG',
      classification: 'eb10',
    });
    const expected = `Period 2023 was not completed within the call's time budget. No services trade records found for reporter 842, flow=X, periods=[2022]. EB10 serves UN Comtrade's conversions from other schemes; rows reported in EB10 itself are served under classification "EB". Service code SG belongs to EB10S. ${AVAILABILITY_ROUTE}`;
    expect(result.structuredContent).toMatchObject({ unservedPeriods: ['2023'], notice: expected });
    expect(textOf(result)).toContain(`> ${expected}`);
  });

  it('gives the scheme lookup only what is left of the 52 s call budget', async () => {
    vi.useFakeTimers();
    stubHangingSchemeCatalogs();
    const start = Date.now();
    fetchMock.mockImplementation(async () => {
      vi.setSystemTime(start + 50_000);
      return { records: [], totalCount: 0, truncated: false };
    });
    const ctx = createMockContext({ errors: getServicesTradeTool.errors });
    let settled = false;
    const run = getServicesTradeTool
      .handler(
        getServicesTradeTool.input.parse({
          reporter_code: 276,
          flow_code: 'X',
          period: ['2022'],
          service_code: '7',
        }),
        ctx,
      )
      .finally(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(Date.now() - start).toBe(52_000);
    expect(fetchMock.mock.calls[0]?.[2]).toBe(start + 52_000);
    expect(getEnrichment(ctx).notice).toBe(
      `No services trade records found for reporter 276, flow=X, periods=[2022]. The EB scheme catalogs did not load, so service code 7 is not matched to a scheme. ${AVAILABILITY_ROUTE}`,
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates caller cancellation during the scheme lookup', async () => {
    vi.useFakeTimers();
    const catalogs = stubHangingSchemeCatalogs();
    fetchMock.mockResolvedValue({ records: [], totalCount: 0, truncated: false });
    const controller = new AbortController();
    const ctx = createMockContext({
      errors: getServicesTradeTool.errors,
      signal: controller.signal,
    });
    const run = getServicesTradeTool.handler(
      getServicesTradeTool.input.parse({
        reporter_code: 276,
        flow_code: 'X',
        period: ['2022'],
        service_code: '7',
      }),
      ctx,
    );
    const outcome = run.then(
      () => 'resolved',
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(catalogs).toHaveBeenCalled();
    controller.abort();
    await expect(outcome).resolves.toMatchObject({ name: 'AbortError' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes multiple periods as CSV', async () => {
    const ctx = createMockContext({ errors: getServicesTradeTool.errors });
    const input = getServicesTradeTool.input.parse({
      reporter_code: 840,
      flow_code: 'X',
      period: ['2021', '2022'],
    });
    await getServicesTradeTool.handler(input, ctx);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ period: '2021,2022' }),
      expect.anything(),
      expect.any(Number),
    );
  });

  it('returns notice when no records found', async () => {
    fetchMock.mockResolvedValue({ records: [], totalCount: 0, truncated: false });
    const ctx = createMockContext({ errors: getServicesTradeTool.errors });
    const input = getServicesTradeTool.input.parse({
      reporter_code: 999,
      flow_code: 'X',
      period: ['1900'],
    });
    const result = await getServicesTradeTool.handler(input, ctx);
    expect(result.records).toHaveLength(0);
    expect(getEnrichment(ctx).notice).toBeDefined();
    expect(getEnrichment(ctx).notice).toContain('999');
  });

  it('lists failed served periods, then periods past the keyless cap, with the failure notice on both surfaces', async () => {
    const periods = Array.from({ length: 9 }, (_, i) => String(2015 + i));
    fetchMock.mockResolvedValue({
      records: ['2015', '2016', '2018', '2019', '2020', '2021', '2022'].map((period) => ({
        ...SERVICES_RECORD,
        period,
      })),
      totalCount: 7,
      truncated: false,
      failedPeriods: [{ period: '2017', reason: 'deadline_exceeded' }],
    });
    const result = await runToolContract(getServicesTradeTool, {
      reporter_code: 840,
      flow_code: 'X',
      period: periods,
    });
    const notice = "Period 2017 was not completed within the call's time budget.";
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ period: periods.slice(0, 8).join(',') }),
      expect.anything(),
      expect.any(Number),
    );
    expect(result.structuredContent).toMatchObject({
      shown: 7,
      unservedPeriods: ['2017', '2023'],
      notice,
    });
    const text = textOf(result);
    expect(text).toContain('**Unserved periods:** 2017, 2023. Query them separately.');
    expect(text).toContain(`> ${notice}`);
    expect(text).not.toContain('No services trade records found');
  });

  it('joins the failure notice with the empty-result notice, which names only answered periods', async () => {
    fetchMock.mockResolvedValue({
      records: [],
      totalCount: 0,
      truncated: false,
      failedPeriods: [{ period: '2022', reason: 'rate_limited', retryAfterSeconds: 9 }],
    });
    const result = await runToolContract(getServicesTradeTool, {
      reporter_code: 842,
      flow_code: 'M',
      period: ['2021', '2022'],
    });
    const notice = `Period 2022 was rate-limited; wait 9 seconds before requesting it again. No services trade records found for reporter 842, flow=M, periods=[2021]. ${AVAILABILITY_ROUTE}`;
    expect(result.structuredContent).toMatchObject({
      records: [],
      unservedPeriods: ['2022'],
      notice,
    });
    expect(textOf(result)).toContain(`> ${notice}`);
    expect(textOf(result)).toContain('**Unserved periods:** 2022. Query them separately.');
  });

  it('propagates truncation', async () => {
    fetchMock.mockResolvedValue({
      records: [SERVICES_RECORD],
      totalCount: 600,
      truncated: true,
      truncationHint: 'Set COMTRADE_SUBSCRIPTION_KEY',
    });
    const ctx = createMockContext({ errors: getServicesTradeTool.errors });
    const input = getServicesTradeTool.input.parse({
      reporter_code: 840,
      flow_code: 'X',
      period: ['2022'],
    });
    const result = await getServicesTradeTool.handler(input, ctx);
    expect(result.truncated).toBe(true);
    expect(result.truncationHint).toContain('COMTRADE_SUBSCRIPTION_KEY');
  });

  it('formats output with reporterCode, partnerCode, period, flowCode, cmdCode, and value', () => {
    const output = {
      records: [SERVICES_RECORD],
      totalCount: 1,
      shown: 1,
      truncated: false,
    };
    const blocks = getServicesTradeTool.format!(output);
    expect(blocks[0].type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('840');
    expect(text).toContain('0');
    expect(text).toContain('United States of America');
    expect(text).toContain('World');
    expect(text).toContain('2022');
    expect(text).toContain('X');
    expect(text).toContain('SA');
    expect(text).toContain('Manufacturing services');
    expect(text).toContain('80,000,000,000');
  });

  it('describes an omitted service_code as mixed levels whose totals must not be summed', () => {
    const description = getServicesTradeTool.input.shape.service_code.description ?? '';
    expect(description).toContain('every category the reporter reported, at mixed levels');
    expect(description).toContain('200 for EB10 and EB02, S for EB10S');
    expect(description).toContain('do not sum');
  });

  it('formats sparse record without fabricating isReported when absent', () => {
    const sparseRecord = {
      reporterCode: 840,
      reporterDesc: 'United States of America',
      partnerCode: 276,
      partnerDesc: 'Germany',
      flowCode: 'X',
      cmdCode: 'SB',
      cmdDesc: 'Travel',
      period: '2022',
      // primaryValue and isReported omitted
    };
    const output = { records: [sparseRecord], totalCount: 1, shown: 1, truncated: false };
    const blocks = getServicesTradeTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Germany');
    // isReported should not appear since it's absent
    expect(text).not.toContain('Reported:');
    expect(text).not.toContain('Original classification:');
  });
});

describe('getServicesTradeTool on the keyless data service', () => {
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
  it('requests S/A/EB10 and relays converted rows on both surfaces', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.hostname !== 'comtradeapi.un.org' || url.pathname !== '/public/v1/preview/S/A/EB10')
        throw new Error(`Unexpected fetch ${url.pathname}`);
      return Response.json({
        count: 1,
        data: [
          {
            reporterCode: 276,
            reporterDesc: 'Germany',
            partnerCode: 0,
            partnerDesc: 'World',
            period: 2022,
            flowCode: 'X',
            cmdCode: '7',
            cmdDesc: 'Financial services',
            classificationCode: 'EB10',
            isOriginalClassification: false,
            primaryValue: 33_757_579_931.91,
          },
        ],
      });
    });
    const run = runToolContract(getServicesTradeTool, {
      reporter_code: 276,
      flow_code: 'X',
      period: ['2022'],
      partner_code: 0,
      service_code: '7',
      classification: ' eb10 ',
    });
    await vi.runAllTimersAsync();
    const result = await run;
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get('cmdCode')).toBe('7');
    expect(getServicesTradeTool.output.parse(result.structuredContent).records).toEqual([
      expect.objectContaining({
        cmdCode: '7',
        classificationCode: 'EB10',
        isOriginalClassification: false,
        primaryValue: 33_757_579_931.91,
      }),
    ]);
    expect(textOf(result)).toContain('Original classification: No (converted by UN Comtrade)');
  });
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
        'No requested period was served. Period 2022 was rate-limited; wait 6 seconds before requesting it again.',
      data: { retryAfter: 6, recovery: { hint: 'Wait 6 seconds, then retry with fewer periods.' } },
    },
    {
      reason: 'deadline_exceeded',
      code: JsonRpcErrorCode.Timeout,
      respond: (init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          }),
        ),
      message:
        "No requested period was served. Period 2022 was not completed within the call's time budget.",
      data: {
        recovery: {
          hint: 'Retry with fewer periods per call, or retry later if UN Comtrade is responding slowly.',
        },
      },
    },
  ])(
    'fails with $reason and its recovery on both surfaces when no period is served',
    async ({ reason, code, respond, message, data }) => {
      fetchMock.mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        if (url.hostname !== 'comtradeapi.un.org' || url.pathname !== '/public/v1/preview/S/A/EB')
          throw new Error(`Unexpected fetch ${url.pathname}`);
        return respond(init);
      });
      const run = runToolContract(getServicesTradeTool, {
        reporter_code: 842,
        flow_code: 'X',
        period: ['2022'],
      });
      await vi.runAllTimersAsync();
      const result = await run;
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
});
