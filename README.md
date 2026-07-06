# @coralswap/sdk

TypeScript SDK for the CoralSwap Protocol -- a V2 AMM on Stellar/Soroban with dynamic fees and flash loans.

> **Upgrading from v1?** See the [Migration Guide](./MIGRATION.md) for breaking changes, before/after examples, and step-by-step instructions.

## Architecture

**Contract-first, API-optional.** This SDK interacts directly with CoralSwap's Soroban smart contracts through Soroban RPC. No centralized API gateway, no API keys, no single points of failure.

```
Application
    |
@coralswap/sdk
    |
Soroban RPC (direct)
    |
CoralSwap Contracts (on-chain)
```

## Installation

```bash
npm install @coralswap/sdk
```

## Quick Start

### Installation

```bash
npm install @coralswap/sdk
```

### Basic Setup

```typescript
import { CoralSwapClient, Network } from "@coralswap/sdk";

// Initialize the client
const client = new CoralSwapClient({
  network: Network.TESTNET,
  rpcUrl: "https://soroban-testnet.stellar.org",
  secretKey: "S...", // Your secret key
});

// Check health
const healthy = await client.isHealthy();
console.log("RPC healthy:", healthy);
```

### Swap Tokens

```typescript
import { SwapModule, TradeType, toSorobanAmount } from "@coralswap/sdk";

const swap = new SwapModule(client);

// Get a quote for swapping 0.1 TokenA for TokenB
const quote = await swap.getQuote({
  tokenIn: "CDLZ...", // TokenA contract address
  tokenOut: "CBQH...", // TokenB contract address
  amount: toSorobanAmount("0.1", 7), // 0.1 tokens with 7 decimals
  tradeType: TradeType.EXACT_IN,
  slippageBps: 50, // 0.5% slippage tolerance
});

console.log("Expected output:", quote.amountOut);
console.log("Dynamic fee:", quote.feeBps, "bps");
console.log("Price impact:", quote.priceImpactBps, "bps");

// Execute the swap
const result = await swap.execute({
  tokenIn: "CDLZ...",
  tokenOut: "CBQH...",
  amount: toSorobanAmount("0.1", 7),
  tradeType: TradeType.EXACT_IN,
  slippageBps: 50,
  deadline: Math.floor(Date.now() / 1000) + 60, // 1 minute deadline
});

console.log("Transaction hash:", result.hash);
```

### Add Liquidity

```typescript
import { LiquidityModule, toSorobanAmount } from "@coralswap/sdk";

const liquidity = new LiquidityModule(client);

// Get a quote for adding liquidity
const quote = await liquidity.getAddLiquidityQuote(
  "CDLZ...", // TokenA contract address
  "CBQH...", // TokenB contract address
  toSorobanAmount("100", 7), // 100 TokenA
  toSorobanAmount("200", 7), // 200 TokenB
);

console.log("Amount A needed:", quote.amountA);
console.log("Amount B needed:", quote.amountB);
console.log("LP tokens to receive:", quote.liquidity);

// Add liquidity to the pool
const result = await liquidity.addLiquidity({
  tokenA: "CDLZ...",
  tokenB: "CBQH...",
  amountADesired: quote.amountA,
  amountBDesired: quote.amountB,
  amountAMin: (quote.amountA * 99n) / 100n, // 1% slippage
  amountBMin: (quote.amountB * 99n) / 100n, // 1% slippage
  to: client.publicKey,
  deadline: Math.floor(Date.now() / 1000) + 300, // 5 minutes deadline
});

console.log("Transaction hash:", result.hash);
```

### Remove Liquidity

```typescript
// Get a quote for removing liquidity
const quote = await liquidity.getRemoveLiquidityQuote(
  "CDLZ...", // TokenA contract address
  "CBQH...", // TokenB contract address
  toSorobanAmount("50", 7), // 50 LP tokens
);

console.log("Amount A to receive:", quote.amountA);
console.log("Amount B to receive:", quote.amountB);

// Remove liquidity from the pool
const result = await liquidity.removeLiquidity({
  tokenA: "CDLZ...",
  tokenB: "CBQH...",
  liquidity: toSorobanAmount("50", 7), // 50 LP tokens
  amountAMin: (quote.amountA * 99n) / 100n, // 1% slippage
  amountBMin: (quote.amountB * 99n) / 100n, // 1% slippage
  to: client.publicKey,
  deadline: Math.floor(Date.now() / 1000) + 300, // 5 minutes deadline
});

console.log("Transaction hash:", result.hash);
```

