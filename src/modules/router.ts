import { CoralSwapClient } from '@/client';
import { TradeType } from '@/types/common';
import { HopResult, SwapQuote } from '@/types/swap';
import { ValidationError } from '../errors';

/**
 * Result of the pathfinding algorithm.
 */
export interface OptimalPath {
  path: string[];
  quote: SwapQuote;
}

/**
 * Router module -- provides off-chain pathfinding and route optimization.
 */
export class RouterModule {
  private client: CoralSwapClient;

  constructor(client: CoralSwapClient) {
    this.client = client;
  }

  /**
   * Find the most efficient route between two tokens off-chain.
   *
   * Fetches all pairs from the factory to build a token graph and
   * simulates swaps across all paths up to 3 hops.
   *
   * @param tokenIn - Source token address.
   * @param tokenOut - Destination token address.
   * @param amount - Amount to swap (in smallest units).
   * @param tradeType - EXACT_IN only (currently).
   * @returns The best path and its estimated quote.
   */
  async findOptimalPath(
    tokenIn: string,
    tokenOut: string,
    amount: bigint,
    tradeType: TradeType = TradeType.EXACT_IN,
  ): Promise<OptimalPath | null> {
    if (tradeType !== TradeType.EXACT_IN) {
      throw new ValidationError('Only EXACT_IN is currently supported for pathfinding');
    }

    const allPairs = await this.client.factory.getAllPairs();
    const tokenGraph = await this.buildTokenGraph(allPairs);

    const paths = this.findAllPaths(tokenIn, tokenOut, tokenGraph, 3);
    if (paths.length === 0) return null;

    let bestPath: OptimalPath | null = null;

    const swapModule = new (await import('./swap')).SwapModule(this.client);

    for (const path of paths) {
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
        } else {
          quote = await swapModule.getMultiHopQuote({
            path,
            amount,
            tradeType,
          });
        }

        if (!bestPath || quote.amountOut > bestPath.quote.amountOut) {
          bestPath = { path, quote };
        }
      } catch (err) {
        // Skip paths with insufficient liquidity or other errors
        continue;
      }
    }

    return bestPath;
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
