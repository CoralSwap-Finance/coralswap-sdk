import { DCAModule } from '../src/modules/dca';
import { CoralSwapClient } from '../src/client';
import { ValidationError, TransactionError } from '../src/errors';
import { DCASchedule } from '../src/types/dca';

// ---------------------------------------------------------------------------
// Mock @stellar/stellar-sdk
// ---------------------------------------------------------------------------

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    Contract: jest.fn().mockImplementation(() => ({
      call: jest.fn().mockReturnValue({}),
    })),
    Address: jest.fn().mockImplementation(() => ({
      toScVal: jest.fn().mockReturnValue({}),
    })),
    // scValToNative should be a passthrough so decodeSchedule sees our object
    scValToNative: jest.fn().mockImplementation((val: unknown) => val),
  };
});

// ---------------------------------------------------------------------------
// Mock isValidAddress — allow all C/G-prefixed addresses to pass
// ---------------------------------------------------------------------------

jest.mock('../src/utils/addresses', () => ({
  isValidAddress: jest.fn().mockReturnValue(true),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_ADDR_A = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM';
const VALID_ADDR_B = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKBNO';
const VALID_ADDR_C = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKCMP';
const CONTRACT_ADDR = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALD4T';

/**
 * Build a mock contract-encoded schedule object (snake_case keys).
 * `decodeSchedule` reads `total_intervals`, `executed_count`, etc., so the
 * mock must match the shape returned by `scValToNative`.
 */
function makeRawSchedule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sched-1',
    owner: VALID_ADDR_A,
    token_in: VALID_ADDR_A,
    token_out: VALID_ADDR_B,
    amount_per_interval: '10000000',
    interval_seconds: 86400,
    total_intervals: 5,
    executed_count: 2,
    next_execution_at: Math.floor(Date.now() / 1000) + 86400,
    status: 'active',
    ...overrides,
  };
}

function createMockClient(overrides: {
  schedule?: DCASchedule;
  submitResult?: { success: boolean; txHash?: string; error?: { message: string } };
  singleReturnValue?: DCASchedule | null;
  vecReturnValue?: { type: 'scvVec'; vec: DCASchedule[] } | null;
} = {}): CoralSwapClient {
  const defaultSchedule = overrides.schedule ?? makeRawSchedule();
  const submitResult = overrides.submitResult ?? {
    success: true,
    txHash: 'tx_hash_001',
  };

  const simulateTransaction = jest.fn();

  if (overrides.vecReturnValue !== undefined) {
    simulateTransaction.mockResolvedValue({
      success: overrides.vecReturnValue !== null,
      returnValue: overrides.vecReturnValue,
    });
  } else if (overrides.singleReturnValue !== undefined) {
    simulateTransaction.mockResolvedValue({
      success: overrides.singleReturnValue !== null,
      returnValue: overrides.singleReturnValue,
    });
  } else {
    simulateTransaction.mockResolvedValue({
      success: true,
      returnValue: defaultSchedule,
    });
  }

  return {
    simulateTransaction,
    submitTransaction: jest.fn().mockResolvedValue(submitResult),
    publicKey: jest.fn().mockResolvedValue(VALID_ADDR_A),
  } as unknown as CoralSwapClient;
}

function makeSigner() {
  return {
    publicKey: jest.fn().mockResolvedValue(VALID_ADDR_A),
    signTransaction: jest.fn().mockImplementation((_tx: string) =>
      Promise.resolve({ signedTx: _tx, signature: 'sig' }),
    ),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DCAModule — regression', () => {
  describe('schedule-id derivation', () => {
    it('createDCA returns the txHash as the schedule reference', async () => {
      const txHash = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
      const client = createMockClient({
        submitResult: { success: true, txHash },
      });
      const module = new DCAModule(client, CONTRACT_ADDR);

      const id = await module.createDCA(
        {
          tokenIn: VALID_ADDR_A,
          tokenOut: VALID_ADDR_B,
          amountPerInterval: 10_0000000n,
          intervalSeconds: 86400,
          totalIntervals: 5,
          pairAddress: VALID_ADDR_C,
        },
        makeSigner(),
      );

      expect(id).toBe(txHash);
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('createDCA returns undefined when txHash is missing despite success', async () => {
      const client = createMockClient({
        submitResult: { success: true, txHash: undefined },
      });
      const module = new DCAModule(client, CONTRACT_ADDR);

      const id = await module.createDCA(
        {
          tokenIn: VALID_ADDR_A,
          tokenOut: VALID_ADDR_B,
          amountPerInterval: 10_0000000n,
          intervalSeconds: 86400,
          totalIntervals: 5,
          pairAddress: VALID_ADDR_C,
        },
        makeSigner(),
      );

      expect(id).toBeUndefined();
    });
  });

  describe('cancel refund snapshot freshness', () => {
    it('cancelDCA computes refund from the schedule snapshot fetched before submission', async () => {
      const schedule = makeRawSchedule({
        amount_per_interval: '5000000',
        total_intervals: 7,
        executed_count: 3,
        status: 'active',
      });
      const client = createMockClient({
        schedule,
        submitResult: { success: true, txHash: 'cancel-tx' },
      });
      const module = new DCAModule(client, CONTRACT_ADDR);

      const result = await module.cancelDCA('sched-1', makeSigner());

      // refund = amount_per_interval × (total_intervals - executed_count)
      //       = 5_0000000 × (7 - 3) = 5_0000000 × 4
      expect(result.refundAmount).toBe(20_000000n);
      expect(result.txHash).toBe('cancel-tx');
      expect(result.scheduleId).toBe('sched-1');
    });

    it('cancelDCA rejects an already-cancelled schedule before spending gas', async () => {
      const schedule = makeRawSchedule({ status: 'cancelled', executed_count: 5, total_intervals: 5 });
      const client = createMockClient({ schedule });
      const module = new DCAModule(client, CONTRACT_ADDR);

      await expect(module.cancelDCA('sched-1', makeSigner())).rejects.toThrow(
        ValidationError,
      );
      expect(client.submitTransaction).not.toHaveBeenCalled();
    });

    it('cancelDCA rejects a completed schedule before spending gas', async () => {
      const schedule = makeRawSchedule({ status: 'completed', executed_count: 5, total_intervals: 5 });
      const client = createMockClient({ schedule });
      const module = new DCAModule(client, CONTRACT_ADDR);

      await expect(module.cancelDCA('sched-1', makeSigner())).rejects.toThrow(
        ValidationError,
      );
      expect(client.submitTransaction).not.toHaveBeenCalled();
    });

    it('cancelDCA propagates on-chain failure as TransactionError', async () => {
      const schedule = makeRawSchedule({ status: 'active' });
      const client = createMockClient({
        schedule,
        submitResult: {
          success: false,
          error: { message: 'insufficient funds' },
        },
      });
      const module = new DCAModule(client, CONTRACT_ADDR);

      await expect(module.cancelDCA('sched-1', makeSigner())).rejects.toThrow(
        TransactionError,
      );
    });
  });

  describe('plan state', () => {
    it('getDCASchedule returns decoded plan with correct remainingCount', async () => {
      const schedule = makeRawSchedule({
        total_intervals: 10,
        executed_count: 3,
      });
      const client = createMockClient({ singleReturnValue: schedule });
      const module = new DCAModule(client, CONTRACT_ADDR);

      const result = await module.getDCASchedule('sched-1');

      expect(result.totalIntervals).toBe(10);
      expect(result.executedCount).toBe(3);
      expect(result.remainingCount).toBe(7);
    });

    it('getDCASchedule clamps remainingCount to zero when all intervals executed', async () => {
      const schedule = makeRawSchedule({
        total_intervals: 5,
        executed_count: 5,
        status: 'completed',
      });
      const client = createMockClient({ singleReturnValue: schedule });
      const module = new DCAModule(client, CONTRACT_ADDR);

      const result = await module.getDCASchedule('sched-1');

      expect(result.executedCount).toBe(5);
      expect(result.remainingCount).toBe(0);
      expect(result.status).toBe('completed');
    });

    it('getDCASchedule throws ValidationError for empty scheduleId', async () => {
      const client = createMockClient();
      const module = new DCAModule(client, CONTRACT_ADDR);

      await expect(module.getDCASchedule('')).rejects.toThrow(ValidationError);
      await expect(module.getDCASchedule('  ')).rejects.toThrow(ValidationError);
    });

    it('getDCASchedule throws ValidationError when schedule not found', async () => {
      const client = createMockClient({ singleReturnValue: null });
      const module = new DCAModule(client, CONTRACT_ADDR);

      await expect(module.getDCASchedule('nonexistent')).rejects.toThrow(
        ValidationError,
      );
    });

    it('getDCASchedules returns empty array for address with no schedules', async () => {
      const client = createMockClient({ vecReturnValue: null });
      const module = new DCAModule(client, CONTRACT_ADDR);

      const result = await module.getDCASchedules(VALID_ADDR_A);

      expect(result).toEqual([]);
    });

    it('getDCASchedules rejects invalid Stellar address', async () => {
      // Temporarily restore real isValidAddress for this test
      const { isValidAddress } = require('../src/utils/addresses');
      isValidAddress.mockReturnValueOnce(false);

      const client = createMockClient();
      const module = new DCAModule(client, CONTRACT_ADDR);

      await expect(module.getDCASchedules('not-an-address')).rejects.toThrow(
        ValidationError,
      );
    });
  });

  describe('input validation', () => {
    it('createDCA rejects identical tokenIn and tokenOut', async () => {
      const client = createMockClient();
      const module = new DCAModule(client, CONTRACT_ADDR);

      await expect(
        module.createDCA(
          {
            tokenIn: VALID_ADDR_A,
            tokenOut: VALID_ADDR_A,
            amountPerInterval: 10_0000000n,
            intervalSeconds: 86400,
            totalIntervals: 5,
            pairAddress: VALID_ADDR_C,
          },
          makeSigner(),
        ),
      ).rejects.toThrow(ValidationError);
    });

    it('createDCA rejects intervalSeconds below minimum', async () => {
      const client = createMockClient();
      const module = new DCAModule(client, CONTRACT_ADDR);

      await expect(
        module.createDCA(
          {
            tokenIn: VALID_ADDR_A,
            tokenOut: VALID_ADDR_B,
            amountPerInterval: 10_0000000n,
            intervalSeconds: 60,
            totalIntervals: 5,
            pairAddress: VALID_ADDR_C,
          },
          makeSigner(),
        ),
      ).rejects.toThrow(ValidationError);
    });

    it('createDCA rejects totalIntervals below minimum', async () => {
      const client = createMockClient();
      const module = new DCAModule(client, CONTRACT_ADDR);

      await expect(
        module.createDCA(
          {
            tokenIn: VALID_ADDR_A,
            tokenOut: VALID_ADDR_B,
            amountPerInterval: 10_0000000n,
            intervalSeconds: 86400,
            totalIntervals: 1,
            pairAddress: VALID_ADDR_C,
          },
          makeSigner(),
        ),
      ).rejects.toThrow(ValidationError);
    });

    it('createDCA rejects non-positive amountPerInterval', async () => {
      const client = createMockClient();
      const module = new DCAModule(client, CONTRACT_ADDR);

      await expect(
        module.createDCA(
          {
            tokenIn: VALID_ADDR_A,
            tokenOut: VALID_ADDR_B,
            amountPerInterval: 0n,
            intervalSeconds: 86400,
            totalIntervals: 5,
            pairAddress: VALID_ADDR_C,
          },
          makeSigner(),
        ),
      ).rejects.toThrow(ValidationError);
    });

    it('cancelDCA rejects empty scheduleId', async () => {
      const client = createMockClient();
      const module = new DCAModule(client, CONTRACT_ADDR);

      await expect(
        module.cancelDCA('', makeSigner()),
      ).rejects.toThrow(ValidationError);
    });
  });
});
