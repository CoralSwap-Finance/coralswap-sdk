import { CoralSwapClient } from "../../src/client";
import { Network } from "../../src/types/common";
import { FeeModule } from "../../src/modules/fees";
import { LiquidityModule } from "../../src/modules/liquidity";
import { SwapModule } from "../../src/modules/swap";
import { TradeType } from "../../src/types/common";
import { toSorobanAmount } from "../../src/utils/amounts";

/**
 * Integration test: fee revenue and LP yield against real testnet pools.
 *
 * Prerequisites (set via env vars):
 *   STELLAR_TESTNET  – must be 'true' to run
 *   TEST_KEYPAIR     – funded testnet secret key (S...)
 *   TEST_TOKEN_A     – contract address of token A (used as $1 stable anchor)
 *   TEST_TOKEN_B     – contract address of token B
 *   TEST_RPC_URL     – optional RPC override
 *
 * Idempotent: reuses existing pairs and skips add-liquidity when LP balance
 * is already sufficient. Removes all LP added during the suite in afterAll.
 */

const SKIP = process.env.STELLAR_TESTNET !== "true";

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

const describeIntegration = SKIP ? describe.skip : describe;

describeIntegration("Fee module (testnet)", () => {
  let client: CoralSwapClient;
  let fees: FeeModule;
  let liquidity: LiquidityModule;
  let swap: SwapModule;
  let tokenA: string;
  let tokenB: string;
  let pairAB: string;

  const AMOUNT_A = toSorobanAmount("1", 7);
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
      secretKey: requireEnv("TEST_KEYPAIR"),
      ...(process.env.TEST_RPC_URL
        ? { rpcUrl: process.env.TEST_RPC_URL }
        : {}),
    });
    tokenA = requireEnv("TEST_TOKEN_A");
    tokenB = requireEnv("TEST_TOKEN_B");
    fees = new FeeModule(client);
    liquidity = new LiquidityModule(client);
    swap = new SwapModule(client);

    pairAB = await ensurePair(tokenA, tokenB);
    await ensureLiquidity(pairAB, tokenA, tokenB);
  });

  async function ensurePair(
    tokenX: string,
    tokenY: string,
  ): Promise<string> {
    let addr = await client.getPairAddress(tokenX, tokenY);
    if (!addr) {
      const op = client.factory.buildCreatePair(
        client.publicKey,
        tokenX,
        tokenY,
      );
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
      amountAMin:
        (quote.amountA * BigInt(10000 - SLIPPAGE_BPS)) / 10000n,
      amountBMin:
        (quote.amountB * BigInt(10000 - SLIPPAGE_BPS)) / 10000n,
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
  // 1. getFeeRevenue — returns fee revenue data for a real pool
  // -----------------------------------------------------------------------
  it("getFeeRevenue returns fee data for a real pool with swap history", async () => {
    // Execute a swap to generate fee revenue
    const swapAmount = toSorobanAmount("0.05", 7);
    const quote = await swap.getQuote({
      tokenIn: tokenB,
      tokenOut: tokenA,
      amount: swapAmount,
      tradeType: TradeType.EXACT_IN,
      slippageBps: SLIPPAGE_BPS,
    });
    expect(quote.amountOut).toBeGreaterThan(0n);

    const swapResult = await swap.execute({
      tokenIn: tokenB,
      tokenOut: tokenA,
      amount: swapAmount,
      tradeType: TradeType.EXACT_IN,
      slippageBps: SLIPPAGE_BPS,
      deadline: client.getDeadline(60),
    });
    expect(swapResult.txHash).toBeTruthy();

    // Now query fee revenue
    const revenue = await fees.getFeeRevenue(pairAB);

    expect(revenue.pairAddress).toBe(pairAB);
    expect(revenue.swapCount).toBeGreaterThanOrEqual(1);
    expect(revenue.totalFeeXLM).toBeGreaterThanOrEqual(0);

    // At least one history entry with the swap we just made
    expect(revenue.history.length).toBeGreaterThanOrEqual(1);
    for (const entry of revenue.history) {
      expect(entry.feeBps).toBeGreaterThan(0);
      expect(entry.feeXLM).toBeGreaterThanOrEqual(0);
      expect(entry.ledger).toBeGreaterThan(0);
    }
  });

  // -----------------------------------------------------------------------
  // 2. getLPYield — verifies LP yield calculation for an active pool
  // -----------------------------------------------------------------------
  it("getLPYield produces sane, non-zero output for an active pool with liquidity", async () => {
    const yieldResult = await fees.getLPYield(pairAB, client.publicKey);

    expect(yieldResult.pairAddress).toBe(pairAB);
    expect(yieldResult.lpAddress).toBe(client.publicKey);

    // LP should have a share since we ensured liquidity
    expect(yieldResult.lpSharePercent).toBeGreaterThan(0);

    // Total fee revenue should be tracked
    expect(typeof yieldResult.totalFeeRevenueXLM).toBe("number");

    // LP value should be positive (they have LP tokens)
    expect(yieldResult.lpValueXLM).toBeGreaterThan(0);

    // APR can be 0 if no recent swaps, but should be a number
    expect(typeof yieldResult.aprPercent).toBe("number");
    expect(yieldResult.aprPercent).toBeGreaterThanOrEqual(0);
  });

  // -----------------------------------------------------------------------
  // 3. getLPYield — returns zero for an address with no LP tokens
  // -----------------------------------------------------------------------
  it("getLPYield returns zero share and zero APR for address with no LP tokens", async () => {
    // Use a random address that has no LP tokens
    const emptyResult = await fees.getLPYield(
      pairAB,
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    );

    expect(emptyResult.lpSharePercent).toBe(0);
    expect(emptyResult.lpFeeShareXLM).toBe(0);
    expect(emptyResult.lpValueXLM).toBe(0);
    expect(emptyResult.aprPercent).toBe(0);
  });

  // -----------------------------------------------------------------------
  // 4. getFeeRevenue — handles ledger range options
  // -----------------------------------------------------------------------
  it("getFeeRevenue respects custom ledger range options", async () => {
    const currentLedger = await client.getCurrentLedger();
    const revenue = await fees.getFeeRevenue(pairAB, {
      fromLedger: Math.max(0, currentLedger - 1000),
      toLedger: currentLedger,
      limit: 50,
    });

    expect(revenue.pairAddress).toBe(pairAB);
    expect(typeof revenue.swapCount).toBe("number");
    expect(typeof revenue.totalFeeXLM).toBe("number");
  });

  // -----------------------------------------------------------------------
  // Cleanup: remove liquidity from pools touched in this suite
  // -----------------------------------------------------------------------
  afterAll(async () => {
    const seen = new Set<string>();
    for (const {
      pairAddress,
      tokenA: tA,
      tokenB: tB,
    } of pairsToCleanup) {
      if (seen.has(pairAddress)) continue;
      seen.add(pairAddress);
      await removeAllLiquidity(pairAddress, tA, tB);
    }
  });
});
