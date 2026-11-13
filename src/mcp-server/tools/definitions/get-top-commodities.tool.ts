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
import { counterpartNotices } from '@/mcp-server/tools/reporter-notice.js';
import { getComtradeDataService } from '@/services/comtrade-data/comtrade-data-service.js';
import { getComtradeReferenceService } from '@/services/comtrade-reference/comtrade-reference-service.js';
import { retrieveCommodityRanking, singlePeriodFailure } from './commodity-ranking.js';

/** Catalogued "Commodities not specified according to kind" codes by native level. */
const RESIDUAL_CODES = { 2: ['99'], 4: ['9999'], 6: ['999999', '9999AA'] } satisfies Record<
  number,
  string[]
>;

const LEVEL_LABEL = { 2: 'Chapter', 4: 'Heading', 6: 'Subheading' } as const;

export const getTopCommoditiesTool = tool('comtrade_get_top_commodities', {
  title: 'Get Top Trade Commodities',
  description:
    'Rank HS chapters (2-digit) or headings (4-digit) by trade value for one reporter, flow, and annual or monthly period. Set parent_code and a deeper aggr_level to rank headings or subheadings within one chapter or heading. The tool uses matching TOTAL to identify the HS edition and queries explicit commodity codes in chunks, subdividing capped chunks. Shares use matching TOTAL or the reported parent value for a drill-down. Incomplete coverage returns available categories without ranks or shares and identifies unresolved codes. Defaults to World; optionally select one bilateral partner. Counterpart to comtrade_get_top_partners.',
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
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'With TOTAL or the HS reference unavailable, the aggregate fallback hit a UN Comtrade server error or network failure through its retries.',
      recovery: 'Wait a minute and retry the same call.',
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

  input: z
    .object({
      reporter_code: m49Schema.describe('M49 numeric code of the reporting country (0–999).'),
      flow_code: flowSchema.describe('Trade flow: M=imports, X=exports.'),
      period: periodSchema.describe(
        'Single period: annual (YYYY) or monthly (YYYYMM, month 01–12).',
      ),
      aggr_level: z
        .union([z.literal(2), z.literal(4), z.literal(6)])
        .default(2)
        .describe(
          'HS aggregation level: 2 = chapter, 4 = heading, 6 = subheading. Level 6 requires parent_code.',
        ),
      parent_code: z
        .string()
        .trim()
        .regex(
          /^(?:[0-9]{2}(?:[0-9]{2})?)?$/,
          'Use a two-digit HS chapter or four-digit HS heading.',
        )
        .optional()
        .describe(
          'Two-digit HS chapter or four-digit heading. Supply a deeper aggr_level. Blank is treated as omitted.',
        ),
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
    })
    .refine(({ aggr_level, parent_code }) => aggr_level !== 6 || Boolean(parent_code), {
      path: ['parent_code'],
      message: 'Level 6 requires a two-digit chapter or four-digit heading in parent_code.',
    })
    .refine(({ aggr_level, parent_code }) => !parent_code || aggr_level > parent_code.length, {
      path: ['aggr_level'],
      message:
        'Supply an explicit aggregation level deeper than parent_code (4 or 6 for a chapter, 6 for a heading).',
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
            aggrLevel: z.number().describe('HS aggregation level (2, 4, or 6).'),
            residual: z
              .boolean()
              .optional()
              .describe(
                'True on a catalogued residual code at this level (99, 9999, 999999 or historical 9999AA), ranked and shared like any other row. Absent on every other row.',
              ),
            primaryValueUsd: z
              .number()
              .optional()
              .describe('Trade value in USD (FOB for exports, CIF for imports).'),
            sharePercent: z
              .number()
              .optional()
              .describe(
                'Share of the matching parent or TOTAL trade value, only with complete code coverage.',
              ),
          })
          .describe('A single ranked commodity entry.'),
      )
      .describe('Top commodity categories sorted by descending trade value.'),
    reporterCode: z.number().describe('M49 reporter code.'),
    reporterDesc: z.string().describe('Reporter country name.'),
    period: z.string().describe('Period queried.'),
    flowCode: z.string().describe('Flow direction queried.'),
    aggrLevel: z.number().describe('HS aggregation level used.'),
    parentCode: z
      .string()
      .optional()
      .describe('HS chapter or heading selected for the drill-down.'),
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
        'Whether complete coverage was established for the matching HS edition and requested scope.',
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
        'Matching parent or TOTAL value used as the share denominator, separate from the retrieved-category sum.',
      ),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery hint when no data is returned, naming the code to query instead of a partner-only reporter_code (250 → 251, 158 → 490) or of a partner_code with a reporter-valid counterpart (840 → 842, 158 → 490); or what a residual row holds when it is on the returned page.',
      ),
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
      input.parent_code || undefined,
    ).catch((error: unknown) => {
      throw singlePeriodFailure(error);
    });

    if (result.records.length === 0) {
      const status = reference.getReporterStatus(input.reporter_code);
      const counterparts = counterpartNotices(reference, input.reporter_code, input.partner_code);
      ctx.enrich.notice(
        `No commodity data found for reporter ${input.reporter_code}, flow=${input.flow_code}, period=${input.period}. ${counterparts.length > 0 ? counterparts.join(' ') : 'Use comtrade_get_data_availability to verify data exists.'}`,
      );
      return {
        commodities: [],
        reporterCode: input.reporter_code,
        reporterDesc:
          status.referenceStatus === 'unknown' ? String(input.reporter_code) : status.name,
        period: input.period,
        flowCode: input.flow_code,
        aggrLevel: input.aggr_level,
        ...(input.parent_code && { parentCode: input.parent_code }),
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
    const residualCodes = RESIDUAL_CODES[input.aggr_level];
    const commodities = sorted.slice(0, input.limit).map((r, i) => ({
      ...(result.coverageComplete && valuesKnown && { rank: i + 1 }),
      cmdCode: r.cmdCode,
      cmdDesc: r.cmdDesc,
      aggrLevel: r.aggrLevel ?? input.aggr_level,
      ...(residualCodes.includes(r.cmdCode) && { residual: true }),
      ...(r.primaryValue != null && { primaryValueUsd: r.primaryValue }),
      ...(result.coverageComplete &&
        result.denominatorValueUsd != null &&
        result.denominatorValueUsd > 0 &&
        r.primaryValue != null && {
          sharePercent: Number(((r.primaryValue / result.denominatorValueUsd) * 100).toFixed(2)),
        }),
    }));
    const residualNotices = commodities
      .filter((row) => row.residual)
      .map((residual) => {
        const figures = [
          ...(residual.primaryValueUsd != null
            ? [`${residual.primaryValueUsd.toLocaleString()} USD`]
            : []),
          ...(residual.sharePercent != null
            ? [
                `${residual.sharePercent}% of matching ${input.parent_code ? `parent ${input.parent_code}` : 'TOTAL'}`,
              ]
            : []),
        ];
        const code = `Code ${residual.cmdCode}${figures.length > 0 ? ` (${figures.join(', ')})` : ''}`;
        if (input.aggr_level === 6) return `${code} is a residual subheading in this HS edition.`;
        const lead = `${code} holds trade not allocated to a ${input.aggr_level === 2 ? 'chapter' : 'heading'}, not a product category`;
        return input.aggr_level === 2
          ? `${lead}.`
          : `${lead}; that includes chapter-level trade the reporter withholds from headings, so 9999 can exceed chapter 99.`;
      });
    if (residualNotices.length > 0) ctx.enrich.notice(residualNotices.join(' '));

    return {
      commodities,
      reporterCode: input.reporter_code,
      reporterDesc,
      period: input.period,
      flowCode: input.flow_code,
      aggrLevel: input.aggr_level,
      ...(input.parent_code && { parentCode: input.parent_code }),
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
    const levelLabel = `HS ${result.aggrLevel === 6 ? LEVEL_LABEL[6] : result.aggrLevel === 4 ? LEVEL_LABEL[4] : LEVEL_LABEL[2]}`;
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
    if (result.parentCode != null) lines.push(`Parent code: ${result.parentCode}`);
    if (result.denominatorValueUsd != null)
      lines.push(
        `${result.parentCode ? `Parent ${result.parentCode}` : 'TOTAL'} denominator: $${result.denominatorValueUsd.toLocaleString()} USD`,
      );
    if (result.truncated) {
      lines.push('> **Note:** Coverage is incomplete; ranks and shares are withheld.');
    }
    for (const c of result.commodities) {
      lines.push(
        `\n**${c.rank == null ? '' : `#${c.rank}. `}${c.cmdCode}** (aggrLevel: ${c.aggrLevel}) — ${c.cmdDesc}`,
      );
      if (c.residual) lines.push('  Residual: true');
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
