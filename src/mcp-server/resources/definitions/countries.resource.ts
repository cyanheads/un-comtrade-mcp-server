/**
 * @fileoverview Resource serving the complete list of all Comtrade country/area codes.
 * @module mcp-server/resources/definitions/countries.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getComtradeReferenceService } from '@/services/comtrade-reference/comtrade-reference-service.js';

export const countriesResource = resource('comtrade://countries', {
  name: 'comtrade-countries',
  title: 'Comtrade Country/Area Codes',
  description:
    'Complete list of all Comtrade country and area codes — both reporters and partners — ' +
    'with M49 numeric codes, ISO identifiers, validAsReporter flag, and group membership. ' +
    'Bundled from reference data loaded at startup. Use comtrade_lookup_countries for name-based ' +
    'search; use this resource to enumerate the full list.',
  mimeType: 'application/json',
  params: z.object({}),
  output: z.object({
    countries: z
      .array(
        z
          .object({
            id: z.number().describe('M49 numeric code.'),
            name: z.string().describe('Display name.'),
            iso3: z.string().optional().describe('ISO 3166-1 alpha-3 code.'),
            iso2: z.string().optional().describe('ISO 3166-1 alpha-2 code.'),
            validAsReporter: z
              .boolean()
              .describe('Whether valid as a reporter code in data queries.'),
            isGroup: z.boolean().describe('Whether this is a geographic or economic grouping.'),
          })
          .describe('A country or area entry with M49 code and identifiers.'),
      )
      .describe('All country and area entries from the Comtrade reference data.'),
    totalCount: z.number().describe('Total number of country/area entries.'),
  }),

  handler(_params, ctx) {
    ctx.log.debug('Serving comtrade://countries resource.');
    const ref = getComtradeReferenceService();
    const all = ref.getAllCountries().sort((a, b) => a.name.localeCompare(b.name));
    return {
      countries: all.map((c) => ({
        id: c.id,
        name: c.name,
        ...(c.iso3 && { iso3: c.iso3 }),
        ...(c.iso2 && { iso2: c.iso2 }),
        validAsReporter: c.validAsReporter,
        isGroup: c.isGroup,
      })),
      totalCount: all.length,
    };
  },

  list: () => ({
    resources: [
      {
        uri: 'comtrade://countries',
        name: 'comtrade-countries',
        description: 'Complete list of all Comtrade country and area codes.',
        mimeType: 'application/json',
      },
    ],
  }),
});
