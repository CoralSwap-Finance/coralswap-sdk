import { CoralSwapClient } from '../../src/client';
import { Network } from '../../src/types/common';
import { FactoryModule, PoolEvent } from '../../src/modules/factory';
import { SwapModule } from '../../src/modules/swap';
import { LiquidityModule } from '../../src/modules/liquidity';
import { TradeType } from '../../src/types/common';
import { toSorobanAmount } from '../../src/utils/amounts';

/**
 * Integration test: factory module pair lookup, caching, and event watching.
 *
 * Prerequisites (set via env vars):
 *   STELLAR_TESTNET  – must be 'true' to run
 *   TEST_KEYPAIR     – funded testnet secret key (S...)
 *   TEST_TOKEN_A     – contract address of token A
 *   TEST_TOKEN_B     – contract address of token B
 *   TEST_RPC_URL     – optional RPC override
 *
 * Idempotent: reuses an existing pair if one already exists.
 * Cleans up any liquidity added during the suite in afterAll.
 */

const SKIP = process.env.STELLAR_TESTNET !== 'true';

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

const describeIntegration = SKIP ? describe.skip : describe;

describeIntegration('Factory module (testnet)', () => {
  let client: CoralSwapClient;
  let factory: FactoryModule;
  let swap: SwapModule;
  let liquidity: LiquidityModule;
  let tokenA: string;
  let tokenB: string;
  let pairAddress: string;

  const AMOUNT_A = toSorobanAmount('1', 7);
  const SLIPPAGE_BPS = 200;

  beforeAll(async () => {
    client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: requireEnv('TEST_KEYPAIR'),
      ...(process.env.TEST_RPC_URL ? { rpcUrl: process.env.TEST_RPC_URL } : {}),
    });
    tokenA = requireEnv('TEST_TOKEN_A');
    tokenB = requireEnv('TEST_TOKEN_B');
    factory = client.factoryModule();
    swap = new SwapModule(client);
    liquidity = new LiquidityModule(client);

    // Ensure the pair exists
    let addr = await factory.getPairAddress(tokenA, tokenB);
    if (!addr) {
      const op = client.factory.buildCreatePair(client.publicKey, tokenA, tokenB);
      const result = await client.submitTransaction([op]);
      expect(result.success).toBe(true);
      addr = await factory.getPairAddress(tokenA, tokenB);
    }
    expect(addr).toBeTruthy();
    pairAddress = addr!;

    // Ensure there is liquidity so swaps produce events
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
  });

  // -----------------------------------------------------------------------
  // 1. getPairAddress — resolve real pairs from testnet
  // -----------------------------------------------------------------------
  it('getPairAddress resolves an existing pair from testnet', async () => {
    const addr = await factory.getPairAddress(tokenA, tokenB);
    expect(addr).toBe(pairAddress);
  });

  it('getPairAddress returns null for a non-existent pair', async () => {
    const fakeToken = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
    const addr = await factory.getPairAddress(tokenA, fakeToken);
    expect(addr).toBeNull();
  });

  it('getPairAddress caches results and returns from cache on repeated calls', async () => {
    const addr1 = await factory.getPairAddress(tokenA, tokenB);
    expect(addr1).toBe(pairAddress);

    // Bypass cache and verify still resolves correctly
    const addr2 = await factory.getPairAddress(tokenA, tokenB, { bypassCache: true });
    expect(addr2).toBe(pairAddress);
  });

  it('getPairAddress works with tokens in reversed order', async () => {
    const addr = await factory.getPairAddress(tokenB, tokenA);
    expect(addr).toBe(pairAddress);
  });

  // -----------------------------------------------------------------------
  // 2. getAllPairs / verifyPairAddress — factory pair registry
  // -----------------------------------------------------------------------
  it('getAllPairs returns a list containing the test pair', async () => {
    const allPairs = await client.factory.getAllPairs();
    expect(Array.isArray(allPairs)).toBe(true);
    expect(allPairs.length).toBeGreaterThan(0);
    expect(allPairs).toContain(pairAddress);
  });

  it('verifyPairAddress returns true for a registered pair', async () => {
    const result = await factory.verifyPairAddress(pairAddress);
    expect(result).toBe(true);
  });

  it('verifyPairAddress returns false for an unregistered address', async () => {
    const fakeAddr = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
    const result = await factory.verifyPairAddress(fakeAddr);
    expect(result).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 3. getPairInfo — batched pair metadata
  // -----------------------------------------------------------------------
  it('getPairInfo returns all five fields for the test pair', async () => {
    const info = await factory.getPairInfo(tokenA, tokenB);
    expect(info.address).toBe(pairAddress);
    expect(typeof info.reserveA).toBe('bigint');
    expect(typeof info.reserveB).toBe('bigint');
    expect(typeof info.feeBps).toBe('number');
    expect(typeof info.totalSupply).toBe('bigint');
    expect(info.feeBps).toBeGreaterThanOrEqual(0);
    expect(info.totalSupply).toBeGreaterThan(0n);
  });

  // -----------------------------------------------------------------------
  // 4. watchPool — event subscription
  // -----------------------------------------------------------------------
  it('watchPool receives a swap event after performing a swap', async () => {
    const swapAmount = toSorobanAmount('0.05', 7);

    const events: PoolEvent[] = [];
    const eventReceived = new Promise<boolean>((resolve) => {
      const unwatch = factory.watchPool(pairAddress, (event) => {
        events.push(event);
        if (event.type === 'swap') {
          unwatch();
          resolve(true);
        }
      }, 2000);

      // Timeout after 60 seconds
      setTimeout(() => {
        unwatch();
        resolve(false);
      }, 60_000);
    });

    // Perform a swap to trigger an event
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

    const received = await eventReceived;
    expect(received).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].type).toBe('swap');
    expect(events[0].pairAddress).toBe(pairAddress);
    expect(events[0].txHash).toBeTruthy();
    expect(events[0].ledger).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------
  afterAll(async () => {
    // Remove liquidity added during setup
    const lpAddr = await client.pair(pairAddress).getLPTokenAddress();
    const lpBalance = await client.lpToken(lpAddr).balance(client.publicKey);
    if (lpBalance > 0n) {
      const pair = client.pair(pairAddress);
      const { reserve0, reserve1 } = await pair.getReserves();
      const totalSupply = await client.lpToken(lpAddr).totalSupply();
      const expectedA = totalSupply > 0n ? (reserve0 * lpBalance) / totalSupply : 0n;
      const expectedB = totalSupply > 0n ? (reserve1 * lpBalance) / totalSupply : 0n;

      await liquidity.removeLiquidity({
        tokenA,
        tokenB,
        liquidity: lpBalance,
        amountAMin: (expectedA * BigInt(10000 - SLIPPAGE_BPS)) / 10000n,
        amountBMin: (expectedB * BigInt(10000 - SLIPPAGE_BPS)) / 10000n,
        to: client.publicKey,
        deadline: client.getDeadline(300),
      });
    }
  });
});