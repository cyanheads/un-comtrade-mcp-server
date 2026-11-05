/**
 * @fileoverview Tool for ranking trading partners by trade value for a given commodity.
 * @module mcp-server/tools/definitions/get-top-partners.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  codeSchema,
  flowSchema,
  GOODS_CODE_SHAPE_MESSAGE,
  goodsClassificationSchema,
  goodsCodesMatchClassification,
  m49Schema,
  periodFrequency,
  periodSchema,
} from '@/mcp-server/tools/comtrade-input.js';
import { partnerOnlyReporterNotice } from '@/mcp-server/tools/reporter-notice.js';
import { getComtradeDataService } from '@/services/comtrade-data/comtrade-data-service.js';
import { getComtradeReferenceService } from '@/services/comtrade-reference/comtrade-reference-service.js';
import { singlePeriodFailure } from './commodity-ranking.js';

export const getTopPartnersTool = tool('comtrade_get_top_partners', {
  title: 'Get Top Trading Partners',
  description:
    'Rank trading partners for a reporter by trade value for a given commodity and flow direction. Returns the top N partners sorted by descending value — answers "who does country X mainly export product Y to?" or "where does country X mainly import product Z from?" for a single period. Fetches a disaggregated breakdown across all partners then sorts locally. Takes an HS or SITC code in the selected classification; omit cmd_code to rank partners for total trade.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  errors: [
    {
      reason: 'keyless_hs_edition_unsupported',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An explicit HS edition H0–H6 requires authenticated access.',
      recovery:
        'Use HS for as-reported rows or configure authenticated access for an explicit edition.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_reporter_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Reporter omission lacks an explicit partner.',
      recovery: 'Supply one reporter_code for this partner ranking query.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_validation',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'UN Comtrade rejects the query dimensions.',
      recovery: 'Check reporter, commodity, flow and period before retrying.',
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
      when: 'UN Comtrade rate-limited the ranking request through its retries.',
      recovery: 'Wait the number of seconds the error states, then retry the ranking.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'deadline_exceeded',
      code: JsonRpcErrorCode.Timeout,
      when: "The ranking request did not complete within the call's time budget.",
      recovery: 'Retry the ranking in a few seconds; it did not finish within its time budget.',
      retryable: true,
      thrownBy: 'service',
    },
  ],

  input: z
    .object({
      reporter_code: m49Schema.describe('M49 numeric code of the reporting country (0–999).'),
      flow_code: flowSchema.describe('Trade flow: M=imports, X=exports.'),
      period: periodSchema.describe(
        'Single period: annual YYYY or monthly YYYYMM, month 01–12; frequency is inferred.',
      ),
      cmd_code: codeSchema
        .optional()
        .describe(
          'Single goods code in the selected classification: HS (e.g. "84", "8471") or SITC (e.g. "071"). Omit or pass "TOTAL" to rank partners for total merchandise trade.',
        ),
      classification: goodsClassificationSchema
        .default('HS')
        .describe(
          'Goods classification: HS as reported, H0–H6 with authenticated access, or SITC S1–S4/SS.',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .default(10)
        .describe(
          'Number of top partners to return; totalPartners counts every partner retrieved.',
        ),
    })
    .refine(goodsCodesMatchClassification, {
      path: ['cmd_code'],
      message: GOODS_CODE_SHAPE_MESSAGE,
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
              .describe('Share of totalValueUsd across every retrieved partner, as a percentage.'),
          })
          .describe('A single ranked trading partner entry.'),
      )
      .describe('Top partners sorted by descending trade value.'),
    reporterCode: z.number().describe('M49 reporter code.'),
    reporterDesc: z.string().describe('Reporter country name.'),
    period: z.string().describe('Period queried.'),
    flowCode: z.string().describe('Flow direction queried.'),
    cmdCode: z.string().describe('Commodity code queried (TOTAL when omitted).'),
    classification: z.string().describe('Goods classification the commodity code was read in.'),
    totalPartners: z
      .number()
      .describe('Partners retrieved before the limit, excluding the World (0) aggregate.'),
    totalValueUsd: z
      .number()
      .optional()
      .describe('Sum of primary values across all returned partners (before limit truncation).'),
    truncated: z
      .boolean()
      .describe('True when API returned 500 records and results may be incomplete.'),
  }),

  enrichment: {
    referenceNotice: z
      .string()
      .optional()
      .describe('Reference descriptions unavailable; codes and values retained.'),
    notice: z.string().optional().describe('Recovery hint when no data is returned.'),
  },

  async handler(input, ctx) {
    ctx.log.info('comtrade_get_top_partners', {
      reporter: input.reporter_code,
      flow: input.flow_code,
      period: input.period,
    });

    const cmdCode = input.cmd_code || 'TOTAL';

    const result = await getComtradeDataService()
      .fetchTradeData(
        {
          reporterCode: input.reporter_code,
          flowCode: input.flow_code,
          period: input.period,
          cmdCode,
          classificationCode: input.classification,
          freqCode: periodFrequency(input.period),
          // No partnerCode filter — get all partners for ranking
        },
        ctx.signal,
      )
      .catch((error: unknown) => {
        throw singlePeriodFailure(error);
      });
    if (result.referenceNotice) ctx.enrich({ referenceNotice: result.referenceNotice });

    if (result.records.length === 0) {
      const status = getComtradeReferenceService().getReporterStatus(input.reporter_code);
      const partnerOnly = partnerOnlyReporterNotice(input.reporter_code, status);
      ctx.enrich.notice(
        `No partner data found for reporter ${input.reporter_code}, flow=${input.flow_code}, period=${input.period}. ${partnerOnly ?? 'Use comtrade_get_data_availability to verify data exists.'}`,
      );
      return {
        partners: [],
        reporterCode: input.reporter_code,
        reporterDesc:
          status.referenceStatus === 'unknown' ? String(input.reporter_code) : status.name,
        period: input.period,
        flowCode: input.flow_code,
        cmdCode,
        classification: input.classification,
        totalPartners: 0,
        truncated: result.truncated,
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
      classification: input.classification,
      totalPartners,
      ...(totalValueUsd > 0 && { totalValueUsd }),
      truncated: result.truncated,
    };
  },

  format: (result) => {
    const flowLabel = result.flowCode === 'X' ? 'Export' : 'Import';
    const lines = [
      `## Top ${flowLabel} Partners: ${result.reporterDesc} (reporterCode: ${result.reporterCode}) | ${result.period} | ${result.classification} ${result.cmdCode} | flowCode: ${result.flowCode}`,
      `**Total Partners:** ${result.totalPartners}` +
        (result.totalValueUsd != null
          ? ` | **Total Value:** $${result.totalValueUsd.toLocaleString()} USD`
          : ''),
    ];
    if (result.truncated) {
      lines.push(`> **Note:** Results may be truncated at 500 records (preview endpoint limit).`);
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
