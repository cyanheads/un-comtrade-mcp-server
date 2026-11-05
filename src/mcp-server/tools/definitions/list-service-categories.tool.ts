/**
 * @fileoverview Tool for listing combined EB service trade categories, each tagged with the EBOPS
 * scheme catalogs that list its code.
 * @module mcp-server/tools/definitions/list-service-categories.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getComtradeReferenceService } from '@/services/comtrade-reference/comtrade-reference-service.js';
import { EB_SCHEMES } from '@/services/comtrade-reference/types.js';

const categorySchema = z
  .object({
    id: z.string().describe('EBOPS category code (use as service_code in trade queries).'),
    description: z.string().describe('Category description.'),
    parent: z
      .string()
      .optional()
      .describe(
        'Parent category code, if any; EB10 top-level codes take 200 from the EB10 catalog.',
      ),
    ebParent: z
      .string()
      .optional()
      .describe(
        'Parent the combined EB catalog gives this code when it differs from parent: TOTAL for EB10 top-level codes.',
      ),
    schemes: z
      .array(z.enum(EB_SCHEMES))
      .optional()
      .describe(
        'EBOPS scheme catalogs listing this code: EB10 (EBOPS 2010), EB10S (EBOPS 2010 SDMX codes), EB02 (EBOPS 2002). Empty when no scheme catalog lists it; absent when the scheme catalogs could not be loaded.',
      ),
  })
  .describe('A service trade category from the combined EB catalog.');

type CategoryRow = z.infer<typeof categorySchema>;

export const listServiceCategoriesTool = tool('comtrade_list_service_categories', {
  title: 'List Service Trade Categories (EB)',
  description:
    'List service trade categories from the combined EB catalog, including numeric EBOPS and SDMX codes. Returns category codes, descriptions, parent codes, and the EBOPS scheme catalogs that list each code: EB10 (EBOPS 2010), EB10S (EBOPS 2010 SDMX codes), EB02 (EBOPS 2002). Filter by keyword (e.g. "transport", "financial", "travel") or browse direct children of a parent code; "200" lists the EB10 and EB02 top levels. Use the returned id as service_code in comtrade_get_services_trade. Code 3 is transport; SA is manufacturing services. Each page holds up to limit categories; continue with nextOffset using the same query and parent_code.',
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
        'Return direct children of this EB category code. Examples: "3" for transport sub-categories, "3.1" for sea transport sub-categories, or "200" for the EB10 and EB02 top-level categories.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .default(100)
      .describe('Maximum categories returned per page; defaults to 100.'),
    offset: z
      .number()
      .int()
      .nonnegative()
      .default(0)
      .describe('Number of matching categories to skip; use nextOffset to continue.'),
  }),

  output: z.object({
    categories: z
      .array(categorySchema)
      .describe('EB service categories on this page, in catalog order.'),
    totalMatches: z.number().describe('Total matching categories across all pages.'),
    shown: z.number().describe('Number of categories returned on this page.'),
    truncated: z
      .boolean()
      .describe(
        'Whether this page holds only part of the matching categories (shown < totalMatches).',
      ),
    offset: z.number().describe('Number of matching categories skipped for this page.'),
    nextOffset: z
      .number()
      .optional()
      .describe('Offset for the next page; absent when no matching categories remain.'),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery hint when no categories match, matches remain past this page, the offset is past the end, or scheme tags are unavailable.',
      ),
  },

  async handler(input, ctx) {
    ctx.log.info('comtrade_list_service_categories', {
      query: input.query,
      parent_code: input.parent_code,
      limit: input.limit,
      offset: input.offset,
    });
    const listing = await getComtradeReferenceService().getServiceCategories(
      input.query,
      ctx.signal,
    );
    const categories: CategoryRow[] =
      listing.status === 'tagged'
        ? listing.categories.map(({ id, text, parent, ebParent, schemes }) => ({
            id,
            description: text,
            ...(parent && { parent }),
            ...(ebParent && { ebParent }),
            schemes,
          }))
        : listing.categories.map(({ id, text, parent }) => ({
            id,
            description: text,
            ...(parent && { parent }),
          }));

    /**
     * EB10's top level carries parent 200 from EB10.json and TOTAL from EB.json; either selects it.
     * Compared case-insensitively: EB.json mixes uppercase SDMX codes with lowercase ones (3a.3).
     */
    const parentCode = input.parent_code?.toUpperCase();
    const matches = parentCode
      ? categories.filter(
          (c) => c.parent?.toUpperCase() === parentCode || c.ebParent?.toUpperCase() === parentCode,
        )
      : categories;
    const total = matches.length;
    const page = matches.slice(input.offset, input.offset + input.limit);
    const nextOffset = input.offset + page.length;

    const notices: string[] = [];
    if (listing.status === 'untagged') {
      notices.push(
        `EB scheme catalogs unavailable (${listing.unavailableCatalogs.join(', ')}): categories are listed without scheme tags and with the combined EB catalog's parents, which put EB10's top-level codes under TOTAL instead of 200. Retry later for scheme tags.`,
      );
    }
    if (total === 0) {
      notices.push(
        `No EBOPS service categories matched${input.query ? ` "${input.query}"` : ''}${input.parent_code ? ` under parent "${input.parent_code}"` : ''}. Try a different keyword or remove the parent_code filter.`,
      );
    } else if (page.length === 0) {
      notices.push(
        `Offset ${input.offset} is past the end of the ${total} matching categories. Use an offset below ${total}.`,
      );
    } else if (nextOffset < total) {
      notices.push(
        `Showing ${page.length} of ${total} categories. Continue with offset=${nextOffset} and the same query and parent_code, or narrow the query.`,
      );
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return {
      categories: page,
      totalMatches: total,
      shown: page.length,
      truncated: page.length < total,
      offset: input.offset,
      ...(nextOffset < total && { nextOffset }),
    };
  },

  format: (result) => {
    const lines = [
      `## EB Service Categories`,
      `**Matches:** ${result.totalMatches} | **Shown:** ${result.shown} | **Truncated:** ${result.truncated ? 'yes' : 'no'}`,
      `**Offset:** ${result.offset}${result.nextOffset === undefined ? '' : ` | **Next offset:** ${result.nextOffset}`}`,
    ];
    for (const c of result.categories) {
      lines.push(`\n**${c.id}** — ${c.description}`);
      const details: string[] = [];
      if (c.parent) {
        details.push(
          `Parent: ${c.parent}${c.ebParent ? ` (EB catalog parent: ${c.ebParent})` : ''}`,
        );
      }
      if (c.schemes) {
        details.push(`Schemes: ${c.schemes.length > 0 ? c.schemes.join(', ') : 'none'}`);
      }
      if (details.length > 0) lines.push(`  ${details.join(' | ')}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
