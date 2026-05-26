/**
 * @fileoverview Tool for ranking trading partners by trade value for a given commodity.
 * @module mcp-server/tools/definitions/get-top-partners.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getComtradeDataService } from '@/services/comtrade-data/comtrade-data-service.js';

export const getTopPartnersTool = tool('comtrade_get_top_partners', {
  title: 'Get Top Trading Partners',
  description:
    'Rank trading partners for a reporter by trade value for a given commodity and flow direction. ' +
    'Returns the top N partners sorted by descending value — answers "who does country X mainly ' +
    'export product Y to?" or "where does country X mainly import product Z from?" for a single period. ' +
    'Fetches a disaggregated breakdown across all partners then sorts locally. ' +
    'Omit cmd_code to rank partners for total trade.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    reporter_code: z.number().int().describe('M49 numeric code of the reporting country.'),
    flow_code: z.enum(['M', 'X']).describe('Trade flow: M=imports, X=exports.'),
    period: z.string().min(4).describe('Single period: annual (YYYY) or monthly (YYYYMM).'),
    cmd_code: z
      .string()
      .optional()
      .describe(
        'Single HS commodity code (e.g. "84", "8471"). ' +
          'Omit or pass "TOTAL" to rank partners for total merchandise trade.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe('Maximum number of top partners to return.'),
  }),

  output: z.object({
    partners: z
      .array(
        z
          .object({
            rank: z.number().describe('Rank (1 = largest trade value).'),
            partnerCode: z.number().describe('M49 partner code.'),
            partnerDesc: z.string().describe('Partner country/area name.'),
            primaryValueUsd: z
              .number()
              .optional()
              .describe('Trade value in USD (FOB for exports, CIF for imports).'),
            sharePercent: z
              .number()
              .optional()
              .describe('Share of total trade value among returned partners, as a percentage.'),
          })
          .describe('A single ranked trading partner entry.'),
      )
      .describe('Top partners sorted by descending trade value.'),
    reporterCode: z.number().describe('M49 reporter code.'),
    reporterDesc: z.string().describe('Reporter country name.'),
    period: z.string().describe('Period queried.'),
    flowCode: z.string().describe('Flow direction queried.'),
    cmdCode: z.string().describe('Commodity code queried (TOTAL when omitted).'),
    totalPartners: z.number().describe('Total partners with non-zero trade value returned by API.'),
    totalValueUsd: z
      .number()
      .optional()
      .describe('Sum of primary values across all returned partners (before limit truncation).'),
    truncated: z
      .boolean()
      .describe('True when API returned 500 records and results may be incomplete.'),
    notice: z.string().optional().describe('Recovery hint when no data is returned.'),
  }),

  errors: [
    {
      reason: 'no_data',
      code: JsonRpcErrorCode.NotFound,
      when: 'No partner breakdown data returned for the given parameters.',
      recovery:
        'Verify the reporter code and period. Use comtrade_get_data_availability to check ' +
        'which periods have published data, then retry.',
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
    ctx.log.info('comtrade_get_top_partners', {
      reporter: input.reporter_code,
      flow: input.flow_code,
      period: input.period,
    });

    const svc = getComtradeDataService();
    const cmdCode = input.cmd_code || 'TOTAL';

    const result = await svc.fetchTradeData(
      {
        reporterCode: input.reporter_code,
        flowCode: input.flow_code,
        period: input.period,
        cmdCode,
        // No partnerCode filter — get all partners for ranking
      },
      ctx.signal,
    );

    if (result.records.length === 0) {
      const notice =
        `No partner data found for reporter ${input.reporter_code}, ` +
        `flow=${input.flow_code}, period=${input.period}. ` +
        `Use comtrade_get_data_availability to verify data exists.`;
      return {
        partners: [],
        reporterCode: input.reporter_code,
        reporterDesc: String(input.reporter_code),
        period: input.period,
        flowCode: input.flow_code,
        cmdCode,
        totalPartners: 0,
        truncated: false,
        notice,
      };
    }

    const reporterDesc = result.records[0]?.reporterDesc ?? String(input.reporter_code);

    // Sort by primary value descending, filter out partner 0 (World aggregate)
    const sorted = result.records
      .filter((r) => r.partnerCode !== 0)
      .sort((a, b) => (b.primaryValue ?? 0) - (a.primaryValue ?? 0));

    const totalValueUsd = sorted.reduce((sum, r) => sum + (r.primaryValue ?? 0), 0);
    const totalPartners = sorted.length;
    const sliced = sorted.slice(0, input.limit);

    return {
      partners: sliced.map((r, i) => ({
        rank: i + 1,
        partnerCode: r.partnerCode,
        partnerDesc: r.partnerDesc,
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
      cmdCode,
      totalPartners,
      ...(totalValueUsd > 0 && { totalValueUsd }),
      truncated: result.truncated,
    };
  },

  format: (result) => {
    const flowLabel = result.flowCode === 'X' ? 'Export' : 'Import';
    const lines = [
      `## Top ${flowLabel} Partners: ${result.reporterDesc} (reporterCode: ${result.reporterCode}) | ${result.period} | ${result.cmdCode} | flowCode: ${result.flowCode}`,
      `**Total Partners:** ${result.totalPartners}` +
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
    for (const p of result.partners) {
      lines.push(`\n**#${p.rank}. ${p.partnerDesc}** (code ${p.partnerCode})`);
      if (p.primaryValueUsd != null) {
        lines.push(`  Value: $${p.primaryValueUsd.toLocaleString()} USD`);
      }
      if (p.sharePercent != null) {
        lines.push(`  Share: ${p.sharePercent}%`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
