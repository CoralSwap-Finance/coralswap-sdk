import { CoralSwapClient } from "@/client";
import {
  GetPortfolioOptions,
  Portfolio,
  PortfolioEntrySnapshot,
  PortfolioPnL,
  PortfolioPosition,
} from "@/types/portfolio";
import { TreasuryModule, TreasuryModuleOptions } from "@/modules/treasury";
import { PositionsModule } from "@/modules/positions";
import { validateAddress } from "@/utils/validation";
import {
  MissingPriceFeedError,
  AddressNotFoundError,
  PortfolioCalculationError,
  CoralSwapSDKError,
} from "@/errors";

const STROOP = 1e7;

/**
 * Aggregates an owner's LP positions across CoralSwap pools into a
 * USD-denominated portfolio view with profit-and-loss tracking.
 *
 * ## Financial model
 *
 * Each LP position is valued using **spot prices** derived from on-chain
 * pair reserves anchored to caller-supplied stablecoins (e.g. USDC).
 * The formula for a single position is:
 *
 * ```
 * valueUSD = (token0Amount / STROOP) × price0
 *          + (token1Amount / STROOP) × price1
 * ```
 *
 * where `STROOP = 1e7` (Stellar's fixed-point scalar) and `price0` /
 * `price1` are derived as:
 *
 * ```
 * priceN = reserveStable / reserveToken   (if the stable is the other side)
 * ```
 *
 * ## Impermanent loss
 *
 * Because prices are recomputed live from reserves on every call, the
 * difference between `getPortfolioPnL` entry and current values already
 * embeds any impermanent loss: if the price ratio of the pair has moved
 * since the snapshot was captured, the implied token amounts will differ
 * from the amounts deposited, and the USD delta will reflect that
 * divergence.
 *
 * ## Stablecoin requirement
 *
 * At least one stablecoin address **must** be passed via
 * {@link TreasuryModuleOptions.stableAddresses} for USD prices to be
 * non-zero. Tokens with no direct or indirect stablecoin-paired pool
 * will throw {@link MissingPriceFeedError}.
 *
 * @example
 * ```ts
 * import { CoralSwapClient, PortfolioModule } from "@coralswap/sdk";
 *
 * const client = new CoralSwapClient({ network: "mainnet", rpcUrl: "..." });
 * const portfolio = new PortfolioModule(client, {
 *   stableAddresses: ["CUSDC_CONTRACT_ADDRESS"],
 * });
 *
 * const view = await portfolio.getPortfolio("GOWNER...");
 * console.log(`Total value: $${view.totalValueUSD.toFixed(2)}`);
 * ```
 *
 * @see {@link TreasuryModule} for the inherited price-map logic
 * @see {@link PositionsModule} for raw on-chain position data
 */
export class PortfolioModule extends TreasuryModule {
  private readonly portfolioClient: CoralSwapClient;
  private positions: PositionsModule;

  /**
   * Create a new PortfolioModule.
   *
   * @param client - Initialised {@link CoralSwapClient} connected to the
   *   target network.
   * @param options - Optional configuration. Pass `stableAddresses` to
   *   enable USD valuation; without it every `valueUSD` field will be `0`.
   *
   * @example
   * ```ts
   * const portfolio = new PortfolioModule(client, {
   *   stableAddresses: ["CUSDC_CONTRACT_ADDRESS"],
   * });
   * ```
   */
  constructor(client: CoralSwapClient, options: TreasuryModuleOptions = {}) {
    super(client, options);
    this.portfolioClient = client;
    this.positions = new PositionsModule(client);
  }

