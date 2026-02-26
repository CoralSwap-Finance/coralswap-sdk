import { SorobanRpc } from '@stellar/stellar-sdk';
import { TransactionPoller, PollingStrategy } from '../src/utils/polling';
import { Logger } from '../src/types/common';

describe('TransactionPoller', () => {
    let mockServer: jest.Mocked<SorobanRpc.Server>;
    let mockLogger: jest.Mocked<Logger>;
    let poller: TransactionPoller;

    beforeEach(() => {
        mockServer = {
            getTransaction: jest.fn(),
        } as any;

        mockLogger = {
            debug: jest.fn(),
            info: jest.fn(),
            error: jest.fn(),
        } as any;

        poller = new TransactionPoller(mockServer, mockLogger);
    });

    it('confirms a transaction on the first attempt', async () => {
        mockServer.getTransaction.mockResolvedValueOnce({
            status: 'SUCCESS',
            ledger: 100,
        } as any);

        const result = await poller.poll('TX_HASH');

        expect(result.success).toBe(true);
        expect(result.data?.ledger).toBe(100);
        expect(mockServer.getTransaction).toHaveBeenCalledTimes(1);
    });

    it('polls multiple times until success (LINEAR)', async () => {
        mockServer.getTransaction
            .mockResolvedValueOnce({ status: 'NOT_FOUND' } as any)
            .mockResolvedValueOnce({ status: 'NOT_FOUND' } as any)
            .mockResolvedValueOnce({ status: 'SUCCESS', ledger: 101 } as any);

        const startTime = Date.now();
        const result = await poller.poll('TX_HASH', {
            strategy: PollingStrategy.LINEAR,
            interval: 100, // Short interval for tests
            maxAttempts: 5,
        });
        const duration = Date.now() - startTime;

        expect(result.success).toBe(true);
        expect(result.data?.ledger).toBe(101);
        expect(mockServer.getTransaction).toHaveBeenCalledTimes(3);
        expect(duration).toBeGreaterThanOrEqual(200); // 2 intervals of 100ms
    });

    it('uses EXPONENTIAL backoff', async () => {
        mockServer.getTransaction
            .mockResolvedValueOnce({ status: 'NOT_FOUND' } as any)
            .mockResolvedValueOnce({ status: 'NOT_FOUND' } as any)
            .mockResolvedValueOnce({ status: 'SUCCESS', ledger: 102 } as any);

        const startTime = Date.now();
        await poller.poll('TX_HASH', {
            strategy: PollingStrategy.EXPONENTIAL,
            interval: 100,
            backoffFactor: 2,
            maxAttempts: 5,
        });
        const duration = Date.now() - startTime;

        // First wait: 100ms
        // Second wait: 200ms
        // Total: ~300ms
        expect(duration).toBeGreaterThanOrEqual(300);
        expect(mockServer.getTransaction).toHaveBeenCalledTimes(3);
    });

    it('handles FAILED status immediately', async () => {
        mockServer.getTransaction.mockResolvedValueOnce({
            status: 'FAILED',
        } as any);

        const result = await poller.poll('TX_HASH');

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('TX_FAILED');
        expect(mockServer.getTransaction).toHaveBeenCalledTimes(1);
    });

    it('times out after maxAttempts', async () => {
        mockServer.getTransaction.mockResolvedValue({ status: 'NOT_FOUND' } as any);

        const result = await poller.poll('TX_HASH', {
            interval: 10,
            maxAttempts: 3,
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('TX_TIMEOUT');
        expect(mockServer.getTransaction).toHaveBeenCalledTimes(3);
    });

    it('continues polling on RPC errors', async () => {
        mockServer.getTransaction
            .mockRejectedValueOnce(new Error('Network error'))
            .mockResolvedValueOnce({ status: 'SUCCESS', ledger: 103 } as any);

        const result = await poller.poll('TX_HASH', { interval: 10 });

        expect(result.success).toBe(true);
        expect(result.data?.ledger).toBe(103);
        expect(mockServer.getTransaction).toHaveBeenCalledTimes(2);
    });
});
