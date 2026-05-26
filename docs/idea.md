# un-comtrade-mcp-server

UN Comtrade — international trade statistics: imports, exports, and trade balances between countries by commodity.

## API

- **Base**: `https://comtradeapi.un.org/` (new API, replaced legacy)
- **Auth**: Free tier available (subscription key via https://comtradeplus.un.org/)
- **Rate limits**: Free tier — 500 requests/day, 100 records per call. Premium unlocks bulk and higher limits.
- **Docs**: https://comtradeapi.un.org/files/v1/app/reference/ListofReferences.json
- **Portal**: https://comtradeplus.un.org/

## Key data

- **Goods trade**: Bilateral trade flows (reporter → partner) by HS commodity code, year
- **Services trade**: Service trade by category (BPM6 classification)
- **Tariff lines**: Detailed commodity classification (6-digit HS, national tariff lines)
- **Coverage**: 200+ countries/areas, 1962–present for goods
- **Classifications**: HS (Harmonized System), SITC, BEC commodity codes

## Cross-domain value

| Chain to | Query |
|---|---|
| World Bank | Trade flows → GDP, development indicators by country |
| Eurostat | EU-specific trade statistics cross-reference |
| SEC EDGAR | Import/export exposure → public company supply chain risk |
| Congress | Trade bills, tariff legislation |
| BLS | Import competition → domestic employment by industry |
| EIA Energy | Energy commodity trade flows (oil, gas, coal) |
| Census | US-specific trade data cross-reference |
| GBIF | Commodity origin countries → biodiversity impact of trade |

## Tool ideas

- `comtrade_search_commodities` — find HS codes by keyword or description
- `comtrade_get_trade_data` — bilateral trade flows with filters (reporter, partner, commodity, year)
- `comtrade_get_trade_summary` — aggregated trade statistics for a country
- `comtrade_compare_partners` — trade balance comparison across trading partners
- `comtrade_get_trends` — trade flow time series for a commodity/country pair
- `comtrade_search_services` — service trade data by category

## Licensing (audited 2026-05-25)

- **Status: BLOCKED — redistribution prohibited without written UN permission**
- License agreement §5: "any copying, automated browsing or downloading, redistribution, publication, or commercial exploitation of any material...is strictly prohibited without the prior written permission of the United Nations"
- Source: https://comtradeplus.un.org/LicenseAgreement
- Hosting as an MCP proxy = redistribution under this clause
- **Path forward**: email comtrade@un.org requesting permission for an open-source MCP server, OR build for local-only use where the user provides their own Comtrade subscription key (data flows user → UN → user, no redistribution by us)

## Notes

- API was recently overhauled (legacy api.comtrade.un.org → comtradeapi.un.org) — use the new one
- HS code classification is hierarchical (2/4/6 digit) — tool search should handle keyword-to-code resolution
- Tariff/trade war analysis chains naturally to Congress + SEC EDGAR
- Existing archived `uncomtrade` server predates mcp-ts-core — this is a clean rebuild
