/**
 * @fileoverview Ranks partners for one annual EBOPS trade series.
 * @module mcp-server/tools/definitions/get-top-services-partners.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import {
  annualPeriodSchema,
  codeSchema,
  flowSchema,
  m49Schema,
  servicesClassificationSchema,
} from '@/mcp-server/tools/comtrade-input.js';
import { servicesEmptyNotice } from '@/mcp-server/tools/services-empty-notice.js';
import {
  getComtradeDataService,
  TRADE_DATA_DEADLINE_MS,
} from '@/services/comtrade-data/comtrade-data-service.js';
import { getComtradeReferenceService } from '@/services/comtrade-reference/comtrade-reference-service.js';
import { singlePeriodFailure } from './commodity-ranking.js';

const totalCodes = new Map([
  ['EB02', '200'],
  ['EB10', '200'],
  ['EB10S', 'S'],
]);

interface PartnerValue {
  partnerCode: number;
  partnerDesc: string;
  primaryValueUsd?: number;
}

/** Partner ranking over the retrieved services breakdown for one EBOPS series. */
export const getTopServicesPartnersTool = tool('comtrade_get_top_services_partners', {
  title: 'Get Top Services Trading Partners',
  description:
    'Rank partners of one reporter by trade value for a single annual EBOPS series. Omit service_code for total services, or use comtrade_list_service_categories to find one category. EB serves original reports, while EB10 and EB02 serve converted series. Shares divide by the sum of eligible retrieved partners before the display limit. Read coverageNotice before interpreting the ranking.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  errors: [
    {
      reason: 'upstream_validation',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'UN Comtrade rejects the query dimensions.',
      recovery: 'Check the reporter, service category, flow and annual period before retrying.',
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
      when: 'UN Comtrade rate-limits the ranking request through its retries.',
      recovery: 'Wait a few seconds and retry the same ranking.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The ranking request hits an upstream server or network failure through its retries.',
      recovery: 'Wait a minute and retry the same call.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'deadline_exceeded',
      code: JsonRpcErrorCode.Timeout,
      when: 'The ranking request does not complete within its time budget.',
      recovery: 'Retry the same ranking after a few seconds.',
      retryable: true,
      thrownBy: 'service',
    },
  ],
  input: z
    .strictObject({
      reporter_code: m49Schema.describe('M49 numeric code of the reporting area (0–999).'),
      flow_code: flowSchema.describe('Trade flow: M=imports, X=exports.'),
      period: annualPeriodSchema.describe('One annual period, YYYY.'),
      service_code: codeSchema
        .optional()
        .describe('One EBOPS service code. Omit or pass blank for total services.'),
      classification: servicesClassificationSchema.describe(
        'EB for as-reported data (default), or EB10 or EB02 for UN Comtrade’s converted series.',
      ),
      limit: z
        .number()
        .int()
        .min(1)
        .default(10)
        .describe('Number of partners to display. Counts and sums precede the display limit.'),
    })
    .refine(({ service_code }) => !/^AG\d+$/.test(service_code ?? ''), {
      path: ['service_code'],
      message: 'Use one EBOPS code, such as SG, or omit service_code for total services.',
    }),
  output: z.object({
    partners: z
      .array(
        z
          .object({
            partnerCode: z.number().describe('M49 partner code.'),
            partnerDesc: z.string().describe('Partner country or area name.'),
            primaryValueUsd: z.number().optional().describe('Reported trade value in USD.'),
            rank: z.number().optional().describe('Rank when the retrieved series can be ranked.'),
            sharePercent: z
              .number()
              .optional()
              .describe('Percentage of the eligible retrieved partner value.'),
          })
          .describe('One partner in the selected services series.'),
      )
      .describe('Retrieved partners, ordered by descending value when available.'),
    reporterCode: z.number().describe('M49 code of the reporting area.'),
    reporterDesc: z.string().describe('Reporting area name.'),
    period: z.string().describe('Annual period queried.'),
    flowCode: z.string().describe('Trade flow queried.'),
    serviceCode: z.string().optional().describe('Selected service category or scheme total code.'),
    classification: z.string().describe('Services classification requested.'),
    classificationCode: z.string().optional().describe('Actual scheme of the selected series.'),
    isOriginalClassification: z
      .boolean()
      .optional()
      .describe(
        'True for an original series, false for a UN Comtrade conversion, when established.',
      ),
    totalPartners: z.number().describe('Eligible retrieved partners before the display limit.'),
    totalValueUsd: z
      .number()
      .optional()
      .describe('Sum of eligible retrieved partner values before the limit, when all are known.'),
    truncated: z.boolean().describe('True when the upstream retrieval was capped or incomplete.'),
    coverageNotice: z
      .string()
      .describe('Scope of the retrieved data and conditions that prevent ranking.'),
  }),
  enrichment: {
    referenceNotice: z.string().optional().describe('Reference descriptions unavailable.'),
    notice: z.string().optional().describe('Next steps when no services series is selected.'),
  },

  async handler(input, ctx) {
    const { reporter_code: reporterCode, flow_code: flowCode, period, classification } = input;
    const requestedCode = input.service_code || undefined;
    const deadlineAt = Date.now() + TRADE_DATA_DEADLINE_MS;
    const result = await getComtradeDataService()
      .fetchTradeData(
        {
          typeCode: 'S',
          freqCode: 'A',
          reporterCode,
          flowCode,
          period,
          classificationCode: classification,
          cmdCode: requestedCode ?? '200,S',
        },
        ctx.signal,
        deadlineAt,
      )
      .catch((error: unknown) => {
        throw singlePeriodFailure(error);
      });
    ctx.signal.throwIfAborted();
    if (result.referenceNotice) ctx.enrich({ referenceNotice: result.referenceNotice });

    const reference = getComtradeReferenceService();
    const rows = result.records.filter((row) => {
      if (row.reporterCode !== reporterCode || row.flowCode !== flowCode || row.period !== period)
        return false;
      const code = row.cmdCode.toUpperCase();
      if (requestedCode !== undefined) return code === requestedCode;
      const expectedTotal = row.classificationCode && totalCodes.get(row.classificationCode);
      return expectedTotal ? code === expectedTotal : code === '200' || code === 'S';
    });
    const schemes = new Set(rows.map((row) => row.classificationCode));
    const scheme = rows[0]?.classificationCode;
    const originalFlags = new Set(rows.map((row) => row.isOriginalClassification));
    const singleScheme =
      schemes.size === 1 &&
      scheme !== undefined &&
      totalCodes.has(scheme) &&
      (classification === 'EB' || scheme === classification);
    const classificationCode = singleScheme ? scheme : undefined;
    const conflictingProvenance = originalFlags.has(true) && originalFlags.has(false);
    const isOriginalClassification =
      singleScheme && !conflictingProvenance && originalFlags.size === 1
        ? rows[0]?.isOriginalClassification
        : undefined;

    const byPartner = new Map<number, PartnerValue>();
    if (singleScheme && !conflictingProvenance) {
      for (const row of rows) {
        const { partnerCode } = row;
        const area = reference.getCountryByCode(partnerCode);
        // Comtrade marks Other Asia, nes as a group despite its distinct area identity.
        if (partnerCode === 0 || (area?.isGroup && partnerCode !== 490)) continue;
        const previous = byPartner.get(partnerCode);
        if (previous) {
          if (previous.primaryValueUsd !== row.primaryValue) delete previous.primaryValueUsd;
          continue;
        }
        byPartner.set(partnerCode, {
          partnerCode,
          partnerDesc: row.partnerDesc || area?.name || String(partnerCode),
          ...(row.primaryValue !== undefined && { primaryValueUsd: row.primaryValue }),
        });
      }
    }
    const sorted = [...byPartner.values()].sort(
      (a, b) =>
        (b.primaryValueUsd ?? -Infinity) - (a.primaryValueUsd ?? -Infinity) ||
        a.partnerCode - b.partnerCode,
    );
    const unresolvedValues = sorted.some((row) => row.primaryValueUsd === undefined);
    const totalPartners = sorted.length;
    const totalValueUsd =
      totalPartners > 0 && !unresolvedValues
        ? sorted.reduce((sum, row) => sum + (row.primaryValueUsd ?? 0), 0)
        : undefined;
    const truncated = result.truncated || Boolean(result.failedPeriods?.length);
    const unresolvedSeries = rows.length > 0 && (!singleScheme || conflictingProvenance);
    const canRank = !truncated && !unresolvedSeries && !unresolvedValues;
    const coverage = [
      'Shares use eligible retrieved partner values, excluding World and known overlapping groups.',
    ];
    if (truncated) coverage.push(result.truncationHint ?? 'The upstream retrieval was incomplete.');
    if (unresolvedSeries)
      coverage.push('Returned rows do not identify one compatible services series.');
    if (unresolvedValues) coverage.push('Some partners have missing or conflicting trade values.');
    if (rows.length === 0) {
      coverage.push(
        requestedCode === undefined
          ? 'No matching total services rows were returned.'
          : 'No rows matched the requested services category.',
      );
      if (!truncated)
        ctx.enrich.notice(
          await servicesEmptyNotice(input, classification, [period], ctx.signal, deadlineAt),
        );
    } else if (totalPartners === 0 && !unresolvedSeries) {
      coverage.push('No eligible partner breakdown was returned for this series.');
    }
    if (!canRank) coverage.push('Ranks and shares are withheld.');

    const serviceCode = requestedCode ?? (classificationCode && totalCodes.get(classificationCode));
    return {
      partners: sorted.slice(0, input.limit).map((row, index) => ({
        ...row,
        ...(canRank && { rank: index + 1 }),
        ...(canRank &&
          totalValueUsd !== undefined &&
          totalValueUsd > 0 &&
          row.primaryValueUsd !== undefined && {
            sharePercent: Number(((row.primaryValueUsd / totalValueUsd) * 100).toFixed(2)),
          }),
      })),
      reporterCode,
      reporterDesc:
        reference.getCountryByCode(reporterCode)?.name ??
        rows[0]?.reporterDesc ??
        String(reporterCode),
      flowCode,
      period,
      classification,
      ...(serviceCode !== undefined && { serviceCode }),
      ...(classificationCode !== undefined && { classificationCode }),
      ...(isOriginalClassification !== undefined && { isOriginalClassification }),
      totalPartners,
      ...(totalValueUsd !== undefined && { totalValueUsd }),
      truncated,
      coverageNotice: coverage.join(' '),
    };
  },

  format: (result) => {
    const lines = [
      `## Services partners | ${escapeMarkdownInline(result.reporterDesc)} (reporterCode: ${result.reporterCode}) | ${result.period} | flowCode: ${result.flowCode}`,
      `**Classification requested:** ${result.classification}`,
      `**Retrieved partners:** ${result.totalPartners} | **Upstream truncated:** ${result.truncated}`,
      result.coverageNotice,
    ];
    if (result.serviceCode !== undefined)
      lines.push(`**Service code:** ${escapeMarkdownInline(result.serviceCode)}`);
    if (result.classificationCode !== undefined)
      lines.push(`**Classification served:** ${escapeMarkdownInline(result.classificationCode)}`);
    if (result.isOriginalClassification !== undefined)
      lines.push(
        `**Original classification:** ${result.isOriginalClassification ? 'Yes (as reported)' : 'No (converted by UN Comtrade)'}`,
      );
    if (result.totalValueUsd !== undefined)
      lines.push(`**Total value of retrieved partners:** ${result.totalValueUsd} USD`);
    for (const row of result.partners) {
      lines.push(`\n**${escapeMarkdownInline(row.partnerDesc)}** (code ${row.partnerCode})`);
      if (row.primaryValueUsd !== undefined) lines.push(`- Value: ${row.primaryValueUsd} USD`);
      if (row.rank !== undefined) lines.push(`- Rank: ${row.rank}`);
      if (row.sharePercent !== undefined) lines.push(`- Share: ${row.sharePercent}%`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
