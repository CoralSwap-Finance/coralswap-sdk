import { Network } from '../../src/types/common';
import { CoralSwapClient } from '../../src/client';
import { DCAModule } from '../../src/modules/dca';
import { KeypairSigner } from '../../src/utils/signer';
import { DCASchedule } from '../../src/types/dca';

/**
 * Integration test: DCA schedule creation, cancellation refund, and cleanup
 * against real Stellar Testnet contract state.
 *
 * Prerequisites (env vars):
 *   STELLAR_TESTNET   – must be 'true' to run
 *   TEST_KEYPAIR      – funded testnet secret key (S...)
 *   TEST_TOKEN_IN     – contract address of the token spent each interval (escrowed)
 *   TEST_TOKEN_OUT    – contract address of the token accumulated
 *   TEST_PAIR_ADDRESS – address of the tokenIn/tokenOut pair the swaps route through
 *   TEST_DCA_CONTRACT – address of the deployed DCA scheduler contract
 *   TEST_RPC_URL      – optional Soroban RPC URL override
 *
 * Flow:
 *   1. Record the tokenIn balance before any on-chain action.
 *   2. Snapshot existing schedules so the newly created one can be identified.
 *   3. Create a short DCA schedule (2 intervals at 1-hour spacing).
 *   4. Verify the schedule appears in getDCASchedules() with status 'active'
 *      and zero executions.
 *   5. Assert the escrowed amount (amountPerInterval * totalIntervals) left the
 *      owner's tokenIn balance.
 *   6. Cancel the schedule and assert the exact refund: the on-chain refund
 *      equals the full escrow and the final tokenIn balance equals the initial
 *      balance (fees are paid in native XLM, so the tokenIn balance is only
 *      moved by escrow/refund).
 *   7. Confirm the schedule is no longer active.
 *
 * Cleanup: any schedule left active after the run (including after assertion
 * failures) is cancelled in afterAll so subsequent runs start clean.
 */

const SKIP =
  process.env.STELLAR_TESTNET !== 'true' ||
  !process.env.TEST_KEYPAIR ||
  !process.env.TEST_TOKEN_IN ||
  !process.env.TEST_TOKEN_OUT ||
  !process.env.TEST_PAIR_ADDRESS ||
  !process.env.TEST_DCA_CONTRACT;

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

const describeIntegration = SKIP ? describe.skip : describe;

