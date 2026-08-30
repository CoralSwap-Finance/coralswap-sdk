# [SDK] Add API reference documentation for portfolio module

**Closes #314**

---

## Summary

Adds comprehensive TSDoc to `src/modules/portfolio.ts` and `src/types/portfolio.ts`, closing the documentation gap for all public portfolio and PnL APIs.

---

## What changed

### `src/modules/portfolio.ts`

- Added module-level class doc explaining the financial model (spot-price valuation, impermanent loss embedding, stablecoin requirement), with a usage example and cross-references to `TreasuryModule` and `PositionsModule`
- Documented the constructor with `@param` tags and a note about the effect of omitting `stableAddresses`
- `getPortfolio` — full `@param`, `@returns`, `@throws` (`ValidationError`, `AddressNotFoundError`, `MissingPriceFeedError`, `PortfolioCalculationError`), and `@example`
- `get` — same coverage plus inline valuation formula (`valueUSD = (tokenNAmount / 1e7) × priceN`) and `totalValueUSD` aggregation note
- `createSnapshot` — documented cost-basis semantics and the recommended capture timing (immediately after deposit), with a full snapshot → PnL workflow example
- `getPortfolioPnL` — documented the PnL formulas (`pnlUSD = current − entry`, `pnlPercent = pnlUSD / entry × 100`), the division-by-zero guard, and the IL-embedded explanation; full `@throws` coverage and `@example`
- `buildPriceMapTracked` (private) — documented the spot-price derivation formula and the purpose of the `missingTokens` return value vs. the inherited `buildPriceMap`

### `src/types/portfolio.ts`

- Added `@module portfolio-types` header with the three-step workflow diagram (`getPortfolio → createSnapshot → getPortfolioPnL`)
- `PortfolioPosition` — field-level docs for all 8 properties; added the implied-amounts formula and USD valuation formula inline
- `Portfolio` — field-level docs clarifying that only non-zero LP positions are included
- `PortfolioEntrySnapshot` — explained cost-basis semantics and the difference between a snapshot and a live portfolio fetch; documented the nested `positions` array fields individually
- `PortfolioPnL` — added PnL formulas, division-by-zero note, and a prose explanation of how IL is embedded in `pnlUSD` rather than reported separately
- `GetPortfolioOptions` — documented the RPC-call-reduction benefit of supplying `pairAddresses`

---

## Acceptance criteria

- [x] Every public method has complete TSDoc (`@param`, `@returns`, `@throws`, `@example`)
- [x] Financial formulas documented inline (valuation, PnL, spot-price derivation, IL)
- [x] At least 3 code examples (5 total across the two files)
- [x] `npm run docs` produces zero errors attributable to the portfolio module

> **Note:** `npm run docs` currently exits with 206 pre-existing errors caused by the TS6/7 `ScVal` API migration in unrelated files (`contracts/`, `modules/staking.ts`, `modules/limit-orders.ts`, etc.). None of those errors reference `portfolio.ts` or `types/portfolio.ts`.

---

## Files changed

| File | Change |
|---|---|
| `src/modules/portfolio.ts` | TSDoc for class, constructor, and all 4 public methods |
| `src/types/portfolio.ts` | TSDoc for module, all 5 interfaces, and every field |
