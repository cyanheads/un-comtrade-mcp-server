/**
 * @fileoverview Input grammar and tool wiring contracts.
 * @module tests/tools/comtrade-input-contract.test
 */
import { z } from '@cyanheads/mcp-ts-core';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  annualPeriodSchema,
  codeSchema,
  flowSchema,
  frequencySchema,
  goodsClassificationSchema,
  periodSchema,
  periodsMatchFrequency,
  resolveFrequency,
  servicesClassificationSchema,
} from '@/mcp-server/tools/comtrade-input.js';
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
import { initComtradeReferenceService } from '@/services/comtrade-reference/comtrade-reference-service.js';

beforeEach(() => {
  initComtradeDataService(
    {} as Parameters<typeof initComtradeDataService>[0],
    {} as Parameters<typeof initComtradeDataService>[1],
  );
  // Empty results read reporter status; an unloaded index classifies every code as unknown.
  initComtradeReferenceService(
    {} as Parameters<typeof initComtradeReferenceService>[0],
    {} as Parameters<typeof initComtradeReferenceService>[1],
  );
});
afterEach(() => vi.restoreAllMocks());

it('characterizes scalar reporters, annual defaults, and World requests', async () => {
  const spy = vi
    .spyOn(ComtradeDataService.prototype, 'fetchTradeData')
    .mockResolvedValue({ records: [], totalCount: 0, truncated: false });
  await getTradeFlowsTool.handler(
    getTradeFlowsTool.input.parse({
      reporter_code: 842,
      flow_code: 'M',
      period: ['2022'],
      partner_code: 0,
    }),
    createMockContext(),
  );
  expect(spy).toHaveBeenCalledWith(
    expect.objectContaining({ reporterCode: 842, partnerCode: 0, freqCode: 'A', cmdCode: 'TOTAL' }),
    expect.anything(),
  );
});

it('normalizes supported casing and blank goods selectors before requesting', async () => {
  const spy = vi
    .spyOn(ComtradeDataService.prototype, 'fetchTradeData')
    .mockResolvedValue({ records: [], totalCount: 0, truncated: false });
  await getTradeFlowsTool.handler(
    getTradeFlowsTool.input.parse({
      reporter_code: 842,
      flow_code: ' m ',
      period: [' 202503 '],
      freq: ' m ',
      classification: ' s4 ',
      cmd_code: [' ', ' ag2 ', ' total '],
    }),
    createMockContext(),
  );
  expect(spy).toHaveBeenCalledWith(
    expect.objectContaining({
      flowCode: 'M',
      period: '202503',
      freqCode: 'M',
      classificationCode: 'S4',
      cmdCode: 'AG2,TOTAL',
    }),
    expect.anything(),
  );
});

it('infers monthly partner requests', async () => {
  const spy = vi.spyOn(ComtradeDataService.prototype, 'fetchTradeData').mockResolvedValue({
    records: [
      {
        reporterCode: 842,
        reporterDesc: 'USA',
        partnerCode: 156,
        partnerDesc: 'China',
        flowCode: 'M',
        cmdCode: 'TOTAL',
        cmdDesc: 'Total',
        period: '202503',
        primaryValue: 1,
      },
    ],
    totalCount: 1,
    truncated: false,
  });
  await getTopPartnersTool.handler(
    getTopPartnersTool.input.parse({ reporter_code: 842, flow_code: 'M', period: '202503' }),
    createMockContext(),
  );
  expect(spy).toHaveBeenCalledWith(expect.objectContaining({ freqCode: 'M' }), expect.anything());
});

