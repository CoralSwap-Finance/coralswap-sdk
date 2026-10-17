import { verifyReserveConservation } from '../src/contracts/reserve-conservation';
import type { PairClient } from '../src/contracts/pair';

const FEE_RECEIVER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

/** Fixture reserves before any borrower callback runs. */
const RESERVES_BEFORE = { reserve0: 1_000_000_000n, reserve1: 500_000_000n };

function makeMockPair(opts: {
  reservesSequence: Array<{ reserve0: bigint; reserve1: bigint }>;
  flashFeeBps?: number;
}): PairClient {
  const getReserves = jest.fn();
  for (const reserves of opts.reservesSequence) {
    getReserves.mockResolvedValueOnce(reserves);
  }

  return {
    getReserves,
    getFlashLoanConfig: jest.fn().mockResolvedValue({
      flashFeeBps: opts.flashFeeBps ?? 9,
      locked: false,
      flashFeeFloor: 0n,
    }),
  } as unknown as PairClient;
}

describe('verifyReserveConservation', () => {
  it('passes when reserves (and k) are unchanged after the callback', async () => {
    const pair = makeMockPair({
      reservesSequence: [RESERVES_BEFORE, RESERVES_BEFORE],
    });
    const callback = jest.fn().mockResolvedValue(undefined);

    const result = await verifyReserveConservation(pair, FEE_RECEIVER, callback);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.kBefore).toBe(RESERVES_BEFORE.reserve0 * RESERVES_BEFORE.reserve1);
    expect(result.kAfter).toBe(result.kBefore);
    expect(result.reason).toBeUndefined();
  });

  it('passes when k grows (a legitimate trade/fee added back to reserves)', async () => {
    const reservesAfter = { reserve0: 1_000_100_000n, reserve1: 500_050_000n };
    const pair = makeMockPair({
      reservesSequence: [RESERVES_BEFORE, reservesAfter],
    });

    const result = await verifyReserveConservation(
      pair,
      FEE_RECEIVER,
      jest.fn().mockResolvedValue(undefined),
    );

    expect(result.ok).toBe(true);
    expect(result.kAfter).toBeGreaterThan(result.kBefore);
  });

  it('passes when k drops by exactly the pair\'s flash-loan fee tolerance (fee skimmed to feeReceiver)', async () => {
    const flashFeeBps = 9; // 0.09%
    const kBefore = RESERVES_BEFORE.reserve0 * RESERVES_BEFORE.reserve1;
    const toleranceAmount = (kBefore * BigInt(flashFeeBps)) / 10_000n;
    const minAcceptableK = kBefore - toleranceAmount;

    // Hold reserve1 fixed, shrink reserve0 so reserve0*reserve1 lands exactly
    // on the tolerance boundary.
    const reserve0After = minAcceptableK / RESERVES_BEFORE.reserve1;
    const reservesAfter = { reserve0: reserve0After, reserve1: RESERVES_BEFORE.reserve1 };

    const pair = makeMockPair({
      reservesSequence: [RESERVES_BEFORE, reservesAfter],
      flashFeeBps,
    });

    const result = await verifyReserveConservation(
      pair,
      FEE_RECEIVER,
      jest.fn().mockResolvedValue(undefined),
    );

    expect(result.toleranceBps).toBe(flashFeeBps);
    expect(result.kAfter).toBeGreaterThanOrEqual(result.minAcceptableK);
    expect(result.ok).toBe(true);
  });

  it('fails when k drops beyond tolerance (borrower manipulated reserves without paying the fee)', async () => {
    // A steep drop in reserve0 with reserve1 unchanged -- far beyond what a
    // 9 bps fee tolerance would excuse.
    const reservesAfter = { reserve0: 900_000_000n, reserve1: RESERVES_BEFORE.reserve1 };
    const pair = makeMockPair({
      reservesSequence: [RESERVES_BEFORE, reservesAfter],
      flashFeeBps: 9,
    });

    const result = await verifyReserveConservation(
      pair,
      FEE_RECEIVER,
      jest.fn().mockResolvedValue(undefined),
    );

    expect(result.ok).toBe(false);
    expect(result.kAfter).toBeLessThan(result.minAcceptableK);
    expect(result.reason).toContain('degraded beyond tolerance');
    expect(result.reason).toContain(FEE_RECEIVER);
  });

  it('uses an explicit toleranceBps override instead of the pair\'s flashFeeBps', async () => {
    const reservesAfter = { reserve0: 900_000_000n, reserve1: RESERVES_BEFORE.reserve1 };
    const pair = makeMockPair({
      reservesSequence: [RESERVES_BEFORE, reservesAfter],
      flashFeeBps: 9,
    });

    // 10% tolerance is generous enough to cover a 10% reserve0 drop.
    const result = await verifyReserveConservation(
      pair,
      FEE_RECEIVER,
      jest.fn().mockResolvedValue(undefined),
      { toleranceBps: 1000 },
    );

    expect(result.toleranceBps).toBe(1000);
    expect(pair.getFlashLoanConfig).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it('snapshots reserves before invoking the callback, not after', async () => {
    const reservesAfter = { reserve0: 2_000_000_000n, reserve1: 1_000_000_000n };
    // No reservesSequence here -- mockImplementation is the only source of
    // return values, so it must not be layered under queued
    // mockResolvedValueOnce calls (those take priority over
    // mockImplementation regardless of call order, which would silently
    // bypass the order-tracking below).
    const pair = makeMockPair({ reservesSequence: [] });

    const callOrder: string[] = [];
    let call = 0;
    const values = [RESERVES_BEFORE, reservesAfter];
    (pair.getReserves as jest.Mock).mockImplementation(async () => {
      callOrder.push(`getReserves#${call}`);
      return values[call++];
    });
    const callback = jest.fn().mockImplementation(async () => {
      callOrder.push('callback');
    });

    const result = await verifyReserveConservation(pair, FEE_RECEIVER, callback);

    expect(callOrder).toEqual(['getReserves#0', 'callback', 'getReserves#1']);
    expect(result.reservesBefore).toEqual(RESERVES_BEFORE);
    expect(result.reservesAfter).toEqual(reservesAfter);
  });

  it('propagates an error thrown by the borrower callback without swallowing it', async () => {
    const pair = makeMockPair({ reservesSequence: [RESERVES_BEFORE] });
    const callback = jest.fn().mockRejectedValue(new Error('callback reverted'));

    await expect(verifyReserveConservation(pair, FEE_RECEIVER, callback)).rejects.toThrow(
      'callback reverted',
    );
  });
});
