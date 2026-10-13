<div align="center">
  <h1>@cyanheads/un-comtrade-mcp-server</h1>
  <p><b>Access UN Comtrade international merchandise and services trade statistics — country lookups, HS commodity search, bilateral trade flows, balances, rankings, and data availability — via MCP. STDIO or Streamable HTTP.</b>
  <div>9 Tools • 2 Resources</div>
  </p>
</div>

<div align="center">



[![Version](https://img.shields.io/badge/Version-0.2.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/un-comtrade-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.3.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/un-comtrade-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/un-comtrade-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.3-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

International merchandise and services trade statistics from UN Comtrade. Resolve country and HS commodity codes, fetch bilateral trade flows and services trade, and compute balances, partner/commodity rankings, and data availability from any MCP client. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:-----|:------------|
| `comtrade_lookup_countries` | Resolve country and area names to Comtrade M49 numeric codes. |
| `comtrade_search_commodities` | Find HS commodity codes by keyword, description, or code prefix. |
| `comtrade_list_service_categories` | List EBOPS 2010 service trade categories by keyword or parent code. |
| `comtrade_get_trade_flows` | Fetch bilateral trade flow records — value, quantity, and weight per period/commodity/partner. |
| `comtrade_get_trade_balance` | Compute a country's trade balance (exports minus imports) across one or more periods. |
| `comtrade_get_top_partners` | Rank trading partners by trade value for a reporter, commodity, and flow direction. |
| `comtrade_get_top_commodities` | Rank commodity categories by trade value for a reporter and flow direction. |
| `comtrade_get_data_availability` | Check which reporter/period/classification combinations have published data. |
| `comtrade_get_services_trade` | Fetch international trade-in-services data (EBOPS 2010). |

### Resources

| Resource | Description |
|:---------|:------------|
| `comtrade://countries` | Complete country/area code list with M49 codes, ISO identifiers, and reporter validity. |
| `comtrade://hs-classification/{level}` | Top-level HS commodity hierarchy at chapter, heading, or subheading level. |

Both resources are also reachable via tools — `comtrade_lookup_countries` and `comtrade_search_commodities` cover the same data with keyword search.

## Capability reference

### `comtrade_lookup_countries` <sub>tool</sub>

- Accepts a partial or full country name, or an ISO alpha-2/alpha-3 code; `role` filters to `"reporter"`, `"partner"`, or `"any"` (default)
- `validAsReporter` flag on each match — regional groupings (e.g. World, EU) are valid partners but not valid reporters
- `include_groups` (default `true`) toggles regional/economic groupings in the results
- Reference data loads from UN static files at startup — no subscription key required, instant response

---

### `comtrade_search_commodities` <sub>tool</sub>

- Free-text keyword, partial description, or code-prefix search; `classification` selects `HS` (combined dataset, default) or a specific edition `H0`–`H6`
- `aggr_level` narrows to `2` (chapter), `4` (heading), or `6` (subheading); omit for all levels
- `limit` defaults to 50; values above 200 return all matches. `truncated: true` when matches exceed a smaller limit
- `recommendedQueryCode` on each result — the best code to pass as `cmd_code` in trade queries

---

### `comtrade_list_service_categories` <sub>tool</sub>

- Lists EBOPS 2010 service categories, optionally filtered by keyword or `parent_code`
- `limit` defaults to 100; values above 500 return all categories. `truncated: true` when matches exceed a smaller limit
- Returned `id` is the `service_code` for `comtrade_get_services_trade`

---

### `comtrade_get_trade_flows` <sub>tool</sub>

- Requires `reporter_code`, `flow_code` (`M` import / `X` export / `RX` re-export / `RM` re-import), and `period` values (`YYYY` or `YYYYMM`). Serves the first 12 periods; inputs up to 120 disclose remaining `unservedPeriods`
- `partner_code: 0` aggregates all partners (World total); omit for a per-partner breakdown
- `classification` supports `HS`, `H0`–`H6`, and SITC `S1`–`S4`/`SS`. HS search remains HS-only; supply known SITC codes from the selected revision
- `cmd_code[]` serves the first 20 HS or SITC codes; inputs up to 200 disclose `unservedCmdCodes`. Omitted or empty arrays and `["TOTAL"]` request cross-commodity totals
- Keyless preview makes one paced request per distinct served period. `truncated: true` plus `truncationHint` means a raw response reached 500 and may be incomplete; `totalCount` sums upstream counts before filtering, not a known full match count
- `isReported` flags directly-reported rows vs. UN-estimated/aggregated ones; joins country and commodity descriptions from the startup reference cache

---

### `comtrade_get_trade_balance` <sub>tool</sub>

- Uses two paced preview requests per distinct served period; authenticated export (`X`) and import (`M`) calls batch periods in parallel, then compute the balance locally
- Returns `balanceUsd` (signed), `exportsUsd`, `importsUsd`, and `coverageRatio` (exports / imports) per period
- Optional `cmd_code[]` restricts the balance to HS or SITC commodities. Serves 12 periods and 20 codes per call; input ceilings 120/200, with `unservedPeriods`/`unservedCmdCodes` for the remainder
- A `notice` discloses possibly incomplete balance values when either raw preview flow reaches 500; `referenceNotice` discloses unavailable SITC descriptions without discarding trade values
- `mirrorCaveat` on every response — the balance reflects this reporter's own values, not the mirror partner's

---

### `comtrade_get_top_partners` <sub>tool</sub>

- Fetches a per-partner breakdown for one `reporter_code` + `flow_code` (`M`/`X`) + single `period`, then sorts retrieved rows locally by value
- Optional single `cmd_code`; omit for total merchandise trade
- Returns up to `limit` partners (default 10); above 50 returns all retrieved partners. Each has `rank`, `primaryValueUsd`, and `sharePercent`
- `truncated: true` when the underlying fetch hit the 500-record cap

---

### `comtrade_get_top_commodities` <sub>tool</sub>

- Ranks commodity categories for one `reporter_code` + `flow_code` + single `period`
- `aggr_level` selects `2` (HS chapter, default) or `4` (heading), requested with `AG2`/`AG4`. Omitted `partner_code` defaults to World (`0`); explicit partners scope to a bilateral relationship
- Returns up to `limit` categories (default 10); above 50 returns all retrieved categories. Each has `rank`, `primaryValueUsd`, and `sharePercent`
- `truncated: true` when the underlying fetch hit the 500-record cap

---

### `comtrade_get_data_availability` <sub>tool</sub>

- All filters optional — `reporter_code`, `period`, `freq` (`A`/`M`, default `A`), `type_code` (`C` goods / `S` services, default `C`), `classification` (omitted or blank resolves to `HS` for goods, `EB10` for services)
- Returns optional per-dataset `totalRecords`, `firstReleased`, and `lastReleased`, preserving first release and latest revision independently; omit all filters to browse goods availability
- Annual data typically publishes 3–12 months after the reference year — call this before querying recent periods

---

### `comtrade_get_services_trade` <sub>tool</sub>

- Same bilateral shape as `comtrade_get_trade_flows`: `reporter_code`, `flow_code` (`M`/`X`), `period` values, optional `partner_code` (`0` for all partners combined). Serves the first 12 periods from inputs up to 120, disclosing `unservedPeriods`
- `service_code` filters to one EBOPS category; resolve it with `comtrade_list_service_categories`
- Preview makes one paced request per distinct served period; a raw response reaching 500 produces `truncated: true` plus a truthful `truncationHint`
- Services trade has more limited country and period coverage than goods trade

---

### `comtrade://countries` <sub>resource</sub>

- Complete country/area list as `application/json` — M49 code, ISO identifiers, `validAsReporter`, and `isGroup`
- Loaded from the same startup reference cache `comtrade_lookup_countries` searches

---

### `comtrade://hs-classification/{level}` <sub>resource</sub>

- `level` path param accepts `2` (chapters), `4` (headings), or `6` (subheadings); any other value throws a validation error
- Returns each code's `description`, `parent`, and `isLeaf`; full leaf enumeration is too large to inject — use `comtrade_search_commodities` for keyword search

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Comtrade-specific:

- Reference data (country codes, HS hierarchy, EBOPS categories) loaded from UN static files at startup — keyword search with no per-request fetches
- Authenticated (`data/v1/get`) and public preview (`public/v1/preview`) endpoints — tools fall back to the preview endpoint when no subscription key is set
- Parallel sub-request execution in workflow tools (`comtrade_get_trade_balance` runs export and import fetches concurrently)
- Retry with exponential backoff on transient failures, honoring an upstream `Retry-After` header when present
- Description enrichment — joins country and HS/EBOPS names from the reference cache, covering the preview endpoint's omission of `*Desc` fields

Agent-friendly output:

- `truncated: true` plus a recovery hint when a public preview response reaches 500 records
- `isReported` flag on trade flow records distinguishes directly-reported values from UN-estimated/aggregated rows
- `validAsReporter` on country lookups prevents constructing invalid queries with partner-only area codes
- `mirrorCaveat` on trade-balance output surfaces the methodological caveat without parsing error text

## Getting started

### Public Hosted Instance

A public instance is available at `https://un-comtrade.caseyjhand.com/mcp` — no installation required. It runs on the keyless public preview endpoint (500 records per upstream request), splitting served periods into paced requests at least one second apart. Balance needs two requests per period, so longer arrays take more time. Point any MCP client at it via Streamable HTTP:

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

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+). Development and Docker images use Bun 1.4.3.
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
| `MCP_SESSION_MODE` | HTTP session posture: `auto`, `stateful`, or `stateless`. No tool asks the caller for input mid-handler, so `src/index.ts` declares `stateless` and every deployment surface restates it. | `stateless` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log failed tool arguments and results, redacted by key name and capped at `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` (default `16384`). Secrets inside free-form values are not redacted. | `false` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP base URL for traces (`/v1/traces`) and metrics (`/v1/metrics`). | — |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Opt-in OTLP log endpoint, used as-is; the base URL does not enable logs. | — |

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
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Nine tools across reference resolution, trade data, and workflow aggregations. |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). Country list and HS hierarchy resources. |
| `src/services/comtrade-data` | `ComtradeDataService` — authenticated/preview request builder with retry and key fallback. |
| `src/services/comtrade-reference` | `ComtradeReferenceService` — reference data loader (countries, HS, EBOPS), startup cache, keyword search. |
| `src/services/comtrade-meta` | `ComtradeMetaService` — data availability and dataset metadata endpoints. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources via the barrels in `src/mcp-server/*/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields
- Reference data (countries, HS codes) joins must pull from the startup cache, not per-request fetches

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
