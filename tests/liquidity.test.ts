import { LiquidityModule } from '../src/modules/liquidity';
import { CoralSwapClient } from '../src/client';
import { PRECISION } from '../src/config';
import { ValidationError, TransactionError } from '../src/errors';
import { Network } from '../src/types/common';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockClient(opts: {
  reserve0?: bigint;
  reserve1?: bigint;
  token0?: string;
  token1?: string;
  pairAddress?: string;
  totalSupply?: bigint;
  balance?: bigint;
  getPairResult?: string | null;
  submitSuccess?: boolean;
} = {}): CoralSwapClient {
  const pairAddress = opts.pairAddress ?? 'PAIR_ADDRESS';
  const getPairResult = opts.getPairResult !== undefined ? opts.getPairResult : pairAddress;
  const mockPair = {
    getReserves: jest.fn().mockResolvedValue({
      reserve0: opts.reserve0 ?? 1_000_000n,
      reserve1: opts.reserve1 ?? 1_000_000n,
    }),
    getTokens: jest.fn().mockResolvedValue({
      token0: opts.token0 ?? 'TOKEN_A',
      token1: opts.token1 ?? 'TOKEN_B',
    }),
  };

  const mockLPToken = {
    totalSupply: jest.fn().mockResolvedValue(opts.totalSupply ?? 1_000_000n),
    balance: jest.fn().mockResolvedValue(opts.balance ?? 100_000n),
  };

  const mockRouter = {
    buildAddLiquidity: jest.fn().mockReturnValue({}),
    buildRemoveLiquidity: jest.fn().mockReturnValue({}),
  };

  const mockFactory = {
    getPair: jest.fn().mockResolvedValue(opts.getPairResult ?? pairAddress),
    getAllPairs: jest.fn().mockResolvedValue([pairAddress]),
  };

  return {
    network: Network.TESTNET,
    getPairAddress: jest.fn().mockResolvedValue(getPairResult),
    pair: jest.fn().mockReturnValue(mockPair),
    lpToken: jest.fn().mockReturnValue(mockLPToken),
    router: mockRouter,
    factory: mockFactory,
    getDeadline: jest.fn().mockReturnValue(1234567890),
    submitTransaction: jest.fn().mockResolvedValue({
      success: opts.submitSuccess ?? true,
      txHash: '0xabc123',
      data: { ledger: 100 },
    }),
  } as unknown as CoralSwapClient;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LiquidityModule', () => {
  const TOKEN_A = 'GDLL5G53N6YD5BBGRFCW6WSZ3BHIQ3L7FO4RBYER3IH7NCCMU7GCAXC6';
  const TOKEN_B = 'GBPJWOMRQSBSC2Q42IXL42FBVEKACCP4PXFN7FULA3O3KBJZ4UGYBLJW';
  const USER = 'GBAQBA53DB3OJK72UAAOD5HJO6QOMUEKV5WMS22DKPGXRY2QIIKGZWOD';

  describe('getAddLiquidityQuote()', () => {
    it('uses sqrt formula for first deposit (no pair exists)', async () => {
      const client = createMockClient({ getPairResult: null });
      const liquidity = new LiquidityModule(client);
      const amountADesired = 2_500_000n;

      const quote = await liquidity.getAddLiquidityQuote(TOKEN_A, TOKEN_B, amountADesired);

      // For first deposit, it defaults to amountA = amountB and sqrt(A*A) - MIN_LIQUIDITY
      expect(quote.amountA).toBe(amountADesired);
      expect(quote.amountB).toBe(amountADesired);
      expect(quote.estimatedLPTokens).toBe(amountADesired - PRECISION.MIN_LIQUIDITY);
      expect(quote.shareOfPool).toBe(1.0);
    });

    it('uses proportional formula for subsequent deposits', async () => {
      const reserveA = 100_000n;
      const reserveB = 200_000n;
      const totalSupply = 150_000n;
      const client = createMockClient({
        reserve0: reserveA,
        reserve1: reserveB,
        token0: TOKEN_A,
        token1: TOKEN_B,
        totalSupply: totalSupply
      });
      const liquidity = new LiquidityModule(client);
      const amountADesired = 10_000n;

      const quote = await liquidity.getAddLiquidityQuote(TOKEN_A, TOKEN_B, amountADesired);

      // amountBOptimal = (amountADesired * reserveB) / reserveA = (10000 * 200000) / 100000 = 20000
      expect(quote.amountB).toBe(20000n);
      // estimatedLP = (amountADesired * totalSupply) / reserveA = (10000 * 150000) / 100000 = 15000
      expect(quote.estimatedLPTokens).toBe(15000n);
      // shareOfPool = estimatedLP / (totalSupply + estimatedLP) = 15000 / (150000 + 15000) = 15000 / 165000 ≈ 0.0909
      expect(quote.shareOfPool).toBeCloseTo(0.0909, 4);
    });

    it('calculates correct prices in quote', async () => {
      const reserveA = 100_000n;
      const reserveB = 50_000n;
      const client = createMockClient({
        reserve0: reserveA,
        reserve1: reserveB,
        token0: TOKEN_A,
        token1: TOKEN_B,
        totalSupply: 1000n
      });
      const liquidity = new LiquidityModule(client);

      const quote = await liquidity.getAddLiquidityQuote(TOKEN_A, TOKEN_B, 1000n);

      // priceAPerB = (reserveB * SCALE) / reserveA = (50000 * SCALE) / 100000 = 0.5 * SCALE
      expect(quote.priceAPerB).toBe(PRECISION.PRICE_SCALE / 2n);
      // priceBPerA = (reserveA * SCALE) / reserveB = (100000 * SCALE) / 50000 = 2 * SCALE
      expect(quote.priceBPerA).toBe(PRECISION.PRICE_SCALE * 2n);
    });
  });

  describe('addLiquidity()', () => {
    it('submits a transaction via router', async () => {
      const client = createMockClient();
      const liquidity = new LiquidityModule(client);
      const request = {
        tokenA: TOKEN_A,
        tokenB: TOKEN_B,
        amountADesired: 1000n,
        amountBDesired: 1000n,
        amountAMin: 900n,
        amountBMin: 900n,
        to: USER,
      };

      const result = await liquidity.addLiquidity(request);

      expect(client.router.buildAddLiquidity).toHaveBeenCalled();
      expect(client.submitTransaction).toHaveBeenCalled();
      expect(result.txHash).toBe('0xabc123');
    });

    it('throws ValidationError if amountAMin > amountADesired', async () => {
      const client = createMockClient();
      const liquidity = new LiquidityModule(client);
      const request = {
        tokenA: TOKEN_A,
        tokenB: TOKEN_B,
        amountADesired: 1000n,
        amountBDesired: 1000n,
        amountAMin: 1100n,
        amountBMin: 900n,
        to: USER,
      };

      await expect(liquidity.addLiquidity(request)).rejects.toThrow(ValidationError);
    });

    it('throws TransactionError if submission fails', async () => {
      const client = createMockClient({ submitSuccess: false });
      const liquidity = new LiquidityModule(client);
      const request = {
        tokenA: TOKEN_A,
        tokenB: TOKEN_B,
        amountADesired: 1000n,
        amountBDesired: 1000n,
        amountAMin: 900n,
        amountBMin: 900n,
        to: USER,
      };

      await expect(liquidity.addLiquidity(request)).rejects.toThrow(TransactionError);
    });
  });

  describe('removeLiquidity()', () => {
    it('submits a removal transaction via router', async () => {
      const client = createMockClient();
      const liquidity = new LiquidityModule(client);
      const request = {
        tokenA: TOKEN_A,
        tokenB: TOKEN_B,
        liquidity: 500n,
        amountAMin: 400n,
        amountBMin: 400n,
        to: USER,
      };

      const result = await liquidity.removeLiquidity(request);

      expect(client.router.buildRemoveLiquidity).toHaveBeenCalledWith(
        USER,
        TOKEN_A,
        TOKEN_B,
        500n,
        400n,
        400n,
        expect.any(Number)
      );
      expect(result.liquidity).toBe(500n);
    });
  });

  describe('getPosition()', () => {
    it('calculates share and underlying amounts correctly', async () => {
      const reserve0 = 1_000_000n;
      const reserve1 = 2_000_000n;
      const totalSupply = 1_000_000n;
      const balance = 100_000n; // 10% share
      const client = createMockClient({
        reserve0,
        reserve1,
        totalSupply,
        balance,
      });
      const liquidity = new LiquidityModule(client);

      const position = await liquidity.getPosition('PAIR_ADDR', USER);

      expect(position.balance).toBe(balance);
      expect(position.share).toBe(0.1);
      // token0Amount = (reserve0 * balance) / totalSupply = (1000000 * 100000) / 1000000 = 100000
      expect(position.token0Amount).toBe(100_000n);
      // token1Amount = (reserve1 * balance) / totalSupply = (2000000 * 100000) / 1000000 = 200000
      expect(position.token1Amount).toBe(200_000n);
    });

    it('returns zero share if total supply is zero', async () => {
      const client = createMockClient({
        totalSupply: 0n,
        balance: 0n,
      });
      const liquidity = new LiquidityModule(client);

      const position = await liquidity.getPosition('PAIR_ADDR', USER);

      expect(position.share).toBe(0);
      expect(position.token0Amount).toBe(0n);
    });
  });
});
