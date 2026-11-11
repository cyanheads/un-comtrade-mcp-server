/**
 * @fileoverview Empty-result notices naming the code to query instead, shared by the trade tools:
 * for a partner-only reporter code, and for a partner code with a reporter-valid counterpart.
 * @module mcp-server/tools/reporter-notice
 */
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import type { ComtradeReferenceService } from '@/services/comtrade-reference/comtrade-reference-service.js';
import type { ReporterStatus } from '@/services/comtrade-reference/types.js';

/**
 * The sentence an empty result for a partner-only reporter code ends with: the code UN Comtrade
 * publishes its trade under, the reporter-valid code sharing its ISO-3 identity, or a pointer to
 * reporter lookup when neither exists. Undefined for reporter-valid and unknown codes, which keep
 * the availability pointer.
 */
export function partnerOnlyReporterNotice(
  code: number,
  status: ReporterStatus,
): string | undefined {
  if (status.referenceStatus !== 'partner_only') return;
  const entity = `Reporter ${code} (${escapeMarkdownInline(status.name)}) is a partner-only code in UN Comtrade reference data`;
  if (status.suggestedReporterCode === undefined)
    return `${entity} and has no reporter-valid counterpart. Find a reporter with comtrade_lookup_countries using role "reporter".`;
  const suggested = status.suggestedReporterCode;
  return status.suggestionBasis === 'published_under'
    ? `${entity}; UN Comtrade publishes its trade under reporter ${suggested} (${escapeMarkdownInline(status.suggestedReporterName)}). Retry with reporter_code ${suggested}.`
    : `${entity}; reporter ${suggested} shares its ISO-3 identity. Retry with reporter_code ${suggested}.`;
}

/**
 * The sentence an empty result for a partner code ends with when `status`, the partner code's
 * reporter status, names a reporter-valid counterpart: the code UN Comtrade publishes the
 * partner's trade under (158 → 490) or the code sharing its ISO-3 identity (840 → 842).
 * Undefined for every other code, World (0) among them.
 */
export function partnerCounterpartNotice(code: number, status: ReporterStatus): string | undefined {
  if (status.referenceStatus !== 'partner_only' || status.suggestedReporterCode === undefined)
    return;
  const partner = `${code} (${escapeMarkdownInline(status.name)})`;
  const suggested = status.suggestedReporterCode;
  return status.suggestionBasis === 'published_under'
    ? `UN Comtrade publishes the trade of partner ${partner} under ${suggested} (${escapeMarkdownInline(status.suggestedReporterName)}). Retry with partner_code ${suggested}.`
    : `Partner ${partner} shares its ISO-3 identity with ${suggested}. Retry with partner_code ${suggested}.`;
}

/**
 * The sentences an empty result ends with, reporter's first: `partnerOnlyReporterNotice` for a
 * single `reporterCode` and `partnerCounterpartNotice` for `partnerCode`. Empty when the reporter
 * code is absent or not partner-only and the partner code is absent or has no reporter-valid
 * counterpart.
 */
export function counterpartNotices(
  reference: Pick<ComtradeReferenceService, 'getReporterStatus'>,
  reporterCode: number | undefined,
  partnerCode: number | undefined,
): string[] {
  return [
    reporterCode === undefined
      ? undefined
      : partnerOnlyReporterNotice(reporterCode, reference.getReporterStatus(reporterCode)),
    partnerCode === undefined
      ? undefined
      : partnerCounterpartNotice(partnerCode, reference.getReporterStatus(partnerCode)),
  ].filter((sentence) => sentence !== undefined);
}
