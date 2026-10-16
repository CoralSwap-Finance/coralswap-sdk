import { xdr } from '@stellar/stellar-sdk';
import { SimulateTransactionResult } from '@/types/common';
import { GasEstimate } from '@/types/gas';
import { SimulationError } from '@/errors';

/**
 * Parse a stroop string into a BigInt without passing through `Number`.
 * Empty or malformed input yields `0n`.
 */
export function parseStroops(raw: string | undefined | null): bigint {
  const trimmed = (raw ?? '').trim();
  if (!/^\d+$/.test(trimmed)) return 0n;
  return BigInt(trimmed);
}

/**
 * Format a stroop amount as an XLM string with 5 decimal places
 * (rounded half-up), using only BigInt arithmetic.
 */
export function formatStroopsAsXLM(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  // 5 decimals => scale of 100 stroops, round half-up.
  const scaled = (abs + 50n) / 100n;
  const whole = scaled / 100_000n;
  const frac = (scaled % 100_000n).toString().padStart(5, '0');
  return `${negative ? '-' : ''}${whole}.${frac} XLM`;
}

/**
 * A function that simulates a set of operations and returns a typed result.
 * Matches the enhanced form of CoralSwapClient.simulateTransaction.
 */
export type SimulateFn = (
  operations: xdr.Operation[],
) => Promise<SimulateTransactionResult>;

/**
 * Estimate the network fee for a set of operations by running a dry-run simulation.
 *
 * @param simulate - Async function that simulates the given operations.
 *   Pass `(ops) => client.simulateTransaction(ops, {})` from a module or client context.
 * @param operations - The operations whose fee should be estimated.
 * @returns A {@link GasEstimate} with the fee in stroops and human-readable XLM string.
 * @throws {SimulationError} If the simulation reports failure.
 *
 * @example
 * const gas = await estimateGas(
 *   (ops) => client.simulateTransaction(ops, {}),
 *   [swapOp],
 * );
 * console.log(gas.feeXLM); // "0.00001 XLM"
 */
export async function estimateGas(
  simulate: SimulateFn,
  operations: xdr.Operation[],
): Promise<GasEstimate> {
  const sim = await simulate(operations);
  if (!sim.success) {
    throw new SimulationError(sim.error ?? 'Simulation failed', {
      reason: sim.error ?? 'Simulation failed',
    });
  }
  const fee = parseStroops(sim.minResourceFee);
  const feeXLM = formatStroopsAsXLM(fee);
  return { fee, feeRaw: fee.toString(), feeXLM };
}
