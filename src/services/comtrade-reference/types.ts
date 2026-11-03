/**
 * @fileoverview Domain types for the Comtrade reference data service.
 * @module services/comtrade-reference/types
 */

import { z } from '@cyanheads/mcp-ts-core';

/** A normalized country/area entry combining reporter and partner dimensions. */
export interface CountryEntry {
  /** M49 numeric code. */
  id: number;
  /** Whether this area is a geographic/economic grouping. */
  isGroup: boolean;
  /** ISO alpha-2 code. */
  iso2?: string;
  /** ISO alpha-3 code. */
  iso3?: string;
  /** Display name. */
  name: string;
  /** Whether this area can be used as a reporter code. */
  validAsReporter: boolean;
}

/** An HS commodity code entry (goods). */
export interface HsCode {
  /** Number of HS digits (2, 4, or 6). */
  aggrLevel: 2 | 4 | 6;
  /** HS code string, e.g. "84", "8471", "847130". */
  id: string;
  /** Whether this code has no children (leaf node). */
  isLeaf: boolean;
  /** Parent HS code (2-digit chapter for 4-digit; 4-digit heading for 6-digit). */
  parent?: string;
  /** Recommended code level for trade queries. */
  recommendedQueryCode: string;
  /** Full English description. */
  text: string;
}

/** A service category from the combined EB reference catalog. */
export interface EbopsCategory {
  /** EBOPS category code, e.g. "SA". */
  id: string;
  /** Parent category code. */
  parent?: string;
  /** Full English description. */
  text: string;
}

/** Fields used from the UN Comtrade reporter reference file. */
export const rawReporterSchema = z.object({
  reporterCode: z.number(),
  reporterDesc: z.string(),
  reporterCodeIsoAlpha2: z.string().optional(),
  reporterCodeIsoAlpha3: z.string().optional(),
  isGroup: z.union([z.boolean(), z.string(), z.number()]).optional(),
});

/** Fields used from the UN Comtrade partner reference file. */
export const rawPartnerSchema = z.object({
  PartnerCode: z.number(),
  PartnerDesc: z.string(),
  PartnerCodeIsoAlpha2: z.string().optional(),
  PartnerCodeIsoAlpha3: z.string().optional(),
  isGroup: z.union([z.boolean(), z.string(), z.number()]).optional(),
});

/** Native commodity catalog fields; old editions spell aggregation as aggrlevel. */
export const rawHsSchema = z.object({
  id: z.string(),
  text: z.string(),
  aggrLevel: z.number().optional(),
  aggrlevel: z.number().optional(),
  parent: z.string().optional(),
  isLeaf: z.union([z.number(), z.boolean(), z.string()]).optional(),
});

/** A parsed upstream commodity entry. */
export type RawHsEntry = z.infer<typeof rawHsSchema>;

/** Fields used from the combined EB reference file. */
export const rawEbopsSchema = z.object({
  id: z.string(),
  text: z.string(),
  parent: z.string().optional(),
});

/** Goods catalog names supported by UN Comtrade's reference endpoint. */
export const COMMODITY_CLASSIFICATIONS = [
  'HS',
  'H0',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'SS',
  'S1',
  'S2',
  'S3',
  'S4',
] as const;

/** A commodity catalog entry retaining its native aggregation level. */
export interface CommodityCode {
  aggrLevel: number;
  id: string;
  isLeaf: boolean;
  parent?: string;
  recommendedQueryCode: string;
  text: string;
}

/** A quantity unit keyed by the numeric qtyCode on trade records; -1 means unavailable. */
export interface QuantityUnit {
  qtyAbbr: string;
  qtyCode: number;
  qtyDescription: string;
}
