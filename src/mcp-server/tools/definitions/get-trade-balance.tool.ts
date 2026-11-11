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
import {
  partnerCounterpartNotice,
  partnerOnlyReporterNotice,
} from '@/mcp-server/tools/reporter-notice.js';
import {
  describePeriodFailures,
  getComtradeDataService,
  periodFailureError,
  periodFailuresOf,
  TRADE_DATA_DEADLINE_MS,
  type TradeQueryResult,
} from '@/services/comtrade-data/comtrade-data-service.js';
import { getComtradeReferenceService } from '@/services/comtrade-reference/comtrade-reference-service.js';

/**
 * The level an `AG<n>` selector covers, else undefined. Codes arrive trimmed, uppercased, and
 * shape-checked against the classification.
 */
function selectorLevel(code: string): number | undefined {
  return code.startsWith('AG') ? Number(code.slice(2)) : undefined;
}

/**
 * Whether two distinct codes return overlapping rows, which a balance would sum twice. HS editions
 * and SITC revisions nest by prefix (SITC memorandum `X` codes and legacy `9999AA` included) and a
 * code's level is its length, so `TOTAL` overlaps everything and `AG<n>` every code of another
 * length.
 */
function codesOverlap(a: string, b: string): boolean {
  if (a === 'TOTAL' || b === 'TOTAL') return true;
  const levelA = selectorLevel(a);
  const levelB = selectorLevel(b);
  if (levelA !== undefined) return levelB !== undefined || b.length !== levelA;
  if (levelB !== undefined) return a.length !== levelB;
  return a.startsWith(b) || b.startsWith(a);
}

/** The earliest code that overlaps a later one, paired with the first such later code. */
function firstOverlap(codes: readonly string[]): [string, string] | undefined {
  for (const [index, code] of codes.entries()) {
    const other = codes.slice(index + 1).find((later) => codesOverlap(code, later));
    if (other !== undefined) return [code, other];
  }
  return;
}

/** Note for a served period where neither flow returned rows. */
const NEITHER_FLOW_NOTE = 'No export or import data found for this period.';

