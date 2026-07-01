import { CoralSwapClient } from "@/client";
import {
  GetPortfolioOptions,
  Portfolio,
  PortfolioEntrySnapshot,
  PortfolioPnL,
  PortfolioPosition,
  PortfolioValue,
} from "@/types/portfolio";
import { TreasuryModule, TreasuryModuleOptions } from "@/modules/treasury";
import { PositionsModule } from "@/modules/positions";
import { validateAddress } from "@/utils/validation";
import { Address, Contract, nativeToScVal, xdr } from "@stellar/stellar-sdk";

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
  private pairMetadataCache: Map<string, { lpTokenAddress: string; token0: string; token1: string }> = new Map();
  private readonly portfolioStableSet: Set<string>;

  constructor(client: CoralSwapClient, options: TreasuryModuleOptions = {}) {
    super(client, options);
    this.portfolioClient = client;
    this.positions = new PositionsModule(client);
    this.portfolioStableSet = new Set(options.stableAddresses ?? []);
  }

  /**
   * Alias for getPortfolio to support RiskMetricsModule.
   */
  async get(
    owner: string,
    options: GetPortfolioOptions = {},
  ): Promise<Portfolio> {
    return this.getPortfolio(owner, options);
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

  /**
   * Get the aggregate USD value of the portfolio for an address,
   * including the absolute and percentage change over the last 24 hours.
   *
   * Batches simulation queries to complete in at most 2 RPC round trips total.
   *
   * @param address - Wallet address to query
   * @returns PortfolioValue containing total USD value and 24h performance change
   */
  async getPortfolioValue(address: string): Promise<PortfolioValue> {
    validateAddress(address, "address");

    const allPairs = await this.portfolioClient.factory.getAllPairs();
    if (allPairs.length === 0) {
      return { totalUSD: 0, change24h: 0, change24hPercent: 0 };
    }

    // 1. Fetch missing metadata (static across timeframe, cached permanently)
    const missingPairs = allPairs.filter((p) => !this.pairMetadataCache.has(p));
    if (missingPairs.length > 0) {
      const metadataOps: xdr.Operation[] = [];
      for (const pairAddr of missingPairs) {
        const pairContract = new Contract(pairAddr);
        metadataOps.push(pairContract.call("lp_token"));
        metadataOps.push(pairContract.call("token_0"));
        metadataOps.push(pairContract.call("token_1"));
      }

      const simResult = await this.portfolioClient.simulateTransaction(metadataOps, {});
      if (simResult.success && simResult.raw && "results" in simResult.raw && Array.isArray(simResult.raw.results)) {
        const results = simResult.raw.results;
        for (let i = 0; i < missingPairs.length; i++) {
          const pairAddr = missingPairs[i];
          const lpRaw = results[i * 3];
          const t0Raw = results[i * 3 + 1];
          const t1Raw = results[i * 3 + 2];
          if (lpRaw && t0Raw && t1Raw) {
            try {
              const lpTokenAddress = Address.fromScVal(xdr.ScVal.fromXDR(lpRaw.xdr, "base64")).toString();
              const token0 = Address.fromScVal(xdr.ScVal.fromXDR(t0Raw.xdr, "base64")).toString();
              const token1 = Address.fromScVal(xdr.ScVal.fromXDR(t1Raw.xdr, "base64")).toString();
              this.pairMetadataCache.set(pairAddr, { lpTokenAddress, token0, token1 });
            } catch {
              // Ignore decoding error for a single pair
            }
          }
        }
      }
    }

    const validPairs = allPairs.filter((p) => this.pairMetadataCache.has(p));
    if (validPairs.length === 0) {
      return { totalUSD: 0, change24h: 0, change24hPercent: 0 };
    }

    // 2. Build valuation queries for current and historical timeframes
    const currentOps: xdr.Operation[] = [];
    const historicalOps: xdr.Operation[] = [];

    for (const pairAddr of validPairs) {
      const meta = this.pairMetadataCache.get(pairAddr)!;
      const pairContract = new Contract(pairAddr);
      const lpContract = new Contract(meta.lpTokenAddress);
      const balanceArgs = nativeToScVal(Address.fromString(address), { type: "address" });

      // Current Ops
      currentOps.push(pairContract.call("get_reserves"));
      currentOps.push(lpContract.call("balance", balanceArgs));
      currentOps.push(lpContract.call("total_supply"));

      // Historical Ops
      historicalOps.push(pairContract.call("get_reserves"));
      historicalOps.push(lpContract.call("balance", balanceArgs));
      historicalOps.push(lpContract.call("total_supply"));
    }

    // 3. Execute both simulations sequentially (1 RPC round trip each)
    const currentSim = await this.portfolioClient.simulateTransaction(currentOps, {});
    const historicalSim = await this.portfolioClient.simulateTransaction(historicalOps, {});

    // Helper to calculate total USD from a simulation result
    const calculateUSD = (simResult: any): number => {
      if (!simResult.success || !simResult.raw || !("results" in simResult.raw) || !Array.isArray(simResult.raw.results)) {
        return 0;
      }

      const results = simResult.raw.results;
      const reservesMap = new Map<string, { reserve0: bigint; reserve1: bigint }>();

      // Parse reserves first to build the price map
      for (let i = 0; i < validPairs.length; i++) {
        const pairAddr = validPairs[i];
        const reservesRaw = results[i * 3];
        if (!reservesRaw) continue;

        try {
          const reservesSc = xdr.ScVal.fromXDR(reservesRaw.xdr, "base64");
          const vec = reservesSc.vec();
          if (vec && vec.length >= 2) {
            const reserve0 = BigInt(vec[0].i128().lo().toString()) + (BigInt(vec[0].i128().hi().toString()) << 64n);
            const reserve1 = BigInt(vec[1].i128().lo().toString()) + (BigInt(vec[1].i128().hi().toString()) << 64n);
            reservesMap.set(pairAddr, { reserve0, reserve1 });
          }
        } catch {
          // ignore parsing error for this pair
        }
      }

      // Build price map using cached pair configurations and simulated reserves (no extra network calls)
      const prices = new Map<string, number>();
      for (const addr of this.portfolioStableSet) {
        prices.set(addr, 1.0);
      }
      if (this.portfolioStableSet.size > 0) {
        for (const pairAddr of validPairs) {
          const meta = this.pairMetadataCache.get(pairAddr)!;
          const reserves = reservesMap.get(pairAddr);
          if (!reserves || reserves.reserve0 === 0n || reserves.reserve1 === 0n) continue;

          if (this.portfolioStableSet.has(meta.token0) && !prices.has(meta.token1)) {
            prices.set(meta.token1, Number(reserves.reserve0) / Number(reserves.reserve1));
          } else if (this.portfolioStableSet.has(meta.token1) && !prices.has(meta.token0)) {
            prices.set(meta.token0, Number(reserves.reserve1) / Number(reserves.reserve0));
          }
        }
      }

      let totalUSD = 0;

      for (let i = 0; i < validPairs.length; i++) {
        const pairAddr = validPairs[i];
        const meta = this.pairMetadataCache.get(pairAddr)!;

        const balanceRaw = results[i * 3 + 1];
        const totalSupplyRaw = results[i * 3 + 2];
        const reserves = reservesMap.get(pairAddr);

        if (!balanceRaw || !totalSupplyRaw || !reserves) continue;

        try {
          const balanceSc = xdr.ScVal.fromXDR(balanceRaw.xdr, "base64");
          const totalSupplySc = xdr.ScVal.fromXDR(totalSupplyRaw.xdr, "base64");

          const balance = BigInt(balanceSc.i128().lo().toString()) + (BigInt(balanceSc.i128().hi().toString()) << 64n);
          const totalSupply = BigInt(totalSupplySc.i128().lo().toString()) + (BigInt(totalSupplySc.i128().hi().toString()) << 64n);

          if (balance === 0n || totalSupply === 0n) continue;

          const price0 = prices.get(meta.token0);
          const price1 = prices.get(meta.token1);

          // If a price is unavailable, we ignore this pair/valuation rather than throwing
          if (price0 === undefined || price1 === undefined) continue;

          const poolValueUSD = (Number(reserves.reserve0) / STROOP) * price0 + (Number(reserves.reserve1) / STROOP) * price1;
          const shareRatio = Number(balance) / Number(totalSupply);
          totalUSD += shareRatio * poolValueUSD;
        } catch {
          // ignore individual parsing/calculation errors
        }
      }

      return totalUSD;
    };

    const totalUSD = calculateUSD(currentSim);
    const usd24hAgo = calculateUSD(historicalSim);

    const change24h = totalUSD - usd24hAgo;
    const change24hPercent = usd24hAgo === 0 ? 0 : (change24h / usd24hAgo) * 100;

    return {
      totalUSD,
      change24h,
      change24hPercent,
    };
  }
}

export type { TreasuryModuleOptions as PortfolioModuleOptions };
