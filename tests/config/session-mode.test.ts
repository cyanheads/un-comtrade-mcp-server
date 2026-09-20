/**
 * @fileoverview Pins the session posture to `stateless` on every surface that sets it.
 * `MCP_SESSION_MODE` defaults to `auto`, which resolves to `stateful`, so a surface that
 * omits the variable silently disagrees with one that sets it — the container and a source
 * run then serve different modes with nothing failing. No tool here calls
 * `ctx.requestInput`, so no handler needs a session to come back to and `stateless` is
 * correct everywhere. Stdio and 2026-07-28 HTTP clients behave identically under either
 * mode, so an end-to-end smoke test cannot catch a split; the declared configuration is
 * what has to be asserted.
 * @module tests/config/session-mode.test
 */

import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';

const { createApp } = vi.hoisted(() => ({ createApp: vi.fn() }));
vi.mock('@cyanheads/mcp-ts-core', async (original) => ({
  ...(await original<object>()),
  createApp,
}));

const read = (file: string) => readFileSync(file, 'utf-8');

it('createApp declares stateless in src/, the durable form', async () => {
  await import('@/index.js');
  expect(createApp.mock.calls[0]?.[0].sessionMode).toBe('stateless');
});

it('the Dockerfile sets it explicitly, restating the declared default', () => {
  expect(read('Dockerfile')).toContain('ENV MCP_SESSION_MODE="stateless"');
});

it('.env.example sets it uncommented, so a copied .env resolves the same way', () => {
  const line = read('.env.example')
    .split('\n')
    .find((l) => /^\s*MCP_SESSION_MODE\s*=/.test(l));
  expect(line).toBeDefined();
  expect(line).toMatch(/^MCP_SESSION_MODE=stateless\b/);
});

it('.env.example documents all three accepted values and the real schema default', () => {
  const env = read('.env.example');
  expect(env).toContain('auto | stateful | stateless');
  expect(env).toMatch(/default: auto, which resolves to stateful/);
});

it('the README configuration table carries a row for it', () => {
  expect(read('README.md')).toMatch(/^\| `MCP_SESSION_MODE` \|/m);
});
