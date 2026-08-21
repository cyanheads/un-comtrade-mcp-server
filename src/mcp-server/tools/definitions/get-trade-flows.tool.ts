/**
 * @fileoverview Primary bilateral trade flow data retrieval tool.
 * @module mcp-server/tools/definitions/get-trade-flows.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getComtradeDataService } from '@/services/comtrade-data/comtrade-data-service.js';

const TradeFlowRecordSchema = z.object({
  reporterCode: z.number().describe('M49 reporter code.'),
  reporterDesc: z.string().describe('Reporter country/area name.'),
  partnerCode: z.number().describe('M49 partner code.'),
  partnerDesc: z.string().describe('Partner country/area name.'),
  flowCode: z.string().describe('Trade flow: M=import, X=export, RX=re-export, RM=re-import.'),
  cmdCode: z.string().describe('HS commodity code or "TOTAL".'),
  cmdDesc: z.string().describe('Commodity description.'),
  period: z.string().describe('Period (YYYY for annual, YYYYMM for monthly).'),
  primaryValue: z
    .number()
    .optional()
    .describe('Primary trade value in USD (FOB for exports, CIF for imports).'),
  fobvalue: z.number().optional().describe('Free-on-board value in USD (exports only).'),
  cifvalue: z.number().optional().describe('Cost-insurance-freight value in USD (imports only).'),
  qty: z
    .number()
    .optional()
    .describe('Quantity in commodity-specific units. Often null for aggregated rows.'),
  netWgt: z.number().optional().describe('Net weight in kg. Often null for aggregated rows.'),
  grossWgt: z.number().optional().describe('Gross weight in kg.'),
  isReported: z
    .boolean()
    .optional()
    .describe('True if directly reported; false if estimated or aggregated by UN.'),
  aggrLevel: z.number().optional().describe('HS aggregation level (2, 4, or 6).'),
});

export const getTradeFlowsTool = tool('comtrade_get_trade_flows', {
  title: 'Get Trade Flow Records',
  description:
    'Fetch bilateral trade flow records — the primary data retrieval tool. ' +
    'Returns trade value in USD (primaryValue — FOB for exports, CIF for imports), ' +
    'quantity, net weight, and period/commodity/partner metadata for each row. ' +
    'Accepts multiple periods and commodity codes per call; pass partner_code 0 to get ' +
    'totals aggregated across all partners. Omit cmd_code or pass "TOTAL" to aggregate ' +
    'all commodities. Free-tier capped at 500 records per call. ' +
    'Use comtrade_lookup_countries to resolve reporter/partner codes and ' +
    'comtrade_search_commodities to resolve HS codes before calling this tool.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    reporter_code: z
      .number()
      .int()
      .describe(
        'M49 numeric code of the reporting country. Use comtrade_lookup_countries to resolve names to codes.',
      ),
    flow_code: z
      .enum(['M', 'X', 'RX', 'RM'])
      .describe('Trade flow direction: M=imports, X=exports, RX=re-exports, RM=re-imports.'),
    period: z
      .array(z.string().min(4))
      .min(1)
      .max(12)
      .describe(
        'One or more periods to query. Annual: "YYYY" (e.g. ["2022", "2023"]). ' +
          'Monthly: "YYYYMM" (e.g. ["202201", "202202"]). Maximum 12 periods per call.',
      ),
    partner_code: z
      .number()
      .int()
      .optional()
      .describe(
        'M49 code of the trade partner. ' +
          'Use 0 to aggregate across all partners (World total). ' +
          'Omit to get a disaggregated breakdown by partner country.',
      ),
    cmd_code: z
      .array(z.string())
      .max(20)
      .optional()
      .describe(
        'HS commodity codes to query. Maximum 20 codes per call. ' +
          'Pass ["TOTAL"] or omit to aggregate all commodities. ' +
          'Use comtrade_search_commodities to find the right codes.',
      ),
    classification: z
      .enum(['HS', 'H0', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'])
      .default('HS')
      .describe('HS classification version. "HS" covers the combined dataset.'),
    freq: z.enum(['A', 'M']).default('A').describe('Frequency: A=annual, M=monthly.'),
  }),

  output: z.object({
    records: z
      .array(TradeFlowRecordSchema.describe('A single bilateral trade flow record.'))
      .describe('Trade flow records.'),
    totalCount: z.number().describe('Total matching records reported by the API.'),
    shown: z.number().describe('Number of records returned in this response.'),
    truncated: z
      .boolean()
      .describe('True when results were capped at 500 (public preview endpoint limit).'),
    truncationHint: z
      .string()
      .optional()
      .describe('How to get more data when truncated — requires a subscription key.'),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Recovery hint when no records are returned. Absent on successful responses.'),
  },

  errors: [
    {
      reason: 'no_data',
      code: JsonRpcErrorCode.NotFound,
      when: 'The API returned no trade flow records for the given parameters.',
      recovery:
        'Verify the reporter code, period, and flow direction. ' +
        'Use comtrade_get_data_availability to check which periods have published data.',
    },
    {
      reason: 'api_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The Comtrade API returned an error or was unreachable.',
      recovery:
        'Check your COMTRADE_SUBSCRIPTION_KEY if set, verify network access, and retry after a brief delay.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('comtrade_get_trade_flows', {
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
        ...(input.cmd_code?.length && { cmdCode: input.cmd_code.join(',') }),
        classificationCode: input.classification,
        freqCode: input.freq,
      },
      ctx.signal,
    );

    if (result.records.length === 0) {
      ctx.enrich.notice(
        `No trade flow records found for reporter ${input.reporter_code}, ` +
          `flow=${input.flow_code}, periods=[${input.period.join(', ')}]. ` +
          `Use comtrade_get_data_availability to check if data exists for this period.`,
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
          (r.aggrLevel != null ? ` (HS-${r.aggrLevel})` : ''),
      );
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
