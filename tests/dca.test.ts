import { CoralSwapClient } from '../src/client';
import { DCAModule } from '../src/modules/dca';
import { ValidationError, TransactionError } from '../src/errors';
import { Network } from '../src/types/common';
import type { DCAParams } from '../src/types/dca';
import type { SimulateTransactionResult } from '../src/types/common';
import { nativeToScVal, xdr } from '@stellar/stellar-sdk';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_SECRET = 'SB6K2AINTGNYBFX4M7TRPGSKQ5RKNOXXWB7UZUHRYOVTM7REDUGECKZU';
const DCA_CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const TOKEN_IN = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const TOKEN_OUT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4';
const PAIR = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM';
const OWNER = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';

const TEST_TX_HASH = 'dca-tx-hash-123';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a valid set of DCA params, allowing per-test overrides. */
function makeParams(overrides: Partial<DCAParams> = {}): DCAParams {
  return {
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    amountPerInterval: 100_0000000n,
    intervalSeconds: 86400, // 1 day
    totalIntervals: 7,
    pairAddress: PAIR,
    ...overrides,
  };
}

/** Build a raw on-chain schedule struct, allowing per-field overrides. */
function makeScheduleNative(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: 'schedule-1',
    owner: OWNER,
    token_in: TOKEN_IN,
    token_out: TOKEN_OUT,
    amount_per_interval: '1000000',
    interval_seconds: 86400,
    total_intervals: 7,
    executed_count: 2,
    next_execution_at: 1_700_000_000,
    status: 'active',
    ...overrides,
  };
}

/** Wrap a native value as a successful simulation result (struct return). */
function makeSimResult(native: unknown): SimulateTransactionResult {
  return {
    success: true,
    returnValue: nativeToScVal(native),
    auth: [],
    minResourceFee: '100',
    cost: { cpuInsns: '1000', memBytes: '512' },
    transactionData: null,
    latestLedger: 12345,
    events: [],
    error: null,
    raw: {} as never,
  };
}

/** Wrap a list of native values as a successful simulation result (vec return). */
function makeArraySimResult(items: unknown[]): SimulateTransactionResult {
  const arrayVal = xdr.ScVal.scvVec(items.map((item) => nativeToScVal(item)));
  return {
    success: true,
    returnValue: arrayVal,
    auth: [],
    minResourceFee: '100',
    cost: { cpuInsns: '1000', memBytes: '512' },
    transactionData: null,
    latestLedger: 12345,
    events: [],
    error: null,
    raw: {} as never,
  };
}

