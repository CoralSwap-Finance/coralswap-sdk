import { EnrichedLPPosition, GetPositionsOptions, PositionSummary } from "./positions";

/**
 * Token prices and decimal metadata used to value an LP position.
 */
export interface PortfolioValuationOptions {
  /** Current USD price of token 0. */
  token0PriceUsd: number;
  /** Current USD price of token 1. */
  token1PriceUsd: number;
  /** Decimal places used by token 0 raw amounts. Defaults to 7. */
  token0Decimals?: number;
  /** Decimal places used by token 1 raw amounts. Defaults to 7. */
  token1Decimals?: number;
}

/**
 * Historical entry amounts and prices used as the LP position cost basis.
 */
export interface PortfolioCostBasis {
  /** Token 0 amount deposited at entry, in raw token units. */
  token0Amount: bigint;
  /** Token 1 amount deposited at entry, in raw token units. */
  token1Amount: bigint;
  /** USD price of token 0 at entry. */
  token0PriceUsd: number;
  /** USD price of token 1 at entry. */
  token1PriceUsd: number;
  /** Decimal places used by the token 0 entry amount. Defaults to 7. */
  token0Decimals?: number;
  /** Decimal places used by the token 1 entry amount. Defaults to 7. */
  token1Decimals?: number;
  /** Fees already earned or claimed for this position, denominated in USD. Defaults to 0. */
  feesEarnedUsd?: number;
}

/**
 * LP position enriched with current USD valuation fields.
 */
export interface PortfolioPosition extends EnrichedLPPosition {
  /** Current token 0 price used for valuation. */
  token0PriceUsd: number;
  /** Current token 1 price used for valuation. */
  token1PriceUsd: number;
  /** Human token 0 amount after applying decimals. */
  token0AmountDecimal: number;
  /** Human token 1 amount after applying decimals. */
  token1AmountDecimal: number;
  /** Current USD value of the token 0 side. */
  token0ValueUsd: number;
  /** Current USD value of the token 1 side. */
  token1ValueUsd: number;
  /** Current total USD value of the LP position. */
  currentValueUsd: number;
}

/**
 * Portfolio summary with aggregate USD value.
 */
export interface PortfolioSummary extends Omit<PositionSummary, "positions"> {
  /** All valued portfolio positions matching the query. */
  positions: PortfolioPosition[];
  /** Sum of `currentValueUsd` across all returned positions. */
  totalValueUsd: number;
}

/**
 * Profit-and-loss metrics for an LP position.
 */
export interface PortfolioPnL {
  /** Current USD value of the LP position. */
  currentValueUsd: number;
  /** Initial USD value of the deposited token amounts. */
  costBasisUsd: number;
  /** Current USD value if the original deposited tokens had been held outside the pool. */
  holdValueUsd: number;
  /** `currentValueUsd - costBasisUsd`, excluding fee income. */
  unrealizedPnlUsd: number;
  /** Fee income supplied by the caller, denominated in USD. */
  feesEarnedUsd: number;
  /** `unrealizedPnlUsd + feesEarnedUsd`. */
  totalPnlUsd: number;
  /** `currentValueUsd - holdValueUsd`, denominated in USD. */
  impermanentLossUsd: number;
  /** `impermanentLossUsd / holdValueUsd * 10000`. */
  impermanentLossBps: number;
  /** `unrealizedPnlUsd / costBasisUsd * 10000`. */
  unrealizedReturnBps: number;
  /** `totalPnlUsd / costBasisUsd * 10000`. */
  totalReturnBps: number;
}

/**
 * Price movement inputs for the constant-product impermanent loss formula.
 */
export interface ImpermanentLossInput {
  /** Token 0 USD price when liquidity was added. */
  token0EntryPriceUsd: number;
  /** Token 1 USD price when liquidity was added. */
  token1EntryPriceUsd: number;
  /** Current token 0 USD price. */
  token0CurrentPriceUsd: number;
  /** Current token 1 USD price. */
  token1CurrentPriceUsd: number;
}

/**
 * Impermanent loss for a balanced constant-product LP position.
 */
export interface ImpermanentLossResult {
  /** Current relative price divided by entry relative price. */
  priceRatio: number;
  /** Decimal IL ratio, e.g. `-0.0572` for -5.72%. */
  impermanentLossRatio: number;
  /** Basis-point IL ratio, e.g. `-572` for -5.72%. */
  impermanentLossBps: number;
}

/**
 * Options for querying portfolio positions.
 */
export interface GetPortfolioOptions extends GetPositionsOptions, PortfolioValuationOptions {}
