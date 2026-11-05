/**
 * @fileoverview Tool for ranking commodity categories by trade value.
 * @module mcp-server/tools/definitions/get-top-commodities.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  flowSchema,
  m49Schema,
  periodFrequency,
  periodSchema,
} from '@/mcp-server/tools/comtrade-input.js';
import { partnerOnlyReporterNotice } from '@/mcp-server/tools/reporter-notice.js';
import { getComtradeDataService } from '@/services/comtrade-data/comtrade-data-service.js';
import { getComtradeReferenceService } from '@/services/comtrade-reference/comtrade-reference-service.js';
import { retrieveCommodityRanking, singlePeriodFailure } from './commodity-ranking.js';

export const getTopCommoditiesTool = tool('comtrade_get_top_commodities', {
  title: 'Get Top Trade Commodities',
  description:
    'Rank HS chapters (2-digit) or headings (4-digit) by trade value for one reporter, flow, and annual or monthly period. Retrieves matching TOTAL and the reporter’s HS edition, then queries explicit commodity codes in chunks; capped chunks are subdivided. Shares use matching TOTAL. Incomplete coverage returns available categories without ranks or shares and identifies unresolved codes. Defaults to World; optionally select one bilateral partner. Counterpart to comtrade_get_top_partners.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  errors: [
    {
      reason: 'keyless_hs_edition_unsupported',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An explicit HS edition requires authenticated access.',
      recovery: 'Use generic HS classification or configure a Comtrade subscription key.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_validation',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'UN Comtrade rejects the supplied query dimensions.',
      recovery: 'Check the reporter, partner, commodity, flow, and period before retrying.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_upstream_response',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'UN Comtrade returns a malformed response.',
      recovery: 'Retry later when UN Comtrade returns valid trade data.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'invalid_reporter_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The query omits required reporter filtering.',
      recovery: 'Supply one reporter code for the commodity ranking query.',
      thrownBy: 'service',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'With TOTAL or the HS reference unavailable, UN Comtrade rate-limited the aggregate fallback through its retries.',
      recovery: 'Wait the number of seconds the error states, then retry the ranking.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'deadline_exceeded',
      code: JsonRpcErrorCode.Timeout,
      when: "With TOTAL or the HS reference unavailable, the aggregate fallback did not complete within the call's time budget.",
      recovery: 'Retry the ranking in a few seconds; it did not finish within its time budget.',
      retryable: true,
      thrownBy: 'service',
    },
  ],

  input: z.object({
    reporter_code: m49Schema.describe('M49 numeric code of the reporting country (0–999).'),
    flow_code: flowSchema.describe('Trade flow: M=imports, X=exports.'),
    period: periodSchema.describe('Single period: annual (YYYY) or monthly (YYYYMM, month 01–12).'),
    aggr_level: z
      .union([z.literal(2), z.literal(4)])
      .default(2)
      .describe('HS aggregation level: 2 = chapter (broader), 4 = heading (more specific).'),
    partner_code: m49Schema
      .optional()
      .describe(
        'M49 partner code (0–999) for a bilateral relationship; omit for World aggregate (0).',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .default(10)
      .describe(
        'Number of top commodity categories to return; totalCommodities counts every category retrieved.',
      ),
  }),

  output: z.object({
    commodities: z
      .array(
        z
          .object({
            rank: z
              .number()
              .optional()
              .describe(
                'Rank (1 = largest trade value), only with complete code coverage and known values.',
              ),
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
              .describe('Share of matching TOTAL trade value, only with complete code coverage.'),
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
      .describe('True when complete commodity-code coverage could not be established.'),
    coverageComplete: z
      .boolean()
      .describe(
        'Whether every code in the matching HS edition was queried without a capped response.',
      ),
    coverageNotice: z.string().describe('Explanation of coverage and ranking availability.'),
    missingCodes: z
      .array(z.string())
      .describe(
        "Codes whose retrieval failed, remained capped, or did not fit the call's time budget; empty when the code universe is unavailable.",
      ),
    classificationCode: z.string().optional().describe('HS edition identified by matching TOTAL.'),
    denominatorValueUsd: z
      .number()
      .optional()
      .describe(
        'Matching TOTAL value used as the share denominator, separate from the retrieved-category sum.',
      ),
  }),

  enrichment: {
    notice: z.string().optional().describe('Recovery hint when no data is returned.'),
  },

  async handler(input, ctx) {
    ctx.log.info('comtrade_get_top_commodities', {
      reporter: input.reporter_code,
      flow: input.flow_code,
      period: input.period,
      aggr_level: input.aggr_level,
    });

    const reference = getComtradeReferenceService();
    const result = await retrieveCommodityRanking(
      getComtradeDataService(),
      reference,
      {
        reporterCode: input.reporter_code,
        flowCode: input.flow_code,
        period: input.period,
        partnerCode: input.partner_code ?? 0,
        classificationCode: 'HS',
        freqCode: periodFrequency(input.period),
      },
      input.aggr_level,
      ctx.signal,
    ).catch((error: unknown) => {
      throw singlePeriodFailure(error);
    });

    if (result.records.length === 0) {
      const status = reference.getReporterStatus(input.reporter_code);
      const partnerOnly = partnerOnlyReporterNotice(input.reporter_code, status);
      ctx.enrich.notice(
        `No commodity data found for reporter ${input.reporter_code}, flow=${input.flow_code}, period=${input.period}. ${partnerOnly ?? 'Use comtrade_get_data_availability to verify data exists.'}`,
      );
      return {
        commodities: [],
        reporterCode: input.reporter_code,
        reporterDesc:
          status.referenceStatus === 'unknown' ? String(input.reporter_code) : status.name,
        period: input.period,
        flowCode: input.flow_code,
        aggrLevel: input.aggr_level,
        totalCommodities: 0,
        truncated: !result.coverageComplete,
        coverageComplete: result.coverageComplete,
        coverageNotice: result.coverageNotice,
        missingCodes: result.missingCodes,
        ...(result.classificationCode && { classificationCode: result.classificationCode }),
        ...(result.denominatorValueUsd != null && {
          denominatorValueUsd: result.denominatorValueUsd,
        }),
      };
    }

    const reporterDesc = result.records[0]?.reporterDesc ?? String(input.reporter_code);

    const sorted = result.records.sort((a, b) => (b.primaryValue ?? 0) - (a.primaryValue ?? 0));
    const totalValueUsd = sorted.reduce((sum, r) => sum + (r.primaryValue ?? 0), 0);
    const totalCommodities = sorted.length;
    const valuesKnown = sorted.every((row) => row.primaryValue != null);
    const sliced = sorted.slice(0, input.limit);

    return {
      commodities: sliced.map((r, i) => ({
        ...(result.coverageComplete && valuesKnown && { rank: i + 1 }),
        cmdCode: r.cmdCode,
        cmdDesc: r.cmdDesc,
        aggrLevel: r.aggrLevel ?? input.aggr_level,
        ...(r.primaryValue != null && { primaryValueUsd: r.primaryValue }),
        ...(result.coverageComplete &&
          result.denominatorValueUsd != null &&
          result.denominatorValueUsd > 0 &&
          r.primaryValue != null && {
            sharePercent: Number(((r.primaryValue / result.denominatorValueUsd) * 100).toFixed(2)),
          }),
      })),
      reporterCode: input.reporter_code,
      reporterDesc,
      period: input.period,
      flowCode: input.flow_code,
      aggrLevel: input.aggr_level,
      totalCommodities,
      ...(valuesKnown && { totalValueUsd }),
      truncated: !result.coverageComplete,
      coverageComplete: result.coverageComplete,
      coverageNotice: result.coverageNotice,
      missingCodes: result.missingCodes,
      ...(result.classificationCode && { classificationCode: result.classificationCode }),
      ...(result.denominatorValueUsd != null && {
        denominatorValueUsd: result.denominatorValueUsd,
      }),
    };
  },

  format: (result) => {
    const flowLabel = result.flowCode === 'X' ? 'Export' : 'Import';
    const levelLabel = result.aggrLevel === 2 ? 'HS Chapter' : 'HS Heading';
    const lines = [
      `Coverage complete: ${result.coverageComplete}; truncated: ${result.truncated}. ${result.coverageNotice}`,
      `Missing codes: ${result.missingCodes.join(', ') || 'none identified'}`,
      `## Top ${flowLabel} Commodities: ${result.reporterDesc} (reporterCode: ${result.reporterCode}) | ${result.period} | ${levelLabel} (aggrLevel: ${result.aggrLevel}) | flowCode: ${result.flowCode}`,
      `**Total Categories:** ${result.totalCommodities}` +
        (result.totalValueUsd != null
          ? ` | **Total Value:** $${result.totalValueUsd.toLocaleString()} USD`
          : ''),
    ];
    if (result.classificationCode != null) lines.push(`HS edition: ${result.classificationCode}`);
    if (result.denominatorValueUsd != null)
      lines.push(`TOTAL denominator: $${result.denominatorValueUsd.toLocaleString()} USD`);
    if (result.truncated) {
      lines.push('> **Note:** Coverage is incomplete; ranks and shares are withheld.');
    }
    for (const c of result.commodities) {
      lines.push(
        `\n**${c.rank == null ? '' : `#${c.rank}. `}${c.cmdCode}** (aggrLevel: ${c.aggrLevel}) — ${c.cmdDesc}`,
      );
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
