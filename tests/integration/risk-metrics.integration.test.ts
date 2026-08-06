import { CoralSwapClient } from '../../src/client';
import { Network } from '../../src/types/common';
import { LiquidityModule } from '../../src/modules/liquidity';
import { PortfolioModule } from '../../src/modules/portfolio';
import { RiskMetricsModule } from '../../src/modules/risk-metrics';
import { toSorobanAmount } from '../../src/utils/amounts';

/**
 * Integration test: portfolio risk scoring against real testnet positions.
 *
 * NOTE ON SCOPE: issue #452 asks for tests of `getConcentrationRisk()` and
 * `getCorrelationMatrix()`. Neither method exists on `RiskMetricsModule` --
 * the only public entry point is `getPortfolioRisk()`, which internally
 * computes a "Concentration Risk" factor (among three others) as part of a
 * single weighted assessment. There is no correlation-matrix concept
 * anywhere in this codebase (see src/types/risk-metrics.ts). This suite
 * tests the concentration-risk behavior through the real, existing
 * `getPortfolioRisk()` API against real multi-pool position data, and omits
 * correlation-matrix coverage since that feature was never implemented.
 *
 * Prerequisites (set via env vars):
 *   STELLAR_TESTNET  – must be 'true' to run
 *   TEST_KEYPAIR     – funded testnet secret key (S...)
 *   TEST_TOKEN_A     – contract address of token A (used as $1 stable anchor)
 *   TEST_TOKEN_B     – contract address of token B
 *   TEST_TOKEN_C     – contract address of token C (second pool leg)
 *   TEST_RPC_URL     – optional RPC override
 *
 * Idempotent: reuses existing pairs and skips add-liquidity when LP balance
 * is already sufficient. Removes all LP added during the suite in afterAll.
 */

const SKIP = process.env.STELLAR_TESTNET !== 'true';

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

const describeIntegration = SKIP ? describe.skip : describe;

/** Mirrors the documented concentration-risk score tiers in risk-metrics.ts. */
function expectedConcentrationScore(concentrationPercent: number): number {
  if (concentrationPercent > 80) return 90;
  if (concentrationPercent > 60) return 70;
  if (concentrationPercent > 40) return 40;
  return 20;
}

function expectedSeverity(score: number): 'low' | 'medium' | 'high' {
  if (score >= 60) return 'high';
  if (score >= 35) return 'medium';
  return 'low';
}

