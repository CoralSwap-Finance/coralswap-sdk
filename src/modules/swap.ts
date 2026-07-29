import { CoralSwapClient } from '../client';
import { TradeType } from '../types/common';
import {
  SwapRequest,
  SwapQuote,
  SwapResult,
  HopResult,
  SwapHistoryFilter,
  SwapHistoryEvent,
  SwapSimulationResult,
  SwapWithPriceGuardRequest,
  PriceGuardConfig,
  MultiHopSwapRequest,
  MultiHopSwapQuote,
} from '../types/swap';
import { PRECISION, DEFAULTS } from '../config';
import { PairNotFoundError, ValidationError, InsufficientLiquidityError, TransactionError } from '../errors';
import { PairClient } from '@/contracts/pair';
import { validateAddress, validatePositiveAmount, validateDistinctTokens, isValidPath } from '@/utils/validation';
import { SorobanRpc } from '@stellar/stellar-sdk';
import { GasEstimate } from '../types/gas';
import { estimateGas } from '../utils/gas';
import { resolveTokenIdentifier } from '../utils/addresses';
import { simulateSwapParamsSchema, multiHopSwapRequestSchema, swapHistoryFilterSchema, priceGuardConfigSchema, parseWithValidationError } from '../schemas/swap';
import { simulateSwapParamsSchema, multiHopSwapRequestSchema, swapHistoryFilterSchema, priceGuardConfigSchema, parseWithValidationError } from '../schemas/swap';
import { verifyRedStonePayload, estimateUsdValue, DEFAULT_PRICE_GUARD_CONFIG } from '../utils/redstone';

