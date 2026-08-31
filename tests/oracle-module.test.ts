import { OracleModule, TWAPObservation, MIN_TWAP_WINDOW_SECONDS, MAX_OBSERVATIONS } from '../src/modules/oracle';
import { CoralSwapClient } from '../src/client';
import { PRECISION } from '../src/config';
import { ValidationError, InsufficientLiquidityError } from '../src/errors';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockClient(opts: {
    reserve0?: bigint;
    reserve1?: bigint;
    token0?: string;
    token1?: string;
    price0CumulativeLast?: bigint;
    price1CumulativeLast?: bigint;
    blockTimestampLast?: number;
} = {}): CoralSwapClient {
    return {
        pair: jest.fn().mockReturnValue({
            getReserves: jest.fn().mockResolvedValue({
                reserve0: opts.reserve0 ?? 1_000_000n,
                reserve1: opts.reserve1 ?? 1_000_000n,
            }),
            getTokens: jest.fn().mockResolvedValue({
                token0: opts.token0 ?? 'TOKEN_0',
                token1: opts.token1 ?? 'TOKEN_1',
            }),
            getCumulativePrices: jest.fn().mockResolvedValue({
                price0CumulativeLast: opts.price0CumulativeLast ?? 0n,
                price1CumulativeLast: opts.price1CumulativeLast ?? 0n,
                blockTimestampLast: opts.blockTimestampLast ?? 1000,
            }),
        }),
    } as unknown as CoralSwapClient;
}

function makeObs(
    p0: bigint,
    p1: bigint,
    ts: number,
): TWAPObservation {
    return {
        price0CumulativeLast: p0,
        price1CumulativeLast: p1,
        blockTimestampLast: ts,
    };
}

/**
 * Create a mock client whose getCumulativePrices() returns a new timestamp
 * on each call: startTs, startTs + stepSeconds, startTs + 2*stepSeconds, ...
 * Cumulative prices are kept at zero for simplicity (pruning logic only
 * inspects timestamps).
 */
