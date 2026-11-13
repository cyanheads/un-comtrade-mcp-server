/**
 * @fileoverview Tool for fetching international trade-in-services data (EBOPS: EB as reported,
 * or UN Comtrade's converted EB10/EB02 series).
 * @module mcp-server/tools/definitions/get-services-trade.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  annualPeriodSchema,
  codeSchema,
  flowSchema,
  m49Schema,
  servicesClassificationSchema,
} from '@/mcp-server/tools/comtrade-input.js';
import {
  counterpartNotices,
  mixedPartnerBreakdownNotice,
} from '@/mcp-server/tools/reporter-notice.js';
import {
  describePeriodFailures,
  getComtradeDataService,
  TRADE_DATA_DEADLINE_MS,
} from '@/services/comtrade-data/comtrade-data-service.js';
import { getComtradeReferenceService } from '@/services/comtrade-reference/comtrade-reference-service.js';
import type { EbScheme } from '@/services/comtrade-reference/types.js';

/** A services classification the trade endpoint serves. */
type ServicesClassification = z.output<typeof servicesClassificationSchema>;

const AVAILABILITY_ROUTE =
  'Use comtrade_get_data_availability with type_code="S" and classification="EB" to check coverage and the scheme each period was reported in.';

/**
 * The scheme catalogs listing a service code: `undefined` when they did not load, or did not
 * answer before `deadlineAt` (the call's budget, shared with the data fetch). The first lookup
 * loads three catalogs; later ones read the cache. Caller cancellation propagates.
 */
