import { waitNextLedger } from '../src/utils/ledger';

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
