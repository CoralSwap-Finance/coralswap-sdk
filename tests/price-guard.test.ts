import { SwapModule } from '../src/modules/swap';
import { MissingPriceFeedError, PriceDeviationError, StaleOracleError, ValidationError } from '../src/errors';
import { TradeType } from '../src/types/common';
import { RedStonePayload, SwapWithPriceGuardRequest } from '../src/types/swap';
import { verifyRedStonePayload, estimateUsdValue } from '../src/utils/redstone';
// The fixture signs its own payload with a test ed25519 key. The SDK does not
// verify RedStone signatures itself, so `hasValidFixtureSignature` only proves
// the fixture is internally consistent; it is not end-to-end signature
// verification of the guard.
import { hasValidFixtureSignature, makeSignedRedstonePayload } from './fixtures/redstone-signed-payload';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fresh (non-stale) payload with the given prices. */
function makePayload(
  prices: Record<string, bigint>,
  ageMs = 0,
): RedStonePayload {
  return makeSignedRedstonePayload(prices, Date.now() - ageMs);
}

/** Prices: XLM = $0.10, USDC = $1.00 (× 10^8) */
const PRICES = {
  XLM: 10_000_000n,   // $0.10
  USDC: 100_000_000n, // $1.00
};

const DEFAULT_CONFIG = {
  minGuardedAmountUsd: 100_000_000_00n, // $100
  maxDeviationBps: 200,
  maxPayloadAgeMs: 5 * 60 * 1000,
};

// ---------------------------------------------------------------------------
// verifyRedStonePayload unit tests
// ---------------------------------------------------------------------------

describe('verifyRedStonePayload', () => {
  it('passes for a valid payload with execution price at oracle price', () => {
    // amountIn = 1000 XLM (7 dec) → 10_000_000_000n
    // amountOut = 100 USDC (7 dec) → 1_000_000_000n
    // oracle ratio: XLM/USDC = 0.10/1.00 = 0.1 → 100 USDC per 1000 XLM ✓
    const payload = makePayload(PRICES);
    expect(hasValidFixtureSignature(payload)).toBe(true);
    expect(() =>
      verifyRedStonePayload(
        payload,
        'XLM',
        'USDC',
        10_000_000_000n, // 1000 XLM
        1_000_000_000n,  // 100 USDC
        DEFAULT_CONFIG,
      ),
    ).not.toThrow();
  });

  it('throws StaleOracleError for a payload older than maxPayloadAgeMs', () => {
    const stalePayload = makePayload(PRICES, 6 * 60 * 1000); // 6 min old
    expect(() =>
      verifyRedStonePayload(
        stalePayload,
        'XLM',
        'USDC',
        10_000_000_000n,
        1_000_000_000n,
        DEFAULT_CONFIG,
      ),
    ).toThrow(StaleOracleError);
  });

  it('throws PriceDeviationError when execution price deviates beyond threshold', () => {
    const payload = makePayload(PRICES);
    // amountOut is 50% less than oracle price → ~5000 bps deviation
    expect(() =>
      verifyRedStonePayload(
        payload,
        'XLM',
        'USDC',
        10_000_000_000n, // 1000 XLM
        500_000_000n,    // 50 USDC (should be ~100 USDC)
        DEFAULT_CONFIG,
      ),
    ).toThrow(PriceDeviationError);
  });

  it('passes when deviation is within threshold', () => {
    const payload = makePayload(PRICES);
    // 1% deviation — within 200 bps
    const amountOut = 990_000_000n; // 99 USDC instead of 100
    expect(() =>
      verifyRedStonePayload(
        payload,
        'XLM',
        'USDC',
        10_000_000_000n,
        amountOut,
        DEFAULT_CONFIG,
      ),
    ).not.toThrow();
  });

  it('fails closed when a price symbol is missing from payload', () => {
    const payload = makePayload({ XLM: PRICES.XLM }); // no USDC price
    expect(() =>
      verifyRedStonePayload(
        payload,
        'XLM',
        'USDC',
        10_000_000_000n,
        1n, // would fail if checked
        DEFAULT_CONFIG,
      ),
    ).toThrow(MissingPriceFeedError);
  });

  it('reports MissingPriceFeedError even when amounts are also degenerate', () => {
    // The missing feed is the security-relevant failure, so it must not be
    // masked by the degenerate-amount skip signal.
    const payload = makePayload({ XLM: PRICES.XLM }); // no USDC price
    expect(() =>
      verifyRedStonePayload(payload, 'XLM', 'USDC', 0n, 0n, DEFAULT_CONFIG),
    ).toThrow(MissingPriceFeedError);
  });

  it('returns a passing result with the observed deviation when the guard runs', () => {
    const payload = makePayload(PRICES);
    const result = verifyRedStonePayload(
      payload,
      'XLM',
      'USDC',
      10_000_000_000n,
      990_000_000n, // 1% under oracle price
      DEFAULT_CONFIG,
    );

    expect(result.guardSkipped).toBe(false);
    expect(result.deviationBps).toBeGreaterThan(0);
    expect(result.deviationBps).toBeLessThanOrEqual(DEFAULT_CONFIG.maxDeviationBps);
  });

  it.each([
    ['zero input amount', 0n, 1_000_000_000n],
    ['zero output amount', 10_000_000_000n, 0n],
    ['both amounts zero', 0n, 0n],
    ['negative input amount', -1_000_000_000n, 1_000_000_000n],
  ])('returns an explicit guardSkipped signal for %s', (_label, amountIn, amountOut) => {
    const result = verifyRedStonePayload(
      makePayload(PRICES),
      'XLM',
      'USDC',
      amountIn,
      amountOut,
      DEFAULT_CONFIG,
    );

    // The caller is told the guard did not run, rather than receiving a quiet
    // return that reads like a verified swap.
    expect(result.guardSkipped).toBe(true);
    expect(result.deviationBps).toBeUndefined();
  });

  it('rejects zero-valued feed prices', () => {
    expect(() =>
      verifyRedStonePayload(
        makePayload({ XLM: 0n, USDC: PRICES.USDC }),
        'XLM',
        'USDC',
        10_000_000_000n,
        1_000_000_000n,
        DEFAULT_CONFIG,
      ),
    ).toThrow(MissingPriceFeedError);
  });
});

