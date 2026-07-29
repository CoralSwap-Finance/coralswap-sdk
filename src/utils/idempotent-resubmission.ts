import { SorobanRpc } from '@stellar/stellar-sdk';

export type TransactionStatus =
  | { status: 'SUCCESS'; ledger: number; txHash: string; result?: SorobanRpc.Api.GetSuccessfulTransactionResponse }
  | { status: 'FAILED'; ledger?: number }
  | { status: 'NOT_FOUND' }
  | { status: 'ERROR'; message: string };

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
    }
  } catch (err) {
    return {
      status: 'ERROR',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface RetryDecision {
  shouldRetry: boolean;
  reason?: string;
}

export function shouldRetrySubmission(
  status: TransactionStatus,
): RetryDecision {
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
