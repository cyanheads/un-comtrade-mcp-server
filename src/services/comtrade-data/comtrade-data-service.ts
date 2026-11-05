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
import type {
  TradeDataParams,
  TradeFlowRecord,
  TradePeriodFailure,
  TradePeriodFailureReason,
} from './types.js';
import { upstreamValidationError } from './upstream-validation-error.js';

const FETCH_TIMEOUT_MS = 30_000;
const MAX_FREE_RECORDS = 500;
/**
 * Wall-clock budget for the trade-data requests of one tool call — every period, attempt,
 * backoff, and queued start — so the call settles under MCP clients' 60 s default request
 * timeout. A caller making several `fetchTradeData` calls builds one `deadlineAt` from it.
 */
export const TRADE_DATA_DEADLINE_MS = 52_000;
/** UN Comtrade refuses (429) keyless preview starts within ~3 s of the last one it accepted. */
const PREVIEW_START_GAP_MS = 4_000;
/** Keyless requests one call may start: 7 gaps × 4 s = 28 s of pacing, 24 s left for latency and retried 429s. */
const KEYLESS_REQUESTS_PER_CALL = 8;
/** Authenticated calls batch every period into one request. */
const KEYED_PERIODS_PER_CALL = 12;
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
      isOriginalClassification: nullableBoolean,
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

/**
 * Why a period's request failed transiently, or undefined for a failure that fails the call
 * (upstream validation, malformed data, cancellation). A pacer shed means no preview slot opened
 * before the call's deadline: every start's wait budget is the time left, which binds long
 * before the 48-deep queue fills at 4 s spacing.
 */
function periodFailureReason(error: unknown): TradePeriodFailureReason | undefined {
  if (error instanceof McpError) {
    if (error.code === JsonRpcErrorCode.RateLimited)
      return error.data?.reason === 'pacer_shed' ? 'deadline_exceeded' : 'rate_limited';
    return error.code === JsonRpcErrorCode.Timeout ? 'deadline_exceeded' : undefined;
  }
  return error instanceof Error && error.name === 'TimeoutError' ? 'deadline_exceeded' : undefined;
}

/** `Retry-After` as whole seconds: the upstream header string or the pacer's number. */
function retryAfterSeconds(error: unknown): number | undefined {
  const value = error instanceof McpError ? Number(error.data?.retryAfter) : Number.NaN;
  return Number.isFinite(value) && value >= 0 ? Math.ceil(value) : undefined;
}

/** The wait a caller is told: the longest stated wait, never below one preview start gap. */
function failureWaitSeconds(failures: readonly TradePeriodFailure[]): number {
  return Math.max(PREVIEW_START_GAP_MS / 1000, ...failures.map((f) => f.retryAfterSeconds ?? 0));
}

function periodsPhrase(periods: string[]): string {
  return periods.length === 1 ? `Period ${periods[0]} was` : `Periods ${periods.join(', ')} were`;
}

/** Failures deduplicated by period, a rate limit outranking a deadline for the same period. */
function groupFailures(failures: readonly TradePeriodFailure[]) {
  const limited = new Map<string, TradePeriodFailure>();
  const late = new Set<string>();
  for (const failure of failures) {
    if (failure.reason === 'rate_limited') {
      const known = limited.get(failure.period);
      limited.set(
        failure.period,
        known && (known.retryAfterSeconds ?? 0) >= (failure.retryAfterSeconds ?? 0)
          ? known
          : failure,
      );
    } else late.add(failure.period);
  }
  for (const period of limited.keys()) late.delete(period);
  return { limited: [...limited.values()], late: [...late] };
}

/** One sentence per failure reason naming the unserved periods and, for rate limits, the wait. */
export function describePeriodFailures(failures: readonly TradePeriodFailure[]): string {
  const { limited, late } = groupFailures(failures);
  const sentences: string[] = [];
  if (limited.length > 0)
    sentences.push(
      `${periodsPhrase(limited.map((f) => f.period))} rate-limited; wait ${failureWaitSeconds(limited)} seconds before requesting ${limited.length === 1 ? 'it' : 'them'} again.`,
    );
  if (late.length > 0)
    sentences.push(`${periodsPhrase(late)} not completed within the call's time budget.`);
  return sentences.join(' ');
}

