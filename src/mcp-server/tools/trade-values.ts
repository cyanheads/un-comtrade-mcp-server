/**
 * @fileoverview Decimal accumulation and locale-independent display of Comtrade USD amounts.
 * @module mcp-server/tools/trade-values
 */

/** Group digits while retaining every significant digit in a JSON number. */
export const tradeNumberFormat = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 21 });

/** Sum the decimal spellings of known source values, rounding to a JS number only once. */
export function sumUsd(values: Iterable<number | null | undefined>): number {
  let total = 0n;
  let scale = 0;
  for (const value of values) {
    if (value == null) continue;
    const literal = String(value);
    const e = literal.indexOf('e');
    const mantissa = e < 0 ? literal : literal.slice(0, e);
    const exponent = e < 0 ? 0 : Number(literal.slice(e + 1));
    const point = mantissa.indexOf('.');
    const places = (point < 0 ? 0 : mantissa.length - point - 1) - exponent;
    if (places > scale) {
      total *= 10n ** BigInt(places - scale);
      scale = places;
    }
    total += BigInt(mantissa.replace('.', '')) * 10n ** BigInt(scale - places);
  }
  return Number(`${total}e-${scale}`);
}
