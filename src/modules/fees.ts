import { xdr, rpc, Contract, TransactionBuilder } from "@stellar/stellar-sdk";
import { CoralSwapClient } from "@/client";
import { FeeEstimate FeeRevenue, FeeRevenueEntry, FeeRevenueTokenTotal } from "@/types/fee";
import {
  FeeRevenueByToken,
  FeeRevenueEvent,
  PairFeeRevenue,
  LPYieldResult,
} from "@/types/fee";
import { FeeState } from "@/types/pool";
import { FeeEstimates } from "@/types/fee-estimates";
import { SwapEvent } from "@/types/events";
import { estimateGas } from "@/utils/gas";
import { validateAddress, validatePositiveAmount } from "@/utils/validation";
import { ledgerToApproxTime, LedgerHead } from "@/utils/ledger";
import { TypedEventCursor } from "@/utils/event-cursor";
import { SwapEvent } from "@/types/events";
import { decodeU32 } from "@/utils/scval";
import { fromSorobanAmount } from "@/utils/amounts";
import { getTokenDecimals, FALLBACK_TOKEN_DECIMALS } from "@/utils/token-decimals";
import { ValidationError } from "@/errors";

/** Swap events aggregated by `getFeeRevenue()` when no `limit` is given. */
const DEFAULT_REVENUE_EVENT_LIMIT = 200;
/**
 * Per-request page size while paginating the swap stream. `getFeeRevenue()`
 * caps how many swaps it aggregates at `limit`, but fetches them in pages so a
 * window holding more than one page of swaps is not truncated at page one.
 */
const REVENUE_PAGE_SIZE = 100;
/** Default revenue window: 30 days of ledgers at a 5s close time. */
const DEFAULT_REVENUE_WINDOW_LEDGERS = 518_400;

/**
 * Fee module -- dynamic fee transparency and estimation.
 *
 * Exposes the full dynamic fee engine state, allowing developers
 * to predict fee impacts, detect stale volatility, and analyze
 * fee history for trading strategies.
 */
export class FeeModule {
  private client: CoralSwapClient;

  /** Default ledger window for revenue scans: 30 days of ledgers at ~5s each. */
  private static readonly DEFAULT_REVENUE_WINDOW_LEDGERS = 518_400;

  /** Default per-request page size for the paginated event scan. */
  private static readonly DEFAULT_REVENUE_PAGE_LIMIT = 200;

  constructor(client: CoralSwapClient) {
    this.client = client;
  }

  /**
   * Get the current dynamic fee estimate for a pair.
   *
   * @param pairAddress - The address of the pair contract
   * @returns The estimated fee state, indicating stale status if unchanged recently
   * @example
   * const fee = await client.fees.getCurrentFee('C...');
   */
  async getCurrentFee(pairAddress: string): Promise<FeeEstimate> {
    validateAddress(pairAddress, "pairAddress");

    const pair = this.client.pair(pairAddress);
    const feeState = await pair.getFeeState();

    const now = Math.floor(Date.now() / 1000);
    const staleSec = now - feeState.lastUpdated;
    const isStale = staleSec > 3600; // stale after 1 hour of no swaps

    return {
      pairAddress,
      currentFeeBps: feeState.feeCurrent,
      baselineFeeBps: feeState.baselineFee,
      feeMin: feeState.feeMin,
      feeMax: feeState.feeMax,
      volatility: feeState.volAccumulator,
      emaDecayRate: feeState.emaDecayRate,
      lastUpdated: feeState.lastUpdated,
      isStale,
    };
  }

  /**
   * Get the fee for a specific token pair via the Router.
   *
   * @param tokenA - Address of the first token
   * @param tokenB - Address of the second token
   * @returns Current fee in basis points
   * @example
   * const feeBps = await client.fees.getFeeForPair('C...', 'C...');
   */
  async getFeeForPair(tokenA: string, tokenB: string): Promise<number> {
    validateAddress(tokenA, "tokenA");
    validateAddress(tokenB, "tokenB");

    return this.client.router.getDynamicFee(tokenA, tokenB);
  }

