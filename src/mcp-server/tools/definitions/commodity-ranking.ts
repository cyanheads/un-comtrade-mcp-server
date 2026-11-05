/**
 * @fileoverview Complete commodity retrieval with raw-cap-driven subdivision under one call
 * deadline, plus the single-period failure both ranking tools share.
 * @module mcp-server/tools/definitions/commodity-ranking
 */
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  type ComtradeDataService,
  TRADE_DATA_DEADLINE_MS,
} from '@/services/comtrade-data/comtrade-data-service.js';
import type { TradeDataParams, TradeFlowRecord } from '@/services/comtrade-data/types.js';
import type { ComtradeReferenceService } from '@/services/comtrade-reference/comtrade-reference-service.js';

/** Explicit codes per request; a capped request is split in halves. */
const CODES_PER_REQUEST = 400;

/** Retrieved categories and how completely they cover the matching HS edition. */
interface CommodityRanking {
  /** HS edition identified by matching TOTAL. */
  classificationCode?: string | undefined;
  coverageComplete: boolean;
  coverageNotice: string;
  /** Matching TOTAL value: the share denominator. */
  denominatorValueUsd?: number | undefined;
  missingCodes: string[];
  records: TradeFlowRecord[];
}

/**
 * Retrieve the edition's full code universe; retain available rows when upstream work fails.
 * TOTAL, the edition catalog, every code request, and the aggregate fallback share one
 * `TRADE_DATA_DEADLINE_MS` deadline, so the call settles under MCP clients' 60 s default; no code
 * request starts once it has passed, and codes left unrequested are reported missing.
 */
