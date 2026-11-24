/**
 * Gas / fee estimate returned by estimateGas() and the estimateOnly option.
 */
export interface GasEstimate {
  /**
   * Fee in stroops (the smallest XLM unit), kept as a BigInt so values
   * above 2^53 survive without precision loss.
   */
  fee: bigint;
  /** The exact stroop string returned by the simulation (`minResourceFee`). */
  feeRaw: string;
  /** Human-readable fee string, e.g. "0.00001 XLM". */
  feeXLM: string;
  /** Optional USD equivalent of the fee (requires a price feed). */
  feeUSD?: number;
}
