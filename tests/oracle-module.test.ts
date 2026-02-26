import { OracleModule, TWAPObservation } from '../src/modules/oracle';
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

            const result = oracle.computeTWAP(start, end);

            // price0TWAP = (11000 - 1000) / 100 = 100
            expect(result.price0TWAP).toBe(100n);
            // price1TWAP = (22000 - 2000) / 100 = 200
            expect(result.price1TWAP).toBe(200n);
            expect(result.timeWindow).toBe(100);
        });

        it('computes correct TWAP for a 1-second window', () => {
            const start = makeObs(0n, 0n, 500);
            const end = makeObs(500n, 1000n, 501);

            const result = oracle.computeTWAP(start, end);

            expect(result.price0TWAP).toBe(500n);
            expect(result.price1TWAP).toBe(1000n);
            expect(result.timeWindow).toBe(1);
        });

        it('handles large cumulative values without overflow', () => {
            const start = makeObs(10n ** 30n, 10n ** 30n, 0);
            const end = makeObs(10n ** 30n + 10n ** 24n, 10n ** 30n + 2n * 10n ** 24n, 1000);

            const result = oracle.computeTWAP(start, end);

            expect(result.price0TWAP).toBe(10n ** 21n);
            expect(result.price1TWAP).toBe(2n * 10n ** 21n);
        });

        it('returns zero TWAP when cumulative prices are unchanged', () => {
            const start = makeObs(5000n, 5000n, 100);
            const end = makeObs(5000n, 5000n, 200);

            const result = oracle.computeTWAP(start, end);

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

            const result = oracle.computeTWAP(start, end);

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

        it('cache is capped at 100 entries (oldest pruned)', async () => {
            const client = createMockClient();
            const oracle = new OracleModule(client);

            // Insert 105 observations
            for (let i = 0; i < 105; i++) {
                await oracle.observe(PAIR);
            }

            expect(oracle.getObservationCount(PAIR)).toBe(100);
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
