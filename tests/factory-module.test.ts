import { CoralSwapClient } from '../src/client';
import { Network } from '../src/types/common';

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

describe('FactoryModule Caching', () => {
    const TOKEN_A = 'CAS3J7GYCCX7NVPYQ37DSVUTVD3YKH7TDRYQFYMCH5FDD3E2XCC7M326';
    const TOKEN_B = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
    const PAIR_ADDR = 'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K';

    let client: CoralSwapClient;

    beforeEach(() => {
        client = new CoralSwapClient({
            network: Network.TESTNET,
            secretKey: 'SB6K2AINTGNYBFX4M7TRPGSKQ5RKNOXXWB7UZUHRYOVTM7REDUGECKZU',
            // Provide a dummy factory address to avoid "Factory address not configured" error
            // using a valid-looking Soroban contract ID
            rpcUrl: 'https://soroban-testnet.stellar.org',
        });
        // Inject factoryAddress directly into networkConfig for testing
        (client as any).networkConfig.factoryAddress = 'CA3J7GYCCX7NVPYQ37DSVUTVD3YKH7TDRYQFYMCH5FDD3E2XCC7M326';
    });

    it('caches getPairAddress results', async () => {
        const mockGetPair = jest.fn().mockResolvedValue(PAIR_ADDR);
        (client as any).factory.getPair = mockGetPair;

        const module = client.factoryModule();

        // First call - should hit the contract
        const addr1 = await module.getPairAddress(TOKEN_A, TOKEN_B);
        expect(addr1).toBe(PAIR_ADDR);
        expect(mockGetPair).toHaveBeenCalledTimes(1);

        // Second call - should hit the cache
        const addr2 = await module.getPairAddress(TOKEN_A, TOKEN_B);
        expect(addr2).toBe(PAIR_ADDR);
        expect(mockGetPair).toHaveBeenCalledTimes(1);
    });

    it('bypasses cache when requested', async () => {
        const mockGetPair = jest.fn().mockResolvedValue(PAIR_ADDR);
        (client as any).factory.getPair = mockGetPair;

        const module = client.factoryModule();

        await module.getPairAddress(TOKEN_A, TOKEN_B);
        expect(mockGetPair).toHaveBeenCalledTimes(1);

        // Bypassing cache
        await module.getPairAddress(TOKEN_A, TOKEN_B, { bypassCache: true });
        expect(mockGetPair).toHaveBeenCalledTimes(2);
    });

    it('uses deterministic sorting for cache keys', async () => {
        const mockGetPair = jest.fn().mockResolvedValue(PAIR_ADDR);
        (client as any).factory.getPair = mockGetPair;

        const module = client.factoryModule();

        // Call with (A, B)
        await module.getPairAddress(TOKEN_A, TOKEN_B);
        expect(mockGetPair).toHaveBeenCalledTimes(1);

        // Call with (B, A) - should hit the same cache entry
        await module.getPairAddress(TOKEN_B, TOKEN_A);
        expect(mockGetPair).toHaveBeenCalledTimes(1);
    });

    it('supports pre-loading pairs', async () => {
        const mockGetPair = jest.fn();
        (client as any).factory.getPair = mockGetPair;

        const module = client.factoryModule();
        module.preLoadPairs([[TOKEN_A, TOKEN_B, PAIR_ADDR]]);

        const addr = await module.getPairAddress(TOKEN_A, TOKEN_B);
        expect(addr).toBe(PAIR_ADDR);
        expect(mockGetPair).not.toHaveBeenCalled();
    });

    it('clears cache on network switch', async () => {
        const mockGetPair = jest.fn().mockResolvedValue(PAIR_ADDR);
        (client as any).factory.getPair = mockGetPair;

        const module = client.factoryModule();
        await module.getPairAddress(TOKEN_A, TOKEN_B);
        expect(mockGetPair).toHaveBeenCalledTimes(1);

        // Switch network
        client.setNetwork(Network.MAINNET);

        // After switching, the factoryAddress might be empty in the new config.
        // Re-inject it for testing.
        (client as any).networkConfig.factoryAddress = 'CA3J7GYCCX7NVPYQ37DSVUTVD3YKH7TDRYQFYMCH5FDD3E2XCC7M326';

        // After switching, the private _factory is null, so accessing client.factory 
        // creates a new FactoryClient with different internal state.
        // We need to re-mock the new FactoryClient's getPair.
        (client as any).factory.getPair = mockGetPair;

        await module.getPairAddress(TOKEN_A, TOKEN_B);
        expect(mockGetPair).toHaveBeenCalledTimes(2);
    });
});