describeIntegration('DCAModule integration (testnet)', () => {
  let client: CoralSwapClient;
  let dca: DCAModule;
  let signer: KeypairSigner;

  let tokenIn: string;
  let tokenOut: string;
  let pairAddress: string;
  let dcaContract: string;

  /** Schedule IDs created in this run — cancelled in afterAll for cleanup. */
  const createdScheduleIds: string[] = [];

  const AMOUNT_PER_INTERVAL = 1_0000000n; // 1 tokenIn (7 decimals)
  const TOTAL_INTERVALS = 2;
  const INTERVAL_SECONDS = 3600; // 1 hour (the minimum allowed interval)

  beforeAll(async () => {
    tokenIn = requireEnv('TEST_TOKEN_IN');
    tokenOut = requireEnv('TEST_TOKEN_OUT');
    pairAddress = requireEnv('TEST_PAIR_ADDRESS');
    dcaContract = requireEnv('TEST_DCA_CONTRACT');

    client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: requireEnv('TEST_KEYPAIR'),
      ...(process.env.TEST_RPC_URL ? { rpcUrl: process.env.TEST_RPC_URL } : {}),
    });

    signer = new KeypairSigner(
      requireEnv('TEST_KEYPAIR'),
      client.networkConfig.networkPassphrase,
    );

    dca = new DCAModule(client, dcaContract);
  });

  /** Cancel every schedule currently active for the owner (best-effort). */
  async function cancelActiveSchedules(): Promise<void> {
    const schedules = await dca.getDCASchedules(client.publicKey);
    for (const schedule of schedules) {
      if (schedule.status === 'active') {
        try {
          await dca.cancelDCA(schedule.id, signer);
          // eslint-disable-next-line no-console
          console.log(`Cleanup: cancelled leftover active schedule ${schedule.id}`);
        } catch {
          // best-effort cleanup
        }
      }
    }
  }

  afterAll(async () => {
    // Cancel every schedule created during this run.
    for (const scheduleId of createdScheduleIds) {
      try {
        const status = await dca.getDCASchedule(scheduleId);
        if (status.status === 'active') {
          await dca.cancelDCA(scheduleId, signer);
        }
      } catch {
        // best-effort cleanup
      }
    }
    // Sweep any strays left behind by a failed assertion.
    await cancelActiveSchedules();
  });
  // ---------------------------------------------------------------------------
  // Create -> verify via getDCASchedules() -> cancel -> assert exact refund
  // ---------------------------------------------------------------------------
  it(
    'creates a DCA schedule, verifies it via getDCASchedules(), cancels it, ' +
      'and refunds the full escrow',
    async () => {
      const owner = client.publicKey;
      const escrowed = AMOUNT_PER_INTERVAL * BigInt(TOTAL_INTERVALS);

      // Record the tokenIn balance before escrow. Transaction fees are paid in
      // native XLM, so the tokenIn balance only moves by escrow/refund amounts.
      const initialBalance = await client.lpToken(tokenIn).balance(owner);

      // Snapshot existing schedules to identify the newly created one.
      const schedulesBefore = await dca.getDCASchedules(owner);
      const idsBefore = new Set(schedulesBefore.map((s: DCASchedule) => s.id));

      const txHash = await dca.createDCA(
        {
          tokenIn,
          tokenOut,
          amountPerInterval: AMOUNT_PER_INTERVAL,
          intervalSeconds: INTERVAL_SECONDS,
          totalIntervals: TOTAL_INTERVALS,
          pairAddress,
        },
        signer,
      );
      expect(typeof txHash).toBe('string');
      expect(txHash.length).toBeGreaterThan(0);

      // Give the network a moment to apply the transaction.
      await new Promise((r) => setTimeout(r, 3_000));

      // Identify the newly created schedule from the on-chain list.
      const schedulesAfter = await dca.getDCASchedules(owner);
      const newSchedules = schedulesAfter.filter(
        (s: DCASchedule) => !idsBefore.has(s.id),
      );
      expect(newSchedules.length).toBeGreaterThanOrEqual(1);

      const scheduleId = newSchedules[0].id;
      createdScheduleIds.push(scheduleId);

      const placed = schedulesAfter.find((s: DCASchedule) => s.id === scheduleId);
      expect(placed).toBeDefined();
      expect(placed!.owner).toBe(owner);
      expect(placed!.tokenIn.toLowerCase()).toBe(tokenIn.toLowerCase());
      expect(placed!.tokenOut.toLowerCase()).toBe(tokenOut.toLowerCase());
      expect(placed!.amountPerInterval).toBe(AMOUNT_PER_INTERVAL);
      expect(placed!.totalIntervals).toBe(TOTAL_INTERVALS);
      // A fresh 1-hour-interval schedule should not have executed yet.
      expect(placed!.executedCount).toBe(0);
      expect(placed!.status).toBe('active');

      // The full budget should have been escrowed.
      const afterCreateBalance = await client.lpToken(tokenIn).balance(owner);
      expect(afterCreateBalance).toBe(initialBalance - escrowed);

      // -----------------------------------------------------------------------
      // Cancel -> verify cancellation state and exact refund
      // -----------------------------------------------------------------------
      const cancellation = await dca.cancelDCA(scheduleId, signer);
      expect(cancellation.scheduleId).toBe(scheduleId);
      expect(typeof cancellation.txHash).toBe('string');
      expect(cancellation.txHash.length).toBeGreaterThan(0);
      // Nothing executed, so the full escrow is refunded.
      expect(cancellation.refundAmount).toBe(escrowed);

      await new Promise((r) => setTimeout(r, 3_000));

      // The schedule must no longer be active for this owner.
      const afterCancel = await dca.getDCASchedules(owner);
      const stillActive = afterCancel.filter(
        (s: DCASchedule) => s.id === scheduleId && s.status === 'active',
      );
      expect(stillActive.length).toBe(0);

      // Exact refund: tokenIn balance is back to the initial value.
      const finalBalance = await client.lpToken(tokenIn).balance(owner);
      expect(finalBalance).toBe(initialBalance);
    },
  );

  // ---------------------------------------------------------------------------
  // getDCASchedules() returns an array for the owner after cancellation.
  // ---------------------------------------------------------------------------
  it('getDCASchedules() returns an array for the owner after cancellation', async () => {
    const schedules = await dca.getDCASchedules(client.publicKey);
    expect(Array.isArray(schedules)).toBe(true);

    // No schedule created during this run should remain active.
    const stillActive = schedules.filter(
      (s: DCASchedule) =>
        s.status === 'active' && createdScheduleIds.includes(s.id),
    );
    expect(stillActive.length).toBe(0);
  });
});
