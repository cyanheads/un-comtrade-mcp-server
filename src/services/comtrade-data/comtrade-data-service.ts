/**
 * @fileoverview Comtrade trade data service. Wraps the authenticated data/v1/get
 * and public/v1/preview endpoints with retry/backoff and response normalization.
 * Joins descriptions from the reference service cache before returning results.
 * @module services/comtrade-data/comtrade-data-service
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import {
  createPacer,
  fetchWithTimeout,
  requestContextService,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { getComtradeReferenceService } from '@/services/comtrade-reference/comtrade-reference-service.js';
import type { RawTradeResponse, TradeDataParams, TradeFlowRecord } from './types.js';

const FETCH_TIMEOUT_MS = 30_000;
const MAX_FREE_RECORDS = 500;

/** Normalized records and coverage information from one or more upstream responses. */
export interface TradeQueryResult {
  records: TradeFlowRecord[];
  /** Missing reference descriptions leave original codes and trade values intact. */
  referenceNotice?: string;
  /** Sum of upstream counts before normalization; not the full match count when capped. */
  totalCount: number;
  /** True when any raw preview slice reaches its cap and may be incomplete. */
  truncated: boolean;
  /** Guidance on how to get more data when truncated. */
  truncationHint?: string;
}

/** Handles authenticated and preview trade data requests against the Comtrade API. */
export class ComtradeDataService {
  private readonly previewPacer = createPacer({
    name: 'comtrade-preview',
    minStartGapMs: 1000,
    maxConcurrent: 1,
    maxQueueDepth: 48,
    cooldown: { baseMs: 1500, maxMs: 30_000 },
  });

  // biome-ignore lint/complexity/noUselessConstructor: params reserved for future use
  constructor(_config: AppConfig, _storage: StorageService) {}

  /** Fetch trade data records. Automatically selects authenticated or preview endpoint. */
  async fetchTradeData(params: TradeDataParams, signal?: AbortSignal): Promise<TradeQueryResult> {
    const hasKey = Boolean(getServerConfig().subscriptionKey);
    const periods = hasKey ? [params.period] : [...new Set(params.period.split(','))];
    const slices: TradeQueryResult[] = [];
    for (const period of periods) {
      signal?.throwIfAborted();
      slices.push(await this.fetchSlice({ ...params, period }, signal));
    }
    const truncated = slices.some((slice) => slice.truncated);
    const referenceNotice = slices.find((slice) => slice.referenceNotice)?.referenceNotice;
    const truncationHint = slices.find((slice) => slice.truncationHint)?.truncationHint;
    return {
      records: slices.flatMap((slice) => slice.records),
      totalCount: slices.reduce((sum, slice) => sum + slice.totalCount, 0),
      truncated,
      ...(referenceNotice && { referenceNotice }),
      ...(truncationHint && { truncationHint }),
    };
  }

  /** Release queued preview work on server shutdown. */
  dispose(): void {
    this.previewPacer.dispose();
  }

  private async fetchSlice(
    params: TradeDataParams,
    signal?: AbortSignal,
  ): Promise<TradeQueryResult> {
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
      ({ signal: attemptSignal }) => {
        const fetchRaw = async (requestSignal: AbortSignal | undefined) => {
          const { subscriptionKey } = serverConfig;
          const headers: Record<string, string> = subscriptionKey
            ? { 'Ocp-Apim-Subscription-Key': subscriptionKey }
            : {};
          const fetchCtx = requestContextService.createRequestContext({
            operation: 'ComtradeDataService.fetchTradeData',
          });
          const fetchOpts = { headers, ...(requestSignal && { signal: requestSignal }) };
          const response = await fetchWithTimeout(url, FETCH_TIMEOUT_MS, fetchCtx, fetchOpts);
          const text = await response.text();
          if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
            throw new Error('Comtrade API returned HTML — service may be unavailable.');
          }
          return JSON.parse(text) as RawTradeResponse;
        };
        return hasKey
          ? fetchRaw(attemptSignal)
          : this.previewPacer.run(fetchRaw, { signal: attemptSignal, maxWaitMs: 60_000 });
      },
      {
        operation: 'ComtradeDataService.fetchTradeData',
        baseDelayMs: 1500,
        deadlineMs: 120_000,
        ...(signal && { signal }),
      },
    );

    const rows = raw.data ?? [];
    const totalCount = raw.count ?? rows.length;
    const ref = getComtradeReferenceService();
    const isServicesQuery = typeCode === 'S';
    const isSitc = !isServicesQuery && ['S1', 'S2', 'S3', 'S4', 'SS'].includes(classCode);
    let sitc: Awaited<ReturnType<typeof ref.getSitcCodes>> | undefined;
    let referenceNotice: string | undefined;
    if (isSitc && rows.some((row) => row.cmdCode && row.cmdCode !== 'TOTAL' && !row.cmdDesc)) {
      try {
        sitc = await ref.getSitcCodes(classCode, signal);
      } catch {
        signal?.throwIfAborted();
        referenceNotice = `${classCode} reference descriptions are unavailable; unresolved commodity codes are shown without descriptions. Trade values are retained.`;
      }
    }

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
        !/^AG\d+$/.test(params.cmdCode ?? '') &&
        !params.cmdCode?.includes(',')
      ) {
        // All-partners, single-commodity: dedup by partnerCode keeping max primaryValue row
        const bestByPartner = new Map<string, (typeof rows)[0]>();
        for (const row of rows) {
          const pc = `${row.period ?? ''}/${row.partnerCode ?? 0}`;
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
            : isSitc
              ? sitc?.get(row.cmdCode)
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

    const truncated =
      !hasKey && (rows.length >= MAX_FREE_RECORDS || totalCount >= MAX_FREE_RECORDS);

    return {
      records,
      totalCount,
      truncated,
      ...(referenceNotice && { referenceNotice }),
      ...(truncated && {
        truncationHint:
          'A public preview response reached 500 records and may be incomplete. ' +
          'Narrow the query by commodity code, partner, or period. ' +
          'COMTRADE_SUBSCRIPTION_KEY selects authenticated access; retrieval limits depend on UN Comtrade and the subscription.',
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
