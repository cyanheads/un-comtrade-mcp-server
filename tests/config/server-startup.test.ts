/**
 * @fileoverview Verifies server configuration fails before reference data is fetched.
 * @module tests/config/server-startup.test
 */

import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('rejects an invalid Comtrade API URL during startup', () => {
  const entry = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
  const probe = spawnSync('bun', [entry], {
    cwd: tmpdir(),
    env: {
      ...process.env,
      COMTRADE_API_BASE_URL: 'invalid-url',
      MCP_TRANSPORT_TYPE: 'stdio',
      MCP_LOG_LEVEL: 'silent',
      OTEL_ENABLED: 'false',
    },
    encoding: 'utf8',
    timeout: 10000,
  });
  expect(probe.error).toBeUndefined();
  expect(probe.status).toBe(1);
  expect(probe.stderr).toContain('COMTRADE_API_BASE_URL');
  expect(probe.stderr).toContain('Configuration error — server failed to start');
});
