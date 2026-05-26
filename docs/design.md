# UN Comtrade — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `comtrade_lookup_countries` | Resolve country and area names to Comtrade numeric codes used in all data queries. Accepts a partial name or ISO alpha-2/alpha-3 code. Returns matching entries with their numeric M49 code, ISO identifiers, and a `validAsReporter` flag — not all partner areas (e.g., regional groupings) are valid reporter codes. Use this before any trade data tool that requires `reporter_code` or `partner_code`. To aggregate across all partners, use partner code `0` (World) — no lookup needed. | `query: string`, `role?: "reporter"\|"partner"\|"any"`, `include_groups?: boolean` | `readOnlyHint`, `openWorldHint: false` |
| `comtrade_search_commodities` | Find HS commodity codes by keyword, partial description, or known code prefix. Returns matched codes at the requested aggregation level (2-, 4-, or 6-digit) with full descriptions, parent code, leaf status, and a `recommended_query_code` field indicating the best code level for subsequent trade queries (2-digit chapter for broad analysis, 4- or 6-digit for specific products). The critical resolution step — agents cannot derive HS codes from product names without this tool. Use `aggr_level: 2` to start broad; narrow with `aggr_level: 4` or `6` once you have a chapter. | `query: string`, `classification?: "HS"\|"H0"–"H6"`, `aggr_level?: 2\|4\|6` | `readOnlyHint`, `openWorldHint: false` |
| `comtrade_get_trade_flows` | Fetch bilateral trade flow records — the primary data retrieval tool. Returns trade value in USD (`primaryValue` — FOB for exports, CIF for imports), quantity, net weight, and period/commodity/partner metadata for each row. Accepts multiple periods and commodity codes per call; pass `partner_code: 0` to get totals aggregated across all partners. Free-tier capped at 500 records per call. | `reporter_code: number`, `flow_code: "M"\|"X"\|"RX"\|"RM"`, `period: string[]`, `partner_code?: number`, `cmd_code?: string[]`, `classification?: string`, `freq?: "A"\|"M"` | `readOnlyHint` |
| `comtrade_get_trade_balance` | Compute the trade balance for a country over one or more periods — total exports minus total imports — with optional commodity filter. Fetches export and import totals in parallel and returns the signed balance (USD), export value, import value, and coverage ratio. Note: mirror asymmetry is common — balance reflects values as reported by this country. | `reporter_code: number`, `period: string[]`, `cmd_code?: string[]`, `classification?: string` | `readOnlyHint` |
| `comtrade_get_top_partners` | Rank trading partners for a reporter by trade value for a given commodity and flow direction. Returns the top N partners sorted by descending value — answers "who does country X mainly export product Y to?" for a single period. | `reporter_code: number`, `flow_code: "M"\|"X"`, `period: string`, `cmd_code?: string`, `limit?: number` | `readOnlyHint` |
| `comtrade_get_top_commodities` | Rank commodity categories for a reporter by trade value for a given flow direction and period. Returns the top N HS chapters (2-digit) or headings (4-digit) sorted by descending value — answers "what does country X mainly export/import?" Symmetric counterpart to `comtrade_get_top_partners`. | `reporter_code: number`, `flow_code: "M"\|"X"`, `period: string`, `aggr_level?: 2\|4`, `partner_code?: number`, `limit?: number` | `readOnlyHint` |
| `comtrade_get_data_availability` | Check which reporter/period/classification combinations have published data before constructing expensive queries. Returns dataset records with period, classification, record count, and publication date. Call this before querying recent periods — annual data is typically published 3–12 months after the reference year. | `reporter_code?: number`, `period?: string`, `freq?: "A"\|"M"`, `type_code?: "C"\|"S"`, `classification?: string` | `readOnlyHint`, `openWorldHint: false` |
| `comtrade_get_services_trade` | Fetch international trade-in-services data (EBOPS 2010 classification). Same bilateral structure as goods trade: returns flow value in USD, period, and reporter/partner/category metadata. Use `comtrade_list_service_categories` to find the right service code before querying. | `reporter_code: number`, `flow_code: "M"\|"X"`, `period: string[]`, `partner_code?: number`, `service_code?: string` | `readOnlyHint` |
| `comtrade_list_service_categories` | List EBOPS 2010 service trade categories — the equivalent of `comtrade_search_commodities` for the services domain. Returns category codes, descriptions, and parent codes. Filter by keyword or browse from a parent code. | `query?: string`, `parent_code?: string` | `readOnlyHint`, `openWorldHint: false` |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `comtrade://countries` | Complete list of all country/area codes — both reporters and partners — with M49 numeric codes, ISO identifiers, `validAsReporter` flag, and group membership. Bundled from reference data at startup. | No (static list) |
| `comtrade://hs-classification/{level}` | Top-level HS commodity hierarchy at the requested aggregation level: `2` (21 sections), `4` (97 chapters), or `6` (top ~1 200 codes). Full leaf-level enumeration is too large to be injectable — use `comtrade_search_commodities` instead. | No |

