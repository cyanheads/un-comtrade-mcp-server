/**
 * @fileoverview Wording of the counterpart sentences the trade tools end an empty result with.
 * @module tests/tools/reporter-notice.test
 */

import { describe, expect, it } from 'vitest';
import {
  counterpartNotices,
  mixedPartnerBreakdownNotice,
  partnerCounterpartNotice,
  partnerOnlyReporterNotice,
} from '@/mcp-server/tools/reporter-notice.js';
import type { ReporterStatus } from '@/services/comtrade-reference/types.js';

/** A partner-only status naming the reporter-valid entry with the same ISO-3 identity. */
function iso3(name: string, suggestedReporterCode: number): ReporterStatus {
  return {
    referenceStatus: 'partner_only',
    name,
    suggestedReporterCode,
    suggestionBasis: 'iso3',
  };
}

const TAIWAN: ReporterStatus = {
  referenceStatus: 'partner_only',
  name: 'Taiwan, Province of China',
  suggestedReporterCode: 490,
  suggestionBasis: 'published_under',
  suggestedReporterName: 'Other Asia, nes',
};

const NO_COUNTERPART =
  'is a partner-only code in UN Comtrade reference data and has no reporter-valid counterpart. Find a reporter with comtrade_lookup_countries using role "reporter".';

