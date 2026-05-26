/**
 * @fileoverview Domain types for the Comtrade metadata/availability service.
 * @module services/comtrade-meta/types
 */

/** A data availability record from the Comtrade getDA endpoint. */
export interface DataAvailabilityRecord {
  /** Classification code (HS, H0–H6, EB10, etc.). */
  classificationCode: string;
  /** Frequency code: A=annual, M=monthly. */
  freqCode: string;
  /** Period (YYYY or YYYYMM). */
  period: string;
  /** Publication date. */
  publicationDate?: string;
  /** M49 reporter code. */
  reporterCode: number;
  /** Reporter name. */
  reporterDesc: string;
  /** Number of records available. */
  totalRecords?: number;
  /** Trade type: C=commodities, S=services. */
  typeCode: string;
}

/** Raw availability row from the Comtrade API. */
export interface RawAvailabilityRow {
  classificationCode?: string;
  freqCode?: string;
  period?: string | number;
  publicationDate?: string;
  reporterCode?: number;
  reporterDesc?: string;
  totalRecords?: number;
  typeCode?: string;
  [key: string]: unknown;
}

/** Raw API response from getDA. */
export interface RawAvailabilityResponse {
  count?: number;
  data?: RawAvailabilityRow[];
  error?: string | unknown;
  message?: string;
}
