/**
 * @fileoverview Comtrade metadata/availability service. Wraps the public/v1/getDA
 * endpoint to check which reporter/period/classification combinations have published data.
 * @module services/comtrade-meta/comtrade-meta-service
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, requestContextService, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { getComtradeReferenceService } from '@/services/comtrade-reference/comtrade-reference-service.js';
import type { DataAvailabilityRecord, RawAvailabilityResponse } from './types.js';

const FETCH_TIMEOUT_MS = 30_000;

export interface DataAvailabilityParams {
  classificationCode?: string;
  freqCode?: 'A' | 'M';
  period?: string;
  reporterCode?: number;
  typeCode?: 'C' | 'S';
}

/** Queries data availability from the Comtrade API. */
export class ComtradeMetaService {
  // biome-ignore lint/complexity/noUselessConstructor: params reserved for future use
  constructor(_config: AppConfig, _storage: StorageService) {}

  /** Check data availability for a reporter/period/classification combination. */
  async getDataAvailability(
    params: DataAvailabilityParams,
    signal?: AbortSignal,
  ): Promise<DataAvailabilityRecord[]> {
    const serverConfig = getServerConfig();
    const baseUrl = serverConfig.apiBaseUrl;

    const typeCode = params.typeCode ?? 'C';
    const freqCode = params.freqCode ?? 'A';
    const classCode = params.classificationCode ?? 'HS';

    const endpoint = `${baseUrl}/public/v1/getDA/${typeCode}/${freqCode}/${classCode}`;

    const queryParams = new URLSearchParams();
    if (params.reporterCode !== undefined) {
      queryParams.set('reporterCode', String(params.reporterCode));
    }
    if (params.period) {
      queryParams.set('period', params.period);
    }

    const qs = queryParams.toString();
    const url = qs ? `${endpoint}?${qs}` : endpoint;

    const raw = await withRetry(
      async () => {
        const headers: Record<string, string> = serverConfig.subscriptionKey
          ? { 'Ocp-Apim-Subscription-Key': serverConfig.subscriptionKey }
          : {};
        const fetchCtx = requestContextService.createRequestContext({
          operation: 'ComtradeMetaService.getDataAvailability',
        });
        const fetchOpts = { headers, ...(signal && { signal }) };
        const response = await fetchWithTimeout(url, FETCH_TIMEOUT_MS, fetchCtx, fetchOpts);
        const text = await response.text();
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw new Error('Comtrade metadata API returned HTML — service may be unavailable.');
        }
        return JSON.parse(text) as RawAvailabilityResponse;
      },
      {
        operation: 'ComtradeMetaService.getDataAvailability',
        baseDelayMs: 1500,
        ...(signal && { signal }),
      },
    );

    const rows = raw.data ?? [];
    const ref = getComtradeReferenceService();

    return rows.map((row) => {
      const reporterEntry =
        typeof row.reporterCode === 'number' ? ref.getCountryByCode(row.reporterCode) : undefined;
      return {
        reporterCode: row.reporterCode ?? 0,
        reporterDesc: row.reporterDesc || reporterEntry?.name || String(row.reporterCode ?? ''),
        period: String(row.period ?? ''),
        freqCode: row.freqCode ?? freqCode,
        classificationCode: row.classificationCode ?? classCode,
        typeCode: row.typeCode ?? typeCode,
        ...(row.totalRecords != null && { totalRecords: row.totalRecords }),
        ...(row.publicationDate && { publicationDate: row.publicationDate }),
      };
    });
  }
}

let _service: ComtradeMetaService | undefined;

/** Initialize the meta service. Call once from createApp() setup(). */
export function initComtradeMetaService(config: AppConfig, storage: StorageService): void {
  _service = new ComtradeMetaService(config, storage);
}

/** Access the initialized meta service. Throws if not initialized. */
export function getComtradeMetaService(): ComtradeMetaService {
  if (!_service) {
    throw new Error(
      'ComtradeMetaService not initialized — call initComtradeMetaService() in setup()',
    );
  }
  return _service;
}
