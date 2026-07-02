# Migration Guide: v1 to v2

Upgrading `@coralswap/sdk` from v1 to v2? This guide covers every breaking change, new module, and deprecated API so you can migrate safely.

---

## Table of Contents

- [Quick Upgrade Checklist](#quick-upgrade-checklist)
- [Breaking Changes](#breaking-changes)
  - [1. Client Configuration](#1-client-configuration)
  - [2. Transaction Submission](#2-transaction-submission)
  - [3. Simulation API](#3-simulation-api)
  - [4. Swap Module](#4-swap-module)
  - [5. Liquidity Module](#5-liquidity-module)
  - [6. Error Handling](#6-error-handling)
  - [7. Network Configuration](#7-network-configuration)
- [New Modules (v2)](#new-modules-v2)
- [Deprecated APIs & Removal Timeline](#deprecated-apis--removal-timeline)
- [Step-by-Step Upgrade Instructions](#step-by-step-upgrade-instructions)
- [FAQ](#faq)

---

## Quick Upgrade Checklist

- [ ] Update package to `@coralswap/sdk@^2.0.0`
- [ ] Review [Client Configuration](#1-client-configuration) for new `signer` and polling options
- [ ] Replace raw `secretKey` usage with `signer` interface where external wallets are needed
- [ ] Update `swap.getQuote()`/`swap.execute()` calls — `SwapRequest` now supports `path` (multi-hop)
- [ ] Update `liquidity.getAddLiquidityQuote()` calls — signature changed
- [ ] Replace manual `mapError()` or `instanceof` checks with the new `mapError()` utility
- [ ] Import new modules from `@coralswap/sdk` directly (no extra setup needed)

---

## Breaking Changes

### 1. Client Configuration

**v1** — only `secretKey` for signing:
```ts
const client = new CoralSwapClient({
  network: Network.TESTNET,
  rpcUrl: "https://soroban-testnet.stellar.org",
  secretKey: "S...",
});
```

**v2** — adds `signer` interface for external wallet adapters (Freighter, Albedo, etc.):
```ts
import { KeypairSigner } from "@coralswap/sdk";

// Same as v1 (backward compatible)
const client = new CoralSwapClient({
  network: Network.TESTNET,
  secretKey: "S...",
});

// New — external signer (e.g., Freighter)
const client = new CoralSwapClient({
  network: Network.TESTNET,
  signer: myFreighterSigner, // implements Signer interface
  publicKey: "G...",         // optional, else resolved via signer.publicKey()
});

// New — custom logger
const client = new CoralSwapClient({
  network: Network.TESTNET,
  secretKey: "S...",
  logger: myLogger, // implements Logger interface
});
```

**New config fields in `CoralSwapConfig`:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `rpcUrl` | `string \| string[]` | network default | Single URL or array of fallback URLs |
| `rpcHeaders` | `Record<string, string>` | — | Custom headers for RPC requests |
| `fetchOptions` | `any` | — | Custom fetch options |
| `signer` | `Signer` | — | External signer (takes precedence over `secretKey`) |
| `publicKey` | `string` | — | Pre-set public key (avoids async resolution) |
| `logger` | `Logger` | — | Request/response instrumentation |
| `defaultSlippageBps` | `number` | `50` | Default slippage tolerance |
| `defaultDeadlineSec` | `number` | `1200` | Default deadline offset |
| `maxRetries` | `number` | `3` | RPC retry count |
| `retryDelayMs` | `number` | `1000` | Base retry delay |
| `maxRetryDelayMs` | `number` | `30000` | Max retry delay |
| `pollingStrategy` | `PollingStrategy` | `LINEAR` | Transaction polling mode |
| `pollingIntervalMs` | `number` | `1000` | Polling interval |
| `maxPollingAttempts` | `number` | `30` | Max polling attempts |
| `pollingBackoffFactor` | `number` | `2` | Exponential backoff factor |
| `maxPollingIntervalMs` | `number` | `10000` | Max polling interval |

### 2. Transaction Submission

`submitTransaction()` now awaits `signer.signTransaction()`, supporting both `secretKey` and external signers.

**v1:**
```ts
const result = await client.submitTransaction([op]);
// { success: boolean, data?: { txHash, ledger }, error?: {...} }
```

**v2:**
```ts
// Same API — internally uses signer.signTransaction()
const result = await client.submitTransaction([op]);
// Result type unchanged, but signing path now supports external wallets
```

**New methods on `CoralSwapClient`:**

| Method | Description |
|--------|-------------|
| `client.poller()` | Returns `TransactionPoller` instance |
| `client.tokens()` | Returns `TokenListModule` for token list management |
| `client.factoryModule()` | Returns `FactoryModule` with cached pair lookups |
| `client.getPairAddress(a, b)` | Quick pair lookup via factory |
| `client.getDeadline(sec?)` | Helper for deadline timestamps |
| `client.getCurrentLedger()` | Returns current ledger number |
| `client.isHealthy()` | RPC health check |
| `client.setNetwork(network, rpcUrl?)` | Switch networks at runtime |
| `client.resolvePublicKey()` | Async public key resolution |
| `client.lpToken(address)` | LP token contract client |

### 3. Simulation API

`simulateTransaction()` now has an **enhanced overload** that returns a typed `SimulateTransactionResult`.

**v1 (legacy, still works):**
```ts
const sim = await client.simulateTransaction([op]);
// Returns SorobanRpc.Api.SimulateTransactionResponse
if (SorobanRpc.Api.isSimulationSuccess(sim)) { ... }
```

**v2 enhanced (recommended):**
```ts
const result = await client.simulateTransaction([op], {}); // empty options object
if (result.success) {
  console.log("Return value:", result.returnValue);
  console.log("CPU instructions:", result.cost?.cpuInsns);
  console.log("Min resource fee:", result.minResourceFee);
  console.log("Events emitted:", result.events.length);
}
```

**`SimulateTransactionOptions` fields:**

| Field | Type | Description |
|-------|------|-------------|
| `source` | `string` | Override source account |
| `timeoutSec` | `number` | Timeout in seconds (default: network timeout) |
| `fee` | `string` | Base fee in stroops (default: `"100"`) |

### 4. Swap Module

**`SwapRequest` now supports multi-hop routing via `path`:**

```ts
interface SwapRequest {
  tokenIn: string;
  tokenOut: string;
  amount: bigint;
  tradeType: TradeType;
  path?: string[];         // NEW — multi-hop routing path
  slippageBps?: number;
  deadline?: number;
  to?: string;             // NEW — recipient override
  quote?: SwapQuote;       // NEW — pre-fetched quote
  priceFeed?: PriceFeed;   // NEW — RedStone price guard
}
```

**v1 — direct swap only:**
```ts
const quote = await swap.getQuote({
  tokenIn: "CDLZ...",
  tokenOut: "CBQH...",
  amount: 1000000n,
  tradeType: TradeType.EXACT_IN,
  slippageBps: 50,
});
```

**v2 — multi-hop swap (new):**
```ts
const quote = await swap.getQuote({
  tokenIn: "CDLZ...",
  tokenOut: "CBQH...",
  amount: 1000000n,
  tradeType: TradeType.EXACT_IN,
  path: ["CDLZ...", "CXYZ...", "CBQH..."], // route A → B → C
  slippageBps: 50,
});
```

**`SwapQuote` extended with new fields:**

```ts
interface SwapQuote {
  // ... v1 fields unchanged ...
  path: string[];     // NEW — routing path used
  deadline: number;   // NEW — quote expiry
}
```

**New swap types:**

| Type | Description |
|------|-------------|
| `SwapHistoryFilter` | Filter for historical swap events |
| `SwapHistoryEvent` | A historical swap with full context |
| `SwapSimulationResult` | Contract-backed dry-run quote |
| `HopResult` | Per-hop calculation during multi-hop |
| `MultiHopSwapRequest` | Multi-hop specific request |
| `MultiHopSwapQuote` | Multi-hop quote with per-hop breakdown |
| `RedStonePayload` | RedStone oracle price payload |
| `PriceGuardConfig` | Price guard configuration |
| `SwapWithPriceGuardRequest` | Price-guarded swap request |

**New static math methods on `SwapModule`:**

```ts
// v2 — new pure functions
swap.getAmountOut(amountIn, reserveIn, reserveOut, feeBps);
swap.getAmountIn(amountOut, reserveIn, reserveOut, feeBps);
swap.computeHops(amountIn, path);
swap.computeHopsReverse(amountOut, path);
```

### 5. Liquidity Module

**`getAddLiquidityQuote()` signature changed:**

**v1:**
```ts
const quote = await liquidity.getAddLiquidityQuote(
  "CDLZ...",
  "CBQH...",
  toSorobanAmount("100", 7),
  toSorobanAmount("200", 7),  // <-- removed in v2
);
```

**v2:**
```ts
const quote = await liquidity.getAddLiquidityQuote(
  "CDLZ...",     // tokenA
  "CBQH...",     // tokenB
  toSorobanAmount("100", 7), // amountADesired
);
// amountB is now computed optimally from pool reserves
```

**`addLiquidity()` / `removeLiquidity()` support `estimateOnly`:**

```ts
// v2 — gas estimation without submission
const gas = await liquidity.addLiquidity(request, { estimateOnly: true });
console.log("Estimated fee:", gas.minResourceFee);

// v2 — normal execution (unchanged)
const result = await liquidity.addLiquidity(request);
```

**New methods:**

```ts
// Get single LP position
const pos = await liquidity.getPosition(pairAddress, owner);

// Get all LP positions for an address
const positions = await liquidity.getAllPositions(owner);
```

### 6. Error Handling

**New error classes in v2:**

| Error Class | Code | When |
|-------------|------|------|
| `CircuitBreakerError` | `CIRCUIT_BREAKER` | Pool is paused |
| `PriceDeviationError` | `PRICE_DEVIATION_TOO_HIGH` | Oracle price deviation |
| `StaleOracleError` | `STALE_ORACLE_PAYLOAD` | Oracle payload expired |
| `SignerError` | `NO_SIGNER` | No signer configured |
| `OrderNotFoundError` | `ORDER_NOT_FOUND` | Limit order not found |
| `InvalidOperationError` | `INVALID_OPERATION` | Invalid operation |
| `StakingError` | `STAKING_ERROR` | Staking operation failed |
| `CooldownError` | `COOLDOWN_ERROR` | Cooldown period active |

**New `mapError()` utility — replaces manual error parsing:**

**v1:**
```ts
try {
  await swap.execute(request);
} catch (err) {
  if (err instanceof SlippageError) { ... }
  else if (err instanceof DeadlineError) { ... }
  else { ... }
}
```

**v2:**
```ts
import { mapError } from "@coralswap/sdk";

try {
  await swap.execute(request);
} catch (err) {
  const sdkError = mapError(err);
  switch (sdkError.code) {
    case "SLIPPAGE_EXCEEDED": ...
    case "DEADLINE_EXCEEDED": ...
    case "CIRCUIT_BREAKER": ...
  }
}
```

`mapError()` also auto-detects Soroban contract error codes from RPC error messages and maps them to the correct typed error.

### 7. Network Configuration

**New `STAGING` network in v2:**

```ts
enum Network {
  TESTNET = "testnet",
  MAINNET = "mainnet",
  STAGING = "staging", // NEW
}
```

**`NetworkConfig` extended:**

```ts
interface NetworkConfig {
  rpcUrl: string;
  networkPassphrase: string;
  factoryAddress: string;
  routerAddress: string;
  limitOrderAddress?: string; // NEW
  sorobanTimeout: number;
}
```

---

## New Modules (v2)

All new modules are exported from `@coralswap/sdk` and require no additional setup beyond passing the `CoralSwapClient` instance.

| Module | Export | Description |
|--------|--------|-------------|
| Token List | `TokenListModule` | Fetch, validate, and manage token lists |
| Factory | `FactoryModule` | Cached pair address lookups and pair info |
| Router | `RouterModule` | Multi-hop path finding and routing |
| Treasury | `TreasuryModule` | Protocol treasury balance, allocation, revenue |
| Staking | `StakingModule` | LP token staking, rewards, cooldown |
| Governance | `GovernanceModule` | Proposal creation, voting, delegation |
| Limit Orders | `LimitOrderModule` | On-chain limit order placement & management |
| DCA | `DCAModule` | Dollar-cost averaging strategies |
| Stop Loss | `StopLossModule` | Stop-loss order management |
| Positions | `PositionsModule` | Enriched LP position tracking |
| Alerts | `AlertsModule` | Configurable monitoring alerts |
| Webhooks | `WebhooksModule` | Webhook delivery management |
| Monitoring | `MonitoringModule` | Dashboard and metric queries |
| Tax Reporting | `TaxReportingModule` | Tax calculation utilities |

**Example — Treasury:**
```ts
import { TreasuryModule } from "@coralswap/sdk";

const treasury = new TreasuryModule(client, {
  stableAddresses: ["C...USDC"],
});
const balance = await treasury.getTreasuryBalance();
console.log("Treasury total USD:", balance.totalUSD);
```

**Example — Staking:**
```ts
import { StakingModule } from "@coralswap/sdk";

const staking = new StakingModule(client);
const txHash = await staking.stake(lpTokenAddr, 1000n, signer);
const rewards = await staking.getStakingRewards(myAddr, lpTokenAddr);
```

**Example — Governance:**
```ts
import { GovernanceModule } from "@coralswap/sdk";

const governance = new GovernanceModule(client, contractAddress);
const proposalId = await governance.createProposal(
  "Update fee parameters",
  "Proposal to adjust dynamic fee bounds...",
  actions,
  signer,
);
```

---

## Deprecated APIs & Removal Timeline

| API | v2 Status | Replacement | Planned Removal |
|-----|-----------|-------------|-----------------|
| `secretKey` only config | Fully supported | — | No removal planned |
| Legacy `simulateTransaction(ops, source)` | Supported (overloaded) | Enhanced form with options object | v3 |
| Manual `instanceof` error checks | Supported | `mapError()` utility | v3 (soft deprecation) |
| Direct `Contract` / `xdr` construction for swaps | Supported | `SwapModule` high-level API | v3 |
| `getAddLiquidityQuote` with 4th param (`amountBDesired`) | Removed | Omit param — amountB is computed optimally | Removed in v2 |

---

## Step-by-Step Upgrade Instructions

### 1. Update Package

```bash
npm install @coralswap/sdk@^2.0.0
```

### 2. Review Client Instantiation

Check every place you create a `CoralSwapClient`. If you pass `secretKey`, no changes needed. If you were constructing raw `Transaction` objects manually, consider using the new `submitTransaction()` method.

### 3. Update Swap Calls

If you use multi-hop, add the `path` field to your `SwapRequest`. Otherwise the existing API is backward compatible.

Before (v1):
```ts
const quote = await swap.getQuote({
  tokenIn, tokenOut, amount, tradeType, slippageBps, deadline,
});
```

After (v2, no multi-hop):
```ts
// Same API — no changes needed
const quote = await swap.getQuote({
  tokenIn, tokenOut, amount, tradeType, slippageBps, deadline,
});
```

### 4. Update Liquidity Calls

Remove the 4th argument from `getAddLiquidityQuote()`:

Before (v1):
```ts
const quote = await liquidity.getAddLiquidityQuote(
  tokenA, tokenB, amountADesired, amountBDesired,
);
```

After (v2):
```ts
const quote = await liquidity.getAddLiquidityQuote(
  tokenA, tokenB, amountADesired, // amountBDesired removed
);
```

### 5. Adopt Enhanced Error Handling (Optional)

Replace `instanceof` chains with `mapError()` for future-proofing:

```ts
import { mapError } from "@coralswap/sdk";

try { await swap.execute(request); }
catch (err) {
  const e = mapError(err);
  if (e.code === "SLIPPAGE_EXCEEDED") { ... }
}
```

### 6. Explore New Modules

Take advantage of v2 modules. Import them directly:

```ts
import {
  CoralSwapClient,
  TreasuryModule,
  StakingModule,
  GovernanceModule,
  PositionsModule,
} from "@coralswap/sdk";
```

---

## FAQ

### Q: Is `secretKey` still supported?

Yes. The `secretKey` option in `CoralSwapConfig` continues to work exactly as before. The new `signer` interface is additive — existing code needs no changes.

### Q: Do I need to install any additional dependencies for v2?

No. All v2 modules are included in the `@coralswap/sdk` package. No additional npm packages are required.

### Q: My swap stopped working — what should I check?

- Verify that `SwapRequest.amount` is a `bigint`, not a `number` or `string`.
- If using multi-hop, ensure `path` has at least 3 elements and all intermediate pairs exist.
- Check that the `deadline` is a future Unix timestamp (in seconds).
- If you removed the 4th argument from `getAddLiquidityQuote()`, that is expected — amountB is now computed automatically.

### Q: How do I handle the new `CircuitBreakerError`?

```ts
try {
  await swap.execute(request);
} catch (err) {
  const e = mapError(err);
  if (e instanceof CircuitBreakerError) {
    // Pool is paused — display message and retry later
    console.log(`Pool ${e.details?.pairAddress} is paused`);
  }
}
```

### Q: Can I still use the legacy `simulateTransaction` form?

Yes. Passing a `string` (or `undefined`) as the second argument triggers the legacy code path that returns the raw `SorobanRpc.Api.SimulateTransactionResponse`. Pass an empty options object `{}` to receive the enhanced `SimulateTransactionResult`.

### Q: Are the new modules (Treasury, Staking, Governance) usable without on-chain contract deployments?

The modules provide TypeScript interfaces and call patterns, but they require corresponding CoralSwap contracts to be deployed on the target network. See the contract deployment guide for details.

### Q: What happened to `amountBDesired` in `getAddLiquidityQuote`?

The parameter was removed in v2. The SDK now computes the optimal `amountB` from the current pool reserves automatically. If you need to specify both amounts, call `addLiquidity()` directly with `AddLiquidityRequest`.

### Q: How do I run integration tests after upgrading?

```bash
npm run test:integration
```

Ensure your test environment variables (`TEST_KEYPAIR`, `TEST_TOKEN_A`, `TEST_TOKEN_B`) are set as before. The test suite is unchanged in v2.
