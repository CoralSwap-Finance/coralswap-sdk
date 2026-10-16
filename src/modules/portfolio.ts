import { CoralSwapClient } from "@/client";
import {
  GetPortfolioOptions,
  Portfolio,
  PortfolioEntrySnapshot,
  PortfolioPnL,
  PortfolioPosition,
  UnavailablePortfolioPosition,
} from "@/types/portfolio";
import { TreasuryModule, TreasuryModuleOptions } from "@/modules/treasury";
import { PositionsModule } from "@/modules/positions";
import { validateAddress, validateDateRange, validateLimit } from "@/utils/validation";
import {
  MissingPriceFeedError,
  AddressNotFoundError,
  PortfolioCalculationError,
  CoralSwapSDKError,
  ValidationError,
} from "@/errors";

const STROOP_SCALE = 10_000_000n; // 1e7, matches the SDK's 7-decimal token precision

/**
 * Fixed-point decimal places used to represent a floating-point spot price
 * as an exact BigInt. 15 is comfortably inside float64's ~15-17 significant
 * decimal digits, so this never claims precision the price itself doesn't
 * actually have.
 */
const PRICE_SCALE_DECIMALS = 15;
const PRICE_SCALE = 10n ** BigInt(PRICE_SCALE_DECIMALS);

/**
 * Represent a floating-point price as an exact, fixed-point BigInt scaled by
 * {@link PRICE_SCALE}, via string parsing rather than float multiplication
 * (`price * 1e15` would itself overflow Number.MAX_SAFE_INTEGER for
 * ordinary prices and round unpredictably).
 */
function scalePrice(price: number): bigint {
  const negative = price < 0;
  const [intPart, fracPart = ""] = Math.abs(price)
    .toFixed(PRICE_SCALE_DECIMALS)
    .split(".");
  const scaled =
    BigInt(intPart) * PRICE_SCALE + BigInt(fracPart.padEnd(PRICE_SCALE_DECIMALS, "0"));
  return negative ? -scaled : scaled;
}

/**
 * Exact USD value (scaled by {@link PRICE_SCALE}) of `amountStroops` at
 * `price`, computed entirely in BigInt -- `amountStroops` is never routed
 * through `Number`, so a position's raw on-chain amount (which can exceed
 * Number.MAX_SAFE_INTEGER for large holdings) never loses stroop-level
 * precision before the price is applied.
 */
function scaledPositionValue(amountStroops: bigint, price: number): bigint {
  return (amountStroops * scalePrice(price)) / STROOP_SCALE;
}

