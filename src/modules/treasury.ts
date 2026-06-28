import { SorobanRpc } from "@stellar/stellar-sdk";
import { CoralSwapClient } from "@/client";
import {
  TreasuryBalance,
  TokenBalance,
  Allocation,
  TreasuryAllocation,
  RevenuePeriod,
  PoolRevenue,
  RevenueData,
} from "@/types/treasury";

const LEDGERS_PER_30_DAYS = 518_400; // 30 days × 86 400 s/day ÷ 5 s/ledger

/**
 * Options for constructing a TreasuryModule.
 */
export interface TreasuryModuleOptions {
  /**
   * Addresses of tokens that are treated as $1 USD stablecoins.
   * Used to anchor USD valuations when computing spot prices from pair reserves.
   * Without at least one stable address, all valueUSD fields default to 0.
   */
  stableAddresses?: string[];
}

/**
 * Treasury module — protocol treasury balance and allocation view.
 *
 * Reads LP-token holdings from the fee-recipient address and computes
 * USD valuations using on-chain spot prices derived from pair reserves
 * anchored to caller-supplied stablecoin addresses.
 */
export class TreasuryModule {
  private readonly client: CoralSwapClient;
  private readonly stableSet: Set<string>;

  constructor(client: CoralSwapClient, options: TreasuryModuleOptions = {}) {
    this.client = client;
    this.stableSet = new Set(options.stableAddresses ?? []);
  }

  /**
   * Return the treasury contract address (the protocol fee recipient).
   *
   * @returns The fee-to address configured in the Factory contract.
   * @example
   * const addr = await treasury.getTreasuryAddress();
   */
  async getTreasuryAddress(): Promise<string> {
    return this.client.factory.getFeeTo();
  }

  /**
   * Return the aggregate token holdings of the protocol treasury.
   *
   * Enumerates all pairs registered in the Factory, checks the treasury's
   * LP-token balance in each pair, and reports each non-zero holding as a
   * {@link TokenBalance}. USD values use spot prices derived from pair
   * reserves (RedStone price feed integration point).
   *
   * @returns TreasuryBalance with totalUSD and per-token breakdown.
   * @example
   * const balance = await treasury.getTreasuryBalance();
   * console.log(`Treasury holds $${balance.totalUSD.toFixed(2)}`);
   */
  async getTreasuryBalance(): Promise<TreasuryBalance> {
    const [treasuryAddress, allPairs] = await Promise.all([
      this.getTreasuryAddress(),
      this.client.factory.getAllPairs(),
    ]);

    if (allPairs.length === 0) {
      return { totalUSD: 0, tokens: [] };
    }

    const priceMap = await this.buildPriceMap(allPairs);
    const tokens = await this.collectLPHoldings(treasuryAddress, allPairs, priceMap);

    const totalUSD = tokens.reduce((sum, t) => sum + t.valueUSD, 0);
    return { totalUSD, tokens };
  }

  /**
   * Return the proportional allocation of each token in the treasury.
   *
   * Percentages are computed from USD values and sum to 100 (±0.01 for rounding).
   * Results are sorted by percentage descending. Includes LP tokens held by the
   * treasury. Returns empty allocations when the treasury has no holdings.
   *
   * @returns TreasuryAllocation with per-token breakdown and total USD.
   * @example
   * const alloc = await treasury.getTreasuryAllocation();
   * alloc.allocations.forEach(a => {
   *   console.log(`${a.token}: ${a.percentage.toFixed(2)}%`);
   * });
   */
  async getTreasuryAllocation(): Promise<TreasuryAllocation> {
    const { tokens, totalUSD } = await this.getTreasuryBalance();

    if (tokens.length === 0) {
      return { allocations: [], totalValueUSD: 0 };
    }

    const allocations: Allocation[] = tokens.map((t) => ({
      token: t.address,
      percentage: totalUSD > 0 ? (t.valueUSD / totalUSD) * 100 : 0,
      valueUSD: t.valueUSD,
      amount: t.amount,
    }));

    allocations.sort((a, b) => b.percentage - a.percentage);

    if (totalUSD > 0) {
      this.normalizePercentages(allocations);
    }

    return { allocations, totalValueUSD: totalUSD };
  }

