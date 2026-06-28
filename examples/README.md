# CoralSwap SDK — Examples

Each example in this directory is a runnable TypeScript script that demonstrates a specific feature of the CoralSwap SDK.  All scripts load configuration from a `.env` file in the project root — copy `.env.example` and fill in the values before running.

```bash
cp .env.example .env   # then edit .env with your keys and addresses
```

---

## Examples

### `simple-swap.ts`

**Run:** `npm run examples:simple-swap`

Demonstrates the minimal client setup needed to look up a pair address. A good starting point for understanding how `CoralSwapClient` is initialised and how the factory module resolves token pairs.

---

### `provide-liquidity.ts`

**Run:** `npm run examples:provide-liquidity`

Shows the pattern for querying a pair before calling liquidity helpers. Extend this script once `LiquidityModule.addLiquidity` / `removeLiquidity` are available in your deployment.

---

### `read-reserves.ts`

**Run:** `npm run examples:read-reserves`

Reads live on-chain state (reserves, fee parameters, pool info) from a deployed pair contract. Useful for monitoring pool health or building dashboards without executing any transactions.

---

### `flash-loan-basic.ts`

**Run:** `npm run examples:flash-loan-basic`

Covers the full flash loan lifecycle: checking availability, estimating the fee, calculating repayment, and executing the atomic borrow/repay in a single transaction. Requires a deployed flash-receiver contract.

---

### `flash-loan-advanced.ts`

Advanced flash loan patterns including multi-asset strategies and custom callback data encoding. See the inline comments for an explanation of reentrancy constraints and the atomic execution model.

---

### `flash-loan-receiver-guide.ts`

A detailed guide to implementing the `on_flash_loan` callback in your own Soroban contract, including how to validate the caller, perform arbitrary logic with the borrowed funds, and return the principal plus fee before the transaction closes.

---

### `governance-vote.ts` ← **New**

**Run:** `npm run examples:governance-vote`

Walks through a full governance proposal lifecycle against a Soroban governance contract: create a proposal, query its status, cast a vote, inspect quorum, and execute the proposal once it passes. The script is intentionally configurable via environment variables so it can target a deployed governance contract on Stellar Testnet without hard-coding a single ABI.

---

### `rwa-pool.ts` ← **New**

**Run:** `npm run examples:rwa-pool`

**What are RWA pools?**

Real-World Asset (RWA) pools pair a tokenised off-chain instrument — here **deJTRSY**, a Centrifuge-issued tokenised U.S. Treasury bill — with a stablecoin (**USDC**).  No existing DeFi protocol on Stellar has shipped one; this example serves as reference documentation for institutional builders.

**Why RWA pools are different from standard AMM pools**

| Property | Standard pool (e.g. USDC/XLM) | RWA pool (USDC/deJTRSY) |
|---|---|---|
| Price anchor | Arbitrage only | Arbitrage **+** on-chain NAV oracle |
| Yield sources | Swap fees | Swap fees **+** T-bill yield (embedded in NAV) |
| Token value | Volatile / stable | Continuously appreciating (NAV rises daily) |
| Pair creation | `create_pair(tokenA, tokenB)` | `create_rwa_pair(tokenA, tokenB, navFeed)` |
| Swap quoting | AMM constant-product | AMM quote **+** NAV-adjusted fair-value check |

**What the example demonstrates**

1. **Pair creation with NAV price feed** — `client.factory.buildCreateRWAPair()` passes the RedStone oracle address as a third argument so the factory records it alongside the standard pool state.

2. **Add liquidity** — deposit USDC and deJTRSY at the current NAV-implied ratio so the pool starts at fair value.

3. **Combined APY query** — `getRWAPoolAPY()` from `src/rwa.ts` sums two components:
   - *Swap-fee APY* — annualised from the pool's dynamic fee rate and a conservative volume estimate.
   - *Underlying yield APY* — the current T-bill rate sourced from the RedStone NAV feed.

4. **NAV-adjusted swap quote** — compares the AMM constant-product output against the oracle-derived fair-value output to surface any pool–NAV divergence before a trade executes.

**Yield-bearing token mechanics (deJTRSY)**

deJTRSY is a *yield-bearing* token: unlike a simple stablecoin, its value in USDC increases every day as the underlying Treasury bills accrue interest.  Key implications for pool LPs:

- The pool spot price naturally drifts upward over time even without any trades.
- An LP holding deJTRSY inside the pool captures the T-bill yield passively through the rising NAV, in addition to the swap fees collected from traders.
- Swap quotes must reference the current NAV (not just reserves) to avoid paying stale prices for an appreciated asset.
- Arbitrageurs enforce NAV parity by buying cheap deJTRSY from the pool whenever the spot price lags the oracle.

**Required environment variables**

| Variable | Description | Default |
|---|---|---|
| `CORALSWAP_SECRET_KEY` | Signing key for the account submitting transactions | — |
| `CORALSWAP_PUBLIC_KEY` | Public key of the signing account | — |
| `CORALSWAP_RPC_URL` | Soroban RPC endpoint (optional) | testnet default |
| `CORALSWAP_NETWORK` | `testnet` or `mainnet` | `testnet` |
| `CORALSWAP_USDC` | USDC contract address | Testnet canonical |
| `CORALSWAP_RWA_TOKEN` | deJTRSY contract address | Centrifuge testnet |
| `CORALSWAP_NAV_FEED` | RedStone NAV oracle address | Testnet placeholder |
| `CORALSWAP_NAV_PER_TOKEN` | Current NAV per deJTRSY (7 dp) | `10520000` ($1.052) |
| `CORALSWAP_TBILL_YIELD_BPS` | Annualised T-bill yield in bps | `520` (5.20 %) |
| `CORALSWAP_LIQUIDITY_USDC` | USDC to deposit (7 dp) | `5000000_0000000` |
| `CORALSWAP_LIQUIDITY_RWA` | deJTRSY to deposit (7 dp) | `4752850_0000000` |
| `CORALSWAP_SWAP_AMOUNT` | USDC to swap in Step 4 (7 dp) | `100000_0000000` |

---

### `redstone-guarded-swap.ts` ← **New**

**Run:** `npm run examples:redstone-guarded-swap`

Demonstrates how to fetch a RedStone price attestation using a custom `price-feed.ts` module, and use it to execute a guarded swap. This is crucial for builders integrating price guards into their protocols.

**Flow:**
1. **Fetch**: Retrieves the latest RedStone attestation via the price feed module (avoiding raw API fetches).
2. **Check Deviation**: Retrieves an AMM quote from CoralSwap and checks the expected price against the oracle's price. If the deviation exceeds the maximum allowed (e.g., 1%), it catches the bad price locally rather than relying on an expensive on-chain revert.
3. **Attach & Submit**: If the price is within the acceptable threshold, it attaches the payload and submits the guarded swap to the Stellar Testnet.

The example simulates both a happy path (within deviation) and a failure case (simulated bad price).

---

## Common environment variables

All examples share these base variables:

| Variable | Description |
|---|---|
| `CORALSWAP_SECRET_KEY` | Stellar secret key (`S...`) for signing |
| `CORALSWAP_PUBLIC_KEY` | Corresponding public key (`G...`) |
| `CORALSWAP_RPC_URL` | Custom Soroban RPC URL (optional) |
| `CORALSWAP_NETWORK` | `testnet` (default) or `mainnet` |
| `CORALSWAP_TOKEN_A` | First token address for swap/liquidity examples |
| `CORALSWAP_TOKEN_B` | Second token address for swap/liquidity examples |
