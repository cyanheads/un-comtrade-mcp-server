/**
 * @fileoverview Tests for the comtrade-hs-classification resource.
 * @module tests/resources/hs-classification.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
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
  });

  it('returns HS chapter-level codes at level 2', () => {
    const ctx = createMockContext();
    const params = hsClassificationResource.params.parse({ level: '2' });
    const result = hsClassificationResource.handler(params, ctx);
    expect(result.level).toBe(2);
    expect(result.codes.every((c) => c.id.length === 2)).toBe(true);
    expect(result.totalCount).toBe(2);
  });

  it('returns HS heading codes at level 4', () => {
    const ctx = createMockContext();
    const params = hsClassificationResource.params.parse({ level: '4' });
    const result = hsClassificationResource.handler(params, ctx);
    expect(result.level).toBe(4);
    expect(result.codes).toHaveLength(1);
    expect(result.codes[0]?.id).toBe('8471');
    expect(result.codes[0]?.parent).toBe('84');
  });

  it('returns HS subheading codes at level 6', () => {
    const ctx = createMockContext();
    const params = hsClassificationResource.params.parse({ level: '6' });
    const result = hsClassificationResource.handler(params, ctx);
    expect(result.level).toBe(6);
    expect(result.codes).toHaveLength(1);
    expect(result.codes[0]?.id).toBe('847130');
    expect(result.codes[0]?.isLeaf).toBe(true);
  });

  it('throws for invalid level', () => {
    const ctx = createMockContext();
    const params = hsClassificationResource.params.parse({ level: '3' });
    expect(() => hsClassificationResource.handler(params, ctx)).toThrow();
  });

  it('throws for non-numeric level', () => {
    const ctx = createMockContext();
    const params = hsClassificationResource.params.parse({ level: 'invalid' });
    expect(() => hsClassificationResource.handler(params, ctx)).toThrow();
  });

  it('omits parent field for top-level codes', () => {
    const ctx = createMockContext();
    const params = hsClassificationResource.params.parse({ level: '2' });
    const result = hsClassificationResource.handler(params, ctx);
    // All chapter codes (level 2) should not have a parent
    expect(result.codes.every((c) => c.parent === undefined)).toBe(true);
  });

  it('list() returns resource descriptors for all three levels', () => {
    const listing = hsClassificationResource.list!();
    expect(listing.resources).toHaveLength(3);
    const uris = listing.resources.map((r) => r.uri);
    expect(uris).toContain('comtrade://hs-classification/2');
    expect(uris).toContain('comtrade://hs-classification/4');
    expect(uris).toContain('comtrade://hs-classification/6');
    for (const r of listing.resources) {
      expect(r).toHaveProperty('name');
      expect(r).toHaveProperty('mimeType');
      expect(r).toHaveProperty('description');
    }
  });
});