// ---------------------------------------------------------------------------
// swapWithPriceGuard surfacing
// ---------------------------------------------------------------------------

describe('swapWithPriceGuard price guard reporting', () => {
  function buildSwap(overrides: Partial<SwapModule> = {}): SwapModule {
    return Object.assign(new SwapModule(null as never), overrides);
  }

  const REQUEST = {
    tokenIn: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
    tokenOut: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
    amountIn: 10_000_000_000n,
    minAmountOut: 1n,
  } as unknown as SwapWithPriceGuardRequest;

  const QUOTE = { amountIn: 10_000_000_000n, amountOut: 1_000_000_000n };

  it('surfaces a passing guard result on the swap result', async () => {
    const swap = buildSwap({
      getQuote: jest.fn().mockResolvedValue(QUOTE),
      execute: jest.fn().mockResolvedValue({ txHash: 'MOCK_TX' }),
    } as unknown as Partial<SwapModule>);

    const result = await swap.swapWithPriceGuard(
      { ...REQUEST, redstonePayload: makePayload(PRICES) },
      'XLM',
      'USDC',
    );

    expect(result.priceGuard?.guardSkipped).toBe(false);
  });

  it('surfaces guardSkipped instead of hiding it when amounts are degenerate', async () => {
    // amountIn is large enough to require the guard, amountOut is zero, so the
    // guard is required but cannot compute a ratio.
    const swap = buildSwap({
      getQuote: jest.fn().mockResolvedValue({ amountIn: 10_000_000_000n, amountOut: 0n }),
      execute: jest.fn().mockResolvedValue({ txHash: 'MOCK_TX' }),
    } as unknown as Partial<SwapModule>);

    const result = await swap.swapWithPriceGuard(
      { ...REQUEST, redstonePayload: makePayload(PRICES) },
      'XLM',
      'USDC',
    );

    // The swap went through, but the caller can see the guard never verified it.
    expect(result.priceGuard?.guardSkipped).toBe(true);
  });

  it('does not require the guard below the USD threshold, leaving priceGuard absent', async () => {
    // amountIn of 0 makes the USD value 0, which is below the $100 threshold, so
    // the guard is not required and the result carries no guard outcome.
    const swap = buildSwap({
      getQuote: jest.fn().mockResolvedValue({ amountIn: 0n, amountOut: 0n }),
      execute: jest.fn().mockResolvedValue({ txHash: 'MOCK_TX' }),
    } as unknown as Partial<SwapModule>);

    const result = await swap.swapWithPriceGuard(
      { ...REQUEST, redstonePayload: makePayload(PRICES) },
      'XLM',
      'USDC',
    );

    expect(result.priceGuard).toBeUndefined();
  });

  it('leaves priceGuard absent when no payload was supplied', async () => {
    const swap = buildSwap({
      getQuote: jest.fn().mockResolvedValue(QUOTE),
      execute: jest.fn().mockResolvedValue({ txHash: 'MOCK_TX' }),
    } as unknown as Partial<SwapModule>);

    const result = await swap.swapWithPriceGuard(REQUEST, 'XLM', 'USDC');

    expect(result.priceGuard).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// estimateUsdValue unit tests
// ---------------------------------------------------------------------------

describe('estimateUsdValue', () => {
  it('returns correct USD value', () => {
    // 1000 XLM × $0.10 = $100 → 100 × 10^8 = 10_000_000_000n
    const usd = estimateUsdValue(10_000_000_000n, 'XLM', PRICES);
    expect(usd).toBe(10_000_000_000n);
  });

  it('returns null when symbol is not in prices', () => {
    expect(estimateUsdValue(1_000_000n, 'BTC', PRICES)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SwapModule.swapWithPriceGuard integration-style tests (mocked execute)
// ---------------------------------------------------------------------------

describe('SwapModule.swapWithPriceGuard', () => {
  let swap: SwapModule;
  const mockResult = {
    txHash: 'abc123',
    amountIn: 10_000_000_000n,
    amountOut: 1_000_000_000n,
    feePaid: 0n,
    ledger: 1,
    timestamp: 0,
  };
  const mockQuote = {
    tokenIn: 'XLM_ADDR',
    tokenOut: 'USDC_ADDR',
    amountIn: 10_000_000_000n,
    amountOut: 1_000_000_000n,
    amountOutMin: 990_000_000n,
    priceImpactBps: 10,
    feeBps: 30,
    feeAmount: 30_000n,
    path: ['XLM_ADDR', 'USDC_ADDR'],
    deadline: Math.floor(Date.now() / 1000) + 60,
  };

  const baseRequest: SwapWithPriceGuardRequest = {
    tokenIn: 'XLM_ADDR',
    tokenOut: 'USDC_ADDR',
    amount: 10_000_000_000n,
    tradeType: TradeType.EXACT_IN,
    quote: mockQuote,
  };

  beforeEach(() => {
    swap = new SwapModule(null as any);
    // Stub execute to avoid real RPC calls
    jest.spyOn(swap, 'execute').mockResolvedValue(mockResult);
  });

  afterEach(() => jest.restoreAllMocks());

  it('executes when valid payload passes guard', async () => {
    const payload = makePayload(PRICES);
    const result = await swap.swapWithPriceGuard(
      { ...baseRequest, redstonePayload: payload },
      'XLM',
      'USDC',
    );
    expect(result.txHash).toBe('abc123');
    expect(swap.execute).toHaveBeenCalledTimes(1);
  });

  it('throws StaleOracleError for stale payload', async () => {
    const stalePayload = makePayload(PRICES, 6 * 60 * 1000);
    await expect(
      swap.swapWithPriceGuard(
        { ...baseRequest, redstonePayload: stalePayload },
        'XLM',
        'USDC',
      ),
    ).rejects.toThrow(StaleOracleError);
    expect(swap.execute).not.toHaveBeenCalled();
  });

  it('throws PriceDeviationError when deviation exceeds threshold', async () => {
    const payload = makePayload(PRICES);
    // Manipulate quote to have a bad execution price
    const badQuote = { ...mockQuote, amountOut: 100_000_000n }; // 10 USDC instead of 100
    await expect(
      swap.swapWithPriceGuard(
        { ...baseRequest, quote: badQuote, redstonePayload: payload },
        'XLM',
        'USDC',
      ),
    ).rejects.toThrow(PriceDeviationError);
    expect(swap.execute).not.toHaveBeenCalled();
  });

  it('bypasses guard for small swaps below threshold even without payload', async () => {
    // Set a very high threshold so this swap is "small"
    swap.setPriceGuardConfig(1_000_000_000_000n, 200); // $10,000 threshold
    const result = await swap.swapWithPriceGuard(
      { ...baseRequest }, // no redstonePayload
      'XLM',
      'USDC',
    );
    expect(result.txHash).toBe('abc123');
    expect(swap.execute).toHaveBeenCalledTimes(1);
  });

  it('setPriceGuardConfig throws ValidationError for invalid maxDeviationBps', () => {
    expect(() => swap.setPriceGuardConfig(100n, -1)).toThrow(ValidationError);
    expect(() => swap.setPriceGuardConfig(100n, 10001)).toThrow(ValidationError);
  });
  it('execute respects request.quote without re-quoting (TOCTOU prevention)', async () => {
    const swapInstance = new SwapModule(null as any);
    const getQuoteSpy = jest.spyOn(swapInstance, 'getQuote');
    const mockBuild = jest.spyOn(swapInstance as any, 'buildSwapOperation').mockReturnValue({} as any);
    const mockSubmit = jest.spyOn(swapInstance as any, 'submitSwapWithIdempotentResubmission').mockResolvedValue({ txHash: 'RESOLVED_TX' });

    const quote = { amountIn: 10_000_000n, amountOut: 1_000_000n, amountOutMin: 990_000n, deadline: 99999999 } as any;
    const req = { tokenIn: 'AAA', tokenOut: 'BBB', amount: 10_000_000n, tradeType: 0, quote } as any;

    const res = await swapInstance.execute(req);
    expect(getQuoteSpy).not.toHaveBeenCalled();
    expect(mockBuild).toHaveBeenCalledWith(req, quote);
  });
});
