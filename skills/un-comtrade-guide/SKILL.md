---
name: un-comtrade-guide
description: Use the comtrade_* tools for historical goods and services trade comparisons, partner and commodity rankings, bilateral balances, mirror analysis, and unit values. Resolve classification-specific identifiers and verify coverage before drawing conclusions.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use UN Comtrade for reported international merchandise and services trade. It does not provide tariff schedules, national tariff-line detail, or observed transaction prices. Keyless preview supports focused analysis; a configured subscription key changes upstream access, not the need to verify completeness.

## Identifiers

- Resolve countries with `comtrade_lookup_countries` for the intended role. A partner area can be invalid as a reporter (World, Metropolitan France 250), while some groupings report (European Union, 97); `validAsReporter` and `role` settle it. Select the returned reporting identity rather than a familiar ISO numeric code: Comtrade's USA reporter is 842, while the similarly named 840 entry is not reporter-valid. Taiwan resolves to 158, a partner-only code; its trade is published under 490 (Other Asia, nes), as reporter and as partner. `comtrade://countries` enumerates the reference entries when browsing is needed.
- Discover goods through `comtrade_search_commodities`. Keep codes as strings, including leading zeros. The default HS catalog is useful for discovery; use the selected HS edition or SITC revision for historical meanings. `comtrade://hs-classification/{level}` navigates the default HS hierarchy, not historical editions.
- Discover services through `comtrade_list_service_categories`, which searches the combined EB catalog. Use its returned category and description together; numeric and SDMX category schemes coexist, so a familiar-looking code is not proof of meaning. Each category's `schemes` tags name the scheme catalogs (EB10, EB10S, EB02) that list its code.

## Gates

1. Before calling missing records zero trade, confirm the reporting identity, category, period, frequency, and classification. Check matching data availability; a published dataset does not guarantee a particular bilateral commodity row exists. Follow availability continuation before claiming the matching index is exhausted.
2. Before comparing historical goods, inspect each row's `classificationCode`. The same commodity code can change meaning across editions. Default HS queries return as-reported data, not a conversion to one common edition. Explicit HS editions are unavailable on keyless trade-data preview; do not silently replace an edition-converted request with HS.
3. Before reporting a complete series or ranking, inspect truncation, coverage, reference notices, and unserved inputs: `unservedPeriods`, `unservedReporters`, `unservedCmdCodes`, and `reportersWithoutRecords`. Retrieve remaining periods, reporters, or codes separately. A reporter listed in `reportersWithoutRecords` returned no rows; read its `referenceStatus` and `suggestedReporterCode` before concluding it has no trade, since a partner-only code has a reporter-valid counterpart (250 reports as 251; 158's trade is published under 490, Other Asia, nes). The same holds for a `partner_code` (840 → 842, 158 → 490): an empty result's notice names the code to retry. Missing descriptions do not justify guessing a commodity's meaning.
4. Before summing goods, choose one aggregation level and exclude overlapping parent/child codes and TOTAL rows from the same sum. World totals and country breakdowns are alternative views; do not add them together. `comtrade_get_trade_balance` rejects overlapping `cmd_code` entries (`overlapping_cmd_codes`): split them into separate calls, and apply the same rule to any sum you build from other tools' rows.
5. Before computing balances or comparing mirror flows, align period, commodity definition, and reporting perspective. A missing import or export value is not zero: a period with only one flow carries no `balanceUsd` or `coverageRatio`, only a `note`. Preserve caveats about CIF/FOB valuation, timing, re-exports, and country definitions.

## Workflows

### Historical product trend

After resolving the product, inspect the available classifications and query a narrow period to establish the reported edition. Search that edition's catalog before extending the series. Keep each observation's edition visible. If product coverage changed, split the comparison or obtain a verified concordance; matching numeric codes alone do not establish comparability.

Use `comtrade_get_trade_flows` for the time series. Select World for an overall total or a particular partner for a bilateral series; omitting the partner requests a breakdown. Keep annual and monthly observations separate and use the tool's frequency contract.

### Leading products and trading partners

Use `comtrade_get_top_commodities` for the product mix and `comtrade_get_top_partners` for suppliers or destinations of a selected product. Follow ranked entries into trade flows when quantities or historical detail are needed.

For commodity rankings, require `coverageComplete` before describing results as the leading categories. Read `coverageNotice` and unresolved-code metadata when coverage is incomplete; absent ranks or shares are not invitations to calculate them from the partial rows. `denominatorValueUsd` is matching TOTAL, while `totalValueUsd` is the retrieved-category sum. A row marked `residual` (99 for chapters, 9999 for headings) is trade not allocated to a code at that level, not a product category: it ranks by value like any row, so read the leading products around it, and note that 9999 can exceed chapter 99. For partner rankings, the share denominator is `totalValueUsd`, the sum of every retrieved partner rather than only those shown; do not describe it as a World-total share without checking that total separately.

### Bilateral balance and mirror evidence

Use `comtrade_get_trade_balance` for a reporter's World or bilateral balance. Keep the same reporter on both sides of exports-minus-imports. The result is that reporter's account, not an average of two countries' reports.

For peer comparisons, `comtrade_get_trade_flows` accepts one reporter or several. For mirror analysis, omit the reporter only with an explicit partner, then retain each returned reporter's identity. Partners' imports from the target provide mirror evidence about the target's exports; partners' exports to it provide mirror evidence about its imports. Label this as mirror evidence, inspect coverage, and do not present it as the target's own report.

### Services comparison

Use the services category catalog, not goods codes. Services trade queries default to EB, which serves each reporter-period in the scheme it was reported in; `classification` EB10 or EB02 selects UN Comtrade's converted series instead, and EB10S rows exist only under EB. Services availability defaults to EB10, so the availability classification and the row's actual classification serve different purposes: check availability with `classification: "EB"` to see the scheme each period was reported in. Inspect each row's `classificationCode` and `isOriginalClassification` (as reported or converted) and the category meanings before combining countries or years. A `service_code` returns rows only for periods reported in its scheme under EB. Omitting `service_code` returns every reported category at mixed levels, with totals (`200` for EB10 and EB02, `S` for EB10S) beside their components; never sum those rows. This server's services queries are annual. From the reporter's perspective, imports are debits and exports are credits.

### Unit values

Use trade-flow records with a known value and a positive quantity in a known unit, or a positive net weight in kilograms. An absent `qty`, `netWgt`, or unit means the value was not reported; the server omits UN Comtrade's placeholder zeros, so never treat absence as zero. Read quantity-unit metadata and the quantity/weight estimation flags before computing a ratio. An absent flag does not establish that a value was measured. Never infer quantity units from the commodity code or combine quantities in unlike units.

Report the ratio as a trade unit value, with its unit, valuation basis, period, product scope, and estimation caveats. Customs trade values divided by quantities are not observed transaction prices; product mix and reporting differences can change the ratio without a price change.
