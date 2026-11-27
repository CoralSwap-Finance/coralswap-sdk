# Changelog

## [Unreleased]

### Added
- Explicit slippage policy on every swap entry point: `slippageToleranceBps` (validated 1-1000, default 100 bps) derives `amountOutMin`/`maxAmountIn` from the current route quote, so no swap path executes without a documented bound (#679)
- `GovernanceModule.cancelProposal()` and `executeProposal()`, and `decodeProposal` now returns the proposal's `actions` instead of an empty array (#655)
- Test matrices for governance (propose, decode actions, cancel, execute) and staking cooldown boundaries (#655), an events-timeline continuity suite over multi-page ledgers (#657), and a tax-reporting regression suite for non-zero gains, BigInt-safe cost basis and exports past 200 events (#659)
- `NotConfiguredError` (`NOT_CONFIGURED`, fail-fast) for a required network deployment or SDK provider that has not been configured (#638, #642)
- `decodeI128Strict` (shared i128 ScVal decoder used by events, staking and limit orders), the `SCALE` constants bundle (`TOKEN_DECIMALS`, `PRICE_SCALE`, `BPS_DENOMINATOR`, `CONVERSION_SCALE`), and a `taskTimeoutMs` option on `batchRequest` that rejects tasks exceeding the per-task timeout
- Webhook endpoint verification for the SDK webhook module:
  - `verifyWebhook(webhookId)` posts a signed challenge payload and records the result — a `2xx` marks the endpoint `verified: true`, a failed handshake (non-`2xx`, network error or timeout) marks it `verified: false`
  - `updateWebhook(webhookId, updates)` changes a registered webhook's `url`, `events` and/or `secret` with the same validation as `registerWebhook()`; changing the url resets `verified` and clears the failure counter, re-enabling a webhook that was auto-disabled
  - `listWebhooks()` now returns `Webhook[]` views carrying `verified`, `failCount` and `lastDelivery` alongside the configuration, and `getWebhook()` returns the same view; `isWebhookVerified()` and `listWebhooksForEvent()` expose the verification state and event subscription directly
  - `sendWebhook(webhookId, payload, { event })` honours the webhook's event subscription: an event the endpoint did not subscribe to is skipped without an HTTP request (`filtered: true`)
- `Webhook` and `WebhookUpdate` types for the above
- CI check requiring a CHANGELOG entry under `[Unreleased]` for PRs that change `src/`
- Input validation guards on `PortfolioModule` methods: `owner` and every `pairAddresses` entry must be a valid Stellar address (`G…` or `C…`), `fromDate`/`toDate` must be real dates that are not in the future and must satisfy `fromDate < toDate`, and `limit` must be a positive integer no greater than 1000 — every failure throws a typed `ValidationError` whose message includes the invalid value
- `MonitoringModule.getSystemMetrics(period)`: TVL, swap volume, fee revenue, and unique-user change vs. the previous equal-length window, plus top growing/declining pools. Historical figures are read through the shared `TypedEventCursor` (#478)
- Monitoring aggregation suite driven by fixture reserve (`sync`) and transfer (`swap`) event streams shaped exactly like Soroban RPC output (real XDR `ScVal` topics and values, RPC-style filter semantics). It pins exact TVL, volume, fee and user figures for two diverging streams plus an empty control, so aggregation that stops reading the data — or that keeps a hardcoded constant — fails the test
- Fees per-token-decimals suite (`tests/fees-per-token-decimals.test.ts`): revenue and LP claim-fee math pinned over 6-, 7- and 12-decimal tokens — stroop-exact totals, literal human-unit strings, one metadata read per token, the 7-decimal fallback, 200+ swaps aggregated across RPC pages, and the default 200-swap cap
- `FeeRevenue`, `FeeRevenueTokenTotal` and `FeeRevenueEntry` types behind `getFeeRevenue()`, which now also returns stroop-exact `byToken[]` totals (`totalFeeAmount`, `totalFeeFormatted`, `decimals`) and per-swap `feeAmount` / `feeFormatted` / `tokenIn` / `decimals`
- `getLPYield()` reports `decimals` — the per-token precision used to value both pool reserves
- Shared `getTokenDecimals(client, address)` util (SEP-41 `decimals()` with a per-address cache and a 7-decimal fallback), extracted from the leaderboard module where it was private
- Acceptance coverage for undeployed-network access: `client.factory` / `client.router` on MAINNET and STAGING pinned for the `NotConfiguredError` class, the `NOT_CONFIGURED` code, `details.configKey`, the network and the actionable message, plus `NotConfiguredError` unit tests for the hint and the `configKey` mirror
- Zod schemas for position entries (`EnrichedLPPositionSchema`, `PositionMathSchema`, `PositionSummarySchema`, exported from `@/schemas`) with a malformed/valid fixture suite (`tests/positions-schema.test.ts`): missing or empty fields, wrong primitive types, `NaN`/infinite/out-of-range `share`, fractional/negative/out-of-ceiling `feeBps`, non-bigint stroops, and summary-level failures — each pinned to a `ValidationError` naming the offending field

### Changed
- Governance module validates `createProposal` and `castVote` inputs with zod schemas (`CreateProposalInputSchema`, `CastVoteInputSchema`), replacing the hand-written guards while keeping `ValidationError` as the thrown type (#488)
- `MonitoringModule.getSystemMetrics(period)` validates `period` through the shared `MonitoringPeriodSchema` (zod) via `validateWithSchema`, replacing the hand-written check; the error is still a `ValidationError` (#493)
- `EventCursor` continues a multi-page scan from the previous page's cursor (paging token) instead of `lastLedger + 1`, so events beyond the page limit inside a single ledger are no longer skipped; continuation requests carry the cursor and no ledger range, as Soroban RPC requires (#657)
- `Network.STAGING` now targets Stellar Futurenet (`rpc-futurenet.stellar.org`, futurenet passphrase) with empty factory and router addresses instead of aliasing Testnet; `client.factory` / `client.router` throw `NotConfiguredError` on STAGING and MAINNET until deployment addresses are configured (#638)
- `NotConfiguredError` carries the missing configuration key: callers can pass `details.configKey`, which is mirrored on a typed `error.configKey` field, and an optional hint that is appended to the message so the failure says what to set. `client.factory` / `client.router` supply `factoryAddress` / `routerAddress`, the network and the accessor, turning `"Factory contract is not configured"` into an actionable message — callers branch on `error.configKey` instead of matching message text
- `getVotingPower` / `getVotingPowerAtLedger` throw `NotConfiguredError` when no voting-power provider is set, instead of returning a silent zero-power account (#642)
- `verifyRedStonePayload` fails closed: a missing or non-positive feed price throws `MissingPriceFeedError` and non-positive amounts throw `ValidationError`, where the guard used to be skipped (#656)
- Bundle-size budget re-baselined from 200 KiB to 225 KiB: the original cap was measured before the check merged, and `main` was already 213.9 KiB when it landed, so the CI job failed on every commit. The current public surface measures 215.1 KiB (220,313 bytes) at `0d73bc2`; the cap keeps the intended ~4.5% headroom (#810)
- Liquidity module validates add/remove-liquidity and add-liquidity-quote inputs with Zod schemas via `validateWithSchema`, replacing the hand-written guards while preserving every existing rule and error message
- Monitoring aggregation derives its figures instead of reporting placeholder zeros: `getPoolHealth()` / `getAllPoolHealth()` and `getProtocolSummary()` read TVL from live reserves (spot-priced through the factory pair map) and 24h volume/fees from the trailing-24h `swap` event stream, and the dashboard's `volume24hUSD` / `fees24hUSD` go through the same derivation. `PoolHealth` documents the derivation, and `getAllPoolHealth()` builds the price map once for all pools
- `FeeModule.getFeeRevenue()` computes each fee in BigInt stroops (`amountIn * feeBps / 10000`) and divides by the input token's on-chain `decimals()` instead of a hardcoded `1e7`; the swap stream is read through the shared `TypedEventCursor`, which base64-encodes the `swap` topic and follows page cursors, and `limit` now caps the swaps aggregated (default 200) rather than one RPC page — a non-positive `limit` throws a `ValidationError`
- `getLPYield()` values `reserve0` / `reserve1` with each pool token's own decimals and keeps the fee share derived from the stroop-exact revenue above
- `PositionsModule.getPosition()` validates its BigInt math operands and the assembled entry before returning, and `getPositions()` validates the final summary, so a malformed chain read fails as a `ValidationError` naming the field instead of a raw `TypeError` (mixing a `number` into `reserve0 * balance`) or a silently wrong-shaped object. A `ValidationError` from one pool is no longer swallowed by `Promise.allSettled`; transient per-pair RPC failures are still skipped

### Fixed
- `DeadlineError` is a single class again: `src/utils/retry.ts` defined its own copy alongside the one in `src/errors.ts`, so `instanceof` against one missed errors thrown as the other (a retry deadline from `withRetry` was not a `CoralSwapSDKError` and failed the public `DeadlineError` check). `@/utils/retry` now re-exports the `@/errors` class, which carries the retry fields `deadlineMs`, `nowMs` and `pastDeadlineMs` (#636)
- `checkCompatibility` flags patch-level downgrades (e.g. `1.2.3` → `1.2.1` and `1.2.0` → `1.1.0`) as incompatible instead of treating same-minor patch returns as compatible, with advisory warning steps (#639)
- `OracleModule.getPriceDeviation()` no longer reports `0` bps when the reference TWAP is `0n`. `computeDeviationBps()` short-circuited to `0`, so a pair whose TWAP accumulator never advanced was indistinguishable from one where oracle and spot agreed exactly — the manipulation detector returned its best possible score while blind. `price0DeviationBps`/`price1DeviationBps` are now `number | null`, where `null` means no usable reference price (#641)
- `FeeModule.getFeeRevenue()` no longer corrupts revenue figures: fee amounts are computed and accumulated in stroop-level BigInt (no `Number()` precision loss above 2^53), display conversions use each input token's own `decimals()` read from its contract instead of a hard-coded 10^7, and swap events are fetched through the shared `TypedEventCursor` with full cursor pagination so windows with more than 200 events are fully retrievable. Returns exact `totalFeeStroops`/`feeStroops` totals plus a per-token breakdown (`totalFeeByToken`), with input validation for the ledger window and page limit (#632)
- `FeeModule.getLPYield()` uses the same BigInt-safe share math (no `Number(lpBalance)` precision loss) and converts both reserve sides with their own tokens' decimals instead of a hard-coded 1e7; it also exposes `totalFeeRevenueStroops` (#632)
- Tax reporting computes cost basis, disposals and gains in stroops with BigInt arithmetic instead of `parseFloat` rounding; partial lot consumption keeps the remaining lot's cost, and holding-period gains use real proceeds and cost instead of a zero placeholder (#659)
- `fromSorobanAmount(amount, 0)` returned `"123."` for zero-decimal tokens, which `parseTokenAmount` rejects; it now returns `"123"`. Caught by the new amounts fuzz suite
- `DecodeError` was exported but missing from `ERROR_TAXONOMY` and the error taxonomy docs; the new conformance suite caught it
- Threshold price alerts using the pair spot-price fallback now quote the watched token in its paired token at the USD canonical scale (10^8), oriented by which side of the pair the token is on, instead of always returning `reserve1 / reserve0` at 10^18. Direction, boundary and orientation semantics are pinned by a fixture suite (#678)
- `RateLimiter.destroy()` no longer "gifts" tokens to queued callers: destroying the limiter now rejects every queued `acquire()` with the new `RateLimiterDestroyedError` instead of resolving them, so a teardown path can no longer materialize an immediate unthrottled burst (#647). The error message is deliberately non-retryable-sounding so `isRetryable()` fails fast on a dead limiter
- Added burst/token-accuracy tests for `RateLimiter` refill boundaries: sub-interval credit accrual, floor rounding at the refill boundary, and refill capping at `maxBurst` without distorting the refill clock (#647)
- Restored source, config, and test files corrupted when #784, #785, #786, #789, #790, and #792 were merged (overwritten code, invalid `package.json` / `package-lock.json`), which left `main` unable to install, compile, or pass CI
- `SwapModule.getSwapHistory()` decoded event payloads only in the accessor-function shape test doubles use (`value.map()`, `val.sym()`); live Soroban RPC returns parsed `xdr.ScVal`s whose arms are plain properties, so every real event decoded to nothing and the method returned `[]` — silently zeroing monitoring's 24h volume/fee figures and the leaderboard aggregation built on it. Event decoding now accepts both the live `ScVal` shape and the accessor-function shape, so the same fixtures drive either path
- `getFeeRevenue()` decoded `amount_in` into a `number` and divided every fee by `1e7`: a 6-decimal token's fees came out 10× too small, a 12-decimal token's 100,000× too large, amounts above 2^53 lost stroops to float rounding, and one non-paginated `getEvents` call (with a bare `"swap"` topic string that live RPC never matches) dropped every swap past the first page. Fees are BigInt now, priced per token, and the stream is paginated

### Removed
- Unused `GetOpenOrdersSchema` and `GetOrderSummarySchema` exports from the package entry (#664)

## [1.1.0] - 2026-02-17

### Added
- Pluggable `Signer` interface in `src/types/common.ts` for wallet adapter support
- `KeypairSigner` default implementation in `src/utils/signer.ts`
- `signer` option in `CoralSwapConfig` for external wallet integration (Freighter, Albedo)
- Core SDK client with direct Soroban RPC interaction
- Factory, Pair, Router, LP Token contract bindings
- Flash Receiver interface and helpers
- Swap module with dynamic fee-aware quoting
- Liquidity module with LP position management
- Flash Loan module with fee estimation
- Fee module for dynamic fee transparency
- TWAP Oracle module for manipulation-resistant price feeds
- Typed error hierarchy (12 error classes)
- Utility modules: amounts, addresses, simulation, retry
- Test scaffolding with Jest configuration
- Full README documentation with examples


### Changed
- `CoralSwapClient` now accepts both `secretKey` and `signer` config options
- `submitTransaction()` now awaits `signer.signTransaction()` 

### Backward Compatible
- Existing `secretKey` usage continues to work unchanged

## [2.0.0] - 2026-06-29

### Added
- Full [Migration Guide](./MIGRATION.md) from v1 to v2
- Treasury, Staking, Governance, Limit Orders, DCA, Stop Loss, Positions modules
- Alerts, Webhooks, Monitoring modules
- RouterModule with multi-hop swap support
- Enhanced `simulateTransaction()` with typed return values
- `estimateOnly` option on liquidity operations
- `Signer` interface for external wallet adapters (Freighter, Albedo)
- `mapError()` utility for automatic contract error mapping
- `CircuitBreakerError`, `PriceDeviationError`, `StaleOracleError`, `SignerError` error classes
- 18 new utility functions (validation, simulation, gas, events)

### Changed
- Improved error handling with `executeWithFallback` for multi-RPC resilience
- `CoralSwapClient` constructor now supports `rpcUrl` as string array for fallback URLs
- `SwapModule.getQuote()`/`execute()` now accept `path` for multi-hop routing
- `LiquidityModule.getAddLiquidityQuote()` signature simplified (removed `amountBDesired`)

### Deprecated
- Legacy `simulateTransaction(ops, source)` string form — prefer enhanced options object
- Manual `instanceof` error chain — prefer `mapError()`