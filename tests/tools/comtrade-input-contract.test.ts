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
} from '@/mcp-server/tools/comtrade-input.js';
import { getDataAvailabilityTool } from '@/mcp-server/tools/definitions/get-data-availability.tool.js';
import { getServicesTradeTool } from '@/mcp-server/tools/definitions/get-services-trade.tool.js';
import { getTopPartnersTool } from '@/mcp-server/tools/definitions/get-top-partners.tool.js';
import { getTradeBalanceTool } from '@/mcp-server/tools/definitions/get-trade-balance.tool.js';
import { getTradeFlowsTool } from '@/mcp-server/tools/definitions/get-trade-flows.tool.js';
import {
  ComtradeDataService,
  initComtradeDataService,
} from '@/services/comtrade-data/comtrade-data-service.js';
import {
  ComtradeMetaService,
  initComtradeMetaService,
} from '@/services/comtrade-meta/comtrade-meta-service.js';

beforeEach(() =>
  initComtradeDataService(
    {} as Parameters<typeof initComtradeDataService>[0],
    {} as Parameters<typeof initComtradeDataService>[1],
  ),
);
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
  const spy = vi
    .spyOn(ComtradeDataService.prototype, 'fetchTradeData')
    .mockResolvedValue({ records: [], totalCount: 0, truncated: false });
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
  expect(
    getTradeFlowsTool.input.safeParse({ reporter_code: 842, flow_code: 'M', period: ['202503'] })
      .success,
  ).toBe(false);
  expect(
    getServicesTradeTool.input.safeParse({ reporter_code: 842, flow_code: 'M', period: ['202503'] })
      .success,
  ).toBe(false);
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
      if (error.reason === 'no_data') continue;
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
