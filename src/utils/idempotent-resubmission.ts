import { SorobanRpc } from '@stellar/stellar-sdk';

/**
 * Real, on-chain outcome of a previously-submitted Soroban transaction.
 *
 * A client-side timeout or connection error while *submitting* a
 * transaction says nothing about whether it actually landed -- the
 * transaction may already be included in a ledger. Callers must check
 * this before rebuilding and resubmitting, or they risk double-executing
 * the operation.
 */
export type TransactionStatus =
  | { status: 'SUCCESS'; ledger: number; txHash: string; result?: SorobanRpc.Api.GetSuccessfulTransactionResponse }
  | { status: 'FAILED'; ledger?: number }
  | { status: 'NOT_FOUND' }
  | { status: 'ERROR'; message: string };

/**
 * Look up the real on-chain status of a transaction hash.
 *
 * @param server - The Soroban RPC server to query.
 * @param txHash - Hash of the transaction to check.
 */
export async function getTransactionStatus(
  server: SorobanRpc.Server,
  txHash: string,
): Promise<TransactionStatus> {
  try {
    const result = await server.getTransaction(txHash);
    switch (result.status) {
      case 'SUCCESS':
        return {
          status: 'SUCCESS',
          ledger: result.ledger ?? 0,
          txHash,
          result: result as SorobanRpc.Api.GetSuccessfulTransactionResponse,
        };
      case 'FAILED':
        return {
          status: 'FAILED',
          ledger: result.ledger,
        };
      case 'NOT_FOUND':
        return { status: 'NOT_FOUND' };
      default:
        return { status: 'ERROR', message: `Unknown transaction status: ${(result as { status: string }).status}` };
    }
  } catch (err) {
    return {
      status: 'ERROR',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface RetryDecision {
  /** Whether it is safe to rebuild and resubmit the transaction. */
  shouldRetry: boolean;
  reason?: string;
}

/**
 * Decide whether a transaction is safe to resubmit given its real status.
 *
 * - `SUCCESS` / `FAILED` -- the transaction already has a final on-chain
 *   outcome. Resubmitting would either duplicate the effect (SUCCESS) or
 *   is pointless (FAILED); either way, do not retry.
 * - `NOT_FOUND` -- the network never saw it land, so it is safe to retry.
 * - `ERROR` -- the status check itself failed. We can't confirm the
 *   transaction didn't land, but favor availability over blocking forever;
 *   callers combining this with other status sources (e.g. an external
 *   bridge API) should prefer the more conservative of the two signals.
 */
export function shouldRetrySubmission(status: TransactionStatus): RetryDecision {
  switch (status.status) {
    case 'SUCCESS':
      return { shouldRetry: false, reason: 'Transaction already succeeded' };
    case 'FAILED':
      return { shouldRetry: false, reason: 'Transaction already failed on-chain' };
    case 'NOT_FOUND':
      return { shouldRetry: true };
    case 'ERROR':
      return { shouldRetry: true, reason: 'Status check failed, allowing retry' };
  }
}
