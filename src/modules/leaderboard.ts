import { CoralSwapClient } from "@/client";
import { validateAddress } from "@/utils/validation";
import { ValidationError } from "@/errors";
import { SorobanRpc } from "@stellar/stellar-sdk";

export interface LeaderboardEntry {
  rank: number;
  address: string;
  metric: "volume" | "yield";
  metricValue: bigint;
  change24h: number;
}

export interface LeaderboardOptions {
  period: "24h" | "7d" | "30d";
  limit?: number;
  pairAddress?: string;
}

/**
 * Leaderboard module — ranks top LPs and traders by yield/volume.
 *
 * Interacts directly with Soroban contract events using the client RPC server
 * to compute real-time performance rankings.
 */
export class LeaderboardModule {
  private client: CoralSwapClient;

  constructor(client: CoralSwapClient) {
    this.client = client;
  }

  /**
   * Get the leaderboard of top LPs or traders by volume/yield.
   *
   * @param type - The type of leaderboard: 'lp' or 'trader'
   * @param options - Leaderboard options including period, limit, and pairAddress
   * @returns A promise resolving to an array of LeaderboardEntry objects
   */
  async getLeaderboard(
    type: "lp" | "trader",
    options: LeaderboardOptions = { period: "24h" },
  ): Promise<LeaderboardEntry[]> {
    if (type !== "lp" && type !== "trader") {
      throw new ValidationError(`Invalid leaderboard type: ${type}`);
    }

    const period = options.period ?? "24h";
    if (period !== "24h" && period !== "7d" && period !== "30d") {
      throw new ValidationError(`Invalid leaderboard period: ${period}`);
    }

    if (options.pairAddress) {
      validateAddress(options.pairAddress, "pairAddress");
    }

    // Determine ledger window sizes
    const ledgersPerDay = 17280;
    let periodLedgers = ledgersPerDay;
    if (period === "7d") periodLedgers = ledgersPerDay * 7;
    else if (period === "30d") periodLedgers = ledgersPerDay * 30;

    const currentLedger = await this.client.getCurrentLedger();
    const startLedger = Math.max(0, currentLedger - periodLedgers - ledgersPerDay);
    const endLedger = currentLedger;

    const topic = type === "trader" ? "swap" : "add_liquidity";

    const request: SorobanRpc.Server.GetEventsRequest = {
      startLedger,
      filters: [
        {
          type: "contract",
          contractIds: options.pairAddress ? [options.pairAddress] : [],
          topics: [[topic]],
        },
      ],
      limit: 1000,
    };

    const response = await this.client.server.getEvents(request);
    if (!response || !Array.isArray(response.events)) return [];

    const currentMap = new Map<string, bigint>();
    const previousMap = new Map<string, bigint>();

    const currentStartBound = Math.max(0, currentLedger - periodLedgers);
    const previousStartBound = Math.max(0, currentLedger - periodLedgers - ledgersPerDay);
    const previousEndBound = Math.max(0, currentLedger - ledgersPerDay);

    for (const ev of response.events) {
      if (options.pairAddress && ev.contractId?.toString() !== options.pairAddress) continue;
      const topicName = ev.topic?.[0] ? decodeScValString(ev.topic[0]) : "";
      if (topicName !== topic) continue;
      if (!ev.value) continue;

      const data = decodeMapEvent(ev.value);
      if (!data) continue;

      const addressKey = type === "trader" ? "sender" : "provider";
      const userAddress = readAddress(data, addressKey);
      if (!userAddress) continue;

      const metricKey = type === "trader" ? "amount_in" : "liquidity";
      const value = readI128(data, metricKey);
      if (value === undefined) continue;

      // Classify event ledger sequence into current or previous period
      if (ev.ledger >= currentStartBound && ev.ledger <= endLedger) {
        currentMap.set(userAddress, (currentMap.get(userAddress) ?? 0n) + value);
      }
      if (ev.ledger >= previousStartBound && ev.ledger <= previousEndBound) {
        previousMap.set(userAddress, (previousMap.get(userAddress) ?? 0n) + value);
      }
    }

    // Convert currentMap to entries and sort
    const entries: LeaderboardEntry[] = [];
    const metricName = type === "trader" ? "volume" : "yield";

    for (const [address, metricValue] of currentMap.entries()) {
      const prevValue = previousMap.get(address) ?? 0n;
      let change24h = 0;

      if (prevValue > 0n) {
        change24h = Number(((metricValue - prevValue) * 10000n) / prevValue) / 100;
      } else if (metricValue > 0n) {
        change24h = 100;
      }

      entries.push({
        rank: 0,
        address,
        metric: metricName,
        metricValue,
        change24h,
      });
    }

    // Sort by metricValue descending
    entries.sort((a, b) => {
      if (b.metricValue > a.metricValue) return 1;
      if (b.metricValue < a.metricValue) return -1;
      return 0;
    });

    // Assign ranks
    entries.forEach((entry, idx) => {
      entry.rank = idx + 1;
    });

    const limit = options.limit ?? entries.length;
    return entries.slice(0, limit);
  }
}