### Prompts

None planned — this is a data-only server; the query/analysis framing is better left to the calling agent.

---

## Overview

`un-comtrade-mcp-server` wraps the UN Comtrade API v2 (`comtradeapi.un.org`) to give agents structured access to international merchandise and services trade statistics. The dataset covers ~200 countries and areas from 1962 to the present with commodity detail down to the 6-digit HS level.

**Local-only deployment** — the UN Comtrade license agreement (§5) explicitly prohibits redistribution of data without prior written UN permission. This server must never be hosted as a proxy that serves data to third parties. The intended deployment is local: the user connects with their own Comtrade subscription key, which flows directly from their machine to UN servers. No data is cached, stored, or forwarded through any intermediate service.

The server solves two friction points that make Comtrade hard to use programmatically: (1) HS code opacity — agents don't know numeric commodity codes; `comtrade_search_commodities` bridges keyword intent to code; (2) code/name resolution — country names don't map trivially to Comtrade M49 numeric codes; the lookup tools handle that.

---

## Requirements

- User must provide their own `COMTRADE_SUBSCRIPTION_KEY` for full API access. The key is passed via header `Ocp-Apim-Subscription-Key` on authenticated endpoints.
- A public preview endpoint (`public/v1/preview`) exists without a key but is limited to 500 records per call and a lower rate limit. Tools support optional key injection — without it they fall back to the preview endpoint.
- Free-tier keys: 500 requests/day, 500 records per call. Premium keys: up to 250 000 records per call.
- Reference data (reporter/partner lists, HS classification, EBOPS categories) is served from static JSON files (`comtradeapi.un.org/files/v1/app/reference/`) without authentication — no key required for lookup tools.
- Data response fields: `primaryValue` (USD), `fobvalue` (exports), `cifvalue` (imports), `qty`, `netWgt`, `grossWgt`. Many fields are `null` in the preview endpoint — codes are present but `*Desc` fields are omitted.
- Rate limiting: 429 responses must trigger exponential backoff with retry.
- **Redistribution prohibited** — local-only deployment, user's own credentials, no hosted proxy.

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `ComtradeDataService` | `data/v1/get` and `public/v1/preview` trade data endpoints | `comtrade_get_trade_flows`, `comtrade_get_trade_balance`, `comtrade_get_top_partners`, `comtrade_get_top_commodities`, `comtrade_get_services_trade` |
| `ComtradeReferenceService` | `files/v1/app/reference/*.json` static reference files | `comtrade_lookup_countries`, `comtrade_search_commodities`, `comtrade_list_service_categories`, both resources |
| `ComtradeMetaService` | `public/v1/getDA` and `public/v1/getMetadata` availability endpoints | `comtrade_get_data_availability` |

Reference data is fetched once at startup and held in memory — the files are static and change only with new HS editions. Data and meta services make per-request calls with retry/backoff.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `COMTRADE_SUBSCRIPTION_KEY` | No | Azure API Management subscription key from comtradedeveloper.un.org. Without it, tools fall back to the public preview endpoint (500-record cap). |
| `COMTRADE_API_BASE_URL` | No | Override API base URL. Defaults to `https://comtradeapi.un.org`. |

---

## Implementation Order

1. Config (`server-config.ts`) — env var schema, base URL, key injection logic
2. `ComtradeReferenceService` — fetch and index reporters, partners, HS hierarchy, EBOPS on startup
3. Lookup/search tools: `comtrade_lookup_countries`, `comtrade_search_commodities`, `comtrade_list_service_categories`
4. Resources: `comtrade://countries`, `comtrade://hs-classification/{level}`
5. `ComtradeDataService` — authenticated/preview request builder with retry, timeout, key fallback
6. `ComtradeMetaService` — availability endpoint
7. Core data tools: `comtrade_get_trade_flows`, `comtrade_get_data_availability`
8. Derived workflow tools: `comtrade_get_trade_balance`, `comtrade_get_top_partners`, `comtrade_get_top_commodities`
9. Services trade: `comtrade_get_services_trade`

Each step is independently testable.

---

## Domain Mapping

