/**
 * @fileoverview Comtrade reference data service. Fetches and indexes reporter/partner
 * country lists, HS commodity codes, and EBOPS service categories from UN Comtrade
 * static reference files at startup. All data is held in memory for fast lookups.
 * @module services/comtrade-reference/comtrade-reference-service
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, requestContextService, withRetry } from '@cyanheads/mcp-ts-core/utils';
import type {
  CountryEntry,
  EbopsCategory,
  HsCode,
  RawEbopsEntry,
  RawHsEntry,
  RawPartnerEntry,
  RawReporterEntry,
} from './types.js';

const REFERENCE_BASE = 'https://comtradeapi.un.org/files/v1/app/reference';
const FETCH_TIMEOUT_MS = 30_000;

/** Indexes all UN Comtrade reference data in memory for fast lookups. */
export class ComtradeReferenceService {
  /** Combined country/area map keyed by M49 numeric code. */
  private countriesByCode = new Map<number, CountryEntry>();
  /** HS codes keyed by HS code string. Covers all editions combined. */
  private hsByCode = new Map<string, HsCode>();
  /** EBOPS categories keyed by category code. */
  private ebopsByCode = new Map<string, EbopsCategory>();

  // biome-ignore lint/complexity/noUselessConstructor: params reserved for future use
  constructor(_config: AppConfig, _storage: StorageService) {}

  /** Fetch and index all reference data. Called once from setup(). */
  async initialize(): Promise<void> {
    const [reporters, partners, hsEntries, ebopsEntries] = await Promise.all([
      this.fetchJson<RawReporterEntry[]>('Reporters.json'),
      this.fetchJson<RawPartnerEntry[]>('partnerAreas.json'),
      this.fetchJson<RawHsEntry[]>('HS.json'),
      this.fetchJson<RawEbopsEntry[]>('EB10.json'),
    ]);

    // Index reporters — these are valid as reporter codes
    const reporterCodes = new Set<number>();
    for (const r of reporters) {
      reporterCodes.add(r.reporterCode);
      if (!this.countriesByCode.has(r.reporterCode)) {
        this.countriesByCode.set(r.reporterCode, {
          id: r.reporterCode,
          name: r.reporterDesc,
          ...(r.reporterCodeIsoAlpha3 && { iso3: r.reporterCodeIsoAlpha3 }),
          validAsReporter: true,
          isGroup: r.isGroup === 1 || r.isGroup === '1',
        });
      }
    }

    // Index partners — may include groupings not valid as reporters
    for (const p of partners) {
      if (!this.countriesByCode.has(p.PartnerCode)) {
        this.countriesByCode.set(p.PartnerCode, {
          id: p.PartnerCode,
          name: p.PartnerDesc,
          ...(p.PartnerCodeIsoAlpha3 && { iso3: p.PartnerCodeIsoAlpha3 }),
          validAsReporter: reporterCodes.has(p.PartnerCode),
          isGroup: p.isGroup === 1 || p.isGroup === '1',
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
        isLeaf: h.isLeaf === 1 || h.isLeaf === true,
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
    const results: CountryEntry[] = [];
    for (const entry of this.countriesByCode.values()) {
      const nameMatch = entry.name.toLowerCase().includes(q);
      const iso3Match = entry.iso3?.toLowerCase() === q;
      const iso2Match = entry.iso2?.toLowerCase() === q;
      if (!nameMatch && !iso3Match && !iso2Match) continue;
      if (roleFilter === 'reporter' && !entry.validAsReporter) continue;
      results.push(entry);
    }
    return results;
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

  private fetchJson<T>(filename: string): Promise<T> {
    return withRetry(
      async () => {
        const url = `${REFERENCE_BASE}/${filename}`;
        const ctx = requestContextService.createRequestContext({
          operation: `ComtradeReferenceService.fetchJson`,
          filename,
        });
        const response = await fetchWithTimeout(url, FETCH_TIMEOUT_MS, ctx, {});
        const text = await response.text();
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw new Error('Reference endpoint returned HTML — service may be unavailable.');
        }
        return JSON.parse(text) as T;
      },
      {
        operation: `ComtradeReferenceService.fetchJson:${filename}`,
        baseDelayMs: 2000,
      },
    );
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