  /**
   * Return fee revenue collected by the protocol across all pools.
   *
   * Queries swap events in the given ledger range (default: last 30 days),
   * sums fees per pool, and computes a trend by comparing first-half vs
   * second-half revenue.
   *
   * @param period - Optional ledger range and granularity. Defaults to last 30 days.
   * @returns RevenueData with totalUSD, per-pool breakdown sorted by revenue, and trend.
   * @example
   * const revenue = await treasury.getFeeRevenue({ granularity: '1d' });
   * console.log(revenue.trend); // 'rising' | 'falling' | 'stable'
   */
  async getFeeRevenue(period?: RevenuePeriod): Promise<RevenueData> {
    const currentLedger = await this.client.getCurrentLedger();
    const fromLedger = period?.fromLedger ?? Math.max(0, currentLedger - this.ledgersPer30Days);
    const toLedger = period?.toLedger ?? currentLedger;
    const midLedger = Math.floor((fromLedger + toLedger) / 2);

    const allPairs = await this.client.factory.getAllPairs();
    const priceMap = await this.buildPriceMap(allPairs);

    let firstHalfRevenue = 0;
    let secondHalfRevenue = 0;
    const byPool: PoolRevenue[] = [];

    for (const pairAddress of allPairs) {
      const { revenueUSD, volumeUSD, firstHalf, secondHalf } =
        await this.fetchPoolRevenue(pairAddress, fromLedger, toLedger, midLedger, priceMap);
      firstHalfRevenue += firstHalf;
      secondHalfRevenue += secondHalf;
      byPool.push({ pairAddress, revenueUSD, volumeUSD });
    }

    byPool.sort((a, b) => b.revenueUSD - a.revenueUSD);

    return {
      totalUSD: byPool.reduce((sum, p) => sum + p.revenueUSD, 0),
      byPool,
      trend: this.computeTrend(firstHalfRevenue, secondHalfRevenue),
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async fetchPoolRevenue(
    pairAddress: string,
    fromLedger: number,
    toLedger: number,
    midLedger: number,
    priceMap: Map<string, number>,
  ): Promise<{ revenueUSD: number; volumeUSD: number; firstHalf: number; secondHalf: number }> {
    try {
      const request: SorobanRpc.Server.GetEventsRequest = {
        startLedger: fromLedger,
        filters: [{ type: 'contract', contractIds: [pairAddress], topics: [['swap']] }],
        limit: 10000,
      };
      const response = await this.client.server.getEvents(request);

      if (!Array.isArray(response?.events) || response.events.length === 0) {
        return { revenueUSD: 0, volumeUSD: 0, firstHalf: 0, secondHalf: 0 };
      }

      let revenueUSD = 0;
      let volumeUSD = 0;
      let firstHalf = 0;
      let secondHalf = 0;

      for (const event of response.events) {
        if (event.ledger > toLedger) continue;
        const parsed = this.parseSwapEventForRevenue(event);
        if (!parsed) continue;

        const priceUSD = priceMap.get(parsed.tokenIn) ?? 0;
        const feeUSD = (Number(parsed.feeAmount) / 1e7) * priceUSD;
        const volUSD = (Number(parsed.amountIn) / 1e7) * priceUSD;

        revenueUSD += feeUSD;
        volumeUSD += volUSD;

        if (event.ledger <= midLedger) {
          firstHalf += feeUSD;
        } else {
          secondHalf += feeUSD;
        }
      }

      return { revenueUSD, volumeUSD, firstHalf, secondHalf };
    } catch {
      return { revenueUSD: 0, volumeUSD: 0, firstHalf: 0, secondHalf: 0 };
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private parseSwapEventForRevenue(rawEvent: any): {
    amountIn: bigint;
    feeAmount: bigint;
    tokenIn: string;
  } | null {
    try {
      const topics: string[] = rawEvent.topic ?? [];
      if (!topics.length || topics[0] !== 'swap') return null;

      const value = rawEvent.value;
      if (!value) return null;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const map: any[] = typeof value.map === 'function' ? value.map() : value._value;
      if (!Array.isArray(map)) return null;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const get = (key: string): any => {
        for (const entry of map) {
          const k = entry.key;
          let keyStr: string | undefined;
          try {
            if (typeof k.sym === 'function') keyStr = k.sym().toString();
            else if (typeof k.str === 'function') keyStr = k.str().toString();
          } catch { /* skip */ }
          if (keyStr === key) return entry.val;
        }
        return undefined;
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const decodeI128 = (val: any): bigint => {
        if (typeof val?.i128 === 'function') {
          const parts = val.i128();
          return (BigInt(parts.hi().toString()) << 64n) + BigInt(parts.lo().toString());
        }
        throw new Error('cannot decode i128');
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const decodeU32 = (val: any): number => {
        if (typeof val?.u32 === 'function') return val.u32();
        throw new Error('cannot decode u32');
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const decodeAddr = (val: any): string => {
        if (typeof val?.address === 'function') return val.address().toString();
        if (typeof val?._value?.toString === 'function') return val._value.toString();
        throw new Error('cannot decode address');
      };

      const amountIn = decodeI128(get('amount_in'));
      const feeBps = decodeU32(get('fee_bps'));
      const tokenIn = decodeAddr(get('token_in'));
      const feeAmount = (amountIn * BigInt(feeBps)) / 10000n;

      return { amountIn, feeAmount, tokenIn };
    } catch {
      return null;
    }
  }

  private computeTrend(first: number, second: number): 'rising' | 'falling' | 'stable' {
    if (first === 0 && second === 0) return 'stable';
    if (first === 0) return second > 0 ? 'rising' : 'stable';
    if (second > first * 1.1) return 'rising';
    if (second < first * 0.9) return 'falling';
    return 'stable';
  }

  private normalizePercentages(allocations: Allocation[]): void {
    if (allocations.length === 0) return;
    const rawSum = allocations.reduce((s, a) => s + a.percentage, 0);
    if (rawSum === 0) return;
    const factor = 100 / rawSum;
    let running = 0;
    for (let i = 0; i < allocations.length - 1; i++) {
      allocations[i].percentage = Math.round(allocations[i].percentage * factor * 100) / 100;
      running += allocations[i].percentage;
    }
    allocations[allocations.length - 1].percentage =
      Math.round((100 - running) * 100) / 100;
  }

  private async collectLPHoldings(
    treasuryAddress: string,
    allPairs: string[],
    priceMap: Map<string, number>,
  ): Promise<TokenBalance[]> {
    const holdings: TokenBalance[] = [];

    for (const pairAddress of allPairs) {
      try {
        const pair = this.client.pair(pairAddress);
        const lpAddress = await pair.getLPTokenAddress();
        const lpToken = this.client.lpToken(lpAddress);

        const [lpBalance, totalSupply, { reserve0, reserve1 }, { token0, token1 }, meta] =
          await Promise.all([
            lpToken.balance(treasuryAddress),
            lpToken.totalSupply(),
            pair.getReserves(),
            pair.getTokens(),
            lpToken.metadata(),
          ]);

        if (lpBalance === 0n || totalSupply === 0n) continue;

        const price0 = priceMap.get(token0) ?? 0;
        const price1 = priceMap.get(token1) ?? 0;
        const poolValueUSD =
          (Number(reserve0) / 1e7) * price0 + (Number(reserve1) / 1e7) * price1;
        const shareRatio = Number(lpBalance) / Number(totalSupply);

        holdings.push({
          address: lpAddress,
          symbol: meta.symbol,
          amount: lpBalance,
          valueUSD: shareRatio * poolValueUSD,
        });
      } catch {
        continue;
      }
    }

    return holdings;
  }

  /**
   * Build a token-address → USD-price map using spot rates from pairs.
   * Stablecoin addresses (set at construction) are anchored at $1.
   * Other token prices are derived from stablecoin-paired reserves.
   */
  protected async buildPriceMap(allPairs: string[]): Promise<Map<string, number>> {
    const prices = new Map<string, number>();

    for (const addr of this.stableSet) {
      prices.set(addr, 1.0);
    }

    if (this.stableSet.size === 0) return prices;

    for (const pairAddress of allPairs) {
      try {
        const pair = this.client.pair(pairAddress);
        const [{ token0, token1 }, { reserve0, reserve1 }] = await Promise.all([
          pair.getTokens(),
          pair.getReserves(),
        ]);

        if (reserve0 === 0n || reserve1 === 0n) continue;

        if (this.stableSet.has(token0) && !prices.has(token1)) {
          prices.set(token1, Number(reserve0) / Number(reserve1));
        } else if (this.stableSet.has(token1) && !prices.has(token0)) {
          prices.set(token0, Number(reserve1) / Number(reserve0));
        }
      } catch {
        continue;
      }
    }

    return prices;
  }

  /** Ledgers per 30-day window (used by getFeeRevenue default period). */
  protected get ledgersPer30Days(): number {
    return LEDGERS_PER_30_DAYS;
  }
}
