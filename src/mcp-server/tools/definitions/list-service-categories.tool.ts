/**
 * @fileoverview Tool for listing EBOPS 2010 service trade categories.
 * @module mcp-server/tools/definitions/list-service-categories.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getComtradeReferenceService } from '@/services/comtrade-reference/comtrade-reference-service.js';

export const listServiceCategoriesTool = tool('comtrade_list_service_categories', {
  title: 'List Service Trade Categories (EBOPS)',
  description:
    'List EBOPS 2010 service trade categories — the equivalent of comtrade_search_commodities ' +
    'for the services domain. Returns category codes, descriptions, and parent codes. ' +
    'Filter by keyword to find a specific service type (e.g. "transport", "financial", "travel"), ' +
    'or browse from a parent category code. Use the returned id as service_code in ' +
    'comtrade_get_services_trade.',
  annotations: { readOnlyHint: true, openWorldHint: false },

  input: z.object({
    query: z
      .string()
      .optional()
      .describe(
        'Keyword or category code prefix to filter results. ' +
          'Examples: "transport", "SA", "financial services". ' +
          'Omit to list all EBOPS categories.',
      ),
    parent_code: z
      .string()
      .optional()
      .describe(
        'Return only sub-categories of this parent EBOPS code. ' +
          'Example: "SA" to see all transport service sub-categories.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(100)
      .describe('Maximum number of categories to return.'),
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
          .describe('An EBOPS 2010 service trade category.'),
      )
      .describe('EBOPS 2010 service categories matching the query.'),
    totalMatches: z.number().describe('Total matching categories before limit truncation.'),
    shown: z.number().describe('Number of categories returned.'),
    notice: z
      .string()
      .optional()
      .describe('Recovery hint when no results found or results are truncated.'),
  }),

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
      return {
        categories: [],
        totalMatches: 0,
        shown: 0,
        notice:
          `No EBOPS service categories matched` +
          (input.query ? ` "${input.query}"` : '') +
          (input.parent_code ? ` under parent "${input.parent_code}"` : '') +
          `. Try a different keyword or remove the parent_code filter.`,
      };
    }

    const total = results.length;
    const sliced = results.slice(0, input.limit);

    return {
      categories: sliced.map((e) => ({
        id: e.id,
        description: e.text,
        ...(e.parent && { parent: e.parent }),
      })),
      totalMatches: total,
      shown: sliced.length,
      ...(total > sliced.length && {
        notice: `Showing ${sliced.length} of ${total} categories. Narrow your query or increase the limit.`,
      }),
    };
  },

  format: (result) => {
    const lines = [
      `## EBOPS 2010 Service Categories`,
      `**Matches:** ${result.totalMatches} | **Shown:** ${result.shown}`,
    ];
    if (result.notice) {
      lines.push(`\n> ${result.notice}`);
    }
    for (const c of result.categories) {
      lines.push(`\n**${c.id}** — ${c.description}`);
      if (c.parent) lines.push(`  Parent: ${c.parent}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