function createSequentialMockClient(
    startTs: number,
    stepSeconds: number,
): CoralSwapClient {
    let call = 0;
    return {
        pair: jest.fn().mockReturnValue({
            getReserves: jest.fn().mockResolvedValue({
                reserve0: 1_000_000n,
                reserve1: 1_000_000n,
            }),
            getTokens: jest.fn().mockResolvedValue({
                token0: 'TOKEN_0',
                token1: 'TOKEN_1',
            }),
            getCumulativePrices: jest.fn().mockImplementation(() =>
                Promise.resolve({
                    price0CumulativeLast: 0n,
                    price1CumulativeLast: 0n,
                    blockTimestampLast: startTs + call++ * stepSeconds,
                }),
            ),
        }),
    } as unknown as CoralSwapClient;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OracleModule', () => {
    const PAIR = 'PAIR_CONTRACT';

    // -----------------------------------------------------------------------
    // computeTWAP() — pure function
    // -----------------------------------------------------------------------
    describe('computeTWAP()', () => {
        let oracle: OracleModule;

        beforeEach(() => {
            oracle = new OracleModule(createMockClient());
        });

        it('computes correct TWAP for two observations 100 seconds apart', () => {
            const start = makeObs(1000n, 2000n, 100);
            const end = makeObs(11000n, 22000n, 200);

            const result = oracle.computeTWAP(start, end, { enforceMinWindow: false });

            // price0TWAP = (11000 - 1000) / 100 = 100
            expect(result.price0TWAP).toBe(100n);
            // price1TWAP = (22000 - 2000) / 100 = 200
            expect(result.price1TWAP).toBe(200n);
            expect(result.timeWindow).toBe(100);
        });

        it('computes correct TWAP for a 1-second window', () => {
            const start = makeObs(0n, 0n, 500);
            const end = makeObs(500n, 1000n, 501);

            const result = oracle.computeTWAP(start, end, { enforceMinWindow: false });

            expect(result.price0TWAP).toBe(500n);
            expect(result.price1TWAP).toBe(1000n);
            expect(result.timeWindow).toBe(1);
        });

        it('handles large cumulative values without overflow', () => {
            const start = makeObs(10n ** 30n, 10n ** 30n, 0);
            const end = makeObs(10n ** 30n + 10n ** 24n, 10n ** 30n + 2n * 10n ** 24n, 1000);

            const result = oracle.computeTWAP(start, end, { enforceMinWindow: false });

            expect(result.price0TWAP).toBe(10n ** 21n);
            expect(result.price1TWAP).toBe(2n * 10n ** 21n);
        });

        it('returns zero TWAP when cumulative prices are unchanged', () => {
            const start = makeObs(5000n, 5000n, 100);
            const end = makeObs(5000n, 5000n, 200);

            const result = oracle.computeTWAP(start, end, { enforceMinWindow: false });

            expect(result.price0TWAP).toBe(0n);
            expect(result.price1TWAP).toBe(0n);
        });

        it('throws ValidationError when time elapsed is zero', () => {
            const start = makeObs(1000n, 2000n, 100);
            const end = makeObs(2000n, 3000n, 100);

            expect(() => oracle.computeTWAP(start, end)).toThrow(ValidationError);
            expect(() => oracle.computeTWAP(start, end)).toThrow(
                'End observation must be after start observation',
            );
        });

        it('throws ValidationError when time elapsed is negative', () => {
            const start = makeObs(1000n, 2000n, 200);
            const end = makeObs(2000n, 3000n, 100);

            expect(() => oracle.computeTWAP(start, end)).toThrow(ValidationError);
        });

        it('floors fractional TWAP via BigInt division', () => {
            // (10 - 0) / 3 = 3.33... → floors to 3
            const start = makeObs(0n, 0n, 0);
            const end = makeObs(10n, 7n, 3);

            const result = oracle.computeTWAP(start, end, { enforceMinWindow: false });

            expect(result.price0TWAP).toBe(3n);
            expect(result.price1TWAP).toBe(2n);
        });
    });

    // -----------------------------------------------------------------------
    // Observation cache
    // -----------------------------------------------------------------------
    describe('observation cache', () => {
        it('observe() caches observations and increments count', async () => {
            const client = createMockClient({ blockTimestampLast: 1000 });
            const oracle = new OracleModule(client);

            expect(oracle.getObservationCount(PAIR)).toBe(0);

            await oracle.observe(PAIR);
            expect(oracle.getObservationCount(PAIR)).toBe(1);

            await oracle.observe(PAIR);
            expect(oracle.getObservationCount(PAIR)).toBe(2);
        });

        it('hard cap: cache is bounded at MAX_OBSERVATIONS when all entries are within the minimum window', async () => {
            // 1-second steps → all observations stay within MIN_TWAP_WINDOW_SECONDS (300 s),
            // so window-coverage pruning never fires; the hard cap must engage.
            const oracle = new OracleModule(
                createSequentialMockClient(0, 1),
            );

            const overCap = MAX_OBSERVATIONS + 10;
            for (let i = 0; i < overCap; i++) {
                await oracle.observe(PAIR);
            }

            expect(oracle.getObservationCount(PAIR)).toBeLessThanOrEqual(MAX_OBSERVATIONS);
        });

        // --- window-coverage pruning ---

        it('window-coverage: drops oldest entry once the window is comfortably covered', async () => {
            // Poll every MIN_TWAP_WINDOW_SECONDS seconds so each new observation
            // immediately gives the next-oldest enough room to become the new oldest.
            const step = MIN_TWAP_WINDOW_SECONDS; // 300 s
            const oracle = new OracleModule(
                createSequentialMockClient(0, step),
            );

            // After 3 observations (ts 0, 300, 600) the gap from obs[1] (ts=300)
            // to obs[2] (ts=600) = 300 = MIN_TWAP_WINDOW_SECONDS, so obs[0] is dropped.
            await oracle.observe(PAIR); // ts = 0   → [0]
            await oracle.observe(PAIR); // ts = 300 → [0, 300]
            await oracle.observe(PAIR); // ts = 600 → drop 0, keep [300, 600]

            const count = oracle.getObservationCount(PAIR);
            expect(count).toBe(2);

            const series = oracle.getObservationSeries(PAIR);
            expect(series[0].blockTimestampLast).toBe(300);
            expect(series[series.length - 1].blockTimestampLast).toBe(600);
        });

        it('window-coverage: never drops below 2 entries', async () => {
            // Even with very long gaps the cache must keep at least 2 entries.
            const oracle = new OracleModule(
                createSequentialMockClient(0, MIN_TWAP_WINDOW_SECONDS * 100),
            );

            await oracle.observe(PAIR);
            await oracle.observe(PAIR);

            expect(oracle.getObservationCount(PAIR)).toBeGreaterThanOrEqual(2);
        });

        it('window-coverage: minimum window is preserved for high-frequency polling', async () => {
            // 1-second steps: after >MIN_TWAP_WINDOW_SECONDS polls the window-coverage
            // pruner fires and stabilises the cache so that the oldest timestamp is
            // always within MIN_TWAP_WINDOW_SECONDS of the newest.
            const step = 1; // 1-second polls
            const numPolls = MIN_TWAP_WINDOW_SECONDS * 2; // well past the window
            const oracle = new OracleModule(
                createSequentialMockClient(0, step),
            );

            for (let i = 0; i < numPolls; i++) {
                await oracle.observe(PAIR);
            }

            const series = oracle.getObservationSeries(PAIR);
            const coverageSeconds =
                series[series.length - 1].blockTimestampLast - series[0].blockTimestampLast;

            expect(coverageSeconds).toBeGreaterThanOrEqual(MIN_TWAP_WINDOW_SECONDS);
        });

        it('window-coverage: retains only a bounded set once history spans the window', async () => {
            // Same scenario as above: once the window is covered the cache should
            // not keep growing unboundedly.
            const step = 1;
            const numPolls = MIN_TWAP_WINDOW_SECONDS * 3;
            const oracle = new OracleModule(
                createSequentialMockClient(0, step),
            );

            for (let i = 0; i < numPolls; i++) {
                await oracle.observe(PAIR);
            }

            // Stabilised count ≈ MIN_TWAP_WINDOW_SECONDS + 1 (one observation per second).
            // Allow a small tolerance for off-by-one edge cases.
            const count = oracle.getObservationCount(PAIR);
            expect(count).toBeLessThanOrEqual(MIN_TWAP_WINDOW_SECONDS + 2);
        });

        it('window-coverage: slow-polling pair accumulates < MIN_TWAP_WINDOW_SECONDS observations without pruning', async () => {
            // 60-second steps; after 4 observations (0, 60, 120, 180) the span is
            // only 180 s which is less than MIN_TWAP_WINDOW_SECONDS (300 s), so
            // nothing should be pruned.
            const oracle = new OracleModule(
                createSequentialMockClient(0, 60),
            );

            for (let i = 0; i < 4; i++) {
                await oracle.observe(PAIR);
            }

            expect(oracle.getObservationCount(PAIR)).toBe(4);
        });

        it('clearCache() removes observations for a specific pair', async () => {
            const client = createMockClient();
            const oracle = new OracleModule(client);

            await oracle.observe('PAIR_A');
            await oracle.observe('PAIR_B');
            expect(oracle.getObservationCount('PAIR_A')).toBe(1);
            expect(oracle.getObservationCount('PAIR_B')).toBe(1);

            oracle.clearCache('PAIR_A');

            expect(oracle.getObservationCount('PAIR_A')).toBe(0);
            expect(oracle.getObservationCount('PAIR_B')).toBe(1);
        });

        it('clearCache() without args removes all observations', async () => {
            const client = createMockClient();
            const oracle = new OracleModule(client);

            await oracle.observe('PAIR_A');
            await oracle.observe('PAIR_B');
            await oracle.observe('PAIR_C');

            oracle.clearCache();

            expect(oracle.getObservationCount('PAIR_A')).toBe(0);
            expect(oracle.getObservationCount('PAIR_B')).toBe(0);
            expect(oracle.getObservationCount('PAIR_C')).toBe(0);
        });

        it('getObservationCount() returns 0 for unknown pairs', () => {
            const oracle = new OracleModule(createMockClient());

            expect(oracle.getObservationCount('UNKNOWN_PAIR')).toBe(0);
        });
    });

    // -----------------------------------------------------------------------
    // getSpotPrice()
    // -----------------------------------------------------------------------
    describe('getSpotPrice()', () => {
        it('computes correct price: price0Per1 = (reserve0 * PRICE_SCALE) / reserve1', async () => {
            const client = createMockClient({
                reserve0: 2_000_000n,
                reserve1: 1_000_000n,
            });
            const oracle = new OracleModule(client);

            const { price0Per1, price1Per0 } = await oracle.getSpotPrice(PAIR);

            expect(price0Per1).toBe(
                (2_000_000n * PRECISION.PRICE_SCALE) / 1_000_000n,
            );
            expect(price1Per0).toBe(
                (1_000_000n * PRECISION.PRICE_SCALE) / 2_000_000n,
            );
        });

        it('equal reserves produce price ratio of PRICE_SCALE', async () => {
            const client = createMockClient({
                reserve0: 5_000_000n,
                reserve1: 5_000_000n,
            });
            const oracle = new OracleModule(client);

            const { price0Per1, price1Per0 } = await oracle.getSpotPrice(PAIR);

            expect(price0Per1).toBe(PRECISION.PRICE_SCALE);
            expect(price1Per0).toBe(PRECISION.PRICE_SCALE);
        });

        it('throws InsufficientLiquidityError when reserve0 is zero', async () => {
            const client = createMockClient({ reserve0: 0n, reserve1: 1_000_000n });
            const oracle = new OracleModule(client);

            await expect(oracle.getSpotPrice(PAIR)).rejects.toThrow(
                InsufficientLiquidityError,
            );
        });

        it('throws InsufficientLiquidityError when reserve1 is zero', async () => {
            const client = createMockClient({ reserve0: 1_000_000n, reserve1: 0n });
            const oracle = new OracleModule(client);

            await expect(oracle.getSpotPrice(PAIR)).rejects.toThrow(
                InsufficientLiquidityError,
            );
        });

        it('throws InsufficientLiquidityError when both reserves are zero', async () => {
            const client = createMockClient({ reserve0: 0n, reserve1: 0n });
            const oracle = new OracleModule(client);

            await expect(oracle.getSpotPrice(PAIR)).rejects.toThrow(
                InsufficientLiquidityError,
            );
        });

        it('handles extremely unbalanced reserves without overflow', async () => {
            const client = createMockClient({
                reserve0: 10n ** 24n,
                reserve1: 1n,
            });
            const oracle = new OracleModule(client);

            const { price0Per1, price1Per0 } = await oracle.getSpotPrice(PAIR);

            expect(price0Per1).toBe(10n ** 24n * PRECISION.PRICE_SCALE);
            expect(price1Per0).toBeGreaterThanOrEqual(0n);
        });
    });
});
