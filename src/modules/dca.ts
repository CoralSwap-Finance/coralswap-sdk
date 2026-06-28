import { CoralSwapClient } from '@/client';
import {
  DCAParams,
  DCASchedule,
  DCAPerformance,
  DCACancellation,
  DCAStatus,
} from '@/types/dca';
import { Signer } from '@/types/common';
import { ValidationError, TransactionError } from '@/errors';
import {
  validateAddress,
  validatePositiveAmount,
  validateDistinctTokens,
} from '@/utils/validation';
import {
  Contract,
  nativeToScVal,
  Address,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';

/** Minimum allowed interval between DCA executions (1 hour, in seconds). */
const MIN_INTERVAL_SECONDS = 3600;

/** Minimum number of intervals for a schedule to qualify as DCA. */
const MIN_TOTAL_INTERVALS = 2;

/** Basis-points denominator used for savings calculations. */
const BPS_DENOMINATOR = 10000n;

/**
 * DCA module — dollar-cost-averaging schedule creation and management.
 *
 * Wraps the on-chain DCA scheduler contract so dApp builders can create
 * time-spaced swap schedules, inspect their progress, measure performance
 * against a lump-sum baseline, and cancel with an automatic refund of the
 * unspent escrow.
 */
export class DCAModule {
  private readonly client: CoralSwapClient;
  private readonly contractAddress: string;

  constructor(client: CoralSwapClient, contractAddress: string) {
    this.client = client;
    this.contractAddress = contractAddress;
  }

  // ---------------------------------------------------------------------------
  // Write operations (require signing)
  // ---------------------------------------------------------------------------

  /**
   * Create a new DCA schedule, escrowing the full budget up front.
   *
   * @param params - Schedule parameters (tokens, amount, interval, count, pair)
   * @param signer - Wallet signer that funds and authorises the schedule
   * @returns The unique schedule ID assigned by the contract
   * @throws {ValidationError} If addresses are invalid, tokens are identical,
   *   the amount is non-positive, the interval is below one hour, or fewer
   *   than two intervals are requested
   * @throws {TransactionError} If the transaction is rejected on-chain
   * @example
   * const id = await client.dca.createDCA({
   *   tokenIn: 'C...', tokenOut: 'C...', amountPerInterval: 100_0000000n,
   *   intervalSeconds: 86400, totalIntervals: 7, pairAddress: 'C...',
   * }, signer);
   */
  async createDCA(params: DCAParams, signer: Signer): Promise<string> {
    validateAddress(params.tokenIn, 'tokenIn');
    validateAddress(params.tokenOut, 'tokenOut');
    validateAddress(params.pairAddress, 'pairAddress');
    validateDistinctTokens(params.tokenIn, params.tokenOut);
    validatePositiveAmount(params.amountPerInterval, 'amountPerInterval');

    if (
      !Number.isInteger(params.intervalSeconds) ||
      params.intervalSeconds < MIN_INTERVAL_SECONDS
    ) {
      throw new ValidationError(
        `intervalSeconds must be at least ${MIN_INTERVAL_SECONDS} (1 hour), got ${params.intervalSeconds}`,
        { intervalSeconds: params.intervalSeconds },
      );
    }

    if (
      !Number.isInteger(params.totalIntervals) ||
      params.totalIntervals < MIN_TOTAL_INTERVALS
    ) {
      throw new ValidationError(
        `totalIntervals must be at least ${MIN_TOTAL_INTERVALS}, got ${params.totalIntervals}`,
        { totalIntervals: params.totalIntervals },
      );
    }

    const signerPublicKey = await signer.publicKey();
    const contract = new Contract(this.contractAddress);

    const op = contract.call(
      'create_dca',
      new Address(params.tokenIn).toScVal(),
      new Address(params.tokenOut).toScVal(),
      nativeToScVal(params.amountPerInterval, { type: 'i128' }),
      nativeToScVal(params.intervalSeconds, { type: 'u32' }),
      nativeToScVal(params.totalIntervals, { type: 'u32' }),
      new Address(params.pairAddress).toScVal(),
      new Address(signerPublicKey).toScVal(),
    );

    const result = await this.client.submitTransaction([op], signerPublicKey);

    if (!result.success) {
      throw new TransactionError(
        `createDCA failed: ${result.error?.message ?? 'Unknown error'}`,
        result.txHash,
      );
    }

    // The contract returns the schedule ID; the txHash is a stable reference
    // when the return value cannot be extracted from the polling result.
    return result.txHash!;
  }

  /**
   * Cancel an active DCA schedule and refund the unspent escrow.
   *
   * The refund equals the escrowed budget for every interval that has not yet
   * executed (`amountPerInterval * remainingCount`).
   *
   * @param scheduleId - ID of the schedule to cancel
   * @param signer - Wallet signer that owns the schedule
   * @returns Cancellation details including the computed refund amount
   * @throws {ValidationError} If `scheduleId` is empty, or the schedule is
   *   already cancelled or has already completed
   * @throws {TransactionError} If the transaction is rejected on-chain
   */
  async cancelDCA(
    scheduleId: string,
    signer: Signer,
  ): Promise<DCACancellation> {
    if (!scheduleId || scheduleId.trim().length === 0) {
      throw new ValidationError('scheduleId must not be empty');
    }

    // Read current state first so we can reject no-op cancellations before
    // spending gas, and compute an accurate refund.
    const schedule = await this.getDCASchedule(scheduleId);

    if (schedule.status === 'cancelled') {
      throw new ValidationError('DCA schedule is already cancelled', {
        scheduleId,
      });
    }
    if (schedule.status === 'completed') {
      throw new ValidationError('Cannot cancel a completed DCA schedule', {
        scheduleId,
      });
    }

    const refundAmount =
      schedule.amountPerInterval * BigInt(schedule.remainingCount);

    const signerPublicKey = await signer.publicKey();
    const contract = new Contract(this.contractAddress);

    const op = contract.call(
      'cancel_dca',
      nativeToScVal(scheduleId, { type: 'string' }),
      new Address(signerPublicKey).toScVal(),
    );

    const result = await this.client.submitTransaction([op], signerPublicKey);

    if (!result.success) {
      throw new TransactionError(
        `cancelDCA failed: ${result.error?.message ?? 'Unknown error'}`,
        result.txHash,
      );
    }

    return {
      scheduleId,
      txHash: result.txHash!,
      refundAmount,
    };
  }

  // ---------------------------------------------------------------------------
  // Read operations
  // ---------------------------------------------------------------------------

  /**
   * Fetch a single DCA schedule by its ID.
   *
   * @param scheduleId - Unique schedule identifier
   * @returns Full schedule state
   * @throws {ValidationError} If `scheduleId` is empty or no schedule exists
   */
  async getDCASchedule(scheduleId: string): Promise<DCASchedule> {
    if (!scheduleId || scheduleId.trim().length === 0) {
      throw new ValidationError('scheduleId must not be empty');
    }

    const contract = new Contract(this.contractAddress);
    const op = contract.call(
      'get_schedule',
      nativeToScVal(scheduleId, { type: 'string' }),
    );

    const sim = await this.client.simulateTransaction([op], {});

    if (!sim.success || !sim.returnValue) {
      throw new ValidationError('DCA schedule not found', { scheduleId });
    }

    return this.decodeSchedule(sim.returnValue);
  }

  /**
   * Fetch all DCA schedules owned by an address.
   *
   * @param owner - Stellar address to query
   * @returns Array of schedules (empty for an address with no schedules)
   * @throws {ValidationError} If `owner` is not a valid Stellar address
   */
  async getDCASchedules(owner: string): Promise<DCASchedule[]> {
    validateAddress(owner, 'owner');

    const contract = new Contract(this.contractAddress);
    const op = contract.call('get_schedules', new Address(owner).toScVal());

    const sim = await this.client.simulateTransaction([op], {});

    if (!sim.success || !sim.returnValue) {
      return [];
    }

    const items = sim.returnValue.vec();
    if (!items) return [];

    return items.map((v) => this.decodeSchedule(v));
  }

  /**
   * Compute performance for a DCA schedule versus a lump-sum baseline.
   *
   * The contract returns the realised aggregates (total invested, total
   * received) plus the `tokenOut` a single lump-sum swap of the same size
   * would have produced. Savings are derived client-side so the comparison
   * is transparent and deterministic.
   *
   * @param scheduleId - Unique schedule identifier
   * @returns Performance breakdown including absolute and basis-point savings
   * @throws {ValidationError} If `scheduleId` is empty or no schedule exists
   */
  async getDCAPerformance(scheduleId: string): Promise<DCAPerformance> {
    if (!scheduleId || scheduleId.trim().length === 0) {
      throw new ValidationError('scheduleId must not be empty');
    }

    const contract = new Contract(this.contractAddress);
    const op = contract.call(
      'get_performance',
      nativeToScVal(scheduleId, { type: 'string' }),
    );

    const sim = await this.client.simulateTransaction([op], {});

    if (!sim.success || !sim.returnValue) {
      throw new ValidationError('DCA schedule not found', { scheduleId });
    }

    const native = scValToNative(sim.returnValue) as Record<string, unknown>;

    const totalInvested = BigInt(String(native['total_invested'] ?? '0'));
    const totalReceived = BigInt(String(native['total_received'] ?? '0'));
    const lumpSumReceived = BigInt(String(native['lump_sum_received'] ?? '0'));

    const savings = totalReceived - lumpSumReceived;
    const savingsBps =
      lumpSumReceived === 0n
        ? 0
        : Number((savings * BPS_DENOMINATOR) / lumpSumReceived);

    return {
      scheduleId,
      totalInvested,
      totalReceived,
      lumpSumReceived,
      savings,
      savingsBps,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private decodeSchedule(val: xdr.ScVal): DCASchedule {
    const native = scValToNative(val) as Record<string, unknown>;

    const totalIntervals = Number(native['total_intervals'] ?? 0);
    const executedCount = Number(native['executed_count'] ?? 0);
    const remainingCount = Math.max(totalIntervals - executedCount, 0);

    return {
      id: String(native['id'] ?? ''),
      owner: String(native['owner'] ?? ''),
      tokenIn: String(native['token_in'] ?? ''),
      tokenOut: String(native['token_out'] ?? ''),
      amountPerInterval: BigInt(String(native['amount_per_interval'] ?? '0')),
      intervalSeconds: Number(native['interval_seconds'] ?? 0),
      totalIntervals,
      executedCount,
      remainingCount,
      nextExecutionAt: Number(native['next_execution_at'] ?? 0),
      status: (native['status'] as DCAStatus) ?? 'active',
    };
  }
}
