import { TransactionPoller, PollingStrategy } from './polling';
import { isRetryable } from './retry';
import { TransactionError } from '@/errors';
import { SorobanRpc } from '@stellar/stellar-sdk';

export interface IdempotentSubmitOptions {
  maxAttempts?: number;
  pollInterval?: number;
  pollMaxAttempts?: number;
}

export async function idempotentSubmit(
  txHash: string,
  submitFn: () => Promise<{ success: boolean; txHash?: string; error?: { message: string }; data?: { ledger: number } }>,
  server: SorobanRpc.Server,
  options: IdempotentSubmitOptions = {},
): Promise<{ success: boolean; txHash: string; ledger: number }> {
  const maxAttempts = options.maxAttempts ?? 3;
  const pollInterval = options.pollInterval ?? 1000;
  const pollMaxAttempts = options.pollMaxAttempts ?? 30;

  let currentTxHash = txHash || '';
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      if (currentTxHash && attempt > 0) {
        const status = await checkTxStatus(currentTxHash, server, pollInterval, pollMaxAttempts);
        if (status === 'LANDED') {
          const txResult = await server.getTransaction(currentTxHash);
          return {
            success: true,
            txHash: currentTxHash,
            ledger: (txResult as any).ledger ?? 0,
          };
        }
        if (status === 'FAILED') {
          currentTxHash = '';
        }
      }

      const result = await submitFn();
      if (result.success && result.txHash) {
        return { success: true, txHash: result.txHash, ledger: result.data?.ledger ?? 0 };
      }

      if (result.txHash) {
        currentTxHash = result.txHash;
        const status = await checkTxStatus(currentTxHash, server, pollInterval, pollMaxAttempts);
        if (status === 'LANDED') {
          const txResult = await server.getTransaction(currentTxHash);
          return {
            success: true,
            txHash: currentTxHash,
            ledger: (txResult as any).ledger ?? 0,
          };
        }
        if (status === 'FAILED') {
          currentTxHash = '';
          throw new TransactionError(
            result.error?.message ?? 'Transaction failed on-chain',
            result.txHash,
          );
        }
        // PENDING — signal retryable
        throw new TransactionError('Transaction timed out', result.txHash);
      }

      throw new TransactionError(
        result.error?.message ?? 'Transaction submission failed',
      );
    } catch (err) {
      if (!isRetryable(err)) throw err;
      lastError = err;
      if (attempt === maxAttempts - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, pollInterval * Math.pow(2, attempt)));
    }
  }

  throw lastError;
}

async function checkTxStatus(
  txHash: string,
  server: SorobanRpc.Server,
  interval: number,
  maxAttempts: number,
): Promise<'LANDED' | 'FAILED' | 'PENDING'> {
  const poller = new TransactionPoller(server);
  const result = await poller.poll(txHash, {
    strategy: PollingStrategy.LINEAR,
    interval,
    maxAttempts,
  });
  if (result.success) return 'LANDED';
  if (result.error?.code === 'TX_FAILED') return 'FAILED';
  return 'PENDING';
}
