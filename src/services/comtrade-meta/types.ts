/**
 * @fileoverview Domain types for the Comtrade metadata/availability service.
 * @module services/comtrade-meta/types
 */

import { z } from '@cyanheads/mcp-ts-core';

/** A data availability record from the Comtrade getDA endpoint. */
export interface DataAvailabilityRecord {
  /** Classification code (HS, H0–H6, EB10, etc.). */
  classificationCode: string;
  /** First release timestamp, as supplied by UN Comtrade. */
  firstReleased?: string;
  /** Frequency code: A=annual, M=monthly. */
  freqCode: string;
  /** Latest release or revision timestamp, as supplied by UN Comtrade. */
  lastReleased?: string;
  /** Period (YYYY or YYYYMM). */
  period: string;
  /** M49 reporter code. */
  reporterCode: number;
  /** Reporter name. */
  reporterDesc: string;
  /** Number of records available. */
  totalRecords?: number;
  /** Trade type: C=commodities, S=services. */
  typeCode: string;
}

/** Validate the availability envelope while retaining upstream sparsity. */
export const rawAvailabilitySchema = z.object({
  data: z.array(
    z.object({
      classificationCode: z.string().nullish(),
      firstReleased: z.string().nullish(),
      freqCode: z.string().nullish(),
      lastReleased: z.string().nullish(),
      period: z.union([z.string(), z.number()]).nullish(),
      reporterCode: z.number().nullish(),
      reporterDesc: z.string().nullish(),
      totalRecords: z.number().nullish(),
      typeCode: z.string().nullish(),
    }),
  ),
});
