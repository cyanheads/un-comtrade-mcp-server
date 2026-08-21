/**
 * @fileoverview Tool for searching HS commodity codes by keyword or code prefix.
 * @module mcp-server/tools/definitions/search-commodities.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getComtradeReferenceService } from '@/services/comtrade-reference/comtrade-reference-service.js';

/** Valid HS classification versions. */
const HS_CLASSIFICATIONS = ['HS', 'H0', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'] as const;

export const searchCommoditiesTool = tool('comtrade_search_commodities', {
  title: 'Search HS Commodity Codes',
  description:
    'Find HS commodity codes by keyword, partial description, or known code prefix. ' +
    'Returns matched codes at the requested aggregation level (2-, 4-, or 6-digit) with full ' +
    'descriptions, parent code, leaf status, and a recommended_query_code field indicating the ' +
    'best code level for subsequent trade queries (2-digit chapter for broad analysis, ' +
    '4- or 6-digit for specific products). This is the critical resolution step — ' +
    'agents cannot derive HS codes from product names without this tool. ' +
    'Use aggr_level 2 to start broad; narrow with aggr_level 4 or 6 once you have a chapter. ' +
    'To get all commodities for an entire chapter, pass the 2-digit code as cmd_code in trade tools.',
  annotations: { readOnlyHint: true, openWorldHint: false },

  input: z.object({
    query: z
      .string()
      .min(1)
      .describe(
        'Keyword, partial description, or HS code prefix to search for. ' +
          'Examples: "motor vehicles", "8471", "coffee", "84" (chapter 84 = machinery).',
      ),
    classification: z
      .enum(HS_CLASSIFICATIONS)
      .default('HS')
      .describe(
        'HS classification version. "HS" covers the combined dataset across all editions (H0–H6). ' +
          'Use a specific edition (e.g. "H6") for version-specific lookups.',
      ),
    aggr_level: z
      .union([z.literal(2), z.literal(4), z.literal(6)])
      .optional()
      .describe(
        'Aggregation level: 2 = HS chapter (most general), 4 = heading, 6 = subheading (most specific). ' +
          'Omit to return all matching levels.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(50)
      .describe('Maximum number of results to return.'),
  }),

  output: z.object({
    matches: z
      .array(
        z
          .object({
            id: z.string().describe('HS code string (e.g. "84", "8471", "847130").'),
            description: z.string().describe('Full commodity description.'),
            aggrLevel: z
              .number()
              .describe('Aggregation level: 2 (chapter), 4 (heading), 6 (subheading).'),
            parent: z
              .string()
              .optional()
              .describe('Parent HS code (chapter for headings; heading for subheadings).'),
            isLeaf: z
              .boolean()
              .describe('Whether this code has no sub-codes (leaf node in the HS hierarchy).'),
            recommendedQueryCode: z
              .string()
              .describe(
                'Best code to pass as cmd_code in trade data queries for this commodity. ' +
                  'Uses the most specific level that returns meaningful data.',
              ),
          })
          .describe('A single HS commodity code entry.'),
      )
      .describe('HS codes matching the query.'),
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
      reason: 'no_match',
      code: JsonRpcErrorCode.NotFound,
      when: 'No HS commodity codes matched the query.',
      recovery:
        'Try a broader keyword, remove filters, or look up a known HS code prefix (e.g. "84" for machinery).',
    },
  ],

  handler(input, ctx) {
    ctx.log.info('comtrade_search_commodities', {
      query: input.query,
      aggr_level: input.aggr_level,
    });
    const ref = getComtradeReferenceService();

    const results = ref.searchHsCodes(input.query, input.aggr_level);

    if (results.length === 0) {
      ctx.enrich.notice(
        `No HS commodity codes matched "${input.query}"` +
          (input.aggr_level ? ` at aggr_level ${input.aggr_level}` : '') +
          `. Try a different keyword, a shorter prefix, or remove the aggr_level filter.`,
      );
      return {
        matches: [],
        totalMatches: 0,
        shown: 0,
        truncated: false,
      };
    }

    const total = results.length;
    const sliced = results.slice(0, input.limit);

    if (total > sliced.length) {
      ctx.enrich.notice(
        `Showing ${sliced.length} of ${total} matches. Increase the limit parameter or narrow your query to see more results.`,
      );
    }

    return {
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
      `## HS Commodity Code Search`,
      `**Matches:** ${result.totalMatches} | **Shown:** ${result.shown} | **Truncated:** ${result.truncated ? 'yes' : 'no'}`,
    ];
    for (const m of result.matches) {
      const levelLabel =
        m.aggrLevel === 2 ? 'Chapter' : m.aggrLevel === 4 ? 'Heading' : 'Subheading';
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
