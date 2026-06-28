/* eslint-disable @typescript-eslint/no-explicit-any */
import { CoralSwapClient } from '@/client';
import { TradeType } from '@/types/common';
import { SwapQuote } from '@/types/swap';
import { DEFAULTS, PRECISION } from '@/config';
import type { SwapModule } from './swap';

/**
 * Result of the pathfinding algorithm.
 */
export interface OptimalPath {
  path: string[];
  quote: SwapQuote;
}

/** Default time-to-live for cached paths in milliseconds (30 seconds). */
const DEFAULT_CACHE_TTL_MS = 30_000;

interface CacheEntry {
  result: OptimalPath | null;
  expiresAt: number;
}

/**
 * Router module -- provides off-chain pathfinding and route optimization.
 */
export class RouterModule {
  private client: CoralSwapClient;
  private pathCache: Map<string, CacheEntry> = new Map();
  private cacheTtlMs: number;

  constructor(client: CoralSwapClient, cacheTtlMs: number = DEFAULT_CACHE_TTL_MS) {
    this.client = client;
    this.cacheTtlMs = cacheTtlMs;
  }

  /**
   * Find the most efficient route between two tokens off-chain.
   *
   * Fetches all pairs from the factory to build a token graph and
   * simulates swaps across all paths up to 3 hops.
   *
   * For `EXACT_IN`, the optimal path maximises the output amount.
   * For `EXACT_OUT`, the optimal path minimises the required input amount.
   *
   * @param tokenIn - Source token address.
   * @param tokenOut - Destination token address.
   * @param amount - Amount to swap (in smallest units).
   * @param tradeType - EXACT_IN (maximise output) or EXACT_OUT (minimise input).
   * @returns The best path and its estimated quote.
   */
  async findOptimalPath(
    tokenIn: string,
    tokenOut: string,
    amount: bigint,
    tradeType: TradeType = TradeType.EXACT_IN,
  ): Promise<OptimalPath | null> {
    const cacheKey = `${tokenIn}:${tokenOut}:${tradeType}:${amount}`;
    const cached = this.pathCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.result;
    }

    const allPairs = await this.client.factory.getAllPairs();
    const tokenGraph = await this.buildTokenGraph(allPairs);

    const paths = this.findAllPaths(tokenIn, tokenOut, tokenGraph, 3);
    if (paths.length === 0) {
      this.pathCache.set(cacheKey, { result: null, expiresAt: Date.now() + this.cacheTtlMs });
      return null;
    }

    // Filter out paths containing zero-liquidity hops
    const viablePaths = await this.filterZeroLiquidityPaths(paths);
    if (viablePaths.length === 0) {
      this.pathCache.set(cacheKey, { result: null, expiresAt: Date.now() + this.cacheTtlMs });
      return null;
    }

    let bestPath: OptimalPath | null = null;

    const swapModule = new (await import('./swap')).SwapModule(this.client);

    for (const path of viablePaths) {
      try {
        let quote: SwapQuote;
        if (path.length === 2) {
          quote = await swapModule.getQuote({
            tokenIn: path[0],
            tokenOut: path[1],
            amount,
            tradeType,
            path,
          });
        } else if (tradeType === TradeType.EXACT_OUT) {
          // getMultiHopQuote does not support EXACT_OUT — compute directly
          quote = await this.buildExactOutMultiHopQuote(swapModule, path, amount);
        } else {
          quote = await swapModule.getMultiHopQuote({
            tokenIn: path[0],
            tokenOut: path[path.length - 1],
            amount,
            tradeType,
            path,
          }, path);
        }

        const isBetter =
          tradeType === TradeType.EXACT_OUT
            ? !bestPath || quote.amountIn < bestPath.quote.amountIn
            : !bestPath || quote.amountOut > bestPath.quote.amountOut;

        if (isBetter) {
          bestPath = { path, quote };
        }
      } catch {
        // Skip paths with insufficient liquidity or other errors
        continue;
      }
    }

