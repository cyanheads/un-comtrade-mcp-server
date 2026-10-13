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
    expect(starts.slice(1).every((start, i) => start - starts[i]! >= 1000)).toBe(true);
    for (const result of results) {
      expect(result.records.map((r) => r.period)).toEqual(['2022', '2023']);
      expect(result.totalCount).toBe(600);
      expect(result.truncated).toBe(false);
    }
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
      fetchMock.mockImplementation(async (url) =>
        String(url).endsWith('HS.json')
          ? Response.json({
              results: [{ id: '11', text: '11 - Products of the milling industry' }],
            })
          : String(url).endsWith(`${classificationCode}.json`)
            ? Response.json({ results: [{ id: '11', text: '11 - Beverages' }] })
            : String(url).endsWith('.json')
              ? Response.json({ results: [] })
              : Response.json({
                  data: [
                    { ...row, cmdCode: '11' },
                    { ...row, cmdCode: 'unknown' },
                    { ...row, cmdCode: '12', cmdDesc: 'upstream' },
                  ],
                }),
      );
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
    ).rejects.toMatchObject({ code: -32602 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(1000);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(1000);
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
  it('handles all 24 balance preview slices with one-second minimum start gaps', async () => {
    const starts: number[] = [];
    fetchMock.mockImplementation(async (url) => {
      starts.push(Date.now());
      return Response.json({
        data: [{ ...row, period: new URL(String(url)).searchParams.get('period') }],
      });
    });
    const periods = Array.from({ length: 12 }, (_, i) => String(2000 + i)).join(',');
    const results = await finish(
      Promise.all(
        ['X', 'M'].map((flowCode) =>
          svc.fetchTradeData({ ...params, flowCode: flowCode as 'X' | 'M', period: periods }),
        ),
      ),
    );
    expect(results.map((r) => r.records.length)).toEqual([12, 12]);
    expect(starts).toHaveLength(24);
    expect(starts.at(-1)! - starts[0]!).toBe(23000);
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
});
