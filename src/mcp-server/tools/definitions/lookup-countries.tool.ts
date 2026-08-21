/**
 * @fileoverview Tool for resolving country and area names to Comtrade M49 numeric codes.
 * @module mcp-server/tools/definitions/lookup-countries.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getComtradeReferenceService } from '@/services/comtrade-reference/comtrade-reference-service.js';

export const lookupCountriesTool = tool('comtrade_lookup_countries', {
  title: 'Lookup Countries / Areas',
  description:
    'Resolve country and area names to Comtrade M49 numeric codes used in all data queries. ' +
    'Accepts a partial name, full name, or ISO alpha-2/alpha-3 code (e.g. "United States", "USA", "US"). ' +
    'Returns matching entries with their numeric code, ISO identifiers, and a validAsReporter flag — ' +
    'regional groupings like "World" (code 0) are valid partners but not valid reporters. ' +
    'Use this before any trade data tool that requires reporter_code or partner_code. ' +
    'To aggregate across all partners, use partner code 0 (World) — no lookup needed.',
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
                'Whether this code is valid as a reporter_code in trade data queries. ' +
                  'Regional groupings (isGroup=true) are typically not valid reporters.',
              ),
            isGroup: z
              .boolean()
              .describe(
                'Whether this entry is a geographic or economic grouping rather than a single country.',
              ),
          })
          .describe('A country or area entry with its Comtrade M49 code and identifiers.'),
      )
      .describe('Country/area entries matching the query, sorted by name.'),
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

  errors: [
    {
      reason: 'no_match',
      code: JsonRpcErrorCode.NotFound,
      when: 'No country or area matched the query string.',
      recovery:
        'Try a shorter name fragment, check spelling, or use an ISO alpha-2/alpha-3 code instead.',
    },
  ],

  handler(input, ctx) {
    ctx.log.info('comtrade_lookup_countries', { query: input.query, role: input.role });
    const ref = getComtradeReferenceService();

    let results = ref.searchCountries(input.query, input.role === 'any' ? undefined : input.role);

    if (!input.include_groups) {
      results = results.filter((c) => !c.isGroup);
    }

    results.sort((a, b) => a.name.localeCompare(b.name));

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
      lines.push(`\n**${c.name}** (code: ${c.id})${codes ? ` | ${codes}` : ''} | ${tags}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
