/**
 * @fileoverview Comtrade trade data service. Wraps the authenticated data/v1/get
 * and public/v1/preview endpoints with retry/backoff and response normalization.
 * Joins descriptions from the reference service cache before returning results.
 * @module services/comtrade-data/comtrade-data-service
 */

import { z } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import {
  createPacer,
  fetchWithTimeout,
  requestContextService,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { getComtradeReferenceService } from '@/services/comtrade-reference/comtrade-reference-service.js';
import type { TradeDataParams, TradeFlowRecord } from './types.js';
import { upstreamValidationError } from './upstream-validation-error.js';

const FETCH_TIMEOUT_MS = 30_000;
const MAX_FREE_RECORDS = 500;
const REQUEST_DEADLINE_MS = 52_000;
const nullableNumber = z.number().nullish();
const nullableString = z.string().nullish();
const nullableBoolean = z.boolean().nullish();
const rawTradeSchema = z.object({
  count: z.number().nonnegative().optional(),
  data: z.array(
    z.object({
      reporterCode: z.number().optional(),
      reporterDesc: nullableString,
      partnerCode: z.number().optional(),
      partnerDesc: nullableString,
      period: z.union([z.string(), z.number()]).optional(),
      flowCode: z.string().optional(),
      cmdCode: z.string().optional(),
      cmdDesc: nullableString,
      classificationCode: nullableString,
      aggrLevel: nullableNumber,
      aggrlevel: nullableNumber,
      motCode: nullableNumber,
      customsCode: nullableString,
      partner2Code: nullableNumber,
      primaryValue: nullableNumber,
      fobvalue: nullableNumber,
      cifvalue: nullableNumber,
      qty: nullableNumber,
      netWgt: nullableNumber,
      grossWgt: nullableNumber,
      qtyUnitCode: nullableNumber,
      qtyUnitAbbr: nullableString,
      altQty: nullableNumber,
      altQtyUnitCode: nullableNumber,
      altQtyUnitAbbr: nullableString,
      isReported: nullableBoolean,
      isAggregate: nullableBoolean,
      isQtyEstimated: nullableBoolean,
      isNetWgtEstimated: nullableBoolean,
    }),
  ),
});

function malformedResponse(): McpError {
  return new McpError(
    JsonRpcErrorCode.ServiceUnavailable,
    'UN Comtrade returned an invalid trade-data response. Retry the request.',
    {
      reason: 'invalid_upstream_response',
      recovery: {
        hint: 'Retry the request; if the response remains invalid, check UN Comtrade availability.',
      },
      retryable: false,
    },
  );
}

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
    signal?.throwIfAborted();
    if (!hasKey && /^H[0-6]$/.test(params.classificationCode ?? '')) {
      throw new McpError(
        JsonRpcErrorCode.ValidationError,
        'Explicit HS editions H0–H6 are unavailable on keyless trade-data preview. Use HS for as-reported data or configure authenticated access; HS is not an edition substitution.',
        {
          reason: 'keyless_hs_edition_unsupported',
          recovery: {
            hint: 'Use classification HS for as-reported data, or configure COMTRADE_SUBSCRIPTION_KEY to request an explicit edition.',
          },
        },
      );
    }
    if (params.reporterCode === undefined && params.partnerCode === undefined) {
      throw new McpError(
        JsonRpcErrorCode.ValidationError,
        'Omitting the reporter requires an explicit partner code.',
        {
          reason: 'invalid_reporter_filter',
          recovery: { hint: 'Supply reporter_code or an explicit partner_code.' },
        },
      );
    }
    const deadline = AbortSignal.timeout(REQUEST_DEADLINE_MS);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const periods = hasKey ? [params.period] : [...new Set(params.period.split(','))];
    const slices: TradeQueryResult[] = [];
    for (const period of periods) {
      requestSignal.throwIfAborted();
      slices.push(await this.fetchSlice({ ...params, period }, requestSignal));
    }
    const truncated = slices.some((slice) => slice.truncated);
    const referenceNotice = [
      ...new Set(slices.flatMap((slice) => (slice.referenceNotice ? [slice.referenceNotice] : []))),
    ].join(' ');
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
      flowCode: params.flowCode,
      period: params.period,
    });
    if (params.reporterCode !== undefined) {
      queryParams.set(
        'reporterCode',
        Array.isArray(params.reporterCode)
          ? [...new Set(params.reporterCode)].join(',')
          : String(params.reporterCode),
      );
    }

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
          let response: Response;
          try {
            response = await fetchWithTimeout(url, FETCH_TIMEOUT_MS, fetchCtx, fetchOpts);
          } catch (error) {
            throw upstreamValidationError(error);
          }
          const text = await response.text();
          if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
            throw malformedResponse();
          }
          let body: unknown;
          try {
            body = JSON.parse(text);
          } catch {
            throw malformedResponse();
          }
          const parsed = rawTradeSchema.safeParse(body);
          if (!parsed.success) throw malformedResponse();
          return parsed.data;
        };
        return hasKey
          ? fetchRaw(attemptSignal)
          : this.previewPacer.run(fetchRaw, { signal: attemptSignal, maxWaitMs: 60_000 });
      },
      {
        operation: 'ComtradeDataService.fetchTradeData',
        baseDelayMs: 1500,
        deadlineMs: REQUEST_DEADLINE_MS,
        ...(signal && { signal }),
      },
    );

    const rows = raw.data;
    const totalCount = raw.count ?? rows.length;
    const ref = getComtradeReferenceService();
    const isServicesQuery = typeCode === 'S';
    const notices = new Set<string>();
    const catalogs = new Map<string, Awaited<ReturnType<typeof ref.getCommodityCodes>>>();
    const editions = new Set(
      rows.flatMap((row) => {
        if (isServicesQuery || !row.cmdCode || row.cmdCode === 'TOTAL' || row.cmdDesc) return [];
        const edition = row.classificationCode ?? (classCode !== 'HS' ? classCode : undefined);
        return edition ? [edition] : [];
      }),
    );
    for (const edition of editions) {
      try {
        catalogs.set(edition, await ref.getCommodityCodes(edition, signal));
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof Error && error.name === 'AbortError') throw error;
        notices.add(
          `${edition} reference descriptions are unavailable; unresolved commodity codes are shown without descriptions. Trade values are retained.`,
        );
      }
    }
    let units: Awaited<ReturnType<typeof ref.getQuantityUnits>> | undefined;
    if (
      rows.some(
        (row) =>
          (row.qtyUnitCode != null && !row.qtyUnitAbbr) ||
          (row.altQtyUnitCode != null && !row.altQtyUnitAbbr),
      )
    ) {
      try {
        units = await ref.getQuantityUnits(signal);
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof Error && error.name === 'AbortError') throw error;
        notices.add(
          'Quantity unit references are unavailable; numeric unit codes, quantities and estimation flags are retained.',
        );
      }
    }
    const referenceNotice = [...notices].join(' ');

    /**
     * Comtrade preview returns one row per (motCode × customsCode × partner2Code) combination,
     * so summing all rows inflates totals by the number of dimension combinations.
     *
     * For explicit partner queries (including World=0): keep only the top-level aggregate row
     * (motCode=0, customsCode=C00, partner2Code=0), which carries the correct single total.
     *
     * For all-partners single-commodity queries (no partnerCode, no aggrLevel, single cmdCode):
     * dedup by reporter/period/partner/commodity keeping the max-primaryValue row, since most partners
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
      if (params.partnerCode !== undefined) {
        // Explicit partner: retain nonoverlapping totals across the dimensions.
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
          const reporter =
            row.reporterCode ??
            (typeof params.reporterCode === 'number' ? params.reporterCode : '');
          const pc = `${reporter}/${row.period ?? ''}/${row.partnerCode ?? 0}/${row.cmdCode ?? ''}`;
          const existing = bestByPartner.get(pc);
          if (!existing || (row.primaryValue ?? 0) > (existing.primaryValue ?? 0)) {
            bestByPartner.set(pc, row);
          }
        }
        filteredRows = Array.from(bestByPartner.values());
      }
    }

    const records: TradeFlowRecord[] = filteredRows.map((row) => {
      const reporterCode =
        row.reporterCode ??
        (typeof params.reporterCode === 'number' ? params.reporterCode : undefined);
      if (reporterCode === undefined) throw malformedResponse();
      const qtyUnitAbbr =
        row.qtyUnitAbbr ||
        (row.qtyUnitCode != null ? units?.get(row.qtyUnitCode)?.qtyAbbr : undefined);
      const altQtyUnitAbbr =
        row.altQtyUnitAbbr ||
        (row.altQtyUnitCode != null ? units?.get(row.altQtyUnitCode)?.qtyAbbr : undefined);
      const aggrLevel = row.aggrLevel ?? row.aggrlevel;
      const reporterEntry =
        typeof row.reporterCode === 'number' ? ref.getCountryByCode(row.reporterCode) : undefined;
      const partnerEntry =
        typeof row.partnerCode === 'number' ? ref.getCountryByCode(row.partnerCode) : undefined;
      const cmdEntry =
        typeof row.cmdCode === 'string' && row.cmdCode !== 'TOTAL'
          ? isServicesQuery
            ? ref.getEbopsCategory(row.cmdCode)
            : catalogs
                .get(row.classificationCode ?? (classCode !== 'HS' ? classCode : ''))
                ?.get(row.cmdCode)
          : undefined;

      return {
        reporterCode,
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
        ...(row.classificationCode != null && { classificationCode: row.classificationCode }),
        ...(row.qtyUnitCode != null && { qtyUnitCode: row.qtyUnitCode }),
        ...(qtyUnitAbbr && { qtyUnitAbbr }),
        ...(row.altQty != null && { altQty: row.altQty }),
        ...(row.altQtyUnitCode != null && { altQtyUnitCode: row.altQtyUnitCode }),
        ...(altQtyUnitAbbr && { altQtyUnitAbbr }),
        ...(row.isQtyEstimated != null && { isQtyEstimated: row.isQtyEstimated }),
        ...(row.isNetWgtEstimated != null && { isNetWgtEstimated: row.isNetWgtEstimated }),
        ...(row.netWgt != null && { netWgt: row.netWgt }),
        ...(row.grossWgt != null && { grossWgt: row.grossWgt }),
        ...(row.isReported != null && { isReported: row.isReported }),
        ...(aggrLevel != null && { aggrLevel }),
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
