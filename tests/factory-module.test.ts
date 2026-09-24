import { CoralSwapClient } from '../src/client';
import { FactoryModule } from '../src/modules/factory';
import { Network } from '../src/types/common';
import { PairNotFoundError } from '../src/errors';
import { PairInfo } from '../src/types/pool';

// Mock Contract to bypass address validation
jest.mock('@stellar/stellar-sdk', () => {
    const actual = jest.requireActual('@stellar/stellar-sdk');
    return {
        ...actual,
        Contract: jest.fn().mockImplementation((address) => ({
            address,
            call: jest.fn(),
        })),
    };
});

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const TOKEN_A   = 'CAS3J7GYCCX7NVPYQ37DSVUTVD3YKH7TDRYQFYMCH5FDD3E2XCC7M326';
const TOKEN_B   = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const TOKEN_C   = 'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K';
const TOKEN_D   = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const PAIR_AB   = 'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K';
const PAIR_CD   = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4';
const LP_ADDR   = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M';

// ---------------------------------------------------------------------------
// Helper: build a minimal mock CoralSwapClient
// ---------------------------------------------------------------------------

function buildClient() {
    const client = new CoralSwapClient({
        network: Network.TESTNET,
        secretKey: 'SB6K2AINTGNYBFX4M7TRPGSKQ5RKNOXXWB7UZUHRYOVTM7REDUGECKZU',
        rpcUrl: 'https://soroban-testnet.stellar.org',
    });
    (client as any).networkConfig.factoryAddress =
        'CA3J7GYCCX7NVPYQ37DSVUTVD3YKH7TDRYQFYMCH5FDD3E2XCC7M326';
    return client;
}

/** Attach a mock getPair on the client's lazy factory singleton. */
function mockGetPair(client: CoralSwapClient, impl: (a: string, b: string) => Promise<string | null>) {
    (client as any).factory.getPair = jest.fn().mockImplementation(impl);
    return (client as any).factory.getPair as jest.Mock;
}

/** Build a mock pair client returned by client.pair(). */
function mockPairClient(opts: {
    reserve0?: bigint;
    reserve1?: bigint;
    feeBps?: number;
    lpTokenAddress?: string;
} = {}) {
    return {
        getReserves: jest.fn().mockResolvedValue({
            reserve0: opts.reserve0 ?? 1_000_000n,
            reserve1: opts.reserve1 ?? 2_000_000n,
        }),
        getDynamicFee: jest.fn().mockResolvedValue(opts.feeBps ?? 30),
        getLPTokenAddress: jest.fn().mockResolvedValue(opts.lpTokenAddress ?? LP_ADDR),
    };
}

/** Build a mock LP token client returned by client.lpToken(). */
function mockLpTokenClient(totalSupply: bigint = 500_000n) {
    return {
        totalSupply: jest.fn().mockResolvedValue(totalSupply),
    };
}

