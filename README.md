<div align="center">
  <h1>@cyanheads/un-comtrade-mcp-server</h1>
  <p><b>Access UN Comtrade international merchandise and services trade statistics — country lookups, HS commodity search, bilateral trade flows, balances, rankings, and data availability — via MCP. STDIO or Streamable HTTP.</b>
  <div>9 Tools • 2 Resources</div>
  </p>
</div>

<div align="center">



[![Version](https://img.shields.io/badge/Version-0.1.7-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/un-comtrade-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/un-comtrade-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/un-comtrade-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/un-comtrade-mcp-server/releases/latest/download/un-comtrade-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=un-comtrade-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvdW4tY29tdHJhZGUtbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22un-comtrade-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fun-comtrade-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

International merchandise and services trade statistics from UN Comtrade. Resolve country and HS commodity codes, fetch bilateral trade flows and services trade, and compute balances, partner/commodity rankings, and data availability from any MCP client. Runs as a stdio process or a local Streamable HTTP server.

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
- Up to 200 results per call (`limit`, default 50); `truncated: true` when matches exceed the limit
- `recommendedQueryCode` on each result — the best code to pass as `cmd_code` in trade queries

---

### `comtrade_list_service_categories` <sub>tool</sub>

- Lists EBOPS 2010 service categories, optionally filtered by keyword or `parent_code`
- Up to 500 results per call (`limit`, default 100); `truncated: true` when matches exceed the limit
- Returned `id` is the `service_code` for `comtrade_get_services_trade`

---

### `comtrade_get_trade_flows` <sub>tool</sub>

- Requires `reporter_code`, `flow_code` (`M` import / `X` export / `RX` re-export / `RM` re-import), and 1–12 `period` values (`YYYY` or `YYYYMM`)
- `partner_code: 0` aggregates all partners (World total); omit for a per-partner breakdown
- `cmd_code[]` accepts up to 20 HS codes; omit or pass `"TOTAL"` for cross-commodity totals
- Free-tier cap of 500 records per call; `truncated: true` plus a `truncationHint` when the cap is hit
- `isReported` flags directly-reported rows vs. UN-estimated/aggregated ones; joins country and commodity descriptions from the startup reference cache

---

### `comtrade_get_trade_balance` <sub>tool</sub>

- Runs export (`X`) and import (`M`) fetches in parallel per period, then computes the balance locally
- Returns `balanceUsd` (signed), `exportsUsd`, `importsUsd`, and `coverageRatio` (exports / imports) per period
- Optional `cmd_code[]` (up to 20) restricts the balance to specific commodities
- `mirrorCaveat` on every response — the balance reflects this reporter's own values, not the mirror partner's

---

### `comtrade_get_top_partners` <sub>tool</sub>

- Fetches the full per-partner breakdown for one `reporter_code` + `flow_code` (`M`/`X`) + single `period`, then sorts locally by value
- Optional single `cmd_code`; omit for total merchandise trade
- Returns up to `limit` partners (max 50, default 10), each with `rank`, `primaryValueUsd`, and `sharePercent`
- `truncated: true` when the underlying fetch hit the 500-record cap

---

### `comtrade_get_top_commodities` <sub>tool</sub>

- Ranks commodity categories for one `reporter_code` + `flow_code` + single `period`
- `aggr_level` selects `2` (HS chapter, default) or `4` (heading); optional `partner_code` scopes to one bilateral relationship
- Returns up to `limit` categories (max 50, default 10), each with `rank`, `primaryValueUsd`, and `sharePercent`
- `truncated: true` when the underlying fetch hit the 500-record cap

---

### `comtrade_get_data_availability` <sub>tool</sub>

- All filters optional — `reporter_code`, `period`, `freq` (`A`/`M`, default `A`), `type_code` (`C` goods / `S` services, default `C`), `classification` (default `HS`)
- Returns per-dataset `totalRecords` and `publicationDate`; omit all filters to browse the full availability index
- Annual data typically publishes 3–12 months after the reference year — call this before querying recent periods

---

### `comtrade_get_services_trade` <sub>tool</sub>

- Same bilateral shape as `comtrade_get_trade_flows`: `reporter_code`, `flow_code` (`M`/`X`), 1–12 `period` values, optional `partner_code` (`0` for all partners combined)
- `service_code` filters to one EBOPS category; resolve it with `comtrade_list_service_categories`
- Free-tier cap of 500 records per call; `truncated: true` plus a `truncationHint` when the cap is hit
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

- `truncated: true` plus a recovery hint on any response capped at the 500-record free-tier limit
- `isReported` flag on trade flow records distinguishes directly-reported values from UN-estimated/aggregated rows
- `validAsReporter` on country lookups prevents constructing invalid queries with partner-only area codes
- `mirrorCaveat` on trade-balance output surfaces the methodological caveat without parsing error text

## Getting started

> **Prerequisites:** A [UN Comtrade subscription key](https://comtradedeveloper.un.org/) is optional but recommended. Without one, tools fall back to the public preview endpoint (500 records/call, lower rate limit). With a free-tier key you get the same record cap but higher request headroom.

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

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+). Development and Docker images use Bun 1.4.0.
- Optional: a [UN Comtrade subscription key](https://comtradedeveloper.un.org/) for full API access. Without one, all tools fall back to the public preview endpoint (500 records/call). Reference/lookup tools (`comtrade_lookup_countries`, `comtrade_search_commodities`, `comtrade_list_service_categories`) never require a key — they query static UN reference files.

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
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

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

The UN Comtrade license agreement (§5) prohibits redistributing data without prior written UN permission. Connect with your own Comtrade subscription key.

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
