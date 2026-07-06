import { LPPosition } from "./pool";

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