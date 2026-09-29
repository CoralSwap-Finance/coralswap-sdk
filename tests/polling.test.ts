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

    describe('EXPONENTIAL backoff schedule', () => {
        it('doubles the delay each attempt and caps it at maxInterval', async () => {
            jest.useFakeTimers();
            try {
                // 6 NOT_FOUND attempts, success on the 7th. A single
                // mockImplementation (not mockResolvedValueOnce) is used
                // throughout so the timestamp recording runs on every call.
                const callTimestamps: number[] = [];
                let calls = 0;
                mockServer.getTransaction.mockImplementation(async () => {
                    callTimestamps.push(Date.now());
                    calls += 1;
                    return calls < 7
                        ? ({ status: 'NOT_FOUND' } as any)
                        : ({ status: 'SUCCESS', ledger: 200 } as any);
                });

                const pollPromise = poller.poll('TX_HASH', {
                    strategy: PollingStrategy.EXPONENTIAL,
                    interval: 100,
                    backoffFactor: 2,
                    maxInterval: 500,
                    maxAttempts: 8,
                });

                // Uncapped schedule would be 100,200,400,800,1600 -- capped at
                // 500 it's 100,200,400,500,500,500. Sum = 2200.
                await jest.advanceTimersByTimeAsync(2200);
                const result = await pollPromise;

                expect(result.success).toBe(true);
                expect(mockServer.getTransaction).toHaveBeenCalledTimes(7);
                expect(callTimestamps).toHaveLength(7);

                const deltas: number[] = [];
                for (let i = 1; i < callTimestamps.length; i++) {
                    deltas.push(callTimestamps[i] - callTimestamps[i - 1]);
                }
                expect(deltas).toEqual([100, 200, 400, 500, 500, 500]);
            } finally {
                jest.useRealTimers();
            }
        });

        it('stays flat when backoffFactor is 1', async () => {
            jest.useFakeTimers();
            try {
                const callTimestamps: number[] = [];
                let calls = 0;
                mockServer.getTransaction.mockImplementation(async () => {
                    callTimestamps.push(Date.now());
                    calls += 1;
                    return calls < 4
                        ? ({ status: 'NOT_FOUND' } as any)
                        : ({ status: 'SUCCESS', ledger: 201 } as any);
                });

                const pollPromise = poller.poll('TX_HASH', {
                    strategy: PollingStrategy.EXPONENTIAL,
                    interval: 50,
                    backoffFactor: 1,
                    maxAttempts: 5,
                });

                await jest.advanceTimersByTimeAsync(150);
                const result = await pollPromise;

                expect(result.success).toBe(true);
                expect(mockServer.getTransaction).toHaveBeenCalledTimes(4);

                const deltas: number[] = [];
                for (let i = 1; i < callTimestamps.length; i++) {
                    deltas.push(callTimestamps[i] - callTimestamps[i - 1]);
                }
                expect(deltas).toEqual([50, 50, 50]);
            } finally {
                jest.useRealTimers();
            }
        });
    });

    describe('cancellation via AbortSignal', () => {
        it('stops between attempts once the signal is aborted, without waiting out the remaining delay', async () => {
            jest.useFakeTimers();
            try {
                const controller = new AbortController();
                mockServer.getTransaction.mockResolvedValue({ status: 'NOT_FOUND' } as any);

                const pollPromise = poller.poll('TX_HASH', {
                    strategy: PollingStrategy.LINEAR,
                    interval: 1000,
                    maxAttempts: 10,
                    signal: controller.signal,
                });

                // Let the first attempt happen, then abort partway through the
                // 1000ms delay before the second attempt.
                await jest.advanceTimersByTimeAsync(0);
                expect(mockServer.getTransaction).toHaveBeenCalledTimes(1);

                await jest.advanceTimersByTimeAsync(400);
                controller.abort();

                // Even though only 400 of the 1000ms delay elapsed, the poll
                // must resolve immediately once aborted -- not wait for the
                // remaining 600ms.
                const result = await pollPromise;

                expect(result.success).toBe(false);
                expect(result.error?.code).toBe('ABORTED');
                // No second attempt was ever issued.
                expect(mockServer.getTransaction).toHaveBeenCalledTimes(1);
            } finally {
                jest.useRealTimers();
            }
        });

        it('rejects immediately if the signal is already aborted before polling starts', async () => {
            const controller = new AbortController();
            controller.abort();

            const result = await poller.poll('TX_HASH', { signal: controller.signal });

            expect(result.success).toBe(false);
            expect(result.error?.code).toBe('ABORTED');
            expect(mockServer.getTransaction).not.toHaveBeenCalled();
        });

        it('does not cancel an in-flight attempt -- only the wait before the next one', async () => {
            const controller = new AbortController();

            // getTransaction resolves normally; abort fires while that call
            // is still pending to prove the in-flight attempt is unaffected.
            let resolveGetTransaction: (value: any) => void;
            const pending = new Promise((resolve) => {
                resolveGetTransaction = resolve;
            });
            mockServer.getTransaction.mockReturnValueOnce(pending as any);

            const pollPromise = poller.poll('TX_HASH', {
                interval: 10,
                maxAttempts: 3,
                signal: controller.signal,
            });

            controller.abort();
            resolveGetTransaction!({ status: 'SUCCESS', ledger: 300 });

            const result = await pollPromise;

            // The already-in-flight attempt's result still wins -- abort
            // only takes effect between attempts, not mid-request.
            expect(result.success).toBe(true);
            expect(result.data?.ledger).toBe(300);
            expect(mockServer.getTransaction).toHaveBeenCalledTimes(1);
        });
    });
});
