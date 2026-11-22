/**
 * @fileoverview Resource serving the top-level HS commodity hierarchy at a requested level.
 * @module mcp-server/resources/definitions/hs-classification.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import { getComtradeReferenceService } from '@/services/comtrade-reference/comtrade-reference-service.js';
import { HS_EDITIONS } from '@/services/comtrade-reference/types.js';

const VALID_LEVELS = [2, 4, 6] as const;

export const hsClassificationResource = resource('comtrade://hs-classification/{level}', {
  name: 'comtrade-hs-classification',
  title: 'Comtrade HS Classification',
  description:
    'Combined HS discovery hierarchy at level 2 (chapters), 4 (headings), or 6 (subheadings), including historical codes. Edition tags name the H0–H6 catalogs that list a code. Use comtrade_search_commodities for edition-specific descriptions or keyword search.',
  mimeType: 'application/json',
  params: z.object({
    level: z
      .string()
      .describe('HS aggregation level: "2" for chapters, "4" for headings, "6" for subheadings.'),
  }),
  output: z.object({
    level: z.number().describe('Aggregation level used: 2, 4, or 6.'),
    codes: z
      .array(
        z
          .object({
            id: z.string().describe('HS code.'),
            description: z.string().describe('Commodity description.'),
            parent: z.string().optional().describe('Parent HS code.'),
            isLeaf: z.boolean().describe('Whether this code has no sub-codes.'),
            editions: z
              .array(z.enum(HS_EDITIONS))
              .optional()
              .describe(
                'HS editions listing this code, in H0–H6 order. Empty if none lists it and omitted if edition catalogs are unavailable. Membership does not establish the same meaning across editions.',
              ),
          })
          .describe('A single HS commodity code entry with description and hierarchy.'),
      )
      .describe('HS codes at this aggregation level.'),
    totalCount: z.number().describe('Total codes at this level.'),
    referenceNotice: z
      .string()
      .optional()
      .describe('Names the unavailable edition catalogs when edition tags could not be included.'),
  }),

  async handler(params, ctx) {
    const requestedLevel = Number(params.level);
    const level = VALID_LEVELS.find((validLevel) => validLevel === requestedLevel);
    if (level === undefined) {
      throw validationError(`Invalid HS level "${params.level}". Must be 2, 4, or 6.`, {
        requestedLevel: params.level,
      });
    }

    ctx.log.debug('Serving comtrade://hs-classification resource.', { level });
    const ref = getComtradeReferenceService();
    const { matches: codes, unavailableCatalogs } = await ref.tagHsEditions(
      ref.getAllHsCodes(level),
      ctx.signal,
    );

    return {
      level,
      codes: codes.map((h) => ({
        id: h.id,
        description: h.text,
        ...(h.parent && { parent: h.parent }),
        isLeaf: h.isLeaf,
        ...(h.editions !== undefined && { editions: h.editions }),
      })),
      totalCount: codes.length,
      ...(unavailableCatalogs.length > 0 && {
        referenceNotice: `HS edition enrichment unavailable. Could not load ${unavailableCatalogs.join(', ')}.`,
      }),
    };
  },

  list: () => ({
    resources: VALID_LEVELS.map((level) => ({
      uri: `comtrade://hs-classification/${level}`,
      name: `comtrade-hs-classification-${level}`,
      title: 'Comtrade HS Classification',
      description: `Combined HS commodity codes, including historical codes, at ${level === 2 ? 'chapter' : level === 4 ? 'heading' : 'subheading'} level (${level}-digit), with edition membership when available.`,
      mimeType: 'application/json',
    })),
  }),
});