it.each(['202500', '202513', '2025-03', '2025031'])(
  'rejects invalid calendar period %s',
  (period) => {
    expect(
      getTopPartnersTool.input.safeParse({ reporter_code: 842, flow_code: 'M', period }).success,
    ).toBe(false);
  },
);
it('rejects period/frequency disagreement and monthly services before work', () => {
  for (const args of [
    { period: ['2023', '202503'] },
    { period: ['2023', '202503'], freq: 'M' },
    { period: ['202503'], freq: 'A' },
  ])
    expect(
      getTradeFlowsTool.input.safeParse({ reporter_code: 842, flow_code: 'M', ...args }).success,
    ).toBe(false);
  expect(
    getServicesTradeTool.input.safeParse({ reporter_code: 842, flow_code: 'M', period: ['202503'] })
      .success,
  ).toBe(false);
});
it.each([
  [{}, 'A', true],
  [{ freq: 'M' }, 'M', true],
  [{ period: '2024' }, 'A', true],
  [{ period: '202401' }, 'M', true],
  [{ period: ['2022', '2023'] }, 'A', true],
  [{ period: ['202401', '202402'] }, 'M', true],
  [{ period: ['2023', '202401'] }, 'A', false],
  [{ period: ['202401', '2023'] }, 'M', false],
  [{ period: ['2023', '202401'], freq: 'A' }, 'A', false],
  [{ period: ['2023', '202401'], freq: 'M' }, 'M', false],
  [{ period: ['202401'], freq: 'A' }, 'A', false],
  [{ period: '2024', freq: 'M' }, 'M', false],
  [{ period: ['202401'], freq: 'M' }, 'M', true],
] as const)('resolves frequency %j to %s, accepted: %s', (input, frequency, accepted) => {
  expect(resolveFrequency(input)).toBe(frequency);
  expect(periodsMatchFrequency(input)).toBe(accepted);
});
it('validates classification-specific goods shapes without reference membership checks', () => {
  const common = { reporter_code: 842, flow_code: 'M', period: ['2022'] };
  expect(getTradeFlowsTool.input.safeParse({ ...common, cmd_code: ['901'] }).success).toBe(false);
  expect(
    getTradeBalanceTool.input.safeParse({ reporter_code: 842, period: ['2022'], cmd_code: ['901'] })
      .success,
  ).toBe(false);
  expect(
    getTopPartnersTool.input.safeParse({
      reporter_code: 842,
      flow_code: 'M',
      period: '2022',
      cmd_code: '901',
    }).success,
  ).toBe(false);
  for (const code of ['9', '90', '901', '9012', '90123', 'TOTAL', 'AG2'])
    expect(
      getTradeFlowsTool.input.safeParse({ ...common, classification: 'S4', cmd_code: [code] })
        .success,
    ).toBe(true);
  for (const code of ['99', '9999', '999999', 'TOTAL', 'AG6'])
    expect(getTradeFlowsTool.input.safeParse({ ...common, cmd_code: [code] }).success).toBe(true);
});

it('keeps AG selectors available to trade tools but rejects them in partner rankings', () => {
  const query = { reporter_code: 842, flow_code: 'X', period: '2022', cmd_code: ' ag6 ' };
  expect(
    getTradeFlowsTool.input.parse({ ...query, period: [query.period], cmd_code: [query.cmd_code] })
      .cmd_code,
  ).toEqual(['AG6']);
  expect(getTopPartnersTool.input.safeParse(query).error?.issues[0]?.path).toEqual(['cmd_code']);
});

/** Measure repeated calls below the timer resolution, keeping the least per-call CPU cost. */
function leastCpuMicrosPerCall(run: () => void, repeats: number): number {
  let least = Infinity;
  for (let trial = 0; trial < 3; trial++) {
    const start = process.threadCpuUsage();
    for (let index = 0; index < repeats; index++) run();
    const used = process.threadCpuUsage(start);
    least = Math.min(least, (used.user + used.system) / repeats);
  }
  return least;
}

