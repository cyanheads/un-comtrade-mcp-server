/** src/mcp-server/tools/trade-page.ts — pagination and rendering for retrieved trade rows. */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { ATTR_MCP_TOOL_NAME, createCounter } from '@cyanheads/mcp-ts-core/utils';
import { clampTradeLimits } from '@/config/server-config.js';

const PAGE_CAP = 1_000;
const DEFAULT_LIMIT = 25;
const maximum = () => (clampTradeLimits() ? undefined : PAGE_CAP);

/** Inputs shared by the goods and services breakdown tools. */
export const tradePageInput = {
  limit: z
    .number()
    .int()
    .min(1)
    .check(({ value, issues }) => {
      const max = maximum();
      if (max !== undefined && value > max) {
        issues.push({
          code: 'too_big',
          origin: 'number',
          maximum: max,
          inclusive: true,
          input: value,
        });
      }
    })
    .default(DEFAULT_LIMIT)
    .meta({
      get maximum() {
        return maximum();
      },
      get description() {
        return clampTradeLimits()
          ? `Records per page (default ${DEFAULT_LIMIT}). Larger requests are limited to ${PAGE_CAP} with a notice.`
          : `Records per page (default ${DEFAULT_LIMIT}, maximum ${PAGE_CAP}).`;
      },
    }),
  offset: z.number().int().min(0).default(0).describe('Number of retrieved records to skip.'),
};

/** The next page depends on normalized records, which may differ from the raw upstream count. */
export const tradePageOutput = {
  offset: z.number().describe('Number of retrieved records skipped for this page.'),
  shown: z.number().describe('Number of records on this page.'),
  nextOffset: z.number().optional().describe('Offset for the next page when more records remain.'),
};

/** Disclosure of the requested and applied limit, present when a limit was clamped. */
export const limitClampSchema = z
  .object({
    requested: z.number().describe('Requested records per page.'),
    applied: z.number().describe('Applied records per page.'),
  })
  .optional()
  .describe('Requested and applied page sizes when the limit was clamped.');

/** Render the same clamp values carried in structuredContent. */
export function renderLimitClamp(clamp: z.output<typeof limitClampSchema>): string {
  return clamp ? `Requested limit ${clamp.requested} was reduced to ${clamp.applied}.` : '';
}

let clampCounter: ReturnType<typeof createCounter> | undefined;

/** Apply and record one clamp before any upstream requests start. */
export function applyTradeLimit(
  requested: number,
  ctx: Context,
  tool: 'comtrade_get_trade_flows' | 'comtrade_get_services_trade',
): number {
  ctx.signal.throwIfAborted();
  if (requested <= PAGE_CAP) return requested;
  ctx.log.info('Trade page limit clamped', { requested, applied: PAGE_CAP });
  clampCounter ??= createCounter(
    'comtrade.limit.clamped',
    'Trade breakdown calls with a clamped page limit',
    '{calls}',
  );
  clampCounter.add(1, { [ATTR_MCP_TOOL_NAME]: tool });
  ctx.enrich({ limitClamp: { requested, applied: PAGE_CAP } });
  return PAGE_CAP;
}

type TradeRow = { period: string; reporterCode: number; partnerCode: number; cmdCode: string };

/** Sort and slice retrieved rows, including stable tie-breaks for distinct visible records. */
export function tradePage<T extends TradeRow>(
  rows: readonly T[],
  offset: number,
  limit: number,
  notices: string[],
) {
  if (offset >= rows.length) {
    if (rows.length > 0) {
      notices.push(
        `This offset is past the end of the retrieved records. The largest offset that returns a row is ${rows.length - 1}.`,
      );
    }
    return { records: [], offset, shown: 0 };
  }

  // Only rows equal on all four primary keys need serialization.
  const tieKeys = new WeakMap<T, string>();
  const tieKey = (row: T) => {
    let key = tieKeys.get(row);
    if (key === undefined) {
      key = JSON.stringify(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)));
      tieKeys.set(row, key);
    }
    return key;
  };
  const ordered = rows.toSorted((a, b) => {
    const order =
      a.period.localeCompare(b.period) ||
      a.reporterCode - b.reporterCode ||
      a.partnerCode - b.partnerCode ||
      a.cmdCode.localeCompare(b.cmdCode);
    if (order !== 0) return order;
    const left = tieKey(a);
    const right = tieKey(b);
    return left < right ? -1 : Number(left > right);
  });
  const records = ordered.slice(offset, offset + limit);
  const nextOffset = offset + records.length;
  return {
    records,
    offset,
    shown: records.length,
    ...(nextOffset < rows.length && { nextOffset }),
  };
}

/** Render one record per named-field table row. Populated cells are JSON literals. */
export function formatTradePage(
  title: string,
  result: {
    records: readonly Record<string, string | number | boolean | undefined>[];
    totalCount: number;
    shown: number;
    offset: number;
    nextOffset?: number | undefined;
    truncated: boolean;
    truncationHint?: string | undefined;
  },
  fields: readonly string[],
) {
  const lines = [
    `## ${title}`,
    `**Records:** ${result.shown} shown | **Offset:** ${result.offset} | **Upstream count:** ${result.totalCount}`,
    `**Upstream truncated:** ${result.truncated}`,
  ];
  if (result.nextOffset !== undefined) {
    lines.push(`Continue with offset=${result.nextOffset}, keeping the same filters and limit.`);
  }
  if (result.truncationHint !== undefined) {
    lines.push(`> **Truncated:** ${result.truncationHint}`);
  }
  if (result.records.length !== 0) {
    const present = new Set(
      result.records.flatMap((row) => Object.keys(row).filter((field) => row[field] !== undefined)),
    );
    const columns = fields.filter((field) => present.has(field));
    lines.push('', `| ${columns.join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`);
    for (const row of result.records) {
      const cells = columns.map((field) => {
        const value = row[field];
        if (value === undefined) return '';
        const literal = JSON.stringify(value)
          .replaceAll('|', '\\u007c')
          .replaceAll('`', '\\u0060')
          .replaceAll('\u2028', '\\u2028')
          .replaceAll('\u2029', '\\u2029');
        return `\`${literal}\``;
      });
      lines.push(`| ${cells.join(' | ')} |`);
    }
  }
  return [{ type: 'text' as const, text: lines.join('\n') }];
}
