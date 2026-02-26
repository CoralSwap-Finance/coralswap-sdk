import { CoralSwapClient } from '@/client';
import { PairClient } from '@/contracts/pair';
import { TradeType } from '@/types/common';
import {
  SwapRequest,
  SwapQuote,
  SwapResult,
  HopResult,
  MultiHopSwapRequest,
  MultiHopSwapQuote,
} from '@/types/swap';
import { PRECISION, DEFAULTS } from '@/config';
import {
  TransactionError,
  ValidationError,
  InsufficientLiquidityError,
  PairNotFoundError,
} from '../errors';
import {
  validateAddress,
  validatePositiveAmount,
  validateSlippage,
  validateDistinctTokens,
} from '@/utils/validation';

/**
 * Swap module -- builds, quotes, and executes token swaps.
 *
 * Directly interacts with CoralSwap Router and Pair contracts on Soroban.
 * Supports exact-in and exact-out trades with dynamic fee awareness,
 * slippage protection, and deadline enforcement.
 *
 * Multi-hop routing: pass an optional `path` array (3+ tokens) in SwapRequest
 * to route through intermediate pairs (A -> B -> C).
 */
export class SwapModule {
  private client: CoralSwapClient;

  constructor(client: CoralSwapClient) {
    this.client = client;
  }

  /**
   * Get an estimated swap quote without executing.
   *
   * If `request.path` is provided with 3+ tokens, calculates a multi-hop
   * quote by chaining getAmountOut across each hop.
   * Falls back to direct swap for a 2-token path or no path.
   */
  async getQuote(request: SwapRequest): Promise<SwapQuote> {
    validatePositiveAmount(request.amount, 'amount');
    validateAddress(request.tokenIn, 'tokenIn');
    validateAddress(request.tokenOut, 'tokenOut');
    validateDistinctTokens(request.tokenIn, request.tokenOut);
    if (request.slippageBps !== undefined) validateSlippage(request.slippageBps);

    const path = this.resolvePath(request);

    if (path.length < 2) {
      throw new ValidationError("Swap path must contain at least 2 tokens", {
        path,
      });
    }

    if (path.length === 2) {
      return this.getDirectQuote(request, path);
    }

    return this.getMultiHopSwapQuote(request, path);
  }

  /**
   * Execute a swap transaction on-chain.
   *
   * For multi-hop paths, invokes the router's swap_exact_tokens_for_tokens
   * with the full path vector. For direct swaps, uses swap_exact_in /
   * swap_exact_out as before.
   */
  async execute(request: SwapRequest): Promise<SwapResult> {
    validatePositiveAmount(request.amount, 'amount');
    validateAddress(request.tokenIn, 'tokenIn');
    validateAddress(request.tokenOut, 'tokenOut');
    validateDistinctTokens(request.tokenIn, request.tokenOut);
    if (request.slippageBps !== undefined) validateSlippage(request.slippageBps);

    const path = this.resolvePath(request);
    const quote = await this.getQuote(request);

    let op: import("@stellar/stellar-sdk").xdr.Operation;

    if (path.length > 2) {
      // Multi-hop: router handles the full path
      op = this.client.router.buildSwapExactTokensForTokens(
        request.to ?? this.client.publicKey,
        path,
        quote.amountIn,
        quote.amountOutMin,
        quote.deadline,
      );
    } else {
      op =
        request.tradeType === TradeType.EXACT_IN
          ? this.client.router.buildSwapExactIn(
              request.to ?? this.client.publicKey,
              request.tokenIn,
              request.tokenOut,
              quote.amountIn,
              quote.amountOutMin,
              quote.deadline,
            )
          : this.client.router.buildSwapExactOut(
              request.to ?? this.client.publicKey,
              request.tokenIn,
              request.tokenOut,
              quote.amountOut,
              quote.amountIn,
              quote.deadline,
            );
    }

    const result = await this.client.submitTransaction([op]);

    if (!result.success) {
      throw new TransactionError(
        `Swap failed: ${result.error?.message ?? "Unknown error"}`,
        result.txHash,
      );
    }

    return {
      txHash: result.txHash!,
      amountIn: quote.amountIn,
      amountOut: quote.amountOut,
      feePaid: quote.feeAmount,
      ledger: result.data!.ledger,
      timestamp: Math.floor(Date.now() / 1000),
    };
  }

