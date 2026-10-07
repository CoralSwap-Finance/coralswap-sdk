import { rpc, xdr } from '@stellar/stellar-sdk';
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
  sim: rpc.Api.SimulateTransactionResponse,
): SimulationResult<boolean> {
  const success = rpc.Api.isSimulationSuccess(sim);
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
  sim: rpc.Api.SimulateTransactionResponse,
): SimulationResult<xdr.ScVal | null> {
  if (!rpc.Api.isSimulationSuccess(sim)) {
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
  sim: rpc.Api.SimulateTransactionResponse,
): SimulationResult<SimulationResourceEstimate | null> {
  if (!rpc.Api.isSimulationSuccess(sim)) {
    return simulationFailedResult(null);
  }

  const resources = sim.transactionData
    ? sim.transactionData.build().resources
    : null;
  return {
    success: true,
    data: resources
      ? {
          cpuInstructions: resources.instructions,
          memoryBytes: resources.diskReadBytes + resources.writeBytes,
          readBytes: resources.diskReadBytes,
          writeBytes: resources.writeBytes,
        }
      : null,
  };
}

/**
 * Decode diagnostic events from a simulation response.
 *
 * SDK v12+ (stellar-sdk) returns pre-decoded `xdr.DiagnosticEvent` objects on the
 * `events` field of `SimulateTransactionSuccessResponse`. Older SDK
 * versions returned base64-encoded XDR strings. This function handles
 * both shapes so the codebase stays forward-compatible.
 *
 * @param rawEvents - The `events` array from the RPC response (may be undefined)
 * @returns Array of `SimulationDiagnosticEvent` objects
 */
export function decodeDiagnosticEvents(
  rawEvents: xdr.DiagnosticEvent[] | string[] | undefined,
): SimulationDiagnosticEvent[] {
  if (!rawEvents || rawEvents.length === 0) return [];

  return rawEvents.map((entry): SimulationDiagnosticEvent => {
    if (typeof entry === 'string') {
      // Legacy: base64-encoded XDR string
      try {
        return {
          xdr: entry,
          decoded: xdr.DiagnosticEvent.fromXdr(entry, 'base64'),
        };
      } catch {
        return { xdr: entry, decoded: null };
      }
    }
    // Already a decoded DiagnosticEvent — serialise back to base64 for the xdr field
    try {
      return {
        xdr: entry.toXdr('base64'),
        decoded: entry,
      };
    } catch {
      return { xdr: '', decoded: entry };
    }
  });
}

/**
 * Build a structured {@link SimulateTransactionResult} from a raw RPC response.
 *
 * Centralises all field extraction so both `client.ts` and any future
 * callers get a consistent, fully-typed view of the simulation data.
 *
 * @param sim - Raw response from `rpc.Server.simulateTransaction`
 * @returns A typed `SimulateTransactionResult`
 */
export function buildSimulationResult(
  sim: rpc.Api.SimulateTransactionResponse,
): SimulateTransactionResult {
  const success = rpc.Api.isSimulationSuccess(sim);
  const events = decodeDiagnosticEvents(
    (sim as rpc.Api.SimulateTransactionSuccessResponse).events,
  );

  if (!success) {
    const errorResponse = sim as rpc.Api.SimulateTransactionErrorResponse;
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

  const ok = sim as rpc.Api.SimulateTransactionSuccessResponse;
  const resources = ok.transactionData
    ? ok.transactionData.build().resources
    : null;
  return {
    success: true,
    returnValue: ok.result?.retval ?? null,
    auth: ok.result?.auth ?? [],
    minResourceFee: ok.minResourceFee,
    cost: resources
      ? {
          cpuInsns: String(resources.instructions),
          memBytes: String(resources.diskReadBytes + resources.writeBytes),
        }
      : null,
    transactionData: ok.transactionData ? ok.transactionData.build() : null,
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
  sim: rpc.Api.SimulateTransactionResponse,
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
