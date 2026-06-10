/**
 * @fileoverview Regression tests for ComtradeDataService.fetchTradeData aggregation
 * filtering (issues #4 and #5) and EBOPS description lookup (issue #6).
 * @module tests/services/comtrade-data-service.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ComtradeDataService,
  type initComtradeDataService,
} from '@/services/comtrade-data/comtrade-data-service.js';
import {
  type ComtradeReferenceService,
  initComtradeReferenceService,
} from '@/services/comtrade-reference/comtrade-reference-service.js';

// ── Shared mock setup ─────────────────────────────────────────────────────────

const mockConfig = {} as Parameters<typeof initComtradeDataService>[0];
const mockStorage = {} as Parameters<typeof initComtradeDataService>[1];

function seedReferenceService(): ComtradeReferenceService {
  const svc = initComtradeReferenceService(mockConfig, mockStorage);
  // @ts-expect-error — seeding private map
  svc.hsByCode = new Map([
    [
      '10',
      { id: '10', text: '10 - Cereals', aggrLevel: 2, isLeaf: false, recommendedQueryCode: '10' },
    ],
    [
      '27',
      { id: '27', text: 'Mineral fuels', aggrLevel: 2, isLeaf: false, recommendedQueryCode: '27' },
    ],
  ]);
  // @ts-expect-error — seeding private map
  svc.ebopsByCode = new Map([
    ['1', { id: '1', text: '1 Manufacturing services on physical inputs owned by others' }],
    ['3', { id: '3', text: '3 Transport' }],
    ['10', { id: '10', text: '10 Other business services' }],
  ]);
  // @ts-expect-error — seeding private map
  svc.countriesByCode = new Map([
    [276, { id: 276, name: 'Germany', validAsReporter: true, isGroup: false }],
    [616, { id: 616, name: 'Poland', validAsReporter: true, isGroup: false }],
    [528, { id: 528, name: 'Netherlands', validAsReporter: true, isGroup: false }],
    [0, { id: 0, name: 'World', validAsReporter: false, isGroup: true }],
  ]);
  return svc;
}

/** Build a minimal raw trade response JSON string. */
function makeResponse(data: object[]): string {
  return JSON.stringify({ count: data.length, data });
}

/** Stub globalThis.fetch to return the given JSON body. */
function stubFetch(body: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => body,
    }),
  );
}

// ── #4 regression: world-aggregate inflation ──────────────────────────────────

/**
 * Multi-dimension raw rows as returned by the Comtrade preview API for a world
 * aggregate (partnerCode=0) query. The API returns 90 rows — one per (motCode ×
 * customsCode × partner2Code) combination. Only the mot=0/C00/p2=0 row is the
 * correct single total; all others are breakdowns whose values must not be summed.
 */
const WORLD_AGGREGATE_RAW_ROWS = [
  // Correct aggregate row — must be the only one kept
  {
    reporterCode: 276,
    reporterDesc: 'Germany',
    partnerCode: 0,
    partnerDesc: 'World',
    flowCode: 'X',
    cmdCode: 'TOTAL',
    cmdDesc: null,
    period: '2022',
    primaryValue: 1_695_806_689_768.824,
    motCode: 0,
    customsCode: 'C00',
    partner2Code: 0,
    isAggregate: true,
  },
  // Breakdown rows — different customs procedures
  {
    reporterCode: 276,
    partnerCode: 0,
    flowCode: 'X',
    cmdCode: 'TOTAL',
    period: '2022',
    primaryValue: 172_088_453.123,
    motCode: 9300,
    customsCode: 'C06',
    partner2Code: 899,
    isAggregate: true,
  },
  {
    reporterCode: 276,
    partnerCode: 0,
    flowCode: 'X',
    cmdCode: 'TOTAL',
    period: '2022',
    primaryValue: 450_000_000_000,
    motCode: 3200,
    customsCode: 'C03',
    partner2Code: 899,
    isAggregate: true,
  },
  {
    reporterCode: 276,
    partnerCode: 0,
    flowCode: 'X',
    cmdCode: 'TOTAL',
    period: '2022',
    primaryValue: 800_000_000_000,
    motCode: 1000,
    customsCode: 'C00',
    partner2Code: 899,
    isAggregate: true,
  },
];

