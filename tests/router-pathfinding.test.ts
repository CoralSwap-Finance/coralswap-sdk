import { RouterModule } from '../src/modules/router';
import { TradeType } from '../src/types/common';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function mockPair(
  token0: string,
  token1: string,
  reserve0: bigint,
  reserve1: bigint,
  feeBps: number,
) {
  return {
    getTokens: jest.fn().mockResolvedValue({ token0, token1 }),
    getReserves: jest.fn().mockResolvedValue({ reserve0, reserve1 }),
    getDynamicFee: jest.fn().mockResolvedValue(feeBps),
  };
}

function buildMockClient(
  pairs: Array<{
    address: string;
    token0: string;
    token1: string;
    reserve0: bigint;
    reserve1: bigint;
    feeBps: number;
  }>,
) {
  const pairMap: Record<string, any> = {};
  for (const p of pairs) {
    pairMap[p.address] = mockPair(p.token0, p.token1, p.reserve0, p.reserve1, p.feeBps);
  }

  return {
    factory: {
      getAllPairs: jest.fn().mockResolvedValue(pairs.map((p) => p.address)),
    },
    pair: jest.fn().mockImplementation((addr: string) => pairMap[addr]),
    getPairAddress: jest.fn().mockImplementation(async (a: string, b: string) => {
      const p = pairs.find(
        (pair) => (pair.token0 === a && pair.token1 === b) || (pair.token0 === b && pair.token1 === a),
      );
      return p ? p.address : null;
    }),
    config: { defaultSlippageBps: 50 },
    getDeadline: jest.fn().mockReturnValue(9999999999),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Valid-looking Stellar contract addresses (C...)
const T_A = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const T_B = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4';
const T_C = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M';
const T_D = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4';

describe('RouterModule.findOptimalPath', () => {
  it('finds a direct path when it is the only one', async () => {
    const client = buildMockClient([
      { address: 'P_AB', token0: T_A, token1: T_B, reserve0: 1000000n, reserve1: 1000000n, feeBps: 30 },
    ]);
    const routerModule = new RouterModule(client as any);

    const result = await routerModule.findOptimalPath(T_A, T_B, 1000n);

    expect(result).not.toBeNull();
    expect(result?.path).toEqual([T_A, T_B]);
    expect(result?.quote.amountOut).toBeGreaterThan(0n);
  });

  it('finds the best path among multiple options (direct vs 2-hop)', async () => {
    // Direct path A -> C (low liquidity)
    // 2-hop path A -> B -> C (high liquidity)
    const client = buildMockClient([
      { address: 'P_AC', token0: T_A, token1: T_C, reserve0: 10000n, reserve1: 10000n, feeBps: 30 },
      { address: 'P_AB', token0: T_A, token1: T_B, reserve0: 1000000n, reserve1: 1000000n, feeBps: 30 },
      { address: 'P_BC', token0: T_B, token1: T_C, reserve0: 1000000n, reserve1: 1000000n, feeBps: 30 },
    ]);
    const routerModule = new RouterModule(client as any);

    // Swap 5000 tokens (significant price impact on A-C, low on A-B-C)
    const result = await routerModule.findOptimalPath(T_A, T_C, 5000n);

    expect(result).not.toBeNull();
    expect(result?.path).toEqual([T_A, T_B, T_C]);
  });

  it('finds the best path among multiple options (3-hop vs direct)', async () => {
    // Direct path A -> D (very low liquidity)
    // 3-hop path A -> B -> C -> D (moderate liquidity)
    const client = buildMockClient([
      { address: 'P_AD', token0: T_A, token1: T_D, reserve0: 1000n, reserve1: 1000n, feeBps: 30 },
      { address: 'P_AB', token0: T_A, token1: T_B, reserve0: 100000n, reserve1: 100000n, feeBps: 30 },
      { address: 'P_BC', token0: T_B, token1: T_C, reserve0: 100000n, reserve1: 100000n, feeBps: 30 },
      { address: 'P_CD', token0: T_C, token1: T_D, reserve0: 100000n, reserve1: 100000n, feeBps: 30 },
    ]);
    const routerModule = new RouterModule(client as any);

    const result = await routerModule.findOptimalPath(T_A, T_D, 500n);

    expect(result).not.toBeNull();
    expect(result?.path).toEqual([T_A, T_B, T_C, T_D]);
  });

  it('returns null when no path exists', async () => {
    const client = buildMockClient([
      { address: 'P_AB', token0: T_A, token1: T_B, reserve0: 1000000n, reserve1: 1000000n, feeBps: 30 },
      { address: 'P_CD', token0: T_C, token1: T_D, reserve0: 1000000n, reserve1: 1000000n, feeBps: 30 },
    ]);
    const routerModule = new RouterModule(client as any);

    const result = await routerModule.findOptimalPath(T_A, T_D, 1000n);

    expect(result).toBeNull();
  });

  it('respects the maxHops limit (does not find 4-hop+ paths)', async () => {
    // Path: A -> B -> C -> D -> E
    const T_E = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA5'; // Dummy valid key
    const client = buildMockClient([
      { address: 'P_AB', token0: T_A, token1: T_B, reserve0: 1000000n, reserve1: 1000000n, feeBps: 30 },
      { address: 'P_BC', token0: T_B, token1: T_C, reserve0: 1000000n, reserve1: 1000000n, feeBps: 30 },
      { address: 'P_CD', token0: T_C, token1: T_D, reserve0: 1000000n, reserve1: 1000000n, feeBps: 30 },
      { address: 'P_DE', token0: T_D, token1: T_E, reserve0: 1000000n, reserve1: 1000000n, feeBps: 30 },
    ]);
    const routerModule = new RouterModule(client as any);

    const result = await routerModule.findOptimalPath(T_A, T_E, 1000n);

    expect(result).toBeNull(); // Because A-B-C-D-E is 4 hops
  });
});
