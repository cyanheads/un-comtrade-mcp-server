/**
 * @fileoverview Ranks the reporting areas returned for one goods trade query.
 * @module mcp-server/tools/definitions/get-top-reporters.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import {
  codeSchema,
  flowSchema,
  goodsClassificationSchema,
  m49Schema,
  periodFrequency,
  periodSchema,
  SINGLE_GOODS_CODE_SHAPE_MESSAGE,
  singleGoodsCodeMatchesClassification,
} from '@/mcp-server/tools/comtrade-input.js';
import { getComtradeDataService } from '@/services/comtrade-data/comtrade-data-service.js';
import { getComtradeReferenceService } from '@/services/comtrade-reference/comtrade-reference-service.js';
import { COMMODITY_CLASSIFICATIONS, HS_EDITIONS } from '@/services/comtrade-reference/types.js';
import { singlePeriodFailure } from './commodity-ranking.js';

interface ReporterValue {
  primaryValueUsd?: number;
  referenceCaveat?: string;
  reporterCode: number;
  reporterDesc: string;
}

/** Goods reporter ranking across the reporting areas retrieved by UN Comtrade. */
export const getTopReportersTool = tool('comtrade_get_top_reporters', {
  title: 'Get Top Goods Reporters',
  description:
    'Rank retrieved reporting areas by reported import or export value for one goods code and period. Partner 0 (World) ranks reporters by their trade with all partners. Use a bilateral partner to rank reporters by their trade with that area. Shares use the retrieved reporting areas before the display limit. Use comtrade_get_top_partners to rank the partners of one reporter.',
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
      reason: 'upstream_validation',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'UN Comtrade rejects the query dimensions.',
      recovery: 'Check partner, commodity, flow and period before retrying.',
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
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The ranking request hit a UN Comtrade server error or network failure through its retries.',
      recovery: 'Wait a minute and retry the same call.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'deadline_exceeded',
      code: JsonRpcErrorCode.Timeout,
      when: "The ranking request did not complete within the call's time budget.",
      recovery: 'Retry the ranking in a few seconds after the time budget expires.',
      retryable: true,
      thrownBy: 'service',
    },
  ],
  input: z
    .strictObject({
      flow_code: flowSchema.describe('Trade flow: M=imports, X=exports.'),
      period: periodSchema.describe(
        'One annual YYYY or monthly YYYYMM period. Frequency is inferred.',
      ),
      cmd_code: codeSchema
        .optional()
        .describe(
          'One commodity code in the selected HS or SITC classification. Omit or pass TOTAL for total merchandise trade.',
        ),
      classification: goodsClassificationSchema
        .default('HS')
        .describe(
          'Goods classification: HS as reported, H0–H6 with authenticated access, or SITC S1–S4/SS.',
        ),
      partner_code: m49Schema
        .default(0)
        .describe('M49 partner code (0–999). Defaults to World (0).'),
      limit: z
        .number()
        .int()
        .min(1)
        .default(10)
        .describe(
          'Maximum reporting areas displayed. Totals cover all eligible retrieved reporting areas.',
        ),
    })
    .refine(singleGoodsCodeMatchesClassification, {
      path: ['cmd_code'],
      message: SINGLE_GOODS_CODE_SHAPE_MESSAGE,
    }),
  output: z.object({
    reporters: z
      .array(
        z
          .object({
            reporterCode: z.number().describe('UN Comtrade reporting area code.'),
            reporterDesc: z
              .string()
              .describe('Reporting area name or code when the name is unavailable.'),
            primaryValueUsd: z
              .number()
              .optional()
              .describe('Reported primary trade value in USD, when known.'),
            rank: z
              .number()
              .optional()
              .describe(
                'Position by value across the eligible retrieved reporting areas, when established.',
              ),
            sharePercent: z
              .number()
              .optional()
              .describe(
                'Percentage of totalValueUsd, when ranks are established and the total is nonzero.',
              ),
            referenceCaveat: z
              .string()
              .optional()
              .describe('Why the reference catalog could not verify this area as a reporter.'),
          })
          .describe('One retrieved reporting area and its available trade value and rank.'),
      )
      .describe(
        'Retrieved reporting areas sorted by descending known value, then code, with unresolved values last.',
      ),
    partnerCode: z.number().describe('Partner code queried (0 = World).'),
    period: z.string().describe('Period queried.'),
    flowCode: z.string().describe('Flow direction queried.'),
    cmdCode: z.string().describe('Commodity code queried (TOTAL when omitted).'),
    classification: z.string().describe('Goods classification queried.'),
    totalReporters: z
      .number()
      .describe('Eligible retrieved reporting areas before the display limit.'),
    totalValueUsd: z
      .number()
      .optional()
      .describe(
        'Sum in USD across eligible retrieved reporting areas before the display limit, whether or not retrieval was capped. Omitted for an empty set or any unresolved value.',
      ),
    truncated: z
      .boolean()
      .describe(
        'True when the upstream retrieval may be incomplete due to a detected limit or failed slice. Independent of the display limit.',
      ),
    coverageNotice: z
      .string()
      .describe('Scope of the retrieved data and any conditions that prevent ranking.'),
  }),
  enrichment: {
    referenceNotice: z
      .string()
      .optional()
      .describe('Reference descriptions unavailable; trade values retained.'),
  },

  async handler(input, ctx) {
    const cmdCode = input.cmd_code || 'TOTAL';
    const result = await getComtradeDataService()
      .fetchTradeData(
        {
          cmdCode,
          classificationCode: input.classification,
          flowCode: input.flow_code,
          freqCode: periodFrequency(input.period),
          partnerCode: input.partner_code,
          period: input.period,
        },
        ctx.signal,
      )
      .catch((error: unknown) => {
        throw singlePeriodFailure(error);
      });
    ctx.signal.throwIfAborted();
    if (result.referenceNotice) ctx.enrich({ referenceNotice: result.referenceNotice });

    const reference = getComtradeReferenceService();
    const byReporter = new Map<number, ReporterValue>();
    let unresolvedClassification = false;
    for (const row of result.records) {
      const code = row.reporterCode;
      const matchesClassification =
        row.classificationCode === undefined ||
        row.classificationCode === input.classification ||
        (input.classification === 'HS' &&
          HS_EDITIONS.some((edition) => edition === row.classificationCode)) ||
        (input.classification === 'SS' &&
          COMMODITY_CLASSIFICATIONS.some(
            (edition) => edition.startsWith('S') && edition === row.classificationCode,
          ));
      if (
        code === 0 ||
        row.partnerCode !== input.partner_code ||
        row.period !== input.period ||
        row.flowCode !== input.flow_code ||
        row.cmdCode !== cmdCode ||
        !matchesClassification
      )
        continue;

      const area = reference.getCountryByCode(code);
      // Comtrade marks 490 as a group but uses it as a distinct goods reporting area.
      if (area?.validAsReporter && area.isGroup && code !== 490) continue;
      if (row.classificationCode === undefined) unresolvedClassification = true;

      const previous = byReporter.get(code);
      if (previous) {
        if (previous.primaryValueUsd !== row.primaryValue) delete previous.primaryValueUsd;
        continue;
      }
      byReporter.set(code, {
        reporterCode: code,
        reporterDesc: area?.name ?? row.reporterDesc,
        ...(row.primaryValue !== undefined && { primaryValueUsd: row.primaryValue }),
        ...(!area?.validAsReporter && {
          referenceCaveat: area
            ? 'This code is listed as a partner only in UN Comtrade reference data.'
            : 'This code is absent from UN Comtrade reporter and partner reference data.',
        }),
      });
    }

    const sorted = [...byReporter.values()].sort(
      (a, b) =>
        (b.primaryValueUsd ?? -Infinity) - (a.primaryValueUsd ?? -Infinity) ||
        a.reporterCode - b.reporterCode,
    );
    const totalReporters = sorted.length;
    let sum = 0;
    let unresolvedValues = false;
    for (const { primaryValueUsd } of sorted) {
      if (primaryValueUsd === undefined) {
        unresolvedValues = true;
        break;
      }
      sum += primaryValueUsd;
    }
    const totalValueUsd = totalReporters > 0 && !unresolvedValues ? sum : undefined;
    const ambiguousIdentity = sorted.some((row) => row.referenceCaveat !== undefined);
    const truncated = result.truncated || Boolean(result.failedPeriods?.length);

    const coverage = [
      'Coverage is limited to retrieved reporting areas for this commodity, partner, flow and period. Mirror trade is a separate view.',
    ];
    if (totalReporters === 0)
      coverage.push(
        'No matching reporting areas were returned. Use comtrade_get_data_availability to check the period and classification.',
      );
    if (truncated) coverage.push(result.truncationHint ?? 'The upstream retrieval was incomplete.');
    if (unresolvedValues)
      coverage.push('Some reporting areas have missing or conflicting trade values.');
    if (ambiguousIdentity)
      coverage.push(
        'Some reporting area identities could not be verified against the reporter reference.',
      );
    if (unresolvedClassification)
      coverage.push(
        'Some retained rows lack a classification code and the classification match cannot be confirmed.',
      );
    const canRank =
      !truncated && !unresolvedValues && !ambiguousIdentity && !unresolvedClassification;
    if (!canRank) coverage.push('Ranks and shares are withheld.');

    return {
      reporters: sorted.slice(0, input.limit).map((row, index) => ({
        ...row,
        ...(canRank && { rank: index + 1 }),
        ...(canRank &&
          totalValueUsd &&
          row.primaryValueUsd !== undefined && {
            sharePercent: Number(((row.primaryValueUsd / totalValueUsd) * 100).toFixed(2)),
          }),
      })),
      partnerCode: input.partner_code,
      period: input.period,
      flowCode: input.flow_code,
      cmdCode,
      classification: input.classification,
      totalReporters,
      ...(totalValueUsd !== undefined && { totalValueUsd }),
      truncated,
      coverageNotice: coverage.join(' '),
    };
  },

  format: (result) => {
    const lines = [
      `## Goods reporters | ${result.period} | ${result.classification} ${result.cmdCode} | flowCode: ${result.flowCode} | partnerCode: ${result.partnerCode}`,
      `**Retrieved reporting areas:** ${result.totalReporters} | **Upstream truncated:** ${result.truncated}`,
      result.coverageNotice,
    ];
    if (result.totalValueUsd !== undefined) {
      lines.push(`**Total value of retrieved reporting areas:** ${result.totalValueUsd} USD`);
    }
    for (const row of result.reporters) {
      lines.push(`\n**${escapeMarkdownInline(row.reporterDesc)}** (code ${row.reporterCode})`);
      if (row.primaryValueUsd !== undefined) lines.push(`- Value: ${row.primaryValueUsd} USD`);
      if (row.rank !== undefined) lines.push(`- Rank: ${row.rank}`);
      if (row.sharePercent !== undefined) lines.push(`- Share: ${row.sharePercent}%`);
      if (row.referenceCaveat) lines.push(`- ${row.referenceCaveat}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
