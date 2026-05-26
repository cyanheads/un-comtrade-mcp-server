<div align="center">
  <h1>@cyanheads/un-comtrade-mcp-server</h1>
  <p><b>Access UN Comtrade international merchandise and services trade statistics — country lookups, HS commodity search, bilateral trade flows, balances, rankings, and data availability — via MCP. STDIO or Streamable HTTP.</b>
  <div>9 Tools • 2 Resources</div>
  </p>
</div>

<div align="center">



[![Version](https://img.shields.io/badge/Version-0.1.3-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/un-comtrade-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/un-comtrade-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/un-comtrade-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/un-comtrade-mcp-server/releases/latest/download/un-comtrade-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=un-comtrade-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvdW4tY29tdHJhZGUtbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22un-comtrade-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fun-comtrade-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

> **Note:** The UN Comtrade license agreement (§5) prohibits redistributing data without prior written UN permission. Connect with your own Comtrade subscription key.

---

## Tools

9 tools covering the full UN Comtrade workflow — reference resolution, trade data retrieval, aggregated rankings, and coverage checking:

| Tool | Description |
|:-----|:------------|
| `comtrade_lookup_countries` | Resolve country and area names to Comtrade M49 numeric codes. Accepts partial names or ISO alpha-2/alpha-3 codes. Returns matching entries with `validAsReporter` flag — regional groupings are valid partner codes but not reporter codes. |
| `comtrade_search_commodities` | Find HS commodity codes by keyword, partial description, or code prefix. Returns codes at 2-, 4-, or 6-digit aggregation with descriptions, parent code, leaf status, and a `recommended_query_code` field. |
| `comtrade_list_service_categories` | List EBOPS 2010 service trade categories — the services-domain equivalent of `comtrade_search_commodities`. Returns codes, descriptions, and parent codes. Filter by keyword or browse from a parent code. |
| `comtrade_get_trade_flows` | Fetch bilateral trade flow records. Returns `primaryValue` (USD, FOB for exports / CIF for imports), quantity, net weight, and period/commodity/partner metadata per row. Accepts multiple periods and commodity codes in one call. |
| `comtrade_get_trade_balance` | Compute trade balance (exports minus imports) for a country over one or more periods with optional commodity filter. Fetches export and import totals in parallel; returns signed balance, component values, and coverage ratio. |
| `comtrade_get_top_partners` | Rank trading partners for a reporter by trade value for a given commodity and flow direction. Returns top N partners sorted by descending value for a single period. |
| `comtrade_get_top_commodities` | Rank commodity categories for a reporter by trade value for a given flow direction and period. Returns top N HS chapters (2-digit) or headings (4-digit) sorted by descending value. |
| `comtrade_get_services_trade` | Fetch international trade-in-services data (EBOPS 2010). Same bilateral structure as goods trade: returns flow value, period, and reporter/partner/category metadata. |
| `comtrade_get_data_availability` | Check which reporter/period/classification combinations have published data before constructing expensive queries. Returns record count and publication date per dataset. |

### `comtrade_lookup_countries`

Resolve reporter and partner codes from natural-language names or ISO identifiers.

- Accepts partial country name, ISO alpha-2 (`US`), or ISO alpha-3 (`USA`)
- `role` filter: `"reporter"`, `"partner"`, or `"any"` — narrows results to only valid reporters or all partner areas
- `validAsReporter` flag on each result — regional groupings (e.g., `Africa`, `ASEAN`) are valid as partners but cannot be used as `reporter_code`
- Optional `include_groups` to surface regional aggregate codes
- Reference data is loaded from UN static files at startup — no key required, instant response

---

### `comtrade_search_commodities`

Find the HS code for any product before querying trade flows.

- Free-text keyword search across HS descriptions (e.g., `"semiconductors"`, `"crude oil"`)
- Accepts known code prefixes — `"8471"` returns the matching chapter and all descendants
- Aggregation level control: start with `aggr_level: 2` (chapters) to scope a sector, then narrow to `4` or `6` for specific headings or subheadings
- `recommended_query_code` field on each result — the best level for downstream `comtrade_get_trade_flows` calls
- Reference data loaded at startup from UN HS files, covering HS combined and editions H0–H6

---

### `comtrade_get_trade_flows`

Fetch bilateral trade records — the primary data retrieval tool.

- `reporter_code` + `flow_code` (`M` import / `X` export / `RX` re-export / `RM` re-import) + `period[]` required
- `period` accepts annual (`YYYY`) or monthly (`YYYYMM`); pass multiple years as an array for time-series in one request (avoids multiple API calls against the 500-req/day free limit)
- `partner_code: 0` aggregates across all partners (World total) — no partner lookup needed
- `cmd_code[]` accepts comma-separated HS codes; omit or use `TOTAL` for cross-commodity totals
- Free-tier cap: 500 records per call; `truncated: true` + hint when the cap is hit
- Joins country and commodity descriptions from the in-memory reference cache — preview-endpoint responses omit `*Desc` fields

---

### `comtrade_get_trade_balance`

Compute signed trade balance from parallel export + import fetches.

- Runs export (`flowCode=X`) and import (`flowCode=M`) requests in parallel, then computes locally
- Returns `balance` (USD, signed), `exports`, `imports`, and `coverageRatio` (exports / imports)
- Optional `cmd_code` filter for commodity-specific balance (e.g., energy trade balance)
- Surfaces mirror-asymmetry caveat — the balance reflects values as reported by this country, not the mirror reporter

---

### `comtrade_get_top_partners`

Rank trading partners by value for a single period.

- Fetches one record per partner by omitting the partner filter, then sorts locally
- Joins partner names from the in-memory reference cache
- `limit` controls N returned (default 10)
- Answers "who does Germany mainly export machinery to?" in one call

---

### `comtrade_get_top_commodities`

Rank commodity chapters or headings by value for a single period.

- `aggr_level: 2` for HS chapter ranking (21 sections), `4` for heading ranking
- Optional `partner_code` to scope the ranking to a specific bilateral relationship
- Answers "what does Japan mainly import?" — symmetric counterpart to `comtrade_get_top_partners`

---

### `comtrade_get_data_availability`

Check data coverage before querying.

- Accepts optional `reporter_code`, `period`, `freq` (`A` annual / `M` monthly), and `classification` filters
- Returns dataset records with period, classification, record count, and publication date
- Annual data is typically published 3–12 months after the reference year — call this before querying recent periods to avoid empty results

---

### `comtrade_get_services_trade`

Fetch services trade data (EBOPS 2010 classification).

- Same bilateral structure and parameters as `comtrade_get_trade_flows`
- `service_code` accepts an EBOPS category code — use `comtrade_list_service_categories` to find the right code
- Covers financial services, transport, travel, insurance, and all EBOPS 2010 categories

## Resources and prompts

| Type | Name | Description |
|:-----|:-----|:------------|
| Resource | `comtrade://countries` | Complete country/area code list — M49 numeric codes, ISO identifiers, `validAsReporter` flag, and group membership. Loaded from UN reference data at startup. |
| Resource | `comtrade://hs-classification/{level}` | Top-level HS commodity hierarchy at aggregation level `2` (chapters), `4` (headings), or `6` (top ~1 200 subheadings). Full leaf enumeration is too large to inject — use `comtrade_search_commodities` for keyword search. |

All resource data is also reachable via tools. `comtrade://hs-classification/{level}` provides a browsable hierarchy; for keyword resolution use `comtrade_search_commodities` instead.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool and resource definitions — single file per primitive, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Pluggable auth: `none`, `jwt`, `oauth`
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

UN Comtrade-specific:

- Reference data (country codes, HS hierarchy, EBOPS categories) loaded at startup from UN static files — fast keyword search with no per-request fetches
- Authenticated (`data/v1/get`) and public preview (`public/v1/preview`) endpoint support — tools fall back to the preview endpoint when no subscription key is set
- Parallel sub-request execution for workflow tools (`comtrade_get_trade_balance` runs export + import fetches concurrently)
- Exponential backoff with retry on 429 responses
- Description enrichment — joins country names and HS/EBOPS descriptions from the in-memory reference cache before returning results, covering the preview endpoint's omission of `*Desc` fields

Agent-friendly output:

- `truncated: true` + hint on any response where the 500-record free-tier cap was hit — agents know when results are incomplete and can narrow the query
- `isReported` flag on trade flow records — distinguishes directly reported values from UN-estimated/aggregated rows so agents can reason about data reliability
- `validAsReporter` on country lookups — prevents agents from constructing invalid queries with partner-only area codes
- Mirror-asymmetry caveat on trade balance output — agents can surface methodological notes to users without parsing error text

## Getting started

> **Prerequisites:** A [UN Comtrade subscription key](https://comtradedeveloper.un.org/) is optional but recommended. Without one, tools fall back to the public preview endpoint (500 records/call, lower rate limit). With a free-tier key you get the same record cap but higher request headroom.

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "un-comtrade": {
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
    "un-comtrade": {
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

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 COMTRADE_SUBSCRIPTION_KEY=... bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.3.0](https://bun.sh/) or higher (or Node.js v24+).
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

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
