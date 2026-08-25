import { Contract, nativeToScVal, scValToNative } from '@stellar/stellar-sdk';
import { CoralSwapClient } from '../../src/client';
import { Network } from '../../src/types/common';

/**
 * Integration test: read a real price from a RedStone oracle contract on Stellar Testnet.
 *
 * Prerequisites (set via env vars):
 *   STELLAR_TESTNET      – must be 'true' to run
 *   REDSTONE_ORACLE_ADDRESS – deployed RedStone oracle contract address
 *   REDSTONE_ASSET       – optional asset symbol to query (default: BTC)
 *   TEST_RPC_URL         – optional RPC override
 */
// Skip unless the full set of testnet fixtures is configured, so the suite
// degrades to a clean skip on forks/PRs without secrets.
const SKIP =
  process.env.STELLAR_TESTNET !== 'true' ||
  !process.env.REDSTONE_ORACLE_ADDRESS;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

const describeIntegration = SKIP ? describe.skip : describe;

describeIntegration('Price feed module (testnet)', () => {
  let client: CoralSwapClient;

  beforeAll(() => {
    client = new CoralSwapClient({
      network: Network.TESTNET,
      ...(process.env.TEST_RPC_URL ? { rpcUrl: process.env.TEST_RPC_URL } : {}),
    });
  });

  it('fetches a non-zero, recent price from a live RedStone oracle contract', async () => {
    const oracleAddress = requireEnv('REDSTONE_ORACLE_ADDRESS');
    const asset = process.env.REDSTONE_ASSET ?? 'BTC';

    const oracle = new Contract(oracleAddress);
    const op = oracle.call('get_price', nativeToScVal(asset, { type: 'symbol' }));

    const sim = await client.simulateTransaction([op], {});

    expect(sim.success).toBe(true);
    expect(sim.returnValue).toBeDefined();

    const raw = scValToNative(sim.returnValue!);
    expect(raw).toBeDefined();

    const record = raw as Record<string, unknown>;
    const price = BigInt(String(record['price'] ?? '0'));
    const rawTimestamp = record['timestamp'] === undefined ? undefined : Number(record['timestamp']);

    expect(price > 0n).toBe(true);
    expect(rawTimestamp).toBeDefined();
    expect(rawTimestamp).toBeGreaterThan(0);

    const now = Date.now();
    const timestampMs =
      rawTimestamp !== undefined && rawTimestamp > 1e12
        ? rawTimestamp
        : (rawTimestamp ?? 0) * 1000;

    expect(timestampMs).toBeLessThanOrEqual(now + 5 * 60 * 1000);
    expect(now - timestampMs).toBeLessThan(24 * 60 * 60 * 1000);
  });
});