it('bounds parent-code validation CPU time for digit runs and line breaks', { timeout: 0 }, () => {
  const input = { reporter_code: 842, flow_code: 'X', period: '2022', aggr_level: 6 };
  const scenarios = [
    { shape: (size: number) => '8'.repeat(size), maxSize: 320_000 },
    { shape: (size: number) => `${'§1 x'.repeat(size / 4)}\ny`, maxSize: 80_000 },
    { shape: (size: number) => `1${'  \r\n'.repeat(size / 4)}1`, maxSize: 80_000 },
  ];
  for (const { shape, maxSize } of scenarios) {
    const callAt = (size: number) => {
      const args = { ...input, parent_code: shape(size) };
      expect(getTopCommoditiesTool.input.safeParse(args).success).toBe(false);
      return () => {
        getTopCommoditiesTool.input.safeParse(args);
      };
    };
    const baseline = callAt(5_000);
    for (let size = 10_000; size <= maxSize; size *= 2) {
      const current = callAt(size);
      const bound = (4 * size) / 5_000;
      let leastGrowth = Infinity;
      let leastMicros = Infinity;
      for (let trial = 0; trial < 3; trial++) {
        const small = leastCpuMicrosPerCall(baseline, 64);
        const large = leastCpuMicrosPerCall(current, Math.max(1, 320_000 / size));
        leastGrowth = Math.min(leastGrowth, large / small);
        leastMicros = Math.min(leastMicros, large);
      }
      expect(leastGrowth, `CPU growth at ${size} characters`).toBeLessThan(bound);
      expect(leastMicros, `CPU time at ${size} characters`).toBeLessThan(50_000);
    }
  }
});
it('rejects malformed M49 reporter and partner codes while keeping unknown three-digit codes', () => {
  for (const reporter_code of [-1, 1.5, 99999])
    expect(
      getTradeFlowsTool.input.safeParse({ reporter_code, flow_code: 'M', period: ['2022'] })
        .success,
    ).toBe(false);
  expect(
    getTradeFlowsTool.input.safeParse({ reporter_code: 999, flow_code: 'M', period: ['2022'] })
      .success,
  ).toBe(true);
  expect(
    getTradeBalanceTool.input.safeParse({
      reporter_code: 842,
      partner_code: 99999,
      period: ['2022'],
    }).success,
  ).toBe(false);
});

it.each([
  ['HS', '9999AA'],
  ['H0', '9999AA'],
  ['S3', '0011X'],
  ['S4', '001XX'],
  ['SS', '00XXX'],
])(
  'preserves catalog selector %s/%s through normalization and retrieval',
  async (classification, code) => {
    const spy = vi
      .spyOn(ComtradeDataService.prototype, 'fetchTradeData')
      .mockResolvedValue({ records: [], totalCount: 0, truncated: false });
    const result = await runToolContract(getTradeFlowsTool, {
      reporter_code: 842,
      flow_code: 'M',
      period: ['1995'],
      classification,
      cmd_code: [code.toLowerCase()],
    });
    expect(result.isError).not.toBe(true);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ classificationCode: classification, cmdCode: code }),
      expect.anything(),
    );
  },
);

it.each(['B4', 'B5'])(
  'forwards availability classification %s without a local membership restriction',
  async (classification) => {
    initComtradeMetaService(
      {} as Parameters<typeof initComtradeMetaService>[0],
      {} as Parameters<typeof initComtradeMetaService>[1],
    );
    const spy = vi
      .spyOn(ComtradeMetaService.prototype, 'getDataAvailability')
      .mockResolvedValue([]);
    const result = await runToolContract(getDataAvailabilityTool, {
      reporter_code: 842,
      period: '2023',
      classification: classification.toLowerCase(),
    });
    expect(result.isError).not.toBe(true);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ classificationCode: classification }),
      expect.anything(),
    );
  },
);

