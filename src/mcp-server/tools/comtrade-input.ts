/**
 * @fileoverview JSON-schema-compatible normalization for Comtrade query inputs.
 * @module mcp-server/tools/comtrade-input
 */
import { z } from '@cyanheads/mcp-ts-core';

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
/** Supported goods classifications; edition capability is checked by the data service. */
export const goodsClassificationSchema = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(z.enum(['HS', 'H0', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'S1', 'S2', 'S3', 'S4', 'SS']));
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
/** Require periods to agree with the selected endpoint frequency. */
export function periodsMatchFrequency(input: {
  period?: string | string[] | undefined;
  freq: 'A' | 'M';
}): boolean {
  const periods = typeof input.period === 'string' ? [input.period] : (input.period ?? []);
  return periods.every((period) => period.length === (input.freq === 'A' ? 4 : 6));
}

/** Validate goods code shape by classification while leaving reference membership open. */
export function goodsCodesMatchClassification(input: {
  classification?: string | undefined;
  cmd_code?: string | string[] | undefined;
}): boolean {
  const codes = typeof input.cmd_code === 'string' ? [input.cmd_code] : (input.cmd_code ?? []);
  const sitc = input.classification?.startsWith('S') === true;
  return codes.every((code) => {
    if (code === '' || code === 'TOTAL') return true;
    // SITC memorandum items append X; the H0 catalog retains one legacy non-WCO selector.
    return sitc
      ? /^AG[1-5]$/.test(code) || (code.length <= 5 && /^[0-9]+X*$/.test(code))
      : code === '9999AA' || /^(?:[0-9]{2}(?:[0-9]{2}){0,2}|AG[246])$/.test(code);
  });
}
