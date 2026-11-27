import { DeadlineError, CoralSwapSDKError } from '../src/errors';
import { DeadlineError as RetryDeadlineError, withRetry } from '../src/utils/retry';
import { DeadlineError as PublicDeadlineError } from '../src';

describe('DeadlineError identity (#636)', () => {
  it('is one class across errors, retry and the public entry point', () => {
    expect(RetryDeadlineError).toBe(DeadlineError);
    expect(PublicDeadlineError).toBe(DeadlineError);
  });

  it('a retry deadline from withRetry matches the public DeadlineError', async () => {
    const deadlineMs = Date.now() - 50;
    const err = await withRetry(async () => 'unreachable', {
      maxRetries: 3,
      baseDelayMs: 1,
      backoffMultiplier: 1,
      maxDelayMs: 1,
      deadlineMs,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(PublicDeadlineError);
    expect(err).toBeInstanceOf(CoralSwapSDKError);
    expect(err.code).toBe('DEADLINE_EXCEEDED');
    expect(err.deadlineMs).toBe(deadlineMs);
    expect(err.pastDeadlineMs).toBeGreaterThanOrEqual(50);
  });

  it('keeps the retry fields when constructed directly', () => {
    const err = new DeadlineError(1_000, 1_250);
    expect(err.details?.deadline).toBe(1_000);
    expect(err.deadlineMs).toBe(1_000);
    expect(err.nowMs).toBe(1_250);
    expect(err.pastDeadlineMs).toBe(250);
    expect(new DeadlineError(1_000, 900).pastDeadlineMs).toBe(0);
  });
});