it.each([
  [periodSchema, ' 202501 ', '202501'],
  [periodSchema, '1900', '1900'],
  [annualPeriodSchema, ' 2025 ', '2025'],
  [codeSchema, ' ag2 ', 'AG2'],
  [codeSchema, ' total ', 'TOTAL'],
  [codeSchema, ' 3 ', '3'],
  [codeSchema, ' 001.1 ', '001.1'],
  [codeSchema, ' unknown ', 'UNKNOWN'],
  [codeSchema, ' ', ''],
  [flowSchema, ' x ', 'X'],
  [frequencySchema, ' m ', 'M'],
  [goodsClassificationSchema, ' s4 ', 'S4'],
] as const)('normalizes the shared grammar %#', (schema, input, expected) => {
  expect(schema.parse(input)).toBe(expected);
});
it.each(['1'.repeat(5000), '1'.repeat(20000), '1'.repeat(80000), `${'1'.repeat(80000)}!`])(
  'rejects oversized periods and malformed selector suffixes',
  (value) => {
    expect(periodSchema.safeParse(value).success).toBe(false);
    expect(codeSchema.safeParse(`${value}!`).success).toBe(false);
  },
);
it('serializes the five advertised input schemas to JSON Schema', () => {
  for (const definition of [
    getTradeFlowsTool,
    getTradeBalanceTool,
    getTopPartnersTool,
    getServicesTradeTool,
    getDataAvailabilityTool,
  ]) {
    expect(z.toJSONSchema(definition.input).type).toBe('object');
  }
});
it('wires normalized balance codes and frequency, services blank omission, and availability defaults', async () => {
  const spy = vi
    .spyOn(ComtradeDataService.prototype, 'fetchTradeData')
    .mockResolvedValue({ records: [], totalCount: 0, truncated: false });
  await runToolContract(getTradeBalanceTool, {
    reporter_code: 842,
    period: [' 202503 '],
    freq: ' m ',
    classification: ' s1 ',
    cmd_code: [' '],
  });
  expect(spy).toHaveBeenCalledWith(
    expect.objectContaining({
      period: '202503',
      freqCode: 'M',
      classificationCode: 'S1',
      cmdCode: 'TOTAL',
    }),
    expect.anything(),
    expect.any(Number),
  );
  await runToolContract(getServicesTradeTool, {
    reporter_code: 842,
    flow_code: ' x ',
    period: [' 2025 '],
    service_code: ' ',
  });
  expect(spy.mock.calls.at(-1)?.[0]).toMatchObject({
    period: '2025',
    flowCode: 'X',
    classificationCode: 'EB',
  });
  expect(spy.mock.calls.at(-1)?.[0]).not.toHaveProperty('cmdCode');
  initComtradeMetaService(
    {} as Parameters<typeof initComtradeMetaService>[0],
    {} as Parameters<typeof initComtradeMetaService>[1],
  );
  const meta = vi.spyOn(ComtradeMetaService.prototype, 'getDataAvailability').mockResolvedValue([]);
  for (const [type_code, expected] of [
    [' c ', 'HS'],
    [' s ', 'EB10'],
  ]) {
    await runToolContract(getDataAvailabilityTool, { type_code, classification: ' ' });
    expect(meta).toHaveBeenLastCalledWith(
      expect.objectContaining({ classificationCode: expected }),
      expect.anything(),
    );
  }
  expect(getDataAvailabilityTool.input.safeParse({ classification: 'X/Y' }).success).toBe(false);
});
it('catalog searches take any positive limit and a non-negative integer offset', () => {
  for (const [definition, base] of [
    [searchCommoditiesTool, { query: 'coffee' }],
    [listServiceCategoriesTool, {}],
  ] as const) {
    expect(z.toJSONSchema(definition.input).type).toBe('object');
    expect(definition.input.parse(base)).toMatchObject({ offset: 0 });
    expect(definition.input.parse({ ...base, limit: 100_000, offset: 7_858 })).toMatchObject({
      limit: 100_000,
      offset: 7_858,
    });
    for (const invalid of [{ limit: 0 }, { limit: -1 }, { offset: -1 }, { offset: 1.5 }])
      expect(definition.input.safeParse({ ...base, ...invalid }).success).toBe(false);
  }
});
it('forwards service reasons and recovery on both tool surfaces', async () => {
  const tools = [
    getTradeFlowsTool,
    getTradeBalanceTool,
    getServicesTradeTool,
    getTopPartnersTool,
  ] as const;
  const spy = vi.spyOn(ComtradeDataService.prototype, 'fetchTradeData');
  for (const definition of tools) {
    for (const error of definition.errors ?? []) {
      // Tool-thrown reasons (no_data, partner_only_reporter) are not forwarded from the service.
      if (error.thrownBy !== 'service') continue;
      spy.mockRejectedValue(
        new McpError(error.code, 'Comtrade query failed.', { reason: error.reason }),
      );
      const args = {
        reporter_code: 842,
        ...(definition !== getTradeBalanceTool && { flow_code: 'X' }),
        period: definition === getTopPartnersTool ? '2022' : ['2022'],
      };
      const result = await runToolContract(definition, args);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: error.code,
          data: { reason: error.reason, recovery: { hint: error.recovery } },
        },
      });
      expect(JSON.stringify(result.content)).toContain(error.recovery);
    }
  }
});

