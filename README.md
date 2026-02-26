# @coralswap/sdk

TypeScript SDK for the CoralSwap Protocol -- a V2 AMM on Stellar/Soroban with dynamic fees and flash loans.

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

## Design Principles

| Principle      | Implementation                                 |
| -------------- | ---------------------------------------------- |
| Contract-first | Direct Soroban RPC, no API gateway             |
| Type-safe      | Full TypeScript with BigInt for i128           |
| Trustless      | No API keys, no centralized dependencies       |
| Modular        | Import only what you need                      |
| Testable       | Pure math functions, mockable contract clients |
| Resilient      | Built-in retry with exponential backoff        |

## License

MIT
