import { TreasuryModule } from '../src/modules/treasury';
import { CoralSwapClient } from '../src/client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TREASURY_ADDR = 'CTREASURY000000000000000000000000000000000000000000000000';
const STABLE_ADDR   = 'CUSDC0000000000000000000000000000000000000000000000000000';
const TOKEN_A       = 'CTOKENA00000000000000000000000000000000000000000000000000';
const TOKEN_B       = 'CTOKENB00000000000000000000000000000000000000000000000000';
const LP_ADDR_1     = 'CLP000000000000000000000000000000000000000000000000000001';
const LP_ADDR_2     = 'CLP000000000000000000000000000000000000000000000000000002';
const PAIR_ADDR_1   = 'CPAIR0000000000000000000000000000000000000000000000000001';
const PAIR_ADDR_2   = 'CPAIR0000000000000000000000000000000000000000000000000002';

interface PairSpec {
  lpAddress?: string;
  lpBalance?: bigint;
  totalSupply?: bigint;
  reserve0?: bigint;
  reserve1?: bigint;
  token0?: string;
  token1?: string;
  lpSymbol?: string;
}

function makeMockPair(spec: PairSpec = {}) {
  return {
    getLPTokenAddress: jest.fn().mockResolvedValue(spec.lpAddress ?? LP_ADDR_1),
    getReserves: jest.fn().mockResolvedValue({
      reserve0: spec.reserve0 ?? 1_000_000_0n,  // 1 unit with 7 decimals
      reserve1: spec.reserve1 ?? 1_000_000_0n,
    }),
    getTokens: jest.fn().mockResolvedValue({
      token0: spec.token0 ?? STABLE_ADDR,
      token1: spec.token1 ?? TOKEN_A,
    }),
  };
}

function makeMockLPToken(spec: PairSpec = {}) {
  return {
    balance: jest.fn().mockResolvedValue(spec.lpBalance ?? 5_000_000n),
    totalSupply: jest.fn().mockResolvedValue(spec.totalSupply ?? 10_000_000n),
    metadata: jest.fn().mockResolvedValue({
      symbol: spec.lpSymbol ?? 'CORAL-LP',
      name: 'CoralSwap LP Token',
      decimals: 7,
    }),
  };
}

function makeSwapEvent(
  ledger: number,
  amountIn: bigint,
  feeBps: number,
  tokenIn: string,
) {
  const makeI128 = (n: bigint) => ({
    i128: () => ({ hi: () => ({ toString: () => (n >> 64n).toString() }), lo: () => ({ toString: () => (n & ((1n << 64n) - 1n)).toString() }) }),
  });
  const makeU32 = (n: number) => ({ u32: () => n });
  const makeAddr = (s: string) => ({ address: () => ({ toString: () => s }) });

  const entries = [
    { key: { sym: () => ({ toString: () => 'amount_in' }) }, val: makeI128(amountIn) },
    { key: { sym: () => ({ toString: () => 'fee_bps' }) }, val: makeU32(feeBps) },
    { key: { sym: () => ({ toString: () => 'token_in' }) }, val: makeAddr(tokenIn) },
    { key: { sym: () => ({ toString: () => 'amount_out' }) }, val: makeI128(amountIn - (amountIn * BigInt(feeBps)) / 10000n) },
    { key: { sym: () => ({ toString: () => 'token_out' }) }, val: makeAddr(TOKEN_B) },
    { key: { sym: () => ({ toString: () => 'sender' }) }, val: makeAddr('GSENDER') },
  ];

  return {
    topic: ['swap'],
    value: { map: () => entries },
    ledger,
    contractId: PAIR_ADDR_1,
    txHash: `txhash_${ledger}`,
    ledgerClosedAt: new Date(ledger * 5000).toISOString(),
  };
}

/**
 * Build a fully-mocked CoralSwapClient for TreasuryModule tests.
 * Pass per-address overrides for pairs and LP tokens.
 */
