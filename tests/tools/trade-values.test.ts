/** Tests for decimal trade amounts across scales, signs, and locales. */
import { describe, expect, it } from 'vitest';
import { sumUsd, tradeNumberFormat } from '@/mcp-server/tools/trade-values.js';

describe('decimal trade values', () => {
  it.each([
    [[0.1, 0.2], 0.3],
    [[-0.1, -0.2], -0.3],
    [[1.01, -1, -0.01], 0],
    [[1e21, 1e-8, -1e21], 1e-8],
    [[7e-7, 2e-7, undefined], 9e-7],
  ] as const)('sums %j', (values, expected) => {
    expect(sumUsd(values)).toBe(expected);
  });

  it('round-trips amounts with grouped digits and no locale-dependent rounding', () => {
    expect(tradeNumberFormat.format(-1234.56789)).toBe('-1,234.56789');
    for (const value of [1e-28, 9.876543210987654e23, 0, 1711347832972.372]) {
      expect(Number(tradeNumberFormat.format(value).replaceAll(',', ''))).toBe(value);
    }
  });
});
