/**
 * Types for the CoralSwap portfolio module.
 *
 * These interfaces model the data returned by {@link PortfolioModule} methods
 * and the snapshot/PnL workflow for tracking LP position performance over time.
 *
 * ## Typical workflow
 *
 * ```
 * getPortfolio()      → Portfolio
 *      ↓
 * createSnapshot()    → PortfolioEntrySnapshot   (persist this as cost basis)
 *      ↓ (time passes)
 * getPortfolioPnL()   → PortfolioPnL
 * ```
 *
 * All USD values use spot prices derived from on-chain pair reserves anchored
 * to caller-supplied stablecoins. The Stellar fixed-point scalar (`1e7`) is
 * applied internally so all amounts here are expressed in **stroops** (`bigint`)
 * while valuations are in **floating-point USD** (`number`).
 *
 * @module portfolio-types
 */

/**
 * A single LP position within a portfolio, valued in USD.
 *
 * Represents the caller's proportional share of one CoralSwap pool,
 * computed by scaling the pool's reserves by the ratio of the caller's
 * LP token balance to the pool's total LP supply.
 *
 * ### Implied amounts formula
 *
 * ```
 * token0Amount = reserve0 × (lpBalance / totalSupply)
 * token1Amount = reserve1 × (lpBalance / totalSupply)
 * ```
 *
 * ### USD valuation formula
 *
 * ```
 * valueUSD = (token0Amount / 1e7) × price0
 *          + (token1Amount / 1e7) × price1
 * ```
 *
 * where `price0` and `price1` are spot prices derived from stablecoin-paired
 * pool reserves at the time of the query.
 */
export interface PortfolioPosition {
  /**
   * Soroban contract address of the pair (pool) for this position.
   * Use this as a key to look up reserves, tokens, or fee history.
   */
  pairAddress: string;

  /**
   * Soroban contract address of the LP token issued by this pair.
   * Pass to `client.lpToken(lpTokenAddress)` to query balance or metadata.
   */
  lpTokenAddress: string;

  /**
   * Contract address of the first token in the pair (token 0).
   * Ordering matches the pair contract's internal token ordering.
   */
  token0: string;

  /**
   * Contract address of the second token in the pair (token 1).
   * Ordering matches the pair contract's internal token ordering.
   */
  token1: string;

  /**
   * LP token balance held by the owner, in stroops (`1e-7` LP tokens per unit).
   * Divide by `1e7` to obtain a human-readable LP token amount.
   */
  lpBalance: bigint;

  /**
   * Implied amount of token 0 belonging to the owner, in stroops.
   * Computed as `reserve0 × (lpBalance / totalSupply)`.
   * Divide by `1e7` for a decimal token amount.
   */
  token0Amount: bigint;

  /**
   * Implied amount of token 1 belonging to the owner, in stroops.
   * Computed as `reserve1 × (lpBalance / totalSupply)`.
   * Divide by `1e7` for a decimal token amount.
   */
  token1Amount: bigint;

  /**
   * Estimated USD value of this position at the time of the query.
   *
   * Calculated using spot prices anchored to the stablecoins configured
   * at module construction. Will be `0` if no stablecoin addresses were
   * provided or if the token has no stablecoin-paired pool.
   */
  valueUSD: number;
}

/**
 * Aggregated portfolio view for an address across all (or selected)
 * CoralSwap pools.
 *
 * Returned by {@link PortfolioModule.getPortfolio} and
 * {@link PortfolioModule.get}. Only pools where the owner holds a
 * non-zero LP balance are included in `positions`.
 *
 * @example
 * ```ts
 * const view: Portfolio = await portfolio.getPortfolio("GOWNER...");
 *
 * view.positions.forEach((p) => {
 *   console.log(`Pool ${p.pairAddress}: $${p.valueUSD.toFixed(2)}`);
 * });
 * console.log(`Total: $${view.totalValueUSD.toFixed(2)}`);
 * ```
 */
export interface Portfolio {
  /**
   * The Stellar address that was queried.
   * Matches the `owner` argument passed to {@link PortfolioModule.getPortfolio}.
   */
  owner: string;

  /**
   * All non-zero LP positions held by `owner` at query time.
   * Positions with a zero LP balance are excluded.
   */
  positions: PortfolioPosition[];

  /**
   * Sum of all `position.valueUSD` values.
   *
   * Represents the total estimated USD value of the portfolio at the
   * time of the query. Will be `0` if no stablecoin anchors are configured.
   */
  totalValueUSD: number;
}

