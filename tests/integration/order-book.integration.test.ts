import { CoralSwapClient } from '../../src/client';
import { Network } from '../../src/types/common';
import { LimitOrderModule } from '../../src/modules/limit-orders';
import { DCAModule } from '../../src/modules/dca';
import { getOpenOrders, getOrderSummary } from '../../src/modules/order-book';

/**
 * Integration test: order-book aggregation across limit-order and DCA modules
 * against the real Stellar Testnet.
 *
 * Prerequisites (set via env vars):
 *   STELLAR_TESTNET           – must be 'true' to run
 *   TEST_KEYPAIR              – funded testnet secret key (S...)
 *   TEST_TOKEN_A              – contract address of tokenIn  (e.g. USDC)
 *   TEST_TOKEN_B              – contract address of tokenOut (e.g. XLM)
 *   TEST_PAIR_ADDRESS         – address of the tokenA/tokenB pair on testnet
 *   TEST_LIMIT_ORDER_CONTRACT – address of the limit-order contract
 *   TEST_DCA_CONTRACT         – address of the DCA scheduler contract
 *   TEST_RPC_URL              – optional RPC override
 *
 * Cleanup: every order / schedule created during the run is cancelled in
 * afterAll so no on-chain state is left behind.
 */

const SKIP = process.env.STELLAR_TESTNET !== 'true';
const describeIntegration = SKIP ? describe.skip : describe;

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