## Modules

### Swap

```typescript
import { SwapModule, TradeType } from "@coralswap/sdk";

const swap = new SwapModule(client);

// Get a quote
const quote = await swap.getQuote({
  tokenIn: "CDLZ...",
  tokenOut: "CBQH...",
  amount: 1000000n, // 0.1 tokens (7 decimals)
  tradeType: TradeType.EXACT_IN,
  slippageBps: 50, // 0.5%
});

console.log("Expected output:", quote.amountOut);
console.log("Dynamic fee:", quote.feeBps, "bps");
console.log("Price impact:", quote.priceImpactBps, "bps");

// Execute the swap
const result = await swap.execute({
  tokenIn: "CDLZ...",
  tokenOut: "CBQH...",
  amount: 1000000n,
  tradeType: TradeType.EXACT_IN,
});
```

### Liquidity

```typescript
import { LiquidityModule, toSorobanAmount } from "@coralswap/sdk";

const liquidity = new LiquidityModule(client);

// Get add-liquidity quote
const quote = await liquidity.getAddLiquidityQuote(
  "CDLZ...",
  "CBQH...",
  toSorobanAmount("100", 7),
);

// Add liquidity
const result = await liquidity.addLiquidity({
  tokenA: "CDLZ...",
  tokenB: "CBQH...",
  amountADesired: quote.amountA,
  amountBDesired: quote.amountB,
  amountAMin: (quote.amountA * 99n) / 100n,
  amountBMin: (quote.amountB * 99n) / 100n,
  to: client.publicKey,
});
```

### Flash Loans

```typescript
import { FlashLoanModule } from "@coralswap/sdk";

const flash = new FlashLoanModule(client);

// Estimate fee
const fee = await flash.estimateFee(pairAddress, tokenAddress, 1000000000n);
console.log("Flash loan fee:", fee.feeAmount, "(", fee.feeBps, "bps)");

// Execute flash loan
const result = await flash.execute({
  pairAddress: "CDLZ...",
  token: "CBQH...",
  amount: 1000000000n,
  receiverAddress: "CXYZ...", // Your flash receiver contract
  callbackData: Buffer.from("{}"),
});
```

### Dynamic Fees

```typescript
import { FeeModule } from "@coralswap/sdk";

const fees = new FeeModule(client);

// Get current fee for a pair
const estimate = await fees.getCurrentFee(pairAddress);
console.log("Current fee:", estimate.currentFeeBps, "bps");
console.log("Stale?", estimate.isStale);

// Compare fees across pairs
const comparison = await fees.compareFees([pair1, pair2, pair3]);
```

### TWAP Oracle

```typescript
import { OracleModule } from "@coralswap/sdk";

const oracle = new OracleModule(client);

// Record observations over time
await oracle.observe(pairAddress);
// ... wait some time ...
await oracle.observe(pairAddress);

// Get TWAP
const twap = await oracle.getTWAP(pairAddress);
if (twap) {
  console.log("TWAP price0:", twap.price0TWAP);
  console.log("Time window:", twap.timeWindow, "seconds");
}
```

## Native XLM

The SDK supports the native Stellar asset (XLM) via the Stellar Asset Contract (SAC). You can pass `"XLM"` or `"native"` as a token identifier in swap and multi-hop methods; it is resolved to the network’s XLM SAC address automatically.

```typescript
import { getNativeAssetContractAddress, resolveTokenIdentifier, isNativeToken } from "@coralswap/sdk";

// Resolve "XLM" to the SAC contract address for the current network
const passphrase = client.networkConfig.networkPassphrase;
const xlmAddress = getNativeAssetContractAddress(passphrase);

// Or resolve any identifier (e.g. "XLM" or a contract address)
const resolved = resolveTokenIdentifier("XLM", passphrase);

// Check if an identifier is native XLM
if (isNativeToken("XLM")) {
  // use resolved address for contract calls
}
```

