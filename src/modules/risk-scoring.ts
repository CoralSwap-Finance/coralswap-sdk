import { validatePositiveAmount } from '@/utils/validation';

/**
 * Analytical risk scoring for LP investment decision-making.
 *
 * A lightweight, dependency-free companion to the client-bound
 * {@link RiskMetricsModule}: instead of reading live portfolio data from the
 * chain, these static functions score an allocation/volatility snapshot
 * directly, so they are easy to unit test and cheap to call.
 *
 * - {@link RiskScoringModule.getConcentrationRisk} — Herfindahl–Hirschman index
 *   (HHI) and threshold classification
 * - {@link RiskScoringModule.getPortfolioRisk} — 0–100 score combining HHI
 *   concentration, weighted volatility and a diversification bonus
 * - {@link RiskScoringModule.getCorrelationMatrix} — Pearson correlation matrix
 *   of return series
 */
export enum RiskLabel {
  Low = 'Low',
  Medium = 'Medium',
  High = 'High',
  Critical = 'Critical',
}

export interface ConcentrationRiskReport {
  hhi: number;
  threshold: 'Diversified' | 'Moderately Concentrated' | 'Highly Concentrated';
}

export interface PortfolioRiskReport {
  overallScore: number;
  riskLabel: RiskLabel;
  hhi: number;
  avgVolatility: number;
  numAssets: number;
}

export class RiskScoringModule {
  static readonly HHI_DIVERSIFIED_THRESHOLD = 1000;
  static readonly HHI_MODERATE_THRESHOLD = 2500;

  /**
   * Calculate the Herfindahl-Hirschman Index (HHI) for portfolio
   * concentration. HHI = sum of squared market shares (as percentages).
   *
   * Thresholds (standard DOJ/FTC convention):
   *   < 1000      → Diversified
   *   1000–2500   → Moderately Concentrated
   *   > 2500      → Highly Concentrated
   *
   * @param allocations - Array of allocation amounts (bigint)
   * @returns Concentration risk report with HHI and threshold label
   */
  static getConcentrationRisk(allocations: bigint[]): ConcentrationRiskReport {
    const total = allocations.reduce((sum, a) => sum + a, 0n);
    if (total === 0n) {
      return { hhi: 10000, threshold: 'Highly Concentrated' };
    }

    for (const a of allocations) {
      validatePositiveAmount(a, 'allocation');
    }

    const shares = allocations.map(
      (a) => Number((a * 10000n) / total) / 100,
    );
    const hhi = shares.reduce((sum, s) => sum + s * s, 0);

    let threshold: ConcentrationRiskReport['threshold'];
    if (hhi < this.HHI_DIVERSIFIED_THRESHOLD) {
      threshold = 'Diversified';
    } else if (hhi < this.HHI_MODERATE_THRESHOLD) {
      threshold = 'Moderately Concentrated';
    } else {
      threshold = 'Highly Concentrated';
    }

    return { hhi: Math.round(hhi * 100) / 100, threshold };
  }

  /**
   * Assess overall portfolio risk from allocation weights and individual
   * asset annualized volatilities.
   *
   * Scoring breakdown:
   *   - HHI-based concentration: 0–40 pts
   *   - Volatility: 0–50 pts
   *   - Diversification bonus: up to −10 pts
   *
   * @param allocations - Array of allocation amounts (bigint)
   * @param volatilities - Array of annualized volatilities (e.g. 0.15 = 15%)
   * @returns Portfolio risk report
   */
  static getPortfolioRisk(
    allocations: bigint[],
    volatilities: number[],
  ): PortfolioRiskReport {
    if (allocations.length !== volatilities.length) {
      throw new Error(
        `allocations (${allocations.length}) and volatilities (${volatilities.length}) must have the same length`,
      );
    }

    const total = allocations.reduce((sum, a) => sum + a, 0n);
    if (total === 0n) {
      return {
        overallScore: 100,
        riskLabel: RiskLabel.Critical,
        hhi: 10000,
        avgVolatility: 0,
        numAssets: 0,
      };
    }

    const totalNum = Number(total);
    const weights = allocations.map((a) => Number(a) / totalNum);
    const hhi = weights.reduce((sum, w) => sum + w * w * 10000, 0);
    const avgVol = volatilities.reduce(
      (sum, v, i) => sum + v * weights[i],
      0,
    );

    let hhiScore: number;
    if (hhi < this.HHI_DIVERSIFIED_THRESHOLD) {
      hhiScore = 0;
    } else if (hhi < this.HHI_MODERATE_THRESHOLD) {
      hhiScore = ((hhi - this.HHI_DIVERSIFIED_THRESHOLD) / 1500) * 20;
    } else if (hhi < 5000) {
      hhiScore = 20 + ((hhi - this.HHI_MODERATE_THRESHOLD) / 2500) * 20;
    } else {
      hhiScore = 40;
    }

    const volScore = Math.min(avgVol * 100, 50);

    const diversificationBonus = -Math.min(
      Math.max(allocations.length - 1, 0) * 2,
      10,
    );

    const overallScore = Math.max(
      0,
      Math.min(100, Math.round(hhiScore + volScore + diversificationBonus)),
    );

    let riskLabel: RiskLabel;
    if (overallScore <= 25) riskLabel = RiskLabel.Low;
    else if (overallScore <= 50) riskLabel = RiskLabel.Medium;
    else if (overallScore <= 75) riskLabel = RiskLabel.High;
    else riskLabel = RiskLabel.Critical;

    return {
      overallScore,
      riskLabel,
      hhi: Math.round(hhi * 100) / 100,
      avgVolatility: Math.round(avgVol * 10000) / 10000,
      numAssets: allocations.length,
    };
  }

  /**
   * Compute the Pearson correlation coefficient matrix for a set of return
   * series.
   *
   * Guaranteed properties:
   *   - Diagonal entries are always 1.0
   *   - Matrix is symmetric: M[i][j] === M[j][i]
   *   - A series with zero variance correlates 0 with every other series
   *
   * @param returnSeries - Array of equal-length return series (number[])
   * @returns N×N correlation matrix
   */
  static getCorrelationMatrix(returnSeries: number[][]): number[][] {
    const n = returnSeries.length;
    if (n === 0) return [];

    const firstLen = returnSeries[0].length;
    if (returnSeries.some((s) => s.length !== firstLen)) {
      throw new Error('All return series must have the same length');
    }

    const matrix: number[][] = Array.from({ length: n }, () =>
      new Array(n).fill(0),
    );

    for (let i = 0; i < n; i++) {
      matrix[i][i] = 1;
      for (let j = i + 1; j < n; j++) {
        const corr = pearsonCorrelation(returnSeries[i], returnSeries[j]);
        matrix[i][j] = corr;
        matrix[j][i] = corr;
      }
    }

    return matrix;
  }
}

function pearsonCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  if (n === 0) return 0;

  const meanX = x.reduce((s, v) => s + v, 0) / n;
  const meanY = y.reduce((s, v) => s + v, 0) / n;

  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }

  if (varX === 0 || varY === 0) return 0;

  return Math.round((cov / Math.sqrt(varX * varY)) * 10000) / 10000;
}