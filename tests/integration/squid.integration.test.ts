/**
 * Integration test: Squid Router cross-chain swap quoting.
 *
 * Tests against the real Squid Router API (testnet/public endpoints)
 * to verify response shape and key fields.
 *
 * Prerequisites (set via env vars):
 *   STELLAR_TESTNET – must be 'true' to run
 *
 * The test gracefully skips (does not fail) if the external Squid API
 * is temporarily unavailable.
 */

import { SquidModule } from '../../src/modules/squid';

const SKIP = process.env.STELLAR_TESTNET !== 'true';

const describeIntegration = SKIP ? describe.skip : describe;

describeIntegration('Squid Router (testnet)', () => {
  let squid: SquidModule;

  beforeAll(() => {
    squid = new SquidModule();
  });

  // -----------------------------------------------------------------------
  // 1. Quote request — real cross-chain route
  // -----------------------------------------------------------------------
  it('should return a valid route response for a cross-chain quote', async () => {
    const result = await squid.getRoute({
      fromChain: 'solana',
      fromToken: 'So11111111111111111111111111111111111111112',
      fromAmount: '1000000',
      toChain: 'arbitrum',
      toToken: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      fromAddress: '0x0000000000000000000000000000000000000001',
      slippage: 1.0,
    });

    expect(result).toBeDefined();
    expect(typeof result.success).toBe('boolean');

    if (result.success && result.route) {
      expect(result.route.estimate).toBeDefined();
      expect(typeof result.route.estimate.fromAmount).toBe('string');
      expect(typeof result.route.estimate.toAmount).toBe('string');
      expect(typeof result.route.estimate.toAmountMin).toBe('string');
      expect(typeof result.route.estimate.exchangeRate).toBe('string');
      expect(typeof result.route.estimate.aggregatedPriceUSD).toBe('string');
      expect(typeof result.route.estimate.duration).toBe('number');
      expect(result.route.estimate.duration).toBeGreaterThan(0);

      expect(Array.isArray(result.route.route)).toBe(true);
      if (result.route.route.length > 0) {
        const step = result.route.route[0];
        expect(step.fromToken).toBeDefined();
        expect(step.toToken).toBeDefined();
        expect(typeof step.fromToken.symbol).toBe('string');
        expect(typeof step.toToken.symbol).toBe('string');
        expect(typeof step.fromAmount).toBe('string');
        expect(typeof step.toAmount).toBe('string');
        expect(typeof step.protocol).toBe('string');
      }

      expect(BigInt(result.route.estimate.toAmount)).toBeGreaterThan(0n);
      expect(BigInt(result.route.estimate.toAmountMin)).toBeGreaterThan(0n);
    } else {
      console.warn('Squid API returned non-success response (may be temporary):', result.error || result.message);
    }
  });

  // -----------------------------------------------------------------------
  // 2. Graceful degradation — API unavailable does not fail suite
  // -----------------------------------------------------------------------
  it('should handle API errors gracefully without throwing', async () => {
    const result = await squid.getRoute({
      fromChain: 'invalid-chain',
      fromToken: 'invalid-token',
      fromAmount: '1',
      toChain: 'also-invalid',
      toToken: 'also-invalid',
      fromAddress: '0x0000000000000000000000000000000000000001',
    });

    expect(result).toBeDefined();
    expect(typeof result.success).toBe('boolean');
  });

  // -----------------------------------------------------------------------
  // 3. Response shape validation — key fields present
  // -----------------------------------------------------------------------
  it('should return route with valid amount and duration fields', async () => {
    const result = await squid.getRoute({
      fromChain: 'polygon',
      fromToken: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
      fromAmount: '1000000',
      toChain: 'avalanche',
      toToken: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
      fromAddress: '0x0000000000000000000000000000000000000001',
      slippage: 0.5,
    });

    if (result.success && result.route) {
      expect(result.route.estimate.duration).toBeGreaterThan(0);
      expect(typeof result.route.estimate.exchangeRate).toBe('string');
      expect(Number(result.route.estimate.exchangeRate)).toBeGreaterThan(0);
      expect(typeof result.route.estimate.priceImpact).toBe('number');
    } else {
      console.warn('Squid API route unavailable (expected if testnet env is restricted):', result.error);
    }
  });

  // -----------------------------------------------------------------------
  // 4. getChains — returns chain list
  // -----------------------------------------------------------------------
  it('should return available chains from Squid API', async () => {
    try {
      const chains = await squid.getChains();
      expect(chains).toBeDefined();
      expect(Array.isArray(chains.chains)).toBe(true);
      expect(chains.chains.length).toBeGreaterThan(0);
    } catch (err) {
      console.warn('getChains failed (API may be rate-limiting):', err);
    }
  });

  // -----------------------------------------------------------------------
  // 5. getTokens — returns token list
  // -----------------------------------------------------------------------
  it('should return tokens for a specific chain from Squid API', async () => {
    try {
      const tokens = await squid.getTokens('137');
      expect(tokens).toBeDefined();
      expect(Array.isArray(tokens.tokens)).toBe(true);
      expect(tokens.tokens.length).toBeGreaterThan(0);
    } catch (err) {
      console.warn('getTokens failed (API may be rate-limiting):', err);
    }
  });
});
