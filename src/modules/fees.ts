import { CoralSwapClient } from "@/client";
import { FeeEstimate } from "@/types/fee";
import { FeeState } from "@/types/pool";
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
}
