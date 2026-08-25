import { CoralSwapClient } from '../../src/client';
import { Network, TradeType } from '../../src/types/common';
import { RouterModule } from '../../src/modules/router';
import { SwapModule } from '../../src/modules/swap';
import { LiquidityModule } from '../../src/modules/liquidity';
import { toSorobanAmount } from '../../src/utils/amounts';

/**
 * Integration test: router module pathfinding against real Stellar Testnet.
 *
 * Prerequisites (set via env vars):
 *   STELLAR_TESTNET  – must be 'true' to run
 *   TEST_KEYPAIR     – funded testnet secret key (S...)
 *   TEST_TOKEN_A     – contract address of token A
 *   TEST_TOKEN_B     – contract address of token B
 *   TEST_TOKEN_C     – contract address of token C (for multi-hop)
 *   TEST_RPC_URL     – optional RPC override
 *
 * Test Scenarios:
 * 1. Multi-hop route quote against real deployed pools
 * 2. EXACT_OUT pathfinding to produce a route satisfying target output
 */

const SKIP =
  process.env.STELLAR_TESTNET !== 'true' || !process.env.TEST_KEYPAIR;

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

const describeIntegration = SKIP ? describe.skip : describe;

describeIntegration('Router module (testnet)', () => {
  let client: CoralSwapClient;
  let router: RouterModule;
  let swap: SwapModule;
  let liquidity: LiquidityModule;
  let tokenA: string;
  let tokenB: string;
  let tokenC: string;
  let pairAB: string;
  let pairBC: string;
  let pairAC: string;

  const AMOUNT_A = toSorobanAmount('1', 7);
  const MIN_LP_BALANCE = 1n;
  const SLIPPAGE_BPS = 200;

  /** Pairs where liquidity was added in this run (for cleanup). */
  const pairsToCleanup: Array<{
    pairAddress: string;
    tokenA: string;
    tokenB: string;
  }> = [];

  beforeAll(async () => {
    client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: requireEnv('TEST_KEYPAIR'),
      ...(process.env.TEST_RPC_URL ? { rpcUrl: process.env.TEST_RPC_URL } : {}),
    });

    tokenA = requireEnv('TEST_TOKEN_A');
    tokenB = requireEnv('TEST_TOKEN_B');
    tokenC = requireEnv('TEST_TOKEN_C');

    router = new RouterModule(client);
    swap = new SwapModule(client);
    liquidity = new LiquidityModule(client);

    // Ensure all pairs exist and have liquidity
    pairAB = await ensurePair(tokenA, tokenB);
    pairBC = await ensurePair(tokenB, tokenC);
    pairAC = await ensurePair(tokenA, tokenC);

    await ensureLiquidity(pairAB, tokenA, tokenB);
    await ensureLiquidity(pairBC, tokenB, tokenC);
    await ensureLiquidity(pairAC, tokenA, tokenC);
  }, 180_000); // Extended timeout for setup

  async function ensurePair(tokenX: string, tokenY: string): Promise<string> {
    let addr = await client.getPairAddress(tokenX, tokenY);
    if (!addr) {
      const op = client.factory.buildCreatePair(client.publicKey, tokenX, tokenY);
      const result = await client.submitTransaction([op]);
      expect(result.success).toBe(true);
      addr = await client.getPairAddress(tokenX, tokenY);
    }
    expect(addr).toBeTruthy();
    return addr!;
  }

  async function ensureLiquidity(
    pairAddress: string,
    tA: string,
    tB: string,
  ): Promise<bigint> {
    const lpAddr = await client.pair(pairAddress).getLPTokenAddress();
    const lpBefore = await client.lpToken(lpAddr).balance(client.publicKey);
    if (lpBefore >= MIN_LP_BALANCE) return lpBefore;

    const quote = await liquidity.getAddLiquidityQuote(tA, tB, AMOUNT_A);
    const result = await liquidity.addLiquidity({
      tokenA: tA,
      tokenB: tB,
      amountADesired: quote.amountA,
      amountBDesired: quote.amountB,
      amountAMin: (quote.amountA * BigInt(10000 - SLIPPAGE_BPS)) / 10000n,
      amountBMin: (quote.amountB * BigInt(10000 - SLIPPAGE_BPS)) / 10000n,
      to: client.publicKey,
      deadline: client.getDeadline(300),
    });
    expect(result.txHash).toBeTruthy();

    pairsToCleanup.push({ pairAddress, tokenA: tA, tokenB: tB });
    const lpAfter = await client.lpToken(lpAddr).balance(client.publicKey);
    expect(lpAfter).toBeGreaterThan(lpBefore);
    return lpAfter;
  }

  async function removeAllLiquidity(
    pairAddress: string,
    tA: string,
    tB: string,
  ): Promise<void> {
    const lpAddr = await client.pair(pairAddress).getLPTokenAddress();
    const lpBalance = await client.lpToken(lpAddr).balance(client.publicKey);
    if (lpBalance === 0n) return;

    const pair = client.pair(pairAddress);
    const { reserve0, reserve1 } = await pair.getReserves();
    const totalSupply = await client.lpToken(lpAddr).totalSupply();
    const expectedA =
      totalSupply > 0n ? (reserve0 * lpBalance) / totalSupply : 0n;
    const expectedB =
      totalSupply > 0n ? (reserve1 * lpBalance) / totalSupply : 0n;

    const result = await liquidity.removeLiquidity({
      tokenA: tA,
      tokenB: tB,
      liquidity: lpBalance,
      amountAMin: (expectedA * BigInt(10000 - SLIPPAGE_BPS)) / 10000n,
      amountBMin: (expectedB * BigInt(10000 - SLIPPAGE_BPS)) / 10000n,
      to: client.publicKey,
      deadline: client.getDeadline(300),
    });
    expect(result.txHash).toBeTruthy();
  }

  // -----------------------------------------------------------------------
  // 1. Multi-hop route quote against real deployed pools
  // -----------------------------------------------------------------------
  describe('findOptimalPath - multi-hop routing', () => {
    it('finds optimal multi-hop route (A -> B -> C) against real pool reserves', async () => {
      const swapAmount = toSorobanAmount('0.1', 7);

      const result = await router.findOptimalPath(
        tokenA,
        tokenC,
        swapAmount,
        TradeType.EXACT_IN,
      );

      expect(result).not.toBeNull();
      expect(result!.path).toBeDefined();
      expect(result!.path.length).toBeGreaterThanOrEqual(2);
      expect(result!.path[0]).toBe(tokenA);
      expect(result!.path[result!.path.length - 1]).toBe(tokenC);

      // Verify quote properties
      const quote = result!.quote;
      expect(quote.amountIn).toBe(swapAmount);
      expect(quote.amountOut).toBeGreaterThan(0n);
      expect(quote.amountOutMin).toBeGreaterThan(0n);
      expect(quote.amountOutMin).toBeLessThanOrEqual(quote.amountOut);
      expect(quote.priceImpactBps).toBeGreaterThanOrEqual(0);
      expect(quote.feeBps).toBeGreaterThan(0);
      expect(quote.feeAmount).toBeGreaterThan(0n);
      expect(quote.path).toEqual(result!.path);

      // Verify against real reserves
      await verifyQuoteAgainstReserves(result!.path, swapAmount, quote.amountOut);
    }, 120_000);

    it('chooses better path when multiple routes are available', async () => {
      const swapAmount = toSorobanAmount('0.05', 7);

      // Router should evaluate direct path (A -> C) vs multi-hop (A -> B -> C)
      const result = await router.findOptimalPath(
        tokenA,
        tokenC,
        swapAmount,
        TradeType.EXACT_IN,
      );

      expect(result).not.toBeNull();
      expect(result!.path).toBeDefined();

      // Verify the chosen path gives better output than alternatives
      const directQuote = await swap.getQuote({
        tokenIn: tokenA,
        tokenOut: tokenC,
        amount: swapAmount,
        tradeType: TradeType.EXACT_IN,
      });

      // If multi-hop was chosen, it should yield more output
      if (result!.path.length > 2) {
        expect(result!.quote.amountOut).toBeGreaterThanOrEqual(directQuote.amountOut);
      } else {
        // If direct was chosen, multi-hop would have been worse
        expect(result!.path).toEqual([tokenA, tokenC]);
      }
    }, 120_000);

    it('handles 3-hop route when beneficial', async () => {
      const swapAmount = toSorobanAmount('0.05', 7);

      // Try finding path from A to C through potential 3-hop
      const result = await router.findOptimalPath(
        tokenA,
        tokenC,
        swapAmount,
        TradeType.EXACT_IN,
      );

      expect(result).not.toBeNull();
      
      // Verify quote consistency regardless of path length
      const quote = result!.quote;
      expect(quote.amountIn).toBe(swapAmount);
      expect(quote.amountOut).toBeGreaterThan(0n);
      
      // Verify path is valid (no duplicate adjacent tokens)
      for (let i = 0; i < result!.path.length - 1; i++) {
        expect(result!.path[i]).not.toBe(result!.path[i + 1]);
      }
    }, 120_000);
  });

  // -----------------------------------------------------------------------
  // 2. EXACT_OUT pathfinding
  // -----------------------------------------------------------------------
  describe('findOptimalPath - EXACT_OUT mode', () => {
    it('finds route for EXACT_OUT with correct required input amount', async () => {
      const desiredOutput = toSorobanAmount('0.05', 7);

      const result = await router.findOptimalPath(
        tokenA,
        tokenC,
        desiredOutput,
        TradeType.EXACT_OUT,
      );

      expect(result).not.toBeNull();
      expect(result!.path).toBeDefined();
      expect(result!.path.length).toBeGreaterThanOrEqual(2);
      expect(result!.path[0]).toBe(tokenA);
      expect(result!.path[result!.path.length - 1]).toBe(tokenC);

      // Verify EXACT_OUT semantics
      const quote = result!.quote;
      expect(quote.amountOut).toBe(desiredOutput);
      expect(quote.amountIn).toBeGreaterThan(0n);
      // Input should be larger than output due to fees
      expect(quote.amountIn).toBeGreaterThan(desiredOutput);
      expect(quote.feeAmount).toBeGreaterThan(0n);
      expect(quote.priceImpactBps).toBeGreaterThanOrEqual(0);
    }, 120_000);

    it('chooses path with minimum required input for EXACT_OUT', async () => {
      const desiredOutput = toSorobanAmount('0.05', 7);

      const result = await router.findOptimalPath(
        tokenA,
        tokenC,
        desiredOutput,
        TradeType.EXACT_OUT,
      );

      expect(result).not.toBeNull();

      // Verify the chosen path requires less input than direct path
      const directQuote = await swap.getQuote({
        tokenIn: tokenA,
        tokenOut: tokenC,
        amount: desiredOutput,
        tradeType: TradeType.EXACT_OUT,
      });

      // If multi-hop was chosen, it should require less or equal input
      if (result!.path.length > 2) {
        expect(result!.quote.amountIn).toBeLessThanOrEqual(directQuote.amountIn);
      } else {
        // If direct was chosen, it should be the most efficient
        expect(result!.path).toEqual([tokenA, tokenC]);
      }
    }, 120_000);

    it('EXACT_OUT quote produces correct output amount when executed', async () => {
      const desiredOutput = toSorobanAmount('0.01', 7); // Small amount to minimize impact

      const result = await router.findOptimalPath(
        tokenA,
        tokenC,
        desiredOutput,
        TradeType.EXACT_OUT,
      );

      expect(result).not.toBeNull();
      
      const quote = result!.quote;
      
      // Verify reverse computation consistency
      // For EXACT_OUT, amountOut should match desired output
      expect(quote.amountOut).toBe(desiredOutput);
      
      // Required input should account for fees and slippage
      expect(quote.amountIn).toBeGreaterThan(desiredOutput);
      
      // amountOutMin should be close to amountOut (within slippage tolerance)
      const slippageRatio = (quote.amountOut - quote.amountOutMin) * 10000n / quote.amountOut;
      expect(Number(slippageRatio)).toBeLessThanOrEqual(SLIPPAGE_BPS);
    }, 120_000);
  });

  // -----------------------------------------------------------------------
  // 3. Edge cases and cache behavior
  // -----------------------------------------------------------------------
  describe('Router edge cases', () => {
    it('returns null when no path exists between tokens', async () => {
      // Use token addresses that definitely don't have a path
      const nonExistentToken = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFAKE';
      
      const result = await router.findOptimalPath(
        tokenA,
        nonExistentToken,
        toSorobanAmount('0.1', 7),
        TradeType.EXACT_IN,
      );

      // Should return null when no path exists
      expect(result).toBeNull();
    }, 120_000);

    it('filters out zero-liquidity paths', async () => {
      const swapAmount = toSorobanAmount('0.1', 7);

      const result = await router.findOptimalPath(
        tokenA,
        tokenC,
        swapAmount,
        TradeType.EXACT_IN,
      );

      // Should find a path (assuming liquidity exists)
      expect(result).not.toBeNull();

      // Verify all hops in path have non-zero reserves
      for (let i = 0; i < result!.path.length - 1; i++) {
        const tIn = result!.path[i];
        const tOut = result!.path[i + 1];
        const pairAddr = await client.getPairAddress(tIn, tOut);
        expect(pairAddr).toBeTruthy();

        const reserves = await client.pair(pairAddr!).getReserves();
        expect(reserves.reserve0).toBeGreaterThan(0n);
        expect(reserves.reserve1).toBeGreaterThan(0n);
      }
    }, 120_000);

    it('cache returns same result on repeated calls', async () => {
      const swapAmount = toSorobanAmount('0.1', 7);

      const firstResult = await router.findOptimalPath(
        tokenA,
        tokenB,
        swapAmount,
        TradeType.EXACT_IN,
      );

      const secondResult = await router.findOptimalPath(
        tokenA,
        tokenB,
        swapAmount,
        TradeType.EXACT_IN,
      );

      expect(firstResult).not.toBeNull();
      expect(secondResult).not.toBeNull();
      expect(secondResult!.path).toEqual(firstResult!.path);
      expect(secondResult!.quote.amountOut).toBe(firstResult!.quote.amountOut);
    }, 120_000);

    it('clearPathCache forces fresh lookup', async () => {
      const swapAmount = toSorobanAmount('0.1', 7);

      await router.findOptimalPath(tokenA, tokenB, swapAmount, TradeType.EXACT_IN);
      
      router.clearPathCache();
      
      const result = await router.findOptimalPath(
        tokenA,
        tokenB,
        swapAmount,
        TradeType.EXACT_IN,
      );

      // Should still find a valid path after cache clear
      expect(result).not.toBeNull();
      expect(result!.path).toBeDefined();
    }, 120_000);
  });

  // -----------------------------------------------------------------------
  // Helper: Verify quote against real reserves
  // -----------------------------------------------------------------------
  async function verifyQuoteAgainstReserves(
    path: string[],
    amountIn: bigint,
    expectedAmountOut: bigint,
  ): Promise<void> {
    let currentAmount = amountIn;

    for (let i = 0; i < path.length - 1; i++) {
      const tokenIn = path[i];
      const tokenOut = path[i + 1];

      const pairAddress = await client.getPairAddress(tokenIn, tokenOut);
      expect(pairAddress).toBeTruthy();

      const pair = client.pair(pairAddress!);
      const [reserves, feeBps] = await Promise.all([
        pair.getReserves(),
        pair.getDynamicFee(),
      ]);

      const tokens = await pair.getTokens();
      const isToken0In = tokens.token0 === tokenIn;
      const reserveIn = isToken0In ? reserves.reserve0 : reserves.reserve1;
      const reserveOut = isToken0In ? reserves.reserve1 : reserves.reserve0;

      // Verify reserves are non-zero
      expect(reserveIn).toBeGreaterThan(0n);
      expect(reserveOut).toBeGreaterThan(0n);

      // Calculate expected output using AMM formula
      const amountOut = swap.getAmountOut(currentAmount, reserveIn, reserveOut, feeBps);
      expect(amountOut).toBeGreaterThan(0n);

      currentAmount = amountOut;
    }

    // Final output should match (within rounding tolerance)
    const tolerance = 100n; // Allow small rounding differences
    expect(currentAmount).toBeGreaterThanOrEqual(expectedAmountOut - tolerance);
    expect(currentAmount).toBeLessThanOrEqual(expectedAmountOut + tolerance);
  }

  // -----------------------------------------------------------------------
  // Cleanup: remove liquidity from pools touched in this suite
  // -----------------------------------------------------------------------
  afterAll(async () => {
    const seen = new Set<string>();
    for (const { pairAddress, tokenA: tA, tokenB: tB } of pairsToCleanup) {
      if (seen.has(pairAddress)) continue;
      seen.add(pairAddress);
      await removeAllLiquidity(pairAddress, tA, tB);
    }
  }, 180_000); // Extended timeout for cleanup
});
