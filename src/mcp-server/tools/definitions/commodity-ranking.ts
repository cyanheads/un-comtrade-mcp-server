/**
 * @fileoverview Complete commodity retrieval with raw-cap-driven subdivision.
 * @module mcp-server/tools/definitions/commodity-ranking
 */
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { ComtradeDataService } from '@/services/comtrade-data/comtrade-data-service.js';
import type { TradeDataParams, TradeFlowRecord } from '@/services/comtrade-data/types.js';
import type { ComtradeReferenceService } from '@/services/comtrade-reference/comtrade-reference-service.js';

/** Retrieve the edition's full code universe; retain available rows when upstream work fails. */
export async function retrieveCommodityRanking(
  svc: ComtradeDataService,
  reference: ComtradeReferenceService,
  params: TradeDataParams,
  level: 2 | 4,
  callerSignal: AbortSignal,
) {
  const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(55_000)]);
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
    const total = await svc.fetchTradeData({ ...params, cmdCode: 'TOTAL' }, signal);
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
      try {
        signal.throwIfAborted();
        const result = await svc.fetchTradeData({ ...params, cmdCode: chunk.join(',') }, signal);
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
    for (let offset = 0; offset < codes.length; offset += 400) {
      await fetchCodes(codes.slice(offset, offset + 400));
    }
    coverageComplete = missingCodes.size === 0;
    coverageNotice = coverageComplete
      ? 'All codes in the matching HS edition were queried; absent codes have no returned data.'
      : 'Some code queries failed or remained capped; available categories have no ranks or shares.';
  } else {
    signal.throwIfAborted();
    const fallback = await svc.fetchTradeData({ ...params, cmdCode: `AG${level}` }, signal);
    preserve(fallback.records);
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
