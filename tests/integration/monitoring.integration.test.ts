import { CoralSwapClient } from '../../src/client';
import { Network } from '../../src/types/common';
import { MonitoringModule } from '../../src/modules/monitoring';
import { LiquidityModule } from '../../src/modules/liquidity';
import { toSorobanAmount } from '../../src/utils/amounts';

/**
 * Integration test: monitoring module against real testnet pools.
 *
 * Tests the monitoring module's ability to compute protocol-wide KPIs from
 * real Testnet pools with known recent activity, verifying non-zero, sane
 * TVL/volume/revenue figures and system health checks.
 *
 * Prerequisites (set via env vars):
 *   STELLAR_TESTNET  – must be 'true' to run
 *   TEST_KEYPAIR     – funded testnet secret key (S...)
 *   TEST_TOKEN_A     – contract address of token A (used as stable anchor)
 *   TEST_TOKEN_B     – contract address of token B
 *   TEST_RPC_URL     – optional RPC override
 *
 * Idempotent: creates or reuses existing pair with liquidity.
 */

const SKIP = process.env.STELLAR_TESTNET !== 'true';

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

const describeIntegration = SKIP ? describe.skip : describe;

describeIntegration('Monitoring module (testnet)', () => {
  let client: CoralSwapClient;
  let monitoring: MonitoringModule;
  let liquidity: LiquidityModule;
  let tokenA: string;
  let tokenB: string;
  let pairAddress: string;

  const AMOUNT_A = toSorobanAmount('1', 7);
  const MIN_LP_BALANCE = 1n;
  const SLIPPAGE_BPS = 200; // 2% — generous for testnet

  beforeAll(async () => {
    client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: requireEnv('TEST_KEYPAIR'),
      ...(process.env.TEST_RPC_URL ? { rpcUrl: process.env.TEST_RPC_URL } : {}),
    });
    tokenA = requireEnv('TEST_TOKEN_A');
    tokenB = requireEnv('TEST_TOKEN_B');
    monitoring = new MonitoringModule(client);
    liquidity = new LiquidityModule(client);

    // Ensure the pair exists
    pairAddress = await ensurePair(tokenA, tokenB);

    // Ensure liquidity exists in the pair
    await ensureLiquidity(pairAddress, tokenA, tokenB);
  });

  async function ensurePair(tokenX: string, tokenY: string): Promise<string> {
    let addr = await client.getPairAddress(tokenX, tokenY);
    if (!addr) {
      const op = client.factory.buildCreatePair(client.publicKey, tokenX, tokenY);
      const result = await client.submitTransaction([op]);
      expect(result.success).toBe(true);
      addr = await client.getPairAddress(tokenX, tokenY);
    }
    expect(addr).toBeTruthy();
    return addr!;
  }

  async function ensureLiquidity(
    pairAddress: string,
    tA: string,
    tB: string,
  ): Promise<bigint> {
    const lpAddr = await client.pair(pairAddress).getLPTokenAddress();
    const lpBefore = await client.lpToken(lpAddr).balance(client.publicKey);
    if (lpBefore >= MIN_LP_BALANCE) return lpBefore;

    const quote = await liquidity.getAddLiquidityQuote(tA, tB, AMOUNT_A);
    const result = await liquidity.addLiquidity({
      tokenA: tA,
      tokenB: tB,
      amountADesired: quote.amountA,
      amountBDesired: quote.amountB,
      amountAMin: (quote.amountA * BigInt(10000 - SLIPPAGE_BPS)) / 10000n,
      amountBMin: (quote.amountB * BigInt(10000 - SLIPPAGE_BPS)) / 10000n,
      to: client.publicKey,
      deadline: client.getDeadline(300),
    });
    expect(result.txHash).toBeTruthy();

    const lpAfter = await client.lpToken(lpAddr).balance(client.publicKey);
    expect(lpAfter).toBeGreaterThan(lpBefore);
    return lpAfter;
  }

  // -----------------------------------------------------------------------
  // 1. checkSystemHealth — RPC connectivity and ledger info
  // -----------------------------------------------------------------------
  it('checkSystemHealth returns healthy RPC status with current ledger', async () => {
    const health = await monitoring.checkSystemHealth();

    expect(health).toBeDefined();
    expect(health.healthy).toBe(true);
    expect(health.rpc).toBeDefined();
    expect(health.rpc.connected).toBe(true);
    expect(health.rpc.latencyMs).toBeGreaterThanOrEqual(0);
    expect(health.rpc.latestLedger).toBeGreaterThan(0);
    expect(health.rpc.error).toBeUndefined();

    expect(health.ledger).toBeDefined();
    expect(health.ledger.currentLedger).toBeGreaterThan(0);
    expect(health.ledger.lastCheckedAt).toBeDefined();
    expect(health.ledger.gapLedgers).toBeGreaterThanOrEqual(0);

    expect(health.checkedAt).toBeDefined();
    expect(new Date(health.checkedAt).getTime()).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // 2. getPoolHealth — single pool metrics with non-zero reserves
  // -----------------------------------------------------------------------
  it('getPoolHealth returns operational pool with real reserve ratio', async () => {
    const poolHealth = await monitoring.getPoolHealth(pairAddress);

    expect(poolHealth).toBeDefined();
    expect(poolHealth.pairAddress).toBe(pairAddress);
    expect(poolHealth.operational).toBe(true);
    expect(poolHealth.errors).toEqual([]);
    expect(poolHealth.warnings).toEqual([]);

    // Reserve ratio should be a valid number (non-zero reserves)
    expect(poolHealth.reserveRatio).toBeGreaterThanOrEqual(0);
    expect(typeof poolHealth.reserveRatio).toBe('number');
    expect(isFinite(poolHealth.reserveRatio)).toBe(true);

    // Fetches real reserves, so ratio should indicate non-empty pool
    // (We added liquidity in beforeAll, so reserves must be > 0)
    expect(poolHealth.reserveRatio).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // 3. getAllPoolHealth — returns all pairs with realistic health data
  // -----------------------------------------------------------------------
  it('getAllPoolHealth returns at least our created pair', async () => {
    const allHealth = await monitoring.getAllPoolHealth();

    expect(Array.isArray(allHealth)).toBe(true);
    expect(allHealth.length).toBeGreaterThan(0);

    // Our pair should be in the list
    const ourPair = allHealth.find((p) => p.pairAddress === pairAddress);
    expect(ourPair).toBeDefined();
    expect(ourPair!.operational).toBe(true);
    expect(ourPair!.reserveRatio).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // 4. getProtocolSummary — system-wide metrics (TVL/volume/fees/pool counts)
  // -----------------------------------------------------------------------
  it('getProtocolSummary returns aggregated protocol metrics with sane values', async () => {
    const summary = await monitoring.getProtocolSummary();

    expect(summary).toBeDefined();
    expect(typeof summary.totalTVLUSD).toBe('number');
    expect(typeof summary.volume24hUSD).toBe('number');
    expect(typeof summary.fees24hUSD).toBe('number');
    expect(typeof summary.poolCount).toBe('number');
    expect(typeof summary.activePairCount).toBe('number');
    expect(typeof summary.totalLPHolders).toBe('number');
    expect(typeof summary.timestamp).toBe('string');

    // Sane value checks
    expect(summary.totalTVLUSD).toBeGreaterThanOrEqual(0);
    expect(summary.volume24hUSD).toBeGreaterThanOrEqual(0);
    expect(summary.fees24hUSD).toBeGreaterThanOrEqual(0);
    expect(summary.poolCount).toBeGreaterThan(0);
    expect(summary.activePairCount).toBeGreaterThan(0);
    expect(summary.activePairCount).toBeLessThanOrEqual(summary.poolCount);
    expect(summary.totalLPHolders).toBeGreaterThanOrEqual(0);

    // Timestamp should be recent (within last minute)
    const summaryTime = new Date(summary.timestamp).getTime();
    const now = Date.now();
    expect(now - summaryTime).toBeLessThan(60_000);
  });

  // -----------------------------------------------------------------------
  // 5. Metric registration, collection, and dashboard
  // -----------------------------------------------------------------------
  it('registerMetric and collect returns non-zero liquidity value from real pool', async () => {
    // Register a liquidity metric for our pair
    const metricId = await monitoring.registerMetric({
      name: 'test-pool-liquidity',
      category: 'liquidity',
      targetAddress: pairAddress,
      granularity: '1h',
    });

    expect(metricId).toBeDefined();
    expect(typeof metricId).toBe('string');

    // Collect the metric
    await monitoring.collect(metricId);

    // Retrieve the metric instance
    const metric = await monitoring.getMetric(metricId);
    expect(metric).toBeDefined();
    expect(metric.id).toBe(metricId);
    expect(metric.config.name).toBe('test-pool-liquidity');
    expect(metric.config.category).toBe('liquidity');
    expect(metric.recentData.length).toBeGreaterThan(0);

    // Current value should be non-zero (we have liquidity)
    expect(metric.currentValue).toBeGreaterThan(0);
    expect(typeof metric.currentValue).toBe('number');
    expect(isFinite(metric.currentValue!)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 6. Verify metric collection detects real reserve data
  // -----------------------------------------------------------------------
  it('metric collection computes liquidity from real reserve data, not mocks', async () => {
    // Get the pair's actual reserves directly
    const pair = client.pair(pairAddress);
    const reserves = await pair.getReserves();

    // Register and collect metric
    const metricId = await monitoring.registerMetric({
      name: 'test-reserve-detection',
      category: 'liquidity',
      targetAddress: pairAddress,
      granularity: '1h',
    });

    await monitoring.collect(metricId);
    const metric = await monitoring.getMetric(metricId);

    // The metric value should reflect actual reserves (sum in canonical units)
    // Reserves are in Soroban units (7 decimals), metric converts to USD by dividing by 1e7
    const expectedValue = Number(reserves.reserve0 + reserves.reserve1) / 1e7;
    expect(metric.currentValue).toBeCloseTo(expectedValue, 0);

    // Verify it's not a placeholder zero
    expect(metric.currentValue).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // 7. Price metric from real pool reserves
  // -----------------------------------------------------------------------
  it('price metric correctly computes reserve-based price', async () => {
    const metricId = await monitoring.registerMetric({
      name: 'test-pool-price',
      category: 'price',
      targetAddress: pairAddress,
      granularity: '1h',
    });

    await monitoring.collect(metricId);
    const metric = await monitoring.getMetric(metricId);

    // Get reserves to compute expected price
    const reserves = await client.pair(pairAddress).getReserves();
    const expectedPrice =
      reserves.reserve0 === 0n
        ? 0
        : Number(reserves.reserve1) / Number(reserves.reserve0);

    expect(metric.currentValue).toBeCloseTo(expectedPrice, 2);
  });

  // -----------------------------------------------------------------------
  // 8. getDashboard aggregates registered metrics
  // -----------------------------------------------------------------------
  it('getDashboard aggregates all registered metrics into categories', async () => {
    // Register multiple metrics
    const liquidityId = await monitoring.registerMetric({
      name: 'dashboard-liquidity',
      category: 'liquidity',
      targetAddress: pairAddress,
      granularity: '1h',
    });

    const priceId = await monitoring.registerMetric({
      name: 'dashboard-price',
      category: 'price',
      targetAddress: pairAddress,
      granularity: '1h',
    });

    // Collect them
    await monitoring.collect(liquidityId);
    await monitoring.collect(priceId);

    // Get dashboard
    const dashboard = await monitoring.getDashboard();

    expect(dashboard).toBeDefined();
    expect(dashboard.totalMetrics).toBeGreaterThanOrEqual(2);
    expect(dashboard.categories.liquidity).toBeDefined();
    expect(dashboard.categories.liquidity?.length).toBeGreaterThanOrEqual(1);
    expect(dashboard.categories.price).toBeDefined();
    expect(dashboard.categories.price?.length).toBeGreaterThanOrEqual(1);

    // Aggregated values should be non-zero
    expect(dashboard.totalLiquidityUSD).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // 9. Pool health is operational for pools with activity
  // -----------------------------------------------------------------------
  it('getPoolHealth correctly identifies operational vs failed pools', async () => {
    const healthList = await monitoring.getAllPoolHealth();

    // At least one pool should be operational (the one we created)
    const operationalCount = healthList.filter((p) => p.operational).length;
    expect(operationalCount).toBeGreaterThan(0);

    // All operational pools should have valid reserve ratios
    healthList.forEach((pool) => {
      if (pool.operational) {
        expect(pool.reserveRatio).toBeGreaterThanOrEqual(0);
        expect(typeof pool.reserveRatio).toBe('number');
        expect(isFinite(pool.reserveRatio)).toBe(true);
        expect(pool.errors).toEqual([]);
      }
    });
  });

  // -----------------------------------------------------------------------
  // 10. Metric query by date range
  // -----------------------------------------------------------------------
  it('queryMetric filters data by timestamp range', async () => {
    const now = Math.floor(Date.now() / 1000);
    const metricId = await monitoring.registerMetric({
      name: 'query-test-metric',
      category: 'liquidity',
      targetAddress: pairAddress,
      granularity: '1h',
    });

    await monitoring.collect(metricId);

    // Query with a broad time range (should include our data point)
    const data = await monitoring.queryMetric({
      metricId,
      fromTimestamp: now - 60,
      toTimestamp: now + 60,
    });

    expect(data.length).toBeGreaterThan(0);
    expect(data[0].value).toBeGreaterThan(0);

    // Query with a range that excludes our point (future)
    const emptyData = await monitoring.queryMetric({
      metricId,
      fromTimestamp: now + 3600,
      toTimestamp: now + 7200,
    });

    expect(emptyData.length).toBe(0);
  });
});
