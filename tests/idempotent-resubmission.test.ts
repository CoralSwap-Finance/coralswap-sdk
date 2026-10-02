import { SorobanRpc } from '@stellar/stellar-sdk';
import {
  getTransactionStatus,
  shouldRetrySubmission,
  TransactionStatus,
} from '../src/utils/idempotent-resubmission';

describe('idempotent-resubmission', () => {
  const TX_HASH = 'test-tx-hash-123';

  describe('getTransactionStatus', () => {
    it('returns SUCCESS when the transaction landed successfully', async () => {
      const mockServer = {
        getTransaction: jest.fn().mockResolvedValue({
          status: 'SUCCESS',
          ledger: 12345,
        }),
      } as unknown as SorobanRpc.Server;

      const status = await getTransactionStatus(mockServer, TX_HASH);

      expect(status.status).toBe('SUCCESS');
      if (status.status === 'SUCCESS') {
        expect(status.ledger).toBe(12345);
        expect(status.txHash).toBe(TX_HASH);
      }
    });

    it('returns FAILED when the transaction failed on-chain', async () => {
      const mockServer = {
        getTransaction: jest.fn().mockResolvedValue({
          status: 'FAILED',
          ledger: 12345,
        }),
      } as unknown as SorobanRpc.Server;

      const status = await getTransactionStatus(mockServer, TX_HASH);

      expect(status.status).toBe('FAILED');
      if (status.status === 'FAILED') {
        expect(status.ledger).toBe(12345);
      }
    });

    it('returns NOT_FOUND when the transaction has never been seen', async () => {
      const mockServer = {
        getTransaction: jest.fn().mockResolvedValue({ status: 'NOT_FOUND' }),
      } as unknown as SorobanRpc.Server;

      const status = await getTransactionStatus(mockServer, TX_HASH);

      expect(status.status).toBe('NOT_FOUND');
    });

    it('returns ERROR when the RPC call throws an Error', async () => {
      const mockServer = {
        getTransaction: jest.fn().mockRejectedValue(new Error('RPC unavailable')),
      } as unknown as SorobanRpc.Server;

      const status = await getTransactionStatus(mockServer, TX_HASH);

      expect(status.status).toBe('ERROR');
      if (status.status === 'ERROR') {
        expect(status.message).toBe('RPC unavailable');
      }
    });

    it('returns ERROR when the RPC call throws a non-Error value', async () => {
      const mockServer = {
        getTransaction: jest.fn().mockRejectedValue('string error'),
      } as unknown as SorobanRpc.Server;

      const status = await getTransactionStatus(mockServer, TX_HASH);

      expect(status.status).toBe('ERROR');
    });
  });

  describe('shouldRetrySubmission', () => {
    it('never retries once the transaction has succeeded', () => {
      const status: TransactionStatus = { status: 'SUCCESS', ledger: 12345, txHash: TX_HASH };
      const decision = shouldRetrySubmission(status);
      expect(decision.shouldRetry).toBe(false);
      expect(decision.reason).toContain('already succeeded');
    });

    it('never retries once the transaction has failed on-chain', () => {
      const status: TransactionStatus = { status: 'FAILED', ledger: 12345 };
      const decision = shouldRetrySubmission(status);
      expect(decision.shouldRetry).toBe(false);
      expect(decision.reason).toContain('already failed');
    });

    it('allows a retry when the transaction was never found on-chain', () => {
      const status: TransactionStatus = { status: 'NOT_FOUND' };
      const decision = shouldRetrySubmission(status);
      expect(decision.shouldRetry).toBe(true);
    });

    it('blocks a retry when the status check itself errors (indeterminate)', () => {
      const status: TransactionStatus = { status: 'ERROR', message: 'Network error' };
      const decision = shouldRetrySubmission(status);
      expect(decision.shouldRetry).toBe(false);
      expect(decision.reason).toContain('indeterminate');
    });
  });
});
