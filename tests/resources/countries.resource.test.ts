/**
 * @fileoverview Tests for the comtrade-countries resource.
 * @module tests/resources/countries.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { countriesResource } from '@/mcp-server/resources/definitions/countries.resource.js';
import {
  type ComtradeReferenceService,
  initComtradeReferenceService,
} from '@/services/comtrade-reference/comtrade-reference-service.js';

const mockConfig = {} as Parameters<typeof initComtradeReferenceService>[0];
const mockStorage = {} as Parameters<typeof initComtradeReferenceService>[1];

function seedReferenceService(): ComtradeReferenceService {
  const svc = initComtradeReferenceService(mockConfig, mockStorage);
  // @ts-expect-error — seeding private map
  svc.countriesByCode = new Map([
    [
      840,
      {
        id: 840,
        name: 'United States of America',
        iso3: 'USA',
        iso2: 'US',
        validAsReporter: true,
        isGroup: false,
      },
    ],
    [
      276,
      {
        id: 276,
        name: 'Germany',
        iso3: 'DEU',
        iso2: 'DE',
        validAsReporter: true,
        isGroup: false,
      },
    ],
    [
      0,
      {
        id: 0,
        name: 'World',
        iso3: undefined,
        iso2: undefined,
        validAsReporter: false,
        isGroup: true,
      },
    ],
  ]);
  return svc;
}

describe('countriesResource', () => {
  beforeEach(() => {
    seedReferenceService();
  });

  it('returns all countries sorted by name', () => {
    const ctx = createMockContext();
    const params = countriesResource.params.parse({});
    const result = countriesResource.handler(params, ctx);
    expect(result.totalCount).toBe(3);
    expect(result.countries).toHaveLength(3);
    // Sorted by name: Germany, United States, World
    const names = result.countries.map((c) => c.name);
    expect(names).toEqual([...names].sort());
  });

  it('includes required fields for each country', () => {
    const ctx = createMockContext();
    const params = countriesResource.params.parse({});
    const result = countriesResource.handler(params, ctx);
    for (const c of result.countries) {
      expect(c).toHaveProperty('id');
      expect(c).toHaveProperty('name');
      expect(c).toHaveProperty('validAsReporter');
      expect(c).toHaveProperty('isGroup');
    }
  });

  it('includes ISO codes when available, omits when absent', () => {
    const ctx = createMockContext();
    const params = countriesResource.params.parse({});
    const result = countriesResource.handler(params, ctx);
    const usa = result.countries.find((c) => c.id === 840);
    expect(usa?.iso3).toBe('USA');
    expect(usa?.iso2).toBe('US');

    const world = result.countries.find((c) => c.id === 0);
    expect(world?.iso3).toBeUndefined();
    expect(world?.iso2).toBeUndefined();
  });

  it('correctly marks validAsReporter and isGroup', () => {
    const ctx = createMockContext();
    const params = countriesResource.params.parse({});
    const result = countriesResource.handler(params, ctx);

    const usa = result.countries.find((c) => c.id === 840);
    expect(usa?.validAsReporter).toBe(true);
    expect(usa?.isGroup).toBe(false);

    const world = result.countries.find((c) => c.id === 0);
    expect(world?.validAsReporter).toBe(false);
    expect(world?.isGroup).toBe(true);
  });

  it('list() returns the static resource descriptor', () => {
    const listing = countriesResource.list!();
    expect(listing.resources).toHaveLength(1);
    expect(listing.resources[0]?.uri).toBe('comtrade://countries');
    expect(listing.resources[0]).toHaveProperty('name');
    expect(listing.resources[0]).toHaveProperty('mimeType');
  });
});
