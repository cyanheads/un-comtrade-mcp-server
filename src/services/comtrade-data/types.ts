/**
 * @fileoverview Domain types for the Comtrade trade data service.
 * @module services/comtrade-data/types
 */

/** Parameters for a trade data query. */
export interface TradeDataParams {
  /** Aggregation level for HS (2, 4, or 6). */
  aggrLevel?: number;
  /** HS classification version. */
  classificationCode?: string;
  /** HS commodity codes, comma-separated. TOTAL = sum all commodities. */
  cmdCode?: string;
  /** Trade flow code: M=import, X=export, RX=re-export, RM=re-import. */
  flowCode: 'M' | 'X' | 'RX' | 'RM';
  /** A=annual, M=monthly. */
  freqCode?: 'A' | 'M';
  /** Maximum records to return (default 500, premium up to 250000). */
  maxRecords?: number;
  /** Partner code; omit for all partners; 0 = World aggregate. */
  partnerCode?: number;
  /** Periods as YYYY (annual) or YYYYMM (monthly), joined as CSV. */
  period: string;
  /** M49 reporter code. */
  reporterCode: number;
  /** Type: C=commodities, S=services. */
  typeCode?: 'C' | 'S';
}

/** A single trade flow record returned by the Comtrade API. */
export interface TradeFlowRecord {
  /** HS digit aggregation level. */
  aggrLevel?: number;
  /** CIF value (imports only). */
  cifvalue?: number;
  /** HS commodity code or "TOTAL". */
  cmdCode: string;
  /** Commodity description (joined from reference cache). */
  cmdDesc: string;
  /** Trade flow code. */
  flowCode: string;
  /** FOB value (exports only). */
  fobvalue?: number;
  /** Gross weight in kg. */
  grossWgt?: number;
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
  /** M49 reporter code. */
  reporterCode: number;
  /** Reporter name (joined from reference cache). */
  reporterDesc: string;
}

/** Raw trade flow row from the Comtrade API response. */
export interface RawTradeRow {
  aggrLevel?: number | null;
  cifvalue?: number | null;
  cmdCode?: string;
  cmdDesc?: string;
  flowCode?: string;
  fobvalue?: number | null;
  grossWgt?: number | null;
  isReported?: boolean | null;
  netWgt?: number | null;
  partnerCode?: number;
  partnerDesc?: string;
  period?: string | number;
  primaryValue?: number | null;
  qty?: number | null;
  reporterCode?: number;
  reporterDesc?: string;
  [key: string]: unknown;
}

/** Raw API response envelope from Comtrade data endpoints. */
export interface RawTradeResponse {
  count?: number;
  data?: RawTradeRow[];
  error?: string | unknown;
  message?: string;
  validation?: unknown;
}
