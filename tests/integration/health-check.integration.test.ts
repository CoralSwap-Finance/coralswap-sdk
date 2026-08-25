import { checkRPCHealth, getRPCLatency, getContractStatus } from '../../src/modules/health-check';

/**
 * Integration test: probe a real Stellar Testnet RPC endpoint and a deployed contract.
 *
 * Prerequisites (set via env vars):
 *   STELLAR_TESTNET      – must be 'true' to run
 *   TEST_RPC_URL         – optional RPC override (defaults to the public Testnet RPC)
 *   TEST_CONTRACT_ID     – optional override for the deployed contract to verify
 */
const SKIP = process.env.STELLAR_TESTNET !== 'true';

const describeIntegration = SKIP ? describe.skip : describe;
const itContractIntegration = process.env.TEST_CONTRACT_ID ? it : it.skip;

describeIntegration('Health check module (testnet)', () => {
  const rpcUrl = process.env.TEST_RPC_URL ?? 'https://soroban-testnet.stellar.org';
  const contractId = process.env.TEST_CONTRACT_ID ?? '';

  it('returns a sane RPC health result and real latency against the live Testnet RPC', async () => {
    const health = await checkRPCHealth(rpcUrl, 10_000);

    expect(health.healthy).toBe(true);
    expect(health.error).toBeNull();
    expect(health.status).toBeTruthy();
    expect(health.latencyMs).toBeGreaterThan(0);
    expect(health.latencyMs).toBeLessThan(30_000);

    const latency = await getRPCLatency(rpcUrl, 3, 10_000);

    expect(latency.sampleCount).toBe(3);
    expect(latency.errorRate).toBeLessThan(1);
    expect(Number.isFinite(latency.meanMs)).toBe(true);
    expect(latency.meanMs).toBeGreaterThan(0);
    expect(latency.p50Ms).toBeGreaterThanOrEqual(0);
    expect(latency.p95Ms).toBeGreaterThanOrEqual(latency.p50Ms);
    expect(latency.p99Ms).toBeGreaterThanOrEqual(latency.p95Ms);
  });

  itContractIntegration('reports deployed contract status from the live Testnet RPC', async () => {
    const status = await getContractStatus(rpcUrl, contractId);

    expect(status.deployed).toBe(true);
    expect(status.error).toBeNull();
    expect(typeof status.liveUntilLedger).toBe('number');
    expect(status.liveUntilLedger).toBeGreaterThan(0);
    expect(status.remainingLedgers).toBeGreaterThanOrEqual(-1);
  });
});
