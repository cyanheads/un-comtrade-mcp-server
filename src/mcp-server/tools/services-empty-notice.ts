/**
 * @fileoverview Recovery guidance for empty annual services queries.
 * @module mcp-server/tools/services-empty-notice
 */

import type { z } from '@cyanheads/mcp-ts-core';
import type { servicesClassificationSchema } from '@/mcp-server/tools/comtrade-input.js';
import { counterpartNotices } from '@/mcp-server/tools/reporter-notice.js';
import { getComtradeReferenceService } from '@/services/comtrade-reference/comtrade-reference-service.js';
import type { EbScheme } from '@/services/comtrade-reference/types.js';

/** A services classification the trade endpoint serves. */
type ServicesClassification = z.output<typeof servicesClassificationSchema>;

const AVAILABILITY_ROUTE =
  'Use comtrade_get_data_availability with type_code="S" and classification="EB" to check coverage and the scheme each period was reported in.';

/**
 * The scheme catalogs listing a service code: `undefined` when they did not load, or did not
 * answer before `deadlineAt` (the call's budget, shared with the data fetch). The first lookup
 * loads three catalogs; later ones read the cache. Caller cancellation propagates.
 */
async function serviceCodeSchemes(
  code: string,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<readonly EbScheme[] | undefined> {
  // A timer rather than AbortSignal.timeout: it is cleared when the lookup settles.
  const budget = new AbortController();
  const timer = setTimeout(
    () => budget.abort(new DOMException('The call budget ran out.', 'TimeoutError')),
    Math.max(0, deadlineAt - Date.now()),
  );
  try {
    // The whole listing, matched by equality: the code never reaches the keyword scan.
    const listing = await getComtradeReferenceService().getServiceCategories(
      undefined,
      AbortSignal.any([signal, budget.signal]),
    );
    if (listing.status === 'untagged') return;
    // codeSchema uppercases; EB.json keeps a few lowercase ids (3a.3.1).
    return listing.categories.find((category) => category.id.toUpperCase() === code)?.schemes ?? [];
  } catch (error) {
    if (signal.aborted || !budget.signal.aborted) throw error;
    return;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Why a services query returned no rows. A partner-only reporter code, or a partner code with a
 * reporter-valid counterpart, ends it with the code to query instead. Otherwise it explains a
 * converted series, names the requested code's EB scheme, and routes to availability under EB,
 * where each period shows the scheme it was reported in.
 */
export async function servicesEmptyNotice(
  input: {
    reporter_code: number;
    flow_code: string;
    partner_code?: number | undefined;
    service_code?: string | undefined;
  },
  classification: ServicesClassification,
  servedPeriods: readonly string[],
  signal: AbortSignal,
  deadlineAt: number,
): Promise<string> {
  const sentences = [
    `No services trade records found for reporter ${input.reporter_code}, flow=${input.flow_code}, periods=[${servedPeriods.join(', ')}].`,
  ];
  const taiwanPartner = input.partner_code === 490;
  if (taiwanPartner) sentences.push('Use partner_code 158 for Taiwan services.');
  const counterparts = counterpartNotices(
    getComtradeReferenceService(),
    input.reporter_code,
    input.partner_code,
    'S',
  );
  sentences.push(...counterparts);
  if (counterparts.length > 0 && !taiwanPartner) return sentences.join(' ');
  if (classification !== 'EB')
    sentences.push(
      `${classification} serves UN Comtrade's conversions from other schemes; rows reported in ${classification} itself are served under classification "EB".`,
    );
  const code = input.service_code;
  const schemes = code ? await serviceCodeSchemes(code, signal, deadlineAt) : [];
  if (schemes === undefined) {
    sentences.push(
      `The EB scheme catalogs did not load, so service code ${code} is not matched to a scheme.`,
    );
  } else if (schemes.length > 0) {
    const listed = `Service code ${code} belongs to ${schemes.join(' and ')}`;
    sentences.push(
      classification === 'EB'
        ? `${listed}; EB serves each reporter-period in the scheme it was reported in, so a period reported in another scheme has no rows for this code.`
        : `${listed}.`,
    );
  }
  sentences.push(AVAILABILITY_ROUTE);
  // EB10S has no converted series, so only EB10 and EB02 are levers.
  const converted = schemes?.filter((scheme) => scheme !== 'EB10S') ?? [];
  if (classification === 'EB' && converted.length > 0) {
    sentences.push(
      `Set classification to ${converted.map((scheme) => `"${scheme}"`).join(' or ')} for UN Comtrade's converted series.`,
    );
  }
  return sentences.join(' ');
}