describeIntegration('Risk metrics module (testnet)', () => {
  let client: CoralSwapClient;
  let liquidity: LiquidityModule;
  let portfolio: PortfolioModule;
  let riskMetrics: RiskMetricsModule;
  let tokenA: string;
  let tokenB: string;
  let tokenC: string;
  let pairAB: string;
  let pairAC: string;

  const AMOUNT_A = toSorobanAmount('1', 7);
  const MIN_LP_BALANCE = 1n;
  const SLIPPAGE_BPS = 200;

  /** Pairs where liquidity was added in this run (for cleanup). */
  const pairsToCleanup: Array<{
    pairAddress: string;
    tokenA: string;
    tokenB: string;
  }> = [];

  beforeAll(async () => {
    client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: requireEnv('TEST_KEYPAIR'),
      ...(process.env.TEST_RPC_URL ? { rpcUrl: process.env.TEST_RPC_URL } : {}),
    });
    tokenA = requireEnv('TEST_TOKEN_A');
    tokenB = requireEnv('TEST_TOKEN_B');
    tokenC = requireEnv('TEST_TOKEN_C');
    liquidity = new LiquidityModule(client);
    portfolio = new PortfolioModule(client, { stableAddresses: [tokenA] });
    riskMetrics = new RiskMetricsModule(client);

    pairAB = await ensurePair(tokenA, tokenB);
    pairAC = await ensurePair(tokenA, tokenC);
    await ensureLiquidity(pairAB, tokenA, tokenB);
    await ensureLiquidity(pairAC, tokenA, tokenC);
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
  ): Promise<void> {
    const lpAddr = await client.pair(pairAddress).getLPTokenAddress();
    const lpBefore = await client.lpToken(lpAddr).balance(client.publicKey);
    if (lpBefore >= MIN_LP_BALANCE) return;

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

    pairsToCleanup.push({ pairAddress, tokenA: tA, tokenB: tB });
    const lpAfter = await client.lpToken(lpAddr).balance(client.publicKey);
    expect(lpAfter).toBeGreaterThan(lpBefore);
  }

  async function removeAllLiquidity(
    pairAddress: string,
    tA: string,
    tB: string,
  ): Promise<void> {
    const lpAddr = await client.pair(pairAddress).getLPTokenAddress();
    const lpBalance = await client.lpToken(lpAddr).balance(client.publicKey);
    if (lpBalance === 0n) return;

    const pair = client.pair(pairAddress);
    const { reserve0, reserve1 } = await pair.getReserves();
    const totalSupply = await client.lpToken(lpAddr).totalSupply();
    const expectedA =
      totalSupply > 0n ? (reserve0 * lpBalance) / totalSupply : 0n;
    const expectedB =
      totalSupply > 0n ? (reserve1 * lpBalance) / totalSupply : 0n;

    const result = await liquidity.removeLiquidity({
      tokenA: tA,
      tokenB: tB,
      liquidity: lpBalance,
      amountAMin: (expectedA * BigInt(10000 - SLIPPAGE_BPS)) / 10000n,
      amountBMin: (expectedB * BigInt(10000 - SLIPPAGE_BPS)) / 10000n,
      to: client.publicKey,
      deadline: client.getDeadline(300),
    });
    expect(result.txHash).toBeTruthy();
  }

  // -----------------------------------------------------------------------
  // 1. getPortfolioRisk — sane overall assessment from real multi-pool data
  // -----------------------------------------------------------------------
  it('getPortfolioRisk returns a sane risk assessment from real multi-pool positions', async () => {
    const risk = await riskMetrics.getPortfolioRisk(client.publicKey, {
      pairAddresses: [pairAB, pairAC],
    });

    expect(risk.overallScore).toBeGreaterThanOrEqual(0);
    expect(risk.overallScore).toBeLessThanOrEqual(100);
    expect(['low', 'medium', 'high']).toContain(risk.severity);
    expect(risk.severity).toBe(expectedSeverity(risk.overallScore));
    expect(risk.assessedAt).toBeGreaterThan(Date.now() - 60_000);

    expect(risk.factors).toHaveLength(4);
    const names = risk.factors.map((f) => f.name).sort();
    expect(names).toEqual(
      [
        'Concentration Risk',
        'Volatility Exposure',
        'Impermanent Loss Risk',
        'Liquidity Depth Risk',
      ].sort(),
    );

    for (const factor of risk.factors) {
      expect(factor.score).toBeGreaterThanOrEqual(0);
      expect(factor.score).toBeLessThanOrEqual(100);
      expect(factor.severity).toBe(expectedSeverity(factor.score));
      expect(factor.description.length).toBeGreaterThan(0);
    }
  });

  // -----------------------------------------------------------------------
  // 2. Concentration risk factor — reflects real position value distribution
  // -----------------------------------------------------------------------
  it('concentration risk factor reflects real position values, not placeholders', async () => {
    const realPortfolio = await portfolio.getPortfolio(client.publicKey, {
      pairAddresses: [pairAB, pairAC],
    });
    expect(realPortfolio.positions.length).toBeGreaterThan(0);

    const maxPositionValue = Math.max(
      ...realPortfolio.positions.map((p) => p.valueUSD),
    );
    const concentrationPercent =
      (maxPositionValue / realPortfolio.totalValueUSD) * 100;
    const expectedScore = expectedConcentrationScore(concentrationPercent);

    const risk = await riskMetrics.getPortfolioRisk(client.publicKey, {
      pairAddresses: [pairAB, pairAC],
    });
    const concentrationFactor = risk.factors.find(
      (f) => f.name === 'Concentration Risk',
    );

    expect(concentrationFactor).toBeDefined();
    expect(concentrationFactor!.score).toBe(expectedScore);
  });

  // -----------------------------------------------------------------------
  // Cleanup: remove liquidity from pools touched in this suite
  // -----------------------------------------------------------------------
  afterAll(async () => {
    const seen = new Set<string>();
    for (const { pairAddress, tokenA: tA, tokenB: tB } of pairsToCleanup) {
      if (seen.has(pairAddress)) continue;
      seen.add(pairAddress);
      await removeAllLiquidity(pairAddress, tA, tB);
    }
  });
});