describeIntegration('Order-book module (testnet)', () => {
  let client: CoralSwapClient;
  let limitOrders: LimitOrderModule;
  let dca: DCAModule;

  let tokenA: string;
  let tokenB: string;
  let pairAddress: string;

  /** IDs collected during the run — cancelled in afterAll. */
  const createdLimitOrderIds: string[] = [];
  const createdDcaScheduleIds: string[] = [];

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------
  beforeAll(async () => {
    tokenA = requireEnv('TEST_TOKEN_A');
    tokenB = requireEnv('TEST_TOKEN_B');
    pairAddress = requireEnv('TEST_PAIR_ADDRESS');

    client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: requireEnv('TEST_KEYPAIR'),
      ...(process.env.TEST_RPC_URL ? { rpcUrl: process.env.TEST_RPC_URL } : {}),
    });

    limitOrders = new LimitOrderModule(
      client,
      requireEnv('TEST_LIMIT_ORDER_CONTRACT'),
    );

    dca = new DCAModule(
      client,
      requireEnv('TEST_DCA_CONTRACT'),
    );
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Place a limit order well below market so it stays open. Returns orderId. */
  async function placeLimitOrder(): Promise<string> {
    const expiry = Math.floor(Date.now() / 1000) + 60 * 60; // 1 hour from now
    const { orderId } = await limitOrders.placeLimitOrder({
      tokenIn: tokenA,
      tokenOut: tokenB,
      amountIn: 1_000_000n, // smallest meaningful amount
      targetPrice: 0.000001,  // far below market — will stay open
      expiry,
      pairAddress,
    });
    createdLimitOrderIds.push(orderId);
    return orderId;
  }

  /** Create a DCA schedule with minimum viable params. Returns scheduleId. */
  async function createDcaSchedule(): Promise<string> {
    const signer = {
      publicKey: async () => client.publicKey,
      signTransaction: async (xdr: string) => {
        // KeypairSigner is used internally by CoralSwapClient; delegate signing.
        return (client as any).signer.signTransaction(xdr);
      },
    };

    const scheduleId = await dca.createDCA(
      {
        tokenIn: tokenA,
        tokenOut: tokenB,
        amountPerInterval: 500_000n,
        intervalSeconds: 3600,   // minimum: 1 hour
        totalIntervals: 2,        // minimum: 2
        pairAddress,
      },
      signer,
    );
    createdDcaScheduleIds.push(scheduleId);
    return scheduleId;
  }

  // -------------------------------------------------------------------------
  // 1. getOpenOrders — aggregated view includes orders from both modules
  // -------------------------------------------------------------------------
  it('getOpenOrders returns orders from both limit-order and DCA modules', async () => {
    const limitOrderId = await placeLimitOrder();
    const dcaScheduleId = await createDcaSchedule();

    const openOrders = await getOpenOrders(client.publicKey);

    // Must contain at least the two orders we just created
    expect(openOrders.length).toBeGreaterThanOrEqual(2);

    const limitEntry = openOrders.find((o) => o.id === limitOrderId);
    const dcaEntry = openOrders.find((o) => o.id === dcaScheduleId);

    expect(limitEntry).toBeDefined();
    expect(limitEntry?.type).toBe('limit');
    expect(limitEntry?.status).toBe('open');
    expect(limitEntry?.tokenIn).toBeTruthy();
    expect(limitEntry?.tokenOut).toBeTruthy();
    expect(limitEntry?.createdAt).toBeInstanceOf(Date);

    expect(dcaEntry).toBeDefined();
    expect(dcaEntry?.type).toBe('dca');
    expect(dcaEntry?.status).toBe('open');
    expect(dcaEntry?.tokenIn).toBeTruthy();
    expect(dcaEntry?.tokenOut).toBeTruthy();
    expect(dcaEntry?.createdAt).toBeInstanceOf(Date);
  });

  // -------------------------------------------------------------------------
  // 2. getOpenOrders — results are sorted newest-first
  // -------------------------------------------------------------------------
  it('getOpenOrders returns orders sorted by createdAt descending', async () => {
    const openOrders = await getOpenOrders(client.publicKey);

    for (let i = 1; i < openOrders.length; i++) {
      expect(openOrders[i - 1].createdAt.getTime()).toBeGreaterThanOrEqual(
        openOrders[i].createdAt.getTime(),
      );
    }
  });

  // -------------------------------------------------------------------------
  // 3. getOrderSummary — counts and value reflect the created orders
  // -------------------------------------------------------------------------
  it('getOrderSummary reflects correct counts across module types', async () => {
    const summary = await getOrderSummary(client.publicKey, client);

    // At least one limit and one DCA were created above
    expect(summary.totalOpenOrders).toBeGreaterThanOrEqual(2);
    expect(summary.byType.limit).toBeGreaterThanOrEqual(1);
    expect(summary.byType.dca).toBeGreaterThanOrEqual(1);
    expect(summary.totalValueLocked).toBeGreaterThanOrEqual(0);
  });

  // -------------------------------------------------------------------------
  // 4. After cancellation the orders no longer appear in the aggregated view
  // -------------------------------------------------------------------------
  it('cancelled orders are removed from the aggregated order-book', async () => {
    // Place a fresh limit order specifically for this assertion
    const orderId = await placeLimitOrder();

    // Confirm it appears before cancellation
    const before = await getOpenOrders(client.publicKey);
    expect(before.some((o) => o.id === orderId)).toBe(true);

    // Cancel it
    await limitOrders.cancelLimitOrder(orderId);
    // Remove from cleanup list — already handled
    const idx = createdLimitOrderIds.indexOf(orderId);
    if (idx !== -1) createdLimitOrderIds.splice(idx, 1);

    // Confirm it is gone
    const after = await getOpenOrders(client.publicKey);
    expect(after.some((o) => o.id === orderId)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Cleanup: cancel every order / schedule created during this suite
  // -------------------------------------------------------------------------
  afterAll(async () => {
    const signer = {
      publicKey: async () => client.publicKey,
      signTransaction: async (xdr: string) =>
        (client as any).signer.signTransaction(xdr),
    };

    await Promise.allSettled(
      createdLimitOrderIds.map((id) => limitOrders.cancelLimitOrder(id)),
    );

    await Promise.allSettled(
      createdDcaScheduleIds.map((id) => dca.cancelDCA(id, signer)),
    );
  });
});
