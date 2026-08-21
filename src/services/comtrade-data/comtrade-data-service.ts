/**
 * @fileoverview Comtrade trade data service. Wraps the authenticated data/v1/get
 * and public/v1/preview endpoints with retry/backoff and response normalization.
 * Joins descriptions from the reference service cache before returning results.
 * @module services/comtrade-data/comtrade-data-service
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, requestContextService, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { getComtradeReferenceService } from '@/services/comtrade-reference/comtrade-reference-service.js';
import type { RawTradeResponse, TradeDataParams, TradeFlowRecord } from './types.js';

const FETCH_TIMEOUT_MS = 30_000;
const MAX_FREE_RECORDS = 500;

export interface TradeQueryResult {
  records: TradeFlowRecord[];
  /** Total count as reported by the API (may exceed records.length when truncated). */
  totalCount: number;
  /** True when totalCount > records.length (preview cap hit). */
  truncated: boolean;
  /** Guidance on how to get more data when truncated. */
  truncationHint?: string;
}

/** Handles authenticated and preview trade data requests against the Comtrade API. */
export class ComtradeDataService {
  // biome-ignore lint/complexity/noUselessConstructor: params reserved for future use
  constructor(_config: AppConfig, _storage: StorageService) {}

  /** Fetch trade data records. Automatically selects authenticated or preview endpoint. */
  async fetchTradeData(params: TradeDataParams, signal?: AbortSignal): Promise<TradeQueryResult> {
    const serverConfig = getServerConfig();
    const hasKey = Boolean(serverConfig.subscriptionKey);
    const baseUrl = serverConfig.apiBaseUrl;

    const typeCode = params.typeCode ?? 'C';
    const freqCode = params.freqCode ?? 'A';
    const classCode = params.classificationCode ?? 'HS';

    const endpoint = hasKey
      ? `${baseUrl}/data/v1/get/${typeCode}/${freqCode}/${classCode}`
      : `${baseUrl}/public/v1/preview/${typeCode}/${freqCode}/${classCode}`;

    const queryParams = new URLSearchParams({
      reporterCode: String(params.reporterCode),
      flowCode: params.flowCode,
      period: params.period,
    });

    if (params.partnerCode !== undefined) {
      queryParams.set('partnerCode', String(params.partnerCode));
    }
    if (params.cmdCode) {
      queryParams.set('cmdCode', params.cmdCode);
    }
    if (params.aggrLevel !== undefined) {
      queryParams.set('aggrLevel', String(params.aggrLevel));
    }
    if (hasKey && params.maxRecords !== undefined) {
      queryParams.set('maxrecords', String(params.maxRecords));
    }

    const url = `${endpoint}?${queryParams.toString()}`;

    const raw = await withRetry(
      async () => {
        const { subscriptionKey } = serverConfig;
        const headers: Record<string, string> = subscriptionKey
          ? { 'Ocp-Apim-Subscription-Key': subscriptionKey }
          : {};
        const fetchCtx = requestContextService.createRequestContext({
          operation: 'ComtradeDataService.fetchTradeData',
        });
        const fetchOpts = { headers, ...(signal && { signal }) };
        const response = await fetchWithTimeout(url, FETCH_TIMEOUT_MS, fetchCtx, fetchOpts);
        const text = await response.text();
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw new Error('Comtrade API returned HTML — service may be unavailable.');
        }
        return JSON.parse(text) as RawTradeResponse;
      },
      {
        operation: 'ComtradeDataService.fetchTradeData',
        baseDelayMs: 1500,
        ...(signal && { signal }),
      },
    );

    const rows = raw.data ?? [];
    const totalCount = raw.count ?? rows.length;
    const ref = getComtradeReferenceService();
    const isServicesQuery = typeCode === 'S';

