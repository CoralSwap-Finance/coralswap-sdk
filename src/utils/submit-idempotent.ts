import { SorobanRpc } from '@stellar/stellar-sdk';
import { Result } from '@/types/common';

/** A function that submits a transaction and returns the SDK Result. */
export type SubmitFn = () => Promise<Result<{ txHash: string; ledger: number }>>;

/**
 * A function that queries the RPC for a transaction's current status.
 *
 * Matches the signature of `SorobanRpc.Server.getTransaction` so the
 * real server and any mock can be passed directly.
 */
export type GetTransactionFn = (
  hash: string,
) => Promise<SorobanRpc.Api.GetTransactionResponse>;

/**
 * Submit a transaction idempotently.
 *
 * **Problem this solves**: A client-side timeout during a liquidity operation
 * leaves the application uncertain whether the transaction actually landed.
 * Naïvely retrying would risk a duplicate deposit or withdrawal if the
 * transaction already succeeded on-chain.
 *
 * **How it works**:
 * 1. Calls `submitFn()` — the normal transaction submission path.
 * 2. If the submission succeeds, returns the result immediately.
 * 3. If the submission fails with a **timeout** (`TX_TIMEOUT`) and a
 *    `txHash` is available (i.e., the transaction was at least sent):
 *    - Checks the real on-chain status via `getTransaction(txHash)`.
 *    - If the ledger reports **SUCCESS**, the transaction already landed —
 *      returns a successful result without resubmitting.
 *    - If the ledger reports **FAILED**, propagates the on-chain failure.
 *    - If the transaction is **NOT_FOUND** (still pending or never landed),
 *      returns the original timeout result so the caller can retry with a
 *      fresh submission.
 * 4. For any non-timeout failure the original error result is returned
 *    unchanged so ordinary error handling is unaffected.
 *
 * @param submitFn - Zero-argument async function that builds and submits the
 *   transaction, returning an SDK `Result`.
 * @param getTransaction - RPC function used to verify on-chain status after a
 *   timeout.  Pass `client.server.getTransaction.bind(client.server)`.
 * @returns An SDK `Result` that is:
 *   - `success: true`  — the transaction is confirmed on-chain (either from
 *     the normal path or from the post-timeout status check).
 *   - `success: false` — the transaction failed, timed out with an unknown
 *     status, or could not be verified.
 *
 * @example
 * const result = await submitIdempotent(
 *   () => client.submitTransaction([op]),
 *   client.server.getTransaction.bind(client.server),
 * );
 * if (result.success) {
 *   console.log('Confirmed at ledger', result.data?.ledger);
 * }
 */
export async function submitIdempotent(
  submitFn: SubmitFn,
  getTransaction: GetTransactionFn,
): Promise<Result<{ txHash: string; ledger: number }>> {
  const result = await submitFn();

  // Happy path — transaction confirmed on the first attempt.
  if (result.success) {
    return result;
  }

  // Only attempt the idempotency check on a polling timeout that has a
  // known tx hash. Any other failure (simulation, signing, network error
  // before submission, etc.) is returned as-is.
  if (result.error?.code !== 'TX_TIMEOUT' || !result.txHash) {
    return result;
  }

  // The transaction was at least sent (we have a hash), but polling timed out.
  // Check the real ledger status before deciding whether to surface an error.
  let status: SorobanRpc.Api.GetTransactionResponse;
  try {
    status = await getTransaction(result.txHash);
  } catch {
    // Cannot reach the RPC — return the original timeout result unchanged.
    return result;
  }

  if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
    // The transaction landed while we were waiting; treat it as a success.
    const successStatus = status as SorobanRpc.Api.GetSuccessfulTransactionResponse;
    return {
      success: true,
      data: {
        txHash: result.txHash,
        ledger: successStatus.ledger ?? 0,
      },
      txHash: result.txHash,
    };
  }

  if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
    // The transaction landed but was rejected by the contract.
    return {
      success: false,
      txHash: result.txHash,
      error: {
        code: 'TX_FAILED',
        message: 'Transaction failed on-chain after timeout check',
        details: { txHash: result.txHash },
      },
    };
  }

  // status === NOT_FOUND: the transaction never landed (or is still pending).
  // Return the original timeout result so the caller can decide to retry with
  // a fresh transaction.
  return result;
}
