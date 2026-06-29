import { CoralSwapClient } from '../../src/client';
import { Network } from '../../src/types/common';
import { LiquidityModule } from '../../src/modules/liquidity';
import { SwapModule } from '../../src/modules/swap';
import { PortfolioModule } from '../../src/modules/portfolio';
import { TradeType } from '../../src/types/common';
import { toSorobanAmount } from '../../src/utils/amounts';

/**
 * Integration test: portfolio aggregation and PnL across real testnet pools.
 *
 * Prerequisites (set via env vars):
 *   STELLAR_TESTNET  – must be 'true' to run
 *   TEST_KEYPAIR     – funded testnet secret key (S...)
 *   TEST_TOKEN_A     – contract address of token A (used as $1 stable anchor)
 *   TEST_TOKEN_B     – contract address of token B
 *   TEST_TOKEN_C     – contract address of token C (second pool leg)
 *   TEST_RPC_URL     – optional RPC override
 *
 * Idempotent: reuses existing pairs and skips add-liquidity when LP balance
 * is already sufficient. Removes all LP added during the suite in afterAll.
 */

const SKIP = process.env.STELLAR_TESTNET !== 'true';

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

const describeIntegration = SKIP ? describe.skip : describe;

describeIntegration('Portfolio module (testnet)', () => {
  let client: CoralSwapClient;
  let liquidity: LiquidityModule;
  let swap: SwapModule;
  let portfolio: PortfolioModule;
  let tokenA: string;
  let tokenB: string;
  let tokenC: string;
  let pairAB: string;
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
    liquidity = new LiquidityModule(client);
    swap = new SwapModule(client);
    portfolio = new PortfolioModule(client, { stableAddresses: [tokenA] });

    pairAB = await ensurePair(tokenA, tokenB);
    pairAC = await ensurePair(tokenA, tokenC);
    await ensureLiquidity(pairAB, tokenA, tokenB);
    await ensureLiquidity(pairAC, tokenA, tokenC);
  });

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
  // 1. getPortfolio — positions across two pools + total value
  // -----------------------------------------------------------------------
  it('getPortfolio returns positions across two pools with correct total value', async () => {
    const result = await portfolio.getPortfolio(client.publicKey, {
      pairAddresses: [pairAB, pairAC],
    });

    expect(result.owner).toBe(client.publicKey);
    expect(result.positions).toHaveLength(2);

    const pairAddrs = result.positions.map((p) => p.pairAddress).sort();
    expect(pairAddrs).toEqual([pairAB, pairAC].sort());

    for (const pos of result.positions) {
      expect(pos.lpBalance).toBeGreaterThan(0n);
      expect(pos.token0Amount).toBeGreaterThan(0n);
      expect(pos.token1Amount).toBeGreaterThan(0n);
      expect(pos.valueUSD).toBeGreaterThan(0);
    }

    const sumPositions = result.positions.reduce((s, p) => s + p.valueUSD, 0);
    expect(result.totalValueUSD).toBeCloseTo(sumPositions, 5);
    expect(result.totalValueUSD).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // 2. getPortfolioPnL — value change after swap shifts pool ratio
  // -----------------------------------------------------------------------
  it('getPortfolioPnL matches expected values after a swap changes pool ratios', async () => {
    const entryPortfolio = await portfolio.getPortfolio(client.publicKey, {
      pairAddresses: [pairAB],
    });
    expect(entryPortfolio.positions).toHaveLength(1);
    const entry = portfolio.createSnapshot(entryPortfolio);

    const swapAmount = toSorobanAmount('0.05', 7);
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

    const pnl = await portfolio.getPortfolioPnL(client.publicKey, entry);
    const current = await portfolio.getPortfolio(client.publicKey, {
      pairAddresses: [pairAB],
    });

    const expectedPnl = current.totalValueUSD - entry.totalValueUSD;
    expect(pnl.entryValueUSD).toBeCloseTo(entry.totalValueUSD, 5);
    expect(pnl.currentValueUSD).toBeCloseTo(current.totalValueUSD, 5);
    expect(pnl.pnlUSD).toBeCloseTo(expectedPnl, 5);
    expect(pnl.pnlPercent).toBeCloseTo(
      entry.totalValueUSD > 0 ? (expectedPnl / entry.totalValueUSD) * 100 : 0,
      5,
    );
  });

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
  });
});