  /**
   * Get a multi-hop swap quote with per-hop breakdown.
   *
   * Accepts a `MultiHopSwapRequest` whose `path` must contain 3+ tokens.
   * Returns a `MultiHopSwapQuote` that includes the standard quote fields
   * plus an ordered `hops` array with the calculation result for each
   * consecutive pair.
   *
   * @param request - Multi-hop swap request with required path.
   * @returns Quote including per-hop fee, amount, and price impact breakdown.
   * @throws {ValidationError} If path has fewer than 3 tokens or trade type
   *   is not EXACT_IN.
   * @throws {PairNotFoundError} If any intermediate pair does not exist.
   */
  async getMultiHopQuote(request: MultiHopSwapRequest): Promise<MultiHopSwapQuote> {
    const { path } = request;

    if (path.length < 3) {
      throw new ValidationError(
        'Multi-hop path must contain at least 3 tokens',
        { path },
      );
    }

    if (request.tradeType !== TradeType.EXACT_IN) {
      throw new ValidationError(
        'Multi-hop routing only supports EXACT_IN trade type',
        { tradeType: request.tradeType },
      );
    }

    const hops = await this.computeHops(request.amount, path);

    const totalFeeAmount = hops.reduce((acc, h) => acc + h.feeAmount, 0n);
    const totalFeeBps = hops.reduce((acc, h) => acc + h.feeBps, 0);
    const compoundImpactBps = this.compoundPriceImpact(hops.map((h) => h.priceImpactBps));

    const amountIn = hops[0].amountIn;
    const amountOut = hops[hops.length - 1].amountOut;

    const slippageBps = request.slippageBps ?? this.client.config.defaultSlippageBps ?? DEFAULTS.slippageBps;
    const amountOutMin = amountOut - (amountOut * BigInt(slippageBps)) / PRECISION.BPS_DENOMINATOR;

    return {
      tokenIn: path[0],
      tokenOut: path[path.length - 1],
      amountIn,
      amountOut,
      amountOutMin,
      priceImpactBps: compoundImpactBps,
      feeBps: totalFeeBps,
      feeAmount: totalFeeAmount,
      path,
      deadline: request.deadline ?? this.client.getDeadline(),
      hops,
    };
  }

  /**
   * Execute a multi-hop swap as a single router transaction.
   *
   * Builds a `swap_exact_tokens_for_tokens` operation with the full path
   * and submits it in one transaction, minimising gas and latency.
   *
   * @param request - Multi-hop swap request with required path.
   * @returns Execution result with txHash, amounts, and ledger.
   * @throws {ValidationError} If path has fewer than 3 tokens.
   * @throws {PairNotFoundError} If any intermediate pair does not exist.
   * @throws {TransactionError} If the on-chain transaction fails.
   */
  async executeMultiHop(request: MultiHopSwapRequest): Promise<SwapResult> {
    const quote = await this.getMultiHopQuote(request);

    const op = this.client.router.buildSwapExactTokensForTokens(
      request.to ?? this.client.publicKey,
      request.path,
      quote.amountIn,
      quote.amountOutMin,
      quote.deadline,
    );

    const result = await this.client.submitTransaction([op]);

    if (!result.success) {
      throw new TransactionError(
        `Multi-hop swap failed: ${result.error?.message ?? 'Unknown error'}`,
        result.txHash,
      );
    }

    return {
      txHash: result.txHash!,
      amountIn: quote.amountIn,
      amountOut: quote.amountOut,
      feePaid: quote.feeAmount,
      ledger: result.data!.ledger,
      timestamp: Math.floor(Date.now() / 1000),
    };
  }

  /**
   * Calculate output amount for exact-in swap (Uniswap V2 formula with dynamic fee).
   */
  getAmountOut(
    amountIn: bigint,
    reserveIn: bigint,
    reserveOut: bigint,
    feeBps: number,
  ): bigint {
    if (amountIn <= 0n) {
      throw new ValidationError("Insufficient input amount", {
        amountIn: amountIn.toString(),
      });
    }
    if (reserveIn <= 0n || reserveOut <= 0n) {
      throw new InsufficientLiquidityError("unknown", {
        reserveIn: reserveIn.toString(),
        reserveOut: reserveOut.toString(),
      });
    }

    const feeFactor = BigInt(10000 - feeBps);
    const amountInWithFee = amountIn * feeFactor;
    const numerator = amountInWithFee * reserveOut;
    const denominator = reserveIn * 10000n + amountInWithFee;
    return numerator / denominator;
  }

