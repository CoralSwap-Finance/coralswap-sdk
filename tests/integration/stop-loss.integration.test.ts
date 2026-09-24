import { Contract, nativeToScVal, Address } from '@stellar/stellar-sdk';
import { CoralSwapClient } from '../../src/client';
import { Network } from '../../src/types/common';
import { StopLossModule } from '../../src/modules/stop-loss';
import { KeypairSigner } from '../../src/utils/signer';
import { StopLossOrder } from '../../src/types/stop-loss';
import { toSorobanAmount } from '../../src/utils/amounts';

/**
 * Integration test: stop-loss order placement and gas estimation against real
 * Testnet contract state.
 *
 * Prerequisites (set via env vars):
 *   STELLAR_TESTNET          – must be 'true' to run
 *   TEST_KEYPAIR             – funded testnet secret key (S...)
 *   TEST_TOKEN_A             – contract address of token A (sold on trigger)
 *   TEST_TOKEN_B             – contract address of token B (received on trigger)
 *   TEST_PAIR_ADDRESS        – address of the A/B pair the swap routes through
 *   TEST_STOP_LOSS_CONTRACT  – address of the stop-loss manager contract
 *   TEST_ORACLE_ADDRESS      – address of the RedStone oracle contract
 *   TEST_ORACLE_ASSET        – RedStone feed identifier, e.g. 'XLM'
 *   TEST_RPC_URL             – optional Soroban RPC URL override
 *
 * Cleanup: any order created during the suite is cancelled in afterAll via a
 * direct `cancel_order` contract call so subsequent runs start clean.
 *
 * Idempotent: the suite records all created order IDs (extracted from
 * getStopLossOrders after placement) and cancels only those.
 */

const SKIP = process.env.STELLAR_TESTNET !== 'true';

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

const describeIntegration = SKIP ? describe.skip : describe;