  /**
   * Get the full fee engine state for a pair (advanced).
   *
   * @param pairAddress - The address of the pair contract
   * @returns Full state of the pair's fee configuration and accumulators
   * @example
   * const state = await client.fees.getFeeState('C...');
   */
  async getFeeState(pairAddress: string): Promise<FeeState> {
    validateAddress(pairAddress, "pairAddress");
    const pair = this.client.pair(pairAddress);
    return pair.getFeeState();
  }

  /**
   * Estimate the effective fee for a swap of a given size.
   *
   * Larger swaps may trigger higher dynamic fees due to increased
   * volatility impact on the EMA.
   *
   * @param pairAddress - The address of the pair contract
   * @param amountIn - The amount of input token proposed for swap
   * @returns Both the fee in basis points and the calculated absolute fee amount
   * @example
   * const est = await client.fees.estimateSwapFee('C...', 100n);
   */
  async estimateSwapFee(
    pairAddress: string,
    amountIn: bigint,
  ): Promise<{ feeBps: number; feeAmount: bigint }> {
    validateAddress(pairAddress, "pairAddress");
    validatePositiveAmount(amountIn, "amountIn");

    const pair = this.client.pair(pairAddress);
    const feeBps = await pair.getDynamicFee();
    const feeAmount = (amountIn * BigInt(feeBps)) / BigInt(10000);

    return { feeBps, feeAmount };
  }

  /**
   * Check if a pair's fee state is stale (EMA decay should be applied).
   *
   * @param pairAddress - The address of the pair contract
   * @param maxAgeSec - Maximum age before state is considered stale (defaults to 3600s)
   * @returns True if the fee state is stale
   * @example
   * const isStale = await client.fees.isStale('C...');
   */
  async isStale(
    pairAddress: string,
    maxAgeSec: number = 3600,
  ): Promise<boolean> {
    validateAddress(pairAddress, "pairAddress");
    const pair = this.client.pair(pairAddress);
    const feeState = await pair.getFeeState();
    const now = Math.floor(Date.now() / 1000);
    return now - feeState.lastUpdated > maxAgeSec;
  }

  /**
   * Get the factory-level fee parameters (protocol-wide).
   *
   * @returns Global constraints and parameters for the protocol fee engine
   * @example
   * const params = await client.fees.getProtocolFeeParams();
   */
  async getProtocolFeeParams(): Promise<{
    feeMin: number;
    feeMax: number;
    emaAlpha: number;
    flashFeeBps: number;
  }> {
    return this.client.factory.getFeeParameters();
  }

  /**
   * Compare fees across multiple pairs for arbitrage detection.
   *
   * @param pairAddresses - Array of pair contract addresses to inspect
   * @returns An array of fee estimates for the requested pairs
   * @example
   * const estimates = await client.fees.compareFees(['C...', 'C...']);
   */
  async compareFees(pairAddresses: string[]): Promise<FeeEstimate[]> {
    return Promise.all(pairAddresses.map((addr) => this.getCurrentFee(addr)));
  }

  /**
   * Get historical fee revenue for a pair by querying on-chain swap events.
   *
   * Reads swap events through the shared {@link TypedEventCursor}, which
   * paginates past any single-page RPC limit so the full requested ledger
   * window is covered — not just the first page.
   *
   * All fee arithmetic is BigInt-safe: the exact fee for every swap is kept
   * in stroop-level units (`feeStroops`), so totals remain precise even when
   * individual swaps exceed `Number.MAX_SAFE_INTEGER`. Amounts are converted
   * to display units with the **input token's own decimal precision** (the
   * decimals are read from the token contract), never a hard-coded 10^7 —
   * tokens with 6, 8, 18 or 0 decimals are all converted correctly.
   *
   * @param pairAddress - The address of the pair contract
   * @param options - Optional ledger range and per-request page limit
   * @returns Aggregated fee revenue (exact BigInt totals + display values)
   * @example
   * const revenue = await client.fees.getFeeRevenue('C...');
   * console.log(revenue.byToken[0].totalFeeFormatted, revenue.totalFeeXLM);
   */
  async getFeeRevenue(
    pairAddress: string,
    options: {
      fromLedger?: number;
      toLedger?: number;
      limit?: number;
    } = {},
  ): Promise<FeeRevenue> {
    validateAddress(pairAddress, "pairAddress");
    this.validateRevenueWindow(options);

    const limit = options.limit ?? DEFAULT_REVENUE_EVENT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new ValidationError(
        `limit must be a positive integer, got ${options.limit}`,
        { field: "limit", constraint: "positive integer", actual: options.limit },
      );
    }

