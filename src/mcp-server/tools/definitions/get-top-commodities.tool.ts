/**
 * @fileoverview Tool for ranking commodity categories by trade value.
 * @module mcp-server/tools/definitions/get-top-commodities.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getComtradeDataService } from '@/services/comtrade-data/comtrade-data-service.js';

export const getTopCommoditiesTool = tool('comtrade_get_top_commodities', {
  title: 'Get Top Trade Commodities',
  description:
    'Rank commodity categories for a reporter by trade value for a given flow direction and period. ' +
    'Returns the top N HS chapters (2-digit) or headings (4-digit) sorted by descending value — ' +
    'answers "what does country X mainly export?" or "what does country X mainly import?". ' +
    'Symmetric counterpart to comtrade_get_top_partners. ' +
    'Optionally filter to a single partner country.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    reporter_code: z.number().int().describe('M49 numeric code of the reporting country.'),
    flow_code: z.enum(['M', 'X']).describe('Trade flow: M=imports, X=exports.'),
    period: z.string().min(4).describe('Single period: annual (YYYY) or monthly (YYYYMM).'),
    aggr_level: z
      .union([z.literal(2), z.literal(4)])
      .default(2)
      .describe('HS aggregation level: 2 = chapter (broader), 4 = heading (more specific).'),
    partner_code: z
      .number()
      .int()
      .optional()
      .describe(
        'M49 partner code to filter to a specific bilateral relationship. ' +
          'Omit to rank commodities across all partners.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe('Maximum number of top commodity categories to return.'),
  }),

  output: z.object({
    commodities: z
      .array(
        z
          .object({
            rank: z.number().describe('Rank (1 = largest trade value).'),
            cmdCode: z.string().describe('HS commodity code.'),
            cmdDesc: z.string().describe('Commodity description.'),
            aggrLevel: z.number().describe('HS aggregation level (2 or 4).'),
            primaryValueUsd: z
              .number()
              .optional()
              .describe('Trade value in USD (FOB for exports, CIF for imports).'),
            sharePercent: z
              .number()
              .optional()
              .describe('Share of total trade value among returned commodities, as a percentage.'),
          })
          .describe('A single ranked commodity entry.'),
      )
      .describe('Top commodity categories sorted by descending trade value.'),
    reporterCode: z.number().describe('M49 reporter code.'),
    reporterDesc: z.string().describe('Reporter country name.'),
    period: z.string().describe('Period queried.'),
    flowCode: z.string().describe('Flow direction queried.'),
    aggrLevel: z.number().describe('HS aggregation level used.'),
    totalCommodities: z.number().describe('Total commodity categories returned by API.'),
    totalValueUsd: z
      .number()
      .optional()
      .describe('Sum of primary values across all returned categories (before limit).'),
    truncated: z
      .boolean()
      .describe('True when API returned 500 records and results may be incomplete.'),
    notice: z.string().optional().describe('Recovery hint when no data is returned.'),
  }),

  errors: [
    {
      reason: 'no_data',
      code: JsonRpcErrorCode.NotFound,
      when: 'No commodity breakdown data returned for the given parameters.',
      recovery:
        'Verify the reporter code and period. Use comtrade_get_data_availability to confirm ' +
        'data is published, then retry.',
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
    ctx.log.info('comtrade_get_top_commodities', {
      reporter: input.reporter_code,
      flow: input.flow_code,
      period: input.period,
      aggr_level: input.aggr_level,
    });

    const svc = getComtradeDataService();

    const result = await svc.fetchTradeData(
      {
        reporterCode: input.reporter_code,
        flowCode: input.flow_code,
        period: input.period,
        ...(input.partner_code !== undefined && { partnerCode: input.partner_code }),
        aggrLevel: input.aggr_level,
      },
      ctx.signal,
    );

    if (result.records.length === 0) {
      const notice =
        `No commodity data found for reporter ${input.reporter_code}, ` +
        `flow=${input.flow_code}, period=${input.period}. ` +
        `Use comtrade_get_data_availability to verify data exists.`;
      return {
        commodities: [],
        reporterCode: input.reporter_code,
        reporterDesc: String(input.reporter_code),
        period: input.period,
        flowCode: input.flow_code,
        aggrLevel: input.aggr_level,
        totalCommodities: 0,
        truncated: false,
        notice,
      };
    }

    const reporterDesc = result.records[0]?.reporterDesc ?? String(input.reporter_code);

    // Filter to the requested aggr_level and exclude TOTAL rows.
    // The Comtrade preview endpoint returns aggrLevel=null for all records — infer from code length.
    const inferAggrLevel = (cmdCode: string): 2 | 4 | 6 =>
      cmdCode.length <= 2 ? 2 : cmdCode.length <= 4 ? 4 : 6;
    const rows = result.records.filter(
      (r) =>
        r.cmdCode !== 'TOTAL' && (r.aggrLevel ?? inferAggrLevel(r.cmdCode)) === input.aggr_level,
    );

    const sorted = rows.sort((a, b) => (b.primaryValue ?? 0) - (a.primaryValue ?? 0));
    const totalValueUsd = sorted.reduce((sum, r) => sum + (r.primaryValue ?? 0), 0);
    const totalCommodities = sorted.length;
    const sliced = sorted.slice(0, input.limit);

    return {
      commodities: sliced.map((r, i) => ({
        rank: i + 1,
        cmdCode: r.cmdCode,
        cmdDesc: r.cmdDesc,
        aggrLevel: r.aggrLevel ?? input.aggr_level,
        ...(r.primaryValue != null && { primaryValueUsd: r.primaryValue }),
        ...(totalValueUsd > 0 &&
          r.primaryValue != null && {
            sharePercent: Number(((r.primaryValue / totalValueUsd) * 100).toFixed(2)),
          }),
      })),
      reporterCode: input.reporter_code,
      reporterDesc,
      period: input.period,
      flowCode: input.flow_code,
      aggrLevel: input.aggr_level,
      totalCommodities,
      ...(totalValueUsd > 0 && { totalValueUsd }),
      truncated: result.truncated,
    };
  },

  format: (result) => {
    const flowLabel = result.flowCode === 'X' ? 'Export' : 'Import';
    const levelLabel = result.aggrLevel === 2 ? 'HS Chapter' : 'HS Heading';
    const lines = [
      `## Top ${flowLabel} Commodities: ${result.reporterDesc} (reporterCode: ${result.reporterCode}) | ${result.period} | ${levelLabel} (aggrLevel: ${result.aggrLevel}) | flowCode: ${result.flowCode}`,
      `**Total Categories:** ${result.totalCommodities}` +
        (result.totalValueUsd != null
          ? ` | **Total Value:** $${result.totalValueUsd.toLocaleString()} USD`
          : ''),
    ];
    if (result.truncated) {
      lines.push(`> **Note:** Results may be truncated at 500 records (preview endpoint limit).`);
    }
    if (result.notice) {
      lines.push(`\n> ${result.notice}`);
    }
    for (const c of result.commodities) {
      lines.push(`\n**#${c.rank}. ${c.cmdCode}** (aggrLevel: ${c.aggrLevel}) — ${c.cmdDesc}`);
      if (c.primaryValueUsd != null) {
        lines.push(`  Value: $${c.primaryValueUsd.toLocaleString()} USD`);
      }
      if (c.sharePercent != null) {
        lines.push(`  Share: ${c.sharePercent}%`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
