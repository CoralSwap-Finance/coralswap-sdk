import { withRetry, isRetryable } from '../src/utils/retry';

describe('Retry Utilities', () => {
  let setTimeoutSpy: jest.SpiedFunction<typeof setTimeout>;

  beforeEach(() => {
    setTimeoutSpy = jest.spyOn(global, 'setTimeout');
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
    jest.clearAllMocks();
  });

  it('retries with exponential backoff intervals and eventually succeeds', async () => {
    const operation = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce('ok');

    const result = await withRetry(operation, {
      maxRetries: 3,
      baseDelayMs: 5,
      backoffMultiplier: 2,
      maxDelayMs: 100,
    });

    expect(result).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(3);

    const retryDelays = setTimeoutSpy.mock.calls.map((call) => call[1]);
    expect(retryDelays.slice(0, 2)).toEqual([5, 10]);
  });

  it('respects maximum retry limit and throws the last error', async () => {
    const operation = jest
      .fn<Promise<never>, []>()
      .mockRejectedValue(new Error('ENOTFOUND'));

    await expect(
      withRetry(operation, {
        maxRetries: 2,
        baseDelayMs: 3,
        backoffMultiplier: 2,
        maxDelayMs: 100,
      }),
    ).rejects.toThrow('ENOTFOUND');

    expect(operation).toHaveBeenCalledTimes(3);

    const retryDelays = setTimeoutSpy.mock.calls.map((call) => call[1]);
    expect(retryDelays.slice(0, 2)).toEqual([3, 6]);
  });

  it('caps backoff delay at maxDelayMs', async () => {
    const operation = jest
      .fn<Promise<never>, []>()
      .mockRejectedValue(new Error('503 Service Unavailable'));

    await expect(
      withRetry(operation, {
        maxRetries: 3,
        baseDelayMs: 4,
        backoffMultiplier: 3,
        maxDelayMs: 10,
      }),
    ).rejects.toThrow('503 Service Unavailable');

    const retryDelays = setTimeoutSpy.mock.calls.map((call) => call[1]);
    expect(retryDelays.slice(0, 3)).toEqual([4, 10, 10]);
  });

  it('does not retry non-retryable errors', async () => {
    const operation = jest
      .fn<Promise<never>, []>()
      .mockRejectedValueOnce(new Error('Validation failed'));

    await expect(
      withRetry(operation, {
        maxRetries: 5,
        baseDelayMs: 5,
        backoffMultiplier: 2,
        maxDelayMs: 100,
      }),
    ).rejects.toThrow('Validation failed');

    expect(operation).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it('detects retryable errors from known transient patterns', () => {
    expect(isRetryable(new Error('Socket hang up'))).toBe(true);
    expect(isRetryable(new Error('HTTP 429 Too Many Requests'))).toBe(true);
    expect(isRetryable(new Error('Invalid slippage value'))).toBe(false);
  });
});