async function serviceCodeSchemes(
  code: string,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<readonly EbScheme[] | undefined> {
  // A timer rather than AbortSignal.timeout: it is cleared when the lookup settles.
  const budget = new AbortController();
  const timer = setTimeout(
    () => budget.abort(new DOMException('The call budget ran out.', 'TimeoutError')),
    Math.max(0, deadlineAt - Date.now()),
  );
  try {
    // The whole listing, matched by equality: the code never reaches the keyword scan.
    const listing = await getComtradeReferenceService().getServiceCategories(
      undefined,
      AbortSignal.any([signal, budget.signal]),
    );
    if (listing.status === 'untagged') return;
    // codeSchema uppercases; EB.json keeps a few lowercase ids (3a.3.1).
    return listing.categories.find((category) => category.id.toUpperCase() === code)?.schemes ?? [];
  } catch (error) {
    if (signal.aborted || !budget.signal.aborted) throw error;
    return;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Why a services query returned no rows. A partner-only reporter code, or a partner code with a
 * reporter-valid counterpart, ends it with the code to query instead. Otherwise it explains a
 * converted series, names the requested code's EB scheme, and routes to availability under EB,
 * where each period shows the scheme it was reported in.
 */
async function emptyResultNotice(
  input: {
    reporter_code: number;
    flow_code: string;
    partner_code?: number | undefined;
    service_code?: string | undefined;
  },
  classification: ServicesClassification,
  servedPeriods: readonly string[],
  signal: AbortSignal,
  deadlineAt: number,
): Promise<string> {
  const sentences = [
    `No services trade records found for reporter ${input.reporter_code}, flow=${input.flow_code}, periods=[${servedPeriods.join(', ')}].`,
  ];
  const taiwanPartner = input.partner_code === 490;
  if (taiwanPartner) sentences.push('Use partner_code 158 for Taiwan services.');
  const counterparts = counterpartNotices(
    getComtradeReferenceService(),
    input.reporter_code,
    input.partner_code,
    'S',
  );
  sentences.push(...counterparts);
  if (counterparts.length > 0 && !taiwanPartner) return sentences.join(' ');
  if (classification !== 'EB')
    sentences.push(
      `${classification} serves UN Comtrade's conversions from other schemes; rows reported in ${classification} itself are served under classification "EB".`,
    );
  const code = input.service_code;
  const schemes = code ? await serviceCodeSchemes(code, signal, deadlineAt) : [];
  if (schemes === undefined) {
    sentences.push(
      `The EB scheme catalogs did not load, so service code ${code} is not matched to a scheme.`,
    );
  } else if (schemes.length > 0) {
    const listed = `Service code ${code} belongs to ${schemes.join(' and ')}`;
    sentences.push(
      classification === 'EB'
        ? `${listed}; EB serves each reporter-period in the scheme it was reported in, so a period reported in another scheme has no rows for this code.`
        : `${listed}.`,
    );
  }
  sentences.push(AVAILABILITY_ROUTE);
  // EB10S has no converted series, so only EB10 and EB02 are levers.
  const converted = schemes?.filter((scheme) => scheme !== 'EB10S') ?? [];
  if (classification === 'EB' && converted.length > 0) {
    sentences.push(
      `Set classification to ${converted.map((scheme) => `"${scheme}"`).join(' or ')} for UN Comtrade's converted series.`,
    );
  }
  return sentences.join(' ');
}

const ServicesFlowRecordSchema = z
  .object({
    classificationCode: z
      .string()
      .optional()
      .describe('Actual services classification edition on the returned row.'),
    isOriginalClassification: z
      .boolean()
      .optional()
      .describe(
        'True when the row is in the scheme the reporter used; false when UN Comtrade converted it into the requested classification.',
      ),
    reporterCode: z.number().describe('M49 reporter code.'),
    reporterDesc: z.string().describe('Reporter country/area name.'),
    partnerCode: z.number().describe('M49 partner code.'),
    partnerDesc: z.string().describe('Partner country/area name.'),
    flowCode: z.string().describe('Trade flow: M=imports (debits), X=exports (credits).'),
    cmdCode: z.string().describe('EBOPS service category code.'),
    cmdDesc: z.string().describe('Service category description.'),
    period: z.string().describe('Annual period YYYY.'),
    primaryValue: z.number().optional().describe('Trade value in USD.'),
    isReported: z.boolean().optional().describe('True if directly reported; false if estimated.'),
  })
  .describe('A single services trade flow record.');

export const getServicesTradeTool = tool('comtrade_get_services_trade', {
  title: 'Get Services Trade Data',
  description:
    "Fetch annual international trade-in-services data. Classification EB (default) serves each reporter-period as reported, in its own scheme (EB10, EB10S or EB02 codes); EB10 or EB02 selects UN Comtrade's conversion of other schemes into that one. Each row names its classification and whether it is original or converted. Same bilateral structure as goods trade: returns flow value in USD, period, and reporter/partner/category metadata for each row. Use comtrade_list_service_categories to find a service code and its scheme before querying. Keyless preview makes one request per served period, at least 4 seconds apart, capped at 500 records per request. Services coverage is more limited than goods trade.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  errors: [
    {
      reason: 'invalid_reporter_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Reporter omission lacks an explicit partner.',
      recovery: 'Supply one reporter_code for this services trade query.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_validation',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'UN Comtrade rejects the query dimensions.',
      recovery: 'Check reporter, partner, service category and annual period before retrying.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_upstream_response',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'UN Comtrade returns malformed services data.',
      recovery: 'Retry later when UN Comtrade returns valid services data.',
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

  input: z.object({
    reporter_code: m49Schema.describe('M49 numeric code of the reporting country (0–999).'),
    flow_code: flowSchema.describe('Trade flow: M=imports (debits), X=exports (credits).'),
    period: z
      .array(annualPeriodSchema)
      .min(1)
      .max(120)
      .describe(
        'Annual periods YYYY. Serves the first 8 distinct periods keyless (12 with authenticated access); the rest, and any period whose request is rate limited, fails on a UN Comtrade server error or network failure, or runs out of time, are listed in unservedPeriods. Input ceiling 120.',
      ),
    partner_code: m49Schema
      .optional()
      .describe(
        'M49 partner code. Use 0 for all partners combined (World). Omitting it can return World alongside the partner breakdown.',
      ),
    service_code: codeSchema
      .optional()
      .describe(
        'Service category code in one scheme: "7" (EB10), "SG" (EB10S) and "260" (EB02) are each financial services. Under EB a code returns rows only for periods reported in its scheme; comtrade_list_service_categories lists codes with their schemes. Omit to get every category the reporter reported, at mixed levels: totals (200 for EB10 and EB02, S for EB10S) beside their components, so do not sum the rows.',
      ),
    classification: servicesClassificationSchema.describe(
      "Services classification. EB (default): each reporter-period as reported, in its own scheme (EB10, EB10S or EB02 codes). EB10 or EB02: UN Comtrade's conversion of reports from other schemes into that one; reports made in it stay under EB. EB10S has no converted series; its rows are served only under EB. Case-insensitive; blank means EB.",
    ),
  }),

  output: z.object({
    records: z.array(ServicesFlowRecordSchema).describe('Services trade flow records.'),
    totalCount: z
      .number()
      .describe(
        'Sum of upstream response counts before local filtering; not a full match count when capped.',
      ),
    shown: z.number().describe('Number of records returned.'),
    truncated: z
      .boolean()
      .describe('True when any preview response reached 500 and may be incomplete.'),
    truncationHint: z
      .string()
      .optional()
      .describe('Query narrowing and authenticated access guidance when possibly incomplete.'),
  }),

  enrichment: {
    referenceNotice: z
      .string()
      .optional()
      .describe('Reference descriptions unavailable; codes and values retained.'),
    unservedPeriods: z
      .array(z.string())
      .optional()
      .describe(
        'Periods not served: past the period cap (8 keyless, 12 authenticated) or whose requests were rate limited, failed on a UN Comtrade server error or network failure, or ran out of time; query them separately.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'World overlap warnings, period failures, and guidance for empty results, including EB scheme coverage, ISO-3 counterpart codes, or partner_code 158 for Taiwan services.',
      ),
  },

  enrichmentTrailer: {
    unservedPeriods: {
      render: (periods) =>
        periods ? `**Unserved periods:** ${periods.join(', ')}. Query them separately.` : '',
    },
  },
  async handler(input, ctx) {
    // One budget for the data fetch and the empty-result scheme lookup.
    const deadlineAt = Date.now() + TRADE_DATA_DEADLINE_MS;
    const { classification } = input;
    ctx.log.info('comtrade_get_services_trade', {
      reporter: input.reporter_code,
      flow: input.flow_code,
      classification,
      periods: input.period.length,
    });

    const svc = getComtradeDataService();
    const periodCap = svc.periodsPerCall(1);
    // Repeats are dropped before the cap, so they take no slot and a served period is never listed unserved.
    const requestedPeriods = [...new Set(input.period)];
    const periods = requestedPeriods.slice(0, periodCap);
    const result = await svc.fetchTradeData(
      {
        reporterCode: input.reporter_code,
        flowCode: input.flow_code,
        period: periods.join(','),
        ...(input.partner_code !== undefined && { partnerCode: input.partner_code }),
        ...(input.service_code && { cmdCode: input.service_code }),
        typeCode: 'S',
        classificationCode: classification,
        freqCode: 'A',
      },
      ctx.signal,
      deadlineAt,
    );
    if (result.referenceNotice) ctx.enrich({ referenceNotice: result.referenceNotice });
    const failed = new Set(result.failedPeriods?.map((failure) => failure.period));
    const unservedPeriods = [
      ...periods.filter((period) => failed.has(period)),
      ...requestedPeriods.slice(periodCap),
    ];
    if (unservedPeriods.length > 0) ctx.enrich({ unservedPeriods });

    const notices = result.failedPeriods ? [describePeriodFailures(result.failedPeriods)] : [];
    const mixedBreakdown = mixedPartnerBreakdownNotice(input.partner_code, result.records);
    if (mixedBreakdown) notices.push(mixedBreakdown);
    if (result.records.length === 0) {
      notices.push(
        await emptyResultNotice(
          input,
          classification,
          periods.filter((period) => !failed.has(period)),
          ctx.signal,
          deadlineAt,
        ),
      );
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return {
      records: result.records.map((record) => ServicesFlowRecordSchema.parse(record)),
      totalCount: result.totalCount,
      shown: result.records.length,
      truncated: result.truncated,
      ...(result.truncationHint && { truncationHint: result.truncationHint }),
    };
  },

  format: (result) => {
    const lines = [
      `## Services Trade Records`,
      `**Records:** ${result.shown} of ${result.totalCount}`,
    ];
    if (result.truncated && result.truncationHint) {
      lines.push(`\n> **Truncated:** ${result.truncationHint}`);
    }
    for (const r of result.records) {
      lines.push(
        `\n**${r.reporterDesc}** (${r.reporterCode}) → **${r.partnerDesc}** (${r.partnerCode}) | ${r.period} | ${r.flowCode}`,
      );
      lines.push(`Service: ${r.cmdCode} — ${r.cmdDesc}`);
      if (r.classificationCode !== undefined)
        lines.push(`classificationCode: ${r.classificationCode}`);
      if (r.isOriginalClassification != null) {
        lines.push(
          `Original classification: ${r.isOriginalClassification ? 'Yes (as reported)' : 'No (converted by UN Comtrade)'}`,
        );
      }
      if (r.primaryValue != null) {
        lines.push(`Value: $${r.primaryValue.toLocaleString()} USD`);
      }
      if (r.isReported != null) {
        lines.push(`Reported: ${r.isReported ? 'Yes (direct)' : 'No (estimated)'}`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
