import { FeeModule } from '../src/modules/fees';
import { CoralSwapClient } from '../src/client';
import { FeeState } from '../src/types/pool';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default FeeState fixture. Override individual fields as needed. */
function makeFeeState(overrides: Partial<FeeState> = {}): FeeState {
    return {
        priceLast: 0n,
        volAccumulator: 500n,
        lastUpdated: Math.floor(Date.now() / 1000) - 60, // 1 min ago (fresh)
        feeCurrent: 30,
        feeMin: 10,
        feeMax: 100,
        emaAlpha: 50,
        feeLastChanged: Math.floor(Date.now() / 1000) - 120,
        emaDecayRate: 5,
        baselineFee: 30,
        ...overrides,
    };
}

/**
 * Build a mock CoralSwapClient for FeeModule tests.
 *
 * `feeBps` controls the value returned by `getDynamicFee()`.
 * `feeState` controls the value returned by `getFeeState()`.
 */
function createMockClient(opts: {
    feeBps?: number;
    feeState?: FeeState;
    /** Per-pair overrides keyed by address */
    pairs?: Record<string, { feeBps?: number; feeState?: FeeState }>;
} = {}): CoralSwapClient {
    const defaultFeeBps = opts.feeBps ?? 30;
    const defaultFeeState = opts.feeState ?? makeFeeState();

    return {
        pair: jest.fn().mockImplementation((addr: string) => {
            const override = opts.pairs?.[addr];
            return {
                getDynamicFee: jest.fn().mockResolvedValue(override?.feeBps ?? defaultFeeBps),
                getFeeState: jest.fn().mockResolvedValue(override?.feeState ?? defaultFeeState),
            };
        }),
        router: {
            getDynamicFee: jest.fn().mockResolvedValue(defaultFeeBps),
        },
        factory: {
            getFeeParameters: jest.fn().mockResolvedValue({
                feeMin: 10,
                feeMax: 100,
                emaAlpha: 50,
                flashFeeBps: 5,
            }),
        },
    } as unknown as CoralSwapClient;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FeeModule', () => {
    const PAIR = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM';

    // -----------------------------------------------------------------------
    // estimateSwapFee()
    // -----------------------------------------------------------------------
    describe('estimateSwapFee()', () => {
        it('calculates correct fee amount: (amountIn * feeBps) / 10000', async () => {
            const client = createMockClient({ feeBps: 30 });
            const module = new FeeModule(client);

            const { feeBps, feeAmount } = await module.estimateSwapFee(PAIR, 10_000n);

            expect(feeBps).toBe(30);
            // 10000 * 30 / 10000 = 30
            expect(feeAmount).toBe(30n);
        });

        it('returns zero fee for zero amount', async () => {
            const client = createMockClient({ feeBps: 30 });
            const module = new FeeModule(client);

            await expect(module.estimateSwapFee(PAIR, 0n)).rejects.toThrow(
                'amountIn must be greater than 0',
            );
        });

        it('handles large amounts without overflow', async () => {
            const client = createMockClient({ feeBps: 100 });
            const module = new FeeModule(client);

            const largeAmount = 10n ** 24n; // 1 septillion stroops
            const { feeAmount } = await module.estimateSwapFee(PAIR, largeAmount);

            // (10^24 * 100) / 10000 = 10^22
            expect(feeAmount).toBe(10n ** 22n);
        });

        it('returns feeBps matching the dynamic fee from the pair', async () => {
            const client = createMockClient({ feeBps: 75 });
            const module = new FeeModule(client);

            const { feeBps } = await module.estimateSwapFee(PAIR, 1000n);

            expect(feeBps).toBe(75);
        });

        it('calculates correctly at max fee (100 bps = 1%)', async () => {
            const client = createMockClient({ feeBps: 100 });
            const module = new FeeModule(client);

            const { feeAmount } = await module.estimateSwapFee(PAIR, 1_000_000n);

            // 1000000 * 100 / 10000 = 10000
            expect(feeAmount).toBe(10_000n);
        });

        it('calculates correctly at min fee (10 bps = 0.1%)', async () => {
            const client = createMockClient({ feeBps: 10 });
            const module = new FeeModule(client);

            const { feeAmount } = await module.estimateSwapFee(PAIR, 1_000_000n);

            // 1000000 * 10 / 10000 = 1000
            expect(feeAmount).toBe(1_000n);
        });

        it('floors fractional fees (integer division)', async () => {
            const client = createMockClient({ feeBps: 30 });
            const module = new FeeModule(client);

            // 100 * 30 / 10000 = 0.3 → floors to 0
            const { feeAmount } = await module.estimateSwapFee(PAIR, 100n);

            expect(feeAmount).toBe(0n);
        });
    });

    // -----------------------------------------------------------------------
    // isStale()
    // -----------------------------------------------------------------------
    describe('isStale()', () => {
        it('returns false when lastUpdated is recent (within default 1 hour)', async () => {
            const recentState = makeFeeState({
                lastUpdated: Math.floor(Date.now() / 1000) - 60, // 1 min ago
            });
            const client = createMockClient({ feeState: recentState });
            const module = new FeeModule(client);

            const stale = await module.isStale(PAIR);

            expect(stale).toBe(false);
        });

        it('returns true when lastUpdated is older than default 1 hour', async () => {
            const oldState = makeFeeState({
                lastUpdated: Math.floor(Date.now() / 1000) - 7200, // 2 hours ago
            });
            const client = createMockClient({ feeState: oldState });
            const module = new FeeModule(client);

            const stale = await module.isStale(PAIR);

            expect(stale).toBe(true);
        });

        it('respects custom maxAgeSec parameter', async () => {
            const state = makeFeeState({
                lastUpdated: Math.floor(Date.now() / 1000) - 600, // 10 min ago
            });
            const client = createMockClient({ feeState: state });
            const module = new FeeModule(client);

            // 300 sec threshold → 10 min > 5 min → stale
            expect(await module.isStale(PAIR, 300)).toBe(true);
            // 900 sec threshold → 10 min < 15 min → not stale
            expect(await module.isStale(PAIR, 900)).toBe(false);
        });

        it('returns true when lastUpdated is exactly at boundary + 1', async () => {
            const now = Math.floor(Date.now() / 1000);
            const state = makeFeeState({ lastUpdated: now - 3601 }); // 1 second past 1 hour
            const client = createMockClient({ feeState: state });
            const module = new FeeModule(client);

            expect(await module.isStale(PAIR)).toBe(true);
        });

        it('returns false when lastUpdated is exactly at boundary', async () => {
            const now = Math.floor(Date.now() / 1000);
            const state = makeFeeState({ lastUpdated: now - 3600 }); // exactly 1 hour
            const client = createMockClient({ feeState: state });
            const module = new FeeModule(client);

            // now - lastUpdated = 3600, not > 3600, so not stale
            expect(await module.isStale(PAIR)).toBe(false);
        });
    });

    // -----------------------------------------------------------------------
    // getCurrentFee()
    // -----------------------------------------------------------------------
    describe('getCurrentFee()', () => {
        it('returns correct FeeEstimate shape with all fields', async () => {
            const feeState = makeFeeState({
                feeCurrent: 45,
                baselineFee: 30,
                feeMin: 10,
                feeMax: 100,
                volAccumulator: 1234n,
                emaDecayRate: 7,
                lastUpdated: Math.floor(Date.now() / 1000) - 120,
            });
            const client = createMockClient({ feeState });
            const module = new FeeModule(client);

            const estimate = await module.getCurrentFee(PAIR);

            expect(estimate.pairAddress).toBe(PAIR);
            expect(estimate.currentFeeBps).toBe(45);
            expect(estimate.baselineFeeBps).toBe(30);
            expect(estimate.feeMin).toBe(10);
            expect(estimate.feeMax).toBe(100);
            expect(estimate.volatility).toBe(1234n);
            expect(estimate.emaDecayRate).toBe(7);
            expect(estimate.lastUpdated).toBe(feeState.lastUpdated);
        });

        it('sets isStale to false when fee was recently updated', async () => {
            const feeState = makeFeeState({
                lastUpdated: Math.floor(Date.now() / 1000) - 30, // 30 sec ago
            });
            const client = createMockClient({ feeState });
            const module = new FeeModule(client);

            const estimate = await module.getCurrentFee(PAIR);

            expect(estimate.isStale).toBe(false);
        });

        it('sets isStale to true when fee is older than 1 hour', async () => {
            const feeState = makeFeeState({
                lastUpdated: Math.floor(Date.now() / 1000) - 7200, // 2 hours ago
            });
            const client = createMockClient({ feeState });
            const module = new FeeModule(client);

            const estimate = await module.getCurrentFee(PAIR);

            expect(estimate.isStale).toBe(true);
        });
    });

    // -----------------------------------------------------------------------
    // compareFees()
    // -----------------------------------------------------------------------
    describe('compareFees()', () => {
        it('returns fee estimates for multiple pairs', async () => {
            const pairs = ['CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDR4', 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOLZM', 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARQG5'];
            const client = createMockClient({
                pairs: {
                    'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDR4': { feeState: makeFeeState({ feeCurrent: 20 }) },
                    'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOLZM': { feeState: makeFeeState({ feeCurrent: 50 }) },
                    'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARQG5': { feeState: makeFeeState({ feeCurrent: 80 }) },
                },
            });
            const module = new FeeModule(client);

            const results = await module.compareFees(pairs);

            expect(results).toHaveLength(3);
        });

        it('preserves input order in results', async () => {
            const pairs = ['CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM', 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4', 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M'];
            const client = createMockClient({
                pairs: {
                    'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM': { feeState: makeFeeState({ feeCurrent: 10 }) },
                    'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4': { feeState: makeFeeState({ feeCurrent: 50 }) },
                    'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M': { feeState: makeFeeState({ feeCurrent: 90 }) },
                },
            });
            const module = new FeeModule(client);

            const results = await module.compareFees(pairs);

            expect(results[0].pairAddress).toBe('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM');
            expect(results[0].currentFeeBps).toBe(10);
            expect(results[1].pairAddress).toBe('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4');
            expect(results[1].currentFeeBps).toBe(50);
            expect(results[2].pairAddress).toBe('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M');
            expect(results[2].currentFeeBps).toBe(90);
        });

        it('returns empty array for empty input', async () => {
            const client = createMockClient();
            const module = new FeeModule(client);

            const results = await module.compareFees([]);

            expect(results).toHaveLength(0);
        });

        it('each result has correct isStale flag', async () => {
            const now = Math.floor(Date.now() / 1000);
            const FRESH_ADDR = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDR4';
            const STALE_ADDR = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOLZM';
            const client = createMockClient({
                pairs: {
                    [FRESH_ADDR]: { feeState: makeFeeState({ lastUpdated: now - 60 }) },
                    [STALE_ADDR]: { feeState: makeFeeState({ lastUpdated: now - 7200 }) },
                },
            });
            const module = new FeeModule(client);

            const results = await module.compareFees([FRESH_ADDR, STALE_ADDR]);

            expect(results[0].isStale).toBe(false);
            expect(results[1].isStale).toBe(true);
        });
    });
});
