/**
 * @fileoverview Both-surface contracts for defaults, read caps, and coverage notices.
 * @module tests/tools/comtrade-batch-contract.test
 */
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getDataAvailabilityTool } from '@/mcp-server/tools/definitions/get-data-availability.tool.js';
import { getServicesTradeTool } from '@/mcp-server/tools/definitions/get-services-trade.tool.js';
import { getTopCommoditiesTool } from '@/mcp-server/tools/definitions/get-top-commodities.tool.js';
import { getTopPartnersTool } from '@/mcp-server/tools/definitions/get-top-partners.tool.js';
import { getTradeBalanceTool } from '@/mcp-server/tools/definitions/get-trade-balance.tool.js';
import { getTradeFlowsTool } from '@/mcp-server/tools/definitions/get-trade-flows.tool.js';
import { listServiceCategoriesTool } from '@/mcp-server/tools/definitions/list-service-categories.tool.js';
import { searchCommoditiesTool } from '@/mcp-server/tools/definitions/search-commodities.tool.js';
import {
  ComtradeDataService,
  initComtradeDataService,
  periodFailureError,
} from '@/services/comtrade-data/comtrade-data-service.js';
import {
  ComtradeMetaService,
  initComtradeMetaService,
} from '@/services/comtrade-meta/comtrade-meta-service.js';
import {
  ComtradeReferenceService,
  initComtradeReferenceService,
} from '@/services/comtrade-reference/comtrade-reference-service.js';

const config = {} as Parameters<typeof initComtradeDataService>[0];
const storage = {} as Parameters<typeof initComtradeDataService>[1];
const record = {
  reporterCode: 842,
  reporterDesc: 'United States',
  partnerCode: 0,
  partnerDesc: 'World',
  flowCode: 'X',
  cmdCode: '11',
  cmdDesc: 'Beverages',
  period: '2022',
  primaryValue: 10,
  aggrLevel: 2,
};
const periods = Array.from({ length: 13 }, (_, i) => String(2000 + i));
const codes = Array.from({ length: 21 }, (_, i) => String(i).padStart(2, '0'));
beforeEach(() => {
  initComtradeDataService(config, storage);
  initComtradeMetaService(config, storage);
  initComtradeReferenceService(config, storage);
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>().mockRejectedValue(new Error('Unexpected live fetch')),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  getTradeFlowsTool,
  getServicesTradeTool,
  getTradeBalanceTool,
  getTopPartnersTool,
  getTopCommoditiesTool,
])('$name declares upstream_unavailable as the data service throws it', (definition) => {
  const { code, data } = periodFailureError([
    { period: '2022', reason: 'upstream_unavailable', status: 503 },
  ]);
  expect(definition.errors?.find((entry) => entry.reason === 'upstream_unavailable')).toEqual(
    expect.objectContaining({
      code,
      retryable: data?.retryable,
      recovery: (data?.recovery as { hint: string } | undefined)?.hint,
      thrownBy: 'service',
    }),
  );
});

