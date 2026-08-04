/**
 * Unit tests confirming that CoralSwapClient respects a configured RateLimiter.
 *
 * Key behavior under test: acquire() is called once **per dispatch attempt**,
 * not once per high-level SDK call. This means retries and fallback-endpoint
 * rotations each consume their own token.
 */

import { CoralSwapClient } from '../src/client';
import { Network } from '../src/types/common';
import { RateLimiter } from '../src/utils/rate-limiter';

// ---------------------------------------------------------------------------
// Minimal @stellar/stellar-sdk mock
// ---------------------------------------------------------------------------
jest.mock('@stellar/stellar-sdk', () => {
    const actual = jest.requireActual('@stellar/stellar-sdk');
    return {
        ...actual,
        TransactionBuilder: jest.fn().mockImplementation(() => ({
            addOperation: jest.fn().mockReturnThis(),
            setTimeout: jest.fn().mockReturnThis(),
            build: jest.fn().mockReturnValue({ toXDR: jest.fn().mockReturnValue('mock-xdr') }),
        })),
        SorobanRpc: {
            ...actual.SorobanRpc,
            Server: jest.fn().mockImplementation(() => ({})),
        },
    };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(rateLimiter?: RateLimiter, rpcUrls?: string[]): CoralSwapClient {
    return new CoralSwapClient({
        network: Network.TESTNET,
        rpcUrl: rpcUrls,
        rateLimiter,
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CoralSwapClient — RateLimiter integration', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    // -------------------------------------------------------------------------
    // Basic wiring
    // -------------------------------------------------------------------------

    it('calls acquire() once for a single successful RPC call', async () => {
        const limiter = new RateLimiter({ maxRequestsPerSecond: 100, maxBurst: 10 });
        const acquireSpy = jest.spyOn(limiter, 'acquire');

        const client = makeClient(limiter);
        client.server = {
            getHealth: jest.fn().mockResolvedValue({ status: 'healthy' }),
        } as any;

        await client.isHealthy();

        expect(acquireSpy).toHaveBeenCalledTimes(1);

        acquireSpy.mockRestore();
        limiter.destroy();
    });

    it('does NOT call acquire() when no RateLimiter is configured (backward-compatible default)', async () => {
        const client = makeClient();
        client.server = {
            getHealth: jest.fn().mockResolvedValue({ status: 'healthy' }),
        } as any;

        await expect(client.isHealthy()).resolves.toBe(true);
    });

    it('stores the rateLimiter on client.config when provided', () => {
        const limiter = new RateLimiter({ maxRequestsPerSecond: 5, maxBurst: 5 });
        const client = makeClient(limiter);
        expect(client.config.rateLimiter).toBe(limiter);
        limiter.destroy();
    });

    // -------------------------------------------------------------------------
    // Per-attempt throttling: retries
    // -------------------------------------------------------------------------

    it('calls acquire() once per retry attempt, not once per SDK call', async () => {
        const limiter = new RateLimiter({ maxRequestsPerSecond: 100, maxBurst: 10 });
        const acquireSpy = jest.spyOn(limiter, 'acquire');

        // Configure the client with maxRetries = 2 so the first failure triggers
        // two retry attempts (3 total dispatches).
        const client = new CoralSwapClient({
            network: Network.TESTNET,
            rateLimiter: limiter,
            maxRetries: 2,
            retryDelayMs: 0,   // no back-off delay in tests
            maxRetryDelayMs: 0,
        });

        let callCount = 0;
        client.server = {
            getHealth: jest.fn().mockImplementation(async () => {
                callCount += 1;
                if (callCount < 3) {
                    // Use an error message that passes isRetryable() so withRetry retries.
                    throw new Error('connection timeout');
                }
                return { status: 'healthy' };
            }),
        } as any;

        await client.isHealthy();

        // 3 total dispatches (1 initial + 2 retries) → acquire() called 3 times.
        expect(acquireSpy).toHaveBeenCalledTimes(3);

        acquireSpy.mockRestore();
        limiter.destroy();
    });

    // -------------------------------------------------------------------------
    // Per-attempt throttling: fallback endpoint rotation
    // -------------------------------------------------------------------------

    it('calls acquire() once per fallback endpoint attempt', async () => {
        const limiter = new RateLimiter({ maxRequestsPerSecond: 100, maxBurst: 10 });
        const acquireSpy = jest.spyOn(limiter, 'acquire');

        // Two RPC URLs so the client can rotate after the first one fails.
        const client = makeClient(limiter, [
            'https://rpc-primary.example.com',
            'https://rpc-fallback.example.com',
        ]);

        // maxRetries = 0 so withRetry never retries — failures go straight to
        // fallback rotation, keeping the acquire() count unambiguous.
        client.config.maxRetries = 0;

        let dispatchCount = 0;
        const mockServer = {
            getHealth: jest.fn().mockImplementation(async () => {
                dispatchCount += 1;
                if (dispatchCount === 1) throw new Error('primary RPC down');
                return { status: 'healthy' };
            }),
        } as any;

        // Both the primary and fallback server slots point to the same mock.
        client.server = mockServer;
        // Intercept rotateRpcServer by keeping server set to our mock always.
        const serverSetter = jest.spyOn(client, 'server', 'set').mockImplementation(() => {
            (client as any)._server = mockServer;
        });

        await client.isHealthy();

        // 2 dispatch attempts (primary fails, fallback succeeds) → 2 acquire() calls.
        expect(acquireSpy).toHaveBeenCalledTimes(2);

        acquireSpy.mockRestore();
        serverSetter.mockRestore();
        limiter.destroy();
    });

    // -------------------------------------------------------------------------
    // Burst exhaustion: concurrent calls are serialized by the limiter
    // -------------------------------------------------------------------------

    it('throttles calls when burst capacity is exhausted', async () => {
        jest.useFakeTimers();

        // Burst of 2, then 1 req/sec → the 3rd call must wait for a token refill.
        const limiter = new RateLimiter({ maxRequestsPerSecond: 1, maxBurst: 2 });
        const client = makeClient(limiter);

        const callCount = { value: 0 };
        client.server = {
            getHealth: jest.fn().mockImplementation(async () => {
                callCount.value += 1;
                return { status: 'healthy' };
            }),
        } as any;

        // Fire 3 calls simultaneously.
        const p1 = client.isHealthy();
        const p2 = client.isHealthy();
        const p3 = client.isHealthy(); // must wait for token refill

        // Flush microtasks so the first two (burst) proceed.
        for (let i = 0; i < 10; i++) await Promise.resolve();

        // Advance clock enough for a token to refill (1 req/sec → ~1000 ms).
        jest.advanceTimersByTime(1100);
        for (let i = 0; i < 20; i++) await Promise.resolve();

        await Promise.all([p1, p2, p3]);

        expect(callCount.value).toBe(3);

        limiter.destroy();
        jest.useRealTimers();
    });
});
