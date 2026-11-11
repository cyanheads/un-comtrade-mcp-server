/**
 * @fileoverview Comtrade reference data service. Fetches and indexes reporter/partner
 * country lists, HS commodity codes, and EBOPS service categories from UN Comtrade
 * static reference files at startup, and loads edition, unit, and EB scheme catalogs on
 * demand. Catalogs are validated row by row. All data is held in memory for fast lookups.
 * @module services/comtrade-reference/comtrade-reference-service
 */

import { z } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { serializationError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import {
  fetchWithTimeout,
  logger,
  requestContextService,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import type {
  CommodityCode,
  CountryEntry,
  CountryMatch,
  EbopsCategory,
  EbScheme,
  HsCode,
  QuantityUnit,
  RawCountry,
  RawHsEntry,
  ReporterStatus,
  ServiceCategoryListing,
} from './types.js';
import {
  COMMODITY_CLASSIFICATIONS,
  EB_SCHEMES,
  rawCountrySchema,
  rawEbopsSchema,
  rawHsSchema,
} from './types.js';

const REFERENCE_BASE = 'https://comtradeapi.un.org/files/v1/app/reference';
const FETCH_TIMEOUT_MS = 30_000;
const commodityClassificationSchema = z.enum(COMMODITY_CLASSIFICATIONS);
const quantityUnitSchema = z.object({
  qtyCode: z.number().int(),
  qtyAbbr: z.string(),
  qtyDescription: z.string(),
});
/** HS aggregation levels: 0 is the all-commodities TOTAL; the others count digits. */
const HS_LEVELS = [0, 2, 4, 6] as const;

type RawEbopsEntry = z.infer<typeof rawEbopsSchema>;

/** The HS level a code's shape implies, for rows whose upstream level is not an HS level. */
function hsLevelFromCode(id: string): HsCode['aggrLevel'] {
  if (id === 'TOTAL') return 0;
  return id.length <= 2 ? 2 : id.length <= 4 ? 4 : 6;
}

/** Today's UTC date as `YYYY-MM-DD`, comparable with entity validity dates. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** An entity is expired once its last valid day is before today; without an expiry it is current. */
function isExpired(entry: CountryEntry, today: string): boolean {
  return entry.entryExpiredDate !== undefined && entry.entryExpiredDate < today;
}

const COMBINING_MARKS = /\p{M}/gu;

/**
 * Fold country text for comparison: lowercase with the locale-insensitive mapping, strip
 * diacritics, trim. Lowercasing comes first, since stripping marks first can change which sigma a
 * capital Σ becomes. Marks are stripped before NFD as well as after it: canonical reordering is
 * quadratic in the length of a run of combining marks, and with the input's own marks gone a run
 * is at most one character's decomposition. Every Unicode non-starter is a mark, so the early
 * strip changes no result.
 */
function normalizeCountryText(text: string): string {
  return text
    .toLowerCase()
    .replace(COMBINING_MARKS, '')
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .trim();
}

/**
 * Common names UN Comtrade's catalogs do not carry, keyed by folded name. Every target is a
 * current entry valid as reporter and as partner. An alias applies only when no catalog name,
 * note, or ISO code equals the query, so a catalog entry always wins over a colliding alias.
 */
const COUNTRY_ALIASES = new Map(
  (
    [
      ['UK', 826], // United Kingdom
      ['Britain', 826],
      ['Great Britain', 826],
      ['South Korea', 410], // Rep. of Korea
      ['North Korea', 408], // Dem. People's Rep. of Korea
      ['Turkey', 792], // Türkiye
      ['Czech Republic', 203], // Czechia
      ['Ivory Coast', 384], // Côte d'Ivoire
      ['UAE', 784], // United Arab Emirates
      ['Laos', 418], // Lao People's Dem. Rep.
      ['Burma', 104], // Myanmar
      ['Macau', 446], // China, Macao SAR
      ['Holland', 528], // Netherlands
      ['Swaziland', 748], // Eswatini
      ['Cape Verde', 132], // Cabo Verde
      ['East Timor', 626], // Timor-Leste
      ['DRC', 180], // Dem. Rep. of the Congo
    ] as const
  ).map(([name, code]) => [normalizeCountryText(name), code]),
);

/**
 * Partner-only codes whose trade UN Comtrade publishes under another code, as reporter and as
 * partner, with no catalog field linking the two: no ISO code is shared and the target's note
 * names no entity. A row applies only while its target is an indexed reporter-valid entry.
 */
const PUBLISHED_UNDER = new Map([
  [158, 490], // Taiwan, Province of China → Other Asia, nes
]);

/**
 * Lookup rank: 0 when an alias key, ISO code, name, or note equals the query; 1 when a name or
 * note contains it.
 */
type CountryMatchTier = 0 | 1;

/** One entry's folded fields: `exact` its ISO codes, name, and note; `texts` its name and note. */
interface CountrySearchKeys {
  exact: string[];
  texts: string[];
}

/** Folded fields per entry, computed on first search; entries are never mutated once indexed. */
const countrySearchKeys = new WeakMap<CountryEntry, CountrySearchKeys>();

/** The tier at which an entry's own fields match a folded query, or undefined when none does. */
function countryMatchTier(entry: CountryEntry, query: string): CountryMatchTier | undefined {
  let keys = countrySearchKeys.get(entry);
  if (!keys) {
    const fold = (values: (string | undefined)[]) =>
      values.filter((value) => value !== undefined).map(normalizeCountryText);
    keys = {
      exact: fold([entry.iso2, entry.iso3, entry.name, entry.note]),
      texts: fold([entry.name, entry.note]),
    };
    countrySearchKeys.set(entry, keys);
  }
  if (keys.exact.includes(query)) return 0;
  return keys.texts.some((text) => text.includes(query)) ? 1 : undefined;
}

/** Record `tier` for `key` unless it already holds a better (lower) one. */
function keepBestTier<K>(tiers: Map<K, CountryMatchTier>, key: K, tier: CountryMatchTier): void {
  const current = tiers.get(key);
  if (current === undefined || tier < current) tiers.set(key, tier);
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * Whether `text` holds a letter or digit of any script at `index`, a character that joins a match
 * to a longer word; outside the text it holds none. ASCII, most of every catalog and the whole-word
 * scan's hot path, is compared by code unit.
 */
function isWordCharacterAt(text: string, index: number): boolean {
  const unit = text.charCodeAt(index);
  if (Number.isNaN(unit)) return false;
  if (unit < 0x80) {
    return (
      (unit >= 0x30 && unit <= 0x39) ||
      (unit >= 0x41 && unit <= 0x5a) ||
      (unit >= 0x61 && unit <= 0x7a)
    );
  }
  return LETTER_OR_DIGIT.test(text.charAt(index));
}

/**
 * The code a code-like query spells without its separators ("0901.11" → "090111"): a query of
 * only digits, `.`, `-` and spaces with at least one digit. Undefined for any other query.
 */
function codeFromCodeLikeQuery(query: string): string | undefined {
  let hasDigit = false;
  for (let i = 0; i < query.length; i++) {
    const unit = query.charCodeAt(i); // digits are 0x30-0x39; ".", "-" and " " 0x2e, 0x2d, 0x20
    if (unit >= 0x30 && unit <= 0x39) hasDigit = true;
    else if (unit !== 0x2e && unit !== 0x2d && unit !== 0x20) return;
  }
  return hasDigit ? query.replaceAll('.', '').replaceAll('-', '').replaceAll(' ', '') : undefined;
}

/**
 * Whether `needle`, first found in `text` at `from`, has an occurrence with no letter or digit
 * immediately before or after it. Scans with `indexOf`, never a pattern built from the caller's
 * text, stepping one past each occurrence so an overlapping later one is checked too.
 */
function hasWholeWordMatch(text: string, needle: string, from: number): boolean {
  for (let at = from; at >= 0; at = text.indexOf(needle, at + 1)) {
    if (!isWordCharacterAt(text, at - 1) && !isWordCharacterAt(text, at + needle.length)) {
      return true;
    }
  }
  return false;
}

/**
 * Catalog entries whose code starts with the query or whose description contains it, in four
 * tiers: exact code, code prefix, whole-word description match, other description match. Ties
 * keep catalog order, so offset pages walk one fixed order. Codes and descriptions compare
 * case-insensitively. With `stripCodeSeparators` (HS and SITC, whose codes never contain a
 * separator) a code-like query meets codes without its separators, while descriptions still match
 * it as typed. The query is read a fixed number of times and each description scan is bounded by
 * that description, so a call grows linearly with the query and with the catalog. An empty query
 * matches every code as a prefix, so the description scan never sees an empty needle.
 */
function rankCatalogMatches<T extends { id: string; text: string }>(
  entries: Iterable<T>,
  query: string,
  { stripCodeSeparators = false } = {},
): T[] {
  const typed = query.toLowerCase();
  const code = (stripCodeSeparators ? codeFromCodeLikeQuery(typed) : undefined) ?? typed;
  const tiers: [T[], T[], T[], T[]] = [[], [], [], []];
  for (const entry of entries) {
    const id = entry.id.toLowerCase();
    if (id === code) {
      tiers[0].push(entry);
    } else if (id.startsWith(code)) {
      tiers[1].push(entry);
    } else {
      const description = entry.text.toLowerCase();
      const at = description.indexOf(typed);
      if (at >= 0) tiers[hasWholeWordMatch(description, typed, at) ? 2 : 3].push(entry);
    }
  }
  return tiers.flat();
}

/** Indexes all UN Comtrade reference data in memory for fast lookups. */
export class ComtradeReferenceService {
  /** Combined country/area map keyed by M49 numeric code. */
  private countriesByCode = new Map<number, CountryEntry>();
  /** Codes listed in partnerAreas.json; Reporters.json also carries reporter-only codes (EU 97, ASEAN 975). */
  private partnerCodes = new Set<number>();
  /** Default HS.json discovery catalog; not an authoritative historical-edition lookup. */
  private hsByCode = new Map<string, HsCode>();
  /** EBOPS categories keyed by category code. */
  private ebopsByCode = new Map<string, EbopsCategory>();
  private sitcByClassification = new Map<string, Map<string, RawHsEntry>>();
  private commoditiesByClassification = new Map<string, Map<string, CommodityCode>>();
  private quantityUnits: Map<number, QuantityUnit> | undefined;
  /** Per-scheme EBOPS catalogs keyed by category code, loaded on demand. */
  private ebSchemeCatalogs = new Map<EbScheme, Map<string, RawEbopsEntry>>();

  // biome-ignore lint/complexity/noUselessConstructor: params reserved for future use
  constructor(_config: AppConfig, _storage: StorageService) {}

  /** Fetch and index all reference data. Called once from setup(); an empty catalog stops startup. */
  async initialize(): Promise<void> {
    const [reporters, partners, hsEntries, ebopsEntries] = await Promise.all([
      this.fetchJson('Reporters.json', rawCountrySchema),
      this.fetchJson('partnerAreas.json', rawCountrySchema),
      this.fetchJson('HS.json', rawHsSchema),
      this.fetchJson('EB.json', rawEbopsSchema),
    ]);
    for (const [filename, rows] of [
      ['Reporters.json', reporters],
      ['partnerAreas.json', partners],
      ['HS.json', hsEntries],
      ['EB.json', ebopsEntries],
    ] as const) {
      // An empty index would answer every lookup with nothing; failing startup is the honest outcome.
      if (rows.length === 0) {
        throw serializationError('Comtrade returned an empty reference catalog. Retry later.', {
          filename,
        });
      }
    }

    // Reporters.json rows are valid reporter codes; partnerAreas.json adds partner-only areas.
    for (const row of reporters) this.indexCountry(row, true);
    for (const row of partners) {
      this.partnerCodes.add(row.id);
      this.indexCountry(row, false);
    }

    // Keep upstream's level when it is an HS level; otherwise derive it from the code.
    for (const h of hsEntries) {
      const upstreamLevel = h.aggrLevel ?? h.aggrlevel;
      const aggrLevel = HS_LEVELS.find((level) => level === upstreamLevel) ?? hsLevelFromCode(h.id);
      this.hsByCode.set(h.id, {
        id: h.id,
        text: h.text,
        ...(h.parent && { parent: h.parent }),
        aggrLevel,
        isLeaf: h.isLeaf === true || h.isLeaf === 1 || h.isLeaf === '1',
        recommendedQueryCode: h.id,
      });
    }

    // Index EBOPS service categories
    for (const e of ebopsEntries) {
      this.ebopsByCode.set(e.id, {
        id: e.id,
        text: e.text,
        ...(e.parent && { parent: e.parent }),
      });
    }
  }

  /**
   * Index a country row unless its code is already indexed; Reporters.json is indexed first.
   * Upstream pads some names and ISO codes with trailing spaces ("Puerto Rico ", "X1 "), so names,
   * codes, and notes are trimmed. A note that folds to the name ("Metropolitan France") is dropped:
   * it matches no query the name does not, and tells a reader nothing.
   */
  private indexCountry(row: RawCountry, validAsReporter: boolean): void {
    if (this.countriesByCode.has(row.id)) return;
    const iso2 = (row.reporterCodeIsoAlpha2 || row.PartnerCodeIsoAlpha2)?.trim();
    const iso3 = (row.reporterCodeIsoAlpha3 || row.PartnerCodeIsoAlpha3)?.trim();
    const name = row.text.trim();
    const note = (row.reporterNote || row.partnerNote)?.trim();
    this.countriesByCode.set(row.id, {
      id: row.id,
      name,
      ...(note && normalizeCountryText(note) !== normalizeCountryText(name) && { note }),
      ...(iso2 && { iso2 }),
      ...(iso3 && { iso3 }),
      validAsReporter,
      isGroup: row.isGroup === true || row.isGroup === 1 || row.isGroup === '1',
      ...(row.entryEffectiveDate && { entryEffectiveDate: row.entryEffectiveDate.slice(0, 10) }),
      ...(row.entryExpiredDate && { entryExpiredDate: row.entryExpiredDate.slice(0, 10) }),
    });
  }

  /** Look up a country/area by M49 numeric code. */
  getCountryByCode(code: number): CountryEntry | undefined {
    return this.countriesByCode.get(code);
  }

  /**
   * Classify a code used as a reporter: reporter-valid, partner-only, or in neither catalog. A
   * partner-only code names the reporter-valid code to query instead: its `PUBLISHED_UNDER`
   * target, else the entry with the same ISO-3 identity, current before expired, then lowest code.
   * ISO-2 does not qualify: it was reassigned between entities (BQ, CS). Annotates empty results
   * only; never reject a request on it.
   */
  getReporterStatus(code: number): ReporterStatus {
    const entry = this.countriesByCode.get(code);
    if (!entry) return { referenceStatus: 'unknown' };
    if (entry.validAsReporter) return { referenceStatus: 'reporter', name: entry.name };
    const publishedUnder = this.publishedUnderTarget(entry);
    if (publishedUnder) {
      return {
        referenceStatus: 'partner_only',
        name: entry.name,
        suggestedReporterCode: publishedUnder.id,
        suggestionBasis: 'published_under',
        suggestedReporterName: publishedUnder.name,
      };
    }
    const today = todayIso();
    const [suggested] = Array.from(this.countriesByCode.values())
      .filter(
        (candidate) =>
          candidate.validAsReporter && entry.iso3 !== undefined && candidate.iso3 === entry.iso3,
      )
      .sort((a, b) => Number(isExpired(a, today)) - Number(isExpired(b, today)) || a.id - b.id);
    return suggested
      ? {
          referenceStatus: 'partner_only',
          name: entry.name,
          suggestedReporterCode: suggested.id,
          suggestionBasis: 'iso3',
        }
      : { referenceStatus: 'partner_only', name: entry.name };
  }

  /** The indexed reporter-valid entry a `PUBLISHED_UNDER` row names for this one, if any. */
  private publishedUnderTarget(entry: CountryEntry): CountryEntry | undefined {
    const code = PUBLISHED_UNDER.get(entry.id);
    const target = code === undefined ? undefined : this.countriesByCode.get(code);
    return target?.validAsReporter ? target : undefined;
  }

  /** Look up an HS code entry. */
  getHsCode(code: string): HsCode | undefined {
    return this.hsByCode.get(code);
  }

  /** Load a SITC revision only when requested; cache successful loads, never a caller's pending work. */
  async getSitcCodes(
    classification: string,
    signal?: AbortSignal,
  ): Promise<Map<string, RawHsEntry>> {
    commodityClassificationSchema.parse(classification);
    signal?.throwIfAborted();
    const cached = this.sitcByClassification.get(classification);
    if (cached) return cached;
    const entries = await this.fetchJson<RawHsEntry>(
      `${classification}.json`,
      rawHsSchema,
      signal,
      10_000,
    );
    signal?.throwIfAborted();
    const index = new Map(entries.map((entry) => [entry.id, entry]));
    this.sitcByClassification.set(classification, index);
    return index;
  }

  /** Load a selected goods edition on demand. Cache completed successes only; each caller owns its cancellation. */
  async getCommodityCodes(
    classification: string,
    signal?: AbortSignal,
  ): Promise<Map<string, CommodityCode>> {
    const selected = commodityClassificationSchema.parse(classification);
    signal?.throwIfAborted();
    if (selected === 'HS') return new Map(this.hsByCode);
    const cached = this.commoditiesByClassification.get(selected);
    if (cached) return cached;
    const raw = selected.startsWith('S')
      ? Array.from((await this.getSitcCodes(selected, signal)).values())
      : await this.fetchJson(`${selected}.json`, rawHsSchema, signal, 10_000);
    signal?.throwIfAborted();
    const index = new Map(
      raw.map((entry) => [
        entry.id,
        {
          id: entry.id,
          text: entry.text,
          aggrLevel:
            entry.aggrLevel ?? entry.aggrlevel ?? (entry.id === 'TOTAL' ? 0 : entry.id.length),
          isLeaf: entry.isLeaf === true || entry.isLeaf === 1 || entry.isLeaf === '1',
          ...(entry.parent && { parent: entry.parent }),
          recommendedQueryCode: entry.id,
        },
      ]),
    );
    this.commoditiesByClassification.set(selected, index);
    return index;
  }

  /**
   * Search the complete selected catalog, ranked by `rankCatalogMatches` and retaining native HS
   * or SITC levels. A dotted, spaced, or hyphenated code ("071.1") compares without its separators.
   */
  async searchCommodityCodes(
    query: string,
    classification: string,
    aggrLevel?: number,
    signal?: AbortSignal,
  ): Promise<CommodityCode[]> {
    signal?.throwIfAborted();
    const atLevel = (entry: CommodityCode) =>
      aggrLevel === undefined || entry.aggrLevel === aggrLevel;
    if (classification === 'HS') return this.searchHsCodes(query).filter(atLevel);
    const codes = await this.getCommodityCodes(classification, signal);
    return rankCatalogMatches(codes.values(), query, { stripCodeSeparators: true }).filter(atLevel);
  }

  /** Lazily load quantity units within a ten-second deadline. Unknown codes remain absent; -1 explicitly means unavailable. */
  async getQuantityUnits(signal?: AbortSignal): Promise<Map<number, QuantityUnit>> {
    signal?.throwIfAborted();
    if (this.quantityUnits) return this.quantityUnits;
    const entries = await this.fetchJson('QuantityUnits.json', quantityUnitSchema, signal, 10_000);
    signal?.throwIfAborted();
    const index = new Map(entries.map((entry) => [entry.qtyCode, entry]));
    this.quantityUnits = index;
    return index;
  }

  /** Look up an EBOPS category by code. */
  getEbopsCategory(code: string): EbopsCategory | undefined {
    return this.ebopsByCode.get(code);
  }

  /**
   * Load one EBOPS scheme catalog on demand within ten seconds; cache completed successes only.
   * An empty catalog is a failed load: cached, it would tag no category with its scheme for good.
   */
  private async getEbSchemeCatalog(
    scheme: EbScheme,
    signal?: AbortSignal,
  ): Promise<Map<string, RawEbopsEntry>> {
    signal?.throwIfAborted();
    const cached = this.ebSchemeCatalogs.get(scheme);
    if (cached) return cached;
    const entries = await this.fetchJson(`${scheme}.json`, rawEbopsSchema, signal, 10_000);
    signal?.throwIfAborted();
    if (entries.length === 0) {
      throw serializationError('Comtrade returned an empty reference catalog. Retry later.', {
        filename: `${scheme}.json`,
      });
    }
    const index = new Map(entries.map((entry) => [entry.id, entry]));
    this.ebSchemeCatalogs.set(scheme, index);
    return index;
  }

  /**
   * EB categories matching an optional keyword or code, ranked by `rankCatalogMatches` (every
   * category in catalog order for an empty or omitted query), each tagged with the scheme
   * catalogs (EB10, EB10S, EB02) that list its code. A code whose EB.json parent is no EB.json
   * code takes the parent a scheme catalog gives it, keeping EB.json's as `ebParent` (EB10's top
   * level: `TOTAL` → `200`). If any scheme catalog fails to load, the categories come back
   * untagged with EB.json's parents. Caller cancellation propagates.
   */
  async getServiceCategories(
    query?: string,
    signal?: AbortSignal,
  ): Promise<ServiceCategoryListing> {
    signal?.throwIfAborted();
    const categories = query ? this.searchEbopsCategories(query) : this.getAllEbopsCategories();
    const loads = await Promise.all(
      EB_SCHEMES.map((scheme) =>
        this.getEbSchemeCatalog(scheme, signal).then(
          (catalog) => ({ scheme, catalog }),
          (reason: unknown) => ({ scheme, reason }),
        ),
      ),
    );
    signal?.throwIfAborted();
    const failed = loads.filter((load) => 'reason' in load);
    if (failed.length > 0) {
      const unavailableCatalogs = failed.map(({ scheme }) => `${scheme}.json`);
      logger.warning(
        `EB scheme catalogs unavailable (${unavailableCatalogs.join(', ')}); serving untagged service categories.`,
        requestContextService.createRequestContext({
          operation: 'ComtradeReferenceService.getServiceCategories',
          additionalContext: {
            unavailableCatalogs,
            reasons: failed.map(({ reason }) =>
              reason instanceof Error ? reason.message : String(reason),
            ),
          },
        }),
      );
      return { status: 'untagged', categories, unavailableCatalogs };
    }
    const catalogs = loads.flatMap((load) => ('catalog' in load ? [load] : []));
    return {
      status: 'tagged',
      categories: categories.map((category) => {
        const schemes = catalogs
          .filter(({ catalog }) => catalog.has(category.id))
          .map(({ scheme }) => scheme);
        const ebParent = category.parent;
        if (ebParent === undefined || this.ebopsByCode.has(ebParent)) {
          return { ...category, schemes };
        }
        const parent = catalogs
          .map(({ catalog }) => catalog.get(category.id)?.parent)
          .find((candidate) => candidate !== undefined && this.ebopsByCode.has(candidate));
        return parent ? { ...category, parent, ebParent, schemes } : { ...category, schemes };
      }),
    };
  }

  /** All country entries (reporters + partners combined). */
  getAllCountries(): CountryEntry[] {
    return Array.from(this.countriesByCode.values());
  }

  /** All HS code entries, optionally filtered by aggregation level. */
  getAllHsCodes(aggrLevel?: 2 | 4 | 6): HsCode[] {
    const all = Array.from(this.hsByCode.values());
    return aggrLevel ? all.filter((h) => h.aggrLevel === aggrLevel) : all;
  }

  /** All EBOPS categories. */
  getAllEbopsCategories(): EbopsCategory[] {
    return Array.from(this.ebopsByCode.values());
  }

  /**
   * Search country/area entries by name, official name, common name, or ISO code, compared after
   * `normalizeCountryText` (case, accents, surrounding spaces ignored). Exact matches, where an
   * alias key, ISO-2/ISO-3 code, name, or catalog note equals the query, rank before partial ones,
   * where a name or note contains it; a common-name alias applies only when no catalog field
   * equals the query. Entries `withPulledInEntries` adds rank with the match that pulled them in;
   * one pulled in as the code a match's trade is published under carries that match as
   * `standsInFor`, also when the role filter leaves the match out. Within a rank: reporter-valid,
   * current before expired, name, then code. A query that folds to empty text (combining marks
   * alone) matches nothing.
   */
  searchCountries(query: string, roleFilter?: 'reporter' | 'partner' | 'any'): CountryMatch[] {
    const q = normalizeCountryText(query);
    // Every name contains the empty string, so an empty key would match the whole catalog.
    if (q === '') return [];
    const direct = new Map<CountryEntry, CountryMatchTier>();
    for (const entry of this.countriesByCode.values()) {
      const tier = countryMatchTier(entry, q);
      if (tier !== undefined) direct.set(entry, tier);
    }
    const aliasCode = COUNTRY_ALIASES.get(q);
    const aliasTarget = aliasCode === undefined ? undefined : this.countriesByCode.get(aliasCode);
    if (aliasTarget && ![...direct.values()].includes(0)) direct.set(aliasTarget, 0);
    const { tiers, standsInFor } = this.withPulledInEntries(direct);
    const today = todayIso();
    return Array.from(tiers)
      .filter(
        ([entry]) =>
          (roleFilter !== 'reporter' || entry.validAsReporter) &&
          (roleFilter !== 'partner' || this.partnerCodes.has(entry.id)),
      )
      .sort(
        ([a, tierA], [b, tierB]) =>
          tierA - tierB ||
          Number(b.validAsReporter) - Number(a.validAsReporter) ||
          Number(isExpired(a, today)) - Number(isExpired(b, today)) ||
          a.name.localeCompare(b.name) ||
          a.id - b.id,
      )
      .map(([entry]) => {
        const source = standsInFor.get(entry);
        return source ? { ...entry, standsInFor: source } : entry;
      });
  }

  /**
   * The direct matches plus the entries they pull in, each pulled-in entry at the best tier of a
   * match that pulled it in: the entries sharing a match's ISO-3 identity, and a match's
   * `PUBLISHED_UNDER` target, recorded in `standsInFor` against that match. ISO-2 codes were
   * reassigned between entities, so they never pull anything in. One hop: a pulled-in entry pulls
   * in nothing further.
   */
  private withPulledInEntries(direct: ReadonlyMap<CountryEntry, CountryMatchTier>): {
    tiers: Map<CountryEntry, CountryMatchTier>;
    standsInFor: Map<CountryEntry, CountryEntry>;
  } {
    const iso3Tiers = new Map<string, CountryMatchTier>();
    const tiers = new Map(direct);
    const standsInFor = new Map<CountryEntry, CountryEntry>();
    for (const [entry, tier] of direct) {
      if (entry.iso3 !== undefined) keepBestTier(iso3Tiers, entry.iso3, tier);
      const target = this.publishedUnderTarget(entry);
      if (target) {
        keepBestTier(tiers, target, tier);
        standsInFor.set(target, entry);
      }
    }
    for (const entry of this.countriesByCode.values()) {
      const tier = entry.iso3 === undefined ? undefined : iso3Tiers.get(entry.iso3);
      if (tier !== undefined) keepBestTier(tiers, entry, tier);
    }
    return { tiers, standsInFor };
  }

  /**
   * Search HS codes by keyword or code, ranked by `rankCatalogMatches`. A dotted, spaced, or
   * hyphenated code ("0901.11") compares without its separators.
   */
  searchHsCodes(query: string): HsCode[] {
    return rankCatalogMatches(this.hsByCode.values(), query, { stripCodeSeparators: true });
  }

  /** Search EBOPS categories by keyword or code, ranked by `rankCatalogMatches`; codes keep dots. */
  searchEbopsCategories(query: string): EbopsCategory[] {
    return rankCatalogMatches(this.ebopsByCode.values(), query);
  }

  /**
   * Fetch one reference catalog and parse it row by row. A row failing the schema is dropped and
   * logged with its position; fewer than half valid rows throws `SerializationError`, since that
   * is schema drift rather than a stray row. An empty catalog is returned as-is.
   */
  private async fetchJson<T>(
    filename: string,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
    deadlineMs = 120_000,
  ): Promise<T[]> {
    const text = await withRetry(
      async ({ signal: attemptSignal }) => {
        const url = `${REFERENCE_BASE}/${filename}`;
        const ctx = requestContextService.createRequestContext({
          operation: `ComtradeReferenceService.fetchJson`,
          additionalContext: { filename },
        });
        const response = await fetchWithTimeout(url, FETCH_TIMEOUT_MS, ctx, {
          signal: attemptSignal,
        });
        const text = await response.text();
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw new Error('Reference endpoint returned HTML — service may be unavailable.');
        }
        return text;
      },
      {
        operation: `ComtradeReferenceService.fetchJson:${filename}`,
        baseDelayMs: 2000,
        deadlineMs,
        ...(signal && { signal }),
      },
    );
    // A fully read invalid payload is deterministic; only request/body I/O belongs in retry.
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw serializationError(
        'Comtrade returned a malformed reference catalog. Retry later.',
        { filename },
        { cause },
      );
    }
    const entries =
      parsed !== null && typeof parsed === 'object' && 'results' in parsed
        ? parsed.results
        : parsed;
    if (!Array.isArray(entries)) {
      throw serializationError('Comtrade returned invalid reference entries. Retry later.', {
        filename,
      });
    }
    const rows: T[] = [];
    const droppedRows: { index: number; issues: string[] }[] = [];
    let firstError: z.ZodError | undefined;
    entries.forEach((entry, index) => {
      const result = schema.safeParse(entry);
      if (result.success) {
        rows.push(result.data);
        return;
      }
      firstError ??= result.error;
      droppedRows.push({
        index,
        issues: result.error.issues.map(
          (issue) => `${issue.path.map(String).join('.') || '(row)'}: ${issue.message}`,
        ),
      });
    });
    if (rows.length * 2 < entries.length) {
      throw serializationError(
        'Comtrade returned invalid reference entries. Retry later.',
        { filename, invalidRowCount: droppedRows.length, rowCount: entries.length },
        { cause: firstError },
      );
    }
    if (droppedRows.length > 0) {
      logger.warning(
        `Dropped ${droppedRows.length} invalid row(s) from ${filename}; serving the other ${rows.length}.`,
        requestContextService.createRequestContext({
          operation: 'ComtradeReferenceService.fetchJson',
          additionalContext: { filename, droppedRows },
        }),
      );
    }
    return rows;
  }
}

let _service: ComtradeReferenceService | undefined;

/** Initialize the reference service. Call once from createApp() setup(). */
export function initComtradeReferenceService(
  config: AppConfig,
  storage: StorageService,
): ComtradeReferenceService {
  _service = new ComtradeReferenceService(config, storage);
  return _service;
}

/** Access the initialized reference service. Throws if not initialized. */
export function getComtradeReferenceService(): ComtradeReferenceService {
  if (!_service) {
    throw new Error(
      'ComtradeReferenceService not initialized — call initComtradeReferenceService() in setup()',
    );
  }
  return _service;
}
