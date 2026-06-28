import {
  Contract,
  TransactionBuilder,
  SorobanRpc,
  nativeToScVal,
  scValToNative,
  Address,
} from '@stellar/stellar-sdk';
import { CoralSwapClient } from '../../src/client';
import { Network } from '../../src/types/common';
import { LiquidityModule } from '../../src/modules/liquidity';
import { SwapModule } from '../../src/modules/swap';
import { TradeType } from '../../src/types/common';
import { toSorobanAmount } from '../../src/utils/amounts';

/**
 * Integration test: create pair → add liquidity → swap → remove liquidity.
 *
 * Prerequisites (set via env vars):
 *   TEST_KEYPAIR   – funded testnet secret key (S...)
 *   TEST_TOKEN_A   – contract address of token A
 *   TEST_TOKEN_B   – contract address of token B
 *   TEST_RPC_URL   – optional RPC override
 *
 * Idempotent: reuses an existing pair if one already exists.
 */

const SKIP = process.env.STELLAR_TESTNET !== 'true';

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

const describeIntegration = SKIP ? describe.skip : describe;

describeIntegration('CoralSwap lifecycle (testnet)', () => {
  let client: CoralSwapClient;
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
    liquidity = new LiquidityModule(client);
    swap = new SwapModule(client);
  });

  /** Read SEP-41 token balance for the test account via simulation. */
  async function tokenBalance(tokenAddress: string): Promise<bigint> {
    const account = await client.server.getAccount(client.publicKey);
    const op = new Contract(tokenAddress).call(
      'balance',
      nativeToScVal(Address.fromString(client.publicKey), { type: 'address' }),
    );
    const tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: client.networkConfig.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();
    const sim = await client.server.simulateTransaction(tx);
    if (!SorobanRpc.Api.isSimulationSuccess(sim)) return 0n;
    const retval = (sim as SorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    if (!retval) return 0n;
    return BigInt(scValToNative(retval) as string | number | bigint);
  }

  // -----------------------------------------------------------------------
  // 1. Ensure pair exists
  // -----------------------------------------------------------------------
  it('resolves or creates the token pair', async () => {
    let addr = await client.getPairAddress(tokenA, tokenB);
    if (!addr) {
      const op = client.factory.buildCreatePair(client.publicKey, tokenA, tokenB);
      const result = await client.submitTransaction([op]);
      expect(result.success).toBe(true);
      addr = await client.getPairAddress(tokenA, tokenB);
    }
    expect(addr).toBeTruthy();
    pairAddress = addr!;
  });

  // -----------------------------------------------------------------------
  // 2. Add liquidity — LP token balance must increase
  // -----------------------------------------------------------------------
  it('adds liquidity and receives LP tokens', async () => {
    const lpAddr = await client.pair(pairAddress).getLPTokenAddress();
    const lpBefore = await client.lpToken(lpAddr).balance(client.publicKey);

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
    const lpAfter = await client.lpToken(lpAddr).balance(client.publicKey);
    expect(lpAfter).toBeGreaterThan(lpBefore);
  });

  // -----------------------------------------------------------------------
  // 3. Swap tokenA → tokenB — tokenB balance must increase
  // -----------------------------------------------------------------------
  it('swaps tokenA for tokenB and receives tokenB', async () => {
    const swapAmount = toSorobanAmount('0.1', 7);
    const balBefore = await tokenBalance(tokenB);

    const quote = await swap.getQuote({
      tokenIn: tokenA,
      tokenOut: tokenB,
      amount: swapAmount,
      tradeType: TradeType.EXACT_IN,
      slippageBps: SLIPPAGE_BPS,
    });
    expect(quote.amountOut).toBeGreaterThan(0n);

    const result = await swap.execute({
      tokenIn: tokenA,
      tokenOut: tokenB,
      amount: swapAmount,
      tradeType: TradeType.EXACT_IN,
      slippageBps: SLIPPAGE_BPS,
      deadline: client.getDeadline(60),
    });
    expect(result.txHash).toBeTruthy();

    const balAfter = await tokenBalance(tokenB);
    expect(balAfter).toBeGreaterThan(balBefore);
  });

  // -----------------------------------------------------------------------
  // 4. Remove liquidity — LP balance decreases, underlying tokens return
  // -----------------------------------------------------------------------
  it('removes liquidity and returns underlying tokens', async () => {
    const lpAddr = await client.pair(pairAddress).getLPTokenAddress();
    const lpBalance = await client.lpToken(lpAddr).balance(client.publicKey);
    const toRemove = lpBalance / 2n;
    if (toRemove === 0n) return; // nothing to remove

    const balABefore = await tokenBalance(tokenA);
    const balBBefore = await tokenBalance(tokenB);

    // Compute proportional expected amounts from current reserves
    const pair = client.pair(pairAddress);
    const { reserve0, reserve1 } = await pair.getReserves();
    const totalSupply = await client.lpToken(lpAddr).totalSupply();
    const expectedA = totalSupply > 0n ? (reserve0 * toRemove) / totalSupply : 0n;
    const expectedB = totalSupply > 0n ? (reserve1 * toRemove) / totalSupply : 0n;

    const result = await liquidity.removeLiquidity({
      tokenA,
      tokenB,
      liquidity: toRemove,
      amountAMin: (expectedA * BigInt(10000 - SLIPPAGE_BPS)) / 10000n,
      amountBMin: (expectedB * BigInt(10000 - SLIPPAGE_BPS)) / 10000n,
      to: client.publicKey,
      deadline: client.getDeadline(300),
    });
    expect(result.txHash).toBeTruthy();

    const lpAfter = await client.lpToken(lpAddr).balance(client.publicKey);
    expect(lpAfter).toBeLessThan(lpBalance);

    const balAAfter = await tokenBalance(tokenA);
    const balBAfter = await tokenBalance(tokenB);
    expect(balAAfter + balBAfter).toBeGreaterThan(balABefore + balBBefore);
  });
});
