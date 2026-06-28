import { SwapModule } from '../src/modules/swap';
import { TradeType } from '../src/types/common';
import { PairNotFoundError, InsufficientLiquidityError, ValidationError } from '../src/errors';

/**
 * Unit tests for multi-hop swap routing in SwapModule.
 *
 * All tests operate on pure math or mock async client calls -- no live RPC.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal mock pair that returns preset reserves and fee. */
function mockPair(reserve0: bigint, reserve1: bigint, feeBps: number, token0: string, token1: string) {
  return {
    getReserves: jest.fn().mockResolvedValue({ reserve0, reserve1 }),
    getDynamicFee: jest.fn().mockResolvedValue(feeBps),
    getTokens: jest.fn().mockResolvedValue({ token0, token1 }),
  };
}

/**
 * Build a mock CoralSwapClient whose factory resolves pair addresses and
 * pair() returns a matching mock pair.
 *
 * pairMap: { "ADDR_A|ADDR_B": { reserve0, reserve1, feeBps } }
 */
function buildMockClient(
  pairMap: Record<string, { reserve0: bigint; reserve1: bigint; feeBps: number; token0: string; token1: string }>,
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
// Token / pair fixtures
// ---------------------------------------------------------------------------

const TOKEN_A = 'GAAA';
const TOKEN_B = 'GBBB';
const TOKEN_C = 'GCCC';

// Balanced pools with 30bps fee
const RESERVE = 1_000_000_000n;
const FEE = 30;

// ---------------------------------------------------------------------------
// Shared swap module under test
// ---------------------------------------------------------------------------

describe('Multi-hop swap routing', () => {
  let swap: SwapModule;

  // -------------------------------------------------------------------------
  // computeHops -- pure routing math (no execute)
  // -------------------------------------------------------------------------

  describe('computeHops', () => {
    beforeEach(() => {
      const client = buildMockClient({
        [`${TOKEN_A}|${TOKEN_B}`]: { reserve0: RESERVE, reserve1: RESERVE, feeBps: FEE, token0: TOKEN_A, token1: TOKEN_B },
        [`${TOKEN_B}|${TOKEN_C}`]: { reserve0: RESERVE, reserve1: RESERVE, feeBps: FEE, token0: TOKEN_B, token1: TOKEN_C },
      });
      swap = new SwapModule(client as any);
    });

    it('returns one HopResult per consecutive pair in a 2-hop path', async () => {
      const hops = await swap.computeHops(1_000_000n, [TOKEN_A, TOKEN_B, TOKEN_C]);
      expect(hops).toHaveLength(2);
    });

    it('first hop amountIn equals the original input', async () => {
      const amountIn = 1_000_000n;
      const hops = await swap.computeHops(amountIn, [TOKEN_A, TOKEN_B, TOKEN_C]);
      expect(hops[0].amountIn).toBe(amountIn);
    });

    it('second hop amountIn equals first hop amountOut (chaining)', async () => {
      const hops = await swap.computeHops(1_000_000n, [TOKEN_A, TOKEN_B, TOKEN_C]);
      expect(hops[1].amountIn).toBe(hops[0].amountOut);
    });

    it('each hop amountOut is positive and less than amountIn (with 30bps fee)', async () => {
      const hops = await swap.computeHops(1_000_000n, [TOKEN_A, TOKEN_B, TOKEN_C]);
      for (const hop of hops) {
        expect(hop.amountOut).toBeGreaterThan(0n);
        expect(hop.amountOut).toBeLessThan(hop.amountIn);
      }
    });

    it('each hop feeAmount equals (amountIn * feeBps / 10000)', async () => {
      const hops = await swap.computeHops(1_000_000n, [TOKEN_A, TOKEN_B, TOKEN_C]);
      for (const hop of hops) {
        const expectedFee = (hop.amountIn * BigInt(hop.feeBps)) / 10000n;
        expect(hop.feeAmount).toBe(expectedFee);
      }
    });

    it('3-hop path returns two intermediate amounts correctly chained', async () => {
      // A->B->C for a balanced pool -- verify sequential getAmountOut
      const amountIn = 500_000n;
      const hops = await swap.computeHops(amountIn, [TOKEN_A, TOKEN_B, TOKEN_C]);

      // Manually calculate expected values using the same formula
      const expectedOut1 = swap.getAmountOut(amountIn, RESERVE, RESERVE, FEE);
      const expectedOut2 = swap.getAmountOut(expectedOut1, RESERVE, RESERVE, FEE);

      expect(hops[0].amountOut).toBe(expectedOut1);
      expect(hops[1].amountOut).toBe(expectedOut2);
    });

    it('throws PairNotFoundError if a pair does not exist in the path', async () => {
      const TOKEN_D = 'GDDD';
      await expect(
        swap.computeHops(1_000_000n, [TOKEN_A, TOKEN_B, TOKEN_D]),
      ).rejects.toBeInstanceOf(PairNotFoundError);
    });
  });

  // -------------------------------------------------------------------------
  // getQuote -- multi-hop
  // -------------------------------------------------------------------------

  describe('getQuote (multi-hop)', () => {
    beforeEach(() => {
      const client = buildMockClient({
        [`${TOKEN_A}|${TOKEN_B}`]: { reserve0: RESERVE, reserve1: RESERVE, feeBps: FEE, token0: TOKEN_A, token1: TOKEN_B },
        [`${TOKEN_B}|${TOKEN_C}`]: { reserve0: RESERVE, reserve1: RESERVE, feeBps: FEE, token0: TOKEN_B, token1: TOKEN_C },
      });
      swap = new SwapModule(client as any);
    });

    it('returns a SwapQuote with the full path attached', async () => {
      const path = [TOKEN_A, TOKEN_B, TOKEN_C];
      const quote = await swap.getQuote({
        tokenIn: TOKEN_A,
        tokenOut: TOKEN_C,
        amount: 1_000_000n,
        tradeType: TradeType.EXACT_IN,
        path,
      });
      expect(quote.path).toEqual(path);
    });

    it('quote.tokenIn / tokenOut match the path endpoints', async () => {
      const quote = await swap.getQuote({
        tokenIn: TOKEN_A,
        tokenOut: TOKEN_C,
        amount: 1_000_000n,
        tradeType: TradeType.EXACT_IN,
        path: [TOKEN_A, TOKEN_B, TOKEN_C],
      });
      expect(quote.tokenIn).toBe(TOKEN_A);
      expect(quote.tokenOut).toBe(TOKEN_C);
    });

    it('quote.amountOut matches the final hop output', async () => {
      const amountIn = 1_000_000n;
      const quote = await swap.getQuote({
        tokenIn: TOKEN_A,
        tokenOut: TOKEN_C,
        amount: amountIn,
        tradeType: TradeType.EXACT_IN,
        path: [TOKEN_A, TOKEN_B, TOKEN_C],
      });

      const expectedOut1 = swap.getAmountOut(amountIn, RESERVE, RESERVE, FEE);
      const expectedOut2 = swap.getAmountOut(expectedOut1, RESERVE, RESERVE, FEE);
      expect(quote.amountOut).toBe(expectedOut2);
    });

    it('quote.feeAmount equals the sum of per-hop fees', async () => {
      const amountIn = 1_000_000n;
      const quote = await swap.getQuote({
        tokenIn: TOKEN_A,
        tokenOut: TOKEN_C,
        amount: amountIn,
        tradeType: TradeType.EXACT_IN,
        path: [TOKEN_A, TOKEN_B, TOKEN_C],
      });

      const hop1Out = swap.getAmountOut(amountIn, RESERVE, RESERVE, FEE);
      const fee1 = (amountIn * BigInt(FEE)) / 10000n;
      const fee2 = (hop1Out * BigInt(FEE)) / 10000n;
      expect(quote.feeAmount).toBe(fee1 + fee2);
    });

    it('quote.feeBps equals the sum of per-hop fee rates', async () => {
      const quote = await swap.getQuote({
        tokenIn: TOKEN_A,
        tokenOut: TOKEN_C,
        amount: 1_000_000n,
        tradeType: TradeType.EXACT_IN,
        path: [TOKEN_A, TOKEN_B, TOKEN_C],
      });
      expect(quote.feeBps).toBe(FEE + FEE);
    });

    it('amountOutMin respects the slippage tolerance', async () => {
      const slippageBps = 100; // 1%
      const quote = await swap.getQuote({
        tokenIn: TOKEN_A,
        tokenOut: TOKEN_C,
        amount: 1_000_000n,
        tradeType: TradeType.EXACT_IN,
        path: [TOKEN_A, TOKEN_B, TOKEN_C],
        slippageBps,
      });
      const expectedMin = quote.amountOut - (quote.amountOut * 100n) / 10000n;
      expect(quote.amountOutMin).toBe(expectedMin);
    });

    it('throws PairNotFoundError when a pair in the path does not exist', async () => {
      await expect(
        swap.getQuote({
          tokenIn: TOKEN_A,
          tokenOut: 'GDDD',
          amount: 1_000_000n,
          tradeType: TradeType.EXACT_IN,
          path: [TOKEN_A, TOKEN_B, 'GDDD'],
        }),
      ).rejects.toBeInstanceOf(PairNotFoundError);
    });

    it('throws ValidationError for EXACT_OUT multi-hop (not supported)', async () => {
      await expect(
        swap.getQuote({
          tokenIn: TOKEN_A,
          tokenOut: TOKEN_C,
          amount: 1_000_000n,
          tradeType: TradeType.EXACT_OUT,
          path: [TOKEN_A, TOKEN_B, TOKEN_C],
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  // -------------------------------------------------------------------------
  // getQuote -- direct (path with 2 tokens, or no path)
  // -------------------------------------------------------------------------

  describe('getQuote (direct, path=[A,B])', () => {
    beforeEach(() => {
      const client = buildMockClient({
        [`${TOKEN_A}|${TOKEN_B}`]: { reserve0: RESERVE, reserve1: RESERVE, feeBps: FEE, token0: TOKEN_A, token1: TOKEN_B },
      });
      swap = new SwapModule(client as any);
    });

    it('explicit 2-token path falls back to direct swap', async () => {
      const quote = await swap.getQuote({
        tokenIn: TOKEN_A,
        tokenOut: TOKEN_B,
        amount: 1_000_000n,
        tradeType: TradeType.EXACT_IN,
        path: [TOKEN_A, TOKEN_B],
      });
      expect(quote.path).toEqual([TOKEN_A, TOKEN_B]);
      expect(quote.amountOut).toBe(swap.getAmountOut(1_000_000n, RESERVE, RESERVE, FEE));
    });

    it('omitting path also falls back to direct swap', async () => {
      const quote = await swap.getQuote({
        tokenIn: TOKEN_A,
        tokenOut: TOKEN_B,
        amount: 1_000_000n,
        tradeType: TradeType.EXACT_IN,
      });
      expect(quote.path).toEqual([TOKEN_A, TOKEN_B]);
    });
  });

  // -------------------------------------------------------------------------
  // compoundPriceImpact -- pure math
  // -------------------------------------------------------------------------

  describe('compoundPriceImpact', () => {
    let swapPure: SwapModule;

    beforeEach(() => {
      swapPure = new SwapModule(null as any);
    });

    it('single hop impact equals input impact', () => {
      expect(swapPure.compoundPriceImpact([100])).toBe(100);
    });

    it('two 0bps hops give 0bps total impact', () => {
      expect(swapPure.compoundPriceImpact([0, 0])).toBe(0);
    });

    it('compound of two equal impacts is greater than either alone', () => {
      const impact = 200; // 2%
      const compound = swapPure.compoundPriceImpact([impact, impact]);
      // 1 - (0.98 * 0.98) = 0.0396 => ~396 bps
      expect(compound).toBeGreaterThan(impact);
    });

    it('matches formula: 1 - product(1 - bps/10000) * 10000', () => {
      const impacts = [150, 200, 300];
      const expected = Math.round((1 - impacts.reduce((p, i) => p * (1 - i / 10000), 1)) * 10000);
      expect(swapPure.compoundPriceImpact(impacts)).toBe(expected);
    });

    it('two 10000bps impacts (full impact each) gives 10000bps total', () => {
      expect(swapPure.compoundPriceImpact([10000, 10000])).toBe(10000);
    });
  });

  // -------------------------------------------------------------------------
  // execute -- router op selection
  // -------------------------------------------------------------------------

  describe('execute', () => {
    it('calls buildSwapExactTokensForTokens for multi-hop', async () => {
      const client = buildMockClient({
        [`${TOKEN_A}|${TOKEN_B}`]: { reserve0: RESERVE, reserve1: RESERVE, feeBps: FEE, token0: TOKEN_A, token1: TOKEN_B },
        [`${TOKEN_B}|${TOKEN_C}`]: { reserve0: RESERVE, reserve1: RESERVE, feeBps: FEE, token0: TOKEN_B, token1: TOKEN_C },
      });
      swap = new SwapModule(client as any);

      await swap.execute({
        tokenIn: TOKEN_A,
        tokenOut: TOKEN_C,
        amount: 1_000_000n,
        tradeType: TradeType.EXACT_IN,
        path: [TOKEN_A, TOKEN_B, TOKEN_C],
      });

      expect(client.router.buildSwapExactTokensForTokens).toHaveBeenCalledTimes(1);
      expect(client.router.buildSwapExactIn).not.toHaveBeenCalled();
    });

    it('passes the full path to buildSwapExactTokensForTokens', async () => {
      const path = [TOKEN_A, TOKEN_B, TOKEN_C];
      const client = buildMockClient({
        [`${TOKEN_A}|${TOKEN_B}`]: { reserve0: RESERVE, reserve1: RESERVE, feeBps: FEE, token0: TOKEN_A, token1: TOKEN_B },
        [`${TOKEN_B}|${TOKEN_C}`]: { reserve0: RESERVE, reserve1: RESERVE, feeBps: FEE, token0: TOKEN_B, token1: TOKEN_C },
      });
      swap = new SwapModule(client as any);

      await swap.execute({
        tokenIn: TOKEN_A,
        tokenOut: TOKEN_C,
        amount: 1_000_000n,
        tradeType: TradeType.EXACT_IN,
        path,
      });

      const [, calledPath] = (client.router.buildSwapExactTokensForTokens as jest.Mock).mock.calls[0];
      expect(calledPath).toEqual(path);
    });

    it('calls buildSwapExactIn for a 2-token path (direct)', async () => {
      const client = buildMockClient({
        [`${TOKEN_A}|${TOKEN_B}`]: { reserve0: RESERVE, reserve1: RESERVE, feeBps: FEE, token0: TOKEN_A, token1: TOKEN_B },
      });
      swap = new SwapModule(client as any);

      await swap.execute({
        tokenIn: TOKEN_A,
        tokenOut: TOKEN_B,
        amount: 1_000_000n,
        tradeType: TradeType.EXACT_IN,
      });

      expect(client.router.buildSwapExactIn).toHaveBeenCalledTimes(1);
      expect(client.router.buildSwapExactTokensForTokens).not.toHaveBeenCalled();
    });

    it('returns a SwapResult with correct txHash on success', async () => {
      const client = buildMockClient({
        [`${TOKEN_A}|${TOKEN_B}`]: { reserve0: RESERVE, reserve1: RESERVE, feeBps: FEE, token0: TOKEN_A, token1: TOKEN_B },
        [`${TOKEN_B}|${TOKEN_C}`]: { reserve0: RESERVE, reserve1: RESERVE, feeBps: FEE, token0: TOKEN_B, token1: TOKEN_C },
      });
      swap = new SwapModule(client as any);

      const result = await swap.execute({
        tokenIn: TOKEN_A,
        tokenOut: TOKEN_C,
        amount: 1_000_000n,
        tradeType: TradeType.EXACT_IN,
        path: [TOKEN_A, TOKEN_B, TOKEN_C],
      });

      expect(result.txHash).toBe('MOCK_TX_HASH');
      expect(result.amountIn).toBeGreaterThan(0n);
      expect(result.amountOut).toBeGreaterThan(0n);
    });
  });

  // -------------------------------------------------------------------------
  // Insufficient liquidity guard
  // -------------------------------------------------------------------------

  describe('InsufficientLiquidityError on zero reserves', () => {
    it('throws InsufficientLiquidityError when a pair has zero reserveIn', async () => {
      const client = buildMockClient({
        [`${TOKEN_A}|${TOKEN_B}`]: { reserve0: 0n, reserve1: RESERVE, feeBps: FEE, token0: TOKEN_A, token1: TOKEN_B },
        [`${TOKEN_B}|${TOKEN_C}`]: { reserve0: RESERVE, reserve1: RESERVE, feeBps: FEE, token0: TOKEN_B, token1: TOKEN_C },
      });
      swap = new SwapModule(client as any);

      await expect(
        swap.computeHops(1_000_000n, [TOKEN_A, TOKEN_B, TOKEN_C]),
      ).rejects.toBeInstanceOf(InsufficientLiquidityError);
    });

    it('throws InsufficientLiquidityError when a pair has zero reserveOut', async () => {
      const client = buildMockClient({
        [`${TOKEN_A}|${TOKEN_B}`]: { reserve0: RESERVE, reserve1: 0n, feeBps: FEE, token0: TOKEN_A, token1: TOKEN_B },
        [`${TOKEN_B}|${TOKEN_C}`]: { reserve0: RESERVE, reserve1: RESERVE, feeBps: FEE, token0: TOKEN_B, token1: TOKEN_C },
      });
      swap = new SwapModule(client as any);

      await expect(
        swap.computeHops(1_000_000n, [TOKEN_A, TOKEN_B, TOKEN_C]),
      ).rejects.toBeInstanceOf(InsufficientLiquidityError);
    });
  });
});
