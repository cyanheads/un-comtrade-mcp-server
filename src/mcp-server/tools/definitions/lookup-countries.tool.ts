/**
 * @fileoverview Tool for resolving country and area names to Comtrade M49 numeric codes.
 * @module mcp-server/tools/definitions/lookup-countries.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { getComtradeReferenceService } from '@/services/comtrade-reference/comtrade-reference-service.js';

export const lookupCountriesTool = tool('comtrade_lookup_countries', {
  title: 'Lookup Countries / Areas',
  description:
    'Resolve country and area names to Comtrade M49 numeric codes used in all data queries. Accepts a partial or full name, an official name (e.g. "Republic of Korea"), a common name (e.g. "UK", "Turkey"), or an ISO alpha-2/alpha-3 code (e.g. "USA", "US"), ignoring case and accents; exact matches are listed before partial ones. Returns matching entries with their numeric code, ISO identifiers, a validAsReporter flag, and validity dates; within the exact and partial groups, historical entities such as Fed. Rep. of Germany (...1990) are listed after current ones. World (code 0) is a valid partner but not a valid reporter, while some groupings, such as the European Union (97), do report — check validAsReporter. Use this before any trade data tool that requires reporter_code or partner_code. To aggregate across all partners, use partner code 0 (World) — no lookup needed.',
  annotations: { readOnlyHint: true, openWorldHint: false },

  input: z.object({
    query: z
      .string()
      .trim()
      .min(
        1,
        'Enter a country or area name or an ISO alpha-2/alpha-3 code, e.g. "Germany" or "DEU".',
      )
      .describe(
        'Country or area to find by name, name fragment, official or common name, or ISO alpha-2/alpha-3 code. Case, accents and surrounding spaces are ignored. Name matching treats St and St. as Saint and accepts straight or curly apostrophes. Examples: "Germany", "DEU", "DE", "south korea", "Turkiye", "St. Lucia".',
      ),
    role: z
      .enum(['reporter', 'partner', 'any'])
      .default('any')
      .describe(
        'Filter by role: "reporter" returns only codes valid for reporter_code; "partner" returns only codes valid for partner_code, which include World (0) but not reporter-only groupings such as the European Union (97) and ASEAN (975); "any" returns every match.',
      ),
    include_groups: z
      .boolean()
      .default(true)
      .describe(
        'Whether to include regional and economic groupings (e.g. EU, ASEAN). Set to false to return only individual countries and groupings under which a match’s goods trade is published (490 Other Asia, nes for 158 Taiwan, Province of China).',
      ),
  }),

  output: z.object({
    matches: z
      .array(
        z
          .object({
            id: z.number().describe('M49 numeric code to use in trade data queries.'),
            name: z.string().describe('Display name of the country or area.'),
            iso3: z.string().optional().describe('ISO 3166-1 alpha-3 code, when available.'),
            iso2: z.string().optional().describe('ISO 3166-1 alpha-2 code, when available.'),
            note: z
              .string()
              .optional()
              .describe(
                'The catalog’s long-form name or coverage note, e.g. "France, Monaco" for 251 France; a match can come from it. Absent when the catalog gives none or it repeats the name.',
              ),
            validAsReporter: z
              .boolean()
              .describe(
                'Whether this code is valid as a reporter_code in trade data queries. Most groupings (isGroup=true) are partner-only, though some report, such as the European Union (97).',
              ),
            isGroup: z
              .boolean()
              .describe(
                'Whether this entry is a geographic or economic grouping rather than a single country.',
              ),
            entryEffectiveDate: z
              .string()
              .optional()
              .describe(
                'First day the entity is valid in UN Comtrade reference data (YYYY-MM-DD), when upstream lists one.',
              ),
            entryExpiredDate: z
              .string()
              .optional()
              .describe(
                'Last day the entity was valid (YYYY-MM-DD), e.g. 1990-12-31 for Fed. Rep. of Germany (...1990); absent when upstream records no expiry.',
              ),
          })
          .describe('A country or area entry with its Comtrade M49 code and identifiers.'),
      )
      .describe(
        'Matching entries, plus entries sharing an ISO-3 code with a match and the code under which UN Comtrade publishes a match’s goods trade (490 Other Asia, nes for 158 Taiwan, Province of China). Exact matches (a common name, ISO code, name, or official long-form name equal to the query) come before partial-name matches, and an entry a match pulls in ranks with that match. Within each rank, reporter-valid entries come first, then current before expired (entryExpiredDate before today), then name and code.',
      ),
    totalMatches: z.number().describe('Total number of matching entries.'),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery hint when no matches are found, or the goods and services codes to query for Taiwan (490 for goods reporter or partner and 158 for services partner).',
      ),
  },

  handler(input, ctx) {
    ctx.log.info('comtrade_lookup_countries', { query: input.query, role: input.role });
    const ref = getComtradeReferenceService();

    const matched = ref.searchCountries(input.query, input.role === 'any' ? undefined : input.role);
    // A goods stand-in survives the group filter.
    const results = input.include_groups
      ? matched
      : matched.filter((c) => !c.isGroup || c.standsInFor !== undefined);

    const publishedUnder = results.flatMap(({ id, name, standsInFor }) =>
      standsInFor
        ? [
            `UN Comtrade publishes goods trade for ${standsInFor.id} (${escapeMarkdownInline(standsInFor.name)}) under ${id} (${escapeMarkdownInline(name)}). For goods, use ${id} as reporter_code or partner_code. For services, use ${standsInFor.id} as partner_code for Taiwan.`,
          ]
        : [],
    );
    if (publishedUnder.length > 0) ctx.enrich.notice(publishedUnder.join(' '));

    if (results.length === 0) {
      const query = escapeMarkdownInline(input.query);
      ctx.enrich.notice(
        matched.length > 0
          ? `Only groupings matched "${query}" with role="${input.role}"; include_groups is false, so they are left out. Retry with include_groups true to list them.`
          : `No countries or areas matched "${query}" with role="${input.role}". Try a shorter name fragment, check the spelling, or use an ISO code (e.g. "USA" or "US").`,
      );
      return {
        matches: [],
        totalMatches: 0,
      };
    }

    return {
      matches: results.map((c) => ({
        id: c.id,
        name: c.name,
        ...(c.iso3 && { iso3: c.iso3 }),
        ...(c.iso2 && { iso2: c.iso2 }),
        ...(c.note && { note: c.note }),
        validAsReporter: c.validAsReporter,
        isGroup: c.isGroup,
        ...(c.entryEffectiveDate && { entryEffectiveDate: c.entryEffectiveDate }),
        ...(c.entryExpiredDate && { entryExpiredDate: c.entryExpiredDate }),
      })),
      totalMatches: results.length,
    };
  },

  format: (result) => {
    const lines = [`## Country/Area Lookup`, `**Matches:** ${result.totalMatches}`];
    for (const c of result.matches) {
      const codes = [c.iso3 ? `ISO3: ${c.iso3}` : null, c.iso2 ? `ISO2: ${c.iso2}` : null]
        .filter(Boolean)
        .join(' | ');
      const tags = [c.validAsReporter ? 'reporter ✓' : 'reporter ✗', c.isGroup ? 'group' : null]
        .filter(Boolean)
        .join(', ');
      const validity = c.entryExpiredDate
        ? c.entryEffectiveDate
          ? `valid ${c.entryEffectiveDate} to ${c.entryExpiredDate}`
          : `valid until ${c.entryExpiredDate}`
        : c.entryEffectiveDate
          ? `valid from ${c.entryEffectiveDate}`
          : undefined;
      lines.push(
        `\n**${c.name}** (code: ${c.id})${codes ? ` | ${codes}` : ''} | ${tags}${validity ? ` | ${validity}` : ''}${c.note ? ` | note: ${escapeMarkdownInline(c.note)}` : ''}`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
