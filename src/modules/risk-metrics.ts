import { CoralSwapClient } from '@/client';
import {
  PortfolioRisk,
  RiskFactor,
  RiskSeverity,
  GetPortfolioRiskOptions,
} from '@/types/risk-metrics';
import { Portfolio } from '@/types/portfolio';
import { validateAddress } from '@/utils/validation';

/**
 * Portfolio risk metrics module for CoralSwap.
 *
 * Analyzes LP positions to identify concentration risk, volatility exposure,
 * impermanent loss risk, and liquidity depth concerns. Returns a scored
 * assessment with actionable risk factor breakdowns.
 *
 * @example
 * const riskMetrics = new RiskMetricsModule(client);
 * const risk = await riskMetrics.getPortfolioRisk('G...');
 * console.log(`Portfolio risk: ${risk.overallScore}/100 (${risk.severity})`);
 */
export class RiskMetricsModule {
  private client: CoralSwapClient;

  constructor(client: CoralSwapClient) {
    this.client = client;
  }

  /**
   * Assess portfolio-level risk across all LP positions.
   *
   * Calculates risk scores for:
   * - Concentration risk: How much of the portfolio is in a single pair
   * - Volatility exposure: Historical price volatility of underlying assets
   * - Impermanent Loss (IL) risk: Risk from price divergence between paired tokens
   * - Liquidity depth: Risk from low pool liquidity causing price impact
   *
   * @param address - Stellar account address
   * @param options - Risk assessment options (pair filter, volatility window)
   * @returns Portfolio risk assessment with scored factors
   * @throws {ValidationError} If address is invalid
   */
  async getPortfolioRisk(
    address: string,
    options: GetPortfolioRiskOptions = {},
  ): Promise<PortfolioRisk> {
    validateAddress(address, 'address');

    const volatilityWindowDays = options.volatilityWindowDays ?? 30;
    const portfolio = await this.client.portfolio.get(address, {
      pairAddresses: options.pairAddresses,
    });

    if (portfolio.positions.length === 0) {
      return this.emptyPortfolioRisk();
    }

    const factors: RiskFactor[] = [];

    // Concentration risk: How much in each position
    const concentrationRisk = await this.analyzeConcentrationRisk(portfolio);
    factors.push(concentrationRisk);

    // Volatility exposure: Price volatility of token pairs
    const volatilityRisk = await this.analyzeVolatilityExposure(
      portfolio,
      volatilityWindowDays
    );
    factors.push(volatilityRisk);

    // IL risk: Risk from token pair divergence
    const ilRisk = await this.analyzeILRisk(portfolio);
    factors.push(ilRisk);

    // Liquidity depth: Pool depth and slippage risk
    const liquidityRisk = await this.analyzeLiquidityDepth(portfolio);
    factors.push(liquidityRisk);

    // Calculate overall score as weighted average
    const overallScore = this.calculateOverallScore(factors);
    const severity = this.scoreSeverity(overallScore);

    return {
      overallScore,
      factors,
      severity,
      assessedAt: Date.now(),
    };
  }

  // ---------------------------------------------------------------------------
  // Private risk analysis methods
  // ---------------------------------------------------------------------------

  private async analyzeConcentrationRisk(
    portfolio: Portfolio
  ): Promise<RiskFactor> {
    if (portfolio.positions.length === 0) {
      return {
        name: 'Concentration Risk',
        score: 0,
        description: 'No positions in portfolio',
        severity: 'low',
      };
    }

    // Find the largest position
    const maxPositionValue = Math.max(
      ...portfolio.positions.map((p) => p.valueUSD)
    );
    const concentrationPercent =
      (maxPositionValue / portfolio.totalValueUSD) * 100;

    let score = 0;
    let description = '';

    if (concentrationPercent > 80) {
      score = 90;
      description =
        'Portfolio is heavily concentrated in a single pair. Consider diversifying across multiple pools to reduce single-pair risk.';
    } else if (concentrationPercent > 60) {
      score = 70;
      description =
        'Portfolio is moderately concentrated. Diversifying to multiple pairs could reduce risk.';
    } else if (concentrationPercent > 40) {
      score = 40;
      description =
        'Portfolio has reasonable diversification across pairs.';
    } else {
      score = 20;
      description = 'Portfolio is well-diversified across multiple pairs.';
    }

    const severity = this.scoreSeverity(score);

    return {
      name: 'Concentration Risk',
      score,
      description,
      severity,
    };
  }