describe('counterpart notices', () => {
  it.each([
    { selected: undefined, returned: [0, 156], warned: true },
    { selected: undefined, returned: [0], warned: false },
    { selected: undefined, returned: [156], warned: false },
    { selected: undefined, returned: [], warned: false },
    { selected: 0, returned: [0, 156], warned: false },
    { selected: 156, returned: [0, 156], warned: false },
  ])('warns only on mixed breakdowns ($selected, $returned)', ({ selected, returned, warned }) => {
    const notice = mixedPartnerBreakdownNotice(
      selected,
      returned.map((partnerCode) => ({ partnerCode })),
    );
    expect(notice !== undefined).toBe(warned);
  });

  // Names are the 2026-11-11 catalog's, trimmed as the reference index trims them.
  it.each<[number, ReporterStatus, string | undefined, string | undefined]>([
    [
      158,
      TAIWAN,
      'Reporter 158 (Taiwan, Province of China) is a partner-only code in UN Comtrade reference data; UN Comtrade publishes its trade under reporter 490 (Other Asia, nes). Retry with reporter_code 490.',
      'UN Comtrade publishes the trade of partner 158 (Taiwan, Province of China) under 490 (Other Asia, nes). Retry with partner_code 490.',
    ],
    [
      250,
      iso3('Metropolitan France', 251),
      'Reporter 250 (Metropolitan France) is a partner-only code in UN Comtrade reference data; reporter 251 shares its ISO-3 identity. Retry with reporter_code 251.',
      'Partner 250 (Metropolitan France) shares its ISO-3 identity with 251. Retry with partner_code 251.',
    ],
    [
      578,
      iso3('Norway, excluding Svalbard and Jan Mayen', 579),
      'Reporter 578 (Norway, excluding Svalbard and Jan Mayen) is a partner-only code in UN Comtrade reference data; reporter 579 shares its ISO-3 identity. Retry with reporter_code 579.',
      'Partner 578 (Norway, excluding Svalbard and Jan Mayen) shares its ISO-3 identity with 579. Retry with partner_code 579.',
    ],
    [
      756,
      iso3('Switzerland', 757),
      'Reporter 756 (Switzerland) is a partner-only code in UN Comtrade reference data; reporter 757 shares its ISO-3 identity. Retry with reporter_code 757.',
      'Partner 756 (Switzerland) shares its ISO-3 identity with 757. Retry with partner_code 757.',
    ],
    [
      840,
      iso3('United States of America', 842),
      'Reporter 840 (United States of America) is a partner-only code in UN Comtrade reference data; reporter 842 shares its ISO-3 identity. Retry with reporter_code 842.',
      'Partner 840 (United States of America) shares its ISO-3 identity with 842. Retry with partner_code 842.',
    ],
    [
      0,
      { referenceStatus: 'partner_only', name: 'World' },
      `Reporter 0 (World) ${NO_COUNTERPART}`,
      undefined,
    ],
    [
      412,
      { referenceStatus: 'partner_only', name: 'Kosovo' },
      `Reporter 412 (Kosovo) ${NO_COUNTERPART}`,
      undefined,
    ],
    [
      438,
      { referenceStatus: 'partner_only', name: 'Liechtenstein' },
      `Reporter 438 (Liechtenstein) ${NO_COUNTERPART}`,
      undefined,
    ],
    [
      630,
      { referenceStatus: 'partner_only', name: 'Puerto Rico' },
      `Reporter 630 (Puerto Rico) ${NO_COUNTERPART}`,
      undefined,
    ],
    [490, { referenceStatus: 'reporter', name: 'Other Asia, nes' }, undefined, undefined],
    [999, { referenceStatus: 'unknown' }, undefined, undefined],
  ])('words code %i as a reporter and as a partner', (code, status, reporter, partner) => {
    expect(partnerOnlyReporterNotice(code, status)).toBe(reporter);
    expect(partnerCounterpartNotice(code, status)).toBe(partner);
  });

  it('escapes Markdown in catalog names on both sides', () => {
    const status: ReporterStatus = {
      referenceStatus: 'partner_only',
      name: 'A_*B*_',
      suggestedReporterCode: 9,
      suggestionBasis: 'published_under',
      suggestedReporterName: '[C](x)',
    };
    for (const sentence of [
      partnerOnlyReporterNotice(1, status),
      partnerCounterpartNotice(1, status),
    ]) {
      expect(sentence).toContain('A\\_\\*B\\*\\_');
      expect(sentence).toContain('\\[C\\](x)');
    }
  });

  describe('counterpartNotices', () => {
    const statuses = new Map<number, ReporterStatus>([
      [158, TAIWAN],
      [250, iso3('Metropolitan France', 251)],
      [0, { referenceStatus: 'partner_only', name: 'World' }],
      [842, { referenceStatus: 'reporter', name: 'USA' }],
    ]);
    const reference = {
      getReporterStatus: (code: number): ReporterStatus =>
        statuses.get(code) ?? { referenceStatus: 'unknown' },
    };
    const REPORTER_158 =
      'Reporter 158 (Taiwan, Province of China) is a partner-only code in UN Comtrade reference data; UN Comtrade publishes its trade under reporter 490 (Other Asia, nes). Retry with reporter_code 490.';
    const PARTNER_250 =
      'Partner 250 (Metropolitan France) shares its ISO-3 identity with 251. Retry with partner_code 251.';

    it('applies ISO-3 counterpart guidance independently of the goods mapping in services', () => {
      expect(counterpartNotices(reference, 158, 250, 'S')).toEqual([PARTNER_250]);
      expect(counterpartNotices(reference, 250, 158, 'S')).toEqual([
        'Reporter 250 (Metropolitan France) is a partner-only code in UN Comtrade reference data; reporter 251 shares its ISO-3 identity. Retry with reporter_code 251.',
      ]);
    });

    it.each<[string, number | undefined, number | undefined, string[]]>([
      ['the reporter sentence before the partner sentence', 158, 250, [REPORTER_158, PARTNER_250]],
      ['the reporter sentence alone for partner World', 158, 0, [REPORTER_158]],
      ['the partner sentence alone for a reporter-valid reporter', 842, 250, [PARTNER_250]],
      ['the partner sentence alone without a single reporter', undefined, 250, [PARTNER_250]],
      [
        'the no-counterpart sentence for reporter World',
        0,
        undefined,
        [`Reporter 0 (World) ${NO_COUNTERPART}`],
      ],
      ['nothing for a reporter-valid reporter and partner World', 842, 0, []],
      ['nothing without codes', undefined, undefined, []],
    ])('returns %s', (_case, reporterCode, partnerCode, sentences) => {
      expect(counterpartNotices(reference, reporterCode, partnerCode)).toStrictEqual(sentences);
    });
  });
});
