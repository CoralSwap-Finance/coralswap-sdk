import { LiquidityModule } from '../src/modules/liquidity';
import { CoralSwapClient } from '../src/client';
import { PairClient } from '../src/contracts/pair';
import { LPTokenClient } from '../src/contracts/lp-token'; // assume it exists, or use whatever return type

jest.mock('../src/client');
jest.mock('../src/contracts/pair');

describe('LiquidityModule', () => {
    let module: LiquidityModule;
    let mockClient: jest.Mocked<CoralSwapClient>;
    let mockPairClient: jest.Mocked<PairClient>;
    let mockLPClient: any;

    beforeEach(() => {
        mockPairClient = {
            getReserves: jest.fn().mockResolvedValue({ reserve0: 1000n, reserve1: 2000n }),
            getTokens: jest.fn().mockResolvedValue({ token0: 'TOKEN_A', token1: 'TOKEN_B' }),
            getLPTokenAddress: jest.fn().mockResolvedValue('REAL_LP_TOKEN_ADDRESS'),
        } as any;

        mockLPClient = {
            balance: jest.fn().mockResolvedValue(500n),
            totalSupply: jest.fn().mockResolvedValue(10000n),
        };

        mockClient = {
            pair: jest.fn().mockReturnValue(mockPairClient),
            lpToken: jest.fn().mockReturnValue(mockLPClient),
        } as any;

        module = new LiquidityModule(mockClient);
    });

    describe('getPosition', () => {
        it('fetches LP token address from pair contract and correctly calculates position', async () => {
            const position = await module.getPosition('PAIR_ADDRESS', 'OWNER_ADDRESS');

            expect(mockPairClient.getLPTokenAddress).toHaveBeenCalledTimes(1);
            expect(mockClient.lpToken).toHaveBeenCalledWith('REAL_LP_TOKEN_ADDRESS');
            expect(position.lpTokenAddress).toBe('REAL_LP_TOKEN_ADDRESS');
            expect(position.balance).toBe(500n);
            expect(position.share).toBe(0.05); // 500 / 10000
        });

        it('caches the LP token address to avoid redundant calls', async () => {
            await module.getPosition('PAIR_ADDRESS', 'OWNER_ADDRESS');
            await module.getPosition('PAIR_ADDRESS', 'OTHER_OWNER');

            // Should only be called once due to caching
            expect(mockPairClient.getLPTokenAddress).toHaveBeenCalledTimes(1);
            expect(mockClient.lpToken).toHaveBeenCalledWith('REAL_LP_TOKEN_ADDRESS');
            expect(mockClient.lpToken).toHaveBeenCalledTimes(2);
        });
    });
});
