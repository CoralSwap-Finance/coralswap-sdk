import { CoralSwapClient } from '../../src/client';
import { Network } from '../../src/types/common';
import { LiquidityModule } from '../../src/modules/liquidity';
import { SwapModule } from '../../src/modules/swap';
import { TradeType } from '../../src/types/common';
import { toSorobanAmount } from '../../src/utils/amounts';

/**
 * Integration test: swap quoting and execution against real testnet pool reserves.
 *
 * Prerequisites (set via env vars):
 *   STELLAR_TESTNET  – must be 'true' to run
 *   TEST_KEYPAIR     – funded testnet secret key (S...)
 *   TEST_TOKEN_A     – contract address of token A
 *   TEST_TOKEN_B     – contract address of token B
 *   TEST_RPC_URL     – optional RPC override
 *
 * Idempotent: reuses an existing pair and skips add-liquidity when LP balance
 * is already sufficient. Removes all LP added during the suite in afterAll.
 *
 * Swap amounts are intentionally tiny (0.01 units) so this suite is cheap to
 * run repeatedly against shared testnet pools.
 */

// Skip unless the full set of testnet fixtures is configured, so the suite
// degrades to a clean skip on forks/PRs without secrets.
const SKIP =
  process.env.STELLAR_TESTNET !== 'true' || !process.env.TEST_KEYPAIR;

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

const describeIntegration = SKIP ? describe.skip : describe;

describeIntegration('Swap module (testnet)', () => {
  let client: CoralSwapClient;
  let liquidity: LiquidityModule;
  let swap: SwapModule;
  let tokenA: string;
  let tokenB: string;
  let pairAddress: string;

  const SEED_AMOUNT_A = toSorobanAmount('1', 7);
  const SWAP_AMOUNT = toSorobanAmount('0.01', 7);
  const MIN_LP_BALANCE = 1n;
  const SLIPPAGE_BPS = 200;

  let addedLiquidity = false;

  beforeAll(async () => {
    client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: requireEnv('TEST_KEYPAIR'),
      ...(process.env.TEST_RPC_URL ? { rpcUrl: process.env.TEST_RPC_URL } : {}),
    });
    tokenA = requireEnv('TEST_TOKEN_A');
    tokenB = requireEnv('TEST_TOKEN_B');
    liquidity = new LiquidityModule(client);
    swap = new SwapModule(client);

    pairAddress = await ensurePair(tokenA, tokenB);
    await ensureLiquidity(pairAddress, tokenA, tokenB);
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
    pAddress: string,
    tA: string,
    tB: string,
  ): Promise<void> {
    const lpAddr = await client.pair(pAddress).getLPTokenAddress();
    const lpBefore = await client.lpToken(lpAddr).balance(client.publicKey);
    if (lpBefore >= MIN_LP_BALANCE) return;

    const quote = await liquidity.getAddLiquidityQuote(tA, tB, SEED_AMOUNT_A);
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
    addedLiquidity = true;

    const lpAfter = await client.lpToken(lpAddr).balance(client.publicKey);
    expect(lpAfter).toBeGreaterThan(lpBefore);
  }

  // -----------------------------------------------------------------------
  // 1. getQuote — verified against real pool reserves, not mock placeholders
  // -----------------------------------------------------------------------
  it('getQuote reflects real testnet pool reserves and is within expected bounds', async () => {
    const pair = client.pair(pairAddress);
    const { reserve0, reserve1 } = await pair.getReserves();
    expect(reserve0).toBeGreaterThan(0n);
    expect(reserve1).toBeGreaterThan(0n);

    const { token0 } = await pair.getTokens();
    const feeBps = await pair.getDynamicFee();
    const isToken0In = token0 === tokenA;
    const reserveIn = isToken0In ? reserve0 : reserve1;
    const reserveOut = isToken0In ? reserve1 : reserve0;

    // Independently derived from the same live reserves fetched above --
    // confirms the quote is sourced from real on-chain state, not a placeholder.
    const expectedAmountOut = swap.getAmountOut(SWAP_AMOUNT, reserveIn, reserveOut, feeBps);

    const quote = await swap.getQuote({
      tokenIn: tokenA,
      tokenOut: tokenB,
      amount: SWAP_AMOUNT,
      tradeType: TradeType.EXACT_IN,
      slippageBps: SLIPPAGE_BPS,
    });

    expect(quote.amountIn).toBe(SWAP_AMOUNT);
    expect(quote.amountOut).toBe(expectedAmountOut);
    expect(quote.amountOut).toBeGreaterThan(0n);
    expect(quote.amountOutMin).toBeLessThanOrEqual(quote.amountOut);
    expect(quote.feeBps).toBe(feeBps);
    expect(quote.path).toEqual([tokenA, tokenB]);
    // Sane bound: a 0.01-unit trade against seeded liquidity should not move
    // the price by more than 50% (500 = 5000bps ceiling used as a generous guard).
    expect(quote.priceImpactBps).toBeGreaterThanOrEqual(0);
    expect(quote.priceImpactBps).toBeLessThan(5000);
  });

  // -----------------------------------------------------------------------
  // 2. execute — real on-chain swap settles within slippage tolerance of quote
  // -----------------------------------------------------------------------
  it('execute settles a real swap on-chain within slippage tolerance of the quote', async () => {
    const quote = await swap.getQuote({
      tokenIn: tokenA,
      tokenOut: tokenB,
      amount: SWAP_AMOUNT,
      tradeType: TradeType.EXACT_IN,
      slippageBps: SLIPPAGE_BPS,
    });

    const result = await swap.execute({
      tokenIn: tokenA,
      tokenOut: tokenB,
      amount: SWAP_AMOUNT,
      tradeType: TradeType.EXACT_IN,
      slippageBps: SLIPPAGE_BPS,
      deadline: client.getDeadline(60),
    });

    // Verifies the swap actually settled on-chain (real tx hash + ledger).
    expect(result.txHash).toBeTruthy();
    expect(result.ledger).toBeGreaterThan(0);
    expect(result.amountIn).toBe(SWAP_AMOUNT);

    // Actual received amount must be at least the quoted minimum, and within
    // the slippage band above the original quote (pool state can shift
    // slightly between quote and execution on a live network).
    expect(result.amountOut).toBeGreaterThanOrEqual(quote.amountOutMin);
    const upperBound =
      quote.amountOut + (quote.amountOut * BigInt(SLIPPAGE_BPS)) / 10000n;
    expect(result.amountOut).toBeLessThanOrEqual(upperBound);
  });

  // -----------------------------------------------------------------------
  // Cleanup: remove any liquidity added during this suite
  // -----------------------------------------------------------------------
  afterAll(async () => {
    if (!addedLiquidity) return;

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

    await liquidity.removeLiquidity({
      tokenA,
      tokenB,
      liquidity: lpBalance,
      amountAMin: (expectedA * BigInt(10000 - SLIPPAGE_BPS)) / 10000n,
      amountBMin: (expectedB * BigInt(10000 - SLIPPAGE_BPS)) / 10000n,
      to: client.publicKey,
      deadline: client.getDeadline(300),
    });
  });
});
