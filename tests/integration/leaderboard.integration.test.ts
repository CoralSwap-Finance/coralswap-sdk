import { CoralSwapClient } from '../../src/client';
import { Network } from '../../src/types/common';
import { LiquidityModule } from '../../src/modules/liquidity';
import { SwapModule } from '../../src/modules/swap';
import { LeaderboardModule } from '../../src/modules/leaderboard';
import { TradeType } from '../../src/types/common';
import { toSorobanAmount } from '../../src/utils/amounts';

/**
 * Integration test: leaderboard rankings against real testnet event history.
 *
 * Prerequisites (set via env vars):
 *   STELLAR_TESTNET  – must be 'true' to run
 *   TEST_KEYPAIR     – funded testnet secret key (S...)
 *   TEST_TOKEN_A     – contract address of token A (used as $1 stable anchor)
 *   TEST_TOKEN_B     – contract address of token B
 *   TEST_TOKEN_C     – contract address of token C (used to form an idle pool)
 *   TEST_RPC_URL     – optional RPC override
 *
 * Strategy: submit a real add-liquidity + swap against the A/B pool, then
 * verify the leaderboard/top-traders queries surface our own address with
 * the actual on-chain amounts — not just a structurally valid shape. The
 * B/C pool is left untouched to exercise the empty/new-pool path.
 */

const SKIP = process.env.STELLAR_TESTNET !== 'true';

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

const describeIntegration = SKIP ? describe.skip : describe;

describeIntegration('Leaderboard module (testnet)', () => {
  let client: CoralSwapClient;
  let liquidity: LiquidityModule;
  let swap: SwapModule;
  let leaderboard: LeaderboardModule;
  let tokenA: string;
  let tokenB: string;
  let tokenC: string;
  let pairAB: string;
  let pairBC: string;

  const SLIPPAGE_BPS = 200; // 2% — generous for testnet
  const LIQUIDITY_AMOUNT_A = toSorobanAmount('1', 7);
  const SWAP_AMOUNT_A = toSorobanAmount('0.1', 7); // 0.1 USD equivalent (tokenA is the stable anchor)

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
    leaderboard = new LeaderboardModule(client, { stableAddresses: [tokenA] });

    pairAB = await ensurePair(tokenA, tokenB);
    // B/C pool is only ever created here — never funded with liquidity or
    // swapped against — so it stands in for a genuinely idle/new pool.
    pairBC = await ensurePair(tokenB, tokenC);
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

  // -----------------------------------------------------------------------
  // 1. Generate real on-chain activity: add liquidity, then swap A → B
  // -----------------------------------------------------------------------
  it('submits an add-liquidity and a swap against the A/B pool', async () => {
    const quote = await liquidity.getAddLiquidityQuote(tokenA, tokenB, LIQUIDITY_AMOUNT_A);
    const addResult = await liquidity.addLiquidity({
      tokenA,
      tokenB,
      amountADesired: quote.amountA,
      amountBDesired: quote.amountB,
      amountAMin: (quote.amountA * BigInt(10000 - SLIPPAGE_BPS)) / 10000n,
      amountBMin: (quote.amountB * BigInt(10000 - SLIPPAGE_BPS)) / 10000n,
      to: client.publicKey,
      deadline: client.getDeadline(300),
    });
    expect(addResult.txHash).toBeTruthy();

    const swapQuote = await swap.getQuote({
      tokenIn: tokenA,
      tokenOut: tokenB,
      amount: SWAP_AMOUNT_A,
      tradeType: TradeType.EXACT_IN,
      slippageBps: SLIPPAGE_BPS,
    });
    expect(swapQuote.amountOut).toBeGreaterThan(0n);

    const swapResult = await swap.execute({
      tokenIn: tokenA,
      tokenOut: tokenB,
      amount: SWAP_AMOUNT_A,
      tradeType: TradeType.EXACT_IN,
      slippageBps: SLIPPAGE_BPS,
      deadline: client.getDeadline(60),
    });
    expect(swapResult.txHash).toBeTruthy();
  });

  // -----------------------------------------------------------------------
  // 2. getLeaderboard('trader', ...) reflects the real swap we just made
  // -----------------------------------------------------------------------
  it('getLeaderboard trader ranking surfaces our address with real swap volume', async () => {
    const entries = await leaderboard.getLeaderboard('trader', {
      period: '24h',
      pairAddress: pairAB,
    });

    const own = entries.find((e) => e.address === client.publicKey);
    expect(own).toBeDefined();
    expect(own!.rank).toBeGreaterThanOrEqual(1);
    // amount_in emitted by the swap event should match what we submitted.
    expect(own!.metricValue).toBeGreaterThanOrEqual(SWAP_AMOUNT_A);
  });

  // -----------------------------------------------------------------------
  // 3. getLeaderboard('lp', ...) reflects the real liquidity we just added
  // -----------------------------------------------------------------------
  it('getLeaderboard LP ranking surfaces our address with real liquidity added', async () => {
    const entries = await leaderboard.getLeaderboard('lp', {
      period: '24h',
      pairAddress: pairAB,
    });

    const own = entries.find((e) => e.address === client.publicKey);
    expect(own).toBeDefined();
    expect(own!.metricValue).toBeGreaterThan(0n);
  });

  // -----------------------------------------------------------------------
  // 4. getTopTraders() aggregates our real swap into USD volume
  // -----------------------------------------------------------------------
  it('getTopTraders reflects real swap volume priced against the stable anchor', async () => {
    const rankings = await leaderboard.getTopTraders({
      pairAddress: pairAB,
      periodDays: 1,
    });

    const own = rankings.find((r) => r.address === client.publicKey);
    expect(own).toBeDefined();
    expect(own!.tradeCount).toBeGreaterThanOrEqual(1);
    // tokenA is the stable anchor, so USD volume should track the input amount (~0.1).
    expect(own!.totalVolumeUSD).toBeGreaterThan(0);
    expect(own!.favoritePool).toBe(pairAB);
  });

  // -----------------------------------------------------------------------
  // 5. Empty/new-pool case: B/C pool has no swap or liquidity history
  // -----------------------------------------------------------------------
  it('handles an idle/new pool gracefully, returning empty results without throwing', async () => {
    await expect(
      leaderboard.getLeaderboard('trader', { period: '24h', pairAddress: pairBC }),
    ).resolves.toEqual([]);

    await expect(
      leaderboard.getLeaderboard('lp', { period: '24h', pairAddress: pairBC }),
    ).resolves.toEqual([]);

    await expect(
      leaderboard.getTopTraders({ pairAddress: pairBC, periodDays: 1 }),
    ).resolves.toEqual([]);
  });
});
