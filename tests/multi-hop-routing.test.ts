import { SwapModule } from '../src/modules/swap';
import { TradeType } from '../src/types/common';
import { MultiHopSwapQuote } from '../src/types/swap';
import {
  PairNotFoundError,
  InsufficientLiquidityError,
  ValidationError,
} from '../src/errors';

// ---------------------------------------------------------------------------
// Mock helpers (same pattern as existing multi-hop-swap.test.ts)
// ---------------------------------------------------------------------------

function mockPair(
  reserve0: bigint,
  reserve1: bigint,
  feeBps: number,
  token0: string,
  token1: string,
) {
  return {
    getReserves: jest.fn().mockResolvedValue({ reserve0, reserve1 }),
    getDynamicFee: jest.fn().mockResolvedValue(feeBps),
    getTokens: jest.fn().mockResolvedValue({ token0, token1 }),
  };
}

function buildMockClient(
  pairMap: Record<
    string,
    { reserve0: bigint; reserve1: bigint; feeBps: number; token0: string; token1: string }
  >,
) {
  const pairInstances: Record<string, ReturnType<typeof mockPair>> = {};
  for (const [key, cfg] of Object.entries(pairMap)) {
    pairInstances[key] = mockPair(cfg.reserve0, cfg.reserve1, cfg.feeBps, cfg.token0, cfg.token1);
  }

  function lookupKey(a: string, b: string): string | null {
    if (`${a}|${b}` in pairMap) return `${a}|${b}`;
    if (`${b}|${a}` in pairMap) return `${b}|${a}`;
    return null;
  }

  return {
    config: { defaultSlippageBps: 50 },
    getDeadline: jest.fn().mockReturnValue(9999999999),
    getPairAddress: jest.fn().mockImplementation(async (tokenA: string, tokenB: string) => {
      return lookupKey(tokenA, tokenB);
    }),
    pair: jest.fn().mockImplementation((addr: string) => {
      const instance = pairInstances[addr];
      if (!instance) throw new Error(`No mock pair for address ${addr}`);
      return instance;
    }),
    router: {
      buildSwapExactIn: jest.fn().mockReturnValue('op_exact_in'),
      buildSwapExactOut: jest.fn().mockReturnValue('op_exact_out'),
      buildSwapExactTokensForTokens: jest.fn().mockReturnValue('op_multi_hop'),
    },
    publicKey: 'GTEST_SENDER',
    submitTransaction: jest.fn().mockResolvedValue({
      success: true,
      txHash: 'MOCK_TX_HASH',
      data: { txHash: 'MOCK_TX_HASH', ledger: 1000 },
    }),
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TOKEN_A = 'GAAA';
const TOKEN_B = 'GBBB';
const TOKEN_C = 'GCCC';
const TOKEN_D = 'GDDD';

const RESERVE = 1_000_000_000n;
const FEE = 30;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Multi-hop routing (dedicated methods)', () => {
  // -----------------------------------------------------------------------
  // getMultiHopQuote
  // -----------------------------------------------------------------------

  describe('getMultiHopQuote', () => {
    let swap: SwapModule;

    beforeEach(() => {
      const client = buildMockClient({
        [`${TOKEN_A}|${TOKEN_B}`]: { reserve0: RESERVE, reserve1: RESERVE, feeBps: FEE, token0: TOKEN_A, token1: TOKEN_B },
        [`${TOKEN_B}|${TOKEN_C}`]: { reserve0: RESERVE, reserve1: RESERVE, feeBps: FEE, token0: TOKEN_B, token1: TOKEN_C },
        [`${TOKEN_C}|${TOKEN_D}`]: { reserve0: RESERVE, reserve1: RESERVE, feeBps: FEE, token0: TOKEN_C, token1: TOKEN_D },
      });
      swap = new SwapModule(client as any);
    });

    it('returns a MultiHopSwapQuote with per-hop breakdown for 2-hop path', async () => {
      const quote = await swap.getMultiHopQuote({
        path: [TOKEN_A, TOKEN_B, TOKEN_C],
        amount: 1_000_000n,
        tradeType: TradeType.EXACT_IN,
      });

      expect(quote.hops).toHaveLength(2);
      expect(quote.hops[0].tokenIn).toBe(TOKEN_A);
      expect(quote.hops[0].tokenOut).toBe(TOKEN_B);
      expect(quote.hops[1].tokenIn).toBe(TOKEN_B);
      expect(quote.hops[1].tokenOut).toBe(TOKEN_C);
    });

    it('returns correct output for a 3-hop path', async () => {
      const amountIn = 500_000n;
      const quote = await swap.getMultiHopQuote({
        path: [TOKEN_A, TOKEN_B, TOKEN_C, TOKEN_D],
        amount: amountIn,
        tradeType: TradeType.EXACT_IN,
      });

      expect(quote.hops).toHaveLength(3);

      // Verify chaining: each hop amountIn === previous hop amountOut
      expect(quote.hops[0].amountIn).toBe(amountIn);
      expect(quote.hops[1].amountIn).toBe(quote.hops[0].amountOut);
      expect(quote.hops[2].amountIn).toBe(quote.hops[1].amountOut);

      // Final amountOut matches quote
      expect(quote.amountOut).toBe(quote.hops[2].amountOut);
    });

    it('includes per-hop fee breakdown', async () => {
      const quote = await swap.getMultiHopQuote({
        path: [TOKEN_A, TOKEN_B, TOKEN_C],
        amount: 1_000_000n,
        tradeType: TradeType.EXACT_IN,
      });

      for (const hop of quote.hops) {
        expect(hop.feeBps).toBe(FEE);
        const expectedFee = (hop.amountIn * BigInt(hop.feeBps)) / 10000n;
        expect(hop.feeAmount).toBe(expectedFee);
      }

      // Total fee is sum of per-hop fees
      const totalFee = quote.hops.reduce((acc, h) => acc + h.feeAmount, 0n);
      expect(quote.feeAmount).toBe(totalFee);
    });

    it('calculates compound price impact correctly', async () => {
      const quote = await swap.getMultiHopQuote({
        path: [TOKEN_A, TOKEN_B, TOKEN_C],
        amount: 1_000_000n,
        tradeType: TradeType.EXACT_IN,
      });

      const expected = swap.compoundPriceImpact(
        quote.hops.map((h) => h.priceImpactBps),
      );
      expect(quote.priceImpactBps).toBe(expected);
    });

    it('tokenIn/tokenOut match path endpoints', async () => {
      const quote = await swap.getMultiHopQuote({
        path: [TOKEN_A, TOKEN_B, TOKEN_C],
        amount: 1_000_000n,
        tradeType: TradeType.EXACT_IN,
      });

      expect(quote.tokenIn).toBe(TOKEN_A);
      expect(quote.tokenOut).toBe(TOKEN_C);
      expect(quote.path).toEqual([TOKEN_A, TOKEN_B, TOKEN_C]);
    });

    it('respects custom slippage tolerance', async () => {
      const slippageBps = 200; // 2%
      const quote = await swap.getMultiHopQuote({
        path: [TOKEN_A, TOKEN_B, TOKEN_C],
        amount: 1_000_000n,
        tradeType: TradeType.EXACT_IN,
        slippageBps,
      });

      const expectedMin = quote.amountOut - (quote.amountOut * BigInt(slippageBps)) / 10000n;
      expect(quote.amountOutMin).toBe(expectedMin);
    });

    it('throws ValidationError for path with fewer than 3 tokens', async () => {
      await expect(
        swap.getMultiHopQuote({
          path: [TOKEN_A, TOKEN_B],
          amount: 1_000_000n,
          tradeType: TradeType.EXACT_IN,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('throws ValidationError for EXACT_OUT trade type', async () => {
      await expect(
        swap.getMultiHopQuote({
          path: [TOKEN_A, TOKEN_B, TOKEN_C],
          amount: 1_000_000n,
          tradeType: TradeType.EXACT_OUT,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('throws PairNotFoundError if any intermediate pair is missing', async () => {
      await expect(
        swap.getMultiHopQuote({
          path: [TOKEN_A, TOKEN_B, 'GXXX'],
          amount: 1_000_000n,
          tradeType: TradeType.EXACT_IN,
        }),
      ).rejects.toBeInstanceOf(PairNotFoundError);
    });

    it('throws InsufficientLiquidityError for zero-reserve pair', async () => {
      const client = buildMockClient({
        [`${TOKEN_A}|${TOKEN_B}`]: { reserve0: RESERVE, reserve1: RESERVE, feeBps: FEE, token0: TOKEN_A, token1: TOKEN_B },
        [`${TOKEN_B}|${TOKEN_C}`]: { reserve0: 0n, reserve1: RESERVE, feeBps: FEE, token0: TOKEN_B, token1: TOKEN_C },
      });
      const s = new SwapModule(client as any);

      await expect(
        s.getMultiHopQuote({
          path: [TOKEN_A, TOKEN_B, TOKEN_C],
          amount: 1_000_000n,
          tradeType: TradeType.EXACT_IN,
        }),
      ).rejects.toBeInstanceOf(InsufficientLiquidityError);
    });
  });

  // -----------------------------------------------------------------------
  // executeMultiHop
  // -----------------------------------------------------------------------

  describe('executeMultiHop', () => {
    it('builds a single router transaction with full path', async () => {
      const client = buildMockClient({
        [`${TOKEN_A}|${TOKEN_B}`]: { reserve0: RESERVE, reserve1: RESERVE, feeBps: FEE, token0: TOKEN_A, token1: TOKEN_B },
        [`${TOKEN_B}|${TOKEN_C}`]: { reserve0: RESERVE, reserve1: RESERVE, feeBps: FEE, token0: TOKEN_B, token1: TOKEN_C },
      });
      const swap = new SwapModule(client as any);

      await swap.executeMultiHop({
        path: [TOKEN_A, TOKEN_B, TOKEN_C],
        amount: 1_000_000n,
        tradeType: TradeType.EXACT_IN,
      });

      expect(client.router.buildSwapExactTokensForTokens).toHaveBeenCalledTimes(1);
      const [, calledPath] = (client.router.buildSwapExactTokensForTokens as jest.Mock).mock.calls[0];
      expect(calledPath).toEqual([TOKEN_A, TOKEN_B, TOKEN_C]);
    });

    it('returns SwapResult with correct fields', async () => {
      const client = buildMockClient({
        [`${TOKEN_A}|${TOKEN_B}`]: { reserve0: RESERVE, reserve1: RESERVE, feeBps: FEE, token0: TOKEN_A, token1: TOKEN_B },
        [`${TOKEN_B}|${TOKEN_C}`]: { reserve0: RESERVE, reserve1: RESERVE, feeBps: FEE, token0: TOKEN_B, token1: TOKEN_C },
      });
      const swap = new SwapModule(client as any);

      const result = await swap.executeMultiHop({
        path: [TOKEN_A, TOKEN_B, TOKEN_C],
        amount: 1_000_000n,
        tradeType: TradeType.EXACT_IN,
      });

      expect(result.txHash).toBe('MOCK_TX_HASH');
      expect(result.amountIn).toBeGreaterThan(0n);
      expect(result.amountOut).toBeGreaterThan(0n);
      expect(result.feePaid).toBeGreaterThan(0n);
      expect(result.ledger).toBe(1000);
    });

    it('throws TransactionError on submission failure', async () => {
      const client = buildMockClient({
        [`${TOKEN_A}|${TOKEN_B}`]: { reserve0: RESERVE, reserve1: RESERVE, feeBps: FEE, token0: TOKEN_A, token1: TOKEN_B },
        [`${TOKEN_B}|${TOKEN_C}`]: { reserve0: RESERVE, reserve1: RESERVE, feeBps: FEE, token0: TOKEN_B, token1: TOKEN_C },
      });
      client.submitTransaction = jest.fn().mockResolvedValue({
        success: false,
        error: { code: 'TX_FAILED', message: 'Simulation failed' },
        txHash: 'FAIL_HASH',
      });

      const swap = new SwapModule(client as any);

      await expect(
        swap.executeMultiHop({
          path: [TOKEN_A, TOKEN_B, TOKEN_C],
          amount: 1_000_000n,
          tradeType: TradeType.EXACT_IN,
        }),
      ).rejects.toThrow('Multi-hop swap failed');
    });

    it('uses custom recipient when to is provided', async () => {
      const client = buildMockClient({
        [`${TOKEN_A}|${TOKEN_B}`]: { reserve0: RESERVE, reserve1: RESERVE, feeBps: FEE, token0: TOKEN_A, token1: TOKEN_B },
        [`${TOKEN_B}|${TOKEN_C}`]: { reserve0: RESERVE, reserve1: RESERVE, feeBps: FEE, token0: TOKEN_B, token1: TOKEN_C },
      });
      const swap = new SwapModule(client as any);

      await swap.executeMultiHop({
        path: [TOKEN_A, TOKEN_B, TOKEN_C],
        amount: 1_000_000n,
        tradeType: TradeType.EXACT_IN,
        to: 'GRECIPIENT',
      });

      const [calledSender] = (client.router.buildSwapExactTokensForTokens as jest.Mock).mock.calls[0];
      expect(calledSender).toBe('GRECIPIENT');
    });
  });
});
