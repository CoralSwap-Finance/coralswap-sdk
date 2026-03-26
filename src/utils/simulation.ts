import { SorobanRpc, xdr } from '@stellar/stellar-sdk';
import type { SimulateTransactionResult, SimulationDiagnosticEvent } from '@/types/common';

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
 * Decode the raw base64-XDR diagnostic events from a simulation response.
 *
 * The `events` field on a successful `SimulateTransactionResponse` is a
 * `string[]` where each entry is a base64-encoded `xdr.DiagnosticEvent`.
 * Entries that fail XDR parsing (e.g. due to schema version differences)
 * are returned with `decoded: null` so the caller can still access the
 * raw XDR string.
 *
 * @param rawEvents - The `events` array from the RPC response (may be undefined)
 * @returns Array of `SimulationDiagnosticEvent` objects
 */
export function decodeDiagnosticEvents(
  rawEvents: string[] | undefined,
): SimulationDiagnosticEvent[] {
  if (!rawEvents || rawEvents.length === 0) return [];

  return rawEvents.map((xdrStr): SimulationDiagnosticEvent => {
    try {
      return {
        xdr: xdrStr,
        decoded: xdr.DiagnosticEvent.fromXDR(xdrStr, 'base64'),
      };
    } catch {
      return { xdr: xdrStr, decoded: null };
    }
  });
}

/**
 * Build a structured {@link SimulateTransactionResult} from a raw RPC response.
 *
 * Centralises all field extraction so both `client.ts` and any future
 * callers get a consistent, fully-typed view of the simulation data.
 *
 * @param sim - Raw response from `SorobanRpc.Server.simulateTransaction`
 * @returns A typed `SimulateTransactionResult`
 */
export function buildSimulationResult(
  sim: SorobanRpc.Api.SimulateTransactionResponse,
): SimulateTransactionResult {
  const success = SorobanRpc.Api.isSimulationSuccess(sim);
  const events = decodeDiagnosticEvents(
    (sim as SorobanRpc.Api.SimulateTransactionSuccessResponse).events,
  );

  if (!success) {
    const errorResponse = sim as SorobanRpc.Api.SimulateTransactionErrorResponse;
    return {
      success: false,
      returnValue: null,
      auth: [],
      minResourceFee: '',
      cost: null,
      transactionData: null,
      latestLedger: sim.latestLedger,
      events,
      error: errorResponse.error ?? 'Simulation failed',
      raw: sim,
    };
  }

  const ok = sim as SorobanRpc.Api.SimulateTransactionSuccessResponse;
  return {
    success: true,
    returnValue: ok.result?.retval ?? null,
    auth: ok.result?.auth ?? [],
    minResourceFee: ok.minResourceFee,
    cost: ok.cost
      ? { cpuInsns: ok.cost.cpuInsns, memBytes: ok.cost.memBytes }
      : null,
    transactionData: ok.transactionData ?? null,
    latestLedger: ok.latestLedger,
    events,
    error: null,
    raw: sim,
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