    /**
     * Comtrade preview returns one row per (motCode × customsCode × partner2Code) combination,
     * so summing all rows inflates totals by the number of dimension combinations.
     *
     * For world-aggregate queries (partnerCode=0): keep only the top-level aggregate row
     * (motCode=0, customsCode=C00, partner2Code=0), which carries the correct single total.
     *
     * For all-partners single-commodity queries (no partnerCode, no aggrLevel, single cmdCode):
     * dedup by partnerCode keeping the max-primaryValue row per partner, since most partners
     * lack a C00 aggregate row and the highest-value row is the bilateral total. Only safe when
     * the query targets a single commodity (TOTAL or one code) — commodity breakdown queries
     * (aggrLevel set, or multi-code cmdCode) must NOT be deduped because they intentionally
     * return multiple rows per partner (one per commodity code).
     *
     * Services data (typeCode=S) does not exhibit this dimension expansion — all rows carry
     * motCode=0/C00/partner2Code=0, so no filtering is needed there.
     */
    let filteredRows = rows;
    if (!isServicesQuery) {
      if (params.partnerCode === 0) {
        // World-aggregate: exactly one correct row with the top-level dimension combination
        filteredRows = rows.filter(
          (r) => r.motCode === 0 && r.customsCode === 'C00' && r.partner2Code === 0,
        );
      } else if (
        params.partnerCode === undefined &&
        params.aggrLevel === undefined &&
        !params.cmdCode?.includes(',')
      ) {
        // All-partners, single-commodity: dedup by partnerCode keeping max primaryValue row
        const bestByPartner = new Map<number, (typeof rows)[0]>();
        for (const row of rows) {
          const pc = row.partnerCode ?? 0;
          const existing = bestByPartner.get(pc);
          if (!existing || (row.primaryValue ?? 0) > (existing.primaryValue ?? 0)) {
            bestByPartner.set(pc, row);
          }
        }
        filteredRows = Array.from(bestByPartner.values());
      }
    }

    const records: TradeFlowRecord[] = filteredRows.map((row) => {
      const reporterEntry =
        typeof row.reporterCode === 'number' ? ref.getCountryByCode(row.reporterCode) : undefined;
      const partnerEntry =
        typeof row.partnerCode === 'number' ? ref.getCountryByCode(row.partnerCode) : undefined;
      const cmdEntry =
        typeof row.cmdCode === 'string' && row.cmdCode !== 'TOTAL'
          ? isServicesQuery
            ? ref.getEbopsCategory(row.cmdCode)
            : ref.getHsCode(row.cmdCode)
          : undefined;

      return {
        reporterCode: row.reporterCode ?? params.reporterCode,
        reporterDesc: row.reporterDesc || reporterEntry?.name || String(row.reporterCode ?? ''),
        partnerCode: row.partnerCode ?? 0,
        partnerDesc: row.partnerDesc || partnerEntry?.name || String(row.partnerCode ?? ''),
        flowCode: row.flowCode ?? params.flowCode,
        cmdCode: row.cmdCode ?? params.cmdCode ?? 'TOTAL',
        cmdDesc:
          row.cmdDesc ||
          cmdEntry?.text ||
          (row.cmdCode === 'TOTAL' ? 'Total (all commodities)' : (row.cmdCode ?? '')),
        period: String(row.period ?? ''),
        ...(row.primaryValue != null && { primaryValue: row.primaryValue }),
        ...(row.fobvalue != null && { fobvalue: row.fobvalue }),
        ...(row.cifvalue != null && { cifvalue: row.cifvalue }),
        ...(row.qty != null && { qty: row.qty }),
        ...(row.netWgt != null && { netWgt: row.netWgt }),
        ...(row.grossWgt != null && { grossWgt: row.grossWgt }),
        ...(row.isReported != null && { isReported: row.isReported }),
        ...(row.aggrLevel != null && { aggrLevel: row.aggrLevel }),
      };
    });

    const truncated = !hasKey && records.length >= MAX_FREE_RECORDS && totalCount > records.length;

    return {
      records,
      totalCount,
      truncated,
      ...(truncated && {
        truncationHint:
          'Results are capped at 500 records on the public preview endpoint. ' +
          'Set COMTRADE_SUBSCRIPTION_KEY to access up to 250,000 records per call, ' +
          'or narrow the query by commodity code, partner, or period.',
      }),
    };
  }
}

let _service: ComtradeDataService | undefined;

/** Initialize the data service. Call once from createApp() setup(). */
export function initComtradeDataService(config: AppConfig, storage: StorageService): void {
  _service = new ComtradeDataService(config, storage);
}

/** Access the initialized data service. Throws if not initialized. */
export function getComtradeDataService(): ComtradeDataService {
  if (!_service) {
    throw new Error(
      'ComtradeDataService not initialized — call initComtradeDataService() in setup()',
    );
  }
  return _service;
}
