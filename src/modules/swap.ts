import { CoralSwapClient } from '../client';
import { TradeType } from '../types/common';
import { SwapRequest, SwapQuote, SwapResult } from '../types/swap';
import { PRECISION, DEFAULTS } from '../config';
import { PairNotFoundError, ValidationError, InsufficientLiquidityError, TransactionError } from '../errors';

/**
 * Swap module -- builds, quotes, and executes token swaps.
 *
 * Directly interacts with CoralSwap Router and Pair contracts on Soroban.
 * Supports exact-in and exact-out trades with dynamic fee awareness,
 * slippage protection, and deadline enforcement.
 */
export class SwapModule {
  private client: CoralSwapClient;

  constructor(client: CoralSwapClient) {
    this.client = client;
  }

  /**
   * Get an estimated swap quote without executing.
   *
   * Reads dynamic fee state from the pair contract, calculates
   * price impact, and returns the expected output with fee breakdown.
   */
  async getQuote(request: SwapRequest): Promise<SwapQuote> {
    const pairAddress = await this.client.getPairAddress(
      request.tokenIn,
      request.tokenOut,
    );

    if (!pairAddress) {
      throw new PairNotFoundError(request.tokenIn, request.tokenOut);
    }

    const pair = this.client.pair(pairAddress);
    const [reserves, dynamicFee] = await Promise.all([
      pair.getReserves(),
      pair.getDynamicFee(),
    ]);

    const { reserve0, reserve1 } = reserves;
    const isToken0In = await this.isToken0(pair, request.tokenIn);
    const reserveIn = isToken0In ? reserve0 : reserve1;
    const reserveOut = isToken0In ? reserve1 : reserve0;

    let amountIn: bigint;
    let amountOut: bigint;

    if (request.tradeType === TradeType.EXACT_IN) {
      amountIn = request.amount;
      amountOut = this.getAmountOut(amountIn, reserveIn, reserveOut, dynamicFee);
    } else {
      amountOut = request.amount;
      amountIn = this.getAmountIn(amountOut, reserveIn, reserveOut, dynamicFee);
    }

    const slippageBps = request.slippageBps ?? this.client.config.defaultSlippageBps ?? DEFAULTS.slippageBps;
    const amountOutMin = amountOut - (amountOut * BigInt(slippageBps)) / PRECISION.BPS_DENOMINATOR;

    const priceImpactBps = this.calculatePriceImpact(
      amountIn,
      amountOut,
      reserveIn,
      reserveOut,
    );

    const feeAmount = (amountIn * BigInt(dynamicFee)) / PRECISION.BPS_DENOMINATOR;

    return {
      tokenIn: request.tokenIn,
      tokenOut: request.tokenOut,
      amountIn,
      amountOut,
      amountOutMin,
      priceImpactBps,
      feeBps: dynamicFee,
      feeAmount,
      path: [request.tokenIn, request.tokenOut],
      deadline: request.deadline ?? this.client.getDeadline(),
    };
  }

  /**
   * Execute a swap transaction on-chain.
   */
  async execute(request: SwapRequest): Promise<SwapResult> {
    const quote = await this.getQuote(request);

    const op =
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

    const result = await this.client.submitTransaction([op]);

    if (!result.success) {
      throw new TransactionError(
        `Swap failed: ${result.error?.message ?? 'Unknown error'}`,
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
    if (amountIn <= 0n) throw new ValidationError('Input amount must be greater than zero');
    if (reserveIn <= 0n || reserveOut <= 0n) throw new InsufficientLiquidityError('unknown');

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
    if (amountOut <= 0n) throw new ValidationError('Output amount must be greater than zero');
    if (reserveIn <= 0n || reserveOut <= 0n) throw new InsufficientLiquidityError('unknown');
    if (amountOut >= reserveOut) throw new ValidationError('Output amount exceeds available reserve');

    const feeFactor = BigInt(10000 - feeBps);
    const numerator = reserveIn * amountOut * 10000n;
    const denominator = (reserveOut - amountOut) * feeFactor;
    return numerator / denominator + 1n;
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
  private async isToken0(pair: any, tokenIn: string): Promise<boolean> {
    const tokens = await pair.getTokens();
    return tokens.token0 === tokenIn;
  }
}
