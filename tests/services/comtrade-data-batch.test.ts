/**
 * @fileoverview Trade data request, normalization, and preview coverage regressions.
 * @module tests/services/comtrade-data-batch.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComtradeDataService } from '@/services/comtrade-data/comtrade-data-service.js';
import { initComtradeReferenceService } from '@/services/comtrade-reference/comtrade-reference-service.js';
import chapters from '../fixtures/comtrade-world-ag2.json';

const settings = vi.hoisted(() => ({ apiBaseUrl: 'https://example.test', subscriptionKey: '' }));
vi.mock('@/config/server-config.js', () => ({ getServerConfig: () => settings }));
const config = {} as ConstructorParameters<typeof ComtradeDataService>[0];
const storage = {} as ConstructorParameters<typeof ComtradeDataService>[1];
const params = { reporterCode: 842, flowCode: 'X' as const, period: '2022', cmdCode: 'TOTAL' };
const row = {
  reporterCode: 842,
  partnerCode: 0,
  cmdCode: 'TOTAL',
  period: '2022',
  primaryValue: 10,
  motCode: 0,
  customsCode: 'C00',
  partner2Code: 0,
};

describe('trade data request and normalization boundaries', () => {
  let svc: ComtradeDataService;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  beforeEach(() => {
    vi.useFakeTimers();
    settings.subscriptionKey = '';
    initComtradeReferenceService(config, storage);
    svc = new ComtradeDataService(config, storage);
    fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('Unexpected fetch'));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    svc.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  async function finish<T>(promise: Promise<T>): Promise<T> {
    const outcome = promise.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await vi.runAllTimersAsync();
    const result = await outcome;
    if ('error' in result) throw result.error;
    return result.value;
  }
  it('characterizes sparse HS values and the aggregate predicate', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        count: 2,
        data: [
          { ...row, primaryValue: null },
          { ...row, motCode: 100 },
        ],
      }),
    );
    const result = await finish(svc.fetchTradeData({ ...params, partnerCode: 0 }));
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).not.toHaveProperty('primaryValue');
    expect(result.totalCount).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([499, 500])('discloses raw preview cap %i before filters', async (count) => {
    fetchMock.mockResolvedValue(
      Response.json({
        count,
        data: Array.from({ length: count }, () => ({ ...row, motCode: 100 })),
      }),
    );
    const result = await finish(svc.fetchTradeData({ ...params, partnerCode: 0 }));
    expect(result.records).toEqual([]);
    expect(result.totalCount).toBe(count);
    expect(result.truncated).toBe(count === 500);
    if (count === 500) {
      expect(result.truncationHint).toContain('may be incomplete');
      expect(result.truncationHint).not.toContain('250,000');
    }
  });
  it('preserves distinct commodities for an AG selector without dedup by partner', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        data: [
          { ...row, cmdCode: '84' },
          { ...row, cmdCode: '87' },
        ],
      }),
    );
    expect((await finish(svc.fetchTradeData({ ...params, cmdCode: 'AG2' }))).records).toHaveLength(
      2,
    );
  });
  it('splits preview periods and shares paced starts across simultaneous flows', async () => {
    const starts: number[] = [];
    fetchMock.mockImplementation(async (url) => {
      starts.push(Date.now());
      const period = new URL(String(url)).searchParams.get('period');
      expect(period).not.toContain(',');
      return Response.json({ count: 300, data: [{ ...row, period }] });
    });
    const results = await finish(
      Promise.all(
        ['X', 'M'].map((flowCode) =>
          svc.fetchTradeData({ ...params, flowCode: flowCode as 'X' | 'M', period: '2022,2023' }),
        ),
      ),
    );
    expect(starts).toHaveLength(4);
    expect(starts.slice(1).map((start, i) => start - starts[i]!)).toEqual([4000, 4000, 4000]);
    for (const result of results) {
      expect(result.records.map((r) => r.period)).toEqual(['2022', '2023']);
      expect(result.totalCount).toBe(600);
      expect(result.truncated).toBe(false);
      expect(result).not.toHaveProperty('failedPeriods');
    }
  });
  it('keeps 4 s between preview starts across retries and waits out a longer Retry-After', async () => {
    const starts: { at: number; flow: string | null; period: string | null }[] = [];
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      const flow = url.searchParams.get('flowCode');
      const period = url.searchParams.get('period');
      starts.push({ at: Date.now(), flow, period });
      // The first M request is refused with a wait longer than the start gap.
      if (flow === 'M' && starts.filter((s) => s.flow === 'M').length === 1)
        return new Response('{"statusCode":429}', { status: 429, headers: { 'Retry-After': '6' } });
      return Response.json({ data: [{ ...row, flowCode: flow, period }] });
    });
    const results = await finish(
      Promise.all(
        (['X', 'M'] as const).map((flowCode) =>
          svc.fetchTradeData({ ...params, flowCode, period: '2022,2023' }),
        ),
      ),
    );
    const gaps = starts.slice(1).map((start, i) => start.at - starts[i]!.at);
    expect(gaps.every((gap) => gap >= 4000)).toBe(true);
    const refused = starts.findIndex((s) => s.flow === 'M');
    expect(starts[refused + 1]!.at - starts[refused]!.at).toBeGreaterThanOrEqual(6000);
    expect(starts).toHaveLength(5);
    for (const result of results)
      expect(result.records.map((r) => r.period)).toEqual(['2022', '2023']);
  });
  it('keeps keyed CSV periods and largest partner row within each period', async () => {
    settings.subscriptionKey = 'test-key';
    fetchMock.mockResolvedValue(
      Response.json({
        count: 500,
        data: [
          { ...row, partnerCode: 616 },
          { ...row, partnerCode: 616, primaryValue: 8 },
          { ...row, partnerCode: 616, period: '2023', primaryValue: 20 },
        ],
      }),
    );
    const result = await finish(svc.fetchTradeData({ ...params, period: '2022,2023' }));
    expect(result.records.map((r) => [r.period, r.primaryValue])).toEqual([
      ['2022', 10],
      ['2023', 20],
    ]);
    expect(result.truncated).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.pathname).toContain('/data/v1/get/');
    expect(url.searchParams.get('period')).toBe('2022,2023');
    expect(url.searchParams.has('maxrecords')).toBe(false);
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      headers: { 'Ocp-Apim-Subscription-Key': 'test-key' },
    });
  });
  it.each(['S1', 'S2', 'S3', 'S4', 'SS'])(
    'resolves %s descriptions without HS collisions',
    async (classificationCode) => {
      // Startup catalogs must be non-empty; reference files not named here load empty.
      const catalogs = new Map<string, unknown[]>([
        ['Reporters.json', [{ id: 842, text: 'USA' }]],
        ['partnerAreas.json', [{ id: 0, text: 'World' }]],
        ['HS.json', [{ id: '11', text: '11 - Products of the milling industry' }]],
        ['EB.json', [{ id: '200', text: 'Total EBOPS 2002/2010 Services' }]],
        [`${classificationCode}.json`, [{ id: '11', text: '11 - Beverages' }]],
      ]);
      fetchMock.mockImplementation(async (input) => {
        const url = new URL(String(input));
        if (url.hostname === 'comtradeapi.un.org') {
          return Response.json({ results: catalogs.get(url.pathname.split('/').at(-1)!) ?? [] });
        }
        return Response.json({
          data: [
            { ...row, cmdCode: '11' },
            { ...row, cmdCode: 'unknown' },
            { ...row, cmdCode: '12', cmdDesc: 'upstream' },
          ],
        });
      });
      const ref = initComtradeReferenceService(config, storage);
      await finish(ref.initialize());
      expect(ref.getHsCode('11')?.text).toBe('11 - Products of the milling industry');
      const result = await finish(
        svc.fetchTradeData({ ...params, partnerCode: 0, classificationCode }),
      );
      expect(result.records.map((r) => r.cmdDesc)).toEqual([
        '11 - Beverages',
        'unknown',
        'upstream',
      ]);
    },
  );
  it('replays captured AG2 chapters with the reproduced TOTAL sum', async () => {
    fetchMock.mockResolvedValue(Response.json({ count: 97, data: chapters }));
    const result = await finish(svc.fetchTradeData({ ...params, partnerCode: 0, cmdCode: 'AG2' }));
    expect(new Set(result.records.map((r) => r.cmdCode)).size).toBe(97);
    expect(result.records.reduce((sum, r) => sum + (r.primaryValue ?? 0), 0)).toBe(2062089832731);
    expect(result.truncated).toBe(false);
  });
  it('cancellation while queued prevents the next period request', async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValue(Response.json({ data: [row] }));
    const promise = svc.fetchTradeData({ ...params, period: '2022,2023,2024' }, controller.signal);
    const assertion = expect(promise).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    controller.abort();
    await assertion;
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('retries a transient request through pacing, but never skips a failed period', async () => {
    const starts: number[] = [];
    fetchMock.mockImplementation(async (url) => {
      starts.push(Date.now());
      if (starts.length === 1) return new Response('busy', { status: 503 });
      const period = new URL(String(url)).searchParams.get('period');
      return period === '2023'
        ? new Response('invalid period', { status: 400 })
        : Response.json({ data: [row] });
    });
    await expect(
      finish(svc.fetchTradeData({ ...params, period: '2022,2023,2024' })),
    ).rejects.toMatchObject({ code: -32602, data: { reason: 'upstream_validation' } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(4000);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(4000);
  });
  /** A preview fetch fake: `refuse` periods answer 429 with `retryAfter`; the rest one row. */
  function previewFake(refuse: Set<string>, retryAfter = '2') {
    const starts: { at: number; period: string }[] = [];
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.hostname !== 'example.test') throw new Error(`Unexpected fetch ${url.hostname}`);
      const period = url.searchParams.get('period') ?? '';
      starts.push({ at: Date.now(), period });
      return refuse.has(period)
        ? new Response('{"statusCode":429,"message":"Rate limit is exceeded."}', {
            status: 429,
            headers: { 'Retry-After': retryAfter },
          })
        : Response.json({ data: [{ ...row, period }] });
    });
    return starts;
  }
  it('returns completed periods and names a period that stays rate limited through every retry', async () => {
    const starts = previewFake(new Set(['2023']));
    const result = await finish(svc.fetchTradeData({ ...params, period: '2022,2023,2024' }));
    expect(result.records.map((r) => r.period)).toEqual(['2022', '2024']);
    expect(result.failedPeriods).toEqual([
      { period: '2023', reason: 'rate_limited', retryAfterSeconds: 2 },
    ]);
    expect(starts.map((s) => s.period)).toEqual(['2022', '2023', '2023', '2023', '2023', '2024']);
    expect(starts.slice(1).every((s, i) => s.at - starts[i]!.at >= 4000)).toBe(true);
  });
  it('fails with rate_limited and the wait on both message and recovery when no period completes', async () => {
    previewFake(new Set(['2022', '2023']), '7');
    const failure = await finish(svc.fetchTradeData({ ...params, period: '2022,2023' })).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      code: -32003,
      message:
        'No requested period was served. Periods 2022, 2023 were rate-limited; wait 7 seconds before requesting them again.',
      data: {
        reason: 'rate_limited',
        retryable: true,
        retryAfter: 7,
        recovery: { hint: 'Wait 7 seconds, then retry with fewer periods.' },
      },
    });
  });
  it('states at least the 4 s start gap as the wait when UN Comtrade asks for less', async () => {
    previewFake(new Set(['2022']), '1');
    await expect(finish(svc.fetchTradeData(params))).rejects.toMatchObject({
      data: { reason: 'rate_limited', retryAfter: 4 },
    });
  });
  it('keeps completed periods at the deadline, names the rest, and starts nothing after settling', async () => {
    let hung = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const period = new URL(String(input)).searchParams.get('period');
      if (period === '2021') {
        hung++;
        return new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          }),
        );
      }
      return Response.json({ data: [{ ...row, period }] });
    });
    const result = await finish(
      svc.fetchTradeData({ ...params, period: '2020,2021,2022' }, undefined, Date.now() + 10_000),
    );
    expect(result.records.map((r) => r.period)).toEqual(['2020']);
    expect(result.failedPeriods).toEqual([
      { period: '2021', reason: 'deadline_exceeded' },
      { period: '2022', reason: 'deadline_exceeded' },
    ]);
    expect(hung).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('sheds a start the deadline cannot fit without sending it', async () => {
    const starts = previewFake(new Set());
    const result = await finish(
      svc.fetchTradeData(
        { ...params, period: '2020,2021,2022,2023' },
        undefined,
        Date.now() + 10_000,
      ),
    );
    expect(starts.map((s) => [s.period, s.at - starts[0]!.at])).toEqual([
      ['2020', 0],
      ['2021', 4000],
      ['2022', 8000],
    ]);
    expect(result.failedPeriods).toEqual([
      { period: '2023', reason: 'deadline_exceeded', retryAfterSeconds: 4 },
    ]);
  });
  it('shares one deadline across calls made for the same tool call', async () => {
    const starts = previewFake(new Set());
    const deadlineAt = Date.now() + 10_000;
    const first = await finish(svc.fetchTradeData(params, undefined, deadlineAt));
    const second = await finish(
      svc.fetchTradeData({ ...params, period: '2023,2024,2025' }, undefined, deadlineAt),
    );
    expect(first.failedPeriods).toBeUndefined();
    expect(second.records.map((r) => r.period)).toEqual(['2023', '2024']);
    expect(second.failedPeriods?.map((f) => [f.period, f.reason])).toEqual([
      ['2025', 'deadline_exceeded'],
    ]);
    expect(starts.every((s) => s.at < deadlineAt)).toBe(true);
  });
  it.each([
    ['a 429', 'rate_limited', ['429']],
    ['a 503 after a 429', 'deadline_exceeded', ['429', '503']],
  ] as const)('reports a budget that runs out after %s as %s', async (_label, reason, answers) => {
    let attempt = 0;
    fetchMock.mockImplementation(async (_input, init) => {
      const status = answers[attempt++];
      if (status === '429')
        return new Response('{}', { status: 429, headers: { 'Retry-After': '1' } });
      if (status === '503') return new Response('busy', { status: 503 });
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
          once: true,
        }),
      );
    });
    await expect(
      finish(svc.fetchTradeData(params, undefined, Date.now() + 10_000)),
    ).rejects.toMatchObject({ data: { reason } });
    expect(fetchMock).toHaveBeenCalledTimes(answers.length + 1);
  });
  it('fails an authenticated call whose single batched request stays rate limited', async () => {
    settings.subscriptionKey = 'test-key';
    previewFake(new Set(['2022,2023']));
    await expect(
      finish(svc.fetchTradeData({ ...params, period: '2022,2023' })),
    ).rejects.toMatchObject({
      message: expect.stringContaining('Periods 2022, 2023 were rate-limited'),
      data: { reason: 'rate_limited' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
  it('serves the per-call period caps: 8 keyless (4 for two-flow balance), 12 authenticated', () => {
    expect([svc.periodsPerCall(1), svc.periodsPerCall(2)]).toEqual([8, 4]);
    settings.subscriptionKey = 'test-key';
    expect([svc.periodsPerCall(1), svc.periodsPerCall(2)]).toEqual([12, 12]);
  });
  it('keeps trade values when a SITC reference fails, then retries the load next call', async () => {
    let available = false;
    fetchMock.mockImplementation(async (url) =>
      String(url).endsWith('S4.json')
        ? available
          ? Response.json({ results: [{ id: '11', text: 'Beverages' }] })
          : new Response('missing', { status: 404 })
        : Response.json({ data: [{ ...row, cmdCode: '11' }] }),
    );
    const first = await finish(
      svc.fetchTradeData({ ...params, partnerCode: 0, classificationCode: 'S4' }),
    );
    expect(first.records[0]).toMatchObject({ cmdCode: '11', cmdDesc: '11', primaryValue: 10 });
    expect(first.referenceNotice).toContain('unavailable');
    available = true;
    const second = await finish(
      svc.fetchTradeData({ ...params, partnerCode: 0, classificationCode: 'S4' }),
    );
    expect(second.records[0]?.cmdDesc).toBe('Beverages');
    expect(second.referenceNotice).toBeUndefined();
  });
  it('does not cache a caller-cancelled SITC load or cancel a concurrent caller', async () => {
    const controller = new AbortController();
    const ref = initComtradeReferenceService(config, storage);
    let loads = 0;
    fetchMock.mockImplementation(async (_url, options) => {
      loads++;
      if (loads === 1)
        return new Promise((_resolve, reject) =>
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          }),
        );
      return Response.json({ results: [{ id: '11', text: 'Beverages' }] });
    });
    const cancelled = ref.getSitcCodes('S4', controller.signal);
    const rejection = expect(cancelled).rejects.toThrow();
    const successful = ref.getSitcCodes('S4');
    controller.abort();
    await rejection;
    expect((await successful).get('11')?.text).toBe('Beverages');
    expect((await ref.getSitcCodes('S4')).get('11')?.text).toBe('Beverages');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("serves a keyless balance's 8 preview slices 4 s apart inside one shared deadline", async () => {
    const starts = previewFake(new Set());
    const deadlineAt = Date.now() + 52_000;
    const results = await finish(
      Promise.all(
        (['X', 'M'] as const).map((flowCode) =>
          svc.fetchTradeData(
            { ...params, flowCode, period: '2000,2001,2002,2003' },
            undefined,
            deadlineAt,
          ),
        ),
      ),
    );
    expect(results.map((r) => [r.records.length, r.failedPeriods])).toEqual([
      [4, undefined],
      [4, undefined],
    ]);
    expect(starts).toHaveLength(8);
    expect(starts.at(-1)!.at - starts[0]!.at).toBe(28_000);
  });
  it('cuts 24 keyless slices at the shared deadline: every start before it, none after settling', async () => {
    const starts = previewFake(new Set());
    const deadlineAt = Date.now() + 52_000;
    const periods = Array.from({ length: 12 }, (_, i) => String(2000 + i));
    const results = await finish(
      Promise.all(
        (['X', 'M'] as const).map((flowCode) =>
          svc.fetchTradeData(
            { ...params, flowCode, period: periods.join(',') },
            undefined,
            deadlineAt,
          ),
        ),
      ),
    );
    expect(starts.every((s) => s.at < deadlineAt)).toBe(true);
    expect(starts).toHaveLength(13);
    for (const result of results) {
      const served = result.records.map((r) => r.period);
      const failed = result.failedPeriods?.map((f) => f.period) ?? [];
      expect([...served, ...failed]).toEqual(periods);
      expect(result.failedPeriods?.every((f) => f.reason === 'deadline_exceeded')).toBe(true);
    }
    expect(vi.getTimerCount()).toBe(0);
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(13);
  });
  it('repeated periods do not duplicate totals or consume redundant preview requests', async () => {
    fetchMock.mockImplementation(async (url) =>
      Response.json({
        data: [{ ...row, period: new URL(String(url)).searchParams.get('period') }],
      }),
    );
    const result = await finish(
      svc.fetchTradeData({
        ...params,
        period: '202201,202202,202201',
        freqCode: 'M',
        partnerCode: 0,
      }),
    );
    expect(result.records.map((r) => r.period)).toEqual(['202201', '202202']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('rejects explicit HS editions before a keyless request', async () => {
    fetchMock.mockResolvedValue(Response.json({ data: [] }));
    await expect(svc.fetchTradeData({ ...params, classificationCode: 'H0' })).rejects.toMatchObject(
      { data: { reason: 'keyless_hs_edition_unsupported' } },
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('retains each reporter and commodity when selecting bilateral aggregate rows', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        data: [
          { ...row, partnerCode: 156, cmdCode: '84' },
          { ...row, partnerCode: 156, cmdCode: '84', motCode: 100, primaryValue: 100 },
          { ...row, reporterCode: 276, partnerCode: 156, cmdCode: '84' },
          { ...row, partnerCode: 156, cmdCode: '87' },
        ],
      }),
    );
    const result = await finish(
      svc.fetchTradeData({
        ...params,
        reporterCode: [842, 276],
        partnerCode: 156,
        cmdCode: '84,87',
      }),
    );
    expect(result.records.map((r) => [r.reporterCode, r.cmdCode, r.primaryValue])).toEqual([
      [842, '84', 10],
      [276, '84', 10],
      [842, '87', 10],
    ]);
  });
  it('does not collapse reporters in all-partner single-commodity data', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ data: [{ ...row }, { ...row, reporterCode: 276 }] }),
    );
    expect(
      (await finish(svc.fetchTradeData({ ...params, reporterCode: [842, 276] }))).records.map(
        (r) => r.reporterCode,
      ),
    ).toEqual([842, 276]);
  });
  it('retains historical classification, lowercase level and quantity uncertainty', async () => {
    fetchMock.mockImplementation(async (url) =>
      String(url).endsWith('H0.json')
        ? Response.json({ results: [{ id: '8524', text: 'Recorded media', aggrlevel: 4 }] })
        : String(url).endsWith('QuantityUnits.json')
          ? Response.json({
              results: [
                { qtyCode: 8, qtyAbbr: 'kg', qtyDescription: 'Weight' },
                { qtyCode: -1, qtyAbbr: 'N/A', qtyDescription: 'Not available' },
              ],
            })
          : Response.json({
              data: [
                {
                  ...row,
                  classificationCode: 'H0',
                  cmdCode: '8524',
                  aggrlevel: 4,
                  qty: 0,
                  qtyUnitCode: 8,
                  altQty: 0,
                  altQtyUnitCode: -1,
                  isQtyEstimated: false,
                  isNetWgtEstimated: true,
                },
              ],
            }),
    );
    const result = await finish(svc.fetchTradeData({ ...params, partnerCode: 0 }));
    expect(result.records[0]).toMatchObject({
      classificationCode: 'H0',
      cmdDesc: 'Recorded media',
      aggrLevel: 4,
      qty: 0,
      qtyUnitCode: 8,
      qtyUnitAbbr: 'kg',
      altQtyUnitCode: -1,
      altQtyUnitAbbr: 'N/A',
      isQtyEstimated: false,
      isNetWgtEstimated: true,
    });
    // UN Comtrade's 0 beside unit -1 is "not reported", not a measured zero.
    expect(result.records[0]).not.toHaveProperty('altQty');
  });
  it('omits zero quantity and weight placeholders, keeping zeros in real units and flags', async () => {
    const units = { qtyUnitAbbr: 'kg', altQtyUnitAbbr: 'N/A' };
    fetchMock.mockImplementation(async () =>
      Response.json({
        data: [
          {
            // Viet Nam 2023 coffee exports: a measured quantity beside placeholders.
            ...row,
            cmdCode: '0901',
            primaryValue: 3_183_873_274.422,
            qty: 1_077_072_475.819,
            qtyUnitCode: 8,
            netWgt: 1_077_072_475.819,
            grossWgt: 0,
            altQty: 0,
            altQtyUnitCode: -1,
            isQtyEstimated: true,
            isNetWgtEstimated: true,
            ...units,
          },
          {
            // A TOTAL row: every quantity and weight is a placeholder.
            ...row,
            qty: 0,
            qtyUnitCode: -1,
            altQty: 0,
            altQtyUnitCode: -1,
            netWgt: 0,
            grossWgt: 0,
            isQtyEstimated: false,
            isNetWgtEstimated: true,
            qtyUnitAbbr: 'N/A',
            altQtyUnitAbbr: 'N/A',
          },
          // Zero weights without a positive value, and zero quantities in real units, stay.
          { ...row, cmdCode: '01', primaryValue: 0, netWgt: 0, grossWgt: 0 },
          { ...row, cmdCode: '02', primaryValue: null, netWgt: 0 },
          { ...row, cmdCode: '03', qty: 0, qtyUnitCode: 5, altQty: 0, altQtyUnitCode: 8, ...units },
        ],
      }),
    );
    const [coffee, total, noValue, nullValue, realUnits] = (
      await finish(svc.fetchTradeData({ ...params, partnerCode: 0, cmdCode: '0901,01,02,03' }))
    ).records;
    expect(coffee).toMatchObject({
      qty: 1_077_072_475.819,
      netWgt: 1_077_072_475.819,
      altQtyUnitCode: -1,
      isQtyEstimated: true,
      isNetWgtEstimated: true,
    });
    expect(coffee).not.toHaveProperty('altQty');
    expect(coffee).not.toHaveProperty('grossWgt');
    expect(total).toMatchObject({
      qtyUnitCode: -1,
      isQtyEstimated: false,
      isNetWgtEstimated: true,
    });
    for (const field of ['qty', 'altQty', 'netWgt', 'grossWgt'])
      expect(total).not.toHaveProperty(field);
    expect(noValue).toMatchObject({ primaryValue: 0, netWgt: 0, grossWgt: 0 });
    expect(nullValue).toMatchObject({ netWgt: 0 });
    expect(realUnits).toMatchObject({ qty: 0, qtyUnitCode: 5, altQty: 0, altQtyUnitCode: 8 });
  });
  it('omits zero CIF and FOB placeholders beside a positive value, keeping other zeros', async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({
        data: [
          {
            // USA 2018 exports to China (H5): CIF sent as 0 beside the FOB value.
            ...row,
            flowCode: 'X',
            primaryValue: 120_147_865_723,
            fobvalue: 120_147_865_723,
            cifvalue: 0,
          },
          { ...row, cmdCode: '01', flowCode: 'M', primaryValue: 55, cifvalue: 55, fobvalue: 0 },
          // Zero valuations on a row without a positive value stay.
          { ...row, cmdCode: '02', primaryValue: 0, fobvalue: 0, cifvalue: 0 },
        ],
      }),
    );
    const [exportTotal, imports, noValue] = (
      await finish(svc.fetchTradeData({ ...params, partnerCode: 0, cmdCode: 'TOTAL,01,02' }))
    ).records;
    expect(exportTotal).toMatchObject({ fobvalue: 120_147_865_723 });
    expect(exportTotal).not.toHaveProperty('cifvalue');
    expect(imports).toMatchObject({ cifvalue: 55 });
    expect(imports).not.toHaveProperty('fobvalue');
    expect(noValue).toMatchObject({ primaryValue: 0, fobvalue: 0, cifvalue: 0 });
  });
  it.each([
    [true, true],
    [false, false],
    [null, undefined],
    [undefined, undefined],
  ])('relays isOriginalClassification %s as %s', async (upstream, relayed) => {
    fetchMock.mockImplementation(async () =>
      Response.json({ data: [{ ...row, isOriginalClassification: upstream }] }),
    );
    const [record] = (await finish(svc.fetchTradeData({ ...params, partnerCode: 0 }))).records;
    if (relayed === undefined) expect(record).not.toHaveProperty('isOriginalClassification');
    else expect(record).toMatchObject({ isOriginalClassification: relayed });
  });
  it('rejects malformed envelopes rather than disguising them as empty data', async () => {
    fetchMock.mockResolvedValue(Response.json({ message: 'unexpected' }));
    await expect(finish(svc.fetchTradeData(params))).rejects.toMatchObject({
      data: { reason: 'invalid_upstream_response' },
    });
  });
  it('relays known upstream validation detail without exposing raw payload fields', async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        {
          error: 'Invalid parameter value',
          details: [{ memberNames: ['period'], errorMessage: 'The field period is invalid' }],
          secret: 'private-token',
        },
        { status: 400 },
      ),
    );
    let failure: unknown;
    try {
      await finish(svc.fetchTradeData(params));
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: -32602,
      message: expect.stringContaining('The field period is invalid'),
      data: { reason: 'upstream_validation', recovery: { hint: expect.any(String) } },
    });
    expect(JSON.stringify(failure)).not.toContain('private-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([
    [
      {
        details: [
          { memberNames: ['reporterCode'], errorMessage: 'The field reporterCode is invalid' },
        ],
      },
      'The field reporterCode is invalid.',
    ],
    [
      {
        error: 'For annual frequency, all periods must be in YYYY format.',
        details: [{ memberNames: ['period'], errorMessage: 'The field period is invalid' }],
      },
      'For annual frequency, all periods must be in YYYY format. The field period is invalid.',
    ],
  ])('ends each relayed validation detail with exactly one period (%#)', async (body, detail) => {
    fetchMock.mockImplementation(async () => Response.json(body, { status: 400 }));
    await expect(finish(svc.fetchTradeData(params))).rejects.toMatchObject({
      message: `UN Comtrade rejected the request. ${detail} Verify reporter, period, classification and commodity filters.`,
      data: { reason: 'upstream_validation', upstreamDetail: detail },
    });
  });
  it('omits absent reporter filter and deduplicates array query identities', async () => {
    fetchMock.mockImplementation(async () => Response.json({ data: [row] }));
    await finish(svc.fetchTradeData({ flowCode: 'X', period: '2022', partnerCode: 0 }));
    expect(new URL(String(fetchMock.mock.calls[0]![0])).searchParams.has('reporterCode')).toBe(
      false,
    );
    await finish(svc.fetchTradeData({ ...params, reporterCode: [842, 842, 276], partnerCode: 0 }));
    expect(new URL(String(fetchMock.mock.calls[1]![0])).searchParams.get('reporterCode')).toBe(
      '842,276',
    );
  });
  it('never manufactures reporter identity from an array or omitted filter', async () => {
    const { reporterCode: _reporterCode, ...withoutReporter } = row;
    fetchMock.mockResolvedValue(Response.json({ data: [withoutReporter] }));
    await expect(
      finish(svc.fetchTradeData({ ...params, reporterCode: [842, 276], partnerCode: 0 })),
    ).rejects.toMatchObject({ data: { reason: 'invalid_upstream_response' } });
  });
  it('retains upstream labels and unknown unit codes without reference fetches', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        data: [
          {
            ...row,
            classificationCode: 'H0',
            cmdCode: '8524',
            cmdDesc: 'upstream',
            qtyUnitCode: 999,
            qtyUnitAbbr: 'upstream unit',
            isQtyEstimated: false,
          },
        ],
      }),
    );
    const result = await finish(svc.fetchTradeData({ ...params, partnerCode: 0 }));
    expect(result.records[0]).toMatchObject({
      cmdDesc: 'upstream',
      qtyUnitCode: 999,
      qtyUnitAbbr: 'upstream unit',
      isQtyEstimated: false,
    });
    expect(result.records[0]).not.toHaveProperty('altQty');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('degrades failed unit enrichment while preserving quantities and codes', async () => {
    fetchMock.mockImplementation(async (url) =>
      String(url).endsWith('QuantityUnits.json')
        ? new Response('missing', { status: 404 })
        : Response.json({
            data: [
              {
                ...row,
                qtyUnitCode: 999,
                qty: 0,
                altQtyUnitCode: -1,
                altQty: 0,
                isQtyEstimated: false,
              },
            ],
          }),
    );
    const result = await finish(svc.fetchTradeData({ ...params, partnerCode: 0 }));
    expect(result.records[0]).toMatchObject({
      qtyUnitCode: 999,
      qty: 0,
      altQtyUnitCode: -1,
      isQtyEstimated: false,
    });
    expect(result.records[0]).not.toHaveProperty('altQty');
    expect(result.records[0]).not.toHaveProperty('qtyUnitAbbr');
    expect(result.referenceNotice).toContain('Quantity unit references are unavailable');
  });
  it('does not label unknown HS editions from the modern startup catalog', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ data: [{ ...row, cmdCode: '8524', classificationCode: 'H9' }] }),
    );
    const result = await finish(svc.fetchTradeData({ ...params, partnerCode: 0 }));
    expect(result.records[0]).toMatchObject({
      cmdCode: '8524',
      cmdDesc: '8524',
      classificationCode: 'H9',
    });
    expect(result.referenceNotice).toContain('H9 reference descriptions are unavailable');
  });
  it('allows authenticated explicit editions without changing the requested classification', async () => {
    settings.subscriptionKey = 'test-key';
    fetchMock.mockResolvedValue(Response.json({ data: [] }));
    expect(
      (await finish(svc.fetchTradeData({ ...params, classificationCode: 'H0' }))).records,
    ).toEqual([]);
    expect(new URL(String(fetchMock.mock.calls[0]![0])).pathname).toBe('/data/v1/get/C/A/H0');
  });
});