    const currentLedger = await this.client.getCurrentLedger();
    const fromLedger =
      options.fromLedger ?? Math.max(0, currentLedger - DEFAULT_REVENUE_WINDOW_LEDGERS);
    const toLedger = options.toLedger ?? currentLedger;
    // Reference head for approximating an event's wall-clock time when the
    // event omits `ledgerClosedAt`. The chain head is ~now.
    const head: LedgerHead = {
      ledger: currentLedger,
      closeTime: Math.floor(Date.now() / 1000),
    };

    // The shared cursor base64-encodes the "swap" topic (RPC rejects bare
    // strings) and follows page cursors so windows past one page are counted.
    const cursor = new TypedEventCursor(this.client.server, pairAddress, ["swap"]);
    const events = await cursor.scan({
      fromLedger,
      toLedger,
      limit: Math.min(limit, REVENUE_PAGE_SIZE),
    });

    const swaps: SwapEvent[] = [];
    for (const event of events) {
      if (event.type !== "swap") continue;
      const swap = event as SwapEvent;
      // The final page can run past toLedger; getEvents has no end bound.
      if (swap.ledger > toLedger || swap.feeBps <= 0) continue;
      swaps.push(swap);
    }
    const swapResult = await cursor.scan({
      fromLedger,
      toLedger,
      limit: this.revenuePageLimit(options.limit),
    });

    // Surface a warning when the page hit the limit so callers know the
    // revenue window was capped. Use swapResult.pageInfo.nextCursor to
    // resume from the exact position in subsequent requests.
    if (swapResult.hasNextPage) {
      const logger = (this.client as any).logger;
      if (logger && typeof logger.warn === 'function') {
        logger.warn(
          'FeeModule.getFeeRevenue: result set was capped — use a smaller ' +
          'window or pass a lower limit and resume with pageInfo.nextCursor',
          { nextCursor: swapResult.pageInfo.nextCursor, pairAddress },
        );
      }
    }

    const swapEvents = swapResult as unknown as SwapEvent[];

    let totalFeeStroops = 0n;
    const totalsByToken = new Map<string, bigint>();
    const history: FeeRevenueEvent[] = [];

    for (const event of swapEvents) {
      // The final page may run past toLedger; getEvents has no end bound.
      if (event.ledger > toLedger) continue;

    // Resolve every distinct input token's decimals once, then price each fee
    // at the decimals of the token it was charged in.
    const decimalsByToken = new Map<string, number>();
    await Promise.all(
      [...new Set(swaps.map((swap) => swap.tokenIn))].map(async (token) => {
        decimalsByToken.set(token, await getTokenDecimals(this.client, token));
      }),
    );

    const history: FeeRevenueEntry[] = [];
    const byToken = new Map<string, FeeRevenueTokenTotal>();
    let totalFeeAmount = 0n;
    let totalFeeXLM = 0;

    for (const swap of swaps.slice(0, limit)) {
      const decimals = decimalsByToken.get(swap.tokenIn) ?? FALLBACK_TOKEN_DECIMALS;
      const feeAmount = (swap.amountIn * BigInt(swap.feeBps)) / 10_000n;
      const feeXLM = Number(feeAmount) / 10 ** decimals;

      history.push({
        ledger: swap.ledger,
        timestamp: swap.timestamp || ledgerToApproxTime(swap.ledger, head),
        feeBps: swap.feeBps,
        tokenIn: swap.tokenIn,
        decimals,
        feeAmount,
        feeFormatted: fromSorobanAmount(feeAmount, decimals),
        feeXLM,
      });

      let tokenTotal = byToken.get(swap.tokenIn);
      if (!tokenTotal) {
        tokenTotal = {
          token: swap.tokenIn,
          decimals,
          swapCount: 0,
          totalFeeAmount: 0n,
          totalFeeFormatted: "",
          totalFeeXLM: 0,
        };
        byToken.set(swap.tokenIn, tokenTotal);
      }
      tokenTotal.swapCount += 1;
      tokenTotal.totalFeeAmount += feeAmount;
      tokenTotal.totalFeeXLM += feeXLM;

      totalFeeAmount += feeAmount;
      totalFeeXLM += feeXLM;
    }

    for (const tokenTotal of byToken.values()) {
      tokenTotal.totalFeeFormatted = fromSorobanAmount(
        tokenTotal.totalFeeAmount,
        tokenTotal.decimals,
      );
    }

    const totalFeeByToken: FeeRevenueByToken[] = [];
    for (const [token, feeStroops] of totalsByToken.entries()) {
      // Memoised — already resolved for every token seen in the loop above.
      const decimals = await this.getTokenDecimals(token);
      totalFeeByToken.push({
        token,
        decimals,
        feeStroops,
        feeDisplay: Number(feeStroops) / Math.pow(10, decimals),
      });
    }
    totalFeeByToken.sort((a, b) =>
      b.feeStroops === a.feeStroops ? a.token.localeCompare(b.token) : b.feeStroops > a.feeStroops ? 1 : -1,
    );

    // Display-only total: each event is converted with its own token's
    // decimals, so the sum matches the per-token breakdown.
    const totalFeeXLM = totalFeeByToken.reduce((sum, t) => sum + t.feeDisplay, 0);

    return {
      pairAddress,
      totalFeeStroops,
      totalFeeXLM,
      totalFeeByToken,
      swapCount: history.length,
      totalFeeAmount,
      totalFeeXLM,
      byToken: [...byToken.values()],
      history,
    };
  }

