import { CoralSwapClient } from '../client';
import { TradeType } from '../types/common';
import { SwapRequest, SwapQuote, SwapResult, HopResult, SwapHistoryFilter, SwapHistoryEvent } from '../types/swap';
import { PRECISION, DEFAULTS } from '../config';
import { PairNotFoundError, ValidationError, InsufficientLiquidityError, TransactionError } from '../errors';
import { PairClient } from '@/contracts/pair';
import { SwapEvent } from '../types/events';
import { validateAddress } from '../utils/validation';
import { EventParser } from '../utils/events';
import { SorobanRpc } from '@stellar/stellar-sdk';

/** Default ledger window when no fromLedger/toLedger is specified. */
const DEFAULT_HISTORY_WINDOW = 1000;

/** Default maximum results per query. */
const DEFAULT_HISTORY_LIMIT = 200;

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
    const path = this.resolvePath(request);

    if (path.length < 2) {
      throw new ValidationError('Swap path must contain at least 2 tokens', { path });
    }

    if (path.length === 2) {
      return this.getDirectQuote(request, path);
    }

    return this.getMultiHopQuote(request, path);
  }

  /**
   * Execute a swap transaction on-chain.
   *
   * For multi-hop paths, invokes the router's swap_exact_tokens_for_tokens
   * with the full path vector. For direct swaps, uses swap_exact_in /
   * swap_exact_out as before.
   */
  async execute(request: SwapRequest): Promise<SwapResult> {
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
  async getMultiHopQuote(request: SwapRequest, path: string[]): Promise<SwapQuote> {
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
    const totalFeeBps = hops.reduce((acc, h) => acc + h.feeBps, 0);

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
    const { pairAddress, userAddress, limit = DEFAULT_HISTORY_LIMIT } = filter;

    // Validate optional addresses up-front
    if (pairAddress) validateAddress(pairAddress, 'pairAddress');
    if (userAddress) validateAddress(userAddress, 'userAddress');

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
          type: 'contract',
          contractIds: pairAddress ? [pairAddress] : [],
          topics: [['swap']],
        },
      ],
      limit,
    };

    const response = await this.client.server.getEvents(request);

    if (!response || !Array.isArray(response.events)) {
      return [];
    }

    const parser = new EventParser(pairAddress ? [pairAddress] : []);
    const results: SwapHistoryEvent[] = [];

    for (const rawEvent of response.events) {
      // Respect toLedger upper bound (RPC only accepts startLedger, not endLedger)
      if (rawEvent.ledger > toLedger) continue;

      // Parse the raw event into a typed SwapEvent using the existing EventParser.
      // The RPC returns events in a different shape than DiagnosticEvents, so we
      // reconstruct the fields we need directly from the raw event value.
      let swapEvent: SwapEvent | null = null;
      try {
        swapEvent = this.parseRawSwapEvent(rawEvent, parser);
      } catch {
        // Skip malformed events
        continue;
      }

      if (!swapEvent) continue;

      // Apply userAddress filter (AND with pairAddress if both given)
      if (userAddress && swapEvent.sender !== userAddress) continue;

      results.push({
        txHash: swapEvent.txHash,
        amountIn: swapEvent.amountIn,
        amountOut: swapEvent.amountOut,
        tokenIn: swapEvent.tokenIn,
        tokenOut: swapEvent.tokenOut,
        sender: swapEvent.sender,
        pairAddress: swapEvent.contractId,
        ledger: swapEvent.ledger,
        timestamp: swapEvent.timestamp,
        feeBps: swapEvent.feeBps,
      });

      if (results.length >= limit) break;
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Private helper: parse a raw RPC event into a SwapEvent
  // ---------------------------------------------------------------------------

  /**
   * Convert a raw `SorobanRpc.Api.EventResponse` entry into a typed SwapEvent.
   *
   * The RPC `getEvents` response carries decoded ScVal values in `event.value`
   * and topic strings in `event.topic`. We reconstruct the SwapEvent fields
   * directly from the decoded values rather than going through XDR re-encoding.
   *
   * Returns null if the event is not a swap event or cannot be decoded.
   */
  private parseRawSwapEvent(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rawEvent: any,
    _parser: EventParser,
  ): SwapEvent | null {
    // Verify this is a swap event by checking the first topic
    const topics: string[] = rawEvent.topic ?? [];
    if (!topics.length || topics[0] !== 'swap') return null;

    // The `value` field is an ScVal (already decoded by stellar-sdk)
    const value = rawEvent.value;
    if (!value) return null;

    // Extract the ScMap entries
    const map: Array<{ key: { sym?: () => { toString(): string }; str?: () => { toString(): string } }; val: unknown }> =
      typeof value.map === 'function' ? value.map() : value._value;

    if (!Array.isArray(map)) return null;

    // Helper to get a map value by key name
    const get = (key: string): unknown => {
      for (const entry of map) {
        const k = entry.key;
        let keyStr: string | undefined;
        try {
          if (typeof k.sym === 'function') keyStr = k.sym().toString();
          else if (typeof k.str === 'function') keyStr = k.str().toString();
        } catch { /* skip */ }
        if (keyStr === key) return entry.val;
      }
      return undefined;
    };

    // Decode address ScVal to string
    const decodeAddr = (val: unknown): string => {
      if (!val) throw new Error('missing address');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const v = val as any;
      if (typeof v.address === 'function') return v.address().toString();
      if (typeof v._value?.toString === 'function') return v._value.toString();
      throw new Error('cannot decode address');
    };

    // Decode i128 ScVal to bigint
    const decodeI128 = (val: unknown): bigint => {
      if (!val) throw new Error('missing i128');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const v = val as any;
      if (typeof v.i128 === 'function') {
        const parts = v.i128();
        return (BigInt(parts.hi().toString()) << 64n) + BigInt(parts.lo().toString());
      }
      throw new Error('cannot decode i128');
    };

    // Decode u32 ScVal to number
    const decodeU32 = (val: unknown): number => {
      if (!val) throw new Error('missing u32');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const v = val as any;
      if (typeof v.u32 === 'function') return v.u32();
      throw new Error('cannot decode u32');
    };

    const sender = decodeAddr(get('sender'));
    const tokenIn = decodeAddr(get('token_in'));
    const tokenOut = decodeAddr(get('token_out'));
    const amountIn = decodeI128(get('amount_in'));
    const amountOut = decodeI128(get('amount_out'));
    const feeBps = decodeU32(get('fee_bps'));

    return {
      type: 'swap',
      contractId: rawEvent.contractId ?? '',
      ledger: rawEvent.ledger ?? 0,
      timestamp: rawEvent.ledgerClosedAt
        ? Math.floor(new Date(rawEvent.ledgerClosedAt).getTime() / 1000)
        : rawEvent.ledger ?? 0,
      txHash: rawEvent.txHash ?? '',
      sender,
      tokenIn,
      tokenOut,
      amountIn,
      amountOut,
      feeBps,
    };
  }
}
