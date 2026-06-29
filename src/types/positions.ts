import { LPPosition } from "./pool";

/**
 * PnL breakdown for a single LP position in one pair.
 *
 * Amounts are USD values. `ilUSD` and `feeEarnedUSD` are complementary:
 * only one is non-zero at a time — fees dominate when the position grew
 * above cost basis, IL dominates when it shrank below it.
 *
 * Invariant: netPnLUSD === feeEarnedUSD - ilUSD === currentValueUSD - entryValueUSD
 *
 * Note: both entryValueUSD and currentValueUSD use the caller-supplied
 * tokenPricesUSD map evaluated at the time of the call. Without historical
 * prices the cost basis is the "HODL value at current prices" of net
 * deposited tokens, so netPnL reflects structural LP effects (fees vs IL)
 * rather than raw dollar return.
 */
export interface PositionPnL {
  /** Address of the pair contract */
  pairAddress: string;
  /** Cost basis: net deposited token amounts at current prices */
  entryValueUSD: number;
  /** Current unrealized LP position value */
  currentValueUSD: number;
  /** Fees accrued: positive when LP position grew above cost basis */
  feeEarnedUSD: number;
  /** Impermanent loss: positive when LP position fell below cost basis */
  ilUSD: number;
  /** Net P&L = currentValueUSD - entryValueUSD (= feeEarnedUSD - ilUSD) */
  netPnLUSD: number;
}

/**
 * Aggregate PnL across all LP positions for one address.
 */
export interface PortfolioPnL {
  /** Sum of netPnLUSD across all positions */
  totalPnLUSD: number;
  /** Total PnL as a percentage of total cost basis (0 when entryValue is 0) */
  totalPnLPercent: number;
  /** Per-position PnL breakdown */
  byPosition: PositionPnL[];
}

/**
 * An LP position enriched with token metadata and USD value estimates.
 */
export interface EnrichedLPPosition extends LPPosition {
  /** Address of token 0 in the pair */
  token0: string;
  /** Address of token 1 in the pair */
  token1: string;
  /** Symbol of token 0, if available */
  token0Symbol?: string;
  /** Symbol of token 1, if available */
  token1Symbol?: string;
  /** Current reserve of token 0 in the pool */
  reserve0: bigint;
  /** Current reserve of token 1 in the pool */
  reserve1: bigint;
  /** Current dynamic fee in basis points */
  feeBps: number;
}

/**
 * Options for querying LP positions.
 */
export interface GetPositionsOptions {
  /**
   * If true, include pairs where the user has zero balance.
   * Defaults to false.
   */
  includeEmpty?: boolean;
  /**
   * Specific pair addresses to query.
   * If omitted, all known pairs from the factory are queried.
   */
  pairAddresses?: string[];
}

/**
 * Summary of all LP positions held by an address.
 */
export interface PositionSummary {
  /** The queried owner address */
  owner: string;
  /** Total number of pools the owner has a position in */
  totalPools: number;
  /** All enriched positions (filtered by options) */
  positions: EnrichedLPPosition[];
}