  /**
   * Calculate the LP yield for an address in a pair over a given period.
   *
   * Pool value and fee share are decimals-aware: each reserve is divided by
   * its own token's on-chain decimals and the fee share comes from the
   * stroop-exact aggregation in {@link getFeeRevenue}, so a 6- or 12-decimal
   * pool prices correctly instead of assuming XLM's 7.
   * The LP's share of the pool is computed in BigInt (scaled by 10^12) so
   * positions with balances above 2^53 are compared exactly; reserve and fee
   * conversions use each token's own decimal precision instead of a
   * hard-coded 10^7.
   *
   * @param pairAddress - The address of the pair contract
   * @param lpAddress - The LP token holder address
   * @param options - Optional ledger range
   * @returns LP yield metrics including APR, fee share and the token decimals used
   */
  async getLPYield(
    pairAddress: string,
    lpAddress: string,
    options: {
      fromLedger?: number;
      toLedger?: number;
    } = {},
  ): Promise<{
    pairAddress: string;
    lpAddress: string;
    totalFeeRevenueXLM: number;
    lpSharePercent: number;
    lpFeeShareXLM: number;
    lpValueXLM: number;
    aprPercent: number;
    /** Decimals read from each pool token's on-chain metadata; `lpValueXLM` is computed from these, not from a hardcoded 7-decimal assumption */
    decimals: { token0: number; token1: number };
  }> {
  ): Promise<LPYieldResult> {
    validateAddress(pairAddress, "pairAddress");
    validateAddress(lpAddress, "lpAddress");

    const pair = this.client.pair(pairAddress);
    const lpTokenAddr = await pair.getLPTokenAddress();
    const lpToken = this.client.lpToken(lpTokenAddr);

    const [lpBalance, totalSupply, { reserve0, reserve1 }, { token0, token1 }] =
      await Promise.all([
        lpToken.balance(lpAddress),
        lpToken.totalSupply(),
        pair.getReserves(),
        pair.getTokens(),
      ]);

    const feeRevenue = await this.getFeeRevenue(pairAddress, options);
    const [decimals0, decimals1] = await Promise.all([
      getTokenDecimals(this.client, token0),
      getTokenDecimals(this.client, token1),
    ]);
    const decimals = { token0: decimals0, token1: decimals1 };

    if (totalSupply === 0n || lpBalance === 0n) {
      return {
        pairAddress,
        lpAddress,
        totalFeeRevenueStroops: feeRevenue.totalFeeStroops,
        totalFeeRevenueXLM: feeRevenue.totalFeeXLM,
        lpSharePercent: 0,
        lpFeeShareXLM: 0,
        lpValueXLM: 0,
        aprPercent: 0,
        decimals,
      };
    }

    const lpSharePercent = (Number(lpBalance) / Number(totalSupply)) * 100;
    const lpFeeShareXLM = feeRevenue.totalFeeXLM * (lpSharePercent / 100);
    // Each side of the pool is denominated in its own token, so each reserve is
    // divided by its own token's decimals before the two are summed.
    const lpValueXLM =
      (Number(reserve0) / 10 ** decimals0 + Number(reserve1) / 10 ** decimals1) *
      (Number(lpBalance) / Number(totalSupply));

    const currentLedger = await this.client.getCurrentLedger();
    const fromLedger =
      options.fromLedger ?? Math.max(0, currentLedger - DEFAULT_REVENUE_WINDOW_LEDGERS);
    const toLedger = options.toLedger ?? currentLedger;
    // Approximate the queried window in seconds via the shared ledger-time
    // helper (the reference close time cancels out of the difference).
    const periodSeconds = ledgerToApproxTime(toLedger, { ledger: fromLedger, closeTime: 0 });
    const daysInPeriod = periodSeconds / 86400;
    const aprPercent =
      daysInPeriod > 0 && lpValueXLM > 0
        ? (lpFeeShareXLM / lpValueXLM) * (365 / daysInPeriod) * 100
        : 0;

    return {
      pairAddress,
      lpAddress,
      totalFeeRevenueStroops: feeRevenue.totalFeeStroops,
      totalFeeRevenueXLM: feeRevenue.totalFeeXLM,
      lpSharePercent,
      lpFeeShareXLM,
      lpValueXLM,
      aprPercent,
      decimals,
    };
  }