export async function retrieveCommodityRanking(
  svc: ComtradeDataService,
  reference: ComtradeReferenceService,
  params: TradeDataParams,
  level: 2 | 4,
  callerSignal: AbortSignal,
): Promise<CommodityRanking> {
  const deadlineAt = Date.now() + TRADE_DATA_DEADLINE_MS;
  // A timer rather than AbortSignal.timeout: it is cleared when the ranking settles.
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new DOMException('The ranking time budget ran out.', 'TimeoutError')),
    TRADE_DATA_DEADLINE_MS,
  );
  const signal = AbortSignal.any([callerSignal, deadline.signal]);
  const records = new Map<string, TradeFlowRecord>();
  const missingCodes = new Set<string>();
  let coverageComplete = false;
  let denominatorValueUsd: number | undefined;
  let classificationCode: string | undefined;
  let coverageNotice = '';
  const preserve = (rows: TradeFlowRecord[]) => {
    for (const row of rows) {
      if (row.cmdCode !== 'TOTAL' && (row.aggrLevel ?? row.cmdCode.length) === level) {
        records.set(row.cmdCode, row);
      }
    }
  };
  const recover = (error: unknown) => {
    callerSignal.throwIfAborted();
    if (
      error instanceof McpError &&
      (error.code === JsonRpcErrorCode.ValidationError ||
        error.code === JsonRpcErrorCode.InvalidParams ||
        error.code === JsonRpcErrorCode.RequestCancelled)
    )
      throw error;
    if (error instanceof Error && error.name === 'AbortError' && !signal.aborted) throw error;
  };
  let codes: string[] | undefined;
  try {
    try {
      const total = await svc.fetchTradeData(
        { ...params, cmdCode: 'TOTAL' },
        callerSignal,
        deadlineAt,
      );
      // TOTAL sums every commodity: when UN Comtrade returns no TOTAL row at all, no commodity has one.
      if (total.records.length === 0 && total.totalCount === 0) {
        return {
          records: [],
          coverageComplete: true,
          coverageNotice:
            'Matching TOTAL returned no rows, so no commodity has data for this reporter, partner, flow and period.',
          missingCodes: [],
        };
      }
      const matching = total.records.filter(
        (row) =>
          row.cmdCode === 'TOTAL' &&
          row.reporterCode === params.reporterCode &&
          row.partnerCode === params.partnerCode &&
          row.flowCode === params.flowCode &&
          row.period === params.period,
      );
      const editions = new Set(matching.map((row) => row.classificationCode));
      const edition = matching[0]?.classificationCode;
      if (
        total.truncated ||
        editions.size !== 1 ||
        !edition ||
        !/^H[0-6]$/.test(edition) ||
        matching.length !== 1
      ) {
        coverageNotice =
          'Matching TOTAL did not identify one complete HS edition; available categories have no ranks or shares.';
      } else {
        classificationCode = edition;
        denominatorValueUsd = matching[0]?.primaryValue;
        const catalog = await reference.getCommodityCodes(edition, signal);
        codes = [...catalog.values()]
          .filter((entry) => entry.aggrLevel === level && entry.id !== 'TOTAL')
          .map((entry) => entry.id);
        if (codes.length === 0) {
          codes = undefined;
          coverageNotice =
            'The matching HS reference has no codes at the requested level; available categories have no ranks or shares.';
        }
      }
    } catch (error) {
      recover(error);
      coverageNotice =
        'TOTAL or the matching HS reference is unavailable; available categories have no ranks or shares.';
    }
    if (codes) {
      const fetchCodes = async (chunk: string[]): Promise<void> => {
        callerSignal.throwIfAborted();
        // Past the deadline nothing starts; a start the preview pacer cannot fit before it is shed unsent.
        if (Date.now() >= deadlineAt) {
          for (const code of chunk) missingCodes.add(code);
          return;
        }
        try {
          const result = await svc.fetchTradeData(
            { ...params, cmdCode: chunk.join(',') },
            callerSignal,
            deadlineAt,
          );
          preserve(result.records);
          if (result.truncated) {
            if (chunk.length === 1) {
              for (const code of chunk) missingCodes.add(code);
            } else {
              const middle = Math.ceil(chunk.length / 2);
              await fetchCodes(chunk.slice(0, middle));
              await fetchCodes(chunk.slice(middle));
            }
          }
        } catch (error) {
          recover(error);
          for (const code of chunk) missingCodes.add(code);
        }
      };
      for (let offset = 0; offset < codes.length; offset += CODES_PER_REQUEST) {
        await fetchCodes(codes.slice(offset, offset + CODES_PER_REQUEST));
      }
      coverageComplete = missingCodes.size === 0;
      coverageNotice = coverageComplete
        ? 'All codes in the matching HS edition were queried; absent codes have no returned data.'
        : 'Some code queries failed, remained capped, or did not fit the time budget; available categories have no ranks or shares.';
    } else {
      const fallback = await svc.fetchTradeData(
        { ...params, cmdCode: `AG${level}` },
        callerSignal,
        deadlineAt,
      );
      preserve(fallback.records);
    }
  } finally {
    clearTimeout(timer);
  }
  return {
    records: [...records.values()],
    coverageComplete,
    coverageNotice,
    missingCodes: [...missingCodes],
    classificationCode,
    denominatorValueUsd,
  };
}

/**
 * A ranking serves one period, so the data service's "retry with fewer periods" hint is no lever
 * for it. `rate_limited` and `deadline_exceeded` keep their code, message, and data; a stated wait
 * becomes the whole hint, otherwise the calling tool's declared recovery fills in.
 */
export function singlePeriodFailure(error: unknown): unknown {
  if (!(error instanceof McpError)) return error;
  const { reason, recovery: _recovery, ...data } = error.data ?? {};
  if (reason !== 'rate_limited' && reason !== 'deadline_exceeded') return error;
  return new McpError(
    error.code,
    error.message,
    {
      ...data,
      reason,
      ...(reason === 'rate_limited' &&
        typeof data.retryAfter === 'number' && {
          recovery: { hint: `Wait ${data.retryAfter} seconds, then retry.` },
        }),
    },
    { cause: error },
  );
}
