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

  /** Index a country row unless its code is already indexed; Reporters.json is indexed first. */
  private indexCountry(row: RawCountry, validAsReporter: boolean): void {
    if (this.countriesByCode.has(row.id)) return;
    const iso2 = row.reporterCodeIsoAlpha2 || row.PartnerCodeIsoAlpha2;
    const iso3 = row.reporterCodeIsoAlpha3 || row.PartnerCodeIsoAlpha3;
    this.countriesByCode.set(row.id, {
      id: row.id,
      name: row.text,
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
   * Classify a code used as a reporter: reporter-valid, partner-only (naming the reporter-valid
   * entry with the same ISO-3 identity, current before expired, then lowest code), or in neither
   * catalog. ISO-2 does not qualify: it was reassigned between entities (BQ, CS). Annotates empty
   * results only; never reject a request on it.
   */
  getReporterStatus(code: number): ReporterStatus {
    const entry = this.countriesByCode.get(code);
    if (!entry) return { referenceStatus: 'unknown' };
    if (entry.validAsReporter) return { referenceStatus: 'reporter', name: entry.name };
    const today = todayIso();
    const [suggested] = Array.from(this.countriesByCode.values())
      .filter(
        (candidate) =>
          candidate.validAsReporter && entry.iso3 !== undefined && candidate.iso3 === entry.iso3,
      )
      .sort((a, b) => Number(isExpired(a, today)) - Number(isExpired(b, today)) || a.id - b.id);
    return {
      referenceStatus: 'partner_only',
      name: entry.name,
      ...(suggested && { suggestedReporterCode: suggested.id }),
    };
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

  /** Search the complete selected catalog, retaining native HS or SITC levels. */
  async searchCommodityCodes(
    query: string,
    classification: string,
    aggrLevel?: number,
    signal?: AbortSignal,
  ): Promise<CommodityCode[]> {
    signal?.throwIfAborted();
    if (classification === 'HS')
      return this.searchHsCodes(query).filter(
        (entry) => aggrLevel === undefined || entry.aggrLevel === aggrLevel,
      );
    const codes = await this.getCommodityCodes(classification, signal);
    const q = query.toLowerCase().trim();
    return Array.from(codes.values()).filter(
      (entry) =>
        (aggrLevel === undefined || entry.aggrLevel === aggrLevel) &&
        (entry.id.toLowerCase().startsWith(q) || entry.text.toLowerCase().includes(q)),
    );
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
   * EB categories matching an optional keyword or code prefix, each tagged with the scheme
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
   * Search country/area entries by name fragment or ISO code (case-insensitive). Each match also
   * pulls in the entries sharing its ISO-3 identity; ISO-2 codes were reassigned between entities,
   * so they never expand a match. Ordered exact ISO match, reporter-valid, current before
   * expired, name, then code.
   */
  searchCountries(query: string, roleFilter?: 'reporter' | 'partner' | 'any'): CountryEntry[] {
    const q = query.toLowerCase().trim();
    const exactIso = (entry: CountryEntry) =>
      entry.iso2?.toLowerCase() === q || entry.iso3?.toLowerCase() === q;
    const matches = (entry: CountryEntry) =>
      entry.name.toLowerCase().includes(q) || exactIso(entry);
    const identities = new Set<string>();
    for (const entry of this.countriesByCode.values()) {
      if (entry.iso3 && matches(entry)) identities.add(entry.iso3);
    }
    const today = todayIso();
    return Array.from(this.countriesByCode.values())
      .filter(
        (entry) =>
          (matches(entry) || (entry.iso3 !== undefined && identities.has(entry.iso3))) &&
          (roleFilter !== 'reporter' || entry.validAsReporter) &&
          (roleFilter !== 'partner' || this.partnerCodes.has(entry.id)),
      )
      .sort(
        (a, b) =>
          Number(exactIso(b)) - Number(exactIso(a)) ||
          Number(b.validAsReporter) - Number(a.validAsReporter) ||
          Number(isExpired(a, today)) - Number(isExpired(b, today)) ||
          a.name.localeCompare(b.name) ||
          a.id - b.id,
      );
  }

  /**
   * Search HS codes by keyword or code prefix.
   * Matches against description text or code string.
   */
  searchHsCodes(query: string, aggrLevel?: 2 | 4 | 6): HsCode[] {
    const q = query.toLowerCase().trim();
    const results: HsCode[] = [];
    for (const entry of this.hsByCode.values()) {
      if (aggrLevel && entry.aggrLevel !== aggrLevel) continue;
      const codeMatch = entry.id.startsWith(q);
      const textMatch = entry.text.toLowerCase().includes(q);
      if (codeMatch || textMatch) results.push(entry);
    }
    return results;
  }

  /**
   * Search EBOPS categories by keyword or code prefix.
   */
  searchEbopsCategories(query: string): EbopsCategory[] {
    const q = query.toLowerCase().trim();
    const results: EbopsCategory[] = [];
    for (const entry of this.ebopsByCode.values()) {
      if (entry.id.toLowerCase().startsWith(q) || entry.text.toLowerCase().includes(q)) {
        results.push(entry);
      }
    }
    return results;
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