// ---------------------------------------------------------------------------
// Event Decoding Helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function decodeMapEvent(value: any): Map<string, any> | null {
  const entries: unknown[] =
    typeof value?.map === "function" ? value.map() : value?._value;
  if (!Array.isArray(entries)) return null;

  const map = new Map<string, unknown>();
  for (const entry of entries as Array<{ key: unknown; val: unknown }>) {
    const k = entry.key as Record<string, () => { toString(): string }>;
    let key: string | undefined;
    try {
      key = k.sym?.().toString() ?? k.str?.().toString();
    } catch { /* skip */ }
    if (key) map.set(key, entry.val);
  }
  return map as Map<string, unknown>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readAddress(map: Map<string, any>, key: string): string | undefined {
  const val = map.get(key);
  if (!val) return undefined;
  try {
    if (typeof val.address === "function") return val.address().toString();
    if (typeof val._value?.toString === "function") return val._value.toString();
  } catch { /* skip */ }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readI128(map: Map<string, any>, key: string): bigint | undefined {
  const val = map.get(key);
  if (!val) return undefined;
  try {
    if (typeof val.i128 === "function") {
      const parts = val.i128();
      return (BigInt(parts.hi().toString()) << 64n) + BigInt(parts.lo().toString());
    }
  } catch { /* skip */ }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function decodeScValString(val: any): string {
  if (!val) return "";
  if (typeof val === "string") return val;
  if (typeof val.sym === "function") return val.sym().toString();
  if (typeof val.str === "function") return val.str().toString();
  return val.toString();
import { CoralSwapClient } from "../client";
import { TreasuryModule, TreasuryModuleOptions } from "./treasury";
import { SwapModule } from "./swap";
import { validateAddress } from "../utils/validation";

/**
 * Rankings for a trader based on their swap activity.
 */
export interface TraderRanking {
  /** The wallet address of the trader. */
  address: string;
  /** Total volume traded in USD across all pairs. */
  totalVolumeUSD: number;
  /** Total number of trades executed (includes all swap types). */
  tradeCount: number;
  /** Average trade size in USD. */
  avgTradeSize: number;
  /** The pair contract address the trader interacted with most. */
  favoritePool: string;
  /** Percentage of swaps where output value > input value at time of trade (0-100). */
  winRate: number;
}

/**
 * Options for querying the top traders leaderboard.
 */
export interface GetTopTradersOptions {
  /** The period in days to look back for swaps (defaults to 30). */
  periodDays?: number;
  /** Optional pool/pair address to restrict the query. */
  pairAddress?: string;
  /** Maximum number of top traders to return. */
  limit?: number;
  /** Optional custom stablecoin addresses to override the constructor ones. */
  stableAddresses?: string[];
  /** Optional starting ledger sequence override. */
  fromLedger?: number;
  /** Optional ending ledger sequence override. */
  toLedger?: number;
}

const decimalsCache = new Map<string, number>();

async function getTokenDecimals(client: CoralSwapClient, address: string): Promise<number> {
  if (decimalsCache.has(address)) {
    return decimalsCache.get(address)!;
  }
  try {
    const meta = await client.lpToken(address).metadata();
    decimalsCache.set(address, meta.decimals);
    return meta.decimals;
  } catch {
    return 7; // standard fallback for Soroban
  }
}

/**
 * Leaderboard module -- ranks traders by swap volume and calculates stats.
 */
export class LeaderboardModule extends TreasuryModule {
  private readonly leaderboardClient: CoralSwapClient;
  private readonly leaderboardStableSet: Set<string>;

  constructor(client: CoralSwapClient, options: TreasuryModuleOptions = {}) {
    super(client, options);
    this.leaderboardClient = client;
    this.leaderboardStableSet = new Set(options.stableAddresses ?? []);
  }

  /**
   * Get the top traders ranked by total swap volume in USD.
   *
   * @param options - Query parameters (periodDays, pairAddress, limit, etc.)
   * @returns List of top traders and their stats sorted by volume descending.
   */
  async getTopTraders(options: GetTopTradersOptions = {}): Promise<TraderRanking[]> {
    if (options.pairAddress) {
      validateAddress(options.pairAddress, "pairAddress");
    }

    const periodDays = options.periodDays ?? 30;
    const currentLedger = await this.leaderboardClient.getCurrentLedger();
    const estimatedLedgers = Math.floor((periodDays * 24 * 60 * 60) / 5);
    const fromLedger = options.fromLedger ?? Math.max(0, currentLedger - estimatedLedgers);
    const toLedger = options.toLedger ?? currentLedger;

    const swapModule = new SwapModule(this.leaderboardClient);
    const swaps = await swapModule.getSwapHistory({
      pairAddress: options.pairAddress,
      fromLedger,
      toLedger,
      limit: 10000,
    });

    if (swaps.length === 0) {
      return [];
    }

    // Identify all unique tokens in the swaps to fetch their decimals
    const uniqueTokens = new Set<string>();
    for (const swap of swaps) {
      uniqueTokens.add(swap.tokenIn);
      uniqueTokens.add(swap.tokenOut);
    }

    // Fetch decimals for all tokens concurrently
    const decimalsMap = new Map<string, number>();
    await Promise.all(
      Array.from(uniqueTokens).map(async (token) => {
        const dec = await getTokenDecimals(this.leaderboardClient, token);
        decimalsMap.set(token, dec);
      })
    );

    // Get all pairs and prices
    const allPairs = await this.leaderboardClient.factory.getAllPairs();
    const stableAddresses = options.stableAddresses ?? Array.from(this.leaderboardStableSet);
    const priceMap = await this.getPriceMap(allPairs, stableAddresses);

    // Aggregate by trader address
    const tradersData = new Map<
      string,
      {
        totalVolumeUSD: number;
        tradeCount: number;
        winCount: number;
        poolCounts: Map<string, number>;
      }
    >();

    for (const swap of swaps) {
      const trader = swap.sender;
      const decIn = decimalsMap.get(swap.tokenIn) ?? 7;
      const decOut = decimalsMap.get(swap.tokenOut) ?? 7;

      const priceIn = priceMap.get(swap.tokenIn) ?? 0;
      const priceOut = priceMap.get(swap.tokenOut) ?? 0;

      // Calculate USD volume
      let volumeUSD = 0;
      if (priceIn > 0) {
        volumeUSD = (Number(swap.amountIn) / 10 ** decIn) * priceIn;
      } else if (priceOut > 0) {
        volumeUSD = (Number(swap.amountOut) / 10 ** decOut) * priceOut;
      }

      // Calculate if it's a win
      const valueIn = (Number(swap.amountIn) / 10 ** decIn) * priceIn;
      const valueOut = (Number(swap.amountOut) / 10 ** decOut) * priceOut;
      const isWin = (priceIn > 0 || priceOut > 0) && valueOut > valueIn;

      let record = tradersData.get(trader);
      if (!record) {
        record = {
          totalVolumeUSD: 0,
          tradeCount: 0,
          winCount: 0,
          poolCounts: new Map<string, number>(),
        };
        tradersData.set(trader, record);
      }

      record.totalVolumeUSD += volumeUSD;
      record.tradeCount += 1;
      if (isWin) {
        record.winCount += 1;
      }

      const pool = swap.pairAddress;
      record.poolCounts.set(pool, (record.poolCounts.get(pool) ?? 0) + 1);
    }

    // Convert aggregated data to TraderRanking objects
    const rankings: TraderRanking[] = [];
    for (const [address, data] of tradersData.entries()) {
      let favoritePool = "";
      let maxCount = -1;
      for (const [pool, count] of data.poolCounts.entries()) {
        if (count > maxCount) {
          maxCount = count;
          favoritePool = pool;
        }
      }

      const winRate = data.tradeCount > 0 ? (data.winCount / data.tradeCount) * 100 : 0;
      const avgTradeSize = data.tradeCount > 0 ? data.totalVolumeUSD / data.tradeCount : 0;

      rankings.push({
        address,
        totalVolumeUSD: data.totalVolumeUSD,
        tradeCount: data.tradeCount,
        avgTradeSize,
        favoritePool,
        winRate,
      });
    }

    // Sort by totalVolumeUSD descending
    rankings.sort((a, b) => b.totalVolumeUSD - a.totalVolumeUSD);

    if (options.limit && options.limit > 0) {
      return rankings.slice(0, options.limit);
    }

    return rankings;
  }

  private async getPriceMap(allPairs: string[], stableAddresses: string[]): Promise<Map<string, number>> {
    const prices = new Map<string, number>();
    const stableSet = new Set(stableAddresses);

    for (const addr of stableSet) {
      prices.set(addr, 1.0);
    }

    if (stableSet.size === 0) return prices;

    for (const pairAddress of allPairs) {
      try {
        const pair = this.leaderboardClient.pair(pairAddress);
        const [{ token0, token1 }, { reserve0, reserve1 }] = await Promise.all([
          pair.getTokens(),
          pair.getReserves(),
        ]);

        if (reserve0 === 0n || reserve1 === 0n) continue;

        if (stableSet.has(token0) && !prices.has(token1)) {
          prices.set(token1, Number(reserve0) / Number(reserve1));
        } else if (stableSet.has(token1) && !prices.has(token0)) {
          prices.set(token0, Number(reserve1) / Number(reserve0));
        }
      } catch {
        continue;
      }
    }

    return prices;
  }
}
