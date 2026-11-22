/** tests/tools/trade-page.test.ts — goods and services paging contract and clamp telemetry. */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as serverConfig from '@/config/server-config.js';
import { getServicesTradeTool } from '@/mcp-server/tools/definitions/get-services-trade.tool.js';
import { getTradeFlowsTool } from '@/mcp-server/tools/definitions/get-trade-flows.tool.js';
import {
  ComtradeDataService,
  getComtradeDataService,
  initComtradeDataService,
} from '@/services/comtrade-data/comtrade-data-service.js';
import { initComtradeReferenceService } from '@/services/comtrade-reference/comtrade-reference-service.js';
import { readTradeTable } from '../fixtures/read-trade-table.js';

const { add } = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  createCounter: () => ({ add }),
}));

const config = {} as Parameters<typeof initComtradeDataService>[0];
const storage = {} as Parameters<typeof initComtradeDataService>[1];
const args = { reporter_code: 842, flow_code: 'X', period: ['2023'] } as const;
const record = {
  reporterCode: 842,
  reporterDesc: 'United States',
  partnerCode: 276,
  partnerDesc: 'Germany',
  cmdCode: '01',
  cmdDesc: 'A | B\n`second line` \\ <unit>',
  period: '2023',
  flowCode: 'X',
  primaryValue: 0,
  isReported: false,
};

function textOf(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return (result.content ?? []).map((block) => (block as { text: string }).text).join('\n');
}

beforeEach(() => {
  initComtradeDataService(config, storage);
  initComtradeReferenceService(config, storage);
  add.mockClear();
});

afterEach(() => {
  getComtradeDataService().dispose();
  vi.restoreAllMocks();
});

