import {
  waitNextLedger,
  ledgerToApproxTime,
  LEDGER_CLOSE_INTERVAL_SECONDS,
} from '../src/utils/ledger';

describe('ledgerToApproxTime', () => {
  const head = { ledger: 1_000, closeTime: 1_700_000_000 };

  it('returns the head close time for the head ledger', () => {
    expect(ledgerToApproxTime(head.ledger, head)).toBe(head.closeTime);
  });

  it('extrapolates forward at the ledger close interval', () => {
    expect(ledgerToApproxTime(head.ledger + 12, head)).toBe(
      head.closeTime + 12 * LEDGER_CLOSE_INTERVAL_SECONDS,
    );
  });

  it('extrapolates backward for ledgers before the head', () => {
    expect(ledgerToApproxTime(head.ledger - 100, head)).toBe(
      head.closeTime - 100 * LEDGER_CLOSE_INTERVAL_SECONDS,
    );
  });

  it('measures a ledger span in seconds when close time cancels out', () => {
    const span = 250;
    const seconds = ledgerToApproxTime(head.ledger + span, {
      ledger: head.ledger,
      closeTime: 0,
    });
    expect(seconds).toBe(span * LEDGER_CLOSE_INTERVAL_SECONDS);
  });

  it('pins the close interval to Stellar\'s ~5s cadence', () => {
    expect(LEDGER_CLOSE_INTERVAL_SECONDS).toBe(5);
  });
});

describe('waitNextLedger', () => {
  it('resolves with new ledger when it increments', async () => {
    let ledger = 100;
    const getCurrentLedger = jest.fn().mockImplementation(() => Promise.resolve(ledger));

    const resultPromise = waitNextLedger(getCurrentLedger, {
      pollIntervalMs: 10,
      timeoutMs: 2000,
    });

    await new Promise((r) => setTimeout(r, 30));
    ledger = 101;

    const result = await resultPromise;
    expect(result).toBe(101);
    expect(getCurrentLedger).toHaveBeenCalled();
  });

  it('throws when timeout is reached before ledger increments', async () => {
    const getCurrentLedger = jest.fn().mockResolvedValue(50);

    await expect(
      waitNextLedger(getCurrentLedger, { pollIntervalMs: 20, timeoutMs: 50 }),
    ).rejects.toThrow('timed out');
  });

  it('uses default options when not provided', async () => {
    let count = 0;
    const getCurrentLedger = jest.fn().mockImplementation(() =>
      Promise.resolve(++count),
    );
    const result = await waitNextLedger(getCurrentLedger, {
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });
    expect(result).toBe(2);
  });
});