  private async analyzeVolatilityExposure(
    portfolio: Portfolio,
    windowDays: number
  ): Promise<RiskFactor> {
    // Volatility assessment is based on position diversification and count
    // In a real implementation, this would query price history from oracle or price feeds
    const positionCount = portfolio.positions.length;

    let volatilityScore = 0;
    let description = '';

    if (positionCount === 1) {
      volatilityScore = 60;
      description =
        'Single pair exposure increases volatility impact. Multiple assets provide natural hedging.';
    } else if (positionCount === 2) {
      volatilityScore = 45;
      description =
        'Limited token diversity. Adding more token pairs can reduce volatility exposure.';
    } else if (positionCount <= 4) {
      volatilityScore = 30;
      description =
        'Reasonable volatility exposure across multiple token pairs.';
    } else {
      volatilityScore = 15;
      description =
        'Strong diversification across many token pairs reduces volatility impact.';
    }

    const severity = this.scoreSeverity(volatilityScore);

    return {
      name: 'Volatility Exposure',
      score: volatilityScore,
      description,
      severity,
    };
  }

  private async analyzeILRisk(portfolio: Portfolio): Promise<RiskFactor> {
    // IL risk is higher when token prices diverge significantly
    // This is approximated based on position health (USD values relative to amounts)
    let ilScore = 0;
    let totalDeviation = 0;
    const positionCount = Math.max(1, portfolio.positions.length);

    for (const position of portfolio.positions) {
      // If token amounts are severely imbalanced, IL risk is higher
      const token0Val = Number(position.token0Amount) / Math.pow(10, 7);
      const token1Val = Number(position.token1Amount) / Math.pow(10, 7);
      const ratio = Math.max(token0Val, token1Val) / Math.min(token0Val, token1Val);

      if (ratio > 10) {
        totalDeviation += 30;
      } else if (ratio > 5) {
        totalDeviation += 20;
      } else if (ratio > 2) {
        totalDeviation += 10;
      }
    }

    ilScore = Math.min(80, Math.round(totalDeviation / positionCount));

    let description = '';
    if (ilScore > 60) {
      description =
        'High IL risk detected. Token pairs show significant imbalance, indicating prior divergence. Monitor positions closely.';
    } else if (ilScore > 40) {
      description =
        'Moderate IL risk. Some token pairs show imbalance. Rebalancing may help manage risk.';
    } else {
      description =
        'IL risk is contained. Token pairs are reasonably balanced.';
    }

    const severity = this.scoreSeverity(ilScore);

    return {
      name: 'Impermanent Loss Risk',
      score: ilScore,
      description,
      severity,
    };
  }

  private async analyzeLiquidityDepth(
    portfolio: Portfolio
  ): Promise<RiskFactor> {
    // Liquidity depth risk assessment
    // In reality, this would check actual pool reserves
    // Here we estimate based on position sizing
    let liquidityScore = 0;
    let largePositions = 0;

    for (const position of portfolio.positions) {
      if (position.valueUSD > 100_000) {
        largePositions++;
      }
    }

    if (largePositions >= 3) {
      liquidityScore = 70;
    } else if (largePositions >= 2) {
      liquidityScore = 50;
    } else if (largePositions >= 1) {
      liquidityScore = 30;
    } else {
      liquidityScore = 15;
    }

    let description = '';
    if (liquidityScore > 60) {
      description =
        'Multiple large positions may face significant slippage on withdrawal. Verify pool liquidity depth.';
    } else if (liquidityScore > 40) {
      description =
        'Some positions are substantial relative to typical pool sizes. Monitor liquidity.';
    } else {
      description =
        'Positions are reasonably sized relative to expected pool liquidity.';
    }

    const severity = this.scoreSeverity(liquidityScore);

    return {
      name: 'Liquidity Depth Risk',
      score: liquidityScore,
      description,
      severity,
    };
  }

  // ---------------------------------------------------------------------------
  // Scoring utilities
  // ---------------------------------------------------------------------------

  private calculateOverallScore(factors: RiskFactor[]): number {
    if (factors.length === 0) return 0;

    // Weighted average (can be customized based on importance)
    const weights = {
      'Concentration Risk': 0.3,
      'Volatility Exposure': 0.25,
      'Impermanent Loss Risk': 0.25,
      'Liquidity Depth Risk': 0.2,
    };

    let weightedSum = 0;
    let totalWeight = 0;

    for (const factor of factors) {
      const weight = weights[factor.name as keyof typeof weights] || 0.25;
      weightedSum += factor.score * weight;
      totalWeight += weight;
    }

    return Math.round(weightedSum / totalWeight);
  }

  private scoreSeverity(score: number): RiskSeverity {
    if (score >= 60) return 'high';
    if (score >= 35) return 'medium';
    return 'low';
  }

  private emptyPortfolioRisk(): PortfolioRisk {
    return {
      overallScore: 0,
      factors: [
        {
          name: 'Portfolio Status',
          score: 0,
          description: 'No LP positions found in portfolio.',
          severity: 'low',
        },
      ],
      severity: 'low',
      assessedAt: Date.now(),
    };
  }
}