  /**
   * Get comprehensive fee estimates combining gas estimation and ledger fee info.
   *
   * This convenience method returns gas fees, protocol fees, and total fees
   * in a single typed object, saving developers from manually assembling
   * fee information from multiple sources.
   *
   * @param operations - The operations to estimate fees for
   * @param options - Optional parameters
   * @returns Detailed fee estimates including gas, protocol fees, and total
   *
   * @example
   * const fees = await client.fees.getFeeEstimates(swapOps);
   * console.log(fees.totalXLM); // "0.00015 XLM"
   * console.log(fees.breakdown.gas.xlm); // "0.00010 XLM"
   * console.log(fees.breakdown.protocol.xlm); // "0.00005 XLM"
   */
  async getFeeEstimates(
    operations: xdr.Operation[],
    _options: {
      feeMultiplier?: number;
    } = {},
  ): Promise<FeeEstimates> {
    const gasEstimate = await estimateGas(
      (ops) => this.client.simulateTransaction(ops, {}),
      operations,
    );

    const ledger = await this.client.getCurrentLedger();

    let protocolFeeBps = 0;
    let protocolFeeStroops = 0;

    try {
      const pairAddress = this.extractPairAddress(operations);
      if (pairAddress) {
        const feeState = await this.getFeeState(pairAddress);
        protocolFeeBps = feeState.feeCurrent || 0;
        protocolFeeStroops = Math.floor(gasEstimate.fee * (protocolFeeBps / 10000));
      }
    } catch {
      protocolFeeBps = 0;
      protocolFeeStroops = 0;
    }

    const totalStroops = gasEstimate.fee + protocolFeeStroops;
    const totalXLM = `${(totalStroops / 10000000).toFixed(5)} XLM`;

    const breakdown = {
      gas: {
        stroops: gasEstimate.fee,
        xlm: gasEstimate.feeXLM,
      },
      protocol: {
        bps: protocolFeeBps,
        stroops: protocolFeeStroops,
        xlm: `${(protocolFeeStroops / 10000000).toFixed(5)} XLM`,
      },
    };

    let resources = undefined;
    try {
      const sim = await this.client.simulateTransaction(operations, {});
      if (sim.success && sim.transactionData) {
        const { instructions, diskReadBytes, writeBytes } = sim.transactionData.resources;
        resources = { instructions, readBytes: diskReadBytes, writeBytes };
      }
    } catch {
      // Resources not available
    }

    return {
      gas: gasEstimate,
      protocolFeeBps,
      protocolFeeStroops,
      totalStroops,
      totalXLM,
      ledger,
      resources,
      breakdown,
    };
  }