| Noun | Operations | API endpoint |
|:-----|:-----------|:-------------|
| Country/area | lookup by name/ISO (reporters and partners via single tool with role filter) | `files/v1/app/reference/Reporters.json`, `partnerAreas.json` |
| HS commodity | search by keyword/code, browse hierarchy | `files/v1/app/reference/HS.json` (+ H0–H6 editions) |
| Service category (EBOPS) | list, search | `files/v1/app/reference/EB10.json` |
| Trade flow (goods) | get by reporter/partner/commodity/period/flow, balance, top-partners, top-commodities | `data/v1/get` (key) / `public/v1/preview` (no key) |
| Trade flow (services) | get by reporter/partner/service-category/period/flow | `data/v1/get` with `typeCode=S` |
| Data availability | check by reporter/period/classification | `public/v1/getDA` |
| Dataset metadata | get publication notes, conversion factors | `public/v1/getMetadata` |

---

## Workflow Analysis

`comtrade_get_trade_balance` (2 upstream calls, parallel):

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `data/v1/get?flowCode=X&cmdCode=TOTAL` | Export value for reporter/partner/period |
| 2 | `data/v1/get?flowCode=M&cmdCode=TOTAL` | Import value for reporter/partner/period |
| — | local computation | `balance = exports - imports`, `coverage = exports / imports` |

`comtrade_get_top_partners` (1 upstream call + local sort):

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `data/v1/get?reporterCode={r}&cmdCode={code}&flowCode={X\|M}` without partner filter | API returns one row per partner — disaggregated breakdown |
| — | local sort + slice | Sort by `primaryValue` descending, take top N, join partner names from reference cache |

`comtrade_get_top_commodities` (1 upstream call + local sort):

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `data/v1/get?reporterCode={r}&flowCode={X\|M}&aggrLevel={2\|4}` | API returns one row per HS chapter/heading — commodity breakdown |
| — | local sort + slice | Sort by `primaryValue` descending, take top N, join HS descriptions from reference cache |

---

## Design Decisions

**No `comtrade_get_tariffline` tool.** Tariffline data (national tariff-line level, more granular than 6-digit HS) is premium-only and requires a separate endpoint. The 6-digit HS level covers the vast majority of agent workflows. Tariffline can be added post-launch if there is demand.

**Single `comtrade_lookup_countries` vs. separate reporter/partner tools.** Reporter and partner code lists are not identical — regional groupings are valid as partners but not as reporters. Rather than two near-identical lookup tools, a single tool with a `role` filter and a `validAsReporter` flag on results handles both dimensions. Agents making a query with reporter+partner still make two lookups, but from one tool — the cognitive surface is smaller and the distinction between valid reporters and partner-only areas is surfaced in the data, not in the tool name.

**Subscription key is env-var-only — no per-call parameter.** The per-call `subscription_key` parameter was dropped from data tools. Users with a key set it in the env; tools fall back to the public preview endpoint without one. The "multiple keys" scenario is too niche to justify the confusion of a per-call override showing up as a parameter in tool descriptions. If a multi-key scenario arises, it can be addressed with a `comtrade_set_subscription_key` session tool.

**`comtrade_get_trade_trend` dropped — covered by `comtrade_get_trade_flows`.** `comtrade_get_trade_flows` already accepts `period: string[]` and returns one record per period. A separate trend tool would do the same thing with a sort applied. The description of `comtrade_get_trade_flows` makes clear the multi-period array input serves time-series workflows.

**`comtrade_get_top_commodities` added.** The partner-ranking tool (`comtrade_get_top_partners`) has no symmetric commodity-ranking counterpart. "What does Germany mainly export?" is an equally common workflow and was absent from the original surface.

**Multi-period array input on data tools.** The API accepts comma-separated periods. Passing `period: ["2020","2021","2022","2023"]` translates to a single request rather than four serial calls — important against the 500-req/day free-tier limit.

**`cmdCode=TOTAL` for country-level aggregates.** The API special-cases `TOTAL` to return the sum across all commodities. Tools that don't require commodity detail default to `TOTAL` rather than fetching and summing all HS codes client-side.

**Reference data preloaded at startup — trade flow data is not cached.** The HS reference file is large (~5 000 entries for the combined HS). Loading it at startup into an in-memory index avoids per-request fetches and enables fast substring/keyword search. This is compliant with the license: the reference data (country codes, HS descriptions) is lookup metadata, not the trade statistics themselves. Trade flow query results are never cached or stored — each call flows directly from the user's client to UN servers.