/**
 * Immutable snapshot of portfolio state captured at a single point in time.
 *
 * Used as the **cost basis** (entry point) for PnL calculations. Create a
 * snapshot immediately after providing liquidity and persist it; then pass
 * it to {@link PortfolioModule.getPortfolioPnL} at any later time to measure
 * returns.
 *
 * ### Snapshot vs. live portfolio
 *
 * A snapshot does **not** re-fetch on-chain data — it freezes the state of
 * a previously resolved {@link Portfolio}. The `capturedAt` timestamp
 * indicates when the source portfolio was resolved.
 *
 * @example
 * ```ts
 * const view = await portfolio.getPortfolio("GOWNER...");
 * const snapshot = portfolio.createSnapshot(view);
 *
 * // Persist snapshot for later comparison
 * localStorage.setItem("entry", JSON.stringify(snapshot));
 * ```
 */
export interface PortfolioEntrySnapshot {
  /**
   * Stellar address of the portfolio owner.
   * Copied from the source {@link Portfolio.owner}.
   */
  owner: string;

  /**
   * Total USD portfolio value at the moment the snapshot was captured.
   * This is the **cost basis** against which PnL is measured.
   */
  totalValueUSD: number;

  /**
   * Per-pool position breakdown recorded at snapshot time.
   *
   * Only includes the fields needed for PnL comparison. Use this to
   * understand how much of each token was in each pool at entry.
   */
  positions: Array<{
    /** Pair contract address identifying the pool. */
    pairAddress: string;
    /** Token 0 amount (stroops) at snapshot time. */
    token0Amount: bigint;
    /** Token 1 amount (stroops) at snapshot time. */
    token1Amount: bigint;
    /** USD value of this position at snapshot time. */
    valueUSD: number;
  }>;

  /**
   * Unix timestamp (seconds since epoch) when the snapshot was created.
   * Set automatically by {@link PortfolioModule.createSnapshot}.
   */
  capturedAt: number;
}

/**
 * Profit and loss result relative to a prior entry snapshot.
 *
 * Returned by {@link PortfolioModule.getPortfolioPnL}. All values are in USD.
 *
 * ### Formulas
 *
 * ```
 * pnlUSD     = currentValueUSD − entryValueUSD
 * pnlPercent = (pnlUSD / entryValueUSD) × 100
 * ```
 *
 * `pnlPercent` is `0` when `entryValueUSD` is zero to avoid division by zero.
 *
 * ### Impermanent loss
 *
 * Impermanent loss is **not** reported as a separate field. Because
 * `currentValueUSD` is derived from live on-chain reserves, any divergence in
 * the pair's price ratio since the snapshot is already embedded in `pnlUSD`.
 * To isolate IL, compare `pnlUSD` against the hypothetical HODL value of the
 * tokens at current prices.
 *
 * @example
 * ```ts
 * const pnl: PortfolioPnL = await portfolio.getPortfolioPnL("GOWNER...", snapshot);
 *
 * const direction = pnl.pnlUSD >= 0 ? "profit" : "loss";
 * console.log(
 *   `${direction}: $${Math.abs(pnl.pnlUSD).toFixed(2)} ` +
 *   `(${pnl.pnlPercent.toFixed(2)}%)`
 * );
 * ```
 */
export interface PortfolioPnL {
  /**
   * USD portfolio value recorded in the entry snapshot (cost basis).
   * Equal to `PortfolioEntrySnapshot.totalValueUSD`.
   */
  entryValueUSD: number;

  /**
   * USD portfolio value at the time {@link PortfolioModule.getPortfolioPnL}
   * was called, fetched live from on-chain state.
   */
  currentValueUSD: number;

  /**
   * Absolute profit or loss in USD.
   *
   * Positive values indicate a gain; negative values indicate a loss.
   * Embeds any impermanent loss from pool price ratio divergence.
   */
  pnlUSD: number;

  /**
   * Percentage profit or loss relative to `entryValueUSD`.
   *
   * Computed as `(pnlUSD / entryValueUSD) × 100`. Returns `0` when
   * `entryValueUSD` is zero.
   */
  pnlPercent: number;
}

/**
 * Options for {@link PortfolioModule.getPortfolio} and
 * {@link PortfolioModule.get}.
 *
 * @example
 * ```ts
 * // Restrict the portfolio query to two specific pools
 * const view = await portfolio.getPortfolio("GOWNER...", {
 *   pairAddresses: ["CPAIR_A...", "CPAIR_B..."],
 * });
 * ```
 */
export interface GetPortfolioOptions {
  /**
   * Restrict the query to this subset of pair contract addresses.
   *
   * When provided, only these pools are checked for LP balances and used
   * to build the spot price map. When omitted (or empty), all pairs
   * registered in the Factory contract are included.
   *
   * Providing a filtered list significantly reduces RPC call volume for
   * wallets with known positions.
   */
  pairAddresses?: string[];
}