  // ---------------------------------------------------------------------------
  // Revenue helpers
  // ---------------------------------------------------------------------------

  /** Memoised per-token decimal precision, read once from the token contract. */
  private decimalsCache = new Map<string, number>();

  /**
   * Read a token's decimal precision from its contract (memoised).
   *
   * The `decimals()` call is simulated read-only against the well-known
   * zero-balance account, so no funds or signer are required. On any failure
   * (unsupported token contract, RPC error) it falls back to 7 — the Stellar
   * convention — so aggregation never throws on odd tokens.
   *
   * @param tokenAddress - The Soroban contract address of the token.
   * @returns The token's decimal precision (0-18), defaulting to 7.
   */
  private async getTokenDecimals(tokenAddress: string): Promise<number> {
    const cached = this.decimalsCache.get(tokenAddress);
    if (cached !== undefined) return cached;

    try {
      const op = new Contract(tokenAddress).call("decimals");
      const result = await this.simulateTokenRead(op);
      const decimals = result ? decodeU32(result) : 7;
      const safe = Number.isInteger(decimals) && decimals >= 0 && decimals <= 18 ? decimals : 7;
      this.decimalsCache.set(tokenAddress, safe);
      return safe;
    } catch {
      this.decimalsCache.set(tokenAddress, 7);
      return 7;
    }
  }

  /**
   * Simulate a read-only contract call against a token contract.
   *
   * The well-known zero-balance account funds the simulation, so no signer
   * is needed. No retry/circuit-breaker layer is applied: this read is
   * best-effort (callers fall back to 7 decimals) and must not poison a
   * shared breaker state for unrelated calls.
   */
  private async simulateTokenRead(op: xdr.Operation): Promise<xdr.ScVal | null> {
    const server = this.client.server;

    const account = await server.getAccount(
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    );
    const tx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: this.client.networkConfig.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationSuccess(sim) && sim.result) {
      return sim.result.retval;
    }
    return null;
  }

  /** Validate the caller-supplied revenue window (ledger range / page limit). */
  private validateRevenueWindow(options: { fromLedger?: number; toLedger?: number; limit?: number }): void {
    if (
      options.fromLedger !== undefined &&
      (!Number.isInteger(options.fromLedger) || options.fromLedger < 0)
    ) {
      throw new ValidationError(
        `fromLedger must be a non-negative integer, got ${options.fromLedger}`,
      );
    }
    if (
      options.toLedger !== undefined &&
      (!Number.isInteger(options.toLedger) || options.toLedger < 0)
    ) {
      throw new ValidationError(
        `toLedger must be a non-negative integer, got ${options.toLedger}`,
      );
    }
    if (
      options.fromLedger !== undefined &&
      options.toLedger !== undefined &&
      options.fromLedger > options.toLedger
    ) {
      throw new ValidationError(
        `fromLedger (${options.fromLedger}) must not exceed toLedger (${options.toLedger})`,
      );
    }
    if (options.limit !== undefined) {
      if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > MAX_EVENT_LIMIT) {
        throw new ValidationError(
          `limit must be an integer between 1 and ${MAX_EVENT_LIMIT}, got ${options.limit}`,
        );
      }
    }
  }

  /** Clamp the page limit to the cursor's supported range. */
  private revenuePageLimit(limit?: number): number {
    return limit ?? FeeModule.DEFAULT_REVENUE_PAGE_LIMIT;
  }

  /**
   * Approximate the wall-clock timestamp of a ledger from the chain head.
   * Used when an event response carries no usable `ledgerClosedAt`.
   */
  private ledgerTimestamp(ledger: number, currentLedger: number): number {
    const head: LedgerHead = {
      ledger: currentLedger,
      closeTime: Math.floor(Date.now() / 1000),
    };
    return ledgerToApproxTime(ledger, head);
  }

  /**
   * Extract the pair address from operations (simplified helper).
   * @private
   */
  private extractPairAddress(_operations: xdr.Operation[]): string | null {
    return null;
  }
}
