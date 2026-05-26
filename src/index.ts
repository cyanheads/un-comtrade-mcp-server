#!/usr/bin/env node
/**
 * @fileoverview un-comtrade-mcp-server MCP server entry point.
 * Provides structured access to UN Comtrade international trade statistics via MCP.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
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
import { initComtradeDataService } from './services/comtrade-data/comtrade-data-service.js';
import { initComtradeMetaService } from './services/comtrade-meta/comtrade-meta-service.js';
import { initComtradeReferenceService } from './services/comtrade-reference/comtrade-reference-service.js';

await createApp({
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

  instructions:
    'UN Comtrade international trade statistics server. ' +
    'Typical workflow: (1) comtrade_lookup_countries to resolve country names to M49 codes, ' +
    '(2) comtrade_search_commodities to find HS codes by keyword, ' +
    '(3) comtrade_get_data_availability to verify data exists for the target period, ' +
    '(4) comtrade_get_trade_flows for raw bilateral records or a workflow tool (balance, top_partners, top_commodities). ' +
    'Free-tier: 500 records/call, 500 requests/day. Set COMTRADE_SUBSCRIPTION_KEY for full access. ' +
    'Data redistribution is prohibited per the UN Comtrade license — local deployment only.',

  async setup(core) {
    // Initialize reference service first — data/meta services depend on it for name lookups
    const refService = initComtradeReferenceService(core.config, core.storage);
    await refService.initialize();

    initComtradeDataService(core.config, core.storage);
    initComtradeMetaService(core.config, core.storage);

    const countryCount = refService.getAllCountries().length;
    const hsCount = refService.getAllHsCodes().length;
    core.logger.info(
      `Comtrade reference data loaded. countries=${countryCount} hsCodes=${hsCount}`,
    );
  },
});