function createMockClient(opts: {
  treasuryAddr?: string;
  pairs?: string[];
  pairSpecs?: Record<string, PairSpec>;
  lpSpecs?: Record<string, PairSpec>;
  currentLedger?: number;
  eventsPerPair?: Record<string, ReturnType<typeof makeSwapEvent>[]>;
} = {}): CoralSwapClient {
  const {
    treasuryAddr = TREASURY_ADDR,
    pairs = [],
    pairSpecs = {},
    lpSpecs = {},
    currentLedger = 100_000,
    eventsPerPair = {},
  } = opts;

  return {
    factory: {
      getFeeTo: jest.fn().mockResolvedValue(treasuryAddr),
      getAllPairs: jest.fn().mockResolvedValue(pairs),
    },
    pair: jest.fn().mockImplementation((addr: string) =>
      makeMockPair(pairSpecs[addr] ?? {}),
    ),
    lpToken: jest.fn().mockImplementation((addr: string) =>
      makeMockLPToken(lpSpecs[addr] ?? {}),
    ),
    server: {
      getEvents: jest.fn().mockImplementation(
        (req: { filters?: Array<{ contractIds?: string[] }> }) => {
          const id = req?.filters?.[0]?.contractIds?.[0] ?? '';
          const events = eventsPerPair[id] ?? [];
          return Promise.resolve({ events });
        },
      ),
    },
    getCurrentLedger: jest.fn().mockResolvedValue(currentLedger),
  } as unknown as CoralSwapClient;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TreasuryModule', () => {

  // =========================================================================
  // getTreasuryAddress()
  // =========================================================================
  describe('getTreasuryAddress()', () => {
    it('returns the fee_to address from the factory', async () => {
      const client = createMockClient({ treasuryAddr: TREASURY_ADDR });
      const treasury = new TreasuryModule(client);

      expect(await treasury.getTreasuryAddress()).toBe(TREASURY_ADDR);
    });
  });

  // =========================================================================
  // getTreasuryBalance()
  // =========================================================================
  describe('getTreasuryBalance()', () => {
    it('returns zero balance when factory has no pairs', async () => {
      const client = createMockClient({ pairs: [] });
      const treasury = new TreasuryModule(client);

      const result = await treasury.getTreasuryBalance();

      expect(result.totalUSD).toBe(0);
      expect(result.tokens).toHaveLength(0);
    });

    it('skips pairs where treasury LP balance is zero', async () => {
      const client = createMockClient({
        pairs: [PAIR_ADDR_1],
        lpSpecs: { [LP_ADDR_1]: { lpBalance: 0n } },
        pairSpecs: { [PAIR_ADDR_1]: { lpAddress: LP_ADDR_1 } },
      });
      const treasury = new TreasuryModule(client);

      const result = await treasury.getTreasuryBalance();

      expect(result.tokens).toHaveLength(0);
      expect(result.totalUSD).toBe(0);
    });

    it('skips pairs where totalSupply is zero', async () => {
      const client = createMockClient({
        pairs: [PAIR_ADDR_1],
        lpSpecs: { [LP_ADDR_1]: { lpBalance: 100n, totalSupply: 0n } },
        pairSpecs: { [PAIR_ADDR_1]: { lpAddress: LP_ADDR_1 } },
      });
      const treasury = new TreasuryModule(client);

      const result = await treasury.getTreasuryBalance();

      expect(result.tokens).toHaveLength(0);
    });

    it('returns an LP token entry for each pair with a non-zero treasury balance', async () => {
      const client = createMockClient({
        pairs: [PAIR_ADDR_1],
        pairSpecs: {
          [PAIR_ADDR_1]: {
            lpAddress: LP_ADDR_1,
            token0: STABLE_ADDR,
            token1: TOKEN_A,
            reserve0: 10_000_000n, // 1 USDC
            reserve1: 10_000_000n, // 1 TOKEN_A
          },
        },
        lpSpecs: {
          [LP_ADDR_1]: {
            lpBalance: 5_000_000n,
            totalSupply: 10_000_000n,
            lpSymbol: 'CORAL-LP',
          },
        },
      });
      const treasury = new TreasuryModule(client, { stableAddresses: [STABLE_ADDR] });

      const result = await treasury.getTreasuryBalance();

      expect(result.tokens).toHaveLength(1);
      expect(result.tokens[0].address).toBe(LP_ADDR_1);
      expect(result.tokens[0].symbol).toBe('CORAL-LP');
      expect(result.tokens[0].amount).toBe(5_000_000n);
    });

    it('computes valueUSD as the treasury share of pool value', async () => {
      // Pool: 10 USDC + 10 TOKEN_A, treasury owns 50% of LP
      // Pool value = (10 * $1) + (10 * $1) = $20 (TOKEN_A priced via USDC pair = $1)
      // Treasury share = 50% × $20 = $10
      const client = createMockClient({
        pairs: [PAIR_ADDR_1],
        pairSpecs: {
          [PAIR_ADDR_1]: {
            lpAddress: LP_ADDR_1,
            token0: STABLE_ADDR,
            token1: TOKEN_A,
            reserve0: 100_000_000n, // 10 USDC (7 decimals)
            reserve1: 100_000_000n, // 10 TOKEN_A (7 decimals; same price as USDC from reserves)
          },
        },
        lpSpecs: {
          [LP_ADDR_1]: { lpBalance: 5_000_000n, totalSupply: 10_000_000n },
        },
      });
      const treasury = new TreasuryModule(client, { stableAddresses: [STABLE_ADDR] });

      const result = await treasury.getTreasuryBalance();

      // Each token priced $1: pool = $20, share 50% = $10
      expect(result.totalUSD).toBeCloseTo(10, 5);
      expect(result.tokens[0].valueUSD).toBeCloseTo(10, 5);
    });

    it('sets valueUSD to 0 when no stableAddresses are configured', async () => {
      const client = createMockClient({
        pairs: [PAIR_ADDR_1],
        pairSpecs: { [PAIR_ADDR_1]: { lpAddress: LP_ADDR_1 } },
        lpSpecs: { [LP_ADDR_1]: { lpBalance: 1_000_000n, totalSupply: 2_000_000n } },
      });
      const treasury = new TreasuryModule(client); // no stableAddresses

      const result = await treasury.getTreasuryBalance();

      expect(result.tokens).toHaveLength(1);
      expect(result.tokens[0].valueUSD).toBe(0);
      expect(result.totalUSD).toBe(0);
    });

    it('aggregates holdings from multiple pairs', async () => {
      const client = createMockClient({
        pairs: [PAIR_ADDR_1, PAIR_ADDR_2],
        pairSpecs: {
          [PAIR_ADDR_1]: { lpAddress: LP_ADDR_1, token0: STABLE_ADDR, token1: TOKEN_A, reserve0: 10_000_000n, reserve1: 10_000_000n },
          [PAIR_ADDR_2]: { lpAddress: LP_ADDR_2, token0: STABLE_ADDR, token1: TOKEN_B, reserve0: 10_000_000n, reserve1: 10_000_000n },
        },
        lpSpecs: {
          [LP_ADDR_1]: { lpBalance: 5_000_000n, totalSupply: 10_000_000n, lpSymbol: 'LP-1' },
          [LP_ADDR_2]: { lpBalance: 5_000_000n, totalSupply: 10_000_000n, lpSymbol: 'LP-2' },
        },
      });
      const treasury = new TreasuryModule(client, { stableAddresses: [STABLE_ADDR] });

      const result = await treasury.getTreasuryBalance();

      expect(result.tokens).toHaveLength(2);
    });

    it('handles very large LP balances without overflow', async () => {
      const largeBalance = 10n ** 18n;
      const client = createMockClient({
        pairs: [PAIR_ADDR_1],
        pairSpecs: { [PAIR_ADDR_1]: { lpAddress: LP_ADDR_1 } },
        lpSpecs: { [LP_ADDR_1]: { lpBalance: largeBalance, totalSupply: largeBalance * 2n } },
      });
      const treasury = new TreasuryModule(client);

      const result = await treasury.getTreasuryBalance();

      expect(result.tokens[0].amount).toBe(largeBalance);
    });

    it('continues to next pair when one pair throws', async () => {
      const client = createMockClient({
        pairs: [PAIR_ADDR_1, PAIR_ADDR_2],
        pairSpecs: {
          [PAIR_ADDR_2]: { lpAddress: LP_ADDR_2 },
        },
        lpSpecs: {
          [LP_ADDR_2]: { lpBalance: 1_000_000n, totalSupply: 2_000_000n },
        },
      });

      // Make PAIR_ADDR_1 throw
      (client.pair as jest.Mock).mockImplementation((addr: string) => {
        if (addr === PAIR_ADDR_1) throw new Error('RPC error');
        return makeMockPair({ lpAddress: LP_ADDR_2 });
      });

      const treasury = new TreasuryModule(client);
      const result = await treasury.getTreasuryBalance();

      // PAIR_ADDR_2 still yields a token
      expect(result.tokens).toHaveLength(1);
    });
  });

  // =========================================================================
  // getTreasuryAllocation()
  // =========================================================================
  describe('getTreasuryAllocation()', () => {
    it('returns empty allocations for empty treasury', async () => {
      const client = createMockClient({ pairs: [] });
      const treasury = new TreasuryModule(client);

      const result = await treasury.getTreasuryAllocation();

      expect(result.allocations).toHaveLength(0);
      expect(result.totalValueUSD).toBe(0);
    });

    it('returns 100% allocation for a single token', async () => {
      const client = createMockClient({
        pairs: [PAIR_ADDR_1],
        pairSpecs: {
          [PAIR_ADDR_1]: {
            lpAddress: LP_ADDR_1,
            token0: STABLE_ADDR,
            token1: TOKEN_A,
            reserve0: 10_000_000n,
            reserve1: 10_000_000n,
          },
        },
        lpSpecs: { [LP_ADDR_1]: { lpBalance: 5_000_000n, totalSupply: 10_000_000n } },
      });
      const treasury = new TreasuryModule(client, { stableAddresses: [STABLE_ADDR] });

      const result = await treasury.getTreasuryAllocation();

      expect(result.allocations).toHaveLength(1);
      expect(result.allocations[0].percentage).toBeCloseTo(100, 1);
    });

    it('percentages sum to 100 for multiple tokens', async () => {
      const client = createMockClient({
        pairs: [PAIR_ADDR_1, PAIR_ADDR_2],
        pairSpecs: {
          [PAIR_ADDR_1]: { lpAddress: LP_ADDR_1, token0: STABLE_ADDR, token1: TOKEN_A, reserve0: 30_000_000n, reserve1: 30_000_000n },
          [PAIR_ADDR_2]: { lpAddress: LP_ADDR_2, token0: STABLE_ADDR, token1: TOKEN_B, reserve0: 70_000_000n, reserve1: 70_000_000n },
        },
        lpSpecs: {
          [LP_ADDR_1]: { lpBalance: 10_000_000n, totalSupply: 10_000_000n },
          [LP_ADDR_2]: { lpBalance: 10_000_000n, totalSupply: 10_000_000n },
        },
      });
      const treasury = new TreasuryModule(client, { stableAddresses: [STABLE_ADDR] });

      const result = await treasury.getTreasuryAllocation();
      const total = result.allocations.reduce((s, a) => s + a.percentage, 0);

      expect(result.allocations).toHaveLength(2);
      expect(total).toBeCloseTo(100, 1);
    });

    it('sorts allocations by percentage descending', async () => {
      const client = createMockClient({
        pairs: [PAIR_ADDR_1, PAIR_ADDR_2],
        pairSpecs: {
          // PAIR_1 has smaller pool => smaller allocation
          [PAIR_ADDR_1]: { lpAddress: LP_ADDR_1, token0: STABLE_ADDR, token1: TOKEN_A, reserve0: 10_000_000n, reserve1: 10_000_000n },
          // PAIR_2 has larger pool => larger allocation
          [PAIR_ADDR_2]: { lpAddress: LP_ADDR_2, token0: STABLE_ADDR, token1: TOKEN_B, reserve0: 90_000_000n, reserve1: 90_000_000n },
        },
        lpSpecs: {
          [LP_ADDR_1]: { lpBalance: 10_000_000n, totalSupply: 10_000_000n },
          [LP_ADDR_2]: { lpBalance: 10_000_000n, totalSupply: 10_000_000n },
        },
      });
      const treasury = new TreasuryModule(client, { stableAddresses: [STABLE_ADDR] });

      const result = await treasury.getTreasuryAllocation();

      expect(result.allocations[0].percentage).toBeGreaterThanOrEqual(
        result.allocations[1].percentage,
      );
    });

    it('includes LP tokens held by treasury', async () => {
      const client = createMockClient({
        pairs: [PAIR_ADDR_1],
        pairSpecs: { [PAIR_ADDR_1]: { lpAddress: LP_ADDR_1 } },
        lpSpecs: { [LP_ADDR_1]: { lpBalance: 100_000n, totalSupply: 200_000n, lpSymbol: 'CORAL-LP' } },
      });
      const treasury = new TreasuryModule(client);

      const result = await treasury.getTreasuryAllocation();

      expect(result.allocations[0].token).toBe(LP_ADDR_1);
      expect(result.allocations[0].amount).toBe(100_000n);
    });
  });

  // =========================================================================
  // getFeeRevenue()
  // =========================================================================
  describe('getFeeRevenue()', () => {
    it('returns zero revenue for all pools when no swap events exist', async () => {
      const client = createMockClient({
        pairs: [PAIR_ADDR_1, PAIR_ADDR_2],
        eventsPerPair: {},   // empty events for all pairs
      });
      const treasury = new TreasuryModule(client);

      const result = await treasury.getFeeRevenue({ granularity: '1d' });

      expect(result.totalUSD).toBe(0);
      expect(result.byPool).toHaveLength(2);
      result.byPool.forEach((p) => {
        expect(p.revenueUSD).toBe(0);
        expect(p.volumeUSD).toBe(0);
      });
    });

    it('uses default 30-day ledger range when no period is provided', async () => {
      const currentLedger = 100_000;
      const client = createMockClient({ pairs: [], currentLedger });
      const treasury = new TreasuryModule(client);

      await treasury.getFeeRevenue({ granularity: '1d' });

      expect(client.getCurrentLedger).toHaveBeenCalled();
    });

    it('respects custom fromLedger and toLedger', async () => {
      const client = createMockClient({
        pairs: [PAIR_ADDR_1],
        eventsPerPair: {
          [PAIR_ADDR_1]: [
            makeSwapEvent(500, 10_000_000n, 30, STABLE_ADDR),  // in range
            makeSwapEvent(1500, 10_000_000n, 30, STABLE_ADDR), // outside toLedger=1000
          ],
        },
        pairSpecs: { [PAIR_ADDR_1]: { token0: STABLE_ADDR, token1: TOKEN_A, reserve0: 10_000_000n, reserve1: 10_000_000n } },
      });
      const treasury = new TreasuryModule(client, { stableAddresses: [STABLE_ADDR] });

      const result = await treasury.getFeeRevenue({ fromLedger: 0, toLedger: 1000, granularity: '1d' });

      // Only event at ledger 500 is in range
      expect(result.byPool[0].revenueUSD).toBeGreaterThan(0);
    });

    it('computes revenue from swap events correctly', async () => {
      // 1 swap: amountIn = 10 USDC (10_000_000 raw), feeBps = 30 → fee = 0.003 USDC
      const amountIn = 100_000_000n; // 10 USDC
      const feeBps = 30;
      const expectedFeeUSD = 10 * 30 / 10000; // $0.03

      const client = createMockClient({
        pairs: [PAIR_ADDR_1],
        eventsPerPair: {
          [PAIR_ADDR_1]: [makeSwapEvent(50_000, amountIn, feeBps, STABLE_ADDR)],
        },
        pairSpecs: {
          [PAIR_ADDR_1]: {
            lpAddress: LP_ADDR_1,
            token0: STABLE_ADDR,
            token1: TOKEN_A,
            reserve0: 10_000_000n,
            reserve1: 10_000_000n,
          },
        },
        currentLedger: 100_000,
      });
      const treasury = new TreasuryModule(client, { stableAddresses: [STABLE_ADDR] });

      const result = await treasury.getFeeRevenue({ fromLedger: 0, toLedger: 100_000, granularity: '1d' });

      expect(result.byPool[0].revenueUSD).toBeCloseTo(expectedFeeUSD, 5);
    });

    it('trend is stable when both halves are zero', async () => {
      const client = createMockClient({ pairs: [PAIR_ADDR_1], eventsPerPair: {} });
      const treasury = new TreasuryModule(client);

      const result = await treasury.getFeeRevenue({ fromLedger: 0, toLedger: 100, granularity: '1d' });

      expect(result.trend).toBe('stable');
    });

    it('trend is rising when second half revenue exceeds first by more than 10%', async () => {
      // First half: ledger 0-50 → small revenue
      // Second half: ledger 51-100 → much larger revenue
      const client = createMockClient({
        pairs: [PAIR_ADDR_1],
        eventsPerPair: {
          [PAIR_ADDR_1]: [
            makeSwapEvent(10, 1_000_000n, 30, STABLE_ADDR),    // first half: ~$0.003
            makeSwapEvent(80, 1_000_000_000n, 30, STABLE_ADDR), // second half: much larger
          ],
        },
        pairSpecs: {
          [PAIR_ADDR_1]: {
            lpAddress: LP_ADDR_1,
            token0: STABLE_ADDR, token1: TOKEN_A,
            reserve0: 10_000_000n, reserve1: 10_000_000n,
          },
        },
        currentLedger: 100_000,
      });
      const treasury = new TreasuryModule(client, { stableAddresses: [STABLE_ADDR] });

      const result = await treasury.getFeeRevenue({ fromLedger: 0, toLedger: 100, granularity: '1d' });

      expect(result.trend).toBe('rising');
    });

    it('trend is falling when second half revenue is less than first by more than 10%', async () => {
      const client = createMockClient({
        pairs: [PAIR_ADDR_1],
        eventsPerPair: {
          [PAIR_ADDR_1]: [
            makeSwapEvent(10, 1_000_000_000n, 30, STABLE_ADDR), // first half: large
            makeSwapEvent(80, 1_000_000n, 30, STABLE_ADDR),     // second half: tiny
          ],
        },
        pairSpecs: {
          [PAIR_ADDR_1]: {
            lpAddress: LP_ADDR_1,
            token0: STABLE_ADDR, token1: TOKEN_A,
            reserve0: 10_000_000n, reserve1: 10_000_000n,
          },
        },
        currentLedger: 100_000,
      });
      const treasury = new TreasuryModule(client, { stableAddresses: [STABLE_ADDR] });

      const result = await treasury.getFeeRevenue({ fromLedger: 0, toLedger: 100, granularity: '1d' });

      expect(result.trend).toBe('falling');
    });

    it('trend is stable when both halves are within 10% of each other', async () => {
      const client = createMockClient({
        pairs: [PAIR_ADDR_1],
        eventsPerPair: {
          [PAIR_ADDR_1]: [
            makeSwapEvent(10, 100_000_000n, 30, STABLE_ADDR), // first half
            makeSwapEvent(80, 105_000_000n, 30, STABLE_ADDR), // second half: 5% more
          ],
        },
        pairSpecs: {
          [PAIR_ADDR_1]: {
            lpAddress: LP_ADDR_1,
            token0: STABLE_ADDR, token1: TOKEN_A,
            reserve0: 10_000_000n, reserve1: 10_000_000n,
          },
        },
        currentLedger: 100_000,
      });
      const treasury = new TreasuryModule(client, { stableAddresses: [STABLE_ADDR] });

      const result = await treasury.getFeeRevenue({ fromLedger: 0, toLedger: 100, granularity: '1d' });

      expect(result.trend).toBe('stable');
    });

    it('sorts byPool by revenueUSD descending', async () => {
      const client = createMockClient({
        pairs: [PAIR_ADDR_1, PAIR_ADDR_2],
        eventsPerPair: {
          [PAIR_ADDR_1]: [makeSwapEvent(50, 1_000_000n, 30, STABLE_ADDR)],
          [PAIR_ADDR_2]: [makeSwapEvent(50, 100_000_000n, 30, STABLE_ADDR)],
        },
        pairSpecs: {
          [PAIR_ADDR_1]: { lpAddress: LP_ADDR_1, token0: STABLE_ADDR, token1: TOKEN_A, reserve0: 10_000_000n, reserve1: 10_000_000n },
          [PAIR_ADDR_2]: { lpAddress: LP_ADDR_2, token0: STABLE_ADDR, token1: TOKEN_B, reserve0: 10_000_000n, reserve1: 10_000_000n },
        },
        currentLedger: 100_000,
      });
      const treasury = new TreasuryModule(client, { stableAddresses: [STABLE_ADDR] });

      const result = await treasury.getFeeRevenue({ fromLedger: 0, toLedger: 100_000, granularity: '1d' });

      expect(result.byPool[0].revenueUSD).toBeGreaterThanOrEqual(result.byPool[1].revenueUSD);
    });

    it('returns zero revenue entry for inactive pools with no events', async () => {
      const client = createMockClient({
        pairs: [PAIR_ADDR_1, PAIR_ADDR_2],
        eventsPerPair: {
          [PAIR_ADDR_1]: [makeSwapEvent(50, 10_000_000n, 30, STABLE_ADDR)],
          // PAIR_ADDR_2 has no events
        },
        pairSpecs: {
          [PAIR_ADDR_1]: { lpAddress: LP_ADDR_1, token0: STABLE_ADDR, token1: TOKEN_A, reserve0: 10_000_000n, reserve1: 10_000_000n },
          [PAIR_ADDR_2]: { lpAddress: LP_ADDR_2, token0: STABLE_ADDR, token1: TOKEN_B, reserve0: 10_000_000n, reserve1: 10_000_000n },
        },
        currentLedger: 100_000,
      });
      const treasury = new TreasuryModule(client, { stableAddresses: [STABLE_ADDR] });

      const result = await treasury.getFeeRevenue({ fromLedger: 0, toLedger: 100_000, granularity: '1d' });

      expect(result.byPool).toHaveLength(2);
      const inactive = result.byPool.find((p) => p.pairAddress === PAIR_ADDR_2);
      expect(inactive?.revenueUSD).toBe(0);
      expect(inactive?.volumeUSD).toBe(0);
    });
  });
});
