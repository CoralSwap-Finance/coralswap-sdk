import { RiskScoringModule, RiskLabel } from '../src/modules/risk-scoring';
import type {
  ConcentrationRiskReport,
  PortfolioRiskReport,
} from '../src/modules/risk-scoring';

// ---------------------------------------------------------------------------
// getConcentrationRisk — HHI calculation & threshold detection
// ---------------------------------------------------------------------------

describe('getConcentrationRisk', () => {
  it('returns HHI=10000 for a single asset portfolio', () => {
    const result = RiskScoringModule.getConcentrationRisk([100n]);
    expect(result.hhi).toBe(10000);
    expect(result.threshold).toBe('Highly Concentrated');
  });

  it('returns HHI=5000 for two equal assets', () => {
    const result = RiskScoringModule.getConcentrationRisk([100n, 100n]);
    expect(result.hhi).toBe(5000);
    expect(result.threshold).toBe('Highly Concentrated');
  });

  it('returns HHI~3333 for three equal assets', () => {
    const result = RiskScoringModule.getConcentrationRisk([100n, 100n, 100n]);
    // 33.33² × 3 = 3332.67
    expect(result.hhi).toBeGreaterThan(3300);
    expect(result.hhi).toBeLessThan(3400);
    expect(result.threshold).toBe('Highly Concentrated');
  });

  it('returns HHI=2000 for five equal assets (moderately concentrated)', () => {
    const result = RiskScoringModule.getConcentrationRisk(
      Array(5).fill(100n),
    );
    expect(result.hhi).toBe(2000);
    expect(result.threshold).toBe('Moderately Concentrated');
  });

  it('returns HHI=1000 for ten equal assets (diversified boundary)', () => {
    // HHI=1000 is the upper bound of Diversified; implementation treats
    // >= 1000 as Moderately Concentrated (standard DOJ/FTC threshold)
    const result = RiskScoringModule.getConcentrationRisk(
      Array(10).fill(100n),
    );
    expect(result.hhi).toBe(1000);
    expect(result.threshold).toBe('Moderately Concentrated');
  });

  it('returns HHI=8200 for a 90/10 two-asset portfolio', () => {
    // shares = [90, 10] → HHI = 8100 + 100 = 8200
    const result = RiskScoringModule.getConcentrationRisk([900n, 100n]);
    expect(result.hhi).toBe(8200);
    expect(result.threshold).toBe('Highly Concentrated');
  });

  it('returns HHI=10000 for a zero-value portfolio (edge case)', () => {
    const result = RiskScoringModule.getConcentrationRisk([0n, 0n]);
    expect(result.hhi).toBe(10000);
    expect(result.threshold).toBe('Highly Concentrated');
  });

  it('throws for negative allocation values', () => {
    expect(() =>
      RiskScoringModule.getConcentrationRisk([100n, -1n]),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// getPortfolioRisk — scoring across different portfolio compositions
// ---------------------------------------------------------------------------

describe('getPortfolioRisk', () => {
  it('scores Medium risk for a single low-volatility asset', () => {
    // Single asset = high concentration (HHI=10000), low vol (1%)
    const result = RiskScoringModule.getPortfolioRisk([100n], [0.01]);
    expect(result.riskLabel).toBe(RiskLabel.Medium);
    expect(result.hhi).toBe(10000);
    expect(result.overallScore).toBeGreaterThan(30);
    expect(result.overallScore).toBeLessThan(50);
  });

  it('scores Low risk for a diversified stablecoin pool', () => {
    // 3 stablecoins → concentration drops, diversification bonus kicks in
    const result = RiskScoringModule.getPortfolioRisk(
      [100n, 100n, 100n],
      [0.01, 0.01, 0.01],
    );
    expect(result.riskLabel).toBe(RiskLabel.Low);
    expect(result.overallScore).toBeLessThanOrEqual(25);
  });

  it('scores Critical risk for a single highly volatile asset', () => {
    // Single memecoin with 80% annualized vol
    const result = RiskScoringModule.getPortfolioRisk([100n], [0.8]);
    expect(result.riskLabel).toBe(RiskLabel.Critical);
    expect(result.overallScore).toBeGreaterThan(75);
  });

  it('scores High risk for a diversified volatile portfolio', () => {
    const result = RiskScoringModule.getPortfolioRisk(
      Array(5).fill(100n),
      [0.8, 0.75, 0.85, 0.7, 0.9],
    );
    expect(result.riskLabel).toBe(RiskLabel.High);
    expect(result.overallScore).toBeGreaterThan(50);
    expect(result.overallScore).toBeLessThanOrEqual(75);
  });

  it('scores High risk for a mixed stable/volatile portfolio', () => {
    // 50% USDC (vol 1%), 50% ETH (vol 60%)
    // HHI=5000 → hhiScore=40, avgVol=0.305 → volScore=30.5, bonus=-2
    // overallScore = round(40 + 30.5 - 2) = 69 → High
    const result = RiskScoringModule.getPortfolioRisk(
      [100n, 100n],
      [0.01, 0.6],
    );
    expect(result.riskLabel).toBe(RiskLabel.High);
    expect(result.overallScore).toBeGreaterThan(50);
    expect(result.overallScore).toBeLessThanOrEqual(75);
  });

  it('returns Critical score of 100 for an empty portfolio', () => {
    const result = RiskScoringModule.getPortfolioRisk([], []);
    expect(result.overallScore).toBe(100);
    expect(result.riskLabel).toBe(RiskLabel.Critical);
  });

  it('throws when allocations and volatilities length mismatch', () => {
    expect(() =>
      RiskScoringModule.getPortfolioRisk([100n, 200n], [0.1]),
    ).toThrow('must have the same length');
  });

  it('reports correct HHI, avgVolatility and numAssets', () => {
    const result = RiskScoringModule.getPortfolioRisk(
      [200n, 200n, 200n, 200n],
      [0.1, 0.2, 0.3, 0.4],
    );
    expect(result.numAssets).toBe(4);
    expect(result.avgVolatility).toBeCloseTo(0.25, 2);
    expect(result.hhi).toBe(2500);
  });
});

// ---------------------------------------------------------------------------
// getCorrelationMatrix — symmetry, diagonal, edge cases
// ---------------------------------------------------------------------------

describe('getCorrelationMatrix', () => {
  const x = [1, 2, 3, 4, 5];
  const y = [2, 4, 6, 8, 10]; // y = 2x
  const z = [10, 8, 6, 4, 2]; // z = -2x + 12

  it('returns empty array for empty input', () => {
    expect(RiskScoringModule.getCorrelationMatrix([])).toEqual([]);
  });

  it('returns 1x1 matrix with 1 for a single series', () => {
    const matrix = RiskScoringModule.getCorrelationMatrix([[1, 2, 3]]);
    expect(matrix).toEqual([[1]]);
  });

  it('has ones on the diagonal', () => {
    const matrix = RiskScoringModule.getCorrelationMatrix([x, y, z]);
    for (let i = 0; i < matrix.length; i++) {
      expect(matrix[i][i]).toBe(1);
    }
  });

  it('is symmetric (M[i][j] === M[j][i])', () => {
    const matrix = RiskScoringModule.getCorrelationMatrix([x, y, z]);
    for (let i = 0; i < matrix.length; i++) {
      for (let j = 0; j < matrix.length; j++) {
        expect(matrix[i][j]).toBe(matrix[j][i]);
      }
    }
  });

  it('returns +1 for perfectly positively correlated series', () => {
    const matrix = RiskScoringModule.getCorrelationMatrix([x, y]);
    expect(matrix[0][1]).toBe(1);
    expect(matrix[1][0]).toBe(1);
  });

  it('returns -1 for perfectly negatively correlated series', () => {
    const matrix = RiskScoringModule.getCorrelationMatrix([x, z]);
    expect(matrix[0][1]).toBe(-1);
    expect(matrix[1][0]).toBe(-1);
  });

  it('returns 0 for a zero-variance (flat) series', () => {
    const flat = [5, 5, 5, 5, 5];
    const matrix = RiskScoringModule.getCorrelationMatrix([x, flat]);
    expect(matrix[0][1]).toBe(0);
  });

  it('returns 0 for series with zero variance', () => {
    const flat = [3, 3, 3];
    const other = [1, 2, 3];
    const matrix = RiskScoringModule.getCorrelationMatrix([flat, other]);
    expect(matrix[0][1]).toBe(0);
    expect(matrix[1][0]).toBe(0);
    expect(matrix[0][0]).toBe(1);
    expect(matrix[1][1]).toBe(1);
  });

  it('throws when series have different lengths', () => {
    expect(() =>
      RiskScoringModule.getCorrelationMatrix([[1, 2], [1, 2, 3]]),
    ).toThrow('All return series must have the same length');
  });

  it('correctly computes a 3×3 correlation matrix for known data', () => {
    const a = [1, 2, 3];
    const b = [2, 4, 6]; // r = 1 vs a
    const c = [6, 4, 2]; // r = -1 vs a, -1 vs b
    const matrix = RiskScoringModule.getCorrelationMatrix([a, b, c]);
    expect(matrix[0][1]).toBe(1);
    expect(matrix[0][2]).toBe(-1);
    expect(matrix[1][2]).toBe(-1);
  });

  it('handles single-element series (zero variance edge case)', () => {
    const matrix = RiskScoringModule.getCorrelationMatrix([[5], [5]]);
    expect(matrix[0][1]).toBe(0);
    expect(matrix[1][0]).toBe(0);
    expect(matrix[0][0]).toBe(1);
    expect(matrix[1][1]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Integration: stablecoin pools (low risk) vs volatile pools (high risk)
// ---------------------------------------------------------------------------

describe('stablecoin vs volatile pool risk comparison', () => {
  // 4-asset stablecoin pool (USDC, USDT, DAI, FRAX)
  const stableAllocs = [400n, 300n, 200n, 100n];
  const stableVols = [0.005, 0.005, 0.008, 0.01];

  // 4-asset volatile pool (ETH, BTC, SOL, DOGE)
  const volatileAllocs = [400n, 300n, 200n, 100n];
  const volatileVols = [0.6, 0.55, 0.8, 0.9];

  it('stablecoin portfolio scores Low risk', () => {
    const result = RiskScoringModule.getPortfolioRisk(stableAllocs, stableVols);
    expect(result.riskLabel).toBe(RiskLabel.Low);
    expect(result.overallScore).toBeLessThanOrEqual(25);
  });

  it('volatile portfolio scores High or Critical risk', () => {
    const result = RiskScoringModule.getPortfolioRisk(
      volatileAllocs,
      volatileVols,
    );
    expect([RiskLabel.High, RiskLabel.Critical].includes(result.riskLabel)).toBe(
      true,
    );
    expect(result.overallScore).toBeGreaterThan(50);
  });

  it('volatile portfolio risk is strictly higher than stablecoin', () => {
    const stable = RiskScoringModule.getPortfolioRisk(stableAllocs, stableVols);
    const volatile = RiskScoringModule.getPortfolioRisk(
      volatileAllocs,
      volatileVols,
    );
    expect(volatile.overallScore).toBeGreaterThan(stable.overallScore);
  });

  it('concentration risk is identical for the same allocation split', () => {
    const stableConc = RiskScoringModule.getConcentrationRisk(stableAllocs);
    const volatileConc = RiskScoringModule.getConcentrationRisk(volatileAllocs);
    expect(stableConc.hhi).toBe(volatileConc.hhi);
    expect(stableConc.threshold).toBe(volatileConc.threshold);
  });
});