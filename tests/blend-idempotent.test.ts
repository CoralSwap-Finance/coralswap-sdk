import { SorobanRpc } from '@stellar/stellar-sdk';
import { idempotentSubmit } from '../src/utils/idempotent-resubmission';
import { TransactionError } from '../src/errors';

describe('Blend idempotent resubmission', () => {
  let mockServer: jest.Mocked<SorobanRpc.Server>;

  beforeEach(() => {
    mockServer = {
      getTransaction: jest.fn(),
    } as any;
  });

  describe('idempotentSubmit', () => {
    it('detects a timed-out-but-landed transaction and does not resubmit', async () => {
      const txHash = 'abc123-landed';

      mockServer.getTransaction.mockResolvedValue({
        status: 'SUCCESS',
        ledger: 200,
      } as any);

      let submitCount = 0;
      const submitFn = jest.fn().mockImplementation(async () => {
        submitCount++;
        if (submitCount === 1) {
          return { success: false, txHash, error: { message: 'timeout' } };
        }
        return { success: true, txHash: 'should-not-happen' };
      });

      const result = await idempotentSubmit(txHash, submitFn, mockServer, {
        maxAttempts: 3,
        pollInterval: 10,
        pollMaxAttempts: 5,
      });

      expect(result.success).toBe(true);
      expect(result.txHash).toBe(txHash);
      expect(result.ledger).toBe(200);
      expect(submitCount).toBe(1);
    });

    it('retries a genuinely failed transaction', async () => {
      const failedTxHash = 'def456-failed';
      const retryTxHash = 'def789-retry';

      mockServer.getTransaction.mockImplementation(async (hash: string) => {
        if (hash === failedTxHash) {
          return { status: 'FAILED', ledger: 150 } as any;
        }
        return { status: 'SUCCESS', ledger: 151 } as any;
      });

      let submitCount = 0;
      const submitFn = jest.fn().mockImplementation(async () => {
        submitCount++;
        if (submitCount === 1) {
          return { success: false, txHash: failedTxHash, error: { message: 'timeout' } };
        }
        return { success: true, txHash: retryTxHash, data: { ledger: 151 } };
      });

      const result = await idempotentSubmit(failedTxHash, submitFn, mockServer, {
        maxAttempts: 3,
        pollInterval: 10,
        pollMaxAttempts: 5,
      });

      expect(result.success).toBe(true);
      expect(result.txHash).toBe(retryTxHash);
      expect(submitCount).toBe(2);
    });

    it('throws immediately on non-retryable error', async () => {
      const submitFn = jest.fn().mockRejectedValue(new Error('Invalid input'));
      await expect(
        idempotentSubmit('some-hash', submitFn, mockServer, { maxAttempts: 2, pollInterval: 10 }),
      ).rejects.toThrow('Invalid input');
      expect(submitFn).toHaveBeenCalledTimes(1);
    });
  });
});
