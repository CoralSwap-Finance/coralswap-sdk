import { rpc, xdr } from "@stellar/stellar-sdk";
import { CoralSwapClient } from "@/client";
import { FeeEstimate } from "@/types/fee";
import { FeeState } from "@/types/pool";
import { validateAddress, validatePositiveAmount } from "@/utils/validation";
import { getEventsPage } from "@/helpers/get-events-page";
import { MIN_START_LEDGER, decodeEventTopic } from "@/utils/event-cursor";

/**
 * Fee module -- dynamic fee transparency and estimation.
 *
 * Exposes the full dynamic fee engine state, allowing developers
 * to predict fee impacts, detect stale volatility, and analyze
 * fee history for trading strategies.
 */
export class FeeModule {
  private client: CoralSwapClient;

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
   * Reads swap events from the ledger, extracts fee amounts per swap,
   * and aggregates them into a revenue total with a per-event breakdown.
   *
   * @param pairAddress - The address of the pair contract
   * @param options - Optional ledger range and result limit
   * @returns Aggregated fee revenue and swap event breakdown
   * @example
   * const revenue = await client.fees.getFeeRevenue('C...');
   * console.log(revenue.totalFeeXLM);
   */
  async getFeeRevenue(
    pairAddress: string,
    options: {
      fromLedger?: number;
      toLedger?: number;
      limit?: number;
    } = {},
  ): Promise<{
    pairAddress: string;
    totalFeeXLM: number;
    swapCount: number;
    history: Array<{
      ledger: number;
      timestamp: number;
      feeBps: number;
      feeXLM: number;
    }>;
  }> {
    validateAddress(pairAddress, "pairAddress");

    const currentLedger = await this.client.getCurrentLedger();
    const startLedger = options.fromLedger ?? Math.max(MIN_START_LEDGER, currentLedger - 518400);
    const endLedger = options.toLedger ?? currentLedger;

    // Use the shared getEventsPage helper for pagination and proper topic encoding
    const page = await getEventsPage(this.client.server, {
      contractIds: [pairAddress],
      topics: ["swap"],
      startLedger,
      endLedger,
      limit: options.limit ?? 200,
    });

    let totalFeeXLM = 0;
    const history: Array<{
      ledger: number;
      timestamp: number;
      feeBps: number;
      feeXLM: number;
    }> = [];

    for (const event of page.events) {
      if (event.ledger > endLedger) continue;

      try {
        // Decode the XDR value (event.value is base64 XDR ScVal)
        let value: any;
        try {
          value = xdr.ScVal.fromXdr(event.value, 'base64');
        } catch {
          continue;
        }

        // Parse fee from the swap event value
        const data = decodeMapEvent(value);
        if (!data) continue;

        // Extract fee_bps and amount_in from the map
        const feeBps = readU32(data, "fee_bps");
        const amountIn = readI128(data, "amount_in");

        if (feeBps === undefined || amountIn === undefined) continue;

        const feeAmount = Number(amountIn) * feeBps / 10000;
        const feeXLM = feeAmount / 1e7;
        totalFeeXLM += feeXLM;
        history.push({
          ledger: event.ledger,
          timestamp: Math.floor(new Date(event.ledgerClosedAt).getTime() / 1000),
          feeBps,
          feeXLM,
        });
      } catch {
        continue;
      }
    }

    return {
      pairAddress,
      totalFeeXLM,
      swapCount: history.length,
      history,
    };
  }

  /**
   * Calculate the LP yield for an address in a pair over a given period.
   *
   * Computes yield as the ratio of fee revenue earned by the LP's share
   * of the pool relative to their deposited value, annualized.
   *
   * @param pairAddress - The address of the pair contract
   * @param lpAddress - The LP token holder address
   * @param options - Optional ledger range
   * @returns LP yield metrics including APR and fee share
   * @example
   * const yield_ = await client.fees.getLPYield('C...', 'G...');
   * console.log(`APR: ${yield_.aprPercent}%`);
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
  }> {
    validateAddress(pairAddress, "pairAddress");
    validateAddress(lpAddress, "lpAddress");

    const pair = this.client.pair(pairAddress);
    const lpTokenAddr = await pair.getLPTokenAddress();
    const lpToken = this.client.lpToken(lpTokenAddr);

    const [lpBalance, totalSupply, { reserve0, reserve1 }] =
      await Promise.all([
        lpToken.balance(lpAddress),
        lpToken.totalSupply(),
        pair.getReserves(),
      ]);

    const feeRevenue = await this.getFeeRevenue(pairAddress, options);

    if (totalSupply === 0n || lpBalance === 0n) {
      return {
        pairAddress,
        lpAddress,
        totalFeeRevenueXLM: feeRevenue.totalFeeXLM,
        lpSharePercent: 0,
        lpFeeShareXLM: 0,
        lpValueXLM: 0,
        aprPercent: 0,
      };
    }

    const lpSharePercent = (Number(lpBalance) / Number(totalSupply)) * 100;
    const lpFeeShareXLM = feeRevenue.totalFeeXLM * (lpSharePercent / 100);
    const lpValueXLM =
      (Number(reserve0) / 1e7 + Number(reserve1) / 1e7) *
      (Number(lpBalance) / Number(totalSupply));

    // Annualize based on the actual ledger range queried
    const currentLedger = await this.client.getCurrentLedger();
    const startLedger = options.fromLedger ?? Math.max(MIN_START_LEDGER, currentLedger - 518400);
    const endLedger = options.toLedger ?? currentLedger;
    const ledgerSpan = endLedger - startLedger;
    const daysInPeriod = (ledgerSpan * 5) / 86400; // 5s per ledger
    const aprPercent =
      daysInPeriod > 0 && lpValueXLM > 0
        ? (lpFeeShareXLM / lpValueXLM) * (365 / daysInPeriod) * 100
        : 0;

    return {
      pairAddress,
      lpAddress,
      totalFeeRevenueXLM: feeRevenue.totalFeeXLM,
      lpSharePercent,
      lpFeeShareXLM,
      lpValueXLM,
      aprPercent,
    };
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
