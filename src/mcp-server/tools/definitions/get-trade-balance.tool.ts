/**
 * @fileoverview Tool for computing a country's trade balance (exports minus imports).
 * @module mcp-server/tools/definitions/get-trade-balance.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getComtradeDataService } from '@/services/comtrade-data/comtrade-data-service.js';

export const getTradeBalanceTool = tool('comtrade_get_trade_balance', {
  title: 'Get Trade Balance',
  description:
    'Compute the trade balance for a country over one or more periods — total exports minus ' +
    'total imports — with optional commodity filter. Fetches export and import totals in parallel ' +
    'and returns the signed balance (USD), export value, import value, and coverage ratio ' +
    '(exports / imports). Note: mirror asymmetry is common — balance reflects values as ' +
    'reported by this country; the same flow may be recorded differently by the partner. ' +
    'Uses comtrade_lookup_countries to resolve reporter codes.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    reporter_code: z.number().int().describe('M49 numeric code of the reporting country.'),
    period: z
      .array(z.string().min(4))
      .min(1)
      .max(12)
      .describe('One or more annual periods (YYYY) or monthly periods (YYYYMM).'),
    cmd_code: z
      .array(z.string())
      .max(20)
      .optional()
      .describe(
        'HS commodity codes to restrict the balance calculation. ' +
          'Omit to compute the overall trade balance across all commodities.',
      ),
    classification: z
      .enum(['HS', 'H0', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'])
      .default('HS')
      .describe('HS classification version.'),
    freq: z.enum(['A', 'M']).default('A').describe('Frequency: A=annual, M=monthly.'),
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

  errors: [
    {
      reason: 'no_data',
      code: JsonRpcErrorCode.NotFound,
      when: 'No trade data available for the reporter and period combination.',
      recovery:
        'Use comtrade_get_data_availability to verify which periods have published data, ' +
        'then retry with a confirmed available period.',
    },
    {
      reason: 'api_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The Comtrade API returned an error or was unreachable.',
      recovery:
        'Check COMTRADE_SUBSCRIPTION_KEY if set, verify network connectivity, and retry after a brief delay.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('comtrade_get_trade_balance', {
      reporter: input.reporter_code,
      periods: input.period.length,
    });

    const svc = getComtradeDataService();
    const periodStr = input.period.join(',');
    const cmdCode = input.cmd_code?.length ? input.cmd_code.join(',') : 'TOTAL';
    const commonParams = {
      reporterCode: input.reporter_code,
      period: periodStr,
      partnerCode: 0, // World aggregate
      cmdCode,
      classificationCode: input.classification,
      freqCode: input.freq,
    };

    const [exportResult, importResult] = await Promise.all([
      svc.fetchTradeData({ ...commonParams, flowCode: 'X' }, ctx.signal),
      svc.fetchTradeData({ ...commonParams, flowCode: 'M' }, ctx.signal),
    ]);

    // Get reporter name from either result
    const reporterDesc =
      exportResult.records[0]?.reporterDesc ??
      importResult.records[0]?.reporterDesc ??
      String(input.reporter_code);

    // Build a map of period → { exports, imports }
    const periodMap = new Map<string, { exportsUsd?: number; importsUsd?: number }>();

    for (const p of input.period) {
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
      throw ctx.fail(
        'no_data',
        `No trade data found for reporter ${input.reporter_code}, periods [${input.period.join(', ')}]`,
        {
          recovery: {
            hint: 'Use comtrade_get_data_availability to check which periods have published data.',
          },
        },
      );
    }

    return {
      periods,
      reporterCode: input.reporter_code,
      reporterDesc,
      ...(input.cmd_code?.length && { cmdCodes: input.cmd_code }),
      mirrorCaveat:
        'Balance reflects values as reported by this country. Mirror asymmetry is common — the partner country may report different values for the same flow due to CIF/FOB valuation, timing, re-exports, and country definition differences.',
    };
  },

  format: (result) => {
    const lines = [`## Trade Balance: ${result.reporterDesc} (code ${result.reporterCode})`];
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
