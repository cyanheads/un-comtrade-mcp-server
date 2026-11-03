/**
 * @fileoverview Tool for searching edition-specific HS and SITC commodity catalogs.
 * @module mcp-server/tools/definitions/search-commodities.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getComtradeReferenceService } from '@/services/comtrade-reference/comtrade-reference-service.js';
import { COMMODITY_CLASSIFICATIONS } from '@/services/comtrade-reference/types.js';

export const searchCommoditiesTool = tool('comtrade_search_commodities', {
  title: 'Search Commodity Codes',
  description:
    'Find HS or SITC commodity codes by keyword, partial description, or code prefix in the selected classification. Returns descriptions, native aggregation levels, parents, leaf status, and recommendedQueryCode for subsequent trade queries. HS uses levels 2 (chapter), 4 (heading), and 6 (subheading); SITC uses levels 1–5. Select the edition matching the trade records when interpreting historical codes.',
  annotations: { readOnlyHint: true, openWorldHint: false },

  input: z.object({
    query: z
      .string()
      .min(1)
      .describe(
        'Keyword, partial description, or commodity code prefix. Examples: "motor vehicles", "8471", "coffee", "84" (HS chapter 84 = machinery).',
      ),
    classification: z
      .enum(COMMODITY_CLASSIFICATIONS)
      .default('HS')
      .describe(
        'Goods reference catalog: HS uses the default HS.json discovery catalog, whose total identifies H6; it is not an authoritative historical-edition reference. Select H0–H6 for an explicit HS edition, or SS/S1–S4 for SITC.',
      ),
    aggr_level: z
      .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)])
      .optional()
      .describe(
        'Native aggregation level: HS uses 2 (chapter), 4 (heading), 6 (subheading); SITC uses 1–5. Omit to return all matching levels.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .default(50)
      .describe('Maximum number of results to return; above 200 returns all matching codes.'),
  }),

  output: z.object({
    classification: z.string().describe('Reference catalog used for the search.'),
    matches: z
      .array(
        z
          .object({
            id: z
              .string()
              .describe('Commodity code in the selected classification, preserving leading zeros.'),
            description: z.string().describe('Full commodity description.'),
            aggrLevel: z
              .number()
              .describe('Native aggregation level in the selected HS or SITC catalog.'),
            parent: z
              .string()
              .optional()
              .describe('Parent commodity code in the selected classification.'),
            isLeaf: z
              .boolean()
              .describe('Whether this code has no sub-codes (leaf node in the HS hierarchy).'),
            recommendedQueryCode: z
              .string()
              .describe(
                'Code to pass as cmd_code with the same classification in trade data queries.',
              ),
          })
          .describe('A commodity entry from the selected catalog.'),
      )
      .describe('Commodity codes matching the query in the selected classification.'),
    totalMatches: z.number().describe('Total matching codes (before limit truncation).'),
    shown: z.number().describe('Number of codes returned in this response.'),
    truncated: z
      .boolean()
      .describe('True when matches were capped at the limit (totalMatches exceeds shown).'),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery hint when no matches are found or results are truncated. ' +
          'Absent when results are non-empty and not truncated.',
      ),
  },

  errors: [
    {
      reason: 'invalid_aggregation_level',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The requested level does not belong to the selected classification family.',
      recovery: 'Use HS levels 2, 4, or 6, or SITC levels 1 through 5.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('comtrade_search_commodities', {
      query: input.query,
      aggr_level: input.aggr_level,
    });
    const ref = getComtradeReferenceService();

    const sitc = input.classification.startsWith('S');
    if (
      input.aggr_level !== undefined &&
      (sitc ? input.aggr_level > 5 : ![2, 4, 6].includes(input.aggr_level))
    ) {
      throw ctx.fail(
        'invalid_aggregation_level',
        `Aggregation level ${input.aggr_level} is invalid for ${input.classification}.`,
      );
    }
    const results = await ref.searchCommodityCodes(
      input.query,
      input.classification,
      input.aggr_level,
      ctx.signal,
    );

    if (results.length === 0) {
      ctx.enrich.notice(
        `No ${input.classification} commodity codes matched "${input.query}"` +
          (input.aggr_level ? ` at aggr_level ${input.aggr_level}` : '') +
          `. Try a different keyword, a shorter prefix, or remove the aggr_level filter.`,
      );
      return {
        classification: input.classification,
        matches: [],
        totalMatches: 0,
        shown: 0,
        truncated: false,
      };
    }

    const total = results.length;
    const sliced = input.limit > 200 ? results : results.slice(0, input.limit);

    if (total > sliced.length) {
      ctx.enrich.notice(
        `Showing ${sliced.length} of ${total} matches. Increase the limit parameter or narrow your query to see more results.`,
      );
    }

    return {
      classification: input.classification,
      matches: sliced.map((h) => ({
        id: h.id,
        description: h.text,
        aggrLevel: h.aggrLevel,
        ...(h.parent && { parent: h.parent }),
        isLeaf: h.isLeaf,
        recommendedQueryCode: h.id,
      })),
      totalMatches: total,
      shown: sliced.length,
      truncated: total > sliced.length,
    };
  },

  format: (result) => {
    const lines = [
      `## Commodity Code Search — ${result.classification}`,
      `**Matches:** ${result.totalMatches} | **Shown:** ${result.shown} | **Truncated:** ${result.truncated ? 'yes' : 'no'}`,
    ];
    for (const m of result.matches) {
      const levelLabel = result.classification.startsWith('S')
        ? 'SITC'
        : m.aggrLevel === 2
          ? 'Chapter'
          : m.aggrLevel === 4
            ? 'Heading'
            : m.aggrLevel === 6
              ? 'Subheading'
              : 'Total';
      lines.push(`\n**${m.id}** — ${m.description}`);
      lines.push(
        `  aggrLevel: ${m.aggrLevel} (${levelLabel})${m.parent ? ` | Parent: ${m.parent}` : ''}`,
      );
      lines.push(
        `  Use in queries: \`${m.recommendedQueryCode}\` | Leaf: ${m.isLeaf ? 'Yes' : 'No'}`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