  /**
   * Calculate input amount for exact-out swap.
   */
  getAmountIn(
    amountOut: bigint,
    reserveIn: bigint,
    reserveOut: bigint,
    feeBps: number,
  ): bigint {
    if (amountOut <= 0n) {
      throw new ValidationError("Insufficient output amount", {
        amountOut: amountOut.toString(),
      });
    }
    if (reserveIn <= 0n || reserveOut <= 0n) {
      throw new InsufficientLiquidityError("unknown", {
        reserveIn: reserveIn.toString(),
        reserveOut: reserveOut.toString(),
      });
    }
    if (amountOut >= reserveOut) {
      throw new InsufficientLiquidityError("unknown", {
        reason: "Output amount exceeds available reserves",
        amountOut: amountOut.toString(),
        reserveOut: reserveOut.toString(),
      });
    }

    const feeFactor = BigInt(10000 - feeBps);
    const numerator = reserveIn * amountOut * 10000n;
    const denominator = (reserveOut - amountOut) * feeFactor;
    return numerator / denominator + 1n;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolve the effective routing path from the request.
   * Defaults to [tokenIn, tokenOut] for direct swaps.
   */
  private resolvePath(request: SwapRequest): string[] {
    if (request.path && request.path.length >= 2) {
      return request.path;
    }
    return [request.tokenIn, request.tokenOut];
  }

  /**
   * Direct (single-hop) quote -- identical to the original getQuote logic.
   */
  private async getDirectQuote(
    request: SwapRequest,
    path: string[],
  ): Promise<SwapQuote> {
    const [tokenIn, tokenOut] = path;

    const pairAddress = await this.client.getPairAddress(tokenIn, tokenOut);
    if (!pairAddress) {
      throw new PairNotFoundError(tokenIn, tokenOut);
    }

    const pair = this.client.pair(pairAddress);
    const [reserves, dynamicFee] = await Promise.all([
      pair.getReserves(),
      pair.getDynamicFee(),
    ]);

    const { reserve0, reserve1 } = reserves;
    const isToken0In = await this.isToken0(pair, tokenIn);
    const reserveIn = isToken0In ? reserve0 : reserve1;
    const reserveOut = isToken0In ? reserve1 : reserve0;

    let amountIn: bigint;
    let amountOut: bigint;

    if (request.tradeType === TradeType.EXACT_IN) {
      amountIn = request.amount;
      amountOut = this.getAmountOut(
        amountIn,
        reserveIn,
        reserveOut,
        dynamicFee,
      );
    } else {
      amountOut = request.amount;
      amountIn = this.getAmountIn(amountOut, reserveIn, reserveOut, dynamicFee);
    }

    const slippageBps =
      request.slippageBps ??
      this.client.config.defaultSlippageBps ??
      DEFAULTS.slippageBps;
    const amountOutMin =
      amountOut - (amountOut * BigInt(slippageBps)) / PRECISION.BPS_DENOMINATOR;

    const priceImpactBps = this.calculatePriceImpact(
      amountIn,
      amountOut,
      reserveIn,
      reserveOut,
    );
    const feeAmount =
      (amountIn * BigInt(dynamicFee)) / PRECISION.BPS_DENOMINATOR;

    return {
      tokenIn,
      tokenOut,
      amountIn,
      amountOut,
      amountOutMin,
      priceImpactBps,
      feeBps: dynamicFee,
      feeAmount,
      path,
      deadline: request.deadline ?? this.client.getDeadline(),
    };
  }

  /**
   * Multi-hop quote: chain getAmountOut across every consecutive pair in `path`.
   *
   * For a path [A, B, C]:
   *   hop1: amountOut_1 = getAmountOut(amountIn,    reserveA, reserveB, fee_AB)
   *   hop2: amountOut_2 = getAmountOut(amountOut_1, reserveB, reserveC, fee_BC)
   *
   * Aggregation:
   *   totalFeeAmount = sum of per-hop fee amounts (denominated in each hop's tokenIn)
   *   compoundImpact = 1 - product((1 - impact_i/10000)) expressed in bps
   */
  private async getMultiHopSwapQuote(
    request: SwapRequest,
    path: string[],
  ): Promise<SwapQuote> {
    if (request.tradeType !== TradeType.EXACT_IN) {
      // Exact-out multi-hop requires reverse path computation; not supported in v1.
      throw new ValidationError(
        "Multi-hop routing only supports EXACT_IN trade type",
        { tradeType: request.tradeType },
      );
    }

    const hops = await this.computeHops(request.amount, path);

    // Aggregate totals
    const totalFeeAmount = hops.reduce((acc, h) => acc + h.feeAmount, 0n);
    const totalFeeBps = hops.reduce((acc, h) => acc + h.feeBps, 0);

    // Compound price impact: 1 - product(1 - impact_i)
    const compoundImpactBps = this.compoundPriceImpact(
      hops.map((h) => h.priceImpactBps),
    );

    const amountIn = hops[0].amountIn;
    const amountOut = hops[hops.length - 1].amountOut;

    const slippageBps =
      request.slippageBps ??
      this.client.config.defaultSlippageBps ??
      DEFAULTS.slippageBps;
    const amountOutMin =
      amountOut - (amountOut * BigInt(slippageBps)) / PRECISION.BPS_DENOMINATOR;

    return {
      tokenIn: path[0],
      tokenOut: path[path.length - 1],
      amountIn,
      amountOut,
      amountOutMin,
      priceImpactBps: compoundImpactBps,
      feeBps: totalFeeBps,
      feeAmount: totalFeeAmount,
      path,
      deadline: request.deadline ?? this.client.getDeadline(),
    };
  }

  /**
   * Fetch reserves for every consecutive pair in `path`, compute per-hop
   * amounts, and return the ordered HopResult array.
   *
   * Throws PairNotFoundError if any pair in the path is not registered,
   * or InsufficientLiquidityError if any pair has zero reserves.
   */
  async computeHops(amountIn: bigint, path: string[]): Promise<HopResult[]> {
    const hops: HopResult[] = [];
    let currentAmountIn = amountIn;

    for (let i = 0; i < path.length - 1; i++) {
      const tokenIn = path[i];
      const tokenOut = path[i + 1];

      const pairAddress = await this.client.getPairAddress(tokenIn, tokenOut);
      if (!pairAddress) {
        throw new PairNotFoundError(tokenIn, tokenOut);
      }

      const pair = this.client.pair(pairAddress);
      const [reserves, feeBps] = await Promise.all([
        pair.getReserves(),
        pair.getDynamicFee(),
      ]);

      const isToken0In = await this.isToken0(pair, tokenIn);
      const reserveIn = isToken0In ? reserves.reserve0 : reserves.reserve1;
      const reserveOut = isToken0In ? reserves.reserve1 : reserves.reserve0;

      if (reserveIn === 0n || reserveOut === 0n) {
        throw new InsufficientLiquidityError(pairAddress, {
          tokenIn,
          tokenOut,
        });
      }

      const amountOut = this.getAmountOut(
        currentAmountIn,
        reserveIn,
        reserveOut,
        feeBps,
      );
      const feeAmount =
        (currentAmountIn * BigInt(feeBps)) / PRECISION.BPS_DENOMINATOR;
      const priceImpactBps = this.calculatePriceImpact(
        currentAmountIn,
        amountOut,
        reserveIn,
        reserveOut,
      );

      hops.push({
        tokenIn,
        tokenOut,
        amountIn: currentAmountIn,
        amountOut,
        feeBps,
        feeAmount,
        priceImpactBps,
      });

      currentAmountIn = amountOut;
    }

    return hops;
  }

  /**
   * Compound price impact across all hops.
   *
   * Formula: impactTotal = 1 - product(1 - impact_i / 10000)
   * Returned as integer basis points (0-10000).
   */
  compoundPriceImpact(impactsBps: number[]): number {
    let product = 1;
    for (const bps of impactsBps) {
      product *= 1 - bps / 10000;
    }
    return Math.round((1 - product) * 10000);
  }

  /**
   * Calculate price impact in basis points.
   */
  private calculatePriceImpact(
    amountIn: bigint,
    amountOut: bigint,
    reserveIn: bigint,
    reserveOut: bigint,
  ): number {
    if (reserveIn === 0n || reserveOut === 0n) return 10000;
    const idealOut = (amountIn * reserveOut) / reserveIn;
    if (idealOut === 0n) return 10000;
    const impact = ((idealOut - amountOut) * 10000n) / idealOut;
    return Number(impact);
  }

  /**
   * Determine if tokenIn is token0 in the pair ordering.
   */
  private async isToken0(pair: PairClient, tokenIn: string): Promise<boolean> {
    const tokens = await pair.getTokens();
    return tokens.token0 === tokenIn;
  }
}
