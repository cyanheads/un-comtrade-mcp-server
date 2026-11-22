/**
 * @fileoverview Tests for the comtrade-hs-classification resource.
 * @module tests/resources/hs-classification.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hsClassificationResource } from '@/mcp-server/resources/definitions/hs-classification.resource.js';
import {
  type ComtradeReferenceService,
  initComtradeReferenceService,
} from '@/services/comtrade-reference/comtrade-reference-service.js';

const mockConfig = {} as Parameters<typeof initComtradeReferenceService>[0];
const mockStorage = {} as Parameters<typeof initComtradeReferenceService>[1];

function seedReferenceService(): ComtradeReferenceService {
  const svc = initComtradeReferenceService(mockConfig, mockStorage);
  // @ts-expect-error — seeding private map
  svc.hsByCode = new Map([
    [
      '84',
      {
        id: '84',
        text: 'Machinery',
        aggrLevel: 2 as const,
        isLeaf: false,
        recommendedQueryCode: '84',
      },
    ],
    [
      '09',
      {
        id: '09',
        text: 'Coffee, tea, spices',
        aggrLevel: 2 as const,
        isLeaf: false,
        recommendedQueryCode: '09',
      },
    ],
    [
      '8471',
      {
        id: '8471',
        text: 'Automatic data processing machines',
        aggrLevel: 4 as const,
        parent: '84',
        isLeaf: false,
        recommendedQueryCode: '8471',
      },
    ],
    [
      '847130',
      {
        id: '847130',
        text: 'Portable ADP machines, weight not more than 10 kg',
        aggrLevel: 6 as const,
        parent: '8471',
        isLeaf: true,
        recommendedQueryCode: '847130',
      },
    ],
  ]);
  return svc;
}

describe('hsClassificationResource', () => {
  beforeEach(() => {
    seedReferenceService();
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockImplementation(async () =>
          Response.json({ results: [{ id: '84', text: 'Machinery' }] }),
        ),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it('tags the hierarchy from shared edition catalogs and caches completed loads', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const file = new URL(String(input)).pathname.split('/').at(-1);
      return Response.json({
        results: [
          { id: '84', text: 'Machinery' },
          { id: '8471', text: 'Machines', parent: '84' },
          ...(file === 'H6.json' ? [] : [{ id: '847130', text: 'Portable', parent: '8471' }]),
        ],
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const read = async (level: string) =>
      hsClassificationResource.output.parse(
        await hsClassificationResource.handler({ level }, createMockContext()),
      );
    expect((await read('2')).codes).toEqual([
      {
        id: '84',
        description: 'Machinery',
        isLeaf: false,
        editions: ['H0', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'],
      },
      { id: '09', description: 'Coffee, tea, spices', isLeaf: false, editions: [] },
    ]);
    expect((await read('4')).codes[0]).toMatchObject({
      id: '8471',
      parent: '84',
      editions: ['H0', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'],
    });
    expect((await read('6')).codes[0]).toEqual({
      id: '847130',
      description: 'Portable ADP machines, weight not more than 10 kg',
      parent: '8471',
      isLeaf: true,
      editions: ['H0', 'H1', 'H2', 'H3', 'H4', 'H5'],
    });
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it('returns HS chapter-level codes at level 2', async () => {
    const ctx = createMockContext();
    const params = hsClassificationResource.params.parse({ level: '2' });
    const result = await hsClassificationResource.handler(params, ctx);
    expect(result.level).toBe(2);
    expect(result.codes.every((c) => c.id.length === 2)).toBe(true);
    expect(result.totalCount).toBe(2);
  });

  it('returns HS heading codes at level 4', async () => {
    const ctx = createMockContext();
    const params = hsClassificationResource.params.parse({ level: '4' });
    const result = await hsClassificationResource.handler(params, ctx);
    expect(result.level).toBe(4);
    expect(result.codes).toHaveLength(1);
    expect(result.codes[0]?.id).toBe('8471');
    expect(result.codes[0]?.parent).toBe('84');
  });

  it('returns HS subheading codes at level 6', async () => {
    const ctx = createMockContext();
    const params = hsClassificationResource.params.parse({ level: '6' });
    const result = await hsClassificationResource.handler(params, ctx);
    expect(result.level).toBe(6);
    expect(result.codes).toHaveLength(1);
    expect(result.codes[0]?.id).toBe('847130');
    expect(result.codes[0]?.isLeaf).toBe(true);
  });

  it.each(['3', 'invalid'])(
    'rejects an invalid level %s without fetching editions',
    async (level) => {
      await expect(
        hsClassificationResource.handler({ level }, createMockContext()),
      ).rejects.toMatchObject({ data: { requestedLevel: level } });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('omits parent field for chapter fixtures with no parent', async () => {
    const ctx = createMockContext();
    const params = hsClassificationResource.params.parse({ level: '2' });
    const result = await hsClassificationResource.handler(params, ctx);
    expect(result.codes.every((c) => c.parent === undefined)).toBe(true);
  });

  it('excludes the level-0 TOTAL from every level, leaving the other codes unchanged', async () => {
    const svc = seedReferenceService();
    // @ts-expect-error — seeding private map
    svc.hsByCode.set('TOTAL', {
      id: 'TOTAL',
      text: 'Total - All H6 commodities',
      parent: '#',
      aggrLevel: 0,
      isLeaf: false,
      recommendedQueryCode: 'TOTAL',
    });
    for (const [level, ids] of [
      ['2', ['84', '09']],
      ['4', ['8471']],
      ['6', ['847130']],
    ] as const) {
      const result = await hsClassificationResource.handler(
        hsClassificationResource.params.parse({ level }),
        createMockContext(),
      );
      expect(result.codes.map((code) => code.id)).toEqual(ids);
      expect(result.totalCount).toBe(ids.length);
    }
  });

  it('omits tags on failed or empty catalogs and retries only the unavailable editions', async () => {
    let recovered = false;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const file = new URL(String(input)).pathname.split('/').at(-1);
      if (!recovered && file === 'H0.json') return new Response('missing', { status: 404 });
      return Response.json({
        results: !recovered && file === 'H6.json' ? [] : [{ id: '8471', text: 'Machines' }],
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const read = async () =>
      hsClassificationResource.output.parse(
        await hsClassificationResource.handler({ level: '4' }, createMockContext()),
      );
    const first = await read();
    expect(first.codes).toEqual([
      {
        id: '8471',
        description: 'Automatic data processing machines',
        parent: '84',
        isLeaf: false,
      },
    ]);
    expect(first.referenceNotice).toContain('H0, H6');
    expect(fetchMock).toHaveBeenCalledTimes(7);
    recovered = true;
    const second = await read();
    expect(second.codes[0]?.editions).toEqual(['H0', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
    expect(second).not.toHaveProperty('referenceNotice');
    expect(fetchMock).toHaveBeenCalledTimes(9);
  });

  it('propagates cancellation during a cold edition load', async () => {
    const controller = new AbortController();
    const reason = new DOMException('Skip hierarchy read', 'AbortError');
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockImplementation(async () => {
        controller.abort(reason);
        throw reason;
      }),
    );
    await expect(
      hsClassificationResource.handler(
        { level: '6' },
        createMockContext({ signal: controller.signal }),
      ),
    ).rejects.toBe(reason);
  });

  it('list() returns resource descriptors for all three levels', () => {
    const listing = hsClassificationResource.list!();
    expect(listing.resources).toHaveLength(3);
    const uris = listing.resources.map((r) => r.uri);
    expect(uris).toContain('comtrade://hs-classification/2');
    expect(uris).toContain('comtrade://hs-classification/4');
    expect(uris).toContain('comtrade://hs-classification/6');
    for (const r of listing.resources) {
      // resources/list entries carry a title only when the entry sets one.
      expect(r).toHaveProperty('title', 'Comtrade HS Classification');
      expect(r).toHaveProperty('name');
      expect(r).toHaveProperty('mimeType');
      expect(r).toHaveProperty('description');
    }
  });
});