    this.pathCache.set(cacheKey, { result: bestPath, expiresAt: Date.now() + this.cacheTtlMs });
    return bestPath;
  }

  /**
   * Build a SwapQuote for a multi-hop EXACT_OUT path using reverse hop computation.
   *
   * `getMultiHopQuote` only supports EXACT_IN. For EXACT_OUT multi-hop paths the
   * router calls `computeHopsReverse` directly and assembles the quote here.
   */
  private async buildExactOutMultiHopQuote(
    swapModule: SwapModule,
    path: string[],
    amountOut: bigint,
  ): Promise<SwapQuote> {
    const hops = await swapModule.computeHopsReverse(amountOut, path);

    const amountIn = hops[0].amountIn;
    const totalFeeAmount = hops.reduce((acc, h) => acc + h.feeAmount, 0n);
    const totalFeeBps = hops.reduce((acc, h) => acc + h.feeBps, 0);
    const compoundImpactBps = swapModule.compoundPriceImpact(hops.map((h) => h.priceImpactBps));

    const slippageBps =
      (this.client as any).config?.defaultSlippageBps ?? DEFAULTS.slippageBps;
    const amountOutMin =
      amountOut - (amountOut * BigInt(slippageBps)) / PRECISION.BPS_DENOMINATOR;

    return {
      tokenIn: path[0],
      tokenOut: path[path.length - 1],
      amountIn,
      amountOut,
      amountOutMin,
      priceImpactBps: compoundImpactBps,
      feeBps: totalFeeBps,
      feeAmount: totalFeeAmount,
      path,
      deadline: (this.client as any).getDeadline?.() ?? Math.floor(Date.now() / 1000) + DEFAULTS.deadlineSec,
    };
  }

  /**
   * Clear the in-memory path cache.
   *
   * Call this after liquidity changes or when fresh results are needed.
   */
  clearPathCache(): void {
    this.pathCache.clear();
  }

  /**
   * Filter out paths that contain at least one hop with zero reserves.
   */
  private async filterZeroLiquidityPaths(paths: string[][]): Promise<string[][]> {
    const viable: string[][] = [];

    for (const path of paths) {
      let hasLiquidity = true;

      for (let i = 0; i < path.length - 1; i++) {
        const pairAddress = await this.client.getPairAddress(path[i], path[i + 1]);
        if (!pairAddress) {
          hasLiquidity = false;
          break;
        }

        const pair = this.client.pair(pairAddress);
        try {
          const reserves = await pair.getReserves();
          if (reserves.reserve0 === 0n || reserves.reserve1 === 0n) {
            hasLiquidity = false;
            break;
          }
        } catch {
          hasLiquidity = false;
          break;
        }
      }

      if (hasLiquidity) {
        viable.push(path);
      }
    }

    return viable;
  }

  /**
   * Build an adjacency list representing the token graph from pair addresses.
   */
  private async buildTokenGraph(pairAddresses: string[]): Promise<Record<string, string[]>> {
    const graph: Record<string, string[]> = {};

    const tokenPairs = await Promise.all(
      pairAddresses.map(async (addr) => {
        try {
          const pair = this.client.pair(addr);
          return await pair.getTokens();
        } catch {
          return null;
        }
      }),
    );

    for (const tokens of tokenPairs) {
      if (!tokens) continue;
      const { token0, token1 } = tokens;

      if (!graph[token0]) graph[token0] = [];
      if (!graph[token1]) graph[token1] = [];

      if (!graph[token0].includes(token1)) graph[token0].push(token1);
      if (!graph[token1].includes(token0)) graph[token1].push(token0);
    }

    return graph;
  }

  /**
   * Find all paths between two tokens in the graph up to a maximum number of hops.
   */
  private findAllPaths(
    start: string,
    end: string,
    graph: Record<string, string[]>,
    maxHops: number,
  ): string[][] {
    const paths: string[][] = [];
    const queue: { current: string; path: string[] }[] = [{ current: start, path: [start] }];

    while (queue.length > 0) {
      const { current, path } = queue.shift()!;

      if (current === end) {
        if (path.length > 1) {
          paths.push(path);
        }
        continue;
      }

      if (path.length > maxHops) continue;

      const neighbors = graph[current] || [];
      for (const neighbor of neighbors) {
        if (!path.includes(neighbor)) {
          queue.push({ current: neighbor, path: [...path, neighbor] });
        }
      }
    }

    return paths;
  }
}
