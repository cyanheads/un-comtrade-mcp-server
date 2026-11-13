/**
 * @fileoverview Tool for searching edition-specific HS and SITC commodity catalogs.
 * @module mcp-server/tools/definitions/search-commodities.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { goodsClassificationSchema } from '@/mcp-server/tools/comtrade-input.js';
import { getComtradeReferenceService } from '@/services/comtrade-reference/comtrade-reference-service.js';
import { HS_EDITIONS } from '@/services/comtrade-reference/types.js';

/** Rejection for a query that is blank after trimming or holds no letter or digit ("-", "."). */
const QUERY_MESSAGE =
  'Provide a keyword or commodity code with at least one letter or digit, such as "coffee" or "0901.11".';

export const searchCommoditiesTool = tool('comtrade_search_commodities', {
  title: 'Search Commodity Codes',
  description:
    'Find HS or SITC commodity codes by keyword, description, or code prefix. A code written with dots, spaces, or hyphens ("0901.11") matches 090111. Exact codes, code prefixes and contiguous description matches rank first, followed by descriptions containing every query term in any order. Default HS searches include historical codes and report which edition catalogs list each code. Use a trade row’s classificationCode or comtrade_get_data_availability to identify the edition, then search that edition for its descriptions. Keyless goods queries use HS for as-reported data. Continue with nextOffset using the same query, classification, and aggr_level.',
  annotations: { readOnlyHint: true, openWorldHint: false },

  input: z.object({
    query: z
      .string()
      .trim()
      .min(1, { error: QUERY_MESSAGE, abort: true })
      .refine((query) => /[\p{L}\p{N}]/u.test(query), { error: QUERY_MESSAGE })
      .describe(
        'Keyword, partial description, or commodity code prefix. Dots, spaces, and hyphens in a code are ignored, so "0901.11" finds 090111. Examples: "motor vehicles", "8471", "coffee", "84" (HS chapter 84 = machinery).',
      ),
    classification: goodsClassificationSchema
      .default('HS')
      .describe(
        'Goods reference catalog, case-insensitive: HS uses the default HS.json discovery catalog, whose total identifies H6; it is not an authoritative historical-edition reference. Select H0–H6 for an explicit HS edition, or SS/S1–S4 for SITC.',
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
      .describe('Maximum matching codes returned per page; defaults to 50.'),
    offset: z
      .number()
      .int()
      .nonnegative()
      .default(0)
      .describe('Number of matching codes to skip; use nextOffset to continue.'),
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
              .describe(
                'Native aggregation level in the selected HS or SITC catalog; 0 is the all-commodities TOTAL, which no aggr_level filter returns.',
              ),
            parent: z
              .string()
              .optional()
              .describe('Parent commodity code in the selected classification.'),
            editions: z
              .array(z.enum(HS_EDITIONS))
              .optional()
              .describe(
                'H0–H6 catalogs listing this code in edition order. Definitions may differ across editions. Available for default HS searches when edition catalogs load.',
              ),
            parentDescription: z
              .string()
              .optional()
              .describe(
                'Immediate parent description from the default HS discovery catalog, when the code is absent from H6 and the parent exists in the discovery catalog.',
              ),
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
      .describe(
        'Commodity codes on this page matching the query in the selected classification, ranked exact code, code prefix, whole-word description match, then other description matches for the contiguous query, then descriptions containing every term in any order. Ties keep catalog order.',
      ),
    totalMatches: z.number().describe('Total matching codes across all pages.'),
    shown: z.number().describe('Number of codes returned on this page.'),
    truncated: z
      .boolean()
      .describe('Whether this page holds only part of the matching codes (shown < totalMatches).'),
    offset: z.number().describe('Number of matching codes skipped for this page.'),
    nextOffset: z
      .number()
      .optional()
      .describe('Offset for the next page; absent when no matching codes remain.'),
  }),

  enrichment: {
    referenceNotice: z
      .string()
      .optional()
      .describe(
        'Unavailable HS edition catalog names when the discovery page is returned without edition enrichment.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery hint when no codes match, matches remain past this page, or the offset is past the end. Absent otherwise.',
      ),
  },
  enrichmentTrailer: {
    referenceNotice: { label: 'Reference notice' },
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
      classification: input.classification,
      aggr_level: input.aggr_level,
      limit: input.limit,
      offset: input.offset,
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

    const total = results.length;
    const page = results.slice(input.offset, input.offset + input.limit);
    const nextOffset = input.offset + page.length;

    if (total === 0) {
      ctx.enrich.notice(
        `No ${input.classification} commodity codes matched "${escapeMarkdownInline(input.query)}"${input.aggr_level ? ` at aggr_level ${input.aggr_level}` : ''}. Try technical commodity terms like "soya beans", "bovine", or "photovoltaic", a shorter code prefix, or remove the aggr_level filter.`,
      );
    } else if (page.length === 0) {
      ctx.enrich.notice(
        `Offset ${input.offset} is past the end of the ${total} matching codes. Use an offset below ${total}.`,
      );
    } else if (nextOffset < total) {
      ctx.enrich.notice(
        `Showing ${page.length} of ${total} matches. Continue with offset=${nextOffset} and the same query, classification and aggr_level, or narrow the query.`,
      );
    }

    let matches = page;
    if (input.classification === 'HS' && page.length > 0) {
      const references = await ref.enrichHsPage(page, ctx.signal);
      matches = references.matches;
      if (references.unavailableCatalogs.length > 0) {
        ctx.enrich({
          referenceNotice: `HS edition enrichment unavailable. Could not load ${references.unavailableCatalogs.join(', ')}.`,
        });
      }
    }

    return {
      classification: input.classification,
      matches: matches.map((h) => ({
        id: h.id,
        description: h.text,
        aggrLevel: h.aggrLevel,
        ...(h.parent && { parent: h.parent }),
        ...(h.editions && { editions: h.editions }),
        ...(h.parentDescription !== undefined && { parentDescription: h.parentDescription }),
        isLeaf: h.isLeaf,
        recommendedQueryCode: h.id,
      })),
      totalMatches: total,
      shown: page.length,
      truncated: page.length < total,
      offset: input.offset,
      ...(nextOffset < total && { nextOffset }),
    };
  },

  format: (result) => {
    const lines = [
      `## Commodity Code Search — ${result.classification}`,
      `**Matches:** ${result.totalMatches} | **Shown:** ${result.shown} | **Truncated:** ${result.truncated ? 'yes' : 'no'}`,
      `**Offset:** ${result.offset}${result.nextOffset === undefined ? '' : ` | **Next offset:** ${result.nextOffset}`}`,
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
      if (m.editions) lines.push(`  HS editions: ${m.editions.join(', ') || 'None'}`);
      if (m.parentDescription !== undefined) {
        lines.push(`  Discovery parent description: ${m.parentDescription}`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
