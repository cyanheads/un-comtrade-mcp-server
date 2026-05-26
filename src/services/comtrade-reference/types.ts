/**
 * @fileoverview Domain types for the Comtrade reference data service.
 * @module services/comtrade-reference/types
 */

/** A reporter (country/area that submitted data to Comtrade). */
export interface Reporter {
  /** Entry type — reporter entries are always "reporter" in the raw file. */
  entryEffectiveDate?: string;
  /** Whether this code was still active (null = no end date = active). */
  entryExpiredDate?: string;
  /** M49 numeric code used in all Comtrade API calls. */
  id: number;
  /** Whether this area can be used as a reporter code in data queries. */
  isGroup: boolean;
  /** ISO alpha-2 code, when available. */
  iso2?: string;
  /** ISO alpha-3 code, when available. */
  iso3?: string;
  /** Display name (English). */
  text: string;
}

/** A partner area (origin/destination in bilateral flows). */
export interface PartnerArea {
  /** M49 numeric code. Partner code 0 = World aggregate. */
  id: number;
  /** Whether this area is a geographic grouping (not a single country). */
  isGroup: boolean;
  /** ISO alpha-2 code, when available. */
  iso2?: string;
  /** ISO alpha-3 code, when available. */
  iso3?: string;
  /** Display name (English). */
  text: string;
}

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

/** An EBOPS 2010 service trade category. */
export interface EbopsCategory {
  /** EBOPS category code, e.g. "SA". */
  id: string;
  /** Parent category code. */
  parent?: string;
  /** Full English description. */
  text: string;
}

/** Raw entry from the UN Comtrade reporter JSON file. */
export interface RawReporterEntry {
  entryEffectiveDate?: string;
  entryExpiredDate?: string;
  isGroup?: string | number;
  reporterCode: number;
  reporterCodeIsoAlpha3?: string;
  reporterDesc: string;
  reporterNote?: string;
}

/** Raw entry from the UN Comtrade partnerAreas JSON file. */
export interface RawPartnerEntry {
  entryEffectiveDate?: string;
  entryExpiredDate?: string;
  isGroup?: string | number;
  PartnerCode: number;
  PartnerCodeIsoAlpha3?: string;
  PartnerDesc: string;
  partnerNote?: string;
}

/** Raw entry from the UN Comtrade HS reference JSON file. */
export interface RawHsEntry {
  aggrLevel?: number;
  id: string;
  isLeaf?: number | boolean;
  parent?: string;
  text: string;
}

/** Raw entry from the UN Comtrade EBOPS reference JSON file. */
export interface RawEbopsEntry {
  aggrLevel?: number;
  id: string;
  parent?: string;
  text: string;
}
