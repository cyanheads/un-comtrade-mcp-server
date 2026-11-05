/**
 * @fileoverview Tool for computing a country's trade balance (exports minus imports).
 * @module mcp-server/tools/definitions/get-trade-balance.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  codeSchema,
  frequencySchema,
  GOODS_CODE_SHAPE_MESSAGE,
  goodsClassificationSchema,
  goodsCodesMatchClassification,
  m49Schema,
  periodSchema,
  periodsMatchFrequency,
  resolveFrequency,
} from '@/mcp-server/tools/comtrade-input.js';
import { partnerOnlyReporterNotice } from '@/mcp-server/tools/reporter-notice.js';
import {
  describePeriodFailures,
  getComtradeDataService,
  periodFailureError,
  TRADE_DATA_DEADLINE_MS,
  type TradeQueryResult,
} from '@/services/comtrade-data/comtrade-data-service.js';
import { getComtradeReferenceService } from '@/services/comtrade-reference/comtrade-reference-service.js';

export const getTradeBalanceTool = tool('comtrade_get_trade_balance', {
  title: 'Get Trade Balance',
  description:
    'Compute the trade balance for a country over one or more periods — total exports minus ' +
    'total imports — with optional HS or SITC commodity filter. Keyless preview makes two requests per served period, at least 4 seconds apart; authenticated calls batch periods. ' +
    'Returns the signed balance (USD), export value, import value, and coverage ratio ' +
    '(exports / imports). Note: mirror asymmetry is common — balance reflects values as ' +
    'reported by this country; the same flow may be recorded differently by the partner. ' +
    'Uses comtrade_lookup_countries to resolve reporter codes.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z
    .object({
      reporter_code: m49Schema.describe(
        'M49 numeric code of the reporting country (0–999). A partner-only code (0 World, 250 Metropolitan France) with no data fails with partner_only_reporter, naming the reporter-valid code when one exists (250 → 251).',
      ),
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
          'Periods, all annual (YYYY) or all monthly (YYYYMM); mixed lengths are rejected. Serves the first 4 keyless (12 with authenticated access); the rest, and any period whose export or import request is rate limited or runs out of time, are listed in unservedPeriods. Input ceiling 120.',
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
        .optional()
        .describe(
          'Frequency for both flows: A=annual YYYY, M=monthly YYYYMM (01–12). Omit to infer it from the periods; an explicit value must match them.',
        ),
    })
    .refine(periodsMatchFrequency, {
      path: ['period'],
      message:
        'Use only YYYY (annual) or only YYYYMM (monthly) periods in one call; an explicit freq must match them.',
    })
    .refine(goodsCodesMatchClassification, {
      path: ['cmd_code'],
      message: GOODS_CODE_SHAPE_MESSAGE,
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
      .describe(
        'Periods left out because a flow was rate limited (with the wait) or ran out of time, and possible incompleteness when a preview response reaches its cap.',
      ),
    referenceNotice: z
      .string()
      .optional()
      .describe('Reference descriptions unavailable; codes and trade values retained.'),
    unservedPeriods: z
      .array(z.string())
      .optional()
      .describe(
        'Periods not served: past the period cap (4 keyless, 12 authenticated) or whose export or import request was rate limited or ran out of time; query them separately.',
      ),
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
    {
      reason: 'partner_only_reporter',
      code: JsonRpcErrorCode.NotFound,
      when: 'No served period has data and the reporter code is partner-only in UN Comtrade reference data.',
      recovery: 'Find a reporter with comtrade_lookup_countries using role "reporter".',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'No period was served and UN Comtrade rate-limited a flow through its retries.',
      recovery: 'Wait the number of seconds the error states, then retry with fewer periods.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'deadline_exceeded',
      code: JsonRpcErrorCode.Timeout,
      when: "No period had both flows complete within the call's time budget.",
      recovery:
        'Retry with fewer periods per call, or retry later if UN Comtrade is responding slowly.',
      retryable: true,
      thrownBy: 'service',
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
    const periodCap = svc.periodsPerCall(2);
    const servedPeriods = input.period.slice(0, periodCap);
    const normalizedCodes = input.cmd_code?.filter(Boolean);
    const codes = normalizedCodes?.slice(0, 20);
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
      freqCode: resolveFrequency(input),
    };

    // Both flows share one deadline; the first to fail stops the other before the call settles,
    // so no preview request starts after it returns.
    const deadlineAt = Date.now() + TRADE_DATA_DEADLINE_MS;
    const stop = new AbortController();
    const signal = AbortSignal.any([ctx.signal, stop.signal]);
    const fetchFlow = (flowCode: 'X' | 'M'): Promise<TradeQueryResult> =>
      svc.fetchTradeData({ ...commonParams, flowCode }, signal, deadlineAt).catch((error) => {
        stop.abort(error);
        throw error;
      });
    const [exportOutcome, importOutcome] = await Promise.allSettled([
      fetchFlow('X'),
      fetchFlow('M'),
    ]);
    if (exportOutcome.status === 'rejected' || importOutcome.status === 'rejected')
      throw stop.signal.reason;
    const exportResult = exportOutcome.value;
    const importResult = importOutcome.value;

    // A period counts only when both flows completed it.
    const failures = [...(exportResult.failedPeriods ?? []), ...(importResult.failedPeriods ?? [])];
    const failed = new Set(failures.map((failure) => failure.period));
    const unservedPeriods = [
      ...[...new Set(servedPeriods)].filter((period) => failed.has(period)),
      ...input.period.slice(periodCap),
    ];
    if (unservedPeriods.length > 0) ctx.enrich({ unservedPeriods });
    const notices = failures.length > 0 ? [describePeriodFailures(failures)] : [];
    if (exportResult.truncated || importResult.truncated)
      notices.push(
        'A preview response reached 500 records; balance values may be incomplete. Narrow the commodity query.',
      );
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));
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
      if (!failed.has(p)) periodMap.set(p, {});
    }

    for (const r of exportResult.records) {
      if (failed.has(r.period)) continue;
      const entry = periodMap.get(r.period) ?? {};
      entry.exportsUsd = (entry.exportsUsd ?? 0) + (r.primaryValue ?? 0);
      periodMap.set(r.period, entry);
    }
    for (const r of importResult.records) {
      if (failed.has(r.period)) continue;
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
      // An answered-empty period is not "no data" for the periods that failed.
      if (failures.length > 0)
        throw periodFailureError(
          failures,
          periods.length > 0
            ? {
                lead: `Served period${periods.length === 1 ? '' : 's'} ${periods.map((p) => p.period).join(', ')} returned no trade data.`,
              }
            : {},
        );
      const status = getComtradeReferenceService().getReporterStatus(input.reporter_code);
      if (status.referenceStatus === 'partner_only') {
        const suggested = status.suggestedReporterCode;
        throw ctx.fail(
          'partner_only_reporter',
          `No trade data found for reporter ${input.reporter_code}, periods [${servedPeriods.join(', ')}]. ${partnerOnlyReporterNotice(input.reporter_code, status)}`,
          suggested === undefined
            ? undefined
            : {
                suggestedReporterCode: suggested,
                recovery: { hint: `Retry with reporter_code ${suggested}.` },
              },
        );
      }
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
