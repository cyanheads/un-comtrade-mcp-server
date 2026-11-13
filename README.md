<div align="center">
  <h1>@cyanheads/un-comtrade-mcp-server</h1>
  <p><b>Access UN Comtrade international merchandise and services trade statistics — country lookups, HS commodity search, bilateral trade flows, balances, rankings, and data availability — via MCP. STDIO or Streamable HTTP.</b>
  <div>10 Tools • 3 Resources</div>
  </p>
</div>

<div align="center">



[![Version](https://img.shields.io/badge/Version-0.3.2-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/un-comtrade-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/un-comtrade-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/un-comtrade-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/un-comtrade-mcp-server/releases/latest/download/un-comtrade-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=un-comtrade-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvdW4tY29tdHJhZGUtbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22un-comtrade-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fun-comtrade-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://un-comtrade.caseyjhand.com/mcp](https://un-comtrade.caseyjhand.com/mcp)

</div>

---

## Overview

International merchandise and services trade statistics from UN Comtrade. Resolve country and HS commodity codes, fetch bilateral trade flows and services trade, and compute balances, partner/commodity/reporter rankings, and data availability.

### Tools

| Tool | Description |
|:-----|:------------|
| `comtrade_lookup_countries` | Resolve country and area names to Comtrade M49 numeric codes. |
| `comtrade_search_commodities` | Find HS or SITC commodity codes in a selected edition by keyword, description, or code prefix. |
| `comtrade_list_service_categories` | Find service trade categories in Comtrade's combined EB catalog, tagged with their EBOPS schemes, by keyword or parent code. |
| `comtrade_get_trade_flows` | Fetch bilateral trade flow records — value, quantity, and weight per period/commodity/partner. |
| `comtrade_get_trade_balance` | Compute a country's trade balance (exports minus imports) across one or more periods. |
| `comtrade_get_top_partners` | Rank trading partners by trade value for a reporter, commodity, and flow direction. |
| `comtrade_get_top_reporters` | Rank retrieved reporting areas by goods trade value for a commodity and flow direction. |
| `comtrade_get_top_commodities` | Rank commodity categories by trade value for a reporter and flow direction. |
| `comtrade_get_data_availability` | Check which reporter/period/classification combinations have published data. |
| `comtrade_get_services_trade` | Fetch international trade-in-services data — EB as reported (EB10, EB10S, or EB02 codes), or UN Comtrade's converted EB10/EB02 series. |

### Resources

| Resource | Description |
|:---------|:------------|
| `comtrade://countries` | Complete country/area code list with M49 codes, ISO identifiers, and reporter validity. |
| `comtrade://hs-classification/{level}` | Top-level HS commodity hierarchy at chapter, heading, or subheading level. |
| `skill://un-comtrade-guide/SKILL.md` | Workflow guide for historical classifications, coverage, bilateral/mirror analysis, and unit values. |

Country and HS reference data are also reachable through `comtrade_lookup_countries` and `comtrade_search_commodities`. The [workflow guide](./skills/un-comtrade-guide/SKILL.md) ships with npm, Docker, MCPB, and plugins, and is available over MCP as a skill resource.

## Capability reference

### `comtrade_lookup_countries` <sub>tool</sub>

- Accepts a partial or full country name, an official name ("Republic of Korea"), a common name ("UK", "Turkey"; 17 aliases), or an ISO alpha-2/alpha-3 code, ignoring case, accents, and surrounding spaces. Curly apostrophes and whole-word "St"/"St." also match their catalog spellings; literal ISO codes such as `ST` retain their meaning. A blank query is rejected, and one of only combining marks matches nothing. `role` filters to `"reporter"`, `"partner"` (only entries in UN's partner-area list, so no reporter-only groupings such as the European Union, 97), or `"any"` (default)
- `validAsReporter` flag on each match — most regional groupings (e.g. World) are partner-only, but some report (e.g. the European Union, 97)
- `include_groups` (default `true`) toggles regional/economic groupings in the results; a grouping that is the code a match's goods trade is published under (490 for 158) is kept. When `false` leaves only groupings out, the notice says so and to retry with `true`
- `note` on a match carries the catalog's long-form name or coverage note (e.g. "France, Monaco" for 251); a match can come from it. Absent when it repeats the name
- Each match also pulls in entries sharing its ISO-3 identity, and the code UN Comtrade publishes a match's goods trade under: Taiwan's 158 is partner-only, with goods trade published under reporter 490 (Other Asia, nes), so a lookup that matches 158 also returns 490. Use 490 as goods `reporter_code` or `partner_code`; use 158 as the services `partner_code`. Exact matches (alias, ISO code, name, or note equal to the query) list before partial ones, and a pulled-in entry ranks with its match; within a rank: reporter-valid, current before expired, name, then code. Reporter and partner-only area codes remain distinct
- `entryEffectiveDate` and `entryExpiredDate` (`YYYY-MM-DD`) give each entity's validity, so historical entities (e.g. Fed. Rep. of Germany, ...1990) sort after current ones within a rank
- Country references load from UN static files at startup — no subscription key required. Rows that fail validation are dropped and logged; startup fails on an empty catalog or when fewer than half a file's rows are valid

---

### `comtrade_search_commodities` <sub>tool</sub>

- Free-text keyword, partial description, or code-prefix search; a code written with dots, spaces, or hyphens (`0901.11`) matches `090111`. Exact code, code prefix, whole-word description, and other contiguous matches rank before descriptions containing every query term in any order; ties retain catalog order. A blank query, or one with no letter or digit, is rejected. `classification` (case-insensitive, default `HS`) selects the combined `HS` discovery reference, an HS edition `H0`–`H6`, or SITC `SS`/`S1`–`S4`
- `aggr_level` uses the selected catalog's native levels: HS chapters/headings/subheadings use `2`/`4`/`6`; SITC has levels `1`–`5`. Omit for all levels. The HS all-commodities `TOTAL` is level 0, which no `aggr_level` filter returns
- `limit` (default 50) is the page size; `totalMatches`, `shown`, and `truncated` describe the page, and `offset` with the returned `nextOffset` continues it
- `recommendedQueryCode` is the code to pass as `cmd_code` in a trade query. Use the classification appropriate to the trade series and your access tier
- Default `HS` results include `editions`, the H0–H6 catalogs listing the code, and `parentDescription` for codes absent from H6 when the immediate parent exists in the discovery catalog. Membership does not establish the same meaning across editions. Identify the series from trade rows or availability, then search its explicit edition; keyless trade queries still use `HS`. If an edition catalog is unavailable, matches and pagination remain usable without edition-derived fields, with a separate `referenceNotice`

---

### `comtrade_list_service_categories` <sub>tool</sub>

- Lists the combined EB service categories, optionally filtered by keyword or `parent_code`; numeric and alphabetic codes are distinct entries. A query ranks exact code, code prefix, whole-word description, then other description matches (ties and unfiltered listings in catalog order); codes compare case-insensitively and keep their dots, and a blank query lists every category. `parent_code: "200"` lists the EB10 and EB02 top levels
- `schemes` on each category names the EBOPS scheme catalogs that list its code (`EB10`, `EB10S`, `EB02`); it is empty when none does and absent, with a notice, when the scheme catalogs could not be loaded. `ebParent` carries the parent the combined EB catalog gives a code when it differs from `parent` (`TOTAL` for EB10's top-level codes, whose `parent` is `200`)
- `limit` (default 100) is the page size; `totalMatches`, `shown`, and `truncated` describe the page, and `offset` with the returned `nextOffset` continues it
- Returned `id` is the `service_code` for `comtrade_get_services_trade`

---

### `comtrade_get_trade_flows` <sub>tool</sub>

- Accepts a scalar `reporter_code` or an array; omission requires an explicit `partner_code`. Reporter arrays serve the first 20 distinct codes and disclose the remainder in `unservedReporters`. Served codes of an array that return no rows are listed in `reportersWithoutRecords` (`referenceStatus`, optional `suggestedReporterCode`; omitted when the response is truncated). A scalar partner-only reporter code, or a `partner_code` with a reporter-valid counterpart, gets a notice naming the code to query instead when no rows come back (reporter 250 → 251, 158 → 490; partner 840 → 842, 158 → 490)
- Requires `flow_code` (`M` import / `X` export / `RX` re-export / `RM` re-import) and `period` values, all `YYYY` or all `YYYYMM`. `freq` is optional: it is inferred from the period length, mixed lengths are rejected, and an explicit value must match. Up to 120 periods are accepted; keyless calls serve the first 8 distinct periods (12 with a subscription key). Periods past the cap, or whose request is rate limited, hits a UN Comtrade server error or network failure after retries, or runs out of time, are listed in `unservedPeriods` with a notice naming each failure (the HTTP status for a server error); if every period fails the call returns `rate_limited`, `upstream_unavailable`, or `deadline_exceeded`
- `partner_code: 0` returns the World total; omitting it can return World alongside the partner breakdown. A notice identifies this overlap: exclude World when summing partner rows, and check for other aggregates. `classification` (case-insensitive, default `HS`) supports `HS`, `H0`–`H6`, and SITC `S1`–`S4`/`SS`. Explicit HS editions require authenticated data access; keyless `HS` returns as-reported editions, identified by each row's `classificationCode`
- `cmd_code[]` accepts up to 200 codes and serves the first 20 distinct codes, listing the rest in `unservedCmdCodes`; omit it or pass `["TOTAL"]` for cross-commodity totals. `truncated: true` plus `truncationHint` means the response hit the 500-record cap; `isReported` separates directly reported rows from UN-estimated ones
- `cmdCodesWithoutRecords` lists explicitly served selectors with no rows in any completed period, including unmatched `AG<n>` expansions. It is omitted for capped responses. When returned rows establish one edition, the notice directs a reference search in that edition; absence is not reported zero trade
- Quantity and alternate quantity retain unit codes/abbreviations and estimation flags where available. UN Comtrade sends `0` for what it does not report, so `qty`/`altQty` of 0 with unit code `-1`, and `netWgt`/`grossWgt`/`cifvalue`/`fobvalue` of 0 beside a positive `primaryValue`, are omitted: an absent field means not reported, not zero. A 0 in a real unit stays a measurement

---

### `comtrade_get_trade_balance` <sub>tool</sub>

- Returns `balanceUsd` (signed), `exportsUsd`, `importsUsd`, and `coverageRatio` (exports / imports) per period; `balanceUsd` and `coverageRatio` appear only when both flows have data, since a flow with no rows may be unreported rather than zero, and a `note` says which flow is missing (a period with neither gets a notice pointing to `comtrade_get_data_availability`). Optional `cmd_code[]` sums the balance over HS or SITC commodities: exact duplicates count once, and overlapping codes (a code beside one of its sub-codes, `TOTAL` beside another entry, `AG<n>` beside another selector or a code of another length) fail with `overlapping_cmd_codes` because their shared trade would be counted twice
- `partner_code` defaults to World (`0`); a country code computes the reporter's bilateral balance and is echoed with the partner name. `classification` is case-insensitive with default `HS`; `freq` is optional and inferred from the period length (mixed lengths are rejected; an explicit value must match)
- Accepts up to 120 periods and 200 codes. Keyless calls serve the first 4 distinct periods (two requests each; 12 with a subscription key) and 20 codes, listing the rest in `unservedPeriods`/`unservedCmdCodes`; a period is served only when both flows complete, and one whose export or import request is rate limited, hits a UN Comtrade server error or network failure, or runs out of time is listed too. A `notice` warns when either flow hit the 500-record cap and the balance may be incomplete
- A partner-only reporter code (0 World, 250 Metropolitan France, 158 Taiwan, Province of China) with no data fails with `partner_only_reporter`, naming the code to query instead when one exists (250 → 251, 158 → 490). A `partner_code` with a reporter-valid counterpart (840 → 842, 158 → 490) that returns no data fails with `no_data` naming it, and either error carries it as `suggestedPartnerCode`
- `mirrorCaveat` on every response: the balance reflects this reporter's own values, not the partner's mirror data
- `cmdCodesWithoutRecords` identifies served selectors absent from both flows of the completed periods; `cmdCodes` still echoes the served selection. Capped results suppress this absence list, and selectors with a returned zero-value row count as present

---

### `comtrade_get_top_partners` <sub>tool</sub>

- Takes one `reporter_code`, `flow_code` (`M`/`X`), and single `period`; optional single `cmd_code` (omit for total merchandise trade) in the selected `classification` (case-insensitive, default `HS`; `H0`–`H6` with a subscription key, SITC `S1`–`S4`/`SS`). `AG<n>` selectors are rejected because they return multiple commodity rows per partner; use `comtrade_get_top_commodities` for a product ranking
- Infers annual or monthly frequency from the period; monthly values require a calendar month from `01` through `12`
- Returns the top `limit` partners (default 10; any larger value is honored, with no return-all threshold), each with `rank`, `primaryValueUsd`, and `sharePercent`; `totalPartners` and `totalValueUsd` cover every partner retrieved, and shares divide by `totalValueUsd`; `classification` names the catalog the `cmd_code` was read in
- `truncated: true` when the fetch hit the 500-record cap. An empty result for a partner-only reporter code ends its notice with the code to query instead (250 → 251, 158 → 490)

---

### `comtrade_get_top_commodities` <sub>tool</sub>

- Takes one `reporter_code`, `flow_code`, and single `period`; `aggr_level` is `2` (HS chapter, default), `4` (heading), or `6` (subheading). Set `parent_code` to a chapter with level 4 or 6, or a heading with level 6, for a scoped drill-down. Level 6 requires a parent. `partner_code` defaults to World (`0`); set it to scope to one partner
- Infers frequency from `period`. Fetches matching `TOTAL` to identify the reporter's HS edition, then queries that edition's category codes in paced chunks, splitting capped chunks
- Returns the top `limit` categories (default 10; any larger value is honored, with no return-all threshold). `residual: true` marks the not-specified code (99 for chapters, 9999 for headings) — trade not allocated to a code at that level, ranked and shared like any row, with a notice when it is on the page (9999 can exceed chapter 99, since it includes chapter-level trade the reporter withholds from headings). Complete coverage permits ranks; unscoped shares use `denominatorValueUsd` from `TOTAL`, while `totalValueUsd` and `totalCommodities` cover every category retrieved
- `coverageComplete`, `coverageNotice`, and `missingCodes` describe retrieval; codes not reached within the call's time budget are listed in `missingCodes`. Incomplete results retain available categories without ranks or shares; `truncated` remains true. Without a parent, `TOTAL` with no rows ends the ranking with an empty result and `truncated: false`; for a partner-only reporter code, or a `partner_code` with a reporter-valid counterpart, its notice names the code to query instead (250 → 251, 158 → 490; partner 840 → 842, 158 → 490). Ranking can require several upstream requests
- A drill-down retrieves only descendants in the identified edition, echoes `parentCode`, and uses the reported parent's value as `denominatorValueUsd`. `totalValueUsd` remains the descendant sum, which can differ from the parent. No parent value means no shares; complete child values can still rank. An unresolved edition never falls back to an unscoped ranking. Catalogued residual subheadings `999999` and historical `9999AA` remain flagged; parent remainders are not distributed among children

---

### `comtrade_get_top_reporters` <sub>tool</sub>

- Takes one `flow_code` (`M`/`X`), annual or monthly `period`, and commodity `cmd_code` (default `TOTAL`). `classification` follows goods HS/SITC rules; `AG<n>` selectors are rejected. `partner_code` defaults to World (`0`), with bilateral selection supported
- Returns the top `limit` reporting areas (default 10), ordered by known value then reporter code, with unresolved values last. `totalReporters` and any `totalValueUsd` cover the eligible retrieved set before the display limit. Shares use that total, not a separate global total
- Excludes World and known overlapping reporting groups, while retaining 490 (Other Asia, nes). Unknown or partner-only reporting identities stay visible with a caveat. Conflicting duplicate values remain unresolved rather than being summed
- `coverageNotice` describes the retrieved set; it makes no claim of global or subscription completeness. A detected upstream cap, unresolved value, or material identity/classification uncertainty withholds ranks and shares. Missing values stay absent, measured zeros remain zero, and a zero total has no shares

---

### `comtrade_get_data_availability` <sub>tool</sub>

- All filters optional — `reporter_code`, `period`, `freq` (`A`/`M`; inferred from `period`, `A` when `period` is omitted, and an explicit value must match it), `type_code` (`C` goods / `S` services, default `C`), `classification` (omitted or blank resolves to `HS` for goods, `EB10` for services; upstream identifiers such as `B4` and `B5` are also accepted)
- Returns per-dataset `totalRecords`, `firstReleased`, and `lastReleased` where available; omit all filters to browse goods availability
- `limit` defaults to 50 and `offset` to 0. Results are sorted before slicing; `totalDatasets`, `shown`, and `nextOffset` support stable page traversal. `truncated` identifies a partial page. Paging still fetches the matching upstream availability list
- An offset past a nonempty matching set returns no datasets and a notice naming the largest usable offset on both output surfaces
- An empty result for a partner-only reporter code names a counterpart when applicable (250 → 251; 158 → 490 for goods only)
- Annual data typically publishes 3–12 months after the reference year — call this before querying recent periods

---

### `comtrade_get_services_trade` <sub>tool</sub>

- Takes one `reporter_code`, `flow_code` (`M` imports/debits, `X` exports/credits), annual `period` values (`YYYY`), and optional `partner_code` (`0` for all partners combined). Up to 120 periods are accepted; keyless calls serve the first 8 distinct periods (12 with a subscription key). Periods past the cap, or whose request is rate limited, hits a UN Comtrade server error or network failure after retries, or runs out of time, are listed in `unservedPeriods` with a notice; if every period fails the call returns `rate_limited`, `upstream_unavailable`, or `deadline_exceeded`
- `classification` (case-insensitive, default `EB`; blank means `EB`) selects EB as reported, with each reporter-period in its own scheme (EB10, EB10S, or EB02 codes), or UN Comtrade's converted `EB10`/`EB02` series. `EB10S` has no converted series and is rejected; its rows are served only under `EB`. Each row's `classificationCode` identifies its classification and `isOriginalClassification` says whether it is as reported or converted
- `service_code` filters to one category from `comtrade_list_service_categories` (`3` is transport; `SA` is manufacturing services), which lists each code's `schemes`. Omit it to get every reported category at mixed levels, with totals (`200` for EB10 and EB02, `S` for EB10S) beside their components: don't sum the rows
- An empty result's notice names the code's scheme, routes to `comtrade_get_data_availability` with `classification: "EB"`, and suggests the converted series when one applies. ISO-3 counterpart guidance remains available (reporter 250 → 251; partner 840 → 842). For Taiwan services, use `partner_code: 158`; an empty request for partner 490 points to 158 without implying that Taiwan reports a services series
- Omitting `partner_code` can return World beside individual partners. A notice warns to exclude World from partner sums and to check the remaining rows for aggregates
- `truncated: true` plus `truncationHint` when the response hit the 500-record cap. Country and period coverage is more limited than for goods

---

### `comtrade://countries` <sub>resource</sub>

- Complete country/area list as `application/json` — M49 code, ISO identifiers, `validAsReporter`, `isGroup`, and `entryEffectiveDate`/`entryExpiredDate` (`YYYY-MM-DD`) where upstream lists them
- Loaded from the same startup reference cache `comtrade_lookup_countries` searches

---

### `comtrade://hs-classification/{level}` <sub>resource</sub>

- `level` path param accepts `2` (chapters), `4` (headings), or `6` (subheadings); any other value throws a validation error
- Returns each code's `description`, `parent`, and `isLeaf`; full leaf enumeration is too large to inject — use `comtrade_search_commodities` for keyword search

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Comtrade-specific:

- Country codes, current HS hierarchy, and EB categories load from UN static files at startup; historical HS/SITC editions, quantity units, and the `EB10.json`/`EB10S.json`/`EB02.json` scheme catalogs (category scheme tags and the services empty-result notice) load lazily and cache successful responses. Invalid rows in a reference file are dropped and logged; startup fails on an empty catalog or when fewer than half a file's rows are valid
- Authenticated (`data/v1/get`) and public preview (`public/v1/preview`) endpoints — tools fall back to the preview endpoint when no subscription key is set
- Parallel sub-request execution in workflow tools (`comtrade_get_trade_balance` runs export and import fetches concurrently)
- Retry with exponential backoff on transient failures, honoring an upstream `Retry-After` header when present
- Description enrichment uses the row's classification edition and preserves upstream labels. Optional reference failures retain trade values and codes with a notice

Agent-friendly output:

- `truncated: true` plus a recovery hint when a public preview response reaches 500 records
- `isReported` flag on trade flow records distinguishes directly-reported values from UN-estimated/aggregated rows
- `validAsReporter` on country lookups prevents constructing invalid queries with partner-only area codes
- `mirrorCaveat` on trade-balance output surfaces the methodological caveat without parsing error text

## Getting started

### Public Hosted Instance

A public instance is available at `https://un-comtrade.caseyjhand.com/mcp` — no installation required. It runs on the keyless public preview endpoint (500 records per upstream request), splitting served periods into paced requests that start at least 4 seconds apart. Each call serves 8 distinct periods for flows and services and 4 for balance (two requests per period); periods past that, or that fail, come back in `unservedPeriods`. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "un-comtrade-mcp-server": {
      "type": "streamable-http",
      "url": "https://un-comtrade.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

> **Prerequisites:** A [UN Comtrade subscription key](https://comtradedeveloper.un.org/) is optional. Without one, tools use the public preview endpoint (500 records per upstream request). A key selects authenticated access; retrieval and request limits depend on UN Comtrade and the subscription.

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "un-comtrade-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/un-comtrade-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "COMTRADE_SUBSCRIPTION_KEY": "your-key-here"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "un-comtrade-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/un-comtrade-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "COMTRADE_SUBSCRIPTION_KEY": "your-key-here"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "un-comtrade-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "-e", "COMTRADE_SUBSCRIPTION_KEY=your-key-here",
        "ghcr.io/cyanheads/un-comtrade-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 COMTRADE_SUBSCRIPTION_KEY=... bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.4](https://bun.sh/) or higher (or Node.js v24+).
- Optional: a [UN Comtrade subscription key](https://comtradedeveloper.un.org/) for authenticated API access subject to subscription limits. Without one, data tools use the public preview endpoint (500 records per upstream request). Reference/lookup tools (`comtrade_lookup_countries`, `comtrade_search_commodities`, `comtrade_list_service_categories`) never require a key — they query static UN reference files.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/un-comtrade-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd un-comtrade-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env and set COMTRADE_SUBSCRIPTION_KEY if you have one
```

## Configuration

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`.

| Variable | Description | Default |
|:---------|:------------|:--------|
| `COMTRADE_SUBSCRIPTION_KEY` | Azure API Management subscription key from [comtradedeveloper.un.org](https://comtradedeveloper.un.org). Without it, tools use the public preview endpoint (500-record cap). | — |
| `COMTRADE_API_BASE_URL` | Override the Comtrade API base URL. | `https://comtradeapi.un.org` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path. | `/mcp` |
| `MCP_PUBLIC_URL` | Public origin override for reverse-proxy deployments. | — |
| `MCP_SESSION_MODE` | HTTP session mode: `auto`, `stateful`, or `stateless`. | `stateless` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log failed tool arguments and results, redacted by key name, capped at `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` (default `16384`). Secrets inside free-form values are not redacted. | `false` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP base URL for traces (`/v1/traces`) and metrics (`/v1/metrics`). | — |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Opt-in OTLP log endpoint, used as-is. | — |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t un-comtrade-mcp-server .
docker run --rm -e COMTRADE_SUBSCRIPTION_KEY=your-key -p 3010:3010 un-comtrade-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/un-comtrade-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools, resources, and inits services. |
| `src/config` | Environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Ten tools across reference resolution, trade data, and workflow aggregations. |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). Country list and HS hierarchy resources. |
| `src/services/comtrade-data` | `ComtradeDataService` — authenticated/preview request builder with retry and key fallback. |
| `src/services/comtrade-reference` | `ComtradeReferenceService` — reference data loader (countries, HS, EBOPS), startup cache, keyword search. |
| `src/services/comtrade-meta` | `ComtradeMetaService` — data availability requests and validation. |
| `skills/` | Published workflow guide for agents calling the server. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources in `src/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields
- Use the matching classification's reference cache for commodity descriptions; lazy reference failures must preserve useful trade records and propagate caller cancellation

## Data license

Use UN Comtrade data in accordance with the UN Comtrade license agreement, including its redistribution terms.

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
