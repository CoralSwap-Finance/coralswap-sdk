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
import { toSorobanAmount } from '../../src/utils/amounts';

/**
 * Integration test: add liquidity to a real Testnet pair, then remove it back out.
 *
 * Prerequisites (set via env vars):
 *   STELLAR_TESTNET  – must be 'true' to run
 *   TEST_KEYPAIR     – funded testnet secret key (S...)
 *   TEST_TOKEN_A     – contract address of token A
 *   TEST_TOKEN_B     – contract address of token B
 *   TEST_RPC_URL     – optional RPC override
 */
const SKIP = process.env.STELLAR_TESTNET !== 'true' || !process.env.TEST_KEYPAIR;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const describeIntegration = SKIP ? describe.skip : describe;

describeIntegration('Liquidity module (testnet)', () => {
  let client: CoralSwapClient;
  let liquidity: LiquidityModule;
  let tokenA: string;
  let tokenB: string;
  let pairAddress: string;
  let lpTokensMinted: bigint;

  const AMOUNT_A = toSorobanAmount('0.1', 7);
  const SLIPPAGE_BPS = 200;

  beforeAll(async () => {
    client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: requireEnv('TEST_KEYPAIR'),
      ...(process.env.TEST_RPC_URL ? { rpcUrl: process.env.TEST_RPC_URL } : {}),
    });
    tokenA = requireEnv('TEST_TOKEN_A');
    tokenB = requireEnv('TEST_TOKEN_B');
    liquidity = new LiquidityModule(client);

    let pair = await client.getPairAddress(tokenA, tokenB);
    if (!pair) {
      const op = client.factory.buildCreatePair(client.publicKey, tokenA, tokenB);
      const result = await client.submitTransaction([op]);
      expect(result.success).toBe(true);
      pair = await client.getPairAddress(tokenA, tokenB);
    }
    expect(pair).toBeTruthy();
    pairAddress = pair!;
  });

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

  async function removeLiquidityForCleanup(liquidityAmount: bigint): Promise<void> {
    if (liquidityAmount <= 0n) return;

    const lpAddr = await client.pair(pairAddress).getLPTokenAddress();
    const lpBalance = await client.lpToken(lpAddr).balance(client.publicKey);
    if (lpBalance <= 0n) return;

    const amountToRemove = liquidityAmount < lpBalance ? liquidityAmount : lpBalance;
    const pair = client.pair(pairAddress);
    const { reserve0, reserve1 } = await pair.getReserves();
    const totalSupply = await client.lpToken(lpAddr).totalSupply();
    const expectedA = totalSupply > 0n ? (reserve0 * amountToRemove) / totalSupply : 0n;
    const expectedB = totalSupply > 0n ? (reserve1 * amountToRemove) / totalSupply : 0n;

    await liquidity.removeLiquidity({
      tokenA,
      tokenB,
      liquidity: amountToRemove,
      amountAMin: expectedA,
      amountBMin: expectedB,
      to: client.publicKey,
      deadline: client.getDeadline(300),
    });
  }

  it('adds liquidity and mints LP tokens for a real Testnet pair', async () => {
    const lpAddr = await client.pair(pairAddress).getLPTokenAddress();
    const lpBefore = await client.lpToken(lpAddr).balance(client.publicKey);

    const quote = await liquidity.getAddLiquidityQuote(tokenA, tokenB, AMOUNT_A);
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
    const lpAfter = await client.lpToken(lpAddr).balance(client.publicKey);
    lpTokensMinted = lpAfter - lpBefore;

    expect(lpTokensMinted).toBeGreaterThan(0n);

    const position = await liquidity.getPosition(pairAddress, client.publicKey);
    expect(position.balance).toBe(lpAfter);
    expect(position.token0Amount).toBeGreaterThan(0n);
    expect(position.token1Amount).toBeGreaterThan(0n);
    expect(position.share).toBeGreaterThan(0);
  });

  it('removes liquidity and returns the correct underlying token amounts', async () => {
    const lpAddr = await client.pair(pairAddress).getLPTokenAddress();
    const lpBalanceBefore = await client.lpToken(lpAddr).balance(client.publicKey);
    expect(lpBalanceBefore).toBeGreaterThan(0n);

    const balanceABefore = await tokenBalance(tokenA);
    const balanceBBefore = await tokenBalance(tokenB);

    const pair = client.pair(pairAddress);
    const { reserve0, reserve1 } = await pair.getReserves();
    const totalSupply = await client.lpToken(lpAddr).totalSupply();
    const expectedA = totalSupply > 0n ? (reserve0 * lpTokensMinted) / totalSupply : 0n;
    const expectedB = totalSupply > 0n ? (reserve1 * lpTokensMinted) / totalSupply : 0n;

    const removeResult = await liquidity.removeLiquidity({
      tokenA,
      tokenB,
      liquidity: lpTokensMinted,
      amountAMin: expectedA,
      amountBMin: expectedB,
      to: client.publicKey,
      deadline: client.getDeadline(300),
    });

    expect(removeResult.txHash).toBeTruthy();

    const balanceAAfter = await tokenBalance(tokenA);
    const balanceBAfter = await tokenBalance(tokenB);
    expect(balanceAAfter).toBeGreaterThan(balanceABefore);
    expect(balanceBAfter).toBeGreaterThan(balanceBBefore);

    const lpBalanceAfter = await client.lpToken(lpAddr).balance(client.publicKey);
    expect(lpBalanceAfter).toBeLessThan(lpBalanceBefore);

    const position = await liquidity.getPosition(pairAddress, client.publicKey);
    expect(position.balance).toBe(lpBalanceAfter);
  });

  afterAll(async () => {
    if (lpTokensMinted > 0n) {
      await removeLiquidityForCleanup(lpTokensMinted);
    }
  });
});
