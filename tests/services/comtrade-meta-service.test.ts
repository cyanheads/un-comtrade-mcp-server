/**
 * @fileoverview Metadata classification defaults and release date mapping regressions.
 * @module tests/services/comtrade-meta-service.test
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ComtradeMetaService } from '@/services/comtrade-meta/comtrade-meta-service.js';
import { initComtradeReferenceService } from '@/services/comtrade-reference/comtrade-reference-service.js';

const config = {} as ConstructorParameters<typeof ComtradeMetaService>[0];
const storage = {} as ConstructorParameters<typeof ComtradeMetaService>[1];
beforeEach(() => {
  initComtradeReferenceService(config, storage);
});
afterEach(() => vi.unstubAllGlobals());
it('characterizes explicit classification forwarding and sparse metadata', async () => {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ data: [{ period: 2022 }] }));
  vi.stubGlobal('fetch', fetchMock);
  const rows = await new ComtradeMetaService(config, storage).getDataAvailability({
    typeCode: 'S',
    classificationCode: 'EB02',
  });
  expect(String(fetchMock.mock.calls[0]![0])).toContain('/S/A/EB02');
  expect(rows[0]).toMatchObject({ period: '2022', classificationCode: 'EB02', typeCode: 'S' });
});
it.each([
  ['C', undefined, 'HS'],
  ['C', '', 'HS'],
  ['S', undefined, 'EB10'],
  ['S', '', 'EB10'],
] as const)('defaults %s/%s to %s', async (typeCode, classificationCode, expected) => {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [] }));
  vi.stubGlobal('fetch', fetchMock);
  await new ComtradeMetaService(config, storage).getDataAvailability({
    typeCode,
    classificationCode,
  });
  expect(String(fetchMock.mock.calls[0]![0])).toContain(`/${typeCode}/A/${expected}`);
});
it('preserves independent release dates and omits absent dates', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: [
          { firstReleased: '2023-03-09T19:23:39.45', lastReleased: '2024-04-01' },
          { firstReleased: '2023-03-09' },
          { lastReleased: '2024-04-01' },
          {},
        ],
      }),
    ),
  );
  const rows = await new ComtradeMetaService(config, storage).getDataAvailability({});
  expect(rows[0]).toMatchObject({
    firstReleased: '2023-03-09T19:23:39.45',
    lastReleased: '2024-04-01',
  });
  expect(rows[1]).not.toHaveProperty('lastReleased');
  expect(rows[1]?.firstReleased).toBe('2023-03-09');
  expect(rows[2]).not.toHaveProperty('firstReleased');
  expect(rows[2]?.lastReleased).toBe('2024-04-01');
  expect(rows[3]).not.toHaveProperty('firstReleased');
  expect(rows[3]).not.toHaveProperty('lastReleased');
  expect(rows[0]).not.toHaveProperty('publicationDate');
});