/** A successful simulation that returns no value (e.g. unknown schedule). */
function makeEmptySimResult(): SimulateTransactionResult {
  return {
    success: true,
    returnValue: null,
    auth: [],
    minResourceFee: '100',
    cost: { cpuInsns: '1000', memBytes: '512' },
    transactionData: null,
    latestLedger: 12345,
    events: [],
    error: null,
    raw: {} as never,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('DCAModule', () => {
  let client: CoralSwapClient;
  let dca: DCAModule;
  let mockSigner: { publicKey: jest.Mock; signTransaction: jest.Mock };

  beforeEach(() => {
    client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: TEST_SECRET,
    });

    dca = new DCAModule(client, DCA_CONTRACT);

    mockSigner = {
      publicKey: jest.fn().mockResolvedValue(OWNER),
      signTransaction: jest.fn().mockResolvedValue('signed-xdr'),
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function mockSubmitSuccess(): jest.SpyInstance {
    return jest.spyOn(client, 'submitTransaction').mockResolvedValue({
      success: true,
      txHash: TEST_TX_HASH,
      data: { txHash: TEST_TX_HASH, ledger: 1000 },
    });
  }

  // -------------------------------------------------------------------------
  // createDCA()
  // -------------------------------------------------------------------------

  describe('createDCA()', () => {
    it('returns a schedule ID (tx hash) on valid params', async () => {
      mockSubmitSuccess();

      const id = await dca.createDCA(makeParams(), mockSigner);

      expect(id).toBe(TEST_TX_HASH);
      expect(mockSigner.publicKey).toHaveBeenCalled();
    });

    it('throws ValidationError for an invalid tokenIn address', async () => {
      await expect(
        dca.createDCA(makeParams({ tokenIn: 'not-an-address' }), mockSigner),
      ).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError when tokenIn and tokenOut are identical', async () => {
      await expect(
        dca.createDCA(makeParams({ tokenOut: TOKEN_IN }), mockSigner),
      ).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError when amountPerInterval is zero', async () => {
      await expect(
        dca.createDCA(makeParams({ amountPerInterval: 0n }), mockSigner),
      ).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError when interval is below the 1-hour minimum', async () => {
      await expect(
        dca.createDCA(makeParams({ intervalSeconds: 3599 }), mockSigner),
      ).rejects.toThrow(ValidationError);

      await expect(
        dca.createDCA(makeParams({ intervalSeconds: 3599 }), mockSigner),
      ).rejects.toThrow('intervalSeconds must be at least 3600');
    });

    it('accepts the exact 1-hour interval boundary (3600s)', async () => {
      mockSubmitSuccess();

      await expect(
        dca.createDCA(makeParams({ intervalSeconds: 3600 }), mockSigner),
      ).resolves.toBe(TEST_TX_HASH);
    });

    it('throws ValidationError when totalIntervals is below 2', async () => {
      await expect(
        dca.createDCA(makeParams({ totalIntervals: 1 }), mockSigner),
      ).rejects.toThrow(ValidationError);

      await expect(
        dca.createDCA(makeParams({ totalIntervals: 1 }), mockSigner),
      ).rejects.toThrow('totalIntervals must be at least 2');
    });

    it('accepts the exact minimum of 2 intervals', async () => {
      mockSubmitSuccess();

      await expect(
        dca.createDCA(makeParams({ totalIntervals: 2 }), mockSigner),
      ).resolves.toBe(TEST_TX_HASH);
    });

    it('throws ValidationError for a non-integer interval', async () => {
      await expect(
        dca.createDCA(makeParams({ intervalSeconds: 3600.5 }), mockSigner),
      ).rejects.toThrow(ValidationError);
    });

    it('throws TransactionError when submitTransaction reports failure', async () => {
      jest.spyOn(client, 'submitTransaction').mockResolvedValue({
        success: false,
        error: { code: 'SIMULATION_FAILED', message: 'Insufficient balance' },
      });

      await expect(dca.createDCA(makeParams(), mockSigner)).rejects.toThrow(
        TransactionError,
      );
      await expect(dca.createDCA(makeParams(), mockSigner)).rejects.toThrow(
        'createDCA failed: Insufficient balance',
      );
    });
  });

  // -------------------------------------------------------------------------
  // getDCASchedule()
  // -------------------------------------------------------------------------

  describe('getDCASchedule()', () => {
    it('returns a decoded schedule by ID', async () => {
      jest
        .spyOn(client, 'simulateTransaction')
        .mockResolvedValue(makeSimResult(makeScheduleNative()));

      const schedule = await dca.getDCASchedule('schedule-1');

      expect(schedule.id).toBe('schedule-1');
      expect(schedule.owner).toBe(OWNER);
      expect(schedule.amountPerInterval).toBe(1_000_000n);
      expect(schedule.status).toBe('active');
    });

    it('derives remainingCount as totalIntervals - executedCount', async () => {
      jest.spyOn(client, 'simulateTransaction').mockResolvedValue(
        makeSimResult(
          makeScheduleNative({ total_intervals: 10, executed_count: 4 }),
        ),
      );

      const schedule = await dca.getDCASchedule('schedule-1');

      expect(schedule.totalIntervals).toBe(10);
      expect(schedule.executedCount).toBe(4);
      expect(schedule.remainingCount).toBe(6);
    });

    it('throws ValidationError for an empty scheduleId', async () => {
      await expect(dca.getDCASchedule('')).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError when the schedule does not exist', async () => {
      jest
        .spyOn(client, 'simulateTransaction')
        .mockResolvedValue(makeEmptySimResult());

      await expect(dca.getDCASchedule('missing')).rejects.toThrow(
        'DCA schedule not found',
      );
    });
  });

  // -------------------------------------------------------------------------
  // getDCASchedules()
  // -------------------------------------------------------------------------

  describe('getDCASchedules()', () => {
    it('returns all schedules for an address', async () => {
      jest.spyOn(client, 'simulateTransaction').mockResolvedValue(
        makeArraySimResult([
          makeScheduleNative({ id: 'schedule-1' }),
          makeScheduleNative({ id: 'schedule-2', status: 'completed' }),
        ]),
      );

      const schedules = await dca.getDCASchedules(OWNER);

      expect(schedules).toHaveLength(2);
      expect(schedules[0].id).toBe('schedule-1');
      expect(schedules[1].status).toBe('completed');
    });

    it('returns an empty array for an address with no schedules', async () => {
      jest
        .spyOn(client, 'simulateTransaction')
        .mockResolvedValue(makeArraySimResult([]));

      const schedules = await dca.getDCASchedules(OWNER);

      expect(schedules).toEqual([]);
    });

    it('throws ValidationError for an invalid owner address', async () => {
      await expect(dca.getDCASchedules('not-an-address')).rejects.toThrow(
        ValidationError,
      );
    });
  });

  // -------------------------------------------------------------------------
  // getDCAPerformance()
  // -------------------------------------------------------------------------

  describe('getDCAPerformance()', () => {
    it('computes positive savings when DCA beats the lump-sum baseline', async () => {
      jest.spyOn(client, 'simulateTransaction').mockResolvedValue(
        makeSimResult({
          total_invested: '1000',
          total_received: '1100',
          lump_sum_received: '1000',
        }),
      );

      const perf = await dca.getDCAPerformance('schedule-1');

      expect(perf.totalInvested).toBe(1000n);
      expect(perf.totalReceived).toBe(1100n);
      expect(perf.lumpSumReceived).toBe(1000n);
      expect(perf.savings).toBe(100n);
      // 100 / 1000 = 1000 bps
      expect(perf.savingsBps).toBe(1000);
    });

    it('computes negative savings when DCA underperforms the lump sum', async () => {
      jest.spyOn(client, 'simulateTransaction').mockResolvedValue(
        makeSimResult({
          total_invested: '1000',
          total_received: '900',
          lump_sum_received: '1000',
        }),
      );

      const perf = await dca.getDCAPerformance('schedule-1');

      expect(perf.savings).toBe(-100n);
      expect(perf.savingsBps).toBe(-1000);
    });

    it('reports zero savingsBps when the lump-sum baseline is zero', async () => {
      jest.spyOn(client, 'simulateTransaction').mockResolvedValue(
        makeSimResult({
          total_invested: '0',
          total_received: '0',
          lump_sum_received: '0',
        }),
      );

      const perf = await dca.getDCAPerformance('schedule-1');

      expect(perf.savings).toBe(0n);
      expect(perf.savingsBps).toBe(0);
    });

    it('throws ValidationError for an empty scheduleId', async () => {
      await expect(dca.getDCAPerformance('')).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError when the schedule does not exist', async () => {
      jest
        .spyOn(client, 'simulateTransaction')
        .mockResolvedValue(makeEmptySimResult());

      await expect(dca.getDCAPerformance('missing')).rejects.toThrow(
        ValidationError,
      );
    });
  });

  // -------------------------------------------------------------------------
  // cancelDCA()
  // -------------------------------------------------------------------------

  describe('cancelDCA()', () => {
    it('cancels an active schedule and refunds the unspent escrow', async () => {
      // remainingCount = 7 - 2 = 5; refund = 1_000_000 * 5 = 5_000_000
      jest
        .spyOn(client, 'simulateTransaction')
        .mockResolvedValue(makeSimResult(makeScheduleNative()));
      mockSubmitSuccess();

      const result = await dca.cancelDCA('schedule-1', mockSigner);

      expect(result.scheduleId).toBe('schedule-1');
      expect(result.txHash).toBe(TEST_TX_HASH);
      expect(result.refundAmount).toBe(5_000_000n);
    });

    it('refunds zero when no intervals remain', async () => {
      jest.spyOn(client, 'simulateTransaction').mockResolvedValue(
        makeSimResult(
          makeScheduleNative({ total_intervals: 3, executed_count: 3, status: 'active' }),
        ),
      );
      mockSubmitSuccess();

      const result = await dca.cancelDCA('schedule-1', mockSigner);

      expect(result.refundAmount).toBe(0n);
    });

    it('prevents double cancellation (already cancelled)', async () => {
      jest
        .spyOn(client, 'simulateTransaction')
        .mockResolvedValue(makeSimResult(makeScheduleNative({ status: 'cancelled' })));
      const submitSpy = mockSubmitSuccess();

      await expect(dca.cancelDCA('schedule-1', mockSigner)).rejects.toThrow(
        'already cancelled',
      );
      expect(submitSpy).not.toHaveBeenCalled();
    });

    it('rejects cancelling a completed schedule', async () => {
      jest
        .spyOn(client, 'simulateTransaction')
        .mockResolvedValue(makeSimResult(makeScheduleNative({ status: 'completed' })));
      const submitSpy = mockSubmitSuccess();

      await expect(dca.cancelDCA('schedule-1', mockSigner)).rejects.toThrow(
        'Cannot cancel a completed DCA schedule',
      );
      expect(submitSpy).not.toHaveBeenCalled();
    });

    it('throws ValidationError for an empty scheduleId', async () => {
      await expect(dca.cancelDCA('', mockSigner)).rejects.toThrow(
        ValidationError,
      );
    });

    it('throws TransactionError when the cancellation is rejected on-chain', async () => {
      jest
        .spyOn(client, 'simulateTransaction')
        .mockResolvedValue(makeSimResult(makeScheduleNative()));
      jest.spyOn(client, 'submitTransaction').mockResolvedValue({
        success: false,
        error: { code: 'TX_FAILED', message: 'Unauthorized caller' },
      });

      await expect(dca.cancelDCA('schedule-1', mockSigner)).rejects.toThrow(
        TransactionError,
      );
    });
  });
});
