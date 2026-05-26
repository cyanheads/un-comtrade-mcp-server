/**
 * @fileoverview Server-specific environment variable configuration for un-comtrade-mcp-server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  subscriptionKey: z
    .string()
    .optional()
    .describe(
      'Azure API Management subscription key from comtradedeveloper.un.org. ' +
        'Without it, tools fall back to the public preview endpoint (500-record cap).',
    ),
  apiBaseUrl: z
    .string()
    .url()
    .default('https://comtradeapi.un.org')
    .describe('Base URL for the UN Comtrade API. Override for testing or alternate deployments.'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/** Lazy-parsed server config from environment variables. Throws ConfigurationError on invalid values. */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    subscriptionKey: 'COMTRADE_SUBSCRIPTION_KEY',
    apiBaseUrl: 'COMTRADE_API_BASE_URL',
  });
  return _config;
}
