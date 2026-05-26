# un-comtrade-mcp-server - Directory Structure

Generated on: 2026-05-26 01:50:54

```text
un-comtrade-mcp-server/
├── .claude/
├── .github/
│   └── ISSUE_TEMPLATE/
│       ├── bug_report.yml
│       ├── config.yml
│       └── feature_request.yml
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   └── template.md
├── docs/
│   ├── design.md
│   └── idea.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skills-sync.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   └── tree.ts
├── skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── migrate-mcp-ts-template/
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       ├── countries.resource.ts
│   │   │       └── hs-classification.resource.ts
│   │   └── tools/
│   │       └── definitions/
│   │           ├── get-data-availability.tool.ts
│   │           ├── get-services-trade.tool.ts
│   │           ├── get-top-commodities.tool.ts
│   │           ├── get-top-partners.tool.ts
│   │           ├── get-trade-balance.tool.ts
│   │           ├── get-trade-flows.tool.ts
│   │           ├── list-service-categories.tool.ts
│   │           ├── lookup-countries.tool.ts
│   │           └── search-commodities.tool.ts
│   ├── services/
│   │   ├── comtrade-data/
│   │   │   ├── comtrade-data-service.ts
│   │   │   └── types.ts
│   │   ├── comtrade-meta/
│   │   │   ├── comtrade-meta-service.ts
│   │   │   └── types.ts
│   │   └── comtrade-reference/
│   │       ├── comtrade-reference-service.ts
│   │       └── types.ts
│   └── index.ts
├── tests/
│   ├── mcp-server/
│   │   └── tools/
│   │       └── definitions/
│   ├── prompts/
│   ├── resources/
│   │   ├── countries.resource.test.ts
│   │   └── hs-classification.resource.test.ts
│   └── tools/
│       ├── get-data-availability.tool.test.ts
│       ├── get-services-trade.tool.test.ts
│       ├── get-top-commodities.tool.test.ts
│       ├── get-top-partners.tool.test.ts
│       ├── get-trade-balance.tool.test.ts
│       ├── get-trade-flows.tool.test.ts
│       ├── list-service-categories.tool.test.ts
│       ├── lookup-countries.tool.test.ts
│       └── search-commodities.tool.test.ts
├── .dockerignore
├── .env.example
├── .gitignore
├── .mcpbignore
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