it.each([undefined, 0, 156])(
  'uses AG selectors and World default with partner %s',
  async (partner_code) => {
    // Upstream TOTAL rows without the aggregate row identify no edition, so the AG selector runs.
    const spy = vi
      .spyOn(ComtradeDataService.prototype, 'fetchTradeData')
      .mockResolvedValue({ records: [], totalCount: 2, truncated: false });
    await getTopCommoditiesTool.handler(
      getTopCommoditiesTool.input.parse({
        reporter_code: 842,
        flow_code: 'X',
        period: '2022',
        aggr_level: 4,
        partner_code,
      }),
      createMockContext(),
    );
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ cmdCode: 'AG4', partnerCode: partner_code ?? 0 }),
      expect.anything(),
      expect.any(Number),
    );
    expect(spy.mock.calls[0]![0]).not.toHaveProperty('aggrLevel');
  },
);
it('keeps preview cap disclosure in every empty record/ranking surface', async () => {
  vi.spyOn(ComtradeDataService.prototype, 'fetchTradeData').mockResolvedValue({
    records: [],
    totalCount: 500,
    truncated: true,
    truncationHint: 'may be incomplete',
  });
  const runs = [
    await runToolContract(getTradeFlowsTool, {
      reporter_code: 842,
      flow_code: 'X',
      period: ['2022'],
    }),
    await runToolContract(getServicesTradeTool, {
      reporter_code: 842,
      flow_code: 'X',
      period: ['2022'],
    }),
    await runToolContract(getTopPartnersTool, {
      reporter_code: 842,
      flow_code: 'X',
      period: '2022',
    }),
    await runToolContract(getTopCommoditiesTool, {
      reporter_code: 842,
      flow_code: 'X',
      period: '2022',
    }),
  ];
  for (const result of runs) {
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ truncated: true });
    expect(JSON.stringify(result.content)).toMatch(/incomplete|truncated/i);
  }
});
it('capped empty balance explains uncertainty in its no_data error', async () => {
  vi.spyOn(ComtradeDataService.prototype, 'fetchTradeData').mockResolvedValue({
    records: [],
    totalCount: 500,
    truncated: true,
  });
  const result = await runToolContract(getTradeBalanceTool, {
    reporter_code: 842,
    period: ['2022'],
  });
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    error: { data: { reason: 'no_data', truncated: true } },
  });
  expect(JSON.stringify(result.content)).toContain('may be incomplete');
});
it.each(['S1', 'S2', 'S3', 'S4', 'SS'])(
  'balance forwards goods %s and discloses capped/reference results',
  async (classification) => {
    const spy = vi.spyOn(ComtradeDataService.prototype, 'fetchTradeData').mockResolvedValue({
      records: [record],
      totalCount: 500,
      truncated: true,
      referenceNotice: 'Reference descriptions unavailable',
    });
    const result = await runToolContract(getTradeBalanceTool, {
      reporter_code: 842,
      period: ['2022'],
      classification,
    });
    // Both flows share one deadline (epoch ms) passed as the third argument.
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ classificationCode: classification, typeCode: 'C' }),
      expect.anything(),
      expect.any(Number),
    );
    expect(spy.mock.calls[0]![2]).toBe(spy.mock.calls[1]![2]);
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.structuredContent)).toContain('may be incomplete');
    expect(JSON.stringify(result.content)).toContain('may be incomplete');
    expect(JSON.stringify(result.structuredContent)).toContain(
      'Reference descriptions unavailable',
    );
    expect(JSON.stringify(result.content)).toContain('Reference descriptions unavailable');
  },
);
it('SITC flows preserve levels without HS labels and disclose reference failure on both surfaces', async () => {
  vi.spyOn(ComtradeDataService.prototype, 'fetchTradeData').mockResolvedValue({
    records: [record],
    totalCount: 1,
    truncated: false,
    referenceNotice: 'Reference descriptions unavailable',
  });
  const result = await runToolContract(getTradeFlowsTool, {
    reporter_code: 842,
    flow_code: 'X',
    period: ['2022'],
    classification: 'S4',
  });
  expect(result.structuredContent).toMatchObject({
    records: [expect.objectContaining({ aggrLevel: 2, primaryValue: 10 })],
  });
  expect(JSON.stringify(result.content)).toContain('aggregation level 2');
  expect(JSON.stringify(result.content)).not.toContain('HS-');
  for (const surface of [result.structuredContent, result.content])
    expect(JSON.stringify(surface)).toContain('Reference descriptions unavailable');
});
it('bounded arrays serve their caps and name unserved inputs on both surfaces', async () => {
  const spy = vi
    .spyOn(ComtradeDataService.prototype, 'fetchTradeData')
    .mockResolvedValue({ records: [record], totalCount: 1, truncated: false });
  const runs = [
    await runToolContract(getTradeFlowsTool, {
      reporter_code: 842,
      flow_code: 'X',
      period: periods,
      cmd_code: codes,
    }),
    await runToolContract(getTradeBalanceTool, {
      reporter_code: 842,
      period: periods,
      cmd_code: codes,
    }),
    await runToolContract(getServicesTradeTool, {
      reporter_code: 842,
      flow_code: 'X',
      period: periods,
    }),
  ];
  // Keyless: flows and services serve 8 periods (one request each), balance 4 (two each).
  for (const [result, served] of [
    [runs[0]!, 8],
    [runs[1]!, 4],
    [runs[2]!, 8],
  ] as const) {
    const unserved = periods.slice(served);
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining(
            `**Unserved periods:** ${unserved.join(', ')}. Query them separately.`,
          ),
        }),
      ]),
    );
    expect(result.structuredContent).toMatchObject({ unservedPeriods: unserved });
  }
  for (const result of runs.slice(0, 2)) {
    expect(result.structuredContent).toMatchObject({ unservedCmdCodes: ['20'] });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('**Unserved commodity codes:** 20. Query them separately.'),
        }),
      ]),
    );
  }
  expect(spy.mock.calls.map(([params]) => params.period.split(',').length)).toEqual([8, 4, 4, 8]);
  for (const [params] of spy.mock.calls)
    if (params.cmdCode) expect(params.cmdCode.split(',')).toHaveLength(20);
});
it('authenticated access serves 12 periods for every period-batching tool', async () => {
  const spy = vi.spyOn(ComtradeDataService.prototype, 'periodsPerCall').mockReturnValue(12);
  const fetchSpy = vi
    .spyOn(ComtradeDataService.prototype, 'fetchTradeData')
    .mockResolvedValue({ records: [record], totalCount: 1, truncated: false });
  for (const [tool, args] of [
    [getTradeFlowsTool, { reporter_code: 842, flow_code: 'X', period: periods }],
    [getTradeBalanceTool, { reporter_code: 842, period: periods }],
    [getServicesTradeTool, { reporter_code: 842, flow_code: 'X', period: periods }],
  ] as const) {
    const result = await runToolContract(tool, args);
    expect(result.structuredContent).toMatchObject({ unservedPeriods: ['2012'] });
  }
  expect(spy).toHaveBeenCalled();
  for (const [params] of fetchSpy.mock.calls) expect(params.period.split(',')).toHaveLength(12);
});
it.each([
  ['C', undefined, 'HS'],
  ['S', undefined, 'EB10'],
  ['S', '', 'EB10'],
  ['S', 'EB02', 'EB02'],
] as const)('availability forwards %s/%s as %s', async (type_code, classification, expected) => {
  const spy = vi.spyOn(ComtradeMetaService.prototype, 'getDataAvailability').mockResolvedValue([
    {
      reporterCode: 842,
      reporterDesc: 'United States',
      period: '2022',
      freqCode: 'A',
      typeCode: type_code,
      classificationCode: expected,
      firstReleased: '2023-03-09T19:23:39.45',
      lastReleased: '2024-04-01T08:12:00',
    },
  ]);
  const result = await runToolContract(getDataAvailabilityTool, { type_code, classification });
  expect(spy).toHaveBeenCalledWith(
    expect.objectContaining({ classificationCode: expected }),
    expect.anything(),
  );
  expect(result.structuredContent).toMatchObject({
    datasets: [
      expect.objectContaining({
        firstReleased: '2023-03-09T19:23:39.45',
        lastReleased: '2024-04-01T08:12:00',
      }),
    ],
  });
  for (const surface of [result.structuredContent, result.content]) {
    expect(JSON.stringify(surface)).toContain('2023-03-09T19:23:39.45');
    expect(JSON.stringify(surface)).toContain('2024-04-01T08:12:00');
    expect(JSON.stringify(surface)).not.toContain('publicationDate');
  }
});
it('catalog searches serve oversized limits as exact pages that continue by nextOffset', async () => {
  vi.spyOn(ComtradeReferenceService.prototype, 'searchHsCodes').mockReturnValue(
    Array.from({ length: 220 }, (_, i) => ({
      id: String(i),
      text: 'test',
      aggrLevel: 2,
      isLeaf: false,
      recommendedQueryCode: String(i),
    })),
  );
  vi.spyOn(ComtradeReferenceService.prototype, 'getServiceCategories').mockResolvedValue({
    status: 'tagged',
    categories: Array.from({ length: 520 }, (_, i) => ({
      id: String(i),
      text: 'test',
      schemes: [],
    })),
  });
  type Page = { limit: number; offset?: number };
  for (const [run, key, total, limit] of [
    [
      (page: Page) => runToolContract(searchCommoditiesTool, { query: 'test', ...page }),
      'matches',
      220,
      201,
    ],
    [(page: Page) => runToolContract(listServiceCategoriesTool, page), 'categories', 520, 501],
  ] as const) {
    const first = await run({ limit });
    const second = await run({ limit, offset: limit });
    expect(first.structuredContent).toMatchObject({
      totalMatches: total,
      shown: limit,
      truncated: true,
      offset: 0,
      nextOffset: limit,
    });
    expect(second.structuredContent).toMatchObject({
      totalMatches: total,
      shown: total - limit,
      offset: limit,
    });
    expect(second.structuredContent).not.toHaveProperty('nextOffset');
    const ids = [first, second].flatMap((result) =>
      (result.structuredContent as Record<typeof key, { id: string }[]>)[key].map(
        (entry) => entry.id,
      ),
    );
    expect(ids).toEqual(Array.from({ length: total }, (_, i) => String(i)));
    expect(JSON.stringify(first.content)).toContain(`**${limit - 1}** — test`);
    expect(JSON.stringify(first.content)).not.toContain(`**${limit}** — test`);
    expect(JSON.stringify(first.content)).toContain(`offset=${limit}`);
    expect(JSON.stringify(second.content)).toContain(`**${total - 1}** — test`);
    for (const result of [first, second]) expect(result.isError).not.toBe(true);
  }
});
it('rejects atomic-invalid empty periods and absurd arrays before work', async () => {
  const spy = vi.spyOn(ComtradeDataService.prototype, 'fetchTradeData');
  for (const period of [[], Array(121).fill('2022')]) {
    const result = await runToolContract(getTradeFlowsTool, {
      reporter_code: 842,
      flow_code: 'X',
      period,
    });
    expect(result.isError).toBe(true);
  }
  expect(spy).not.toHaveBeenCalled();
  expect(searchCommoditiesTool.input.safeParse({ query: 'test', limit: 0 }).success).toBe(false);
});
