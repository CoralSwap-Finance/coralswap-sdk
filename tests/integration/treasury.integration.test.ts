import { CoralSwapClient } from '../../src/client';
import { Network } from '../../src/types/common';
import { TreasuryModule } from '../../src/modules/treasury';

/**
 * Integration test: treasury balance and allocation breakdown.
 *
 * Verifies getTreasuryAllocation() against the real deployed treasury
 * contract on Stellar Testnet.
 *
 * Prerequisites (set via env vars):
 *   STELLAR_TESTNET   – must be 'true' to run
 *   TEST_KEYPAIR      – funded testnet secret key (S...)
 *   TEST_TOKEN_A      – contract address of token A (used as $1 stable anchor)
 *   TEST_RPC_URL      – optional RPC override
 *
 * Read-only: does not create any pairs, add liquidity, or submit
 * state-changing transactions to the network.
 */

const SKIP = process.env.STELLAR_TESTNET !== 'true' || !process.env.TEST_KEYPAIR;

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

const describeIntegration = SKIP ? describe.skip : describe;

describeIntegration('Treasury module (testnet)', () => {
  let client: CoralSwapClient;
  let treasury: TreasuryModule;

  beforeAll(async () => {
    client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: requireEnv('TEST_KEYPAIR'),
      ...(process.env.TEST_RPC_URL ? { rpcUrl: process.env.TEST_RPC_URL } : {}),
    });
    const stableToken = requireEnv('TEST_TOKEN_A');
    treasury = new TreasuryModule(client, { stableAddresses: [stableToken] });
  });

  it('getTreasuryAddress returns a valid contract address', async () => {
    const addr = await treasury.getTreasuryAddress();
    expect(addr).toBeTruthy();
    expect(typeof addr).toBe('string');
    expect(addr.startsWith('C')).toBe(true);
  });

  it('getTreasuryAllocation returns allocations that sum correctly', async () => {
    const result = await treasury.getTreasuryAllocation();

    expect(result).toHaveProperty('allocations');
    expect(result).toHaveProperty('totalValueUSD');

    if (result.allocations.length === 0) {
      expect(result.totalValueUSD).toBe(0);
      return;
    }

    expect(result.totalValueUSD).toBeGreaterThan(0);

    for (const alloc of result.allocations) {
      expect(alloc.token).toBeTruthy();
      expect(typeof alloc.token).toBe('string');
      expect(alloc.percentage).toBeGreaterThanOrEqual(0);
      expect(alloc.valueUSD).toBeGreaterThanOrEqual(0);
      expect(typeof alloc.amount).toBe('bigint');
    }

    const sumPercentages = result.allocations.reduce((s, a) => s + a.percentage, 0);
    expect(sumPercentages).toBeCloseTo(100, 0);

    for (let i = 1; i < result.allocations.length; i++) {
      expect(result.allocations[i - 1].percentage)
        .toBeGreaterThanOrEqual(result.allocations[i].percentage);
    }
  });

  it('getTreasuryBalance is consistent with getTreasuryAllocation', async () => {
    const [balance, allocation] = await Promise.all([
      treasury.getTreasuryBalance(),
      treasury.getTreasuryAllocation(),
    ]);

    expect(balance.tokens.length).toBe(allocation.allocations.length);
    expect(balance.totalUSD).toBeCloseTo(allocation.totalValueUSD, 5);

    for (let i = 0; i < balance.tokens.length; i++) {
      expect(balance.tokens[i].address).toBe(allocation.allocations[i].token);
      expect(balance.tokens[i].amount).toBe(allocation.allocations[i].amount);
      expect(balance.tokens[i].valueUSD).toBeCloseTo(
        allocation.allocations[i].valueUSD,
        5,
      );
    }
  });
});
