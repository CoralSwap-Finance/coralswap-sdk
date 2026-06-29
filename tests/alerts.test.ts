import { createPriceAlert, getPriceAlerts } from '../src/modules/alerts';
import { ValidationError } from '../src/errors';

const WALLET = 'GABC123WALLET';
const TOKEN = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2ZCMJ';

function mockFetch(price: number) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => [{ value: price }],
  } as any);
}

beforeEach(() => {
  // Reset in-memory store between tests by re-importing is not needed;
  // use unique wallet addresses per test to isolate state.
  jest.restoreAllMocks();
});

describe('createPriceAlert', () => {
  it('creates an alert and returns it with correct fields', async () => {
    mockFetch(1.5);
    const alert = await createPriceAlert(`${WALLET}_create`, {
      tokenAddress: TOKEN,
      tokenSymbol: 'XLM',
      targetPriceUSD: 2.0,
      direction: 'above',
      label: 'XLM moon',
    });

    expect(alert.tokenAddress).toBe(TOKEN);
    expect(alert.tokenSymbol).toBe('XLM');
    expect(alert.targetPriceUSD).toBe(2.0);
    expect(alert.direction).toBe('above');
    expect(alert.label).toBe('XLM moon');
    expect(alert.triggered).toBe(false);
    expect(alert.id).toMatch(/^alert_/);
  });

  it('throws ValidationError when targetPriceUSD is zero', async () => {
    await expect(
      createPriceAlert(`${WALLET}_zero`, {
        tokenAddress: TOKEN,
        tokenSymbol: 'XLM',
        targetPriceUSD: 0,
        direction: 'above',
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError when targetPriceUSD is negative', async () => {
    await expect(
      createPriceAlert(`${WALLET}_neg`, {
        tokenAddress: TOKEN,
        tokenSymbol: 'XLM',
        targetPriceUSD: -5,
        direction: 'above',
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('accepts optional label and pairAddress', async () => {
    mockFetch(1.0);
    const alert = await createPriceAlert(`${WALLET}_opts`, {
      tokenAddress: TOKEN,
      tokenSymbol: 'XLM',
      targetPriceUSD: 0.5,
      direction: 'below',
      pairAddress: 'CPAIR123',
      label: 'stop loss',
    });
    expect(alert.pairAddress).toBe('CPAIR123');
    expect(alert.label).toBe('stop loss');
  });

  it('label is optional -- undefined when not provided', async () => {
    mockFetch(1.0);
    const alert = await createPriceAlert(`${WALLET}_nolabel`, {
      tokenAddress: TOKEN,
      tokenSymbol: 'XLM',
      targetPriceUSD: 5.0,
      direction: 'above',
    });
    expect(alert.label).toBeUndefined();
  });

  describe('initial armed state', () => {
    it('starts armed (not triggered) when price is below target for "above" alert', async () => {
      mockFetch(1.0); // price < 2.0 target
      const alert = await createPriceAlert(`${WALLET}_armed_above`, {
        tokenAddress: TOKEN,
        tokenSymbol: 'XLM',
        targetPriceUSD: 2.0,
        direction: 'above',
      });
      expect(alert.armed).toBe(true);
      expect(alert.triggered).toBe(false);
    });

    it('starts disarmed when price is already above target for "above" alert', async () => {
      mockFetch(3.0); // price > 2.0 target
      const alert = await createPriceAlert(`${WALLET}_disarmed_above`, {
        tokenAddress: TOKEN,
        tokenSymbol: 'XLM',
        targetPriceUSD: 2.0,
        direction: 'above',
      });
      expect(alert.armed).toBe(false);
    });

    it('starts armed when price is above target for "below" alert', async () => {
      mockFetch(3.0); // price > 2.0 target → not on trigger side
      const alert = await createPriceAlert(`${WALLET}_armed_below`, {
        tokenAddress: TOKEN,
        tokenSymbol: 'XLM',
        targetPriceUSD: 2.0,
        direction: 'below',
      });
      expect(alert.armed).toBe(true);
    });
  });
});

describe('getPriceAlerts', () => {
  it('returns empty array when no alerts exist', async () => {
    const alerts = await getPriceAlerts(`${WALLET}_empty`);
    expect(alerts).toEqual([]);
  });

  it('triggers alert when price crosses above target', async () => {
    const wallet = `${WALLET}_trigger_above`;
    mockFetch(1.0);
    await createPriceAlert(wallet, {
      tokenAddress: TOKEN,
      tokenSymbol: 'XLM',
      targetPriceUSD: 2.0,
      direction: 'above',
    });

    // Price crosses above threshold
    mockFetch(3.0);
    const alerts = await getPriceAlerts(wallet);
    expect(alerts[0].triggered).toBe(true);
    expect(alerts[0].armed).toBe(false);
  });

  it('triggers alert when price crosses below target', async () => {
    const wallet = `${WALLET}_trigger_below`;
    mockFetch(5.0);
    await createPriceAlert(wallet, {
      tokenAddress: TOKEN,
      tokenSymbol: 'XLM',
      targetPriceUSD: 2.0,
      direction: 'below',
    });

    mockFetch(1.0);
    const alerts = await getPriceAlerts(wallet);
    expect(alerts[0].triggered).toBe(true);
  });

  it('does not re-trigger until price crosses back and returns', async () => {
    const wallet = `${WALLET}_no_retrigger`;
    mockFetch(1.0);
    await createPriceAlert(wallet, {
      tokenAddress: TOKEN,
      tokenSymbol: 'XLM',
      targetPriceUSD: 2.0,
      direction: 'above',
    });

    // First cross — triggers
    mockFetch(3.0);
    let alerts = await getPriceAlerts(wallet);
    expect(alerts[0].triggered).toBe(true);
    expect(alerts[0].armed).toBe(false);

    // Still above — no re-trigger, remains triggered & disarmed
    mockFetch(4.0);
    alerts = await getPriceAlerts(wallet);
    expect(alerts[0].triggered).toBe(true);
    expect(alerts[0].armed).toBe(false);

    // Drops back below — re-arms
    mockFetch(1.5);
    alerts = await getPriceAlerts(wallet);
    expect(alerts[0].armed).toBe(true);

    // Crosses above again — re-triggers
    mockFetch(3.5);
    alerts = await getPriceAlerts(wallet);
    expect(alerts[0].triggered).toBe(true);
    expect(alerts[0].armed).toBe(false);
  });

  it('does not trigger when price stays on the safe side', async () => {
    const wallet = `${WALLET}_no_trigger`;
    mockFetch(1.0);
    await createPriceAlert(wallet, {
      tokenAddress: TOKEN,
      tokenSymbol: 'XLM',
      targetPriceUSD: 2.0,
      direction: 'above',
    });

    mockFetch(1.8); // still below target
    const alerts = await getPriceAlerts(wallet);
    expect(alerts[0].triggered).toBe(false);
    expect(alerts[0].armed).toBe(true);
  });

  it('updates lastCheckedAt and lastPriceUSD on each check', async () => {
    const wallet = `${WALLET}_meta`;
    mockFetch(1.0);
    const created = await createPriceAlert(wallet, {
      tokenAddress: TOKEN,
      tokenSymbol: 'XLM',
      targetPriceUSD: 5.0,
      direction: 'above',
    });

    mockFetch(1.2);
    const alerts = await getPriceAlerts(wallet);
    expect(alerts[0].lastPriceUSD).toBe(1.2);
    expect(alerts[0].lastCheckedAt).toBeGreaterThanOrEqual(created.createdAt);
  });

  it('throws when RedStone fetch fails', async () => {
    const wallet = `${WALLET}_fetch_fail`;
    mockFetch(1.0);
    await createPriceAlert(wallet, {
      tokenAddress: TOKEN,
      tokenSymbol: 'XLM',
      targetPriceUSD: 2.0,
      direction: 'above',
    });

    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 } as any);
    await expect(getPriceAlerts(wallet)).rejects.toThrow('RedStone price fetch failed');
  });
});
