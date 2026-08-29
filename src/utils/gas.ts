import { xdr } from '@stellar/stellar-sdk';
import { SimulateTransactionResult } from '@/types/common';
import { GasEstimate } from '@/types/gas';
import { SimulationError } from '@/errors';

const STROOPS_PER_XLM = 10_000_000;

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
  const fee = parseInt(sim.minResourceFee, 10) || 0;
  const feeXLM = `${(fee / STROOPS_PER_XLM).toFixed(5)} XLM`;
  return { fee, feeXLM };
}