describe.each([getTradeFlowsTool, getServicesTradeTool])('$name', (tool) => {
  it('walks reordered rows through tie breaks and stops at the normalized count', async () => {
    const tied = { ...record, primaryValue: 1 };
    const world = { ...record, partnerCode: 0, partnerDesc: 'World' };
    const expected = [world, record, tied];
    const spy = vi.spyOn(ComtradeDataService.prototype, 'fetchTradeData');
    let offset = 0;
    for (const [index, reordering] of [
      [tied, world, record],
      [tied, record, world],
      [record, world, tied],
    ].entries()) {
      spy.mockResolvedValueOnce({ records: reordering, totalCount: 500, truncated: true });
      const result = await runToolContract(tool, { ...args, period: ['2023'], limit: 1, offset });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        records: [expected[index]],
        offset,
        shown: 1,
        totalCount: 500,
        truncated: true,
      });
      const text = textOf(result);
      expect(readTradeTable(text)).toEqual([expected[index]]);
      expect(text).toContain('Upstream truncated:** true');
      expect(text).toContain('World');
      const next = result.structuredContent?.nextOffset;
      if (index < 2) {
        expect(next).toBe(index + 1);
        expect(text).toContain(`offset=${index + 1}`);
        offset = Number(next);
      } else {
        expect(result.structuredContent).not.toHaveProperty('nextOffset');
        expect(text).not.toContain('Continue with');
      }
    }
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('returns the default page, clamps larger requests, and discloses it on both surfaces', async () => {
    const rows = Array.from({ length: 1_001 }, (_, partnerCode) => ({ ...record, partnerCode }));
    vi.spyOn(ComtradeDataService.prototype, 'fetchTradeData').mockResolvedValue({
      records: rows,
      totalCount: rows.length,
      truncated: false,
    });
    const initial = await runToolContract(tool, { ...args, period: ['2023'] });
    expect(initial.structuredContent).toMatchObject({ shown: 25, offset: 0, nextOffset: 25 });
    expect(readTradeTable(textOf(initial))).toHaveLength(25);
    expect(add).not.toHaveBeenCalled();

    const clamped = await runToolContract(tool, { ...args, period: ['2023'], limit: 1_001 });
    expect(clamped.structuredContent).toMatchObject({
      shown: 1_000,
      nextOffset: 1_000,
      truncated: false,
      limitClamp: { requested: 1_001, applied: 1_000 },
    });
    expect(readTradeTable(textOf(clamped))).toHaveLength(1_000);
    expect(textOf(clamped)).toContain('Requested limit 1001 was reduced to 1000.');
    expect(add).toHaveBeenCalledExactlyOnceWith(1, { 'mcp.tool.name': tool.name });
  });

  it('distinguishes past-end pages from empty results', async () => {
    const spy = vi.spyOn(ComtradeDataService.prototype, 'fetchTradeData');
    spy.mockResolvedValueOnce({
      records: [record, { ...record, partnerCode: 0 }],
      totalCount: 10,
      truncated: false,
    });
    spy.mockResolvedValueOnce({ records: [], totalCount: 0, truncated: false });
    const past = await runToolContract(tool, { ...args, period: ['2023'], offset: 2 });
    expect(past.structuredContent).toMatchObject({
      records: [],
      shown: 0,
      offset: 2,
      totalCount: 10,
      notice: expect.stringContaining('The largest offset that returns a row is 1.'),
    });
    expect(past.structuredContent).not.toHaveProperty('nextOffset');
    expect(textOf(past)).toContain('The largest offset that returns a row is 1.');
    expect(textOf(past)).toContain('World');
    const empty = await runToolContract(tool, { ...args, period: ['2023'], offset: 2 });
    expect(empty.structuredContent?.notice).toMatch(/No .*records found/);
    expect(textOf(empty)).toContain(String(empty.structuredContent?.notice));
    expect(textOf(empty)).not.toContain('past the end');
  });

  it('validates paging inputs and advertises the enforced strict maximum', async () => {
    const spy = vi.spyOn(ComtradeDataService.prototype, 'fetchTradeData');
    const advertisedLimit = () => z.toJSONSchema(tool.input, { io: 'input' }).properties?.limit;
    expect(advertisedLimit()).toMatchObject({ type: 'integer', minimum: 1, default: 25 });
    expect(advertisedLimit()).not.toHaveProperty('maximum', expect.any(Number));
    vi.spyOn(serverConfig, 'clampTradeLimits').mockReturnValue(false);
    expect(advertisedLimit()).toMatchObject({ maximum: 1_000 });
    expect(tool.input.safeParse({ ...args, limit: 1_000 }).success).toBe(true);
    for (const invalid of [
      { limit: 0 },
      { limit: 1.5 },
      { limit: 1_001 },
      { offset: -1 },
      { offset: 0.5 },
    ]) {
      const result = await runToolContract(tool, { ...args, period: ['2023'], ...invalid });
      expect(result.isError).toBe(true);
      const field = Object.keys(invalid)[0];
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.InvalidParams,
          data: { reason: 'invalid_arguments', recovery: { hint: expect.stringContaining(field) } },
        },
      });
      expect(textOf(result)).toContain(field);
    }
    expect(spy).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });
});

it('logs a clamp once and bypasses the clamp and fetch when already cancelled', async () => {
  const fetch = vi.spyOn(ComtradeDataService.prototype, 'fetchTradeData').mockResolvedValue({
    records: [],
    totalCount: 0,
    truncated: false,
  });
  const controller = new AbortController();
  const ctx = createMockContext({ errors: getTradeFlowsTool.errors, signal: controller.signal });
  const info = vi.spyOn(ctx.log, 'info');
  const input = getTradeFlowsTool.input.parse({ ...args, limit: 1_001 });
  await getTradeFlowsTool.handler(input, ctx);
  expect(info.mock.calls.filter(([message]) => message === 'Trade page limit clamped')).toEqual([
    ['Trade page limit clamped', { requested: 1_001, applied: 1_000 }],
  ]);
  expect(getEnrichment(ctx).limitClamp).toEqual({ requested: 1_001, applied: 1_000 });
  controller.abort();
  await expect(getTradeFlowsTool.handler(input, ctx)).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(add).toHaveBeenCalledTimes(1);
});
