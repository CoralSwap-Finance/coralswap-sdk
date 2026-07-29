import { SorobanRpc, xdr } from "@stellar/stellar-sdk";
import { Result } from "../types/common";

/**
 * Minimal interface that `submitIdempotent` needs from the client so the
 * utility stays decoupled from the full CoralSwapClient type.
 */
export interface SubmitIdempotentClient {
  /**
   * Build, simulate, sign and submit a transaction.
   *
   * Should return `{ success: false, error: { code: 'TX_TIMEOUT', ... }, txHash }` when
   * the transaction was submitted but confirmation polling timed out.
   */
  submitTransaction(
    operations: xdr.Operation[],
    source?: string,
  ): Promise<Result<{ txHash: string; ledger: number }>>;

  /**
   * Access to the underlying Soroban RPC server for post-timeout status checks.
   */
  server: {
    getTransaction(hash: string): Promise<SorobanRpc.Api.GetTransactionResponse>;
  };
}

/**
 * Submit a transaction with idempotent-resubmission protection.
 *
 * The problem this solves:
 *
 *   When a client-side polling timeout fires, the transaction may have
 *   already landed on-chain.  Blindly resubmitting would create a
 *   duplicate operation (double-spend, double deposit, double withdrawal).
 *
 * Behaviour:
 *
 *  1. Calls `client.submitTransaction(operations)` normally.
 *  2. If the result is a `TX_TIMEOUT` error **and** we have a `txHash`:
 *       a. Queries `getTransaction(txHash)` for the definitive on-chain status.
 *       b. `SUCCESS`  → returns the landed result (no resubmission needed).
 *       c. `FAILED`   → returns a failure result so the caller can handle/retry.
 *       d. `NOT_FOUND` → the transaction has expired; returns the original timeout
 *                        result so the caller can resubmit a fresh transaction.
 *  3. Any other error is propagated as-is.
 *
 * @param client     - Object exposing `submitTransaction` and `server.getTransaction`.
 * @param operations - Soroban XDR operations to include in the transaction.
 * @param source     - Optional source account override.
 * @returns A `Result` that is either the landed transaction or an error.
 *
 * @example
 * const result = await submitIdempotent(client, [addLiquidityOp]);
 * if (!result.success && result.error?.code === 'TX_NOT_FOUND_AFTER_TIMEOUT') {
 *   // Safe to resubmit — transaction definitely did not land.
 *   result = await submitIdempotent(client, [addLiquidityOp]);
 * }
 */
export async function submitIdempotent(
  client: SubmitIdempotentClient,
  operations: xdr.Operation[],
  source?: string,
): Promise<Result<{ txHash: string; ledger: number }>> {
  const result = await client.submitTransaction(operations, source);

  // Happy path — transaction confirmed, or failed for a non-timeout reason.
  if (result.success || result.error?.code !== "TX_TIMEOUT") {
    return result;
  }

  // Polling timed out.  If we have the hash, check whether it landed.
  const txHash = result.txHash;
  if (!txHash) {
    // No hash means we never even submitted — propagate the original result.
    return result;
  }

  let statusResponse: SorobanRpc.Api.GetTransactionResponse;
  try {
    statusResponse = await client.server.getTransaction(txHash);
  } catch {
    // RPC error during the status check — return the timeout as-is; the
    // caller should decide whether to retry.
    return result;
  }

  if (statusResponse.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
    // Transaction landed despite the client-side timeout.
    const ledger =
      (statusResponse as SorobanRpc.Api.GetSuccessfulTransactionResponse)
        .ledger ?? 0;
    return {
      success: true,
      data: { txHash, ledger },
      txHash,
    };
  }

  if (statusResponse.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
    return {
      success: false,
      error: {
        code: "TX_FAILED",
        message: "Transaction failed on-chain (detected after timeout)",
        details: { txHash },
      },
      txHash,
    };
  }

  // NOT_FOUND — transaction was not seen by the network (expired).
  // It is safe to resubmit a fresh transaction.
  return {
    success: false,
    error: {
      code: "TX_NOT_FOUND_AFTER_TIMEOUT",
      message:
        "Transaction timed out and was not found on-chain — safe to resubmit",
      details: { txHash },
    },
    txHash,
  };
}
