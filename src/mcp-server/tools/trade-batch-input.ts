/** src/mcp-server/tools/trade-batch-input.ts — raw read array limits and usage telemetry. */

import type { Context, z } from '@cyanheads/mcp-ts-core';
import { ATTR_MCP_TOOL_NAME, createCounter } from '@cyanheads/mcp-ts-core/utils';
import { clampTradeLimits } from '@/config/server-config.js';

const LEGACY_MAX_ITEMS = { period: 120, cmd_code: 200, reporter_code: 200 } as const;
const MAX_ITEMS = 1_000;
type BatchField = keyof typeof LEGACY_MAX_ITEMS;

/** Advertise and enforce the configured ceiling on raw array length, before deduplication. */
export function tradeBatchArray<Schema extends z.ZodArray>(
  schema: Schema,
  field: BatchField,
  description: string,
): Schema {
  const maximum = () => (clampTradeLimits() ? MAX_ITEMS : LEGACY_MAX_ITEMS[field]);
  return schema
    .check(({ value, issues }) => {
      const max = maximum();
      if (value.length > max) {
        issues.push({
          code: 'too_big',
          origin: 'array',
          maximum: max,
          inclusive: true,
          input: value,
        });
      }
    })
    .meta({
      description,
      get maxItems() {
        return maximum();
      },
    });
}

let expandedCounter: ReturnType<typeof createCounter> | undefined;

/** Record a call that crosses any legacy ceiling, once and before retrieving upstream data. */
export function observeExpandedTradeBatch(
  input: {
    period: string[];
    cmd_code?: string[] | undefined;
    reporter_code?: number | number[] | undefined;
  },
  ctx: Context,
  tool: string,
): void {
  ctx.signal.throwIfAborted();
  if (!clampTradeLimits()) return;
  const counts = {
    period: input.period.length,
    cmd_code: input.cmd_code?.length ?? 0,
    reporter_code: Array.isArray(input.reporter_code) ? input.reporter_code.length : 0,
  };
  if (
    counts.period <= LEGACY_MAX_ITEMS.period &&
    counts.cmd_code <= LEGACY_MAX_ITEMS.cmd_code &&
    counts.reporter_code <= LEGACY_MAX_ITEMS.reporter_code
  )
    return;
  ctx.log.info('Trade batch exceeds a legacy input ceiling', counts);
  expandedCounter ??= createCounter(
    'comtrade.batch.expanded',
    'Trade calls with a raw list above a legacy input ceiling',
    '{calls}',
  );
  expandedCounter.add(1, { [ATTR_MCP_TOOL_NAME]: tool });
}
