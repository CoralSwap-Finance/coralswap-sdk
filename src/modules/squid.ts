import { CoralSwapClient } from "@/client";
import { CrossChainError, ValidationError } from "@/errors";
import { validateAddress, validatePositiveAmount } from "@/utils/validation";
import { DEFAULTS } from "@/config";
import { isRetryable } from "@/utils/retry";
import {
  getTransactionStatus,
  shouldRetrySubmission,
} from "@/utils/idempotent-resubmission";
import {
  CrossChainQuote,
  CrossChainQuoteParams,
  CrossChainRouteStep,
  CrossChainSwapResult,
  SquidModuleOptions,
  SquidRouteStatusResult,
} from "@/types/squid";

const DEFAULT_SQUID_API_BASE_URL = "https://apiplus.squidrouter.com/v2";
const STELLAR_CHAIN_ID = "stellar";

interface SquidRouteApiResponse {
  routeId?: string;
  toToken?: string;
  toAmount?: string;
  toAmountMin?: string;
  feeCosts?: Array<{ amount?: string; name?: string }>;
  estimatedRouteDuration?: number;
  calldata?: { target?: string; data?: string; value?: string };
}

interface SquidStatusApiResponse {
  status?: string;
  toChain?: { transactionHash?: string };
}

/**
 * Cross-chain swap execution via the Squid Router aggregator.
 *
 * Bridges assets from any Squid-supported chain into Stellar, then routes
 * the bridged funds through the CoralSwap Router. When `fromChain` is
 * already Stellar the bridge leg is bypassed automatically and the request
 * becomes a plain on-chain swap.
 *
 * ## Idempotent resubmission
 *
 * Execution has two independent points of failure: the Squid API call for
 * the bridge leg, and the Soroban transaction submission for the swap leg.
 * A timeout at either point does not mean the underlying operation failed
 * -- the bridge transfer may already be in flight/landed, or the Soroban
 * transaction may already be included in a ledger. On a retryable failure
 * this module always checks the real tracked/on-chain status first:
 *
 * - Bridge leg: queries Squid's `/status` endpoint for the route. A
 *   `success`/`ongoing` result means the transfer already landed or is in
 *   flight, so it is returned as-is rather than resubmitted.
 * - Swap leg: uses the shared {@link getTransactionStatus} /
 *   {@link shouldRetrySubmission} utility against the Soroban RPC.
 *
 * Only a status that genuinely shows "never landed" triggers a resubmit.
 */
export class SquidModule {
  private client: CoralSwapClient;
  private readonly apiBaseUrl: string;
  private readonly integratorId?: string;
  private readonly apiKey?: string;
  private readonly fetchFn: typeof fetch;

