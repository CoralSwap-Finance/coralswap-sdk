import { CoralSwapClient } from '../src/client';
import { RiskMetricsModule } from '../src/modules/risk-metrics';
import { Network } from '../src/types/common';
import type { Portfolio, PortfolioPosition } from '../src/types/portfolio';
import { ValidationError } from '../src/errors';

const TEST_SECRET =
  'SB6K2AINTGNYBFX4M7TRPGSKQ5RKNOXXWB7UZUHRYOVTM7REDUGECKZU';
const USER =
  'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const PAIR_A =
  'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
const PAIR_B =
  'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC527';
const TOKEN_A =
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const TOKEN_B =
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4';
const TOKEN_C =
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM';

function makePosition(overrides: Partial<PortfolioPosition> = {}): PortfolioPosition {
  return {
    pairAddress: PAIR_A,
    lpTokenAddress: TOKEN_A,
    token0: TOKEN_A,
    token1: TOKEN_B,
    lpBalance: 1_000_000n,
    token0Amount: 500_000_000n,
    token1Amount: 500_000_000n,
    valueUSD: 50_000,
    ...overrides,
  };
}

function makePortfolio(positions: PortfolioPosition[] = []): Portfolio {
  const totalValueUSD = positions.reduce((sum, p) => sum + p.valueUSD, 0);
  return {
    owner: USER,
    positions,
    totalValueUSD,
  };
}