/** Default ledger window when no fromLedger/toLedger is specified. */
const DEFAULT_HISTORY_WINDOW = 1000;
/** Default maximum results per query. */

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
  private priceGuardConfig: PriceGuardConfig = { ...DEFAULT_PRICE_GUARD_CONFIG };

  constructor(client: CoralSwapClient) {
    this.client = client;
  }

  /**
   * Update the price guard configuration (admin operation).
   *
   * @param minGuardedAmountUsd - Minimum swap size in USD (× 10^8) that triggers the guard.
   * @param maxDeviationBps - Maximum allowed deviation from oracle price in basis points.
   */
  setPriceGuardConfig(minGuardedAmountUsd: bigint, maxDeviationBps: number): void {
    parseWithValidationError(priceGuardConfigSchema, { minGuardedAmountUsd, maxDeviationBps });
    this.priceGuardConfig = {
      ...this.priceGuardConfig,
      minGuardedAmountUsd,
      maxDeviationBps,
    };
  }

  /**
   * Execute a swap with an optional RedStone oracle price guard.
   */
  async swapWithPriceGuard(
    request: SwapWithPriceGuardRequest,
    tokenInSymbol: string,
    tokenOutSymbol: string,
  ): Promise<SwapResult> {
    const quote = request.quote ?? await this.getQuote(request);

    const { redstonePayload } = request;

    if (redstonePayload) {
      // Determine whether this swap is large enough to require the guard.
      const usdValue = estimateUsdValue(
        quote.amountIn,
        tokenInSymbol,
        redstonePayload.prices,
      );

      const guardRequired =
        usdValue === null || usdValue >= this.priceGuardConfig.minGuardedAmountUsd;

      if (guardRequired) {
        verifyRedStonePayload(
          redstonePayload,
          tokenInSymbol,
          tokenOutSymbol,
          quote.amountIn,
          quote.amountOut,
          this.priceGuardConfig,
        );
      }
    }

    return this.execute({ ...request, quote });
  }

  /**
   * Dry-run a swap against live on-chain reserve state without submitting a transaction.
   */
  async simulateSwap(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
    pairAddress?: string,
  ): Promise<SwapSimulationResult> {
    const passphrase = this.client.networkConfig.networkPassphrase;
    const resolvedTokenIn = resolveTokenIdentifier(tokenIn, passphrase);
    const resolvedTokenOut = resolveTokenIdentifier(tokenOut, passphrase);

    parseWithValidationError(
      simulateSwapParamsSchema,
      { tokenIn: resolvedTokenIn, tokenOut: resolvedTokenOut, amountIn },
      { tokenIn: 'tokenIn', tokenOut: 'tokenOut', amountIn: 'amountIn' },
    );

    // Resolve pair address via factory if not provided
    const resolvedPair =
      pairAddress ?? (await this.client.getPairAddress(resolvedTokenIn, resolvedTokenOut));
    if (!resolvedPair) {
      throw new PairNotFoundError(resolvedTokenIn, resolvedTokenOut);
    }

    const pair = this.client.pair(resolvedPair);

    // Fetch reserves and fee in parallel — both are read-only contract views
    const [reserves, feeBps] = await Promise.all([
      pair.getReserves(),
      pair.getDynamicFee(),
    ]);

    const { reserve0, reserve1 } = reserves;

    if (reserve0 === 0n || reserve1 === 0n) {
      throw new InsufficientLiquidityError(resolvedPair, {
        tokenIn: resolvedTokenIn,
        tokenOut: resolvedTokenOut,
        reserve0: reserve0.toString(),
        reserve1: reserve1.toString(),
        pairAddress: resolvedPair,
      });
    }

    // Determine which reserve corresponds to tokenIn
    const isToken0In = await this.isToken0(pair, resolvedTokenIn);
    const reserveIn = isToken0In ? reserve0 : reserve1;
    const reserveOut = isToken0In ? reserve1 : reserve0;

    // Apply the Uniswap V2 AMM formula with the dynamic fee
    const amountOut = this.getAmountOut(amountIn, reserveIn, reserveOut, feeBps);

    // Fee deducted from amountIn
    const feeAmount = (amountIn * BigInt(feeBps)) / PRECISION.BPS_DENOMINATOR;

    // Price impact: how much the trade moves the price relative to spot
    const priceImpactBps = this.calculatePriceImpact(amountIn, amountOut, reserveIn, reserveOut);

    // Execution price as an exact fraction (amountOut / amountIn)
    const executionPrice = { numerator: amountOut, denominator: amountIn };

    const result: SwapSimulationResult = {
      amountOut,
      priceImpactBps,
      feeAmount,
      executionPrice,
    };

    if (priceImpactBps > 500) {
      result.warning = 'HIGH_PRICE_IMPACT';
    }

    return result;
  }

  /**
   * Get an estimated swap quote without executing.
   *
   * If `request.path` is provided with 3+ tokens, calculates a multi-hop
   * quote by chaining getAmountOut across each hop.
   * Falls back to direct swap for a 2-token path or no path.
   */
  async getQuote(request: SwapRequest): Promise<SwapQuote> {
    const path = this.resolvePath(request);

    if (path.length < 2) {
      throw new ValidationError('Swap path must contain at least 2 tokens', { path });
    }

    if (path.length === 2) {
      return this.getDirectQuote(request, path);
    }

    return this.getMultiHopQuoteInternal(request, path);
  }

  /**
   * Execute a swap transaction on-chain, or estimate its fee.
   */
  async execute(request: SwapRequest, options: { estimateOnly: true }): Promise<GasEstimate>;
  async execute(request: SwapRequest, options?: { estimateOnly?: false }): Promise<SwapResult>;
  async execute(request: SwapRequest, options?: { estimateOnly?: boolean }): Promise<SwapResult | GasEstimate> {
    const path = this.resolvePath(request);
    const quote = await this.getQuote(request);

    let op: import('@stellar/stellar-sdk').xdr.Operation;

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

    if (options?.estimateOnly) {
      return estimateGas((ops) => this.client.simulateTransaction(ops, {}), [op]);
    }

    const result = await this.client.submitTransaction([op]);

    if (!result.success) {
      throw new TransactionError(
        `Multi-hop swap failed: ${result.error?.message ?? "Unknown error"}`,
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
   *
   * @param amountIn - Input amount
   * @param reserveIn - Reserve of input token in the pool
   * @param reserveOut - Reserve of output token in the pool
   * @param feeBps - Fee in basis points
   * @returns Maximum output amount
   * @throws {ValidationError} If input amount is <= 0
   * @throws {InsufficientLiquidityError} If reserves are 0
   * @example
   * const out = client.swap.getAmountOut(100n, 1000n, 1000n, 30);
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
   *
   * @param amountOut - Output amount
   * @param reserveIn - Reserve of input token in the pool
   * @param reserveOut - Reserve of output token in the pool
   * @param feeBps - Fee in basis points
   * @returns Minimum input amount required
   * @throws {ValidationError} If output amount is <= 0
   * @throws {InsufficientLiquidityError} If reserves are 0 or output amount >= reserveOut
   * @example
   * const req = client.swap.getAmountIn(100n, 1000n, 1000n, 30);
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
  private async getDirectQuote(request: SwapRequest, path: string[]): Promise<SwapQuote> {
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
      amountOut = this.getAmountOut(amountIn, reserveIn, reserveOut, dynamicFee);
    } else {
      amountOut = request.amount;
      amountIn = this.getAmountIn(amountOut, reserveIn, reserveOut, dynamicFee);
    }

    const slippageBps = request.slippageBps ?? this.client.config.defaultSlippageBps ?? DEFAULTS.slippageBps;
    const amountOutMin = amountOut - (amountOut * BigInt(slippageBps)) / PRECISION.BPS_DENOMINATOR;

    const priceImpactBps = this.calculatePriceImpact(amountIn, amountOut, reserveIn, reserveOut);
    const feeAmount = (amountIn * BigInt(dynamicFee)) / PRECISION.BPS_DENOMINATOR;

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
  async getMultiHopQuoteInternal(request: SwapRequest, path: string[]): Promise<SwapQuote> {
    if (request.tradeType !== TradeType.EXACT_IN) {
      // Exact-out multi-hop requires reverse path computation; not supported in v1.
      throw new ValidationError(
        'Multi-hop routing only supports EXACT_IN trade type',
        { tradeType: request.tradeType },
      );
    }

    const hops = await this.computeHops(request.amount, path);

    // Aggregate totals
    const totalFeeAmount = hops.reduce((acc, h) => acc + h.feeAmount, 0n);
    const totalFeeBps = this.computeCompoundedFeeBps(hops.map((h) => h.feeBps));

    // Compound price impact: 1 - product(1 - impact_i)
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
    };
  }

  async getMultiHopQuote(request: MultiHopSwapRequest): Promise<MultiHopSwapQuote> {
    const passphrase = this.client.networkConfig.networkPassphrase;
    const path = request.path.map((t) => resolveTokenIdentifier(t, passphrase));

    parseWithValidationError(
      multiHopSwapRequestSchema,
      { path, amount: request.amount, tradeType: request.tradeType, slippageBps: request.slippageBps, deadline: request.deadline, to: request.to },
    );

    const hops =
      request.tradeType === TradeType.EXACT_OUT
        ? await this.computeHopsReverse(request.amount, path)
        : await this.computeHops(request.amount, path);

    const totalFeeAmount = hops.reduce((acc, h) => acc + h.feeAmount, 0n);
    const totalFeeBps = this.computeCompoundedFeeBps(hops.map((h) => h.feeBps));
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
      hops,
    };
  }

  async executeMultiHop(request: MultiHopSwapRequest): Promise<SwapResult> {
    const quote = await this.getMultiHopQuote(request);

    const op = this.client.router.buildSwapExactTokensForTokens(
      request.to ?? this.client.publicKey,
      quote.path,
      quote.amountIn,
      quote.amountOutMin,
      quote.deadline,
    );

    const result = await this.client.submitTransaction([op]);

    if (!result.success) {
      throw new TransactionError(
        `Multi-hop swap failed: ${result.error?.message ?? "Unknown error"}`,
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

  computeCompoundedFeeBps(feesBps: number[]): number {
    let remainingRatio = 10000n;

    for (const feeBps of feesBps) {
      remainingRatio =
        (remainingRatio * (PRECISION.BPS_DENOMINATOR - BigInt(feeBps))) /
        PRECISION.BPS_DENOMINATOR;
    }

    return Number(PRECISION.BPS_DENOMINATOR - remainingRatio);
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
        throw new InsufficientLiquidityError(pairAddress, { tokenIn, tokenOut });
      }

      const amountOut = this.getAmountOut(currentAmountIn, reserveIn, reserveOut, feeBps);
      const feeAmount = (currentAmountIn * BigInt(feeBps)) / PRECISION.BPS_DENOMINATOR;
      const priceImpactBps = this.calculatePriceImpact(currentAmountIn, amountOut, reserveIn, reserveOut);

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
   * Compute hops in reverse (given amountOut, find required amountIn).
   */
  async computeHopsReverse(amountOut: bigint, path: string[]): Promise<HopResult[]> {
    const hops: HopResult[] = [];
    let currentAmountOut = amountOut;

    for (let i = path.length - 1; i > 0; i--) {
      const tokenIn = path[i - 1];
      const tokenOut = path[i];

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
        throw new InsufficientLiquidityError(pairAddress, { tokenIn, tokenOut });
      }

      const amountIn = this.getAmountIn(currentAmountOut, reserveIn, reserveOut, feeBps);
      const feeAmount = (amountIn * BigInt(feeBps)) / PRECISION.BPS_DENOMINATOR;
      const priceImpactBps = this.calculatePriceImpact(amountIn, currentAmountOut, reserveIn, reserveOut);

      hops.unshift({
        tokenIn,
        tokenOut,
        amountIn,
        amountOut: currentAmountOut,
        feeBps,
        feeAmount,
        priceImpactBps,
      });

      currentAmountOut = amountIn;
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

  /**
   * Fetch swap history.
   *
   * Uses the Soroban RPC `getEvents` endpoint to fetch on-chain swap events
   * and applies the provided filters client-side. Pagination is controlled
   * via `fromLedger` / `toLedger`; both default to a 1000-ledger window
   * ending at the current ledger when omitted.
   *
   * Filter semantics:
   * - `pairAddress` alone  → all swaps in that pool
   * - `userAddress` alone  → all swaps by that sender across all pools
   * - both provided        → swaps by that sender in that pool (AND)
   * - neither provided     → all swap events in the ledger window
   *
   * @param filter - Query parameters (pairAddress, userAddress, ledger range, limit)
   * @returns Ordered array of SwapHistoryEvent (oldest first). Returns [] on no match.
   * @throws {ValidationError} If pairAddress or userAddress is provided but invalid.
   */

  async getSwapHistory(filter: SwapHistoryFilter = {}): Promise<SwapHistoryEvent[]> {
    const { pairAddress, userAddress } = filter;

    parseWithValidationError(
      swapHistoryFilterSchema,
      filter,
    );

    // Resolve ledger range — default to last DEFAULT_HISTORY_WINDOW ledgers
    const currentLedger = await this.client.getCurrentLedger();
    const fromLedger = filter.fromLedger ?? Math.max(0, currentLedger - DEFAULT_HISTORY_WINDOW);
    const toLedger = filter.toLedger ?? currentLedger;

    if (fromLedger > toLedger) {
      throw new ValidationError(
        `fromLedger (${fromLedger}) must not be greater than toLedger (${toLedger})`,
        { fromLedger, toLedger },
      );
    }

    // Build the getEvents request.
    // When pairAddress is given we scope the query to that contract, which is
    // the most efficient path. Without it we query all contracts for "swap" topic.
    const request: SorobanRpc.Server.GetEventsRequest = {
      startLedger: fromLedger,
      filters: [
        {
          type: "contract",
          contractIds: filter.pairAddress ? [filter.pairAddress] : [],
          topics: [["swap"]],
        },
      ],
      limit: filter.limit ?? 200,
    };

    const response = await this.client.server.getEvents(request);
    if (!response || !Array.isArray(response.events)) return [];

    const events: SwapHistoryEvent[] = [];

    for (const ev of response.events) {
      // Skip events beyond toLedger
      if (ev.ledger > toLedger) continue;

      // Skip non-swap topics
      const topicName = ev.topic?.[0] ? decodeScValString(ev.topic[0]) : "";
      if (topicName !== "swap") continue;

      if (!ev.value) continue;

      const data = decodeMapEvent(ev.value);
      if (!data) continue;

      const sender = readAddress(data, "sender");
      if (!sender) continue;

      // Filter by userAddress if specified
      if (filter.userAddress && sender !== filter.userAddress) continue;

      const amountIn = readI128(data, "amount_in");
      const amountOut = readI128(data, "amount_out");
      const tokenIn = readAddress(data, "token_in");
      const tokenOut = readAddress(data, "token_out");
      const feeBps = readU32(data, "fee_bps");

      if (
        amountIn === undefined ||
        amountOut === undefined ||
        !tokenIn ||
        !tokenOut ||
        feeBps === undefined
      ) {
        continue;
      }

      const timestamp = ev.ledgerClosedAt
        ? Math.floor(new Date(ev.ledgerClosedAt).getTime() / 1000)
        : Math.floor(Date.now() / 1000);

      events.push({
        txHash: ev.txHash ?? "",
        amountIn,
        amountOut,
        tokenIn,
        tokenOut,
        sender,
        pairAddress: ev.contractId?.toString() ?? "",
        ledger: ev.ledger,
        timestamp,
        feeBps,
      });
    }

    // Limit the results
    return events.slice(0, filter.limit ?? 200);
  }
}

// ---------------------------------------------------------------------------
// Event Decoding Helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function decodeMapEvent(value: any): Map<string, any> | null {
  const entries: unknown[] =
    typeof value?.map === "function" ? value.map() : value?._value;
  if (!Array.isArray(entries)) return null;

  const map = new Map<string, unknown>();
  for (const entry of entries as Array<{ key: unknown; val: unknown }>) {
    const k = entry.key as Record<string, () => { toString(): string }>;
    let key: string | undefined;
    try {
      key = k.sym?.().toString() ?? k.str?.().toString();
    } catch { /* skip */ }
    if (key) map.set(key, entry.val);
  }
  return map as Map<string, unknown>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readAddress(map: Map<string, any>, key: string): string | undefined {
  const val = map.get(key);
  if (!val) return undefined;
  try {
    if (typeof val.address === "function") return val.address().toString();
    if (typeof val._value?.toString === "function") return val._value.toString();
  } catch { /* skip */ }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readI128(map: Map<string, any>, key: string): bigint | undefined {
  const val = map.get(key);
  if (!val) return undefined;
  try {
    if (typeof val.i128 === "function") {
      const parts = val.i128();
      return (BigInt(parts.hi().toString()) << 64n) + BigInt(parts.lo().toString());
    }
  } catch { /* skip */ }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readU32(map: Map<string, any>, key: string): number | undefined {
  const val = map.get(key);
  if (!val) return undefined;
  try {
    if (typeof val.u32 === "function") return val.u32();
  } catch { /* skip */ }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function decodeScValString(val: any): string {
  if (!val) return "";
  if (typeof val === "string") return val;
  if (typeof val.sym === "function") return val.sym().toString();
  if (typeof val.str === "function") return val.str().toString();
  return val.toString();
}
