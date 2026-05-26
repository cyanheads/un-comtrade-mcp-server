/**
 * @fileoverview Resource serving the top-level HS commodity hierarchy at a requested level.
 * @module mcp-server/resources/definitions/hs-classification.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { notFound } from '@cyanheads/mcp-ts-core/errors';
import { getComtradeReferenceService } from '@/services/comtrade-reference/comtrade-reference-service.js';

const VALID_LEVELS = [2, 4, 6] as const;
type Level = (typeof VALID_LEVELS)[number];

export const hsClassificationResource = resource('comtrade://hs-classification/{level}', {
  name: 'comtrade-hs-classification',
  title: 'Comtrade HS Classification',
  description:
    'Top-level HS commodity hierarchy at the requested aggregation level: ' +
    '2 (HS chapters — 21 sections), 4 (headings — 97 chapters), or 6 (6-digit subheadings). ' +
    'Full leaf-level enumeration is large — use comtrade_search_commodities for keyword search. ' +
    'This resource provides the structural overview for navigation and code discovery.',
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
          })
          .describe('A single HS commodity code entry with description and hierarchy.'),
      )
      .describe('HS codes at this aggregation level.'),
    totalCount: z.number().describe('Total codes at this level.'),
  }),

  handler(params, ctx) {
    const levelNum = Number(params.level);
    if (!VALID_LEVELS.includes(levelNum as Level)) {
      throw notFound(`Invalid HS level "${params.level}". Must be 2, 4, or 6.`, {
        requestedLevel: params.level,
      });
    }

    ctx.log.debug('Serving comtrade://hs-classification resource.', { level: levelNum });
    const ref = getComtradeReferenceService();
    const codes = ref.getAllHsCodes(levelNum as Level);

    return {
      level: levelNum,
      codes: codes.map((h) => ({
        id: h.id,
        description: h.text,
        ...(h.parent && { parent: h.parent }),
        isLeaf: h.isLeaf,
      })),
      totalCount: codes.length,
    };
  },

  list: () => ({
    resources: VALID_LEVELS.map((level) => ({
      uri: `comtrade://hs-classification/${level}`,
      name: `comtrade-hs-classification-${level}`,
      description: `HS commodity codes at ${level === 2 ? 'chapter' : level === 4 ? 'heading' : 'subheading'} level (${level}-digit).`,
      mimeType: 'application/json',
    })),
  }),
});