/**
 * The error for a call that served no period with data: `rate_limited` (RateLimited, `retryAfter`
 * in seconds) when any period was rate limited, otherwise `deadline_exceeded` (Timeout). `lead`
 * replaces the opening sentence when some periods were served but held no data.
 */
export function periodFailureError(
  failures: readonly TradePeriodFailure[],
  { lead = 'No requested period was served.', ...options }: { cause?: unknown; lead?: string } = {},
): McpError {
  const message = `${lead} ${describePeriodFailures(failures)}`;
  const { limited } = groupFailures(failures);
  if (limited.length > 0) {
    const retryAfter = failureWaitSeconds(limited);
    return new McpError(
      JsonRpcErrorCode.RateLimited,
      message,
      {
        reason: 'rate_limited',
        retryable: true,
        retryAfter,
        recovery: { hint: `Wait ${retryAfter} seconds, then retry with fewer periods.` },
      },
      options,
    );
  }
  return new McpError(
    JsonRpcErrorCode.Timeout,
    message,
    {
      reason: 'deadline_exceeded',
      retryable: true,
      recovery: {
        hint: 'Retry with fewer periods per call, or retry later if UN Comtrade is responding slowly.',
      },
    },
    options,
  );
}

/** Normalized records and coverage information from one or more upstream responses. */
export interface TradeQueryResult {
  /** Requested periods that did not complete, in request order; absent when every period completed. */
  failedPeriods?: TradePeriodFailure[];
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
    minStartGapMs: PREVIEW_START_GAP_MS,
    maxConcurrent: 1,
    maxQueueDepth: 48,
    cooldown: { baseMs: 1500, maxMs: 30_000 },
  });

  // biome-ignore lint/complexity/noUselessConstructor: params reserved for future use
  constructor(_config: AppConfig, _storage: StorageService) {}

  /**
   * Periods one call serves: authenticated access batches every period into one request (12);
   * keyless preview spends `requestsPerPeriod` paced requests per period from a budget of 8.
   */
  periodsPerCall(requestsPerPeriod: 1 | 2): number {
    return getServerConfig().subscriptionKey
      ? KEYED_PERIODS_PER_CALL
      : Math.floor(KEYLESS_REQUESTS_PER_CALL / requestsPerPeriod);
  }

  /**
   * Fetch trade data records through the authenticated endpoint or, keyless, one paced preview
   * request per period. Periods whose requests are rate limited or run out of time come back in
   * `failedPeriods` beside the completed ones; when none completes, throws `periodFailureError`.
   * Upstream validation (400), malformed responses, and cancellation fail the call.
   * `deadlineAt` (epoch ms) bounds every attempt, backoff, and queued start; a caller making
   * several calls for one tool call passes the same value to each.
   */
  async fetchTradeData(
    params: TradeDataParams,
    signal?: AbortSignal,
    deadlineAt = Date.now() + TRADE_DATA_DEADLINE_MS,
  ): Promise<TradeQueryResult> {
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
    // A timer rather than AbortSignal.timeout: it is cleared when the call settles.
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new DOMException('The trade-data time budget ran out.', 'TimeoutError')),
      Math.max(0, deadlineAt - Date.now()),
    );
    const requestSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    const periods = hasKey ? [params.period] : [...new Set(params.period.split(','))];
    const slices: TradeQueryResult[] = [];
    const failedPeriods: TradePeriodFailure[] = [];
    let lastError: unknown;
    try {
      for (const period of periods) {
        signal?.throwIfAborted();
        let failure: Omit<TradePeriodFailure, 'period'> = { reason: 'deadline_exceeded' };
        if (Date.now() < deadlineAt) {
          try {
            slices.push(await this.fetchSlice({ ...params, period }, requestSignal, deadlineAt));
            continue;
          } catch (error) {
            // Caller cancellation, and a sibling flow's stop, fail the call rather than a period.
            signal?.throwIfAborted();
            const reason = periodFailureReason(error);
            if (!reason) throw error;
            const retryAfter = retryAfterSeconds(error);
            failure = {
              reason,
              ...(retryAfter !== undefined && { retryAfterSeconds: retryAfter }),
            };
            lastError = error;
          }
        }
        // Authenticated calls send every period in one request, so its failure covers them all.
        for (const failed of new Set(period.split(',')))
          failedPeriods.push({ period: failed, ...failure });
      }
    } finally {
      clearTimeout(timer);
    }
    if (slices.length === 0) throw periodFailureError(failedPeriods, { cause: lastError });
    const truncated = slices.some((slice) => slice.truncated);
    const referenceNotice = [
      ...new Set(slices.flatMap((slice) => (slice.referenceNotice ? [slice.referenceNotice] : []))),
    ].join(' ');
    const truncationHint = slices.find((slice) => slice.truncationHint)?.truncationHint;
    return {
      records: slices.flatMap((slice) => slice.records),
      totalCount: slices.reduce((sum, slice) => sum + slice.totalCount, 0),
      truncated,
      ...(failedPeriods.length > 0 && { failedPeriods }),
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
    signal: AbortSignal,
    deadlineAt: number,
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

    // The last attempt UN Comtrade answered, when that answer was a 429.
    let lastRefusal: McpError | undefined;
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
            if (error instanceof McpError && error.data?.errorSource === 'FetchHttpError')
              lastRefusal = error.code === JsonRpcErrorCode.RateLimited ? error : undefined;
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
        // A start that cannot happen before the deadline is shed at once, sending nothing.
        return hasKey
          ? fetchRaw(attemptSignal)
          : this.previewPacer.run(fetchRaw, {
              signal: attemptSignal,
              maxWaitMs: Math.max(0, deadlineAt - Date.now()),
            });
      },
      {
        operation: 'ComtradeDataService.fetchTradeData',
        baseDelayMs: 1500,
        deadlineMs: Math.max(0, deadlineAt - Date.now()),
        signal,
      },
    ).catch((error: unknown) => {
      // A budget that runs out after UN Comtrade's last answer was a 429 is still a rate limit.
      throw lastRefusal && periodFailureReason(error) === 'deadline_exceeded' ? lastRefusal : error;
    });

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
        signal.throwIfAborted();
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
        signal.throwIfAborted();
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
      // UN Comtrade sends 0, not null, for what it does not report: quantities with unit code
      // -1, and weights or CIF/FOB valuations beside a positive value. A zero in a real unit
      // stays a measurement.
      const reportsValue = (row.primaryValue ?? 0) > 0;
      const qty = row.qty === 0 && row.qtyUnitCode === -1 ? undefined : row.qty;
      const altQty = row.altQty === 0 && row.altQtyUnitCode === -1 ? undefined : row.altQty;
      const netWgt = row.netWgt === 0 && reportsValue ? undefined : row.netWgt;
      const grossWgt = row.grossWgt === 0 && reportsValue ? undefined : row.grossWgt;
      const fobvalue = row.fobvalue === 0 && reportsValue ? undefined : row.fobvalue;
      const cifvalue = row.cifvalue === 0 && reportsValue ? undefined : row.cifvalue;

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
        ...(fobvalue != null && { fobvalue }),
        ...(cifvalue != null && { cifvalue }),
        ...(qty != null && { qty }),
        ...(row.classificationCode != null && { classificationCode: row.classificationCode }),
        ...(row.isOriginalClassification != null && {
          isOriginalClassification: row.isOriginalClassification,
        }),
        ...(row.qtyUnitCode != null && { qtyUnitCode: row.qtyUnitCode }),
        ...(qtyUnitAbbr && { qtyUnitAbbr }),
        ...(altQty != null && { altQty }),
        ...(row.altQtyUnitCode != null && { altQtyUnitCode: row.altQtyUnitCode }),
        ...(altQtyUnitAbbr && { altQtyUnitAbbr }),
        ...(row.isQtyEstimated != null && { isQtyEstimated: row.isQtyEstimated }),
        ...(row.isNetWgtEstimated != null && { isNetWgtEstimated: row.isNetWgtEstimated }),
        ...(netWgt != null && { netWgt }),
        ...(grossWgt != null && { grossWgt }),
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
