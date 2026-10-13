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
const codes = Array.from({ length: 21 }, (_, i) => String(i));
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

it.each([undefined, 0, 156])(
  'uses AG selectors and World default with partner %s',
  async (partner_code) => {
    const spy = vi
      .spyOn(ComtradeDataService.prototype, 'fetchTradeData')
      .mockResolvedValue({ records: [], totalCount: 0, truncated: false });
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
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ classificationCode: classification, typeCode: 'C' }),
      expect.anything(),
    );
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
  for (const result of runs) {
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('**Unserved periods:** 2012. Query them separately.'),
        }),
      ]),
    );
    expect(result.structuredContent).toMatchObject({ unservedPeriods: ['2012'] });
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
  for (const [params] of spy.mock.calls) {
    expect(params.period.split(',')).toHaveLength(12);
    if (params.cmdCode) expect(params.cmdCode.split(',')).toHaveLength(20);
  }
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
it('output-only oversized limits return all matches and rankings', async () => {
  vi.spyOn(ComtradeDataService.prototype, 'fetchTradeData').mockResolvedValue({
    records: Array.from({ length: 60 }, (_, i) => ({
      ...record,
      partnerCode: i + 1,
      cmdCode: String(i + 10),
    })),
    totalCount: 60,
    truncated: false,
  });
  vi.spyOn(ComtradeReferenceService.prototype, 'searchHsCodes').mockReturnValue(
    Array.from({ length: 220 }, (_, i) => ({
      id: String(i),
      text: 'test',
      aggrLevel: 2,
      isLeaf: false,
      recommendedQueryCode: String(i),
    })),
  );
  vi.spyOn(ComtradeReferenceService.prototype, 'getAllEbopsCategories').mockReturnValue(
    Array.from({ length: 520 }, (_, i) => ({ id: String(i), text: 'test' })),
  );
  const partners = await runToolContract(getTopPartnersTool, {
    reporter_code: 842,
    flow_code: 'X',
    period: '2022',
    limit: 51,
  });
  const commodities = await runToolContract(getTopCommoditiesTool, {
    reporter_code: 842,
    flow_code: 'X',
    period: '2022',
    limit: 51,
  });
  const hs = await runToolContract(searchCommoditiesTool, { query: 'test', limit: 201 });
  const services = await runToolContract(listServiceCategoriesTool, { limit: 501 });
  expect(partners.structuredContent).toMatchObject({
    partners: expect.arrayContaining([expect.objectContaining({ rank: 60 })]),
  });
  expect(commodities.structuredContent).toMatchObject({
    commodities: expect.arrayContaining([expect.objectContaining({ rank: 60 })]),
  });
  expect(hs.structuredContent).toMatchObject({ shown: 220, truncated: false });
  expect(services.structuredContent).toMatchObject({ shown: 520, truncated: false });
  expect(JSON.stringify(partners.content)).toContain('**#60.');
  expect(JSON.stringify(commodities.content)).toContain('**#60.');
  expect(JSON.stringify(hs.content)).toContain('**219** — test');
  expect(JSON.stringify(services.content)).toContain('**519** — test');
  for (const result of [partners, commodities, hs, services]) expect(result.isError).not.toBe(true);
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
