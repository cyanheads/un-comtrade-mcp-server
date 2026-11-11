/**
 * @fileoverview Primary bilateral trade flow data retrieval tool.
 * @module mcp-server/tools/definitions/get-trade-flows.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import {
  codeSchema,
  frequencySchema,
  GOODS_CODE_SHAPE_MESSAGE,
  goodsClassificationSchema,
  goodsCodesMatchClassification,
  goodsFlowSchema,
  m49Schema,
  periodSchema,
  periodsMatchFrequency,
  resolveFrequency,
} from '@/mcp-server/tools/comtrade-input.js';
import { counterpartNotices } from '@/mcp-server/tools/reporter-notice.js';
import {
  describePeriodFailures,
  getComtradeDataService,
} from '@/services/comtrade-data/comtrade-data-service.js';
import { getComtradeReferenceService } from '@/services/comtrade-reference/comtrade-reference-service.js';

const TradeFlowRecordSchema = z.object({
  classificationCode: z
    .string()
    .optional()
    .describe('Actual classification edition supplied by the row.'),
  qtyUnitCode: z.number().optional().describe('Quantity unit code; -1 means unavailable.'),
  qtyUnitAbbr: z
    .string()
    .optional()
    .describe('Quantity unit abbreviation supplied or resolved from the unit catalog.'),
  altQty: z
    .number()
    .optional()
    .describe('Alternate quantity, in its own unit. Absent when not reported.'),
  altQtyUnitCode: z.number().optional().describe('Alternate quantity unit code.'),
  altQtyUnitAbbr: z.string().optional().describe('Alternate quantity unit abbreviation.'),
  isQtyEstimated: z.boolean().optional().describe('Whether quantity is estimated.'),
  isNetWgtEstimated: z.boolean().optional().describe('Whether net weight is estimated.'),
  reporterCode: z.number().describe('M49 reporter code.'),
  reporterDesc: z.string().describe('Reporter country/area name.'),
  partnerCode: z.number().describe('M49 partner code.'),
  partnerDesc: z.string().describe('Partner country/area name.'),
  flowCode: z.string().describe('Trade flow: M=import, X=export, RX=re-export, RM=re-import.'),
  cmdCode: z.string().describe('HS or SITC commodity code or "TOTAL".'),
  cmdDesc: z.string().describe('Commodity description.'),
  period: z.string().describe('Period (YYYY for annual, YYYYMM for monthly).'),
  primaryValue: z
    .number()
    .optional()
    .describe('Primary trade value in USD (FOB for exports, CIF for imports).'),
  fobvalue: z.number().optional().describe('Free-on-board value in USD. Absent when not reported.'),
  cifvalue: z
    .number()
    .optional()
    .describe('Cost-insurance-freight value in USD. Absent when not reported.'),
  qty: z
    .number()
    .optional()
    .describe('Quantity in commodity-specific units. Absent when not reported.'),
  netWgt: z.number().optional().describe('Net weight in kg. Absent when not reported.'),
  grossWgt: z.number().optional().describe('Gross weight in kg. Absent when not reported.'),
  isReported: z
    .boolean()
    .optional()
    .describe('True if directly reported; false if estimated or aggregated by UN.'),
  aggrLevel: z.number().optional().describe('Commodity aggregation level supplied by UN Comtrade.'),
});

export const getTradeFlowsTool = tool('comtrade_get_trade_flows', {
  title: 'Get Trade Flow Records',
  description:
    'Fetch bilateral trade flow records — the primary data retrieval tool. Returns trade value in USD (primaryValue — FOB for exports, CIF for imports), quantity, net weight, and period/commodity/partner metadata for each row. Accepts multiple periods and commodity codes per call; pass partner_code 0 to get totals aggregated across all partners. Omit cmd_code or pass "TOTAL" to aggregate all commodities. Keyless preview makes one request per served period, at least 4 seconds apart, with a 500-record cap per request. Use comtrade_lookup_countries to resolve reporter/partner codes and comtrade_search_commodities to resolve HS codes. For SITC, supply codes from the selected SITC revision.',
  annotations: { readOnlyHint: true, openWorldHint: true },
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
      recovery: 'Supply reporter_code or explicitly select partner_code for all reporters.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_validation',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'UN Comtrade rejects the query dimensions.',
      recovery: 'Check reporter, partner, commodity, flow and period before retrying.',
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
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'No served period completed and UN Comtrade rate-limited at least one through its retries.',
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
      when: "No served period completed within the call's time budget.",
      recovery:
        'Retry with fewer periods per call, or retry later if UN Comtrade is responding slowly.',
      retryable: true,
      thrownBy: 'service',
    },
  ],

  input: z
    .object({
      reporter_code: z
        .union([
          m49Schema.describe('One M49 reporter code.'),
          z.array(m49Schema).min(1).max(200).describe('Reporter codes to query together.'),
        ])
        .optional()
        .describe(
          'M49 reporter code or nonempty array (input ceiling 200). Deduplicates and serves the first 20 reporters, disclosing the remainder; served codes of an array that return no records are listed in reportersWithoutRecords. Some codes are partners only (0 World, 250 Metropolitan France, 158 Taiwan, Province of China): France reports as 251, and UN Comtrade publishes the trade of 158 under 490 (Other Asia, nes). Omit only with an explicit partner_code to query all reporters.',
        ),
      flow_code: goodsFlowSchema.describe(
        'Trade flow direction: M=imports, X=exports, RX=re-exports, RM=re-imports.',
      ),
      period: z
        .array(periodSchema)
        .min(1)
        .max(120)
        .describe(
          'One or more periods to query, all annual "YYYY" (e.g. ["2022", "2023"]) or all monthly "YYYYMM" (e.g. ["202201", "202202"]); mixed lengths are rejected. Serves the first 8 distinct periods keyless (12 with authenticated access); the rest, and any period whose request is rate limited, fails on a UN Comtrade server error or network failure, or runs out of time, are listed in unservedPeriods. Input ceiling 120.',
        ),
      partner_code: m49Schema
        .optional()
        .describe(
          'M49 code of the trade partner. Use 0 to aggregate across all partners (World total). Omit to get a disaggregated breakdown by partner country.',
        ),
      cmd_code: z
        .array(codeSchema)
        .max(200)
        .optional()
        .describe(
          'HS or SITC commodity codes to query. Serves the first 20 distinct codes and discloses the remainder; input ceiling 200. Pass ["TOTAL"] or omit to aggregate all commodities. Use comtrade_search_commodities for codes in the selected HS or SITC edition.',
        ),
      classification: goodsClassificationSchema
        .default('HS')
        .describe(
          'Goods classification: HS as reported, H0–H6 with authenticated access, or SITC S1–S4/SS.',
        ),
      freq: frequencySchema
        .optional()
        .describe(
          'Frequency: A=annual YYYY, M=monthly YYYYMM (01–12). Omit to infer it from the periods; an explicit value must match them.',
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
    })
    .refine((input) => input.reporter_code !== undefined || input.partner_code !== undefined, {
      path: ['reporter_code'],
      message: 'Supply a reporter or an explicit partner_code when querying all reporters.',
    }),

  output: z.object({
    records: z
      .array(TradeFlowRecordSchema.describe('A single bilateral trade flow record.'))
      .describe('Trade flow records.'),
    totalCount: z
      .number()
      .describe(
        'Sum of upstream response counts before local filtering; not a full match count when capped.',
      ),
    shown: z.number().describe('Number of records returned in this response.'),
    truncated: z
      .boolean()
      .describe('True when any preview response reached 500 and may be incomplete.'),
    truncationHint: z
      .string()
      .optional()
      .describe('Query narrowing and authenticated access guidance when possibly incomplete.'),
  }),

  enrichment: {
    unservedReporters: z
      .array(z.number())
      .optional()
      .describe('Reporter codes beyond the 20-reporter work cap; query them separately.'),
    reportersWithoutRecords: z
      .array(
        z
          .object({
            reporterCode: z.number().describe('Served reporter code that returned no records.'),
            name: z
              .string()
              .optional()
              .describe('Reference catalog name; absent when the code is in neither catalog.'),
            referenceStatus: z
              .enum(['reporter', 'partner_only', 'unknown'])
              .describe(
                'reporter: a reporting entity with nothing published here; partner_only: a code UN Comtrade lists only as a partner; unknown: in neither reference catalog.',
              ),
            suggestedReporterCode: z
              .number()
              .optional()
              .describe(
                'Reporter-valid code to query instead of a partner_only code: the one sharing its ISO-3 identity (250 → 251), or the one UN Comtrade publishes its trade under (158 → 490).',
              ),
          })
          .describe('A served reporter with no records, classified by the reference catalogs.'),
      )
      .optional()
      .describe(
        'Served codes from a reporter_code array with no records in any served period. Omitted when truncated, since a capped response can hide a reporter’s rows.',
      ),
    unservedPeriods: z
      .array(z.string())
      .optional()
      .describe(
        'Periods not served: past the period cap (8 keyless, 12 authenticated) or whose requests were rate limited, failed on a UN Comtrade server error or network failure, or ran out of time; query them separately.',
      ),
    unservedCmdCodes: z
      .array(z.string())
      .optional()
      .describe('Commodity codes beyond the 20-code work cap; query them separately.'),
    referenceNotice: z
      .string()
      .optional()
      .describe(
        'Notice when reference descriptions could not be loaded; codes and trade values remain available.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Why data is missing: periods that were rate limited (with the wait), failed on a UN Comtrade server error (with the HTTP status) or network failure, or ran out of time, and a recovery hint when no records are returned, naming the code to query instead of a partner-only reporter_code (250 → 251, 158 → 490) or of a partner_code with a reporter-valid counterpart (840 → 842, 158 → 490).',
      ),
  },

  enrichmentTrailer: {
    unservedReporters: {
      render: (reporters) =>
        reporters
          ? `**Unserved reporters:** ${reporters.join(', ')}. Query them separately with reporter_code.`
          : '',
    },
    reportersWithoutRecords: {
      render: (reporters) =>
        reporters
          ? `**Reporters without records:** ${reporters
              .map(
                (r) =>
                  `${r.reporterCode}${r.name === undefined ? '' : ` ${escapeMarkdownInline(r.name)}`} (${r.referenceStatus}${r.suggestedReporterCode === undefined ? '' : `, suggestedReporterCode ${r.suggestedReporterCode}`})`,
              )
              .join('; ')}.`
          : '',
    },
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
    ctx.log.info('comtrade_get_trade_flows', {
      reporter: input.reporter_code,
      flow: input.flow_code,
      periods: input.period.length,
    });

    const svc = getComtradeDataService();
    const reporters = Array.isArray(input.reporter_code)
      ? [...new Set(input.reporter_code)]
      : input.reporter_code;
    if (Array.isArray(reporters) && reporters.length > 20)
      ctx.enrich({ unservedReporters: reporters.slice(20) });
    const servedReporters = Array.isArray(reporters) ? reporters.slice(0, 20) : reporters;
    // Repeats are dropped before each cap, so they take no slot and a served value is never listed unserved.
    const periodCap = svc.periodsPerCall(1);
    const requestedPeriods = [...new Set(input.period)];
    const periods = requestedPeriods.slice(0, periodCap);
    const normalizedCodes = input.cmd_code && [...new Set(input.cmd_code.filter(Boolean))];
    const codes = normalizedCodes?.slice(0, 20);
    if (normalizedCodes && normalizedCodes.length > 20)
      ctx.enrich({ unservedCmdCodes: normalizedCodes.slice(20) });
    const result = await svc.fetchTradeData(
      {
        ...(servedReporters !== undefined && { reporterCode: servedReporters }),
        flowCode: input.flow_code,
        period: periods.join(','),
        ...(input.partner_code !== undefined && { partnerCode: input.partner_code }),
        cmdCode: codes?.length ? codes.join(',') : 'TOTAL',
        typeCode: 'C',
        classificationCode: input.classification,
        freqCode: resolveFrequency(input),
      },
      ctx.signal,
    );
    if (result.referenceNotice) ctx.enrich({ referenceNotice: result.referenceNotice });
    const failed = new Set(result.failedPeriods?.map((failure) => failure.period));
    const unservedPeriods = [
      ...periods.filter((period) => failed.has(period)),
      ...requestedPeriods.slice(periodCap),
    ];
    if (unservedPeriods.length > 0) ctx.enrich({ unservedPeriods });
    const reference = getComtradeReferenceService();
    // Records come only from completed periods. A capped response can hide a reporter's rows.
    if (Array.isArray(servedReporters) && !result.truncated) {
      const answered = new Set(result.records.map((record) => record.reporterCode));
      const reportersWithoutRecords = servedReporters
        .filter((code) => !answered.has(code))
        .map((reporterCode) => ({ reporterCode, ...reference.getReporterStatus(reporterCode) }));
      if (reportersWithoutRecords.length > 0) ctx.enrich({ reportersWithoutRecords });
    }

    const notices = result.failedPeriods ? [describePeriodFailures(result.failedPeriods)] : [];
    if (result.records.length === 0) {
      const counterparts = counterpartNotices(
        reference,
        typeof servedReporters === 'number' ? servedReporters : undefined,
        input.partner_code,
      );
      const subject =
        servedReporters === undefined
          ? 'all reporters'
          : `reporter ${Array.isArray(servedReporters) ? servedReporters.join(', ') : servedReporters}`;
      const served = periods.filter((period) => !failed.has(period)).join(', ');
      const next =
        counterparts.length > 0
          ? counterparts.join(' ')
          : 'Use comtrade_get_data_availability to check if data exists for this period.';
      notices.push(
        `No trade flow records found for ${subject}, flow=${input.flow_code}, periods=[${served}]. ${next}`,
      );
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return {
      records: result.records,
      totalCount: result.totalCount,
      shown: result.records.length,
      truncated: result.truncated,
      ...(result.truncationHint && { truncationHint: result.truncationHint }),
    };
  },

  format: (result) => {
    const lines = [`## Trade Flow Records`, `**Records:** ${result.shown} of ${result.totalCount}`];
    if (result.truncated && result.truncationHint) {
      lines.push(`\n> **Truncated:** ${result.truncationHint}`);
    }
    for (const r of result.records) {
      lines.push(
        `\n**${r.reporterDesc}** (${r.reporterCode}) → **${r.partnerDesc}** (${r.partnerCode}) | ${r.period} | ${r.flowCode}`,
      );
      lines.push(
        `Commodity: ${r.cmdCode} — ${r.cmdDesc}` +
          (r.aggrLevel != null ? ` (aggregation level ${r.aggrLevel})` : ''),
      );
      if (r.classificationCode !== undefined)
        lines.push(`classificationCode: ${r.classificationCode}`);
      if (r.qtyUnitCode !== undefined) lines.push(`qtyUnitCode: ${r.qtyUnitCode}`);
      if (r.qtyUnitAbbr !== undefined) lines.push(`qtyUnitAbbr: ${r.qtyUnitAbbr}`);
      if (r.altQty !== undefined) lines.push(`altQty: ${r.altQty}`);
      if (r.altQtyUnitCode !== undefined) lines.push(`altQtyUnitCode: ${r.altQtyUnitCode}`);
      if (r.altQtyUnitAbbr !== undefined) lines.push(`altQtyUnitAbbr: ${r.altQtyUnitAbbr}`);
      if (r.isQtyEstimated !== undefined) lines.push(`isQtyEstimated: ${r.isQtyEstimated}`);
      if (r.isNetWgtEstimated !== undefined)
        lines.push(`isNetWgtEstimated: ${r.isNetWgtEstimated}`);
      if (r.primaryValue != null) {
        lines.push(`Primary Value: $${r.primaryValue.toLocaleString()} USD`);
      }
      if (r.fobvalue != null) lines.push(`FOB: $${r.fobvalue.toLocaleString()} USD`);
      if (r.cifvalue != null) lines.push(`CIF: $${r.cifvalue.toLocaleString()} USD`);
      if (r.qty != null) lines.push(`Quantity: ${r.qty.toLocaleString()}`);
      if (r.netWgt != null) lines.push(`Net Weight: ${r.netWgt.toLocaleString()} kg`);
      if (r.grossWgt != null) lines.push(`Gross Weight: ${r.grossWgt.toLocaleString()} kg`);
      if (r.isReported != null) {
        lines.push(`Reported: ${r.isReported ? 'Yes (direct)' : 'No (estimated/aggregated)'}`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
