import { CoralSwapClient } from "@/client";
import { LPPosition } from "@/types/pool";
import {
  EnrichedLPPosition,
  GetPositionsOptions,
  PositionSummary,
} from "@/types/positions";
import { ValidationError } from "@/errors";
import { validateAddress } from "@/utils/validation";

/**
 * Positions module — tracks LP positions per address across CoralSwap pools.
 *
 * Builds on top of the raw LPPosition data from the LiquidityModule and
 * enriches each position with pool token addresses, reserves, and fee state.
 */
export class PositionsModule {
  private client: CoralSwapClient;
  private lpTokenCache: Map<string, string> = new Map();

  constructor(client: CoralSwapClient) {
    this.client = client;
  }

  /**
   * Get a single enriched LP position for an owner in a specific pair.
   *
   * @param pairAddress - The address of the pair contract
   * @param owner - The wallet address to query
   * @returns Enriched LP position with token metadata and reserves
   * @example
   * const pos = await sdk.positions.getPosition('C...pair', 'G...wallet');
   */
  async getPosition(
    pairAddress: string,
    owner: string,
  ): Promise<EnrichedLPPosition> {
    validateAddress(pairAddress, "pairAddress");
    validateAddress(owner, "owner");

    const pair = this.client.pair(pairAddress);

    const [reserves, tokens, feeState] = await Promise.all([
      pair.getReserves(),
      pair.getTokens(),
      pair.getFeeState().catch(() => null),
    ]);

    let lpTokenAddress = this.lpTokenCache.get(pairAddress);
    if (!lpTokenAddress) {
      lpTokenAddress = await pair.getLPTokenAddress();
      this.lpTokenCache.set(pairAddress, lpTokenAddress);
    }

    const lpClient = this.client.lpToken(lpTokenAddress);

    const [balance, totalSupply] = await Promise.all([
      lpClient.balance(owner),
      lpClient.totalSupply(),
    ]);

    const share =
      totalSupply > 0n ? Number((balance * 10000n) / totalSupply) / 10000 : 0;

    const token0Amount =
      totalSupply > 0n ? (reserves.reserve0 * balance) / totalSupply : 0n;
    const token1Amount =
      totalSupply > 0n ? (reserves.reserve1 * balance) / totalSupply : 0n;

    return {
      pairAddress,
      lpTokenAddress,
      balance,
      totalSupply,
      share,
      token0Amount,
      token1Amount,
      token0: tokens.token0,
      token1: tokens.token1,
      reserve0: reserves.reserve0,
      reserve1: reserves.reserve1,
      feeBps: feeState?.feeCurrent ?? 0,
    };
  }

  /**
   * Get all LP positions for an owner across multiple pairs.
   *
   * @param owner - The wallet address to query
   * @param options - Optional filters: includeEmpty, pairAddresses
   * @returns A PositionSummary with all matching positions
   * @example
   * const summary = await sdk.positions.getPositions('G...wallet');
   * const summary = await sdk.positions.getPositions('G...wallet', { includeEmpty: true });
   * const summary = await sdk.positions.getPositions('G...wallet', { pairAddresses: ['C...'] });
   */
  async getPositions(
    owner: string,
    options: GetPositionsOptions = {},
  ): Promise<PositionSummary> {
    validateAddress(owner, "owner");

    const { includeEmpty = false, pairAddresses } = options;

    const pairs =
      pairAddresses && pairAddresses.length > 0
        ? pairAddresses
        : await this.client.factory.getAllPairs();

    if (pairs.length === 0) {
      return { owner, totalPools: 0, positions: [] };
    }

    const results = await Promise.allSettled(
      pairs.map((addr) => this.getPosition(addr, owner)),
    );

    const positions: EnrichedLPPosition[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        const pos = result.value;
        if (includeEmpty || pos.balance > 0n) {
          positions.push(pos);
        }
      }
    }

    return {
      owner,
      totalPools: positions.length,
      positions,
    };
  }

  /**
   * Check whether an address holds any LP tokens in a given pair.
   *
   * @param pairAddress - The pair contract address
   * @param owner - The wallet address to check
   * @returns true if the owner has a non-zero LP balance
   */
  async hasPosition(pairAddress: string, owner: string): Promise<boolean> {
    validateAddress(pairAddress, "pairAddress");
    validateAddress(owner, "owner");

    let lpTokenAddress = this.lpTokenCache.get(pairAddress);
    if (!lpTokenAddress) {
      const pair = this.client.pair(pairAddress);
      lpTokenAddress = await pair.getLPTokenAddress();
      this.lpTokenCache.set(pairAddress, lpTokenAddress);
    }

    const lpClient = this.client.lpToken(lpTokenAddress);
    const balance = await lpClient.balance(owner);
    return balance > 0n;
  }
}