Swap and multi-hop methods accept `"XLM"` as `tokenIn`/`tokenOut` or as an element in `path`; no need to look up the SAC address when using the high-level API.

## Utilities

```typescript
import {
  toSorobanAmount,
  fromSorobanAmount,
  formatAmount,
  sortTokens,
  isValidAddress,
  withRetry,
} from "@coralswap/sdk";

// Amount conversions
const amount = toSorobanAmount("1.5", 7); // 15000000n
const display = fromSorobanAmount(15000000n, 7); // "1.5000000"
const formatted = formatAmount(15000000n, 7, 2); // "1.50"

// Address utilities
const [token0, token1] = sortTokens(tokenA, tokenB);
const valid = isValidAddress("GABC...");

// Retry with backoff
const result = await withRetry(() => client.factory.getAllPairs(), {
  maxRetries: 5,
  baseDelayMs: 500,
});
```

## Error Handling

```typescript
import {
  CoralSwapSDKError,
  SlippageError,
  DeadlineError,
  InsufficientLiquidityError,
  mapError,
} from "@coralswap/sdk";

try {
  await swap.execute(request);
} catch (err) {
  const sdkError = mapError(err);

  switch (sdkError.code) {
    case "SLIPPAGE_EXCEEDED":
      console.log("Increase slippage tolerance");
      break;
    case "DEADLINE_EXCEEDED":
      console.log("Transaction expired, retry");
      break;
    case "INSUFFICIENT_LIQUIDITY":
      console.log("Not enough liquidity");
      break;
    default:
      console.error("Unexpected:", sdkError.message);
  }
}
```

## Performance

High-throughput integrations (trading bots, aggregators, dashboards) should tune caching, RPC failover, and connection pooling. See **[docs/PERFORMANCE.md](docs/PERFORMANCE.md)** for use-case profiles, TTL guidance, benchmark numbers, and copy-paste configuration examples.

## Design Principles

| Principle      | Implementation                                 |
| -------------- | ---------------------------------------------- |
| Contract-first | Direct Soroban RPC, no API gateway             |
| Type-safe      | Full TypeScript with BigInt for i128           |
| Trustless      | No API keys, no centralized dependencies       |
| Modular        | Import only what you need                      |
| Testable       | Pure math functions, mockable contract clients |
| Resilient      | Built-in retry with exponential backoff        |

## Integration Tests

The integration suite runs the full add-liquidity → swap → remove-liquidity lifecycle against real testnet contracts.

### Running locally

1. Fund a testnet account at [https://friendbot.stellar.org](https://friendbot.stellar.org).
2. Deploy (or note the addresses of) two SEP-41 tokens on testnet.
3. Export the required environment variables:

```bash
export STELLAR_TESTNET=true
export TEST_KEYPAIR=S...          # funded testnet secret key
export TEST_TOKEN_A=C...          # contract address of token A
export TEST_TOKEN_B=C...          # contract address of token B
# optional — defaults to https://soroban-testnet.stellar.org
export TEST_RPC_URL=https://...
```

4. Run:

```bash
npm run test:integration
```

The tests are idempotent — if the pair already exists it is reused, so you can run the suite multiple times without conflicts.

### CI

Integration tests run automatically on pull requests to `main` via `.github/workflows/integration.yml`. The job is marked `continue-on-error` for fork PRs (which cannot access repository secrets), so they will not block merges from external contributors.

Add the following secrets to your repository (Settings → Secrets → Actions):

| Secret | Description |
|---|---|
| `TEST_KEYPAIR` | Funded testnet secret key |
| `TEST_TOKEN_A` | Testnet token A contract address |
| `TEST_TOKEN_B` | Testnet token B contract address |

## Architecture Decision Records

- [ADR-001 Module Boundary Decisions](docs/adr/ADR-001-module-boundaries.md)
- [ADR-002 Error Handling Strategy](docs/adr/ADR-002-error-handling.md)
- [ADR-003 Caching Approach](docs/adr/ADR-003-caching-approach.md)

## License

MIT
