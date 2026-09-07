import { Keypair } from '@stellar/stellar-sdk';
import { CoralSwapClient } from '../src/client';
import { SwapModule } from '../src/modules/swap';
import { PositionsModule } from '../src/modules/positions';
import { RouterModule } from '../src/modules/router';
import { FeeModule } from '../src/modules/fees';
import { OracleModule } from '../src/modules/oracle';
import { LiquidityModule } from '../src/modules/liquidity';
import { FactoryModule } from '../src/modules/factory';
import { TreasuryModule } from '../src/modules/treasury';
import { Network } from '../src/types/common';
import { LatencyMockProvider } from './latency-mock-provider';

// ---------------------------------------------------------------------------
// Shared token / pair fixtures (valid Soroban contract IDs)
// ---------------------------------------------------------------------------

export const TOKEN_A =
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
export const TOKEN_B =
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4';
export const TOKEN_C =
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M';
export const TOKEN_D =
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJG3M';
export const TOKEN_E =
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKL3M';
export const TOKEN_F =
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMP3M';
export const TOKEN_G =
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAANQ3M';
export const PAIR_AB =
  'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
export const PAIR_BC =
  'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K';
export const PAIR_AD =
  'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSD';
export const PAIR_BE =
  'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4L';
export const PAIR_CF =
  'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSE';
export const PAIR_DG =
  'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4M';
export const PAIR_EG =
  'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSF';
export const PAIR_FG =
  'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4N';
export const PAIR_AF =
  'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSG';
export const PAIR_BD =
  'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4P';
export const LP_TOKEN =
  'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WRTP5AP5WOJVRY3WNT';
export const OWNER =
  'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';

const TEST_SECRET =
  'SB6K2AINTGNYBFX4M7TRPGSKQ5RKNOXXWB7UZUHRYOVTM7REDUGECKZU';
export const TEST_PUBLIC = Keypair.fromSecret(TEST_SECRET).publicKey();

const FACTORY_ADDRESS =
  'CA3J7GYCCX7NVPYQ37DSVUTVD3YKH7TDRYQFYMCH5FDD3E2XCC7M326';
const ROUTER_ADDRESS =
  'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K';