it.each([
  [' eb ', 'EB'],
  ['eb10', 'EB10'],
  [' EB02 ', 'EB02'],
  [' ', 'EB'],
  [undefined, 'EB'],
] as const)('normalizes services classification %j to %j', (input, expected) => {
  expect(servicesClassificationSchema.parse(input)).toBe(expected);
});
it.each([
  ['EB10S', 'EB10S has no converted series; its rows are served only under EB.'],
  [' eb10s ', 'EB10S has no converted series; its rows are served only under EB.'],
  ['HS', 'Use EB as reported, or EB10 or EB02 for UN Comtrade'],
  ['S2', 'Use EB as reported, or EB10 or EB02 for UN Comtrade'],
  ['EB2010', 'Use EB as reported, or EB10 or EB02 for UN Comtrade'],
] as const)('rejects services classification %j, pointing to EB', (input, message) => {
  const result = servicesClassificationSchema.safeParse(input);
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.message).toContain(message);
});
it('advertises the services classifications and their EB default on the input side tools/list serves', () => {
  const schema = z.toJSONSchema(getServicesTradeTool.input, { io: 'input' }) as {
    properties: Record<string, { default?: unknown; enum?: unknown; type?: unknown }>;
    required?: string[];
  };
  expect(schema.properties.classification).toMatchObject({
    type: 'string',
    default: 'EB',
    enum: ['EB', 'EB10', 'EB02'],
  });
  expect(schema.required).not.toContain('classification');
});
it.each([
  [searchCommoditiesTool, { query: 'coffee' }],
  [getTradeFlowsTool, { reporter_code: 842, flow_code: 'M', period: ['2022'] }],
  [getTradeBalanceTool, { reporter_code: 842, period: ['2022'] }],
  [getTopPartnersTool, { reporter_code: 842, flow_code: 'M', period: '2022' }],
] as const)(
  'advertises goods classification as a plain HS-default string any casing satisfies, for %#',
  (definition, args) => {
    const schema = z.toJSONSchema(definition.input, { io: 'input' }) as {
      properties: Record<string, { default?: unknown; enum?: unknown; type?: unknown }>;
      required?: string[];
    };
    // A client validating against tools/list must not reject a casing the server normalizes.
    expect(schema.properties.classification).toMatchObject({ type: 'string', default: 'HS' });
    expect(schema.properties.classification).not.toHaveProperty('enum');
    expect(schema.required ?? []).not.toContain('classification');
    expect(definition.input.parse({ ...args, classification: ' h3 ' })).toMatchObject({
      classification: 'H3',
    });
    expect(definition.input.parse(args)).toMatchObject({ classification: 'HS' });
    expect(definition.input.safeParse({ ...args, classification: 'H7' }).success).toBe(false);
  },
);
