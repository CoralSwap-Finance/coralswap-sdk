import { SorobanRpc, xdr } from '@stellar/stellar-sdk';

/**
 * Transaction simulation utilities.
 *
 * Pre-flight checks before submitting transactions to Soroban.
 */

/**
 * Standardized simulation response wrapper.
 */
export interface SimulationResult<T> {
  success: boolean;
  data: T;
  error?: string;
}

/**
 * Resource usage estimate extracted from simulation cost.
 */
export interface SimulationResourceEstimate {
  cpuInstructions: number;
  memoryBytes: number;
  readBytes: number;
  writeBytes: number;
}

function simulationFailedResult<T>(data: T): SimulationResult<T> {
  return {
    success: false,
    data,
    error: 'Simulation failed',
  };
}

/**
 * Check if a simulation result is successful.
 */
export function isSimulationSuccess(
  sim: SorobanRpc.Api.SimulateTransactionResponse,
): SimulationResult<boolean> {
  const success = SorobanRpc.Api.isSimulationSuccess(sim);
  if (!success) return simulationFailedResult(false);

  return {
    success: true,
    data: true,
  };
}

/**
 * Extract the return value from a successful simulation.
 */
export function getSimulationReturnValue(
  sim: SorobanRpc.Api.SimulateTransactionResponse,
): SimulationResult<xdr.ScVal | null> {
  if (!SorobanRpc.Api.isSimulationSuccess(sim)) {
    return simulationFailedResult(null);
  }

  return {
    success: true,
    data: sim.result?.retval ?? null,
  };
}

/**
 * Extract resource usage estimates from a simulation.
 */
export function getResourceEstimate(
  sim: SorobanRpc.Api.SimulateTransactionResponse,
): SimulationResult<SimulationResourceEstimate | null> {
  if (!SorobanRpc.Api.isSimulationSuccess(sim)) {
    return simulationFailedResult(null);
  }

  const cost = sim.cost;
  return {
    success: true,
    data: {
      cpuInstructions: cost?.cpuInsns ? Number(cost.cpuInsns) : 0,
      memoryBytes: cost?.memBytes ? Number(cost.memBytes) : 0,
      readBytes: 0,
      writeBytes: 0,
    },
  };
}

/**
 * Check if a simulation exceeds budget limits.
 */
export function exceedsBudget(
  sim: SorobanRpc.Api.SimulateTransactionResponse,
  maxInstructions: number = 100_000_000,
): SimulationResult<boolean> {
  const resources = getResourceEstimate(sim);
  if (!resources.success || !resources.data) {
    return simulationFailedResult(true);
  }

  return {
    success: true,
    data: resources.data.cpuInstructions > maxInstructions,
  };
}
