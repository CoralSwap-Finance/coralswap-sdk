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
    validateAddress(owner, "owner");

    const summary = await this.positions.getPositions(owner, {
      pairAddresses: options.pairAddresses,
      includeEmpty: false,
    });

    const allPairs =
      options.pairAddresses && options.pairAddresses.length > 0
        ? options.pairAddresses
        : await this.portfolioClient.factory.getAllPairs();

    const priceMap = await this.buildPriceMap(allPairs);

    const positions: PortfolioPosition[] = summary.positions.map((pos) => {
      const price0 = priceMap.get(pos.token0) ?? 0;
      const price1 = priceMap.get(pos.token1) ?? 0;
      const valueUSD =
        (Number(pos.token0Amount) / STROOP) * price0 +
        (Number(pos.token1Amount) / STROOP) * price1;

      return {
        pairAddress: pos.pairAddress,
        lpTokenAddress: pos.lpTokenAddress,
        token0: pos.token0,
        token1: pos.token1,
        lpBalance: pos.balance,
        token0Amount: pos.token0Amount,
        token1Amount: pos.token1Amount,
        valueUSD,
      };
    });

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
}

export type { TreasuryModuleOptions as PortfolioModuleOptions };