**Services trade as a separate tool.** Goods and services trade use the same `data/v1/get` endpoint but diverge in classification code scheme (HS vs. EBOPS) and conceptual framing. A single "get trade data" tool with a `type` enum would be valid but would obscure the classification lookup step — users of the services tool need `comtrade_list_service_categories`, not `comtrade_search_commodities`. The split makes the prerequisite chain unambiguous.

---

## Output Schema Notes

Key fields returned by data tools (implementer reference):

| Field | Type | Meaning |
|:------|:-----|:--------|
| `primaryValue` | number (USD) | The main trade value — FOB for exports, CIF for imports. Use this for consistent cross-flow comparisons; do not use `fobvalue`/`cifvalue` directly since one will be null depending on flow direction. |
| `fobvalue` | number\|null | Free-on-board value. Present for export flows; null for import flows. |
| `cifvalue` | number\|null | Cost-insurance-freight value. Present for import flows; null for export flows. |
| `qty` / `netWgt` | number\|null | Quantity in commodity-specific units / net weight in kg. Often null for aggregated or estimated rows. |
| `cmdCode` | string | HS code (e.g., `"8471"` or `"TOTAL"`). Join descriptions from in-memory reference cache — the API omits `*Desc` fields on the preview endpoint. |
| `reporterCode` / `partnerCode` | number | M49 numeric codes. Join names from reference cache. |
| `isReported` | boolean | Whether the value is directly reported (`true`) or estimated/aggregated by UN (`false`). Surface this to callers — estimated values have lower reliability. |
| `aggrLevel` | number\|null | HS digit level of the commodity (2, 4, 6). Useful when `cmd_code` was omitted and the tool fetches at the chapter level. |

All data tools should include a top-level `truncated` field (boolean) when the API returned 500 records and the total count may exceed that, with a `hint` string explaining how to get the full dataset.

---

## Known Limitations

- **500-record cap on the preview endpoint.** Without a subscription key, queries that match more than 500 rows are silently truncated. The response includes a `count` field; the tool surfaces this as `truncated: true` with a hint when `data.length === 500` and `count > 500`.
- **Null `*Desc` fields in preview responses.** The public preview omits text descriptions for reporter, partner, flow, commodity, and unit fields — only codes are returned. The service layer joins these back from the in-memory reference cache before returning results.
- **No bulk download.** The bulk file API (`bulk/v1/get`) is premium-only and designed for full-country annual downloads. It is outside the scope of this server — use the Comtrade Plus UI or the official Python library for bulk workflows.
- **Mirror asymmetry.** Export data reported by country A may not match import data reported by country B for the same bilateral flow — differences in CIF/FOB valuation, timing, re-exports, and country definitions. The `comtrade_get_trade_balance` tool notes this caveat in its output.
- **Data lag.** Annual data is typically published 3–12 months after the reference year; monthly data varies by country. `comtrade_get_data_availability` should be called before querying recent periods.

---

## API Reference

**Base URL:** `https://comtradeapi.un.org`

**Auth header:** `Ocp-Apim-Subscription-Key: {key}` — or pass as `subscription-key` query param.

**URL patterns:**

```
# Authenticated data
data/v1/get/{typeCode}/{freqCode}/{classificationCode}?reporterCode=&partnerCode=&cmdCode=&flowCode=&period=&maxrecords=

# Public preview (no key, 500-record cap)
public/v1/preview/{typeCode}/{freqCode}/{classificationCode}?reporterCode=&partnerCode=&cmdCode=&flowCode=&period=

# Data availability
public/v1/getDA/{typeCode}/{freqCode}/{classificationCode}?reporterCode=&period=

# Reference files (no auth)
files/v1/app/reference/{filename}.json
```

**Key parameters:**

| Param | Values | Notes |
|:------|:-------|:------|
| `typeCode` | `C` (commodities), `S` (services) | |
| `freqCode` | `A` (annual), `M` (monthly) | Monthly: `YYYYMM` periods |
| `classificationCode` | `HS`, `H0`–`H6`, `S1`–`S4`, `EB10` | `HS` = combined across all editions |
| `flowCode` | `M`, `X`, `RX`, `RM`, `DX`, `FM` | M=import, X=export, RX=re-export, RM=re-import |
| `reporterCode` | M49 numeric codes (e.g., `842`=USA, `156`=China) | From Reporters.json |
| `partnerCode` | M49 numeric codes; `0`=World aggregate | From partnerAreas.json |
| `cmdCode` | HS codes: `TOTAL`, 2/4/6-digit codes, comma-separated | Max 20 codes per call |
| `period` | `YYYY` (annual) or `YYYYMM` (monthly), comma-separated | Max ~12 periods per call |
| `maxrecords` | integer, default 500, max 250 000 (premium) | |
