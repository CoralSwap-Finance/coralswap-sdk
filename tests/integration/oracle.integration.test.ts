import { CoralSwapClient } from '../../src/client';
import { Network } from '../../src/types/common';
import { OracleModule, TWAPObservation } from '../../src/modules/oracle';
import { LiquidityModule } from '../../src/modules/liquidity';
import { SwapModule } from '../../src/modules/swap';
import { TradeType } from '../../src/types/common';
import { toSorobanAmount } from '../../src/utils/amounts';

/**
 * Integration test: Oracle TWAP and volatility scoring against real testnet data.
 *
 * Prerequisites (set via env vars):
 *   STELLAR_TESTNET  – must be 'true' to run
 *   TEST_KEYPAIR     – funded testnet secret key (S...)
 *   TEST_TOKEN_A     – contract address of token A
 *   TEST_TOKEN_B     – contract address of token B
 *   TEST_RPC_URL     – optional RPC override
 *
 * Idempotent: reuses an existing pair and existing liquidity. Does not
 * remove any liquidity or perform cleanup — observations are read-only
 * after the initial setup.
 */

const SKIP = process.env.STELLAR_TESTNET !== 'true';

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

/** Simple sleep helper for collecting observations over time. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const describeIntegration = SKIP ? describe.skip : describe;

describeIntegration('OracleModule (testnet)', () => {
  let client: CoralSwapClient;
  let oracle: OracleModule;
  let liquidity: LiquidityModule;
  let swap: SwapModule;
  let tokenA: string;
  let tokenB: string;
  let pairAddress: string;

  const AMOUNT_A = toSorobanAmount('1', 7);
  const SLIPPAGE_BPS = 200; // 2% — generous for testnet

  beforeAll(async () => {
    client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: requireEnv('TEST_KEYPAIR'),
      ...(process.env.TEST_RPC_URL ? { rpcUrl: process.env.TEST_RPC_URL } : {}),
    });
    tokenA = requireEnv('TEST_TOKEN_A');
    tokenB = requireEnv('TEST_TOKEN_B');
    oracle = new OracleModule(client);
    liquidity = new LiquidityModule(client);
    swap = new SwapModule(client);
  });

  // -------------------------------------------------------------------------
  // Setup: ensure pair exists with liquidity so cumulative prices are non-zero
  // -------------------------------------------------------------------------
  it('resolves or creates the token pair with liquidity', async () => {
    let addr = await client.getPairAddress(tokenA, tokenB);
    if (!addr) {
      const op = client.factory.buildCreatePair(client.publicKey, tokenA, tokenB);
      const result = await client.submitTransaction([op]);
      expect(result.success).toBe(true);
      addr = await client.getPairAddress(tokenA, tokenB);
    }
    expect(addr).toBeTruthy();
    pairAddress = addr!;

    // Add liquidity if the pair is empty (LP balance == 0)
    const lpAddr = await client.pair(pairAddress).getLPTokenAddress();
    const lpBalance = await client.lpToken(lpAddr).balance(client.publicKey);
    if (lpBalance === 0n) {
      const quote = await liquidity.getAddLiquidityQuote(tokenA, tokenB, AMOUNT_A);
      const result = await liquidity.addLiquidity({
        tokenA,
        tokenB,
        amountADesired: quote.amountA,
        amountBDesired: quote.amountB,
        amountAMin: (quote.amountA * BigInt(10000 - SLIPPAGE_BPS)) / 10000n,
        amountBMin: (quote.amountB * BigInt(10000 - SLIPPAGE_BPS)) / 10000n,
        to: client.publicKey,
        deadline: client.getDeadline(300),
      });
      expect(result.txHash).toBeTruthy();
    }

    // Perform a small swap to ensure cumulative price accumulators advance
    // after the initial liquidity provision.
    const swapAmount = toSorobanAmount('0.01', 7);
    const quote = await swap.getQuote({
      tokenIn: tokenA,
      tokenOut: tokenB,
      amount: swapAmount,
      tradeType: TradeType.EXACT_IN,
      slippageBps: SLIPPAGE_BPS,
    });
    expect(quote.amountOut).toBeGreaterThan(0n);

    const swapResult = await swap.execute({
      tokenIn: tokenA,
      tokenOut: tokenB,
      amount: swapAmount,
      tradeType: TradeType.EXACT_IN,
      slippageBps: SLIPPAGE_BPS,
      deadline: client.getDeadline(60),
    });
    expect(swapResult.txHash).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // TWAP computation against real deployed oracle-backed pool
  // -------------------------------------------------------------------------
  it('computes TWAP from real testnet pair cumulative price observations', async () => {
    // Clear any stale cache from prior runs
    oracle.clearCache(pairAddress);
    expect(oracle.getObservationCount(pairAddress)).toBe(0);

    // First observation
    const obs1 = await oracle.observe(pairAddress);
    expect(obs1.blockTimestampLast).toBeGreaterThan(0);
    expect(obs1.price0CumulativeLast).toBeGreaterThan(0n);
    expect(obs1.price1CumulativeLast).toBeGreaterThan(0n);

    // Wait for the ledger to advance so the second observation has a
    // later timestamp (testnet ledger closes ~5 s).
    await sleep(6_000);

    // Execute another small swap to advance cumulative prices so we
    // get a meaningful (non-zero) TWAP delta.
    const swapAmount = toSorobanAmount('0.005', 7);
    const quote = await swap.getQuote({
      tokenIn: tokenA,
      tokenOut: tokenB,
      amount: swapAmount,
      tradeType: TradeType.EXACT_IN,
      slippageBps: SLIPPAGE_BPS,
    });
    expect(quote.amountOut).toBeGreaterThan(0n);

    const swapResult = await swap.execute({
      tokenIn: tokenA,
      tokenOut: tokenB,
      amount: swapAmount,
      tradeType: TradeType.EXACT_IN,
      slippageBps: SLIPPAGE_BPS,
      deadline: client.getDeadline(60),
    });
    expect(swapResult.txHash).toBeTruthy();

    // Second observation
    const obs2 = await oracle.observe(pairAddress);
    expect(obs2.blockTimestampLast).toBeGreaterThan(obs1.blockTimestampLast);

    // Compute TWAP
    const twap = oracle.computeTWAP(obs1, obs2);

    // TWAP must be non-zero because cumulative prices advanced
    expect(twap.price0TWAP).toBeGreaterThan(0n);
    expect(twap.price1TWAP).toBeGreaterThan(0n);
    expect(twap.timeWindow).toBeGreaterThan(0);

    // TWAP values should be reasonable — not astronomically large
    // (the price accumulator grows with reserves * time, so TWAP should
    // be in the general order of the pool's reserves).
    expect(twap.price0TWAP).toBeLessThan(10n ** 30n);
    expect(twap.price1TWAP).toBeLessThan(10n ** 30n);
  });

  it('getTWAP returns a full TWAPResult with correct structure after observations', async () => {
    oracle.clearCache(pairAddress);

    // Seed two observations so getTWAP has enough data
    await oracle.observe(pairAddress);
    await sleep(6_000);
    await oracle.observe(pairAddress);

    const result = await oracle.getTWAP(pairAddress);
    expect(result).not.toBeNull();

    // Verify the result has all expected fields
    expect(result!.pairAddress).toBe(pairAddress);
    expect(result!.token0).toBeTruthy();
    expect(result!.token1).toBeTruthy();
    expect(result!.timeWindow).toBeGreaterThan(0);
    expect(result!.price0TWAP).toBeDefined();
    expect(result!.price1TWAP).toBeDefined();
    expect(result!.startObservation.blockTimestampLast).toBeGreaterThan(0);
    expect(result!.endObservation.blockTimestampLast).toBeGreaterThan(
      result!.startObservation.blockTimestampLast,
    );
  });

  // -------------------------------------------------------------------------
  // Volatility score computation from real price history
  // -------------------------------------------------------------------------
  it('produces a sane volatility score from real price history observations', async () => {
    oracle.clearCache(pairAddress);

    // Collect multiple observations spread over time.  Each observe()
    // call reads fresh cumulative prices from the on-chain pair contract.
    // We collect at least 4 observations to get a meaningful std-dev.
    //
    // Retry helper: wait for the on-chain timestamp to advance so
    // consecutive observations have strictly increasing timestamps.
    async function waitForTimestampAdvance(prevTs: number): Promise<number> {
      for (let attempt = 0; attempt < 10; attempt++) {
        await sleep(3_000);
        const obs = await oracle.observe(pairAddress);
        if (obs.blockTimestampLast > prevTs) return obs.blockTimestampLast;
      }
      throw new Error('Timestamp did not advance after 10 retries (30 s)');
    }

    const SWAP_AMOUNT = toSorobanAmount('0.003', 7);

    // First observation (baseline timestamp)
    const initialObs = await oracle.observe(pairAddress);
    let lastTs = initialObs.blockTimestampLast;

    for (let i = 1; i < 4; i++) {
      // Perform a small swap to advance cumulative prices
      const quote = await swap.getQuote({
        tokenIn: tokenA,
        tokenOut: tokenB,
        amount: SWAP_AMOUNT,
        tradeType: TradeType.EXACT_IN,
        slippageBps: SLIPPAGE_BPS,
      });
      if (quote.amountOut > 0n) {
        await swap.execute({
          tokenIn: tokenA,
          tokenOut: tokenB,
          amount: SWAP_AMOUNT,
          tradeType: TradeType.EXACT_IN,
          slippageBps: SLIPPAGE_BPS,
          deadline: client.getDeadline(60),
        });
      }

      // Wait for the on-chain timestamp to actually advance
      lastTs = await waitForTimestampAdvance(lastTs);
    }

    const series = oracle.getObservationSeries(pairAddress);
    expect(series.length).toBeGreaterThanOrEqual(4);

    // ── Compute a simple volatility score from the observation series ──
    // We derive per-observation "instantaneous price" deltas by computing
    // the cumulative price change between consecutive observations,
    // normalised by the time delta.  Then we compute the standard
    // deviation of those deltas, scaled up to a human-readable score.
    const deltas: bigint[] = [];
    for (let i = 1; i < series.length; i++) {
      const prev = series[i - 1];
      const curr = series[i];
      const timeDelta = curr.blockTimestampLast - prev.blockTimestampLast;
      if (timeDelta <= 0) continue;

      // price-per-second delta for token0 (normalised)
      const priceDelta =
        (curr.price0CumulativeLast - prev.price0CumulativeLast) /
        BigInt(timeDelta);
      deltas.push(priceDelta);
    }

    expect(deltas.length).toBeGreaterThanOrEqual(1);

    // Mean of deltas
    const sum = deltas.reduce((a, b) => a + b, 0n);
    const mean = sum / BigInt(deltas.length);

    // Variance = average of squared deviation from mean
    const squaredDiffs = deltas.map((d) => {
      const diff = d - mean;
      return diff * diff;
    });
    const varianceSum = squaredDiffs.reduce((a, b) => a + b, 0n);
    const variance = varianceSum / BigInt(squaredDiffs.length);

    // Standard deviation (integer square root approximation via Math.sqrt
    // cast through Number — safe here because variance is within safe
    // integer range for typical pool reserves).
    const varianceNum = Number(variance);
    const stdDev = Math.sqrt(varianceNum);

    // Volatility score as an integer (scaled std-dev)
    const volatilityScore = Math.round(stdDev);

    // ── Assertions ──
    // Sane: not NaN
    expect(Number.isNaN(volatilityScore)).toBe(false);
    // Sane: not Infinity
    expect(Number.isFinite(volatilityScore)).toBe(true);
    // Sane: non-negative
    expect(volatilityScore).toBeGreaterThanOrEqual(0);
    // Sane: non-placeholder — an active pool with swaps between
    // observations must produce a non-zero volatility score.
    expect(volatilityScore).toBeGreaterThan(0);
    // Upper bound sanity — for testnet pools the volatility shouldn't
    // exceed 10^12 (scaled price-per-second)
    expect(volatilityScore).toBeLessThan(10 ** 12);

    // Verify the observation timestamps are strictly increasing (data
    // integrity check).
    for (let i = 1; i < series.length; i++) {
      expect(series[i].blockTimestampLast).toBeGreaterThan(
        series[i - 1].blockTimestampLast,
      );
    }

    // Verify each cumulative price is non-decreasing (monotonic
    // accumulator property of Soroban pair contracts).
    for (let i = 1; i < series.length; i++) {
      expect(series[i].price0CumulativeLast).toBeGreaterThanOrEqual(
        series[i - 1].price0CumulativeLast,
      );
      expect(series[i].price1CumulativeLast).toBeGreaterThanOrEqual(
        series[i - 1].price1CumulativeLast,
      );
    }
  });
});
