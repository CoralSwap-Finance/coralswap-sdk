import { ValidationError } from "@/errors";

/**
 * Source of the current time for the webhook delivery scheduler.
 *
 * Injected so the delivery state machine can be driven deterministically in
 * tests without waiting on real timers.
 */
export interface Clock {
  /** Current time in milliseconds since the Unix epoch. */
  now(): number;
}

/** Clock backed by the real system time. */
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

/**
 * Manually-advanced clock for deterministic tests.
 *
 * @example
 * ```ts
 * const clock = new FakeClock();
 * const queue = new WebhookDeliveryQueue({ clock });
 * clock.advance(60_000); // simulate a minute passing
 * ```
 */
export class FakeClock implements Clock {
  private currentMs: number;

  constructor(startMs = 0) {
    this.currentMs = startMs;
  }

  now(): number {
    return this.currentMs;
  }

  /** Move the clock forward by `ms` milliseconds and return the new time. */
  advance(ms: number): number {
    if (ms < 0) {
      throw new ValidationError("FakeClock cannot advance by a negative duration", { ms });
    }
    this.currentMs += ms;
    return this.currentMs;
  }

  /** Set the clock to an absolute time. */
  set(ms: number): void {
    this.currentMs = ms;
  }
}
