/**
 * @fileoverview JSON-schema-compatible normalization for Comtrade query inputs.
 * @module mcp-server/tools/comtrade-input
 */
import { z } from '@cyanheads/mcp-ts-core';
import {
  BEC_LEVELS,
  COMMODITY_CLASSIFICATIONS,
  RANKED_GOODS_CLASSIFICATIONS,
} from '@/services/comtrade-reference/types.js';

/** Numeric M49 grammar, including unknown codes without catalog membership checks. */
export const m49Schema = z.number().int().min(0).max(999);

/** A calendar-valid annual year or monthly year/month. */
export const periodSchema = z
  .string()
  .trim()
  .regex(/^[0-9]{4}(?:0[1-9]|1[0-2])?$/, 'Use YYYY or YYYYMM with a month from 01 to 12.');
/** Annual services period. */
export const annualPeriodSchema = z
  .string()
  .trim()
  .regex(/^[0-9]{4}$/, 'Use an annual YYYY period.');
/**
 * Supported goods classifications; edition capability is checked by the data service. A string
 * pipe advertises a plain string in tools/list, so clients that validate against the advertised
 * schema can send any casing the pipe normalizes.
 */
export const goodsClassificationSchema = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(
    z.enum(RANKED_GOODS_CLASSIFICATIONS, {
      error: 'Use an HS classification (HS or H0–H6) or SITC (SS or S1–S4).',
    }),
  );

/** Goods trade, balance, and catalog search accept the two converted BEC revisions. */
export const tradeClassificationSchema = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(z.enum(COMMODITY_CLASSIFICATIONS));
/**
 * Services classifications the trade endpoint serves: EB as reported (the default, also for a
 * blank value), or UN Comtrade's converted EB10/EB02 series. EB10S is refused: its endpoint
 * returns nothing, and its rows are served only under EB. A preprocess rather than a string pipe,
 * so the enum and default survive into the input-side JSON Schema that tools/list advertises.
 */
export const servicesClassificationSchema = z.preprocess(
  (value) => {
    if (typeof value !== 'string') return value;
    const normalized = value.trim().toUpperCase();
    return normalized === '' ? undefined : normalized;
  },
  z
    .enum(['EB', 'EB10', 'EB02'], {
      error: (issue) =>
        issue.input === 'EB10S'
          ? 'EB10S has no converted series; its rows are served only under EB. Use classification EB.'
          : "Use EB as reported, or EB10 or EB02 for UN Comtrade's converted series.",
    })
    .default('EB'),
);
/** Flow grammar for goods. */
export const goodsFlowSchema = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(z.enum(['M', 'X', 'RX', 'RM']));
/** Import/export flow grammar for services and rankings. */
export const flowSchema = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(z.enum(['M', 'X']));
/** Annual or monthly query frequency. */
export const frequencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(z.enum(['A', 'M']));
/** Well-formed commodity/category selector, including blank omitted entries. */
export const codeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    /^(?:[A-Z0-9]+(?:\.[A-Z0-9]+)*)?$/,
    'Use a numeric, SITC, EBOPS, TOTAL, or AG selector without separators.',
  );
/** Periods and an optional explicit frequency, as the trade and availability tools accept them. */
interface FrequencyInput {
  freq?: 'A' | 'M' | undefined;
  period?: string | string[] | undefined;
}

/** The frequency a validated period implies: YYYY is annual, YYYYMM monthly. */
export function periodFrequency(period: string): 'A' | 'M' {
  return period.length === 6 ? 'M' : 'A';
}

function periodsOf(input: FrequencyInput): string[] {
  return typeof input.period === 'string' ? [input.period] : (input.period ?? []);
}

/** The explicit frequency, else the one the first period implies; annual when no period is given. */
export function resolveFrequency(input: FrequencyInput): 'A' | 'M' {
  const [first] = periodsOf(input);
  return input.freq ?? (first === undefined ? 'A' : periodFrequency(first));
}

/** Require every period to imply the resolved frequency: one length per call, matching any explicit freq. */
export function periodsMatchFrequency(input: FrequencyInput): boolean {
  const frequency = resolveFrequency(input);
  return periodsOf(input).every((period) => periodFrequency(period) === frequency);
}

/** Rejection message for a goods code whose shape doesn't fit the selected classification. */
export const GOODS_CODE_SHAPE_MESSAGE =
  'Use 2, 4 or 6 digits or legacy 9999AA for HS, up to 5 characters with optional trailing X for SITC, 1–3 digits for B4, or 1–4 or 6 digits for B5. TOTAL and HS/SITC aggregation selectors are supported.';

/** Rejection for rankings that accept only a single commodity at a time. */
export const SINGLE_GOODS_CODE_SHAPE_MESSAGE =
  'Use TOTAL or a single HS or SITC code. HS codes have 2, 4 or 6 digits or are legacy 9999AA; SITC codes (up to 5 characters, optional trailing X) need classification S1–S4 or SS. Use comtrade_get_top_commodities to rank products.';

/** Validate a normalized ranking selector without allowing level-wide AG selectors. */
export function singleGoodsCodeMatchesClassification(input: {
  classification?: string | undefined;
  cmd_code?: string | undefined;
}): boolean {
  return !input.cmd_code?.startsWith('AG') && goodsCodesMatchClassification(input);
}

/** Validate goods code shape by classification while leaving reference membership open. */
export function goodsCodesMatchClassification(input: {
  classification?: string | undefined;
  cmd_code?: string | string[] | undefined;
}): boolean {
  const codes = typeof input.cmd_code === 'string' ? [input.cmd_code] : (input.cmd_code ?? []);
  const sitc = input.classification?.startsWith('S') === true;
  const becLevels: readonly number[] | undefined =
    input.classification === 'B4' || input.classification === 'B5'
      ? BEC_LEVELS[input.classification]
      : undefined;
  return codes.every((code) => {
    if (code === '' || code === 'TOTAL') return true;
    if (becLevels) return becLevels.includes(code.length) && /^[0-9]+$/.test(code);
    // SITC memorandum items append X; the H0 catalog retains one legacy non-WCO selector.
    return sitc
      ? /^AG[1-5]$/.test(code) || (code.length <= 5 && /^[0-9]+X*$/.test(code))
      : code === '9999AA' || /^(?:[0-9]{2}(?:[0-9]{2}){0,2}|AG[246])$/.test(code);
  });
}
