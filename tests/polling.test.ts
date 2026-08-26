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
        // See the EXPONENTIAL backoff test below for why this uses fake
        // timers instead of a wall-clock Date.now() duration assertion.
        jest.useFakeTimers();
        try {
            mockServer.getTransaction
                .mockResolvedValueOnce({ status: 'NOT_FOUND' } as any)
                .mockResolvedValueOnce({ status: 'NOT_FOUND' } as any)
                .mockResolvedValueOnce({ status: 'SUCCESS', ledger: 101 } as any);

            const pollPromise = poller.poll('TX_HASH', {
                strategy: PollingStrategy.LINEAR,
                interval: 100, // Short interval for tests
                maxAttempts: 5,
            });

            // 2 intervals of 100ms between the 3 attempts.
            await jest.advanceTimersByTimeAsync(200);
            const result = await pollPromise;

            expect(result.success).toBe(true);
            expect(result.data?.ledger).toBe(101);
            expect(mockServer.getTransaction).toHaveBeenCalledTimes(3);
        } finally {
            jest.useRealTimers();
        }
    });

    it('uses EXPONENTIAL backoff', async () => {
        // Real-timer duration assertions are inherently flaky (a run can land
        // a millisecond under the boundary from ordinary timer jitter), so
        // this drives the backoff deterministically with fake timers instead
        // of asserting on wall-clock Date.now() deltas.
        jest.useFakeTimers();
        try {
            mockServer.getTransaction
                .mockResolvedValueOnce({ status: 'NOT_FOUND' } as any)
                .mockResolvedValueOnce({ status: 'NOT_FOUND' } as any)
                .mockResolvedValueOnce({ status: 'SUCCESS', ledger: 102 } as any);

            const pollPromise = poller.poll('TX_HASH', {
                strategy: PollingStrategy.EXPONENTIAL,
                interval: 100,
                backoffFactor: 2,
                maxAttempts: 5,
            });

            // First wait: 100ms, second wait: 200ms — advance past both.
            await jest.advanceTimersByTimeAsync(300);
            await pollPromise;

            expect(mockServer.getTransaction).toHaveBeenCalledTimes(3);
        } finally {
            jest.useRealTimers();
        }
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