const RESERVE = 1_000_000_000n;
const FEE_BPS = 30;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withLatency<T>(
  fn: (...args: never[]) => Promise<T>,
  latencyMs: number,
): (...args: never[]) => Promise<T> {
  return async (...args) => {
    if (latencyMs > 0) await sleep(latencyMs);
    return fn(...args);
  };
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// ---------------------------------------------------------------------------
// Mock pair graph for multi-hop routing benchmarks
// ---------------------------------------------------------------------------

const PAIR_GRAPH: Record<
  string,
  {
    reserve0: bigint;
    reserve1: bigint;
    feeBps: number;
    token0: string;
    token1: string;
  }
> = {
  [pairKey(TOKEN_A, TOKEN_B)]: {
    reserve0: RESERVE,
    reserve1: RESERVE,
    feeBps: FEE_BPS,
    token0: TOKEN_A,
    token1: TOKEN_B,
  },
  [pairKey(TOKEN_B, TOKEN_C)]: {
    reserve0: RESERVE,
    reserve1: RESERVE,
    feeBps: FEE_BPS,
    token0: TOKEN_B,
    token1: TOKEN_C,
  },
  [pairKey(TOKEN_A, TOKEN_D)]: {
    reserve0: RESERVE,
    reserve1: RESERVE,
    feeBps: FEE_BPS,
    token0: TOKEN_A,
    token1: TOKEN_D,
  },
  [pairKey(TOKEN_B, TOKEN_E)]: {
    reserve0: RESERVE,
    reserve1: RESERVE,
    feeBps: FEE_BPS,
    token0: TOKEN_B,
    token1: TOKEN_E,
  },
  [pairKey(TOKEN_C, TOKEN_F)]: {
    reserve0: RESERVE,
    reserve1: RESERVE,
    feeBps: FEE_BPS,
    token0: TOKEN_C,
    token1: TOKEN_F,
  },
  [pairKey(TOKEN_D, TOKEN_G)]: {
    reserve0: RESERVE,
    reserve1: RESERVE,
    feeBps: FEE_BPS,
    token0: TOKEN_D,
    token1: TOKEN_G,
  },
  [pairKey(TOKEN_E, TOKEN_G)]: {
    reserve0: RESERVE,
    reserve1: RESERVE,
    feeBps: FEE_BPS,
    token0: TOKEN_E,
    token1: TOKEN_G,
  },
  [pairKey(TOKEN_F, TOKEN_G)]: {
    reserve0: RESERVE,
    reserve1: RESERVE,
    feeBps: FEE_BPS,
    token0: TOKEN_F,
    token1: TOKEN_G,
  },
  [pairKey(TOKEN_A, TOKEN_F)]: {
    reserve0: RESERVE,
    reserve1: RESERVE,
    feeBps: FEE_BPS,
    token0: TOKEN_A,
    token1: TOKEN_F,
  },
  [pairKey(TOKEN_B, TOKEN_D)]: {
    reserve0: RESERVE,
    reserve1: RESERVE,
    feeBps: FEE_BPS,
    token0: TOKEN_B,
    token1: TOKEN_D,
  },
};

function mockPair(
  cfg: (typeof PAIR_GRAPH)[string],
  latencyMs: number,
) {
  return {
    getReserves: withLatency(
      async () => ({ reserve0: cfg.reserve0, reserve1: cfg.reserve1 }),
      latencyMs,
    ),
    getDynamicFee: withLatency(async () => cfg.feeBps, latencyMs),
    getTokens: withLatency(
      async () => ({ token0: cfg.token0, token1: cfg.token1 }),
      latencyMs,
    ),
    getFeeState: withLatency(
      async () => ({
        priceLast: 0n,
        volAccumulator: 0n,
        lastUpdated: Math.floor(Date.now() / 1000) - 60,
        feeCurrent: cfg.feeBps,
        feeMin: 10,
        feeMax: 100,
        emaAlpha: 200,
        feeLastChanged: 0,
        emaDecayRate: 100,
        baselineFee: cfg.feeBps,
      }),
      latencyMs,
    ),
    getLPTokenAddress: withLatency(async () => LP_TOKEN, latencyMs),
    getCumulativePrices: withLatency(
      async () => ({
        price0CumulativeLast: 1_000_000n,
        price1CumulativeLast: 2_000_000n,
        blockTimestampLast: Math.floor(Date.now() / 1000) - 300,
      }),
      latencyMs,
    ),
  };
}

export interface BenchmarkModules {
  client: CoralSwapClient;
  swap: SwapModule;
  positions: PositionsModule;
  router: RouterModule;
  fees: FeeModule;
  oracle: OracleModule;
  liquidity: LiquidityModule;
  factoryModule: FactoryModule;
  treasury: TreasuryModule;
}

/**
 * Build a CoralSwapClient wired to a latency-injecting MockProvider for
 * direct Soroban RPC benchmarks.
 */
export function createRpcClient(latencyMs: number): CoralSwapClient {
  const mock = new LatencyMockProvider(latencyMs);
  mock.setAccount(TEST_PUBLIC, { sequence: '100' });
  mock.setAccount(
    'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    { sequence: '1' },
  );
  mock.setLatestLedger(1500);

  const client = new CoralSwapClient({
    network: Network.TESTNET,
    secretKey: TEST_SECRET,
    maxRetries: 0,
  });

  (client as unknown as { server: typeof mock }).server = mock;
  (client as { networkConfig: { factoryAddress: string; routerAddress: string } })
    .networkConfig.factoryAddress = FACTORY_ADDRESS;
  (client as { networkConfig: { routerAddress: string } }).networkConfig.routerAddress =
    ROUTER_ADDRESS;

  return client;
}

/**
 * Build module instances backed by latency-simulated RPC contract reads.
 */
export function createModuleContext(latencyMs: number): BenchmarkModules {
  const pairInstances: Record<string, ReturnType<typeof mockPair>> = {};
  for (const [key, cfg] of Object.entries(PAIR_GRAPH)) {
    pairInstances[key] = mockPair(cfg, latencyMs);
  }
  pairInstances[PAIR_AB] = mockPair(PAIR_GRAPH[pairKey(TOKEN_A, TOKEN_B)], latencyMs);

  const mockLpToken = {
    balance: withLatency(async () => 500_000n, latencyMs),
    totalSupply: withLatency(async () => 1_000_000n, latencyMs),
  };

  const mockFactory = {
    getAllPairs: withLatency(
      async () => [
        PAIR_AB,
        PAIR_BC,
        PAIR_AD,
        PAIR_BE,
        PAIR_CF,
        PAIR_DG,
        PAIR_EG,
        PAIR_FG,
        PAIR_AF,
        PAIR_BD,
      ],
      latencyMs,
    ),
    getPair: withLatency(async (tokenA: string, tokenB: string) => {
      const key = pairKey(tokenA, tokenB);
      if (key === pairKey(TOKEN_A, TOKEN_B)) return PAIR_AB;
      if (key === pairKey(TOKEN_B, TOKEN_C)) return PAIR_BC;
      if (key === pairKey(TOKEN_A, TOKEN_D)) return PAIR_AD;
      if (key === pairKey(TOKEN_B, TOKEN_E)) return PAIR_BE;
      if (key === pairKey(TOKEN_C, TOKEN_F)) return PAIR_CF;
      if (key === pairKey(TOKEN_D, TOKEN_G)) return PAIR_DG;
      if (key === pairKey(TOKEN_E, TOKEN_G)) return PAIR_EG;
      if (key === pairKey(TOKEN_F, TOKEN_G)) return PAIR_FG;
      if (key === pairKey(TOKEN_A, TOKEN_F)) return PAIR_AF;
      if (key === pairKey(TOKEN_B, TOKEN_D)) return PAIR_BD;
      return null;
    }, latencyMs),
  };

  const mockRouter = {
    getDynamicFee: withLatency(async () => FEE_BPS, latencyMs),
    buildSwapExactIn: () => ({}),
    buildSwapExactOut: () => ({}),
    buildSwapExactTokensForTokens: () => ({}),
  };

  const client = {
    config: { defaultSlippageBps: 50 },
    networkConfig: { networkPassphrase: 'Test SDF Network ; September 2015' },
    getDeadline: () => Math.floor(Date.now() / 1000) + 1200,
    getPairAddress: withLatency(async (tokenA: string, tokenB: string) => {
      const key = pairKey(tokenA, tokenB);
      if (key === pairKey(TOKEN_A, TOKEN_B)) return PAIR_AB;
      if (key === pairKey(TOKEN_B, TOKEN_C)) return PAIR_BC;
      if (key === pairKey(TOKEN_A, TOKEN_D)) return PAIR_AD;
      if (key === pairKey(TOKEN_B, TOKEN_E)) return PAIR_BE;
      if (key === pairKey(TOKEN_C, TOKEN_F)) return PAIR_CF;
      if (key === pairKey(TOKEN_D, TOKEN_G)) return PAIR_DG;
      if (key === pairKey(TOKEN_E, TOKEN_G)) return PAIR_EG;
      if (key === pairKey(TOKEN_F, TOKEN_G)) return PAIR_FG;
      if (key === pairKey(TOKEN_A, TOKEN_F)) return PAIR_AF;
      if (key === pairKey(TOKEN_B, TOKEN_D)) return PAIR_BD;
      return null;
    }, latencyMs),
    pair: (addr: string) => {
      if (addr === PAIR_AB) return pairInstances[pairKey(TOKEN_A, TOKEN_B)];
      if (addr === PAIR_BC) return pairInstances[pairKey(TOKEN_B, TOKEN_C)];
      if (addr === PAIR_AD) return pairInstances[pairKey(TOKEN_A, TOKEN_D)];
      if (addr === PAIR_BE) return pairInstances[pairKey(TOKEN_B, TOKEN_E)];
      if (addr === PAIR_CF) return pairInstances[pairKey(TOKEN_C, TOKEN_F)];
      if (addr === PAIR_DG) return pairInstances[pairKey(TOKEN_D, TOKEN_G)];
      if (addr === PAIR_EG) return pairInstances[pairKey(TOKEN_E, TOKEN_G)];
      if (addr === PAIR_FG) return pairInstances[pairKey(TOKEN_F, TOKEN_G)];
      if (addr === PAIR_AF) return pairInstances[pairKey(TOKEN_A, TOKEN_F)];
      if (addr === PAIR_BD) return pairInstances[pairKey(TOKEN_B, TOKEN_D)];
      return pairInstances[pairKey(TOKEN_A, TOKEN_B)];
    },
    lpToken: () => mockLpToken,
    factory: mockFactory,
    router: mockRouter,
    publicKey: TEST_PUBLIC,
  } as unknown as CoralSwapClient;

  return {
    client,
    swap: new SwapModule(client),
    positions: new PositionsModule(client),
    router: new RouterModule(client, 0),
    fees: new FeeModule(client),
    oracle: new OracleModule(client),
    liquidity: new LiquidityModule(client),
    factoryModule: new FactoryModule(client),
    treasury: new TreasuryModule(client, {
      stableAddresses: [TOKEN_A, TOKEN_B],
    }),
  };
}

export const SWAP_AMOUNT = 1_000_000n;