describeIntegration('StopLossModule (testnet)', () => {
  let client: CoralSwapClient;
  let stopLoss: StopLossModule;
  let signer: KeypairSigner;

  let tokenA: string;
  let tokenB: string;
  let pairAddress: string;
  let stopLossContract: string;
  let oracleAddress: string;
  let oracleAsset: string;

  /** Order IDs (from on-chain state) created in this run — cancelled in afterAll. */
  const createdOrderIds: string[] = [];

  beforeAll(async () => {
    tokenA = requireEnv('TEST_TOKEN_A');
    tokenB = requireEnv('TEST_TOKEN_B');
    pairAddress = requireEnv('TEST_PAIR_ADDRESS');
    stopLossContract = requireEnv('TEST_STOP_LOSS_CONTRACT');
    oracleAddress = requireEnv('TEST_ORACLE_ADDRESS');
    oracleAsset = requireEnv('TEST_ORACLE_ASSET');

    client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: requireEnv('TEST_KEYPAIR'),
      ...(process.env.TEST_RPC_URL ? { rpcUrl: process.env.TEST_RPC_URL } : {}),
    });

    signer = new KeypairSigner(
      requireEnv('TEST_KEYPAIR'),
      client.networkConfig.networkPassphrase,
    );

    stopLoss = new StopLossModule(client, stopLossContract, oracleAddress);
  });

  // -------------------------------------------------------------------------
  // Helper: query live oracle price so we can set a valid trigger price
  // -------------------------------------------------------------------------
  async function getLiveOraclePrice(): Promise<bigint> {
    const oracle = new Contract(oracleAddress);
    const op = oracle.call(
      'get_price',
      nativeToScVal(oracleAsset, { type: 'symbol' }),
    );
    const sim = await client.simulateTransaction([op], {});
    if (!sim.success || !sim.returnValue) {
      throw new Error(
        `Oracle simulation failed for asset ${oracleAsset}: ${sim.error ?? 'no return value'}`,
      );
    }
    const { scValToNative } = await import('@stellar/stellar-sdk');
    const native = scValToNative(sim.returnValue);
    if (native && typeof native === 'object' && 'price' in (native as Record<string, unknown>)) {
      return BigInt(String((native as Record<string, unknown>)['price'] ?? '0'));
    }
    return BigInt(String(native));
  }

  // -------------------------------------------------------------------------
  // Helper: cancel an order by its ID via a direct contract call
  // -------------------------------------------------------------------------
  async function cancelOrder(orderId: string): Promise<void> {
    const contract = new Contract(stopLossContract);
    const op = contract.call(
      'cancel_order',
      nativeToScVal(orderId, { type: 'string' }),
      new Address(client.publicKey).toScVal(),
    );
    // Best-effort: do not throw if cancellation fails (order may already be gone)
    try {
      await client.submitTransaction([op]);
    } catch {
      // Swallow — cleanup should never fail the suite
    }
  }

  // -------------------------------------------------------------------------
  // Test 1: place a stop-loss order → verify it appears in getStopLossOrders
  // -------------------------------------------------------------------------
  it('places a stop-loss order and verifies it appears in getStopLossOrders()', async () => {
    const currentPrice = await getLiveOraclePrice();
    expect(currentPrice).toBeGreaterThan(0n);

    // Trigger at 10 % below the live price — well within range, won't fire
    // accidentally during the test run.
    const triggerPrice = (currentPrice * 90n) / 100n;
    const amount = toSorobanAmount('0.1', 7); // 0.1 token (7 decimals)

    const params = {
      tokenIn: tokenA,
      tokenOut: tokenB,
      amount,
      triggerPrice,
      pairAddress,
      oracleAsset,
    };

    // Snapshot orders BEFORE placement so we can identify the new one
    const ordersBefore = await stopLoss.getStopLossOrders(client.publicKey);
    const idsBefore = new Set(ordersBefore.map((o: StopLossOrder) => o.id));

    const txHash = await stopLoss.createStopLoss(params, signer);
    expect(typeof txHash).toBe('string');
    expect(txHash.length).toBeGreaterThan(0);

    // Give the network a moment to apply the transaction
    await new Promise((r) => setTimeout(r, 3_000));

    const ordersAfter = await stopLoss.getStopLossOrders(client.publicKey);
    const newOrders = ordersAfter.filter(
      (o: StopLossOrder) => !idsBefore.has(o.id),
    );

    // At least one new order must have appeared for this owner
    expect(newOrders.length).toBeGreaterThanOrEqual(1);

    const placed = newOrders[0];
    expect(placed.owner).toBe(client.publicKey);
    expect(placed.tokenIn.toLowerCase()).toBe(tokenA.toLowerCase());
    expect(placed.tokenOut.toLowerCase()).toBe(tokenB.toLowerCase());
    expect(placed.amount).toBe(amount);
    expect(placed.triggerPrice).toBe(triggerPrice);
    expect(placed.status).toBe('active');
    // The order should NOT be triggered yet (price is 10 % above trigger)
    expect(placed.triggered).toBe(false);
    expect(placed.distancePercent).toBeGreaterThan(0);

    // Register for cleanup
    createdOrderIds.push(placed.id);
  });

  // -------------------------------------------------------------------------
  // Test 2: estimateStopLossGas() returns a real, sane fee from simulation
  // -------------------------------------------------------------------------
  it('estimateStopLossGas() returns a positive fee from a real simulated transaction', async () => {
    const currentPrice = await getLiveOraclePrice();
    const triggerPrice = (currentPrice * 90n) / 100n;

    const params = {
      tokenIn: tokenA,
      tokenOut: tokenB,
      amount: toSorobanAmount('0.1', 7),
      triggerPrice,
      pairAddress,
      oracleAsset,
    };

    const estimate = await stopLoss.estimateStopLossGas(params);

    // fee must be a positive integer (stroops)
    expect(typeof estimate.fee).toBe('number');
    expect(Number.isInteger(estimate.fee)).toBe(true);
    expect(estimate.fee).toBeGreaterThan(0);

    // feeXLM must be a non-empty string ending in " XLM"
    expect(typeof estimate.feeXLM).toBe('string');
    expect(estimate.feeXLM.length).toBeGreaterThan(0);
    expect(estimate.feeXLM).toMatch(/XLM$/);

    // Sanity bounds: 1 stroop to 100 XLM (1_000_000_000 stroops)
    // Typical Soroban fees are in the hundreds to low thousands of stroops.
    expect(estimate.fee).toBeGreaterThanOrEqual(1);
    expect(estimate.fee).toBeLessThan(1_000_000_000);
  });

  // -------------------------------------------------------------------------
  // Cleanup: cancel every order created during this suite
  // -------------------------------------------------------------------------
  afterAll(async () => {
    for (const orderId of createdOrderIds) {
      await cancelOrder(orderId);
    }
  });
});