/** Convert a {@link PRICE_SCALE}-scaled BigInt back to a display `number`. */
function toDisplayUSD(scaled: bigint): number {
  return Number(scaled) / Number(PRICE_SCALE);
}

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
   * Per-position USD values (and their sum, `totalValueUSD`) are computed
   * entirely in BigInt from the on-chain stroop amounts, converting to a
   * display `number` only once at the very end -- large positions never
   * lose stroop-level precision through a premature `Number()` conversion,
   * and per-position rounding never compounds across the total.
   *
   * A position without price coverage for one of its tokens, or that
   * otherwise fails to value, is excluded from `positions` and
   * `totalValueUSD` and reported in `unavailablePositions` instead -- it
   * never aborts the call or zeroes out the rest of an otherwise-valid
   * portfolio.
   *
   * This is an alias for {@link get} provided for readability.
   *
   * @param owner - Stellar address (`G…` or `C…`) of the wallet to query.
   * @param options - Optional filter. Supply `pairAddresses` to restrict the
   *   query to specific pools instead of scanning all factory pairs.
   * @returns Resolved {@link Portfolio} containing `positions`,
   *   `totalValueUSD` (over available positions only), and
   *   `unavailablePositions`.
   *
   * @throws {@link ValidationError} if `owner`, any entry of
   *   `options.pairAddresses`, `options.fromDate` / `options.toDate`, or
   *   `options.limit` fails validation (the message includes the invalid
   *   value).
   * @throws {@link AddressNotFoundError} if the address has no on-chain state.
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
   * @throws {@link ValidationError} if `owner` or any option fails validation
   *   (the message includes the invalid value).
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
    this.validatePortfolioInputs(owner, options);

    let summary;
    try {
      summary = await this.positions.getPositions(owner, {
        pairAddresses: options.pairAddresses,
        includeEmpty: false,
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
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
    const unavailablePositions: UnavailablePortfolioPosition[] = [];
    // Accumulated in BigInt (scaled by PRICE_SCALE) across the whole loop,
    // and converted to a display Number exactly once at the end -- summing
    // already-rounded per-position floats here would let rounding error
    // compound across many positions instead of only at the final display
    // step.
    let totalScaled = 0n;

    for (const pos of summary.positions) {
      const unavailable = (reason: string): UnavailablePortfolioPosition => ({
        pairAddress: pos.pairAddress,
        lpTokenAddress: pos.lpTokenAddress,
        token0: pos.token0,
        token1: pos.token1,
        lpBalance: pos.balance,
        token0Amount: pos.token0Amount,
        token1Amount: pos.token1Amount,
        reason,
      });

      const price0 = priceMap.get(pos.token0);
      const price1 = priceMap.get(pos.token1);

      if (price0 === undefined || price1 === undefined) {
        // No price coverage for one of this position's tokens -- isolate it
        // rather than aborting the whole portfolio (a bad/uncovered position
        // must not zero out an otherwise-valid total).
        const missing = price0 === undefined ? pos.token0 : pos.token1;
        unavailablePositions.push(
          unavailable(new MissingPriceFeedError(missing, false).message),
        );
        continue;
      }

      try {
        const valueScaled =
          scaledPositionValue(pos.token0Amount, price0) +
          scaledPositionValue(pos.token1Amount, price1);

        totalScaled += valueScaled;

        positions.push({
          pairAddress: pos.pairAddress,
          lpTokenAddress: pos.lpTokenAddress,
          token0: pos.token0,
          token1: pos.token1,
          lpBalance: pos.balance,
          token0Amount: pos.token0Amount,
          token1Amount: pos.token1Amount,
          valueUSD: toDisplayUSD(valueScaled),
        });
      } catch (err) {
        // Any failure computing this position's value -- including a
        // CoralSwapSDKError -- isolates just this position. Aborting the
        // whole call on one bad position is exactly the failure mode this
        // issue exists to remove.
        unavailablePositions.push(
          unavailable(
            new PortfolioCalculationError(
              pos.pairAddress,
              err instanceof Error ? err.message : String(err),
            ).message,
          ),
        );
      }
    }

    return {
      owner,
      positions,
      totalValueUSD: toDisplayUSD(totalScaled),
      unavailablePositions,
    };
  }

  /**
   * Validate every caller-supplied parameter of the portfolio query methods.
   *
   * Runs before any RPC call so malformed input fails fast with a typed
   * {@link ValidationError} instead of wasting an RPC round-trip:
   *
   * - `owner` and each entry of `options.pairAddresses` must be a valid
   *   Stellar public key (`G…`) or contract ID (`C…`)
   * - `options.fromDate` / `options.toDate`, when given, must be real dates
   *   that are not in the future, with `fromDate` strictly earlier than
   *   `toDate`
   * - `options.limit`, when given, must be a positive integer no greater
   *   than 1000
   *
   * @param owner - Stellar address of the wallet being queried.
   * @param options - Query options to validate.
   * @throws {ValidationError} If any parameter is malformed; the message
   *   always includes the offending value.
   */
  private validatePortfolioInputs(
    owner: string,
    options: GetPortfolioOptions = {},
  ): void {
    validateAddress(owner, "owner");

    if (options.pairAddresses !== undefined) {
      if (!Array.isArray(options.pairAddresses)) {
        throw new ValidationError(
          `pairAddresses must be an array of Stellar addresses, got ${options.pairAddresses}`,
        );
      }
      options.pairAddresses.forEach((address, index) => {
        validateAddress(address, `pairAddresses[${index}]`);
      });
    }

    validateDateRange(options.fromDate, options.toDate);
    validateLimit(options.limit);
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
   * @throws {@link ValidationError} if `portfolio` is not a resolved
   *   {@link Portfolio} or its `owner` is not a valid Stellar address.
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
    if (!portfolio || typeof portfolio !== "object") {
      throw new ValidationError(
        `portfolio must be a resolved Portfolio object, got ${portfolio}`,
      );
    }
    validateAddress(portfolio.owner, "portfolio.owner");

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
   * @throws {@link ValidationError} if `owner` is not a valid Stellar address,
   *   or if `entry` is not a well-formed snapshot (`entry.owner` must be a
   *   valid address and `entry.positions` must be an array).
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
    this.validatePortfolioInputs(owner, {});

    if (!entry || typeof entry !== "object") {
      throw new ValidationError(
        `entry must be a PortfolioEntrySnapshot object, got ${entry}`,
      );
    }
    validateAddress(entry.owner, "entry.owner");

    if (!Array.isArray(entry.positions)) {
      throw new ValidationError(
        `entry.positions must be an array of positions, got ${entry.positions}`,
      );
    }
    if (typeof entry.totalValueUSD !== "number") {
      throw new ValidationError(
        `entry.totalValueUSD must be a number, got ${entry.totalValueUSD}`,
      );
    }

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
