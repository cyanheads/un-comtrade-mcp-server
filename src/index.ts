#!/usr/bin/env node
/**
 * @fileoverview un-comtrade-mcp-server MCP server entry point.
 * Provides structured access to UN Comtrade international trade statistics via MCP.
 * @module index
 */

import { fileURLToPath } from 'node:url';
import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from './config/server-config.js';
import { countriesResource } from './mcp-server/resources/definitions/countries.resource.js';
import { hsClassificationResource } from './mcp-server/resources/definitions/hs-classification.resource.js';
import { getDataAvailabilityTool } from './mcp-server/tools/definitions/get-data-availability.tool.js';
import { getServicesTradeTool } from './mcp-server/tools/definitions/get-services-trade.tool.js';
import { getTopCommoditiesTool } from './mcp-server/tools/definitions/get-top-commodities.tool.js';
import { getTopPartnersTool } from './mcp-server/tools/definitions/get-top-partners.tool.js';
import { getTradeBalanceTool } from './mcp-server/tools/definitions/get-trade-balance.tool.js';
import { getTradeFlowsTool } from './mcp-server/tools/definitions/get-trade-flows.tool.js';
import { listServiceCategoriesTool } from './mcp-server/tools/definitions/list-service-categories.tool.js';
import { lookupCountriesTool } from './mcp-server/tools/definitions/lookup-countries.tool.js';
import { searchCommoditiesTool } from './mcp-server/tools/definitions/search-commodities.tool.js';
import {
  getComtradeDataService,
  initComtradeDataService,
} from './services/comtrade-data/comtrade-data-service.js';
import { initComtradeMetaService } from './services/comtrade-meta/comtrade-meta-service.js';
import { initComtradeReferenceService } from './services/comtrade-reference/comtrade-reference-service.js';

await createApp({
  name: 'un-comtrade-mcp-server',
  title: 'un-comtrade-mcp-server',
  /**
   * Every tool is a single-round read of the UN Comtrade API or of reference data held in
   * memory — nothing calls `ctx.requestInput`, so no handler needs a session to come back to.
   * Declared here rather than left to `MCP_SESSION_MODE` alone so the posture travels with the
   * code to any deployment that does not set the variable; where it is set (Dockerfile,
   * `.env.example`) it still wins, and the schema default of `auto` — which resolves to
   * `stateful` — is no longer what an unconfigured host falls back to.
   */
  sessionMode: 'stateless',
  tools: [
    lookupCountriesTool,
    searchCommoditiesTool,
    listServiceCategoriesTool,
    getTradeFlowsTool,
    getTradeBalanceTool,
    getTopPartnersTool,
    getTopCommoditiesTool,
    getDataAvailabilityTool,
    getServicesTradeTool,
  ],
  resources: [countriesResource, hsClassificationResource],
  prompts: [],
  skills: fileURLToPath(new URL('../skills/', import.meta.url)),

  instructions:
    'UN Comtrade international goods and services trade statistics. Resolve country names with comtrade_lookup_countries, goods with comtrade_search_commodities, and services with comtrade_list_service_categories; check comtrade_get_data_availability before interpreting missing data. Reporter and partner identifiers are Comtrade numeric codes, not inferred ISO numbers. Keyless preview uses paced requests with a 500-record cap per upstream response; inspect coverage, truncation, and unserved-input fields such as unservedPeriods before drawing conclusions. Configure COMTRADE_SUBSCRIPTION_KEY for authenticated access subject to subscription limits. Load un-comtrade-guide for historical classifications, complete rankings, bilateral and mirror analysis, and unit-value interpretation.',

  async setup(core) {
    getServerConfig();
    // Initialize reference service first — data/meta services depend on it for name lookups
    const refService = initComtradeReferenceService(core.config, core.storage);
    await refService.initialize();

    initComtradeDataService(core.config, core.storage);
    initComtradeMetaService(core.config, core.storage);

    core.logger.info(
      `Comtrade reference data loaded. countries=${refService.getAllCountries().length} ` +
        `hsCodes=${refService.getAllHsCodes().length}`,
    );
  },
  teardown() {
    getComtradeDataService().dispose();
  },
});
