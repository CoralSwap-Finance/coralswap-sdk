/**
 * Severity level for risk factors.
 */
export type RiskSeverity = 'low' | 'medium' | 'high';

/**
 * A single risk factor in a portfolio assessment.
 */
export interface RiskFactor {
  /** Name of the risk factor (e.g., "Concentration Risk") */
  name: string;
  /** Risk score for this factor (0-100, where 100 is highest risk) */
  score: number;
  /** Description of the risk and its implications */
  description: string;
  /** Severity level based on the score */
  severity: RiskSeverity;
}

/**
 * Portfolio-level risk metrics and scoring.
 */
export interface PortfolioRisk {
  /** Overall portfolio risk score (0-100, where 100 is highest risk) */
  overallScore: number;
  /** Array of individual risk factors analyzed */
  factors: RiskFactor[];
  /** Overall severity assessment */
  severity: RiskSeverity;
  /** Timestamp when the assessment was performed */
  assessedAt: number;
}

/**
 * Options for portfolio risk assessment.
 */
export interface GetPortfolioRiskOptions {
  /** Specific pair addresses to include; defaults to all factory pairs */
  pairAddresses?: string[];
  /** Volatility window in days for historical volatility calculation */
  volatilityWindowDays?: number;
}
