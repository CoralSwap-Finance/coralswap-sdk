import { SorobanRpc } from '@stellar/stellar-sdk';
import { Result } from '../types/common';
import { TransactionError } from '../errors';
import { sleep } from './retry';

export enum TransactionFinality {
  SUCCESS = 'success',
  FAILED = 'failed',
  NOT_FOUND = 'not_found',
}

export interface IdempotentResubmissionConfig {
  maxRetries: number;
  retryDelayMs: number;
}

const DEFAULT_CONFIG: IdempotentResubmissionConfig = {
  maxRetries: 2,
  retryDelayMs: 2000,
};

export function checkTransactionFinality(
  server: SorobanRpc.Server,
  txHash: string,
): Promise<TransactionFinality> {
  return server
    .getTransaction(txHash)
    .then((tx) => {
      if (tx.status === 'SUCCESS') return TransactionFinality.SUCCESS;
      if (tx.status === 'FAILED') return TransactionFinality.FAILED;
      return TransactionFinality.NOT_FOUND;
    })
    .catch(() => TransactionFinality.NOT_FOUND);
}

export async function executeWithIdempotentResubmission<T>(
  submitFn: () => Promise<Result<{ txHash: string; ledger: number }>>,
  server: SorobanRpc.Server,
  onSuccess: (txHash: string, ledger: number) => T,
  config: IdempotentResubmissionConfig = DEFAULT_CONFIG,
): Promise<T> {
  const { maxRetries, retryDelayMs } = config;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await submitFn();

    if (result.success) {
      return onSuccess(result.txHash!, result.data!.ledger);
    }

    if (result.txHash) {
      const finality = await checkTransactionFinality(server, result.txHash);

      switch (finality) {
        case TransactionFinality.SUCCESS:
          return onSuccess(result.txHash, result.data?.ledger ?? 0);

        case TransactionFinality.FAILED:
          throw new TransactionError(
            `Transaction failed on-chain: ${result.error?.message ?? "Unknown error"}`,
            result.txHash,
          );

        case TransactionFinality.NOT_FOUND:
          if (attempt < maxRetries) {
            await sleep(retryDelayMs);
            continue;
          }
          break;
      }
    }

    throw new TransactionError(
      result.error?.message ?? "Transaction submission failed after all retries",
      result.txHash,
    );
  }

  throw new TransactionError('Max retries exceeded without successful submission');
}
