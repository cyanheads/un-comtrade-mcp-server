/**
 * @fileoverview Tool for checking data availability before constructing trade queries.
 * @module mcp-server/tools/definitions/get-data-availability.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getComtradeMetaService } from '@/services/comtrade-meta/comtrade-meta-service.js';

export const getDataAvailabilityTool = tool('comtrade_get_data_availability', {
  title: 'Check Data Availability',
  description:
    'Check which reporter/period/classification combinations have published data before ' +
    'constructing expensive trade queries. Returns dataset records with period, classification, ' +
    'record count, and publication date. Call this before querying recent periods — annual data ' +
    'is typically published 3–12 months after the reference year and not all countries report ' +
    'every year. Omit all parameters to browse the full availability index.',
  annotations: { readOnlyHint: true, openWorldHint: false },

  input: z.object({
    reporter_code: z
      .number()
      .int()
      .optional()
      .describe('M49 reporter code to check. Omit to browse availability across all reporters.'),
    period: z
      .string()
      .optional()
      .describe(
        'Period to check: YYYY (annual) or YYYYMM (monthly). ' +
          'Omit to see all available periods for the reporter.',
      ),
    freq: z.enum(['A', 'M']).default('A').describe('Frequency: A=annual, M=monthly.'),
    type_code: z
      .enum(['C', 'S'])
      .default('C')
      .describe('Trade type: C=commodities (goods), S=services.'),
    classification: z
      .string()
      .default('HS')
      .describe('Classification code filter (e.g. "HS", "H6", "EB10").'),
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
            publicationDate: z
              .string()
              .optional()
              .describe('Date when this dataset was published by UN Comtrade.'),
          })
          .describe('A single data availability record.'),
      )
      .describe('Available datasets matching the query.'),
    totalDatasets: z.number().describe('Total number of available dataset records.'),
    notice: z.string().optional().describe('Recovery hint when no availability records are found.'),
  }),

  errors: [
    {
      reason: 'api_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The Comtrade availability endpoint was unreachable or returned an error.',
      recovery: 'Verify network connectivity and retry after a brief delay.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('comtrade_get_data_availability', {
      reporter: input.reporter_code,
      period: input.period,
    });

    const svc = getComtradeMetaService();
    const records = await svc.getDataAvailability(
      {
        freqCode: input.freq,
        typeCode: input.type_code,
        classificationCode: input.classification,
        ...(input.reporter_code !== undefined && { reporterCode: input.reporter_code }),
        ...(input.period && { period: input.period }),
      },
      ctx.signal,
    );

    if (records.length === 0) {
      const notice =
        `No data availability records found` +
        (input.reporter_code ? ` for reporter ${input.reporter_code}` : '') +
        (input.period ? `, period ${input.period}` : '') +
        `. Try a different reporter, period, or classification.`;
      return {
        datasets: [],
        totalDatasets: 0,
        notice,
      };
    }

    return {
      datasets: records.map((r) => ({
        reporterCode: r.reporterCode,
        reporterDesc: r.reporterDesc,
        period: r.period,
        freqCode: r.freqCode,
        classificationCode: r.classificationCode,
        typeCode: r.typeCode,
        ...(r.totalRecords != null && { totalRecords: r.totalRecords }),
        ...(r.publicationDate && { publicationDate: r.publicationDate }),
      })),
      totalDatasets: records.length,
    };
  },

  format: (result) => {
    const lines = [`## Data Availability`, `**Datasets Found:** ${result.totalDatasets}`];
    if (result.notice) {
      lines.push(`\n> ${result.notice}`);
    }
    for (const d of result.datasets) {
      lines.push(
        `\n**${d.reporterDesc}** (${d.reporterCode}) | ${d.period} | ${d.classificationCode} | freq:${d.freqCode} | typeCode:${d.typeCode}`,
      );
      if (d.totalRecords != null) lines.push(`  Records: ${d.totalRecords.toLocaleString()}`);
      if (d.publicationDate) lines.push(`  Published: ${d.publicationDate}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
