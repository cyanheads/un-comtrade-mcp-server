/**
 * @fileoverview Comtrade reference data service. Fetches and indexes reporter/partner
 * country lists, HS commodity codes, and EBOPS service categories from UN Comtrade
 * static reference files at startup. All data is held in memory for fast lookups.
 * @module services/comtrade-reference/comtrade-reference-service
 */

import { z } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { serializationError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, requestContextService, withRetry } from '@cyanheads/mcp-ts-core/utils';
import type {
  CommodityCode,
  CountryEntry,
  EbopsCategory,
  HsCode,
  QuantityUnit,
  RawHsEntry,
} from './types.js';
import {
  COMMODITY_CLASSIFICATIONS,
  rawEbopsSchema,
  rawHsSchema,
  rawPartnerSchema,
  rawReporterSchema,
} from './types.js';

const REFERENCE_BASE = 'https://comtradeapi.un.org/files/v1/app/reference';
const FETCH_TIMEOUT_MS = 30_000;
const commodityClassificationSchema = z.enum(COMMODITY_CLASSIFICATIONS);
const quantityUnitSchema = z.object({
  qtyCode: z.number().int(),
  qtyAbbr: z.string(),
  qtyDescription: z.string(),
});

/** Indexes all UN Comtrade reference data in memory for fast lookups. */
export class ComtradeReferenceService {
  /** Combined country/area map keyed by M49 numeric code. */
  private countriesByCode = new Map<number, CountryEntry>();
  /** Default HS.json discovery catalog; not an authoritative historical-edition lookup. */
  private hsByCode = new Map<string, HsCode>();
  /** EBOPS categories keyed by category code. */
  private ebopsByCode = new Map<string, EbopsCategory>();
  private sitcByClassification = new Map<string, Map<string, RawHsEntry>>();
  private commoditiesByClassification = new Map<string, Map<string, CommodityCode>>();
  private quantityUnits: Map<number, QuantityUnit> | undefined;

  // biome-ignore lint/complexity/noUselessConstructor: params reserved for future use
  constructor(_config: AppConfig, _storage: StorageService) {}

  /** Fetch and index all reference data. Called once from setup(). */
  async initialize(): Promise<void> {
    const [reporters, partners, hsEntries, ebopsEntries] = await Promise.all([
      this.fetchJson('Reporters.json', rawReporterSchema),
      this.fetchJson('partnerAreas.json', rawPartnerSchema),
      this.fetchJson('HS.json', rawHsSchema),
      this.fetchJson('EB.json', rawEbopsSchema),
    ]);

    // Index reporters — these are valid as reporter codes
    const reporterCodes = new Set<number>();
    for (const r of reporters) {
      reporterCodes.add(r.reporterCode);
      if (!this.countriesByCode.has(r.reporterCode)) {
        this.countriesByCode.set(r.reporterCode, {
          id: r.reporterCode,
          name: r.reporterDesc,
          ...(r.reporterCodeIsoAlpha2 && { iso2: r.reporterCodeIsoAlpha2 }),
          ...(r.reporterCodeIsoAlpha3 && { iso3: r.reporterCodeIsoAlpha3 }),
          validAsReporter: true,
          isGroup: r.isGroup === true || r.isGroup === 1 || r.isGroup === '1',
        });
      }
    }

    // Index partners — may include groupings not valid as reporters
    for (const p of partners) {
      if (!this.countriesByCode.has(p.PartnerCode)) {
        this.countriesByCode.set(p.PartnerCode, {
          id: p.PartnerCode,
          name: p.PartnerDesc,
          ...(p.PartnerCodeIsoAlpha2 && { iso2: p.PartnerCodeIsoAlpha2 }),
          ...(p.PartnerCodeIsoAlpha3 && { iso3: p.PartnerCodeIsoAlpha3 }),
          validAsReporter: reporterCodes.has(p.PartnerCode),
          isGroup: p.isGroup === true || p.isGroup === 1 || p.isGroup === '1',
        });
      }
    }

    // Index HS codes — compute aggr level from code length if not provided
    for (const h of hsEntries) {
      const raw =
        typeof h.aggrLevel === 'number'
          ? h.aggrLevel
          : h.id.length <= 2
            ? 2
            : h.id.length <= 4
              ? 4
              : 6;
      const aggrLevel = ([2, 4, 6].includes(raw) ? raw : 6) as 2 | 4 | 6;
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

  /** Look up a country/area by M49 numeric code. */
  getCountryByCode(code: number): CountryEntry | undefined {
    return this.countriesByCode.get(code);
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
   * Search country/area entries by name fragment or ISO code.
   * Returns entries where name, iso3, or iso2 match the query (case-insensitive).
   */
  searchCountries(query: string, roleFilter?: 'reporter' | 'partner' | 'any'): CountryEntry[] {
    const q = query.toLowerCase().trim();
    const identities = new Set<string>();
    for (const entry of this.countriesByCode.values()) {
      if (
        entry.name.toLowerCase().includes(q) ||
        entry.iso3?.toLowerCase() === q ||
        entry.iso2?.toLowerCase() === q
      ) {
        if (entry.iso2) identities.add(entry.iso2);
        if (entry.iso3) identities.add(entry.iso3);
      }
    }
    const results: CountryEntry[] = [];
    for (const entry of this.countriesByCode.values()) {
      const nameMatch = entry.name.toLowerCase().includes(q);
      const iso3Match = entry.iso3?.toLowerCase() === q;
      const iso2Match = entry.iso2?.toLowerCase() === q;
      const identityMatch =
        (entry.iso2 !== undefined && identities.has(entry.iso2)) ||
        (entry.iso3 !== undefined && identities.has(entry.iso3));
      if (!nameMatch && !iso3Match && !iso2Match && !identityMatch) continue;
      if (roleFilter === 'reporter' && !entry.validAsReporter) continue;
      results.push(entry);
    }
    const exactIso = (entry: CountryEntry) =>
      entry.iso2?.toLowerCase() === q || entry.iso3?.toLowerCase() === q;
    return results.sort(
      (a, b) =>
        Number(exactIso(b)) - Number(exactIso(a)) ||
        Number(b.validAsReporter) - Number(a.validAsReporter) ||
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
    const result = z.array(schema).safeParse(entries);
    if (!result.success) {
      throw serializationError(
        'Comtrade returned invalid reference entries. Retry later.',
        { filename },
        { cause: result.error },
      );
    }
    return result.data;
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