  /**
   * Return the full portfolio for `owner` across one or more CoralSwap pools.
   *
   * Fetches all non-zero LP positions held by `owner`, resolves spot prices
   * for every token using stablecoin-anchored pair reserves, and returns an
   * aggregated {@link Portfolio} with per-pool breakdowns and a total USD
   * value.
   *
   * This is an alias for {@link get} provided for readability.
   *
   * @param owner - Stellar address (`G…` or `C…`) of the wallet to query.
   * @param options - Optional filter. Supply `pairAddresses` to restrict the
   *   query to specific pools instead of scanning all factory pairs.
   * @returns Resolved {@link Portfolio} containing `positions` and
   *   `totalValueUSD`.
   *
   * @throws {@link ValidationError} if `owner` is not a valid Stellar address.
   * @throws {@link AddressNotFoundError} if the address has no on-chain state.
   * @throws {@link MissingPriceFeedError} if a token in one of the positions
   *   has no stablecoin-paired pool (and therefore no derivable USD price).
   * @throws {@link PortfolioCalculationError} if reserve/balance fetching
   *   fails for a specific pool.
   *
   * @example
   * ```ts
   * const view = await portfolio.getPortfolio("GOWNER...");
   *
   * for (const pos of view.positions) {
   *   console.log(
   *     `Pool ${pos.pairAddress}: $${pos.valueUSD.toFixed(2)}`
   *   );
   * }
   * console.log(`Total: $${view.totalValueUSD.toFixed(2)}`);
   * ```
   */
  async getPortfolio(
    owner: string,
    options: GetPortfolioOptions = {},
  ): Promise<Portfolio> {
    return this.get(owner, options);
  }