describe('FactoryClient and PairClient contract view wrappers', () => {
    it('exposes total pair and fee-state version accessors', async () => {
        const factory = new (require('../src/contracts/factory').FactoryClient)(
            'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
            {} as any,
            'Test SDF Network ; September 2015',
            { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
        );

        (factory as any).simulateRead = jest.fn()
            .mockResolvedValueOnce({ type: 'scvU32', u32: 42 })
            .mockResolvedValueOnce({ type: 'scvU32', u32: 7 });

        await expect(factory.getTotalPairs()).resolves.toBe(42);
        await expect(factory.getFeeStateVersion()).resolves.toBe(7);
    });

    it('exposes pair wasm and fee-state version accessors', async () => {
        const pair = new (require('../src/contracts/pair').PairClient)(
            'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
            {} as any,
            'Test SDF Network ; September 2015',
            { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
        );

        (pair as any).simulateRead = jest.fn()
            .mockResolvedValueOnce({ type: 'scvBytes', bytes: () => Buffer.from('abcd', 'hex') })
            .mockResolvedValueOnce({ type: 'scvU32', u32: 17 });

        await expect(pair.getWasmHash()).resolves.toBe('abcd');
        await expect(pair.getFeeStateVersion()).resolves.toBe(17);
    });
});

// ---------------------------------------------------------------------------
// Existing cache tests (preserved + migrated to TTL-aware entries)
// ---------------------------------------------------------------------------

describe('FactoryModule — existing cache behaviour', () => {
    let client: CoralSwapClient;

    beforeEach(() => {
        client = buildClient();
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    it('caches getPairAddress results within TTL', async () => {
        const mockGetPairFn = mockGetPair(client, async () => PAIR_AB);
        const module = new FactoryModule(client);

        const addr1 = await module.getPairAddress(TOKEN_A, TOKEN_B);
        expect(addr1).toBe(PAIR_AB);
        expect(mockGetPairFn).toHaveBeenCalledTimes(1);

        const addr2 = await module.getPairAddress(TOKEN_A, TOKEN_B);
        expect(addr2).toBe(PAIR_AB);
        expect(mockGetPairFn).toHaveBeenCalledTimes(1); // cache hit
    });

    it('bypasses cache when bypassCache: true', async () => {
        const mockGetPairFn = mockGetPair(client, async () => PAIR_AB);
        const module = new FactoryModule(client);

        await module.getPairAddress(TOKEN_A, TOKEN_B);
        expect(mockGetPairFn).toHaveBeenCalledTimes(1);

        await module.getPairAddress(TOKEN_A, TOKEN_B, { bypassCache: true });
        expect(mockGetPairFn).toHaveBeenCalledTimes(2);
    });

    it('uses deterministic sorting for cache keys', async () => {
        const mockGetPairFn = mockGetPair(client, async () => PAIR_AB);
        const module = new FactoryModule(client);

        await module.getPairAddress(TOKEN_A, TOKEN_B);
        expect(mockGetPairFn).toHaveBeenCalledTimes(1);

        // Reversed order — same cache key
        await module.getPairAddress(TOKEN_B, TOKEN_A);
        expect(mockGetPairFn).toHaveBeenCalledTimes(1);
    });

    it('supports pre-loading pairs (no RPC call on lookup)', async () => {
        const mockGetPairFn = mockGetPair(client, async () => PAIR_AB);
        const module = new FactoryModule(client);

        module.preLoadPairs([[TOKEN_A, TOKEN_B, PAIR_AB]]);

        const addr = await module.getPairAddress(TOKEN_A, TOKEN_B);
        expect(addr).toBe(PAIR_AB);
        expect(mockGetPairFn).not.toHaveBeenCalled();
    });

    it('clears cache on network switch', async () => {
        const mockGetPairFn = mockGetPair(client, async () => PAIR_AB);
        const module = client.factoryModule();

        await module.getPairAddress(TOKEN_A, TOKEN_B);
        expect(mockGetPairFn).toHaveBeenCalledTimes(1);

        client.setNetwork(Network.MAINNET);
        (client as any).networkConfig.factoryAddress =
            'CA3J7GYCCX7NVPYQ37DSVUTVD3YKH7TDRYQFYMCH5FDD3E2XCC7M326';
        (client as any).factory.getPair = mockGetPairFn;

        await module.getPairAddress(TOKEN_A, TOKEN_B);
        expect(mockGetPairFn).toHaveBeenCalledTimes(2);
    });
});

// ---------------------------------------------------------------------------
// invalidateCache()
// ---------------------------------------------------------------------------

describe('FactoryModule.invalidateCache()', () => {
    let client: CoralSwapClient;

    beforeEach(() => {
        client = buildClient();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('clears a specific pair by address', async () => {
        const mockGetPairFn = mockGetPair(client, async () => PAIR_AB);
        const module = new FactoryModule(client);

        // Warm cache
        await module.getPairAddress(TOKEN_A, TOKEN_B);
        expect(mockGetPairFn).toHaveBeenCalledTimes(1);

        // Invalidate by pair address — next lookup must hit RPC again
        module.invalidateCache(PAIR_AB);

        await module.getPairAddress(TOKEN_A, TOKEN_B);
        expect(mockGetPairFn).toHaveBeenCalledTimes(2);
    });

    it('does not affect other cached pairs when invalidating a specific one', async () => {
        // Seed two separate pairs into the cache
        const getPairFn = jest.fn()
            .mockImplementation(async (a: string, b: string) => {
                if ((a === TOKEN_A || b === TOKEN_A) && (a === TOKEN_B || b === TOKEN_B))
                    return PAIR_AB;
                return PAIR_CD;
            });
        (client as any).factory.getPair = getPairFn;
        const module = new FactoryModule(client);

        await module.getPairAddress(TOKEN_A, TOKEN_B);
        await module.getPairAddress(TOKEN_C, TOKEN_D);
        expect(getPairFn).toHaveBeenCalledTimes(2);

        // Invalidate only PAIR_AB
        module.invalidateCache(PAIR_AB);

        // TOKEN_A/TOKEN_B must re-fetch; TOKEN_C/TOKEN_D must still be cached
        await module.getPairAddress(TOKEN_A, TOKEN_B);
        await module.getPairAddress(TOKEN_C, TOKEN_D);
        expect(getPairFn).toHaveBeenCalledTimes(3); // one extra call for AB only
    });

    it('invalidates all cached pairs when called with no argument', async () => {
        const getPairFn = jest.fn().mockResolvedValue(PAIR_AB);
        (client as any).factory.getPair = getPairFn;
        const module = new FactoryModule(client);

        // Warm multiple entries
        await module.getPairAddress(TOKEN_A, TOKEN_B);
        await module.getPairAddress(TOKEN_C, TOKEN_D);
        expect(getPairFn).toHaveBeenCalledTimes(2);

        module.invalidateCache(); // clear all

        // Both pairs must hit the RPC again
        await module.getPairAddress(TOKEN_A, TOKEN_B);
        await module.getPairAddress(TOKEN_C, TOKEN_D);
        expect(getPairFn).toHaveBeenCalledTimes(4);
    });

    it('is a no-op when the cache is already empty', () => {
        const module = new FactoryModule(client);
        expect(() => module.invalidateCache()).not.toThrow();
        expect(() => module.invalidateCache(PAIR_AB)).not.toThrow();
    });

    it('is a no-op when the specified pair address is not cached', async () => {
        const getPairFn = mockGetPair(client, async () => PAIR_AB);
        const module = new FactoryModule(client);

        await module.getPairAddress(TOKEN_A, TOKEN_B);
        expect(getPairFn).toHaveBeenCalledTimes(1);

        // Invalidate an address that was never cached — AB must still be valid
        module.invalidateCache(PAIR_CD);

        await module.getPairAddress(TOKEN_A, TOKEN_B);
        expect(getPairFn).toHaveBeenCalledTimes(1); // still cached
    });
});

// ---------------------------------------------------------------------------
// getPairInfo()
// ---------------------------------------------------------------------------

describe('FactoryModule.getPairInfo()', () => {
    let client: CoralSwapClient;

    beforeEach(() => {
        client = buildClient();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    function setupPairInfo(opts: {
        pairAddress?: string;
        reserve0?: bigint;
        reserve1?: bigint;
        feeBps?: number;
        lpTokenAddress?: string;
        totalSupply?: bigint;
    } = {}) {
        const addr = opts.pairAddress ?? PAIR_AB;
        mockGetPair(client, async () => addr);

        const pair = mockPairClient({
            reserve0: opts.reserve0,
            reserve1: opts.reserve1,
            feeBps: opts.feeBps,
            lpTokenAddress: opts.lpTokenAddress ?? LP_ADDR,
        });
        jest.spyOn(client, 'pair').mockReturnValue(pair as any);

        const lpToken = mockLpTokenClient(opts.totalSupply ?? 500_000n);
        jest.spyOn(client, 'lpToken').mockReturnValue(lpToken as any);

        return { pair, lpToken };
    }

    it('returns a PairInfo object with all five fields', async () => {
        setupPairInfo();
        const module = new FactoryModule(client);

        const info: PairInfo = await module.getPairInfo(TOKEN_A, TOKEN_B);

        expect(info).toHaveProperty('address');
        expect(info).toHaveProperty('reserveA');
        expect(info).toHaveProperty('reserveB');
        expect(info).toHaveProperty('feeBps');
        expect(info).toHaveProperty('totalSupply');
    });

    it('address field equals the resolved pair contract address', async () => {
        setupPairInfo({ pairAddress: PAIR_AB });
        const module = new FactoryModule(client);

        const info = await module.getPairInfo(TOKEN_A, TOKEN_B);
        expect(info.address).toBe(PAIR_AB);
    });

    it('reserveA and reserveB are bigints', async () => {
        setupPairInfo({ reserve0: 3_000_000n, reserve1: 7_000_000n });
        const module = new FactoryModule(client);

        const info = await module.getPairInfo(TOKEN_A, TOKEN_B);
        expect(typeof info.reserveA).toBe('bigint');
        expect(typeof info.reserveB).toBe('bigint');
    });

    it('returns correct reserve values for the caller token ordering', async () => {
        // TOKEN_A < TOKEN_B lexicographically so t0=TOKEN_A, reserve0 maps to reserveA
        setupPairInfo({ reserve0: 1_111n, reserve1: 2_222n });
        const module = new FactoryModule(client);

        const info = await module.getPairInfo(TOKEN_A, TOKEN_B);

        // TOKEN_A is the smaller address → it is token0 → reserve0 = reserveA
        expect(info.reserveA).toBe(1_111n);
        expect(info.reserveB).toBe(2_222n);
    });

    it('swaps reserve mapping when tokenA > tokenB (reversed order)', async () => {
        // Call with (TOKEN_B, TOKEN_A) — B > A so t0=TOKEN_A, reserve0 → reserveB
        setupPairInfo({ reserve0: 1_111n, reserve1: 2_222n });
        const module = new FactoryModule(client);

        const info = await module.getPairInfo(TOKEN_B, TOKEN_A);

        // tokenA arg is TOKEN_B which is token1, so reserveA = reserve1
        expect(info.reserveA).toBe(2_222n);
        expect(info.reserveB).toBe(1_111n);
    });

    it('feeBps is a number matching the dynamic fee', async () => {
        setupPairInfo({ feeBps: 45 });
        const module = new FactoryModule(client);

        const info = await module.getPairInfo(TOKEN_A, TOKEN_B);
        expect(info.feeBps).toBe(45);
        expect(typeof info.feeBps).toBe('number');
    });

    it('totalSupply is a bigint matching LP token supply', async () => {
        setupPairInfo({ totalSupply: 999_999n });
        const module = new FactoryModule(client);

        const info = await module.getPairInfo(TOKEN_A, TOKEN_B);
        expect(info.totalSupply).toBe(999_999n);
        expect(typeof info.totalSupply).toBe('bigint');
    });

    it('calls pair() and lpToken() exactly once each (single multicall)', async () => {
        const { pair, lpToken } = setupPairInfo();
        const module = new FactoryModule(client);

        await module.getPairInfo(TOKEN_A, TOKEN_B);

        expect(client.pair).toHaveBeenCalledTimes(1);
        expect(client.lpToken).toHaveBeenCalledTimes(1);
    });

    it('fetches reserves, fee, and LP address in parallel (all three called)', async () => {
        const { pair } = setupPairInfo();
        const module = new FactoryModule(client);

        await module.getPairInfo(TOKEN_A, TOKEN_B);

        expect(pair.getReserves).toHaveBeenCalledTimes(1);
        expect(pair.getDynamicFee).toHaveBeenCalledTimes(1);
        expect(pair.getLPTokenAddress).toHaveBeenCalledTimes(1);
    });

    it('throws PairNotFoundError when the pair does not exist', async () => {
        mockGetPair(client, async () => null);
        const module = new FactoryModule(client);

        await expect(module.getPairInfo(TOKEN_A, TOKEN_B)).rejects.toBeInstanceOf(
            PairNotFoundError,
        );
    });

    it('PairNotFoundError carries both token addresses', async () => {
        mockGetPair(client, async () => null);
        const module = new FactoryModule(client);

        try {
            await module.getPairInfo(TOKEN_A, TOKEN_B);
            fail('Expected PairNotFoundError');
        } catch (err) {
            expect(err).toBeInstanceOf(PairNotFoundError);
            const details = (err as PairNotFoundError).details;
            expect(details?.tokenA).toBe(TOKEN_A);
            expect(details?.tokenB).toBe(TOKEN_B);
        }
    });

    it('passes the LP token address from the pair to client.lpToken()', async () => {
        const customLpAddr = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM';
        setupPairInfo({ lpTokenAddress: customLpAddr });
        const module = new FactoryModule(client);

        await module.getPairInfo(TOKEN_A, TOKEN_B);

        expect(client.lpToken).toHaveBeenCalledWith(customLpAddr);
    });
});

// ---------------------------------------------------------------------------
// Cache TTL
// ---------------------------------------------------------------------------

describe('FactoryModule — cache TTL', () => {
    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it('uses the cache within TTL window', async () => {
        jest.useFakeTimers();
        const client = buildClient();
        const getPairFn = mockGetPair(client, async () => PAIR_AB);
        const module = new FactoryModule(client, 60_000);

        await module.getPairAddress(TOKEN_A, TOKEN_B);
        expect(getPairFn).toHaveBeenCalledTimes(1);

        // Advance 59 seconds — still within TTL
        jest.advanceTimersByTime(59_000);

        await module.getPairAddress(TOKEN_A, TOKEN_B);
        expect(getPairFn).toHaveBeenCalledTimes(1); // cache still valid
    });

    it('re-fetches after TTL expires', async () => {
        jest.useFakeTimers();
        const client = buildClient();
        const getPairFn = mockGetPair(client, async () => PAIR_AB);
        const module = new FactoryModule(client, 60_000);

        await module.getPairAddress(TOKEN_A, TOKEN_B);
        expect(getPairFn).toHaveBeenCalledTimes(1);

        // Advance past the 60-second TTL
        jest.advanceTimersByTime(61_000);

        await module.getPairAddress(TOKEN_A, TOKEN_B);
        expect(getPairFn).toHaveBeenCalledTimes(2); // cache expired → re-fetch
    });

    it('configurable TTL: short TTL expires quickly', async () => {
        jest.useFakeTimers();
        const client = buildClient();
        const getPairFn = mockGetPair(client, async () => PAIR_AB);

        // 5-second TTL
        const module = new FactoryModule(client, 5_000);

        await module.getPairAddress(TOKEN_A, TOKEN_B);
        expect(getPairFn).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(4_000); // still within 5 s
        await module.getPairAddress(TOKEN_A, TOKEN_B);
        expect(getPairFn).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(2_000); // now 6 s total — expired
        await module.getPairAddress(TOKEN_A, TOKEN_B);
        expect(getPairFn).toHaveBeenCalledTimes(2);
    });

    it('default TTL is 60 seconds', async () => {
        jest.useFakeTimers();
        const client = buildClient();
        const getPairFn = mockGetPair(client, async () => PAIR_AB);
        const module = new FactoryModule(client); // no explicit TTL

        await module.getPairAddress(TOKEN_A, TOKEN_B);

        jest.advanceTimersByTime(60_001);
        await module.getPairAddress(TOKEN_A, TOKEN_B);
        expect(getPairFn).toHaveBeenCalledTimes(2); // expired at 60 s
    });

    it('preLoadPairs entries also expire after TTL', async () => {
        jest.useFakeTimers();
        const client = buildClient();
        const getPairFn = mockGetPair(client, async () => PAIR_AB);
        const module = new FactoryModule(client, 10_000);

        module.preLoadPairs([[TOKEN_A, TOKEN_B, PAIR_AB]]);

        // Within TTL — no RPC call
        await module.getPairAddress(TOKEN_A, TOKEN_B);
        expect(getPairFn).not.toHaveBeenCalled();

        // Advance past TTL
        jest.advanceTimersByTime(11_000);
        await module.getPairAddress(TOKEN_A, TOKEN_B);
        expect(getPairFn).toHaveBeenCalledTimes(1); // pre-loaded entry expired
    });

    it('invalidateCache() forces re-fetch regardless of TTL', async () => {
        jest.useFakeTimers();
        const client = buildClient();
        const getPairFn = mockGetPair(client, async () => PAIR_AB);
        const module = new FactoryModule(client, 60_000);

        await module.getPairAddress(TOKEN_A, TOKEN_B);
        expect(getPairFn).toHaveBeenCalledTimes(1);

        // Still within TTL but we invalidate explicitly
        jest.advanceTimersByTime(10_000);
        module.invalidateCache(PAIR_AB);

        await module.getPairAddress(TOKEN_A, TOKEN_B);
        expect(getPairFn).toHaveBeenCalledTimes(2); // invalidated → re-fetch
    });

    // -----------------------------------------------------------------------
    // verifyPairAddress
    // -----------------------------------------------------------------------

    describe('verifyPairAddress', () => {
        it('returns true for a registered pair', async () => {
            const client = buildClient();
            const module = new FactoryModule(client);
            // Mock getAllPairs to include the test pair
            (client as any).factory.getAllPairs = jest.fn().mockResolvedValue([
                PAIR_AB,
                'COTHERPAIR0000000000000000000000000000000000000000000',
            ]);

            const result = await module.verifyPairAddress(PAIR_AB);
            expect(result).toBe(true);
        });

        it('returns false for an unregistered/spoofed address', async () => {
            const client = buildClient();
            const module = new FactoryModule(client);
            const spoofedAddress = 'CSPOOFED000000000000000000000000000000000000000000000';

            (client as any).factory.getAllPairs = jest.fn().mockResolvedValue([
                PAIR_AB,
                PAIR_CD,
            ]);

            const result = await module.verifyPairAddress(spoofedAddress);
            expect(result).toBe(false);
        });

        it('returns false for empty pair list', async () => {
            const client = buildClient();
            const module = new FactoryModule(client);
            (client as any).factory.getAllPairs = jest.fn().mockResolvedValue([]);

            const result = await module.verifyPairAddress(PAIR_AB);
            expect(result).toBe(false);
        });

        it('throws ValidationError for empty address', async () => {
            const client = buildClient();
            const module = new FactoryModule(client);
            (client as any).factory.getAllPairs = jest.fn().mockResolvedValue([]);

            await expect(module.verifyPairAddress('')).rejects.toThrow();
            await expect(module.verifyPairAddress('   ')).rejects.toThrow();
        });
    });
});
