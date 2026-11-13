/**
 * @fileoverview Coverage of explicitly served goods selectors in completed trade data.
 * @module mcp-server/tools/commodity-coverage
 */

import { z } from '@cyanheads/mcp-ts-core';
import { goodsClassificationSchema } from '@/mcp-server/tools/comtrade-input.js';
import type { TradeFlowRecord } from '@/services/comtrade-data/types.js';

export const cmdCodesWithoutRecordsSchema = z
  .array(z.string())
  .optional()
  .describe(
    'Served commodity selectors without records in any completed period. Omitted when the result is truncated.',
  );

/** The native level requested by an already validated AG selector. */
export function selectorLevel(code: string): number | undefined {
  return code.startsWith('AG') ? Number(code.slice(2)) : undefined;
}

/** Missing selectors and applicable edition guidance from the same complete slice. */
export function commodityCoverage(
  codes: readonly string[] | undefined,
  recordGroups: readonly (readonly TradeFlowRecord[])[],
  failedPeriods: ReadonlySet<string>,
): { missing: string[]; editionNotice?: string } {
  if (!codes?.length) return { missing: [] };

  const answered = new Set<string>();
  const levels = new Set<number>();
  const editions = new Set<string | undefined>();
  for (const records of recordGroups) {
    for (const row of records) {
      if (failedPeriods.has(row.period)) continue;
      answered.add(row.cmdCode);
      editions.add(row.classificationCode);
      if (row.cmdCode !== 'TOTAL') levels.add(row.aggrLevel ?? row.cmdCode.length);
    }
  }
  const missing = codes.filter((code) => {
    if (answered.has(code)) return false;
    const level = selectorLevel(code);
    return level === undefined || !levels.has(level);
  });
  const [edition] = editions;
  if (
    missing.length > 0 &&
    editions.size === 1 &&
    edition &&
    edition !== 'HS' &&
    edition !== 'SS' &&
    goodsClassificationSchema.safeParse(edition).data === edition
  ) {
    return {
      missing,
      editionNotice: `Returned rows use ${edition}. Check the missing selectors with comtrade_search_commodities using classification ${edition}.`,
    };
  }
  return { missing };
}

/** Render the same missing selectors as the structured coverage field. */
export function renderCmdCodesWithoutRecords(codes: string[] | undefined): string {
  return codes ? `**Commodity codes without records:** ${codes.join(', ')}.` : '';
}
