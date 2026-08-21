/**
 * @fileoverview Tool for fetching international trade-in-services data (EBOPS 2010).
 * @module mcp-server/tools/definitions/get-services-trade.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getComtradeDataService } from '@/services/comtrade-data/comtrade-data-service.js';

const ServicesFlowRecordSchema = z
  .object({
    reporterCode: z.number().describe('M49 reporter code.'),
    reporterDesc: z.string().describe('Reporter country/area name.'),
    partnerCode: z.number().describe('M49 partner code.'),
    partnerDesc: z.string().describe('Partner country/area name.'),
    flowCode: z.string().describe('Trade flow: M=import (credit received), X=export (debit paid).'),
    cmdCode: z.string().describe('EBOPS service category code.'),
    cmdDesc: z.string().describe('Service category description.'),
    period: z.string().describe('Period (YYYY or YYYYMM).'),
    primaryValue: z.number().optional().describe('Trade value in USD.'),
    isReported: z.boolean().optional().describe('True if directly reported; false if estimated.'),
  })
  .describe('A single services trade flow record.');

export const getServicesTradeTool = tool('comtrade_get_services_trade', {
  title: 'Get Services Trade Data',
  description:
    'Fetch international trade-in-services data (EBOPS 2010 classification). ' +
    'Same bilateral structure as goods trade: returns flow value in USD, period, and ' +
    'reporter/partner/category metadata for each row. ' +
    'Use comtrade_list_service_categories to find the right service code before querying. ' +
    'Note: services trade data has more limited country and period coverage than goods trade.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    reporter_code: z.number().int().describe('M49 numeric code of the reporting country.'),
    flow_code: z
      .enum(['M', 'X'])
      .describe('Trade flow: M=imports (credit received by reporter), X=exports (debit paid).'),
    period: z
      .array(z.string().min(4))
      .min(1)
      .max(12)
      .describe('One or more annual periods (YYYY) or monthly periods (YYYYMM).'),
    partner_code: z
      .number()
      .int()
      .optional()
      .describe(
        'M49 partner code. Use 0 for all partners combined. ' +
          'Omit for a disaggregated by-partner breakdown.',
      ),
    service_code: z
      .string()
      .optional()
      .describe(
        'EBOPS 2010 service category code (e.g. "SA" for transport). ' +
          'Use comtrade_list_service_categories to find available codes. ' +
          'Omit to get totals across all service categories.',
      ),
  }),

  output: z.object({
    records: z.array(ServicesFlowRecordSchema).describe('Services trade flow records.'),
    totalCount: z.number().describe('Total records reported by the API.'),
    shown: z.number().describe('Number of records returned.'),
    truncated: z.boolean().describe('True when results were capped at 500 records.'),
    truncationHint: z.string().optional().describe('How to get full data when truncated.'),
  }),

  enrichment: {
    notice: z.string().optional().describe('Recovery hint when no records are returned.'),
  },

  errors: [
    {
      reason: 'no_data',
      code: JsonRpcErrorCode.NotFound,
      when: 'No services trade records returned for the given parameters.',
      recovery:
        'Verify the reporter code and period. Use comtrade_get_data_availability with ' +
        'type_code="S" to check which periods have services trade data published.',
    },
    {
      reason: 'api_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The Comtrade API was unreachable or returned an error.',
      recovery:
        'Check network connectivity and COMTRADE_SUBSCRIPTION_KEY if set, then retry after a brief delay.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('comtrade_get_services_trade', {
      reporter: input.reporter_code,
      flow: input.flow_code,
      periods: input.period.length,
    });

    const svc = getComtradeDataService();
    const result = await svc.fetchTradeData(
      {
        reporterCode: input.reporter_code,
        flowCode: input.flow_code,
        period: input.period.join(','),
        ...(input.partner_code !== undefined && { partnerCode: input.partner_code }),
        ...(input.service_code && { cmdCode: input.service_code }),
        typeCode: 'S',
        classificationCode: 'EB10',
        freqCode: 'A',
      },
      ctx.signal,
    );

    if (result.records.length === 0) {
      ctx.enrich.notice(
        `No services trade records found for reporter ${input.reporter_code}, ` +
          `flow=${input.flow_code}, periods=[${input.period.join(', ')}]. ` +
          `Use comtrade_get_data_availability with type_code="S" to verify coverage.`,
      );
      return {
        records: [],
        totalCount: 0,
        shown: 0,
        truncated: false,
      };
    }

    return {
      records: result.records,
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
