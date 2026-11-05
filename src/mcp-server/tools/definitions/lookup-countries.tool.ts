/**
 * @fileoverview Tool for resolving country and area names to Comtrade M49 numeric codes.
 * @module mcp-server/tools/definitions/lookup-countries.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getComtradeReferenceService } from '@/services/comtrade-reference/comtrade-reference-service.js';

export const lookupCountriesTool = tool('comtrade_lookup_countries', {
  title: 'Lookup Countries / Areas',
  description:
    'Resolve country and area names to Comtrade M49 numeric codes used in all data queries. Accepts a partial name, full name, or ISO alpha-2/alpha-3 code (e.g. "United States", "USA", "US"). Returns matching entries with their numeric code, ISO identifiers, a validAsReporter flag, and validity dates; historical entities such as Fed. Rep. of Germany (...1990) are listed after current ones. World (code 0) is a valid partner but not a valid reporter, while some groupings, such as the European Union (97), do report — check validAsReporter. Use this before any trade data tool that requires reporter_code or partner_code. To aggregate across all partners, use partner code 0 (World) — no lookup needed.',
  annotations: { readOnlyHint: true, openWorldHint: false },

  input: z.object({
    query: z
      .string()
      .min(1)
      .describe(
        'Country or area name fragment, full name, or ISO alpha-2/alpha-3 code to search for. ' +
          'Case-insensitive. Examples: "Germany", "DEU", "DE", "united states", "china".',
      ),
    role: z
      .enum(['reporter', 'partner', 'any'])
      .default('any')
      .describe(
        'Filter by role: "reporter" returns only codes valid for the reporterCode parameter, ' +
          '"partner" returns only partner areas (includes regional groupings), ' +
          '"any" returns all matches regardless of role.',
      ),
    include_groups: z
      .boolean()
      .default(true)
      .describe(
        'Whether to include regional and economic groupings (e.g. EU, ASEAN). ' +
          'Set to false to return only individual countries.',
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
        'Matching entries, plus entries sharing an ISO-3 code with a match, ordered by exact ISO match, reporter validity, current before expired (entryExpiredDate before today), name, then code.',
      ),
    totalMatches: z.number().describe('Total number of matching entries.'),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery hint when no matches are found — echoes the query and suggests alternatives. ' +
          'Absent when results are non-empty.',
      ),
  },

  handler(input, ctx) {
    ctx.log.info('comtrade_lookup_countries', { query: input.query, role: input.role });
    const ref = getComtradeReferenceService();

    let results = ref.searchCountries(input.query, input.role === 'any' ? undefined : input.role);

    if (!input.include_groups) {
      results = results.filter((c) => !c.isGroup);
    }

    if (results.length === 0) {
      ctx.enrich.notice(
        `No countries or areas matched "${input.query}" with role="${input.role}". ` +
          `Try a shorter name fragment, check the spelling, or use an ISO code (e.g. "USA" or "US").`,
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
        `\n**${c.name}** (code: ${c.id})${codes ? ` | ${codes}` : ''} | ${tags}${validity ? ` | ${validity}` : ''}`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