  constructor(client: CoralSwapClient, options: SquidModuleOptions = {}) {
    this.client = client;
    this.apiBaseUrl = options.apiBaseUrl ?? DEFAULT_SQUID_API_BASE_URL;
    this.integratorId = options.integratorId;
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  /**
   * Fetch a cross-chain quote. When `params.fromChain` is Stellar, returns
   * a bridge-free quote for a direct CoralSwap swap.
   *
   * @throws {ValidationError} If required parameters are missing/invalid.
   * @throws {CrossChainError} If the Squid API request fails.
   */
  async getCrossChainQuote(params: CrossChainQuoteParams): Promise<CrossChainQuote> {
    validateAddress(params.toAsset, "toAsset");
    validatePositiveAmount(params.amount, "amount");
    if (!params.fromAsset || params.fromAsset.trim().length === 0) {
      throw new ValidationError("fromAsset must not be empty");
    }
    if (!params.fromChain || params.fromChain.trim().length === 0) {
      throw new ValidationError("fromChain must not be empty");
    }

    const toAddress = params.toAddress ?? this.client.publicKey;
    const slippageBps = params.slippageBps ?? DEFAULTS.slippageBps;

    if (this.isStellarNative(params.fromChain)) {
      const steps: CrossChainRouteStep[] = [
        {
          type: "swap",
          chain: STELLAR_CHAIN_ID,
          description: `Swap ${params.fromAsset} -> ${params.toAsset} on CoralSwap`,
        },
      ];

      return {
        routeId: `native:${params.fromAsset}:${params.toAsset}:${params.amount.toString()}:${Date.now()}`,
        isStellarNative: true,
        fromChain: params.fromChain,
        fromAsset: params.fromAsset,
        bridgedAsset: params.fromAsset,
        toAsset: params.toAsset,
        amountIn: params.amount,
        bridgedAmount: params.amount,
        estimatedAmountOut: params.amount,
        amountOutMin: params.amount - (params.amount * BigInt(slippageBps)) / 10_000n,
        bridgeFee: 0n,
        swapFee: 0n,
        totalSlippageBps: slippageBps,
        estimatedTimeSeconds: 0,
        deadline: this.client.getDeadline(),
        steps,
      };
    }

    return this.fetchRoute(params, toAddress, slippageBps);
  }

  /**
   * Execute a previously fetched cross-chain quote.
   *
   * Submits the bridge leg (unless Stellar-native) and the CoralSwap swap
   * leg. Both legs use idempotent resubmission: a retryable failure checks
   * real tracked status before ever resubmitting.
   *
   * @throws {CrossChainError} If either leg genuinely fails (not just times out).
   */
  async executeCrossChainSwap(
    quote: CrossChainQuote,
    options: { source?: string } = {},
  ): Promise<CrossChainSwapResult> {
    let bridgeTxHash: string | undefined;

    if (!quote.isStellarNative) {
      bridgeTxHash = await this.submitBridgeLegIdempotent(quote);
    }

    const swapLeg = await this.submitSwapLegIdempotent(quote, options.source);

    return {
      bridgeTxHash,
      swapTxHash: swapLeg.txHash,
      ledger: swapLeg.ledger,
    };
  }

  private isStellarNative(fromChain: string): boolean {
    return fromChain.trim().toLowerCase() === STELLAR_CHAIN_ID;
  }

  // ---------------------------------------------------------------------
  // Bridge leg (Squid API) -- idempotent via Squid's tracked route status
  // ---------------------------------------------------------------------

  private async submitBridgeLegIdempotent(quote: CrossChainQuote): Promise<string> {
    try {
      return await this.postRoute(quote);
    } catch (err) {
      if (err instanceof CrossChainError || !isRetryable(err)) {
        throw this.toCrossChainError("Bridge submission failed", err, quote.routeId);
      }

      // Retryable failure (timeout, connection reset, 429/503): check Squid's
      // tracked status before resubmitting -- a blind retry here would risk
      // duplicating a real bridge transfer.
      const status = await this.getSquidRouteStatus(quote.routeId);

      if (status.status === "success" || status.status === "ongoing") {
        if (!status.bridgeTxHash) {
          throw new CrossChainError(
            "Bridge transfer is tracked as landed but Squid returned no transaction hash",
            { routeId: quote.routeId, status: status.status },
          );
        }
        return status.bridgeTxHash;
      }

      if (status.status === "failed") {
        throw new CrossChainError("Bridge execution failed on the source chain", {
          routeId: quote.routeId,
        });
      }

      // "not_found" / "unknown" -- Squid never saw it land; safe to resubmit once.
      try {
        return await this.postRoute(quote);
      } catch (retryErr) {
        throw this.toCrossChainError("Bridge submission failed after retry", retryErr, quote.routeId);
      }
    }
  }

  private async postRoute(quote: CrossChainQuote): Promise<string> {
    const res = await this.fetchFn(
      `${this.apiBaseUrl}/route/${encodeURIComponent(quote.routeId)}/execute`,
      {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify({ calldata: quote.bridgeCalldata }),
      },
    );

    if (!res.ok) {
      const err: Error & { response?: { status: number } } = new Error(
        `Squid route execution request failed with status ${res.status}`,
      );
      err.response = { status: res.status };
      throw err;
    }

    const body = (await res.json()) as { transactionHash?: string };
    if (!body.transactionHash) {
      throw new CrossChainError("Squid route execution response is missing a transaction hash", {
        routeId: quote.routeId,
      });
    }
    return body.transactionHash;
  }

  private async getSquidRouteStatus(routeId: string): Promise<SquidRouteStatusResult> {
    try {
      const res = await this.fetchFn(
        `${this.apiBaseUrl}/status?routeId=${encodeURIComponent(routeId)}`,
        { headers: this.buildHeaders() },
      );

      if (!res.ok) {
        return { status: "unknown" };
      }

      const body = (await res.json()) as SquidStatusApiResponse;
      const bridgeTxHash = body.toChain?.transactionHash;

      switch (body.status) {
        case "success":
          return { status: "success", bridgeTxHash };
        case "ongoing":
        case "needs_gas":
          return { status: "ongoing", bridgeTxHash };
        case "failed":
          return { status: "failed" };
        default:
          return { status: "not_found" };
      }
    } catch {
      return { status: "unknown" };
    }
  }

  private async fetchRoute(
    params: CrossChainQuoteParams,
    toAddress: string,
    slippageBps: number,
  ): Promise<CrossChainQuote> {
    const res = await this.fetchFn(`${this.apiBaseUrl}/route`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify({
        fromChain: params.fromChain,
        fromToken: params.fromAsset,
        toChain: STELLAR_CHAIN_ID,
        toToken: params.toAsset,
        fromAmount: params.amount.toString(),
        toAddress,
        slippageBps,
      }),
    });

    if (!res.ok) {
      throw new CrossChainError(`Squid quote request failed with status ${res.status}`, {
        fromChain: params.fromChain,
        fromAsset: params.fromAsset,
        toAsset: params.toAsset,
      });
    }

    const body = (await res.json()) as SquidRouteApiResponse;
    if (!body.routeId || !body.toAmount) {
      throw new CrossChainError("Squid quote response is missing required fields", {
        fromChain: params.fromChain,
        fromAsset: params.fromAsset,
        toAsset: params.toAsset,
      });
    }

    const bridgedAsset = body.toToken ?? params.toAsset;
    const bridgedAmount = BigInt(body.toAmount);
    const bridgeFee = (body.feeCosts ?? [])
      .filter((f) => f.name !== "swapFee")
      .reduce((acc, f) => acc + BigInt(f.amount ?? "0"), 0n);
    const swapFee = (body.feeCosts ?? [])
      .filter((f) => f.name === "swapFee")
      .reduce((acc, f) => acc + BigInt(f.amount ?? "0"), 0n);

    const estimatedAmountOut = bridgedAmount;
    const amountOutMin =
      estimatedAmountOut - (estimatedAmountOut * BigInt(slippageBps)) / 10_000n;

    const steps: CrossChainRouteStep[] = [
      {
        type: "bridge",
        chain: params.fromChain,
        description: `Bridge ${params.fromAsset} from ${params.fromChain} to Stellar`,
      },
      {
        type: "swap",
        chain: STELLAR_CHAIN_ID,
        description: `Swap ${bridgedAsset} -> ${params.toAsset} on CoralSwap`,
      },
    ];

    return {
      routeId: body.routeId,
      isStellarNative: false,
      fromChain: params.fromChain,
      fromAsset: params.fromAsset,
      bridgedAsset,
      toAsset: params.toAsset,
      amountIn: params.amount,
      bridgedAmount,
      estimatedAmountOut,
      amountOutMin,
      bridgeFee,
      swapFee,
      totalSlippageBps: slippageBps,
      estimatedTimeSeconds: body.estimatedRouteDuration ?? 0,
      deadline: this.client.getDeadline(),
      steps,
      bridgeCalldata: body.calldata?.target && body.calldata?.data
        ? {
            target: body.calldata.target,
            data: body.calldata.data,
            value: body.calldata.value,
          }
        : undefined,
    };
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.integratorId) headers["x-integrator-id"] = this.integratorId;
    if (this.apiKey) headers["x-api-key"] = this.apiKey;
    return headers;
  }

  private toCrossChainError(prefix: string, err: unknown, routeId: string): CrossChainError {
    if (err instanceof CrossChainError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new CrossChainError(`${prefix}: ${message}`, { routeId });
  }

  // ---------------------------------------------------------------------
  // Swap leg (on-chain) -- idempotent via real Soroban transaction status
  // ---------------------------------------------------------------------

  private async submitSwapLegIdempotent(
    quote: CrossChainQuote,
    source?: string,
  ): Promise<{ txHash: string; ledger: number }> {
    const op = this.buildSwapOperation(quote);
    const result = await this.client.submitTransaction([op], source);

    if (result.success) {
      return { txHash: result.txHash!, ledger: result.data!.ledger };
    }

    if (result.txHash) {
      const txStatus = await getTransactionStatus(this.client.server, result.txHash);
      const decision = shouldRetrySubmission(txStatus);

      if (!decision.shouldRetry) {
        if (txStatus.status === "SUCCESS") {
          // Timed out client-side, but the swap leg genuinely landed --
          // report it rather than resubmitting a duplicate swap.
          return { txHash: result.txHash, ledger: txStatus.ledger };
        }
        throw new CrossChainError(
          `Cross-chain swap leg failed on-chain: ${result.error?.message ?? "Transaction failed"}`,
          { routeId: quote.routeId },
          result.txHash,
        );
      }

      // Genuinely never landed -- safe to rebuild (fresh sequence number via
      // client.submitTransaction) and resubmit exactly once.
      const retryOp = this.buildSwapOperation(quote);
      const retryResult = await this.client.submitTransaction([retryOp], source);
      if (!retryResult.success) {
        throw new CrossChainError(
          `Cross-chain swap leg failed after retry: ${retryResult.error?.message ?? "Unknown error"}`,
          { routeId: quote.routeId },
          retryResult.txHash,
        );
      }
      return { txHash: retryResult.txHash!, ledger: retryResult.data!.ledger };
    }

    throw new CrossChainError(
      `Cross-chain swap leg failed: ${result.error?.message ?? "Unknown error"}`,
      { routeId: quote.routeId },
    );
  }

  private buildSwapOperation(quote: CrossChainQuote) {
    return this.client.router.buildSwapExactIn(
      this.client.publicKey,
      quote.bridgedAsset,
      quote.toAsset,
      quote.bridgedAmount,
      quote.amountOutMin,
      quote.deadline,
    );
  }
}