export const getTradeBalanceTool = tool('comtrade_get_trade_balance', {
  title: 'Get Trade Balance',
  description:
    'Compute the trade balance for a country over one or more periods — total exports minus total imports — with an optional HS or SITC commodity filter whose codes must not overlap. Keyless preview makes two requests per served period, at least 4 seconds apart; authenticated calls batch periods. Returns the export and import values per period and, when both flows have data, the signed balance (USD) and coverage ratio (exports / imports). Note: mirror asymmetry is common — balance reflects values as reported by this country; the same flow may be recorded differently by the partner. Uses comtrade_lookup_countries to resolve reporter codes.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z
    .object({
      reporter_code: m49Schema.describe(
        'M49 numeric code of the reporting country (0–999). A partner-only code (0 World, 250 Metropolitan France, 158 Taiwan, Province of China) with no data fails with partner_only_reporter, naming the code to query instead when one exists: 251 shares the ISO-3 identity of 250, and UN Comtrade publishes the trade of 158 under 490 (Other Asia, nes).',
      ),
      partner_code: m49Schema
        .default(0)
        .describe(
          'M49 partner code (0–999); defaults to World (0). The balance uses the reporter’s values. A partner code with a reporter-valid counterpart (840 → 842, 158 → 490) that returns no data fails with no_data naming that counterpart.',
        ),
      period: z
        .array(periodSchema)
        .min(1)
        .max(120)
        .describe(
          'Periods, all annual (YYYY) or all monthly (YYYYMM); mixed lengths are rejected. Serves the first 4 distinct periods keyless (12 with authenticated access); the rest, and any period whose export or import request is rate limited, hits a UN Comtrade server error or network failure, or runs out of time, are listed in unservedPeriods. Input ceiling 120.',
        ),
      cmd_code: z
        .array(codeSchema)
        .max(200)
        .optional()
        .describe(
          'HS or SITC commodity codes whose values the balance sums; omit for the overall balance across all commodities. Exact duplicates count once. Overlapping codes are rejected because their shared trade would be summed twice: a code beside one of its sub-codes (27 and 2709), TOTAL beside any other entry, or AG<n> beside another AG selector or a code whose length is not n. Serves the first 20 and discloses the remainder; input ceiling 200.',
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
              .describe(
                'Trade balance in USD: exports minus imports, only when both flows have data for the period. Positive = surplus.',
              ),
            coverageRatio: z
              .number()
              .optional()
              .describe(
                'Export coverage ratio: exports / imports. >1 = surplus, <1 = deficit. Only when both flows have data and imports are above zero.',
              ),
            note: z
              .string()
              .optional()
              .describe(
                'Data note when a flow has no data for this period: export only, import only, or neither.',
              ),
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
        'Periods left out because a flow was rate limited (with the wait), hit a UN Comtrade server error or network failure, or ran out of time; served periods with no export or import data; and possible incompleteness when a preview response reaches its cap.',
      ),
    referenceNotice: z
      .string()
      .optional()
      .describe('Reference descriptions unavailable; codes and trade values retained.'),
    unservedPeriods: z
      .array(z.string())
      .optional()
      .describe(
        'Periods not served: past the period cap (4 keyless, 12 authenticated) or whose export or import request was rate limited, hit a UN Comtrade server error or network failure, or ran out of time; query them separately.',
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
      reason: 'overlapping_cmd_codes',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Two cmd_code entries return overlapping rows: a code and one of its sub-codes, TOTAL and another entry, or an AG selector and another level.',
      recovery:
        'Request overlapping codes in separate balance calls, or use comtrade_get_trade_flows for per-code values.',
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
        'Use comtrade_get_data_availability to verify which periods have published data, then retry with a confirmed available period.',
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
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'No requested period completed and at least one request failed on a UN Comtrade server error or network failure after retries.',
      recovery: 'Wait a minute and retry the same call.',
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

    // codeSchema trims and uppercases each entry, so the Set drops exact duplicates, whose rows
    // UN Comtrade returns once. The overlap check spans codes past the cap: a caller adds their
    // follow-up balances to this one.
    const requestedCodes = [...new Set(input.cmd_code?.filter(Boolean))];
    const overlap = firstOverlap(requestedCodes);
    if (overlap)
      throw ctx.fail(
        'overlapping_cmd_codes',
        `cmd_code entries ${overlap[0]} and ${overlap[1]} overlap, so the balance would count their shared trade twice.`,
      );
    const codes = requestedCodes.slice(0, 20);
    if (requestedCodes.length > 20) ctx.enrich({ unservedCmdCodes: requestedCodes.slice(20) });

    const svc = getComtradeDataService();
    const periodCap = svc.periodsPerCall(2);
    // Repeats are dropped before the cap, so they take no slot and a served period is never listed unserved.
    const requestedPeriods = [...new Set(input.period)];
    const servedPeriods = requestedPeriods.slice(0, periodCap);
    const periodStr = servedPeriods.join(',');
    const cmdCode = codes.length > 0 ? codes.join(',') : 'TOTAL';
    const commonParams = {
      reporterCode: input.reporter_code,
      period: periodStr,
      partnerCode: input.partner_code,
      cmdCode,
      classificationCode: input.classification,
      typeCode: 'C' as const,
      freqCode: resolveFrequency(input),
    };

    // Both flows share one deadline. A failure that ends the call stops the other flow before the
    // call settles, so no preview request starts after it returns. A flow whose every period
    // failed transiently lets the other finish, so the thrown reason ranks both flows' failures.
    const deadlineAt = Date.now() + TRADE_DATA_DEADLINE_MS;
    const stop = new AbortController();
    const signal = AbortSignal.any([ctx.signal, stop.signal]);
    const fetchFlow = (flowCode: 'X' | 'M'): Promise<TradeQueryResult> =>
      svc.fetchTradeData({ ...commonParams, flowCode }, signal, deadlineAt).catch((error) => {
        if (!periodFailuresOf(error)) stop.abort(error);
        throw error;
      });
    const outcomes = await Promise.allSettled([fetchFlow('X'), fetchFlow('M')]);
    if (stop.signal.aborted) throw stop.signal.reason;
    const [exportOutcome, importOutcome] = outcomes;
    if (exportOutcome.status === 'rejected' || importOutcome.status === 'rejected')
      throw periodFailureError(
        outcomes.flatMap((outcome) =>
          outcome.status === 'rejected'
            ? (periodFailuresOf(outcome.reason) ?? [])
            : (outcome.value.failedPeriods ?? []),
        ),
      );
    const exportResult = exportOutcome.value;
    const importResult = importOutcome.value;

    // A period counts only when both flows completed it.
    const failures = [...(exportResult.failedPeriods ?? []), ...(importResult.failedPeriods ?? [])];
    const failed = new Set(failures.map((failure) => failure.period));
    const unservedPeriods = [
      ...servedPeriods.filter((period) => failed.has(period)),
      ...requestedPeriods.slice(periodCap),
    ];
    if (unservedPeriods.length > 0) ctx.enrich({ unservedPeriods });
    const truncated = exportResult.truncated || importResult.truncated;
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

    const periods = Array.from(periodMap.entries()).map(([period, { exportsUsd, importsUsd }]) => {
      // A flow without rows may be unreported rather than zero, so the derived figures need both.
      const bothFlows = exportsUsd !== undefined && importsUsd !== undefined;
      const note =
        exportsUsd === undefined && importsUsd === undefined
          ? NEITHER_FLOW_NOTE
          : importsUsd === undefined
            ? 'Export data only; no import data found for this period.'
            : exportsUsd === undefined
              ? 'Import data only; no export data found for this period.'
              : undefined;
      return {
        period,
        ...(exportsUsd !== undefined && { exportsUsd }),
        ...(importsUsd !== undefined && { importsUsd }),
        ...(bothFlows && { balanceUsd: exportsUsd - importsUsd }),
        ...(bothFlows && importsUsd > 0 && { coverageRatio: exportsUsd / importsUsd }),
        ...(note && { note }),
      };
    });
    const emptyPeriods = periods.filter((p) => p.note === NEITHER_FLOW_NOTE).map((p) => p.period);

    if (emptyPeriods.length === periods.length) {
      // An answered-empty period is not "no data" for the periods that failed.
      if (failures.length > 0)
        throw periodFailureError(
          failures,
          periods.length > 0
            ? {
                lead: `Served period${periods.length === 1 ? '' : 's'} ${emptyPeriods.join(', ')} returned no trade data.`,
              }
            : {},
        );
      const lead = `No trade data found for reporter ${input.reporter_code}${input.partner_code === 0 ? '' : ` and partner ${input.partner_code}`}, periods [${servedPeriods.join(', ')}]`;
      const reference = getComtradeReferenceService();
      const status = reference.getReporterStatus(input.reporter_code);
      const partnerStatus = reference.getReporterStatus(input.partner_code);
      const partnerHint = partnerCounterpartNotice(input.partner_code, partnerStatus);
      const suggestedPartnerCode =
        partnerStatus.referenceStatus === 'partner_only'
          ? partnerStatus.suggestedReporterCode
          : undefined;
      if (status.referenceStatus === 'partner_only') {
        const suggested = status.suggestedReporterCode;
        const partnerRetry =
          suggestedPartnerCode === undefined ? '' : ` and partner_code ${suggestedPartnerCode}`;
        throw ctx.fail(
          'partner_only_reporter',
          [`${lead}.`, partnerOnlyReporterNotice(input.reporter_code, status), partnerHint]
            .filter(Boolean)
            .join(' '),
          {
            ...(suggested !== undefined && {
              suggestedReporterCode: suggested,
              recovery: { hint: `Retry with reporter_code ${suggested}${partnerRetry}.` },
            }),
            ...(suggestedPartnerCode !== undefined && { suggestedPartnerCode }),
          },
        );
      }
      const sentences = [
        truncated
          ? 'A preview response reached 500 records; coverage may be incomplete. Narrow the commodity query.'
          : undefined,
        partnerHint,
      ].filter((sentence) => sentence !== undefined);
      throw ctx.fail('no_data', sentences.length > 0 ? `${lead}. ${sentences.join(' ')}` : lead, {
        ...(suggestedPartnerCode === undefined
          ? ctx.recoveryFor('no_data')
          : {
              suggestedPartnerCode,
              recovery: { hint: `Retry with partner_code ${suggestedPartnerCode}.` },
            }),
        ...(truncated && { truncated }),
      });
    }

    const notices = failures.length > 0 ? [describePeriodFailures(failures)] : [];
    if (emptyPeriods.length > 0)
      notices.push(
        emptyPeriods.length === 1
          ? `Period ${emptyPeriods[0]} returned no export or import data; use comtrade_get_data_availability to check whether it is published.`
          : `Periods ${emptyPeriods.join(', ')} returned no export or import data; use comtrade_get_data_availability to check whether they are published.`,
      );
    if (truncated)
      notices.push(
        'A preview response reached 500 records; balance values may be incomplete. Narrow the commodity query.',
      );
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return {
      periods,
      reporterCode: input.reporter_code,
      reporterDesc,
      partnerCode: input.partner_code,
      partnerDesc:
        exportResult.records[0]?.partnerDesc ??
        importResult.records[0]?.partnerDesc ??
        String(input.partner_code),
      ...(codes.length > 0 && { cmdCodes: codes }),
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
        const label = p.balanceUsd > 0 ? ' (Surplus)' : p.balanceUsd < 0 ? ' (Deficit)' : '';
        lines.push(`**Balance:** $${Math.abs(p.balanceUsd).toLocaleString()} USD${label}`);
      }
      if (p.coverageRatio != null) {
        lines.push(`**Coverage Ratio:** ${p.coverageRatio}`);
      }
      if (p.note) lines.push(`> Note: ${p.note}`);
    }
    lines.push(`\n> *${result.mirrorCaveat}*`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