// ── #5 regression: per-partner duplicate elimination ─────────────────────────

/**
 * Per-partner raw rows where Poland (616) appears with multiple dimension
 * combinations, replicating the duplicate-partner bug in comtrade_get_top_partners.
 */
const PER_PARTNER_RAW_ROWS = [
  // Netherlands — only one row variant (dominant row)
  {
    reporterCode: 276,
    partnerCode: 528,
    partnerDesc: 'Netherlands',
    flowCode: 'X',
    cmdCode: 'TOTAL',
    period: '2022',
    primaryValue: 111_470_457_115.123,
    motCode: 0,
    customsCode: 'C03',
    partner2Code: 0,
    isAggregate: true,
  },
  // Poland — two rows for the same partner (the bug scenario)
  {
    reporterCode: 276,
    partnerCode: 616,
    partnerDesc: 'Poland',
    flowCode: 'X',
    cmdCode: 'TOTAL',
    period: '2022',
    primaryValue: 97_504_955_206.207,
    motCode: 0,
    customsCode: 'C00',
    partner2Code: 0,
    isAggregate: true,
  },
  {
    reporterCode: 276,
    partnerCode: 616,
    partnerDesc: 'Poland',
    flowCode: 'X',
    cmdCode: 'TOTAL',
    period: '2022',
    primaryValue: 83_120_047_716.397,
    motCode: 3200,
    customsCode: 'C03',
    partner2Code: 899,
    isAggregate: true,
  },
  // World aggregate row — should be preserved but filtered out at tool level
  {
    reporterCode: 276,
    partnerCode: 0,
    partnerDesc: 'World',
    flowCode: 'X',
    cmdCode: 'TOTAL',
    period: '2022',
    primaryValue: 1_695_806_689_768.824,
    motCode: 0,
    customsCode: 'C00',
    partner2Code: 0,
    isAggregate: true,
  },
];

// ── #6 regression: EBOPS description lookup ───────────────────────────────────

/**
 * Services trade raw rows with null cmdDesc and numerically-colliding cmdCodes.
 * EBOPS code 10 = "Other business services"; HS code 10 = "Cereals".
 * The bug: service always used getHsCode(), returning "10 - Cereals" for EBOPS code 10.
 */
const SERVICES_RAW_ROWS = [
  {
    reporterCode: 276,
    partnerCode: 0,
    flowCode: 'X',
    cmdCode: '10',
    cmdDesc: null, // confirmed null in live API
    period: '2022',
    primaryValue: 50_000_000_000,
    motCode: 0,
    customsCode: 'C00',
    partner2Code: 0,
    classificationCode: 'EB10',
  },
  {
    reporterCode: 276,
    partnerCode: 0,
    flowCode: 'X',
    cmdCode: '3',
    cmdDesc: null,
    period: '2022',
    primaryValue: 30_000_000_000,
    motCode: 0,
    customsCode: 'C00',
    partner2Code: 0,
    classificationCode: 'EB10',
  },
  {
    reporterCode: 276,
    partnerCode: 0,
    flowCode: 'X',
    cmdCode: '1',
    cmdDesc: null,
    period: '2022',
    primaryValue: 10_000_000_000,
    motCode: 0,
    customsCode: 'C00',
    partner2Code: 0,
    classificationCode: 'EB10',
  },
];

// ── Test suites ───────────────────────────────────────────────────────────────

