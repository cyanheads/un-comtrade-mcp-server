/**
 * @fileoverview Tool for checking data availability before constructing trade queries.
 * @module mcp-server/tools/definitions/get-data-availability.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  frequencySchema,
  m49Schema,
  periodSchema,
  periodsMatchFrequency,
  resolveFrequency,
} from '@/mcp-server/tools/comtrade-input.js';
import { partnerOnlyReporterNotice } from '@/mcp-server/tools/reporter-notice.js';
import { getComtradeMetaService } from '@/services/comtrade-meta/comtrade-meta-service.js';
import { getComtradeReferenceService } from '@/services/comtrade-reference/comtrade-reference-service.js';

export const getDataAvailabilityTool = tool('comtrade_get_data_availability', {
  title: 'Check Data Availability',
  description:
    'Check which reporter/period/classification combinations have published data before constructing expensive trade queries. Returns dataset records with period, classification, record count, and first/latest release dates. Call this before querying recent periods — annual data is typically published 3–12 months after the reference year and not all countries report every year. Omit filters to browse the availability index, 50 rows by default. Continue with nextOffset using the same filters and limit.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  errors: [
    {
      reason: 'upstream_validation',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'UN Comtrade rejects the availability query dimensions.',
      recovery: 'Check reporter, classification, trade type, frequency and period before retrying.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_upstream_response',
      code: JsonRpcErrorCode.SerializationError,
      when: 'UN Comtrade returns malformed availability data.',
      recovery: 'Retry later when UN Comtrade returns valid availability data.',
      retryable: false,
      thrownBy: 'service',
    },
  ],

  input: z
    .object({
      limit: z
        .number()
        .int()
        .positive()
        .default(50)
        .describe('Maximum datasets returned per page; defaults to 50.'),
      offset: z
        .number()
        .int()
        .nonnegative()
        .default(0)
        .describe('Number of matching datasets to skip; use nextOffset to continue.'),
      reporter_code: m49Schema
        .optional()
        .describe('M49 reporter code to check. Omit to browse availability across all reporters.'),
      period: periodSchema
        .optional()
        .describe(
          'Period to check: YYYY (annual) or YYYYMM (monthly). ' +
            'Omit to see all available periods for the reporter.',
        ),
      freq: frequencySchema
        .optional()
        .describe(
          'Frequency: A=annual YYYY, M=monthly YYYYMM (01–12). Omit to infer it from period, or annual when period is omitted too; an explicit value must match period.',
        ),
      type_code: z
        .string()
        .trim()
        .toUpperCase()
        .pipe(z.enum(['C', 'S']))
        .default('C')
        .describe('Trade type: C=commodities (goods), S=services.'),
      classification: z
        .string()
        .trim()
        .toUpperCase()
        .regex(
          /^(?:[A-Z][A-Z0-9]*)?$/,
          'Use a classification identifier containing letters and digits, such as HS, B4, B5, or EB10.',
        )
        .optional()
        .describe(
          'Classification code filter (e.g. "HS", "H6", "EB10"). Omitted or blank defaults to HS for goods and EB10 for services.',
        ),
    })
    .refine(periodsMatchFrequency, {
      path: ['period'],
      message:
        'Use a YYYY period for annual or YYYYMM for monthly frequency, matching any explicit freq.',
    }),

  output: z.object({
    datasets: z
      .array(
        z
          .object({
            reporterCode: z.number().describe('M49 reporter code.'),
            reporterDesc: z.string().describe('Reporter country name.'),
            period: z.string().describe('Period (YYYY or YYYYMM).'),
            freqCode: z.string().describe('Frequency: A or M.'),
            classificationCode: z.string().describe('Classification code.'),
            typeCode: z.string().describe('Trade type: C or S.'),
            totalRecords: z
              .number()
              .optional()
              .describe('Number of records available in this dataset.'),
            firstReleased: z
              .string()
              .optional()
              .describe('First release timestamp supplied by UN Comtrade.'),
            lastReleased: z
              .string()
              .optional()
              .describe('Latest release or revision timestamp supplied by UN Comtrade.'),
          })
          .describe('A single data availability record.'),
      )
      .describe('Available datasets matching the query.'),
    totalDatasets: z.number().describe('Total number of available dataset records.'),
    truncated: z
      .boolean()
      .describe('Whether this page contains only part of the matching dataset list.'),
    offset: z.number().describe('Number of matching datasets skipped for this page.'),
    shown: z.number().describe('Number of datasets returned on this page.'),
    nextOffset: z
      .number()
      .optional()
      .describe('Offset for the next page; absent when no rows remain.'),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Recovery hint when no records match or the offset is past the end.'),
  },

  async handler(input, ctx) {
    ctx.log.info('comtrade_get_data_availability', {
      reporter: input.reporter_code,
      period: input.period,
    });

    const svc = getComtradeMetaService();
    const records = await svc.getDataAvailability(
      {
        freqCode: resolveFrequency(input),
        typeCode: input.type_code,
        classificationCode: input.classification || (input.type_code === 'S' ? 'EB10' : 'HS'),
        ...(input.reporter_code !== undefined && { reporterCode: input.reporter_code }),
        ...(input.period && { period: input.period }),
      },
      ctx.signal,
    );

    if (records.length === 0) {
      const partnerOnly =
        input.reporter_code === undefined
          ? undefined
          : partnerOnlyReporterNotice(
              input.reporter_code,
              getComtradeReferenceService().getReporterStatus(input.reporter_code),
              input.type_code,
            );
      ctx.enrich.notice(
        `No data availability records found` +
          (input.reporter_code !== undefined ? ` for reporter ${input.reporter_code}` : '') +
          (input.period ? `, period ${input.period}` : '') +
          `. ${partnerOnly ?? 'Try a different reporter, period, or classification.'}`,
      );
      return {
        datasets: [],
        totalDatasets: 0,
        truncated: false,
        offset: input.offset,
        shown: 0,
      };
    }

    if (input.offset >= records.length) {
      ctx.enrich.notice(
        `This offset is past the end of the matching datasets. The largest offset that returns a row is ${records.length - 1}.`,
      );
    }
    const ordered = records.toSorted(
      (a, b) =>
        a.reporterCode - b.reporterCode ||
        a.period.localeCompare(b.period) ||
        a.classificationCode.localeCompare(b.classificationCode) ||
        a.typeCode.localeCompare(b.typeCode) ||
        a.freqCode.localeCompare(b.freqCode),
    );
    const page = ordered.slice(input.offset, input.offset + input.limit);
    const nextOffset = input.offset + page.length;
    return {
      datasets: page.map((r) => ({
        reporterCode: r.reporterCode,
        reporterDesc: r.reporterDesc,
        period: r.period,
        freqCode: r.freqCode,
        classificationCode: r.classificationCode,
        typeCode: r.typeCode,
        ...(r.totalRecords != null && { totalRecords: r.totalRecords }),
        ...(r.firstReleased && { firstReleased: r.firstReleased }),
        ...(r.lastReleased && { lastReleased: r.lastReleased }),
      })),
      totalDatasets: records.length,
      truncated: page.length < records.length,
      offset: input.offset,
      shown: page.length,
      ...(nextOffset < records.length && { nextOffset }),
    };
  },

  format: (result) => {
    const lines = [
      `## Data Availability`,
      `**Datasets Found:** ${result.totalDatasets}`,
      `**Partial page:** ${result.truncated}`,
      `**Offset:** ${result.offset}`,
      `**Shown:** ${result.shown}`,
    ];
    if (result.nextOffset !== undefined) {
      lines.push(`Continue with offset=${result.nextOffset}, keeping the same filters and limit.`);
    }
    for (const d of result.datasets) {
      lines.push(
        `\n**${d.reporterDesc}** (${d.reporterCode}) | ${d.period} | ${d.classificationCode} | freq:${d.freqCode} | typeCode:${d.typeCode}`,
      );
      if (d.totalRecords != null) lines.push(`  Records: ${d.totalRecords.toLocaleString()}`);
      if (d.firstReleased) lines.push(`  First Released: ${d.firstReleased}`);
      if (d.lastReleased) lines.push(`  Last Released: ${d.lastReleased}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
