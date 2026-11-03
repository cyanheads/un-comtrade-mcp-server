/**
 * @fileoverview Tool for listing combined EB service trade categories.
 * @module mcp-server/tools/definitions/list-service-categories.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getComtradeReferenceService } from '@/services/comtrade-reference/comtrade-reference-service.js';

export const listServiceCategoriesTool = tool('comtrade_list_service_categories', {
  title: 'List Service Trade Categories (EB)',
  description:
    'List service trade categories from the combined EB catalog, including numeric EBOPS and SDMX codes. Returns category codes, descriptions, and parent codes. Filter by keyword (e.g. "transport", "financial", "travel") or browse direct children of a parent code. Use the returned id as service_code in comtrade_get_services_trade. Code 3 is transport; SA is manufacturing services.',
  annotations: { readOnlyHint: true, openWorldHint: false },

  input: z.object({
    query: z
      .string()
      .optional()
      .describe(
        'Keyword or category code prefix to filter results. Examples: "transport", "SA", "financial services". Omit to list all EB categories.',
      ),
    parent_code: z
      .string()
      .optional()
      .describe(
        'Return direct children of this EB category code. Example: "3" for transport sub-categories, or "3.1" for sea transport sub-categories.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .default(100)
      .describe(
        'Maximum number of categories to return; above 500 returns all matching categories.',
      ),
  }),

  output: z.object({
    categories: z
      .array(
        z
          .object({
            id: z.string().describe('EBOPS category code (use as service_code in trade queries).'),
            description: z.string().describe('Category description.'),
            parent: z.string().optional().describe('Parent EBOPS category code, if any.'),
          })
          .describe('A service trade category from the combined EB catalog.'),
      )
      .describe('EB service categories matching the query.'),
    totalMatches: z.number().describe('Total matching categories before limit truncation.'),
    shown: z.number().describe('Number of categories returned.'),
    truncated: z
      .boolean()
      .describe('True when categories were capped at the limit (totalMatches exceeds shown).'),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Recovery hint when no results found or results are truncated.'),
  },

  handler(input, ctx) {
    ctx.log.info('comtrade_list_service_categories', {
      query: input.query,
      parent_code: input.parent_code,
    });
    const ref = getComtradeReferenceService();

    let results = input.query
      ? ref.searchEbopsCategories(input.query)
      : ref.getAllEbopsCategories();

    if (input.parent_code) {
      const parentCode = input.parent_code.toUpperCase();
      results = results.filter((e) => e.parent === parentCode);
    }

    if (results.length === 0) {
      ctx.enrich.notice(
        `No EBOPS service categories matched` +
          (input.query ? ` "${input.query}"` : '') +
          (input.parent_code ? ` under parent "${input.parent_code}"` : '') +
          `. Try a different keyword or remove the parent_code filter.`,
      );
      return {
        categories: [],
        totalMatches: 0,
        shown: 0,
        truncated: false,
      };
    }

    const total = results.length;
    const sliced = input.limit > 500 ? results : results.slice(0, input.limit);

    if (total > sliced.length) {
      ctx.enrich.notice(
        `Showing ${sliced.length} of ${total} categories. Narrow your query or increase the limit.`,
      );
    }

    return {
      categories: sliced.map((e) => ({
        id: e.id,
        description: e.text,
        ...(e.parent && { parent: e.parent }),
      })),
      totalMatches: total,
      shown: sliced.length,
      truncated: total > sliced.length,
    };
  },

  format: (result) => {
    const lines = [
      `## EB Service Categories`,
      `**Matches:** ${result.totalMatches} | **Shown:** ${result.shown} | **Truncated:** ${result.truncated ? 'yes' : 'no'}`,
    ];
    for (const c of result.categories) {
      lines.push(`\n**${c.id}** — ${c.description}`);
      if (c.parent) lines.push(`  Parent: ${c.parent}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
