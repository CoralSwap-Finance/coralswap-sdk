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
import { validateAddress } from "@/utils/validation";
import {
  MissingPriceFeedError,
  AddressNotFoundError,
  PortfolioCalculationError,
  CoralSwapSDKError,
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
 * Portfolio module — aggregates LP positions with USD valuations and PnL.
 *
 * Builds on {@link PositionsModule} for on-chain position data and reuses
 * treasury-style spot pricing anchored to caller-supplied stablecoins.
 */
export class PortfolioModule extends TreasuryModule {
  private readonly portfolioClient: CoralSwapClient;
  private positions: PositionsModule;

  constructor(client: CoralSwapClient, options: TreasuryModuleOptions = {}) {
    super(client, options);
    this.portfolioClient = client;
    this.positions = new PositionsModule(client);
  }

  /**
   * Get the full portfolio for an owner across one or more pools.
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
   * @param owner - Wallet address to query
   * @param options - Optional pair filter
   * @returns Portfolio with per-pool positions, total USD value (over
   *   available positions only), and any positions that could not be valued
   */
  async getPortfolio(
    owner: string,
    options: GetPortfolioOptions = {},
  ): Promise<Portfolio> {
    return this.get(owner, options);
  }

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
   * Capture a snapshot from a portfolio result for later PnL comparison.
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
   * Compute PnL relative to an entry snapshot after on-chain state changes.
   *
   * @param owner - Wallet address to query
   * @param entry - Entry snapshot from {@link createSnapshot}
   * @returns PnL breakdown in USD
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
   * Build a price map and track which tokens had no price feed.
   *
   * Unlike the inherited {@link TreasuryModule.buildPriceMap}, this version
   * reports missing tokens so callers can decide whether to warn or fail.
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
          const [{ token0, token1 }, { reserve0, reserve1 }] = await Promise.all([
            pair.getTokens(),
            pair.getReserves(),
          ]);

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
