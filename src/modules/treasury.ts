import { CoralSwapClient } from "@/client";
import { TreasuryBalance, TokenBalance } from "@/types/treasury";

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

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

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
