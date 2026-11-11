/**
 * @fileoverview Domain types for the Comtrade reference data service.
 * @module services/comtrade-reference/types
 */

import { z } from '@cyanheads/mcp-ts-core';

/** A normalized country/area entry combining reporter and partner dimensions. */
export interface CountryEntry {
  /** First day the entity is valid, `YYYY-MM-DD`; `1900-01-01` is upstream's open start. */
  entryEffectiveDate?: string;
  /** Last day the entity was valid, `YYYY-MM-DD`; absent while the entity is current. */
  entryExpiredDate?: string;
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
  /**
   * Upstream's long-form name or coverage note, e.g. "Republic of Korea" or "France, Monaco";
   * absent when it only repeats the name.
   */
  note?: string;
  /** Whether this area can be used as a reporter code. */
  validAsReporter: boolean;
}

/**
 * A country lookup match. `standsInFor` is the matched entry whose trade UN Comtrade publishes
 * under this one (490 Other Asia, nes for 158 Taiwan, Province of China).
 */
export type CountryMatch = CountryEntry & { standsInFor?: CountryEntry };

/**
 * The reporter-valid code to query instead of a partner-only one, by basis: `iso3`, the entry
 * sharing its ISO-3 identity, current before expired (250 Metropolitan France → 251 France);
 * `published_under`, the code UN Comtrade publishes the entity's trade under, which neither
 * catalog links to it (158 → 490 Other Asia, nes).
 */
type ReporterSuggestion =
  | { suggestedReporterCode?: undefined }
  | { suggestedReporterCode: number; suggestionBasis: 'iso3' }
  | {
      suggestedReporterCode: number;
      suggestionBasis: 'published_under';
      /** Catalog name of the suggested code. */
      suggestedReporterName: string;
    };

/**
 * How the startup reference index classifies a code used as a reporter. It annotates empty
 * results only: a dropped Reporters.json row can make a real reporter read as partner-only.
 */
export type ReporterStatus =
  | { referenceStatus: 'reporter'; name: string }
  | ({ referenceStatus: 'partner_only'; name: string } & ReporterSuggestion)
  | { referenceStatus: 'unknown' };

/** An HS commodity code entry (goods). */
export interface HsCode {
  /** 0 for the all-commodities TOTAL, otherwise the number of HS digits (2, 4, or 6). */
  aggrLevel: 0 | 2 | 4 | 6;
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

/** Upstream writes entity dates as `YYYY-MM-DDT00:00:00`; only the date part carries meaning. */
const referenceDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}/);

/**
 * One row of either country file. Identity is read from `id`/`text`, which every row of both
 * files carries; ISO codes and the long-form note may use the reporter or the partner spelling,
 * because Reporters.json can hold partner-shaped rows.
 */
export const rawCountrySchema = z.object({
  id: z.number().int(),
  text: z.string(),
  reporterCodeIsoAlpha2: z.string().optional(),
  reporterCodeIsoAlpha3: z.string().optional(),
  PartnerCodeIsoAlpha2: z.string().optional(),
  PartnerCodeIsoAlpha3: z.string().optional(),
  reporterNote: z.string().optional(),
  partnerNote: z.string().optional(),
  isGroup: z.union([z.boolean(), z.string(), z.number()]).optional(),
  entryEffectiveDate: referenceDateSchema.optional(),
  entryExpiredDate: referenceDateSchema.optional(),
});

/** A parsed row of Reporters.json or partnerAreas.json. */
export type RawCountry = z.infer<typeof rawCountrySchema>;

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

/** Fields used from the combined EB reference file and the per-scheme EB catalogs. */
export const rawEbopsSchema = z.object({
  id: z.string(),
  text: z.string(),
  parent: z.string().optional(),
});

/** Per-scheme EBOPS catalogs published beside the combined EB.json, in tag order. */
export const EB_SCHEMES = ['EB10', 'EB10S', 'EB02'] as const;

/** An EBOPS scheme: EB10 (EBOPS 2010), EB10S (EBOPS 2010 SDMX codes), EB02 (EBOPS 2002). */
export type EbScheme = (typeof EB_SCHEMES)[number];

/** A combined-EB category tagged with the scheme catalogs that list its code. */
export interface ServiceCategory extends EbopsCategory {
  /**
   * EB.json's own parent when it names no EB.json code and a scheme catalog supplies `parent`
   * instead: EB10's top-level codes, which EB.json parents under the absent id `TOTAL`.
   */
  ebParent?: string;
  /** Scheme catalogs listing this code, in `EB_SCHEMES` order; empty when none lists it. */
  schemes: EbScheme[];
}

/** EB categories tagged by scheme, or untagged with the scheme catalogs that failed to load. */
export type ServiceCategoryListing =
  | { status: 'tagged'; categories: ServiceCategory[] }
  | { status: 'untagged'; categories: EbopsCategory[]; unavailableCatalogs: string[] };

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
