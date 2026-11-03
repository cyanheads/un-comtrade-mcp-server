/**
 * @fileoverview Domain types for the Comtrade trade data service.
 * @module services/comtrade-data/types
 */

/** Parameters for a trade data query. */
export interface TradeDataParams {
  /** Aggregation level for HS (2, 4, or 6). */
  aggrLevel?: number;
  /** Goods or services classification code (HS, SITC, or EBOPS). */
  classificationCode?: string;
  /** Commodity codes or AG selectors, comma-separated. TOTAL = sum all commodities. */
  cmdCode?: string;
  /** Trade flow code: M=import, X=export, RX=re-export, RM=re-import. */
  flowCode: 'M' | 'X' | 'RX' | 'RM';
  /** A=annual, M=monthly. */
  freqCode?: 'A' | 'M';
  /** Optional authenticated retrieval bound; upstream/subscription limits apply. */
  maxRecords?: number;
  /** Partner code; omit for all partners; 0 = World aggregate. */
  partnerCode?: number;
  /** Periods as YYYY (annual) or YYYYMM (monthly), joined as CSV. */
  period: string;
  /** M49 reporter code. */
  reporterCode?: number | number[];
  /** Type: C=commodities, S=services. */
  typeCode?: 'C' | 'S';
}

/** A single trade flow record returned by the Comtrade API. */
export interface TradeFlowRecord {
  /** Commodity aggregation level supplied by UN Comtrade. */
  aggrLevel?: number;
  /** Alternate quantity and its independent unit. */
  altQty?: number;
  altQtyUnitAbbr?: string;
  altQtyUnitCode?: number;
  /** CIF value (imports only). */
  cifvalue?: number;
  /** Actual classification edition supplied on the upstream row. */
  classificationCode?: string;
  /** HS, SITC, or EBOPS commodity/category code or "TOTAL". */
  cmdCode: string;
  /** Commodity description (joined from reference cache). */
  cmdDesc: string;
  /** Trade flow code. */
  flowCode: string;
  /** FOB value (exports only). */
  fobvalue?: number;
  /** Gross weight in kg. */
  grossWgt?: number;
  isNetWgtEstimated?: boolean;
  /** Upstream estimation flags, absent when not supplied. */
  isQtyEstimated?: boolean;
  /** Whether directly reported (true) or estimated/aggregated (false). */
  isReported?: boolean;
  /** Net weight in kg. */
  netWgt?: number;
  /** M49 partner code. */
  partnerCode: number;
  /** Partner name (joined from reference cache). */
  partnerDesc: string;
  /** Period (YYYY or YYYYMM). */
  period: string;
  /** Primary value in USD (FOB for exports, CIF for imports). */
  primaryValue?: number;
  /** Quantity (in commodity-specific units). */
  qty?: number;
  qtyUnitAbbr?: string;
  /** Quantity unit identity and abbreviation; -1/N/A means unavailable. */
  qtyUnitCode?: number;
  /** M49 reporter code. */
  reporterCode: number;
  /** Reporter name (joined from reference cache). */
  reporterDesc: string;
}
