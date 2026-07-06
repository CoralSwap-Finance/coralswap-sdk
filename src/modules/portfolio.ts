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
   * @param owner - Wallet address to query
   * @param options - Optional pair filter
   * @returns Portfolio with per-pool positions and total USD value
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
