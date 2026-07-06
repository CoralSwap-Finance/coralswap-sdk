import type { BenchmarkOperation } from './types';
import {
  createModuleContext,
  createRpcClient,
  OWNER,
  PAIR_AB,
  SWAP_AMOUNT,
  TOKEN_A,
  TOKEN_B,
  TOKEN_C,
} from './fixtures';
import { TradeType } from '../src/types/common';

/**
 * Register all RPC-calling SDK operations to benchmark.
 *
 * Each operation simulates Soroban RPC round-trip latency via fixtures so
 * results stay reproducible across CI runs (±10 % with fixed latency).
 */
export function buildOperations(rpcLatencyMs: number): BenchmarkOperation[] {
  const ctx = createModuleContext(rpcLatencyMs);
  const rpcClient = createRpcClient(rpcLatencyMs);

  return [
    // --- Direct Soroban RPC (via CoralSwapClient) ---
    {
      name: 'client.isHealthy',
      group: 'rpc',
      run: () => rpcClient.isHealthy(),
    },
    {
      name: 'client.getCurrentLedger',
      group: 'rpc',
      run: () => rpcClient.getCurrentLedger(),
    },

    // --- Swap quotes ---
    {
      name: 'swap.getQuote',
      group: 'swap',
      run: () =>
        ctx.swap.getQuote({
          tokenIn: TOKEN_A,
          tokenOut: TOKEN_B,
          amount: SWAP_AMOUNT,
          tradeType: TradeType.EXACT_IN,
        }),
    },
    {
      name: 'swap.getMultiHopQuote',
      group: 'swap',
      run: () =>
        ctx.swap.getQuote({
          tokenIn: TOKEN_A,
          tokenOut: TOKEN_C,
          amount: SWAP_AMOUNT,
          tradeType: TradeType.EXACT_IN,
          path: [TOKEN_A, TOKEN_B, TOKEN_C],
        }),
    },
    {
      name: 'swap.computeHops',
      group: 'swap',
      run: () => ctx.swap.computeHops(SWAP_AMOUNT, [TOKEN_A, TOKEN_B, TOKEN_C]),
    },

    // --- Portfolio ---
    {
      name: 'positions.getPositions',
      group: 'portfolio',
      run: () => ctx.positions.getPositions(OWNER),
    },
    {
      name: 'positions.getPosition',
      group: 'portfolio',
      run: () => ctx.positions.getPosition(PAIR_AB, OWNER),
    },

    // --- Multi-hop routing ---
    {
      name: 'router.findOptimalPath',
      group: 'routing',
      run: async () => {
        ctx.router.clearPathCache();
        return ctx.router.findOptimalPath(
          TOKEN_A,
          TOKEN_C,
          SWAP_AMOUNT,
          TradeType.EXACT_IN,
        );
      },
    },

    // --- Pool analytics ---
    {
      name: 'fees.getCurrentFee',
      group: 'analytics',
      run: () => ctx.fees.getCurrentFee(PAIR_AB),
    },
    {
      name: 'fees.estimateSwapFee',
      group: 'analytics',
      run: () => ctx.fees.estimateSwapFee(PAIR_AB, SWAP_AMOUNT),
    },
    {
      name: 'oracle.getSpotPrice',
      group: 'analytics',
      run: () => ctx.oracle.getSpotPrice(PAIR_AB),
    },
    {
      name: 'oracle.observe',
      group: 'analytics',
      run: () => ctx.oracle.observe(PAIR_AB),
    },

    // --- Liquidity / factory ---
    {
      name: 'liquidity.getAddLiquidityQuote',
      group: 'liquidity',
      run: () =>
        ctx.liquidity.getAddLiquidityQuote(TOKEN_A, TOKEN_B, SWAP_AMOUNT),
    },
    {
      name: 'factory.getPairAddress',
      group: 'factory',
      run: () =>
        ctx.factoryModule.getPairAddress(TOKEN_A, TOKEN_B, { bypassCache: true }),
    },
    {
      name: 'pair.getReserves',
      group: 'analytics',
      run: () => ctx.client.pair(PAIR_AB).getReserves(),
    },
  ];
}