  /**
   * Core implementation of {@link getPortfolio}.
   *
   * Validates the owner address, retrieves positions from
   * {@link PositionsModule}, builds a stablecoin-anchored price map,
   * and computes a USD value for every non-zero position.
   *
   * ### Valuation formula
   *
   * For each pool position:
   * ```
   * valueUSD = (token0Amount / 1e7) × price0
   *          + (token1Amount / 1e7) × price1
   * ```
   *
   * `totalValueUSD` is the sum of all individual `valueUSD` values.
   *
   * @param owner - Stellar wallet address to query.
   * @param options - Optional pair filter; see {@link GetPortfolioOptions}.
   * @returns {@link Portfolio} with `owner`, `positions`, and `totalValueUSD`.
   *
   * @throws {@link ValidationError} if `owner` fails address validation.
   * @throws {@link AddressNotFoundError} if position fetch returns no state.
   * @throws {@link MissingPriceFeedError} if a token price cannot be derived.
   * @throws {@link PortfolioCalculationError} if valuation arithmetic fails
   *   for a specific pool.
   *
   * @example
   * ```ts
   * // Filter to two specific pools
   * const view = await portfolio.get("GOWNER...", {
   *   pairAddresses: ["CPAIR_A...", "CPAIR_B..."],
   * });
   * console.log(view.totalValueUSD);
   * ```
   */
  async get(
    owner: string,
    options: GetPortfolioOptions = {},
  ): Promise<Portfolio> {
    validateAddress(owner, "owner");

    let summary;
    try {
      summary = await this.positions.getPositions(owner, {
        pairAddresses: options.pairAddresses,
        includeEmpty: false,
      });
    } catch (err) {
      if (err instanceof CoralSwapSDKError) throw err;
      throw new AddressNotFoundError(owner, this.portfolioClient.network);
    }

    const allPairs =
      options.pairAddresses && options.pairAddresses.length > 0
        ? options.pairAddresses
        : await this.portfolioClient.factory.getAllPairs();

    const { priceMap } = await this.buildPriceMapTracked(allPairs);

    const positions: PortfolioPosition[] = [];
    for (const pos of summary.positions) {
      const price0 = priceMap.get(pos.token0) ?? 0;
      const price1 = priceMap.get(pos.token1) ?? 0;

      if (!priceMap.has(pos.token0)) {
        throw new MissingPriceFeedError(pos.token0, false);
      }
      if (!priceMap.has(pos.token1)) {
        throw new MissingPriceFeedError(pos.token1, false);
      }

      try {
        const valueUSD =
          (Number(pos.token0Amount) / STROOP) * price0 +
          (Number(pos.token1Amount) / STROOP) * price1;

        positions.push({
          pairAddress: pos.pairAddress,
          lpTokenAddress: pos.lpTokenAddress,
          token0: pos.token0,
          token1: pos.token1,
          lpBalance: pos.balance,
          token0Amount: pos.token0Amount,
          token1Amount: pos.token1Amount,
          valueUSD,
        });
      } catch (err) {
        if (err instanceof CoralSwapSDKError) throw err;
        throw new PortfolioCalculationError(
          pos.pairAddress,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    const totalValueUSD = positions.reduce((sum, p) => sum + p.valueUSD, 0);

    return { owner, positions, totalValueUSD };
  }

  /**
   * Capture the current portfolio state as an immutable entry snapshot.
   *
   * The snapshot records the USD value and token amounts at the moment of
   * capture and is intended to be stored by the caller (in memory, a
   * database, or local storage) for later comparison via
   * {@link getPortfolioPnL}.
   *
   * The snapshot represents the **cost basis** — the baseline from which
   * PnL is measured. Capture it immediately after providing liquidity to
   * track returns from that entry point.
   *
   * @param portfolio - An already-resolved {@link Portfolio} object, e.g.
   *   the return value of {@link getPortfolio}.
   * @returns A {@link PortfolioEntrySnapshot} stamped with the current Unix
   *   timestamp (seconds).
   *
   * @example
   * ```ts
   * // Record entry cost basis right after depositing
   * const view = await portfolio.getPortfolio("GOWNER...");
   * const snapshot = portfolio.createSnapshot(view);
   *
   * // … time passes, prices move …
   *
   * const pnl = await portfolio.getPortfolioPnL("GOWNER...", snapshot);
   * console.log(`PnL: ${pnl.pnlPercent.toFixed(2)}%`);
   * ```
   */
  createSnapshot(portfolio: Portfolio): PortfolioEntrySnapshot {
    return {
      owner: portfolio.owner,
      totalValueUSD: portfolio.totalValueUSD,
      positions: portfolio.positions.map((p) => ({
        pairAddress: p.pairAddress,
        token0Amount: p.token0Amount,
        token1Amount: p.token1Amount,
        valueUSD: p.valueUSD,
      })),
      capturedAt: Math.floor(Date.now() / 1000),
    };
  }

  /**
   * Compute profit and loss for `owner` relative to a prior entry snapshot.
   *
   * Fetches the current portfolio (restricted to the pools in `entry`) and
   * computes the difference from the snapshot's recorded values.
   *
   * ### PnL formulas
   *
   * ```
   * pnlUSD     = currentValueUSD − entryValueUSD
   * pnlPercent = (pnlUSD / entryValueUSD) × 100
   * ```
   *
   * `pnlPercent` is `0` when `entryValueUSD` is zero (i.e. the snapshot was
   * taken with an empty portfolio) to avoid division by zero.
   *
   * ### Impermanent loss
   *
   * Because USD values are derived from live on-chain reserves, any
   * divergence in the price ratio of a pair since the snapshot was captured
   * is automatically reflected in `currentValueUSD`. There is no separate
   * IL field; the IL contribution is embedded in `pnlUSD`.
   *
   * @param owner - Stellar address of the wallet to evaluate.
   * @param entry - Snapshot produced by {@link createSnapshot} at the
   *   desired entry point (cost basis).
   * @returns {@link PortfolioPnL} with `entryValueUSD`, `currentValueUSD`,
   *   `pnlUSD`, and `pnlPercent`.
   *
   * @throws {@link ValidationError} if `owner` is not a valid Stellar address.
   * @throws {@link MissingPriceFeedError} if a token's current price cannot
   *   be derived from on-chain reserves.
   * @throws {@link PortfolioCalculationError} if valuation fails for any pool
   *   included in the snapshot.
   *
   * @example
   * ```ts
   * // Snapshot taken at deposit time (stored in DB / local state)
   * const entry: PortfolioEntrySnapshot = loadSnapshot("GOWNER...");
   *
   * const pnl = await portfolio.getPortfolioPnL("GOWNER...", entry);
   *
   * console.log(`Entry value : $${pnl.entryValueUSD.toFixed(2)}`);
   * console.log(`Current value: $${pnl.currentValueUSD.toFixed(2)}`);
   * console.log(`PnL          : $${pnl.pnlUSD.toFixed(2)} (${pnl.pnlPercent.toFixed(2)}%)`);
   * ```
   */
  async getPortfolioPnL(
    owner: string,
    entry: PortfolioEntrySnapshot,
  ): Promise<PortfolioPnL> {
    validateAddress(owner, "owner");

    const pairAddresses = entry.positions.map((p) => p.pairAddress);
    const current = await this.getPortfolio(owner, { pairAddresses });

    const pnlUSD = current.totalValueUSD - entry.totalValueUSD;
    const pnlPercent =
      entry.totalValueUSD > 0 ? (pnlUSD / entry.totalValueUSD) * 100 : 0;

    return {
      entryValueUSD: entry.totalValueUSD,
      currentValueUSD: current.totalValueUSD,
      pnlUSD,
      pnlPercent,
    };
  }

  /**
   * Build a spot-price map and report which tokens had no derivable price.
   *
   * Extends the inherited {@link TreasuryModule.buildPriceMap} by also
   * collecting a list of tokens that appear in the given pairs but have no
   * stablecoin anchor — useful for generating warnings without immediately
   * throwing.
   *
   * Stablecoin addresses (set at construction via
   * {@link TreasuryModuleOptions.stableAddresses}) are unconditionally
   * assigned a price of `1.0` USD. All other token prices are derived from
   * the spot rate implied by a pair's reserves when one side is a known
   * stablecoin:
   *
   * ```
   * priceToken = reserveStable / reserveToken
   * ```
   *
   * Pairs with zero reserves on either side are skipped to avoid
   * division-by-zero artefacts.
   *
   * @param allPairs - List of pair contract addresses to scan.
   * @returns An object with `priceMap` (token address → USD price) and
   *   `missingTokens` (addresses for which no price could be derived).
   */
  private async buildPriceMapTracked(
    allPairs: string[],
  ): Promise<{ priceMap: Map<string, number>; missingTokens: string[] }> {
    const prices = new Map<string, number>();
    const missingTokens: string[] = [];

    for (const addr of this.stableAddresses) {
      prices.set(addr, 1.0);
    }

    if (this.stableAddresses.size > 0) {
      for (const pairAddress of allPairs) {
        try {
          const pair = this.portfolioClient.pair(pairAddress);
          const [{ token0, token1 }, { reserve0, reserve1 }] =
            await Promise.all([pair.getTokens(), pair.getReserves()]);

          if (reserve0 === 0n || reserve1 === 0n) continue;

          if (this.stableAddresses.has(token0) && !prices.has(token1)) {
            prices.set(token1, Number(reserve0) / Number(reserve1));
          } else if (this.stableAddresses.has(token1) && !prices.has(token0)) {
            prices.set(token0, Number(reserve1) / Number(reserve0));
          }
        } catch {
          continue;
        }
      }
    }

    // Collect tokens that appear in pairs but have no price
    const allTokens = new Set<string>();
    for (const pairAddress of allPairs) {
      try {
        const pair = this.portfolioClient.pair(pairAddress);
        const { token0, token1 } = await pair.getTokens();
        allTokens.add(token0);
        allTokens.add(token1);
      } catch {
        continue;
      }
    }

    for (const token of allTokens) {
      if (!prices.has(token)) {
        missingTokens.push(token);
      }
    }

    return { priceMap: prices, missingTokens };
  }
}

export type { TreasuryModuleOptions as PortfolioModuleOptions };
