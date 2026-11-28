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
import { mixedPartnerBreakdownNotice } from '@/mcp-server/tools/reporter-notice.js';
import { servicesEmptyNotice } from '@/mcp-server/tools/services-empty-notice.js';
import {
  observeExpandedTradeBatch,
  tradeBatchArray,
} from '@/mcp-server/tools/trade-batch-input.js';
import {
  applyTradeLimit,
  formatTradePage,
  limitClampSchema,
  renderLimitClamp,
  tradePage,
  tradePageInput,
  tradePageOutput,
} from '@/mcp-server/tools/trade-page.js';
import {
  describePeriodFailures,
  getComtradeDataService,
  TRADE_DATA_DEADLINE_MS,
} from '@/services/comtrade-data/comtrade-data-service.js';

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
    "Fetch annual international trade-in-services data. Classification EB (default) serves each reporter-period as reported, in its own scheme (EB10, EB10S or EB02 codes); EB10 or EB02 selects UN Comtrade's conversion of other schemes into that one. Each row names its classification and whether it is original or converted. Same bilateral structure as goods trade: returns flow value in USD, period, and reporter/partner/category metadata for each row. Follow nextOffset for remaining records; each page repeats the upstream period requests. Use comtrade_list_service_categories to find a service code and its scheme before querying. Keyless preview makes one request per served period, at least 4 seconds apart, capped at 500 records per request. Services coverage is more limited than goods trade.",
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
    ...tradePageInput,
    reporter_code: m49Schema.describe('M49 numeric code of the reporting country (0–999).'),
    flow_code: flowSchema.describe('Trade flow: M=imports (debits), X=exports (credits).'),
    period: tradeBatchArray(
      z.array(annualPeriodSchema).min(1),
      'period',
      'Annual periods YYYY. Serves the first 8 distinct periods keyless (12 with authenticated access); the rest, and any period whose request is rate limited, fails on a UN Comtrade server error or network failure, or runs out of time, are listed in unservedPeriods.',
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
    ...tradePageOutput,
    truncated: z
      .boolean()
      .describe('True when any preview response reached 500 and may be incomplete.'),
    truncationHint: z
      .string()
      .optional()
      .describe('Query narrowing and authenticated access guidance when possibly incomplete.'),
  }),

  enrichment: {
    limitClamp: limitClampSchema,
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
    limitClamp: { render: renderLimitClamp },
    unservedPeriods: {
      render: (periods) =>
        periods ? `**Unserved periods:** ${periods.join(', ')}. Query them separately.` : '',
    },
  },
  async handler(input, ctx) {
    const limit = applyTradeLimit(input.limit, ctx, 'comtrade_get_services_trade');
    observeExpandedTradeBatch(input, ctx, 'comtrade_get_services_trade');
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
    ctx.signal.throwIfAborted();
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
        await servicesEmptyNotice(
          input,
          classification,
          periods.filter((period) => !failed.has(period)),
          ctx.signal,
          deadlineAt,
        ),
      );
    }
    ctx.signal.throwIfAborted();
    const page = tradePage(
      result.records.map((record) => ServicesFlowRecordSchema.parse(record)),
      input.offset,
      limit,
      notices,
    );
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return {
      ...page,
      totalCount: result.totalCount,
      truncated: result.truncated,
      ...(result.truncationHint && { truncationHint: result.truncationHint }),
    };
  },

  format: (result) =>
    formatTradePage('Services Trade Records', result, Object.keys(ServicesFlowRecordSchema.shape)),
});
