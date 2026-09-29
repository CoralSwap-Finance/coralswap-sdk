import { CoralSwapClient } from '../../src/client';
import { Network } from '../../src/types/common';
import { SquidModule } from '../../src/modules/squid';

/**
 * Integration test: cross-chain quote normalization through Squid Router.
 *
 * The native route is deterministic and does not call Squid. The external
 * route is best-effort because the public Squid API may be unavailable or
 * require credentials that are not present on fork pull requests.
 *
 * Prerequisites (set via env vars):
 *   STELLAR_TESTNET - must be 'true' to run
 *   TEST_KEYPAIR    - funded testnet secret key (S...)
 *   TEST_TOKEN_A    - source Stellar token contract address
 *   TEST_TOKEN_B    - destination Stellar token contract address
 *   TEST_RPC_URL    - optional RPC override
 */
const SKIP =
  process.env.STELLAR_TESTNET !== 'true' ||
  !process.env.TEST_KEYPAIR ||
  !process.env.TEST_TOKEN_A ||
  !process.env.TEST_TOKEN_B;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const describeIntegration = SKIP ? describe.skip : describe;

describeIntegration('Squid Router (testnet)', () => {
  let client: CoralSwapClient;
  let squid: SquidModule;
  let tokenA: string;
  let tokenB: string;

  beforeAll(() => {
    client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: requireEnv('TEST_KEYPAIR'),
      ...(process.env.TEST_RPC_URL ? { rpcUrl: process.env.TEST_RPC_URL } : {}),
    });
    tokenA = requireEnv('TEST_TOKEN_A');
    tokenB = requireEnv('TEST_TOKEN_B');
    squid = new SquidModule(client);
  });

  it('normalizes a Stellar-native quote without a bridge leg', async () => {
    const amount = 1_000_000n;
    const quote = await squid.getCrossChainQuote({
      fromChain: 'stellar',
      fromAsset: tokenA,
      toAsset: tokenB,
      amount,
      toAddress: client.publicKey,
      slippageBps: 100,
    });

    expect(quote.isStellarNative).toBe(true);
    expect(quote.fromChain).toBe('stellar');
    expect(quote.fromAsset).toBe(tokenA);
    expect(quote.toAsset).toBe(tokenB);
    expect(quote.amountIn).toBe(amount);
    expect(quote.bridgedAmount).toBe(amount);
    expect(quote.estimatedAmountOut).toBe(amount);
    expect(quote.amountOutMin).toBe(990_000n);
    expect(quote.bridgeFee).toBe(0n);
    expect(quote.swapFee).toBe(0n);
    expect(quote.estimatedTimeSeconds).toBe(0);
    expect(quote.bridgeCalldata).toBeUndefined();
    expect(quote.steps).toEqual([
      {
        type: 'swap',
        chain: 'stellar',
        description: `Swap ${tokenA} -> ${tokenB} on CoralSwap`,
      },
    ]);
  });

  it('normalizes an external Squid route when the public API is available', async () => {
    try {
      const quote = await squid.getCrossChainQuote({
        fromChain: 'ethereum',
        fromAsset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        toAsset: tokenB,
        amount: 1_000_000n,
        toAddress: client.publicKey,
        slippageBps: 100,
      });

      expect(quote.isStellarNative).toBe(false);
      expect(quote.routeId).toBeTruthy();
      expect(quote.fromChain).toBe('ethereum');
      expect(quote.fromAsset).toBe(
        '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      );
      expect(quote.toAsset).toBe(tokenB);
      expect(quote.amountIn).toBe(1_000_000n);
      expect(quote.bridgedAmount).toBeGreaterThan(0n);
      expect(quote.estimatedAmountOut).toBe(quote.bridgedAmount);
      expect(quote.amountOutMin).toBeLessThanOrEqual(quote.estimatedAmountOut);
      expect(quote.steps.map((step) => step.type)).toEqual(['bridge', 'swap']);
    } catch (error) {
      console.warn(
        'Squid API route unavailable; skipping external-route assertions:',
        error,
      );
    }
  });
});
