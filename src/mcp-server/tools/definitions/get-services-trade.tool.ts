/**
 * @fileoverview Tool for fetching international trade-in-services data (EBOPS 2010).
 * @module mcp-server/tools/definitions/get-services-trade.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  annualPeriodSchema,
  codeSchema,
  flowSchema,
  m49Schema,
} from '@/mcp-server/tools/comtrade-input.js';
import { getComtradeDataService } from '@/services/comtrade-data/comtrade-data-service.js';

const ServicesFlowRecordSchema = z
  .object({
    classificationCode: z
      .string()
      .optional()
      .describe('Actual services classification edition on the returned row.'),
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
    'Fetch annual international trade-in-services data through the combined EB classification; each row identifies its actual classification edition. ' +
    'Same bilateral structure as goods trade: returns flow value in USD, period, and ' +
    'reporter/partner/category metadata for each row. ' +
    'Use comtrade_list_service_categories to find the right service code before querying. ' +
    'Preview makes one paced request per served period, capped at 500 records per request. Services coverage is more limited than goods trade.',
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
  ],

  input: z.object({
    reporter_code: m49Schema.describe('M49 numeric code of the reporting country (0–999).'),
    flow_code: flowSchema.describe('Trade flow: M=imports (debits), X=exports (credits).'),
    period: z
      .array(annualPeriodSchema)
      .min(1)
      .max(120)
      .describe(
        'Annual periods YYYY. Serves the first 12 and discloses the remainder; input ceiling 120. Preview makes one paced request per period.',
      ),
    partner_code: m49Schema
      .optional()
      .describe(
        'M49 partner code. Use 0 for all partners combined. ' +
          'Omit for a disaggregated by-partner breakdown.',
      ),
    service_code: codeSchema
      .optional()
      .describe(
        'EB service category code (e.g. "SA" for manufacturing services or "3" for transport). ' +
          'Use comtrade_list_service_categories to find available codes. ' +
          'Omit to get totals across all service categories.',
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
      .describe('Periods beyond the 12-period work cap; query them separately.'),
    notice: z.string().optional().describe('Recovery hint when no records are returned.'),
  },

  enrichmentTrailer: {
    unservedPeriods: {
      render: (periods) =>
        periods ? `**Unserved periods:** ${periods.join(', ')}. Query them separately.` : '',
    },
  },
  async handler(input, ctx) {
    ctx.log.info('comtrade_get_services_trade', {
      reporter: input.reporter_code,
      flow: input.flow_code,
      periods: input.period.length,
    });

    const svc = getComtradeDataService();
    if (input.period.length > 12) ctx.enrich({ unservedPeriods: input.period.slice(12) });
    const result = await svc.fetchTradeData(
      {
        reporterCode: input.reporter_code,
        flowCode: input.flow_code,
        period: input.period.slice(0, 12).join(','),
        ...(input.partner_code !== undefined && { partnerCode: input.partner_code }),
        ...(input.service_code && { cmdCode: input.service_code }),
        typeCode: 'S',
        classificationCode: 'EB',
        freqCode: 'A',
      },
      ctx.signal,
    );
    if (result.referenceNotice) ctx.enrich({ referenceNotice: result.referenceNotice });

    if (result.records.length === 0) {
      ctx.enrich.notice(
        `No services trade records found for reporter ${input.reporter_code}, ` +
          `flow=${input.flow_code}, periods=[${input.period.join(', ')}]. ` +
          `Use comtrade_get_data_availability with type_code="S" to verify coverage.`,
      );
    }

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
