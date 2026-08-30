import {
  withRetry,
  isRetryable,
  getCircuitBreaker,
  resetCircuitBreakers,
  CircuitOpenError,
  DeadlineError,
} from '../src/utils/retry';

describe('Retry Utilities', () => {
  let setTimeoutSpy: jest.SpiedFunction<typeof setTimeout>;

  beforeEach(() => {
    resetCircuitBreakers();
    setTimeoutSpy = jest.spyOn(global, 'setTimeout');
  });

  afterEach(() => {
    jest.useRealTimers();
    setTimeoutSpy.mockRestore();
    jest.clearAllMocks();
  });

  it('retries with exponential backoff intervals and eventually succeeds', async () => {
    const operation = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))
      .mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))
      .mockResolvedValueOnce('ok');

    const result = await withRetry(operation, {
      maxRetries: 3,
      baseDelayMs: 5,
      backoffMultiplier: 2,
      maxDelayMs: 100,
    });

    expect(result).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(3);

    const retryDelays = setTimeoutSpy.mock.calls.map((call: any[]) => call[1]);
    expect(retryDelays.length).toBeGreaterThanOrEqual(2);
    expect(retryDelays[0]).toBeGreaterThanOrEqual(0);
    expect(retryDelays[1]).toBeGreaterThanOrEqual(0);
  });

  it('respects maximum retry limit and throws the last error', async () => {
    const operation = jest
      .fn<Promise<never>, []>()
      .mockRejectedValue(Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }));

    await expect(
      withRetry(operation, {
        maxRetries: 2,
        baseDelayMs: 3,
        backoffMultiplier: 2,
        maxDelayMs: 100,
      }),
    ).rejects.toThrow('ETIMEDOUT');

    expect(operation).toHaveBeenCalledTimes(3);

    const retryDelays = setTimeoutSpy.mock.calls.map((call: any[]) => call[1]);
    expect(retryDelays.length).toBeGreaterThanOrEqual(2);
  });

  it('caps backoff delay at maxDelayMs', async () => {
    const operation = jest
      .fn<Promise<never>, []>()
      .mockRejectedValue(Object.assign(new Error('503 Service Unavailable'), { response: { status: 503 } }));

    await expect(
      withRetry(operation, {
        maxRetries: 3,
        baseDelayMs: 4,
        backoffMultiplier: 3,
        maxDelayMs: 10,
      }),
    ).rejects.toThrow('503 Service Unavailable');

    const retryDelays = setTimeoutSpy.mock.calls.map((call: any[]) => call[1]);
    expect(retryDelays.length).toBeGreaterThanOrEqual(3);
    expect(retryDelays[1]).toBeLessThanOrEqual(10);
    expect(retryDelays[2]).toBeLessThanOrEqual(10);
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

  it('stops retrying once deadlineMs is reached and throws DeadlineError', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));

    const operation = jest
      .fn<Promise<never>, []>()
      .mockRejectedValue(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));

    const deadlineMs = Date.now() + 15;

    const promise = withRetry(operation, {
      maxRetries: 10,
      baseDelayMs: 10,
      backoffMultiplier: 1,
      maxDelayMs: 10,
      deadlineMs,
    });

    const caught = promise.catch((e) => e);

    await jest.advanceTimersByTimeAsync(20);

    const err = await caught;
    expect(err).toBeInstanceOf(DeadlineError);
    expect(err.message).not.toContain('ETIMEDOUT');

    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('opens circuit after consecutive failures threshold', async () => {
    const label = 'CircuitTest_threshold';
    const operation = jest
      .fn<Promise<never>, []>()
      .mockRejectedValue(new Error('ETIMEDOUT'));

    await expect(
      withRetry(operation, {
        maxRetries: 0,
        baseDelayMs: 1,
        backoffMultiplier: 2,
        maxDelayMs: 1,
        circuitBreaker: { failureThreshold: 2, cooldownMs: 30_000 },
      }, undefined, label),
    ).rejects.toThrow('ETIMEDOUT');

    expect(getCircuitBreaker(label).getState()).toBe('closed');

    await expect(
      withRetry(operation, {
        maxRetries: 0,
        baseDelayMs: 1,
        backoffMultiplier: 2,
        maxDelayMs: 1,
        circuitBreaker: { failureThreshold: 2, cooldownMs: 30_000 },
      }, undefined, label),
    ).rejects.toThrow('ETIMEDOUT');

    expect(getCircuitBreaker(label).getState()).toBe('open');
  });

  it('fast-fails while circuit is open without attempting the operation', async () => {
    const label = 'CircuitTest_fastFail';
    const operation = jest
      .fn<Promise<never>, []>()
      .mockRejectedValue(new Error('ETIMEDOUT'));

    await expect(
      withRetry(operation, {
        maxRetries: 0,
        baseDelayMs: 1,
        backoffMultiplier: 2,
        maxDelayMs: 1,
        circuitBreaker: { failureThreshold: 1, cooldownMs: 30_000 },
      }, undefined, label),
    ).rejects.toThrow('ETIMEDOUT');

    expect(getCircuitBreaker(label).getState()).toBe('open');

    const op2 = jest.fn<Promise<string>, []>().mockResolvedValue('ok');
    await expect(
      withRetry(op2, {
        maxRetries: 0,
        baseDelayMs: 1,
        backoffMultiplier: 2,
        maxDelayMs: 1,
        circuitBreaker: { failureThreshold: 1, cooldownMs: 30_000 },
      }, undefined, label),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(op2).toHaveBeenCalledTimes(0);
  });

  it('maxRetries=0 with retryable error calls fn exactly once and throws immediately', async () => {
    const operation = jest
      .fn<Promise<never>, []>()
      .mockRejectedValue(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));

    await expect(
      withRetry(operation, {
        maxRetries: 0,
        baseDelayMs: 500,
        backoffMultiplier: 2,
        maxDelayMs: 1000,
      }),
    ).rejects.toThrow('timeout');

    expect(operation).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it('maxRetries=0 with non-retryable error calls fn exactly once and throws immediately', async () => {
    const operation = jest
      .fn<Promise<never>, []>()
      .mockRejectedValueOnce(new Error('slippage exceeded'));

    await expect(
      withRetry(operation, {
        maxRetries: 0,
        baseDelayMs: 500,
        backoffMultiplier: 2,
        maxDelayMs: 1000,
      }),
    ).rejects.toThrow('slippage exceeded');

    expect(operation).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it('non-retryable error is thrown verbatim without wrapping or mutation', async () => {
    class CustomAppError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'CustomAppError';
      }
    }

    const original = new CustomAppError('invalid pair');
    const operation = jest.fn<Promise<never>, []>().mockRejectedValueOnce(original);

    await expect(
      withRetry(operation, {
        maxRetries: 3,
        baseDelayMs: 5,
        backoffMultiplier: 2,
        maxDelayMs: 100,
      }),
    ).rejects.toBe(original);

    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('half-open state forces maxRetries=0 even when caller requests retries', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));

    const label = 'CircuitTest_halfOpenSingleShot';
    const failing = jest
      .fn<Promise<never>, []>()
      .mockRejectedValue(new Error('ETIMEDOUT'));

    await expect(
      withRetry(failing, {
        maxRetries: 0,
        baseDelayMs: 1,
        backoffMultiplier: 2,
        maxDelayMs: 1,
        circuitBreaker: { failureThreshold: 1, cooldownMs: 30_000 },
      }, undefined, label),
    ).rejects.toThrow('ETIMEDOUT');

    jest.advanceTimersByTime(30_000);
    expect(getCircuitBreaker(label).getState()).toBe('half-open');

    const failingAgain = jest
      .fn<Promise<never>, []>()
      .mockRejectedValue(new Error('ETIMEDOUT'));

    await expect(
      withRetry(failingAgain, {
        maxRetries: 5,
        baseDelayMs: 500,
        backoffMultiplier: 2,
        maxDelayMs: 1000,
        circuitBreaker: { failureThreshold: 2, cooldownMs: 30_000 },
      }, undefined, label),
    ).rejects.toThrow('ETIMEDOUT');

    expect(failingAgain).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(getCircuitBreaker(label).getState()).toBe('open');
  });

  it('half-open probe failure re-opens the circuit', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));

    const label = 'CircuitTest_halfOpenReopen';

    const failing = jest
      .fn<Promise<never>, []>()
      .mockRejectedValue(new Error('ETIMEDOUT'));

    await expect(
      withRetry(failing, {
        maxRetries: 0,
        baseDelayMs: 1,
        backoffMultiplier: 2,
        maxDelayMs: 1,
        circuitBreaker: { failureThreshold: 2, cooldownMs: 30_000 },
      }, undefined, label),
    ).rejects.toThrow('ETIMEDOUT');

    expect(getCircuitBreaker(label).getState()).toBe('closed');

    await expect(
      withRetry(failing, {
        maxRetries: 0,
        baseDelayMs: 1,
        backoffMultiplier: 2,
        maxDelayMs: 1,
        circuitBreaker: { failureThreshold: 2, cooldownMs: 30_000 },
      }, undefined, label),
    ).rejects.toThrow('ETIMEDOUT');

    expect(getCircuitBreaker(label).getState()).toBe('open');

    jest.advanceTimersByTime(30_000);
    expect(getCircuitBreaker(label).getState()).toBe('half-open');

    const failingOnce = jest
      .fn<Promise<never>, []>()
      .mockRejectedValue(new Error('connection reset'));

    await expect(
      withRetry(failingOnce, {
        maxRetries: 0,
        baseDelayMs: 1,
        backoffMultiplier: 2,
        maxDelayMs: 1,
        circuitBreaker: { failureThreshold: 2, cooldownMs: 30_000 },
      }, undefined, label),
    ).rejects.toThrow('connection reset');

    expect(getCircuitBreaker(label).getState()).toBe('open');
  });

  it('auto-closes after cooldown and allows a half-open probe', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));

    const label = 'CircuitTest_cooldown';
    const failing = jest
      .fn<Promise<never>, []>()
      .mockRejectedValue(new Error('ETIMEDOUT'));

    await expect(
      withRetry(failing, {
        maxRetries: 0,
        baseDelayMs: 1,
        backoffMultiplier: 2,
        maxDelayMs: 1,
        circuitBreaker: { failureThreshold: 1, cooldownMs: 30_000 },
      }, undefined, label),
    ).rejects.toThrow('ETIMEDOUT');

    const breaker = getCircuitBreaker(label);
    expect(breaker.getState()).toBe('open');

    jest.advanceTimersByTime(30_000);
    expect(breaker.getState()).toBe('half-open');

    const success = jest.fn<Promise<string>, []>().mockResolvedValue('ok');
    await expect(
      withRetry(success, {
        maxRetries: 0,
        baseDelayMs: 1,
        backoffMultiplier: 2,
        maxDelayMs: 1,
        circuitBreaker: { failureThreshold: 1, cooldownMs: 30_000 },
      }, undefined, label),
    ).resolves.toBe('ok');

    expect(breaker.getState()).toBe('closed');
  });
});
