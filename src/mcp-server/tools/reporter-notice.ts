/**
 * @fileoverview Empty-result notice for partner-only reporter codes, shared by the trade tools.
 * @module mcp-server/tools/reporter-notice
 */
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import type { ReporterStatus } from '@/services/comtrade-reference/types.js';

/**
 * The sentence an empty result for a partner-only reporter code ends with: the reporter-valid
 * code sharing its ISO-3 identity, or a pointer to reporter lookup when none exists. Undefined for
 * reporter-valid and unknown codes, which keep the availability pointer.
 */
export function partnerOnlyReporterNotice(
  code: number,
  status: ReporterStatus,
): string | undefined {
  if (status.referenceStatus !== 'partner_only') return;
  const entity = `Reporter ${code} (${escapeMarkdownInline(status.name)}) is a partner-only code in UN Comtrade reference data`;
  return status.suggestedReporterCode === undefined
    ? `${entity} and has no reporter-valid counterpart. Find a reporter with comtrade_lookup_countries using role "reporter".`
    : `${entity}; reporter ${status.suggestedReporterCode} shares its ISO-3 identity. Retry with reporter_code ${status.suggestedReporterCode}.`;
}
