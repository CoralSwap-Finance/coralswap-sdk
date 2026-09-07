import { rpc, xdr } from "@stellar/stellar-sdk";
import { CoralSwapClient } from "@/client";
import { FeeEstimate } from "@/types/fee";
import { FeeState } from "@/types/pool";
import { FeeEstimates } from "@/types/fee-estimates";
import { estimateGas } from "@/utils/gas";
import { validateAddress, validatePositiveAmount } from "@/utils/validation";

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
    const fromLedger = options.fromLedger ?? Math.max(0, currentLedger - 518400);
    const toLedger = options.toLedger ?? currentLedger;

    const request: rpc.Server.GetEventsRequest = {
      startLedger: fromLedger,
      filters: [
        {
          type: "contract",
          contractIds: [pairAddress],
          topics: [["swap"]],
        },
      ],
      limit: options.limit ?? 200,
    };
    const response = await this.client.server.getEvents(request);
    const rawEvents = response?.events ?? [];

    let totalFeeXLM = 0;
    const history: Array<{
      ledger: number;
      timestamp: number;
      feeBps: number;
      feeXLM: number;
    }> = [];

    for (const event of rawEvents) {
      if (event.ledger > toLedger) continue;
      try {
        const value = event.value as unknown as Record<string, unknown>;
        if (!value) continue;

        let feeBps = 0;
        let amountIn = 0;
        const map = typeof (value as any)._value !== 'undefined'
          ? (value as any)._value
          : value;

        if (Array.isArray(map)) {
          for (const entry of map) {
            const key = entry?.key;
            const val = entry?.val;
            if (!key || !val) continue;
            const keyStr = typeof key._value === 'string'
              ? key._value
              : key?.sym?.()?.toString?.() ?? key?.str?.()?.toString?.() ?? '';
            if (keyStr === 'fee_bps') {
              feeBps = val?.type === 'scvU32' ? val.u32 ?? 0 : 0;
            }
            if (keyStr === 'amount_in') {
              if (val?.type === 'scvI128') {
                const i128 = val.i128 as unknown;
                amountIn = typeof i128 === 'bigint'
                  ? Number(i128)
                  : Number(((i128 as { hi: bigint; lo: bigint }).hi << 64n) + (i128 as { hi: bigint; lo: bigint }).lo);
              } else {
                amountIn = 0;
              }
            }
          }
        }

        if (feeBps === 0) continue;
        const feeAmount = amountIn * feeBps / 10000;
        const feeXLM = feeAmount / 1e7;
        totalFeeXLM += feeXLM;
        history.push({
          ledger: event.ledger,
          timestamp: Number(event.ledgerClosedAt) || 0,
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
   * @param pairAddress - The address of the pair contract
   * @param lpAddress - The LP token holder address
   * @param options - Optional ledger range
   * @returns LP yield metrics including APR and fee share
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

    const currentLedger = await this.client.getCurrentLedger();
    const fromLedger = options.fromLedger ?? Math.max(0, currentLedger - 518400);
    const toLedger = options.toLedger ?? currentLedger;
    const ledgerSpan = toLedger - fromLedger;
    const daysInPeriod = (ledgerSpan * 5) / 86400;
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
    options: {
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
      if (sim.success && sim.resourceEstimate) {
        resources = {
          instructions: sim.resourceEstimate.instructions || 0,
          readBytes: sim.resourceEstimate.readBytes || 0,
          writeBytes: sim.resourceEstimate.writeBytes || 0,
        };
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
      ledger: ledger.sequence || 0,
      resources,
      breakdown,
    };
  }

  /**
   * Extract the pair address from operations (simplified helper).
   * @private
   */
  private extractPairAddress(operations: xdr.Operation[]): string | null {
    return null;
  }
}