describe('RiskMetricsModule', () => {
  let client: CoralSwapClient;
  let riskMetrics: RiskMetricsModule;

  beforeEach(() => {
    client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: TEST_SECRET,
    });

    riskMetrics = new RiskMetricsModule(client);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('getPortfolioRisk()', () => {
    it('returns zero risk for empty portfolio', async () => {
      jest.spyOn(client.portfolio, 'get').mockResolvedValue(
        makePortfolio([])
      );

      const risk = await riskMetrics.getPortfolioRisk(USER);
      expect(risk.overallScore).toBe(0);
      expect(risk.severity).toBe('low');
      expect(risk.factors.length).toBeGreaterThan(0);
    });

    it('analyzes concentration risk for single large position', async () => {
      const position = makePosition({ valueUSD: 100_000 });
      jest.spyOn(client.portfolio, 'get').mockResolvedValue(
        makePortfolio([position])
      );

      const risk = await riskMetrics.getPortfolioRisk(USER);
      const concentrationFactor = risk.factors.find(
        (f) => f.name === 'Concentration Risk'
      );
      expect(concentrationFactor).toBeDefined();
      expect(concentrationFactor!.severity).toBe('high');
    });

    it('reduces concentration risk with diversified positions', async () => {
      const positions = [
        makePosition({ valueUSD: 30_000 }),
        makePosition({
          pairAddress: PAIR_B,
          token0: TOKEN_B,
          token1: TOKEN_C,
          valueUSD: 30_000,
        }),
        makePosition({
          pairAddress: PAIR_A,
          token0: TOKEN_A,
          token1: TOKEN_C,
          valueUSD: 40_000,
        }),
      ];
      jest.spyOn(client.portfolio, 'get').mockResolvedValue(
        makePortfolio(positions)
      );

      const risk = await riskMetrics.getPortfolioRisk(USER);
      const concentrationFactor = risk.factors.find(
        (f) => f.name === 'Concentration Risk'
      );
      expect(concentrationFactor).toBeDefined();
      expect(concentrationFactor!.severity).toBe('low');
    });

    it('calculates volatility exposure based on position count', async () => {
      const positions = [
        makePosition({ valueUSD: 25_000 }),
        makePosition({
          pairAddress: PAIR_B,
          token0: TOKEN_B,
          token1: TOKEN_C,
          valueUSD: 25_000,
        }),
      ];
      jest.spyOn(client.portfolio, 'get').mockResolvedValue(
        makePortfolio(positions)
      );

      const risk = await riskMetrics.getPortfolioRisk(USER);
      const volatilityFactor = risk.factors.find(
        (f) => f.name === 'Volatility Exposure'
      );
      expect(volatilityFactor).toBeDefined();
      expect(volatilityFactor!.score).toBeLessThan(60);
    });

    it('identifies impermanent loss risk from imbalanced positions', async () => {
      const position = makePosition({
        token0Amount: 100_000_000n,
        token1Amount: 1_000_000n,
      });
      jest.spyOn(client.portfolio, 'get').mockResolvedValue(
        makePortfolio([position])
      );

      const risk = await riskMetrics.getPortfolioRisk(USER);
      const ilFactor = risk.factors.find(
        (f) => f.name === 'Impermanent Loss Risk'
      );
      expect(ilFactor).toBeDefined();
      expect(ilFactor!.score).toBeGreaterThan(20);
    });

    it('assesses liquidity depth risk for large positions', async () => {
      const position = makePosition({ valueUSD: 150_000 });
      jest.spyOn(client.portfolio, 'get').mockResolvedValue(
        makePortfolio([position])
      );

      const risk = await riskMetrics.getPortfolioRisk(USER);
      const liquidityFactor = risk.factors.find(
        (f) => f.name === 'Liquidity Depth Risk'
      );
      expect(liquidityFactor).toBeDefined();
      expect(liquidityFactor!.score).toBeGreaterThan(20);
    });

    it('includes all risk factors in assessment', async () => {
      const positions = [makePosition()];
      jest.spyOn(client.portfolio, 'get').mockResolvedValue(
        makePortfolio(positions)
      );

      const risk = await riskMetrics.getPortfolioRisk(USER);
      const factorNames = risk.factors.map((f) => f.name);
      expect(factorNames).toContain('Concentration Risk');
      expect(factorNames).toContain('Volatility Exposure');
      expect(factorNames).toContain('Impermanent Loss Risk');
      expect(factorNames).toContain('Liquidity Depth Risk');
    });

    it('calculates weighted overall score from factors', async () => {
      const positions = [makePosition()];
      jest.spyOn(client.portfolio, 'get').mockResolvedValue(
        makePortfolio(positions)
      );

      const risk = await riskMetrics.getPortfolioRisk(USER);
      expect(risk.overallScore).toBeGreaterThanOrEqual(0);
      expect(risk.overallScore).toBeLessThanOrEqual(100);
    });

    it('determines severity based on overall score', async () => {
      const positions = [makePosition()];
      jest.spyOn(client.portfolio, 'get').mockResolvedValue(
        makePortfolio(positions)
      );

      const risk = await riskMetrics.getPortfolioRisk(USER);
      expect(['low', 'medium', 'high']).toContain(risk.severity);
    });

    it('includes timestamp in assessment', async () => {
      const positions = [makePosition()];
      jest.spyOn(client.portfolio, 'get').mockResolvedValue(
        makePortfolio(positions)
      );

      const risk = await riskMetrics.getPortfolioRisk(USER);
      expect(risk.assessedAt).toBeGreaterThan(0);
      expect(risk.assessedAt).toBeLessThanOrEqual(Date.now());
    });

    it('throws ValidationError for invalid address', async () => {
      await expect(
        riskMetrics.getPortfolioRisk('INVALID_ADDRESS')
      ).rejects.toThrow(ValidationError);
    });

    it('filters positions by provided pair addresses', async () => {
      const positions = [
        makePosition({ pairAddress: PAIR_A }),
        makePosition({
          pairAddress: PAIR_B,
          token0: TOKEN_B,
          token1: TOKEN_C,
        }),
      ];
      const mockGet = jest
        .spyOn(client.portfolio, 'get')
        .mockResolvedValue(makePortfolio(positions));

      await riskMetrics.getPortfolioRisk(USER, {
        pairAddresses: [PAIR_A],
      });

      expect(mockGet).toHaveBeenCalledWith(USER, {
        pairAddresses: [PAIR_A],
      });
    });

    it('respects volatility window option', async () => {
      const positions = [makePosition()];
      jest.spyOn(client.portfolio, 'get').mockResolvedValue(
        makePortfolio(positions)
      );

      const risk = await riskMetrics.getPortfolioRisk(USER, {
        volatilityWindowDays: 90,
      });
      expect(risk.factors).toBeDefined();
    });
  });

  describe('Risk factor descriptions', () => {
    it('includes actionable descriptions for each risk factor', async () => {
      const positions = [makePosition()];
      jest.spyOn(client.portfolio, 'get').mockResolvedValue(
        makePortfolio(positions)
      );

      const risk = await riskMetrics.getPortfolioRisk(USER);
      for (const factor of risk.factors) {
        expect(factor.description).toBeDefined();
        expect(factor.description.length).toBeGreaterThan(0);
      }
    });
  });
});
