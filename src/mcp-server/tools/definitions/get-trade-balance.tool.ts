/**
 * @fileoverview Tool for computing a country's trade balance (exports minus imports).
 * @module mcp-server/tools/definitions/get-trade-balance.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  codeSchema,
  frequencySchema,
  goodsClassificationSchema,
  goodsCodesMatchClassification,
  m49Schema,
  periodSchema,
  periodsMatchFrequency,
} from '@/mcp-server/tools/comtrade-input.js';
import { getComtradeDataService } from '@/services/comtrade-data/comtrade-data-service.js';

export const getTradeBalanceTool = tool('comtrade_get_trade_balance', {
  title: 'Get Trade Balance',
  description:
    'Compute the trade balance for a country over one or more periods — total exports minus ' +
    'total imports — with optional HS or SITC commodity filter. Preview makes two paced requests per served period; authenticated calls batch periods. ' +
    'Returns the signed balance (USD), export value, import value, and coverage ratio ' +
    '(exports / imports). Note: mirror asymmetry is common — balance reflects values as ' +
    'reported by this country; the same flow may be recorded differently by the partner. ' +
    'Uses comtrade_lookup_countries to resolve reporter codes.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z
    .object({
      reporter_code: m49Schema.describe('M49 numeric code of the reporting country (0–999).'),
      partner_code: m49Schema
        .default(0)
        .describe(
          'M49 partner code (0–999); defaults to World (0). The balance uses the reporter’s values.',
        ),
      period: z
        .array(periodSchema)
        .min(1)
        .max(120)
        .describe(
          'Annual periods (YYYY) or monthly periods (YYYYMM). Serves the first 12 and discloses the remainder; input ceiling 120.',
        ),
      cmd_code: z
        .array(codeSchema)
        .max(200)
        .optional()
        .describe(
          'HS or SITC commodity codes to restrict the balance calculation. Serves the first 20 and discloses the remainder; input ceiling 200. ' +
            'Omit to compute the overall trade balance across all commodities.',
        ),
      classification: goodsClassificationSchema
        .default('HS')
        .describe('Goods classification: HS/H0–H6 or SITC S1–S4/SS.'),
      freq: frequencySchema
        .default('A')
        .describe('Frequency: A=annual YYYY, M=monthly YYYYMM (01–12).'),
    })
    .refine(periodsMatchFrequency, {
      path: ['period'],
      message: 'Use YYYY for annual frequency or YYYYMM for monthly frequency.',
    })
    .refine(goodsCodesMatchClassification, {
      path: ['cmd_code'],
      message:
        'Use HS codes with 2, 4 or 6 digits or legacy 9999AA; SITC codes have up to 5 characters with optional trailing X. TOTAL and classification-specific AG selectors are supported.',
    }),

  output: z.object({
    periods: z
      .array(
        z
          .object({
            period: z.string().describe('Period (YYYY or YYYYMM).'),
            exportsUsd: z
              .number()
              .optional()
              .describe('Total exports value in USD for this period.'),
            importsUsd: z
              .number()
              .optional()
              .describe('Total imports value in USD for this period.'),
            balanceUsd: z
              .number()
              .optional()
              .describe('Trade balance in USD: exports minus imports. Positive = surplus.'),
            coverageRatio: z
              .number()
              .optional()
              .describe(
                'Export coverage ratio: exports / imports. >1 = surplus, <1 = deficit. ' +
                  'Absent when imports is zero.',
              ),
            note: z
              .string()
              .optional()
              .describe('Data note, e.g. when only one flow direction has data.'),
          })
          .describe('Trade balance values for a single reporting period.'),
      )
      .describe('Balance computation per period.'),
    reporterCode: z.number().describe('M49 reporter code used.'),
    reporterDesc: z.string().describe('Reporter country name.'),
    partnerCode: z.number().describe('M49 partner code used.'),
    partnerDesc: z
      .string()
      .describe(
        'Partner name supplied by the returned records, or its numeric code when unavailable.',
      ),
    cmdCodes: z
      .array(z.string())
      .optional()
      .describe('Commodity codes used in the query (absent when querying all commodities).'),
    mirrorCaveat: z
      .string()
      .describe(
        "Standard caveat about mirror asymmetry — balance reflects this country's reported values.",
      ),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Possible incompleteness of the balance when a preview response reaches its cap.'),
    referenceNotice: z
      .string()
      .optional()
      .describe('Reference descriptions unavailable; codes and trade values retained.'),
    unservedPeriods: z
      .array(z.string())
      .optional()
      .describe('Periods beyond the 12-period work cap; query them separately.'),
    unservedCmdCodes: z
      .array(z.string())
      .optional()
      .describe('Commodity codes beyond the 20-code work cap; query them separately.'),
  },
  errors: [
    {
      reason: 'keyless_hs_edition_unsupported',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Explicit HS editions require authenticated data access.',
      recovery:
        'Use HS for as-reported rows or configure authenticated access for an explicit edition.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_reporter_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Reporter omission lacks an explicit partner.',
      recovery: 'Supply one reporter_code for this balance query.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_validation',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'UN Comtrade rejects the query dimensions.',
      recovery: 'Check reporter, partner, commodity and period before retrying.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_upstream_response',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'UN Comtrade returns malformed trade data.',
      recovery: 'Retry later when UN Comtrade returns valid trade data.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'no_data',
      code: JsonRpcErrorCode.NotFound,
      when: 'No trade data available for the reporter and period combination.',
      recovery:
        'Use comtrade_get_data_availability to verify which periods have published data, ' +
        'then retry with a confirmed available period.',
    },
  ],

  enrichmentTrailer: {
    unservedPeriods: {
      render: (periods) =>
        periods ? `**Unserved periods:** ${periods.join(', ')}. Query them separately.` : '',
    },
    unservedCmdCodes: {
      render: (codes) =>
        codes ? `**Unserved commodity codes:** ${codes.join(', ')}. Query them separately.` : '',
    },
  },
  async handler(input, ctx) {
    ctx.log.info('comtrade_get_trade_balance', {
      reporter: input.reporter_code,
      periods: input.period.length,
    });

    const svc = getComtradeDataService();
    const servedPeriods = input.period.slice(0, 12);
    const normalizedCodes = input.cmd_code?.filter(Boolean);
    const codes = normalizedCodes?.slice(0, 20);
    if (input.period.length > 12) ctx.enrich({ unservedPeriods: input.period.slice(12) });
    if (normalizedCodes && normalizedCodes.length > 20)
      ctx.enrich({ unservedCmdCodes: normalizedCodes.slice(20) });
    const periodStr = servedPeriods.join(',');
    const cmdCode = codes?.length ? codes.join(',') : 'TOTAL';
    const commonParams = {
      reporterCode: input.reporter_code,
      period: periodStr,
      partnerCode: input.partner_code,
      cmdCode,
      classificationCode: input.classification,
      typeCode: 'C' as const,
      freqCode: input.freq,
    };

    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(55_000)]);
    const [exportResult, importResult] = await Promise.all([
      svc.fetchTradeData({ ...commonParams, flowCode: 'X' }, signal),
      svc.fetchTradeData({ ...commonParams, flowCode: 'M' }, signal),
    ]);
    if (exportResult.truncated || importResult.truncated)
      ctx.enrich.notice(
        'A preview response reached 500 records; balance values may be incomplete. Narrow the commodity query.',
      );
    const referenceNotice = [
      ...new Set([exportResult.referenceNotice, importResult.referenceNotice].filter(Boolean)),
    ].join(' ');
    if (referenceNotice) ctx.enrich({ referenceNotice });

    // Get reporter name from either result
    const reporterDesc =
      exportResult.records[0]?.reporterDesc ??
      importResult.records[0]?.reporterDesc ??
      String(input.reporter_code);

    // Build a map of period → { exports, imports }
    const periodMap = new Map<string, { exportsUsd?: number; importsUsd?: number }>();

    for (const p of servedPeriods) {
      periodMap.set(p, {});
    }

    for (const r of exportResult.records) {
      const entry = periodMap.get(r.period) ?? {};
      entry.exportsUsd = (entry.exportsUsd ?? 0) + (r.primaryValue ?? 0);
      periodMap.set(r.period, entry);
    }
    for (const r of importResult.records) {
      const entry = periodMap.get(r.period) ?? {};
      entry.importsUsd = (entry.importsUsd ?? 0) + (r.primaryValue ?? 0);
      periodMap.set(r.period, entry);
    }

    const periods = Array.from(periodMap.entries()).map(([period, vals]) => {
      const { exportsUsd, importsUsd } = vals;
      const balanceUsd =
        exportsUsd !== undefined || importsUsd !== undefined
          ? (exportsUsd ?? 0) - (importsUsd ?? 0)
          : undefined;
      const coverageRatio =
        importsUsd !== undefined && importsUsd > 0 && exportsUsd !== undefined
          ? exportsUsd / importsUsd
          : undefined;
      const hasExports = exportsUsd !== undefined;
      const hasImports = importsUsd !== undefined;
      const note =
        hasExports && !hasImports
          ? 'Export data only; no import data found for this period.'
          : !hasExports && hasImports
            ? 'Import data only; no export data found for this period.'
            : undefined;
      return {
        period,
        ...(exportsUsd !== undefined && { exportsUsd }),
        ...(importsUsd !== undefined && { importsUsd }),
        ...(balanceUsd !== undefined && { balanceUsd }),
        ...(coverageRatio !== undefined && { coverageRatio }),
        ...(note && { note }),
      };
    });

    if (periods.every((p) => p.exportsUsd === undefined && p.importsUsd === undefined)) {
      const truncated = exportResult.truncated || importResult.truncated;
      throw ctx.fail(
        'no_data',
        `No trade data found for reporter ${input.reporter_code}, periods [${servedPeriods.join(', ')}]` +
          (truncated
            ? '. A preview response reached 500 records; coverage may be incomplete. Narrow the commodity query.'
            : ''),
        { ...ctx.recoveryFor('no_data'), ...(truncated && { truncated }) },
      );
    }

    return {
      periods,
      reporterCode: input.reporter_code,
      reporterDesc,
      partnerCode: input.partner_code,
      partnerDesc:
        exportResult.records[0]?.partnerDesc ??
        importResult.records[0]?.partnerDesc ??
        String(input.partner_code),
      ...(codes?.length && { cmdCodes: codes }),
      mirrorCaveat:
        'Balance reflects values as reported by this country. Mirror asymmetry is common — the partner country may report different values for the same flow due to CIF/FOB valuation, timing, re-exports, and country definition differences.',
    };
  },

  format: (result) => {
    const lines = [`## Trade Balance: ${result.reporterDesc} (code ${result.reporterCode})`];
    lines.push(`**Partner:** ${result.partnerDesc} (code ${result.partnerCode})`);
    if (result.cmdCodes?.length) {
      lines.push(`**Commodities:** ${result.cmdCodes.join(', ')}`);
    }
    for (const p of result.periods) {
      lines.push(`\n### Period: ${p.period}`);
      if (p.exportsUsd != null) lines.push(`**Exports:** $${p.exportsUsd.toLocaleString()} USD`);
      if (p.importsUsd != null) lines.push(`**Imports:** $${p.importsUsd.toLocaleString()} USD`);
      if (p.balanceUsd != null) {
        const sign = p.balanceUsd >= 0 ? 'Surplus' : 'Deficit';
        lines.push(`**Balance:** $${Math.abs(p.balanceUsd).toLocaleString()} USD (${sign})`);
      }
      if (p.coverageRatio != null) {
        lines.push(`**Coverage Ratio:** ${p.coverageRatio.toFixed(3)}`);
      }
      if (p.note) lines.push(`> Note: ${p.note}`);
    }
    lines.push(`\n> *${result.mirrorCaveat}*`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