describe('ComtradeDataService.fetchTradeData', () => {
  let svc: ComtradeDataService;

  beforeEach(() => {
    vi.unstubAllGlobals();
    seedReferenceService();
    svc = new ComtradeDataService(mockConfig, mockStorage);
    // Silence retry delays in tests
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /**
   * Regression for #4: world-aggregate query (partnerCode=0) must return
   * exactly one record — the mot=0/C00/p2=0 row — not the sum of all 90
   * dimension-expanded rows.
   */
  describe('issue #4 — world-aggregate inflation', () => {
    it('filters to mot=0/C00/p2=0 row for world-aggregate query (partnerCode=0)', async () => {
      stubFetch(makeResponse(WORLD_AGGREGATE_RAW_ROWS));

      const result = await svc.fetchTradeData({
        reporterCode: 276,
        flowCode: 'X',
        period: '2022',
        partnerCode: 0,
        cmdCode: 'TOTAL',
      });

      expect(result.records).toHaveLength(1);
      expect(result.records[0]?.primaryValue).toBeCloseTo(1_695_806_689_768.824, 0);
    });

    it('does not sum multi-dimension breakdown rows when partnerCode=0', async () => {
      stubFetch(makeResponse(WORLD_AGGREGATE_RAW_ROWS));

      const result = await svc.fetchTradeData({
        reporterCode: 276,
        flowCode: 'X',
        period: '2022',
        partnerCode: 0,
        cmdCode: 'TOTAL',
      });

      // Inflated sum of all 4 fixture rows would be ~$2.247T; correct is ~$1.696T
      const sum = result.records.reduce((acc, r) => acc + (r.primaryValue ?? 0), 0);
      expect(sum).toBeCloseTo(1_695_806_689_768.824, 0);
    });
  });

  /**
   * Regression for #5: all-partners query (no partnerCode) must deduplicate
   * by partnerCode keeping max primaryValue, eliminating duplicate partner rows.
   */
  describe('issue #5 — per-partner duplicate elimination', () => {
    it('deduplicates Poland (616) to a single record by max primaryValue', async () => {
      stubFetch(makeResponse(PER_PARTNER_RAW_ROWS));

      const result = await svc.fetchTradeData({
        reporterCode: 276,
        flowCode: 'X',
        period: '2022',
        cmdCode: 'TOTAL',
        // no partnerCode — all-partners query
      });

      const polandRecords = result.records.filter((r) => r.partnerCode === 616);
      expect(polandRecords).toHaveLength(1);
      expect(polandRecords[0]?.primaryValue).toBeCloseTo(97_504_955_206.207, 0);
    });

    it('keeps the max-value row when a partner has multiple dimension variants', async () => {
      stubFetch(makeResponse(PER_PARTNER_RAW_ROWS));

      const result = await svc.fetchTradeData({
        reporterCode: 276,
        flowCode: 'X',
        period: '2022',
        cmdCode: 'TOTAL',
      });

      // Each partner code appears at most once
      const partnerCodes = result.records.map((r) => r.partnerCode);
      const unique = new Set(partnerCodes);
      expect(partnerCodes.length).toBe(unique.size);
    });

    it('Netherlands (528) is rank-1 by value after dedup', async () => {
      stubFetch(makeResponse(PER_PARTNER_RAW_ROWS));

      const result = await svc.fetchTradeData({
        reporterCode: 276,
        flowCode: 'X',
        period: '2022',
        cmdCode: 'TOTAL',
      });

      const nonWorld = result.records.filter((r) => r.partnerCode !== 0);
      const ranked = [...nonWorld].sort((a, b) => (b.primaryValue ?? 0) - (a.primaryValue ?? 0));
      expect(ranked[0]?.partnerCode).toBe(528);
      expect(ranked[0]?.primaryValue).toBeCloseTo(111_470_457_115.123, 0);
    });

    it('does NOT dedup when aggrLevel is set (commodity breakdown query — all rows kept)', async () => {
      // Two rows for Poland (616) with different cmdCodes — as in a commodity breakdown query.
      // Poland chapter 84 and chapter 87, same motCode/customsCode/partner2Code.
      const commodityBreakdownRows = [
        {
          reporterCode: 276,
          partnerCode: 616,
          partnerDesc: 'Poland',
          flowCode: 'X',
          cmdCode: '84',
          period: '2022',
          primaryValue: 97_000_000_000,
          motCode: 0,
          customsCode: 'C00',
          partner2Code: 0,
        },
        {
          reporterCode: 276,
          partnerCode: 616,
          partnerDesc: 'Poland',
          flowCode: 'X',
          cmdCode: '87',
          period: '2022',
          primaryValue: 45_000_000_000,
          motCode: 0,
          customsCode: 'C00',
          partner2Code: 0,
        },
      ];
      stubFetch(makeResponse(commodityBreakdownRows));

      const result = await svc.fetchTradeData({
        reporterCode: 276,
        flowCode: 'X',
        period: '2022',
        aggrLevel: 2,
        // no partnerCode, no cmdCode — commodity breakdown
      });

      // Both rows must survive — dedup must not fire for commodity breakdown queries
      const polandRecords = result.records.filter((r) => r.partnerCode === 616);
      expect(polandRecords).toHaveLength(2);
    });
  });

  /**
   * Regression for #6: services trade queries (typeCode='S') must look up
   * cmdDesc via EBOPS reference, not HS reference. EBOPS code 10 = "Other
   * business services"; HS code 10 = "Cereals".
   */
  describe('issue #6 — EBOPS description lookup', () => {
    it('resolves cmdCode=10 to EBOPS "Other business services" for typeCode=S', async () => {
      stubFetch(makeResponse(SERVICES_RAW_ROWS));

      const result = await svc.fetchTradeData({
        reporterCode: 276,
        flowCode: 'X',
        period: '2022',
        partnerCode: 0,
        typeCode: 'S',
        classificationCode: 'EB10',
      });

      const code10 = result.records.find((r) => r.cmdCode === '10');
      expect(code10?.cmdDesc).toBe('10 Other business services');
      expect(code10?.cmdDesc).not.toContain('Cereals');
    });

    it('resolves cmdCode=3 to EBOPS "Transport" for typeCode=S', async () => {
      stubFetch(makeResponse(SERVICES_RAW_ROWS));

      const result = await svc.fetchTradeData({
        reporterCode: 276,
        flowCode: 'X',
        period: '2022',
        partnerCode: 0,
        typeCode: 'S',
        classificationCode: 'EB10',
      });

      const code3 = result.records.find((r) => r.cmdCode === '3');
      expect(code3?.cmdDesc).toBe('3 Transport');
    });

    it('resolves cmdCode=1 to EBOPS manufacturing description for typeCode=S', async () => {
      stubFetch(makeResponse(SERVICES_RAW_ROWS));

      const result = await svc.fetchTradeData({
        reporterCode: 276,
        flowCode: 'X',
        period: '2022',
        partnerCode: 0,
        typeCode: 'S',
        classificationCode: 'EB10',
      });

      const code1 = result.records.find((r) => r.cmdCode === '1');
      expect(code1?.cmdDesc).toBe('1 Manufacturing services on physical inputs owned by others');
    });

    it('uses HS lookup for goods trade (typeCode=C or unset)', async () => {
      // A goods query with cmdCode=10 should get the HS description
      stubFetch(
        makeResponse([
          {
            reporterCode: 276,
            partnerCode: 0,
            flowCode: 'X',
            cmdCode: '10',
            cmdDesc: null,
            period: '2022',
            primaryValue: 1_000_000,
            motCode: 0,
            customsCode: 'C00',
            partner2Code: 0,
          },
        ]),
      );

      const result = await svc.fetchTradeData({
        reporterCode: 276,
        flowCode: 'X',
        period: '2022',
        partnerCode: 0,
        // typeCode defaults to 'C' (goods)
      });

      const code10 = result.records.find((r) => r.cmdCode === '10');
      expect(code10?.cmdDesc).toBe('10 - Cereals');
      expect(code10?.cmdDesc).not.toContain('Other business services');
    });

    it('services query does not apply dimension filtering (all rows kept)', async () => {
      stubFetch(makeResponse(SERVICES_RAW_ROWS));

      const result = await svc.fetchTradeData({
        reporterCode: 276,
        flowCode: 'X',
        period: '2022',
        partnerCode: 0,
        typeCode: 'S',
        classificationCode: 'EB10',
      });

      // All 3 fixture rows should survive — services data doesn't have dimension expansion
      expect(result.records).toHaveLength(3);
    });
  });
});
