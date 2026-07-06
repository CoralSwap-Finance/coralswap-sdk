/**
 * Unit tests for batchRequest / batchRequestOrThrow.
 *
 * All tests use only in-memory mock functions — no real network calls.
 */

import { batchRequest, batchRequestOrThrow, batchCall, batchCallSequential, DEFAULT_BATCH_CONCURRENCY } from '../src/utils/batch-request';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a task that resolves with `value` after `delayMs`. */
function makeTask<T>(value: T, delayMs = 0): () => Promise<T> {
  return () =>
    new Promise<T>((resolve) => {
      if (delayMs === 0) resolve(value);
      else setTimeout(() => resolve(value), delayMs);
    });
}

/** Create a task that rejects with `error` after `delayMs`. */
function makeFailingTask(error: unknown, delayMs = 0): () => Promise<never> {
  return () =>
    new Promise<never>((_, reject) => {
      if (delayMs === 0) reject(error);
      else setTimeout(() => reject(error), delayMs);
    });
}

// ---------------------------------------------------------------------------
// batchRequest()
// ---------------------------------------------------------------------------

describe('batchRequest()', () => {
  // -------------------------------------------------------------------------
  // Result ordering
  // -------------------------------------------------------------------------

  describe('result ordering', () => {
    it('returns results in input order when all tasks succeed', async () => {
      const tasks = [makeTask('a'), makeTask('b'), makeTask('c')];
      const results = await batchRequest(tasks);

      expect(results).toHaveLength(3);
      expect(results[0]).toEqual({ status: 'fulfilled', value: 'a' });
      expect(results[1]).toEqual({ status: 'fulfilled', value: 'b' });
      expect(results[2]).toEqual({ status: 'fulfilled', value: 'c' });
    });

    it('preserves input order even when tasks finish out of order', async () => {
      jest.useFakeTimers();

      // task[0] is slow, task[1] is fast — but result[0] must still map to task[0]
      const tasks = [makeTask('slow', 200), makeTask('fast', 10), makeTask('medium', 100)];
      const promise = batchRequest(tasks, { concurrency: 3 });

      jest.runAllTimers();
      const results = await promise;

      expect(results[0]).toEqual({ status: 'fulfilled', value: 'slow' });
      expect(results[1]).toEqual({ status: 'fulfilled', value: 'fast' });
      expect(results[2]).toEqual({ status: 'fulfilled', value: 'medium' });

      jest.useRealTimers();
    });

    it('handles an empty task array', async () => {
      const results = await batchRequest([]);
      expect(results).toEqual([]);
    });

    it('handles a single task', async () => {
      const results = await batchRequest([makeTask(42)]);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ status: 'fulfilled', value: 42 });
    });
  });

  // -------------------------------------------------------------------------
  // Concurrency limit
  // -------------------------------------------------------------------------

  describe('concurrency limit', () => {
    it('never runs more tasks simultaneously than the concurrency cap', async () => {
      const concurrency = 3;
      const totalTasks = 9;
      let running = 0;
      let maxRunning = 0;

      const tasks = Array.from({ length: totalTasks }, (_, i) => async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        // Yield control so other tasks have a chance to start if uncapped
        await Promise.resolve();
        running--;
        return i;
      });

      await batchRequest(tasks, { concurrency });

      expect(maxRunning).toBeLessThanOrEqual(concurrency);
    });

    it('runs all tasks when concurrency >= task count', async () => {
      const called = jest.fn();
      const tasks = Array.from({ length: 4 }, () => async () => {
        called();
        return true;
      });

      await batchRequest(tasks, { concurrency: 100 });

      expect(called).toHaveBeenCalledTimes(4);
    });

    it('runs tasks sequentially when concurrency is 1', async () => {
      const order: number[] = [];
      const tasks = [0, 1, 2].map((i) => async () => {
        order.push(i);
        return i;
      });

      await batchRequest(tasks, { concurrency: 1 });

      expect(order).toEqual([0, 1, 2]);
    });

    it('defaults to running all tasks concurrently when concurrency is omitted', async () => {
      const called = jest.fn();
      const tasks = Array.from({ length: 5 }, () => async () => {
        called();
        return 1;
      });

      await batchRequest(tasks);

      expect(called).toHaveBeenCalledTimes(5);
    });
  });

  // -------------------------------------------------------------------------
  // Error isolation
  // -------------------------------------------------------------------------

  describe('error isolation', () => {
    it('marks failed tasks as rejected without affecting fulfilled ones', async () => {
      const error = new Error('rpc timeout');
      const tasks = [makeTask(1), makeFailingTask(error), makeTask(3)];
      const results = await batchRequest(tasks);

      expect(results[0]).toEqual({ status: 'fulfilled', value: 1 });
      expect(results[1]).toEqual({ status: 'rejected', reason: error });
      expect(results[2]).toEqual({ status: 'fulfilled', value: 3 });
    });

    it('captures the exact error object for each rejected task', async () => {
      const err1 = new TypeError('bad type');
      const err2 = new RangeError('out of range');
      const tasks = [makeFailingTask(err1), makeFailingTask(err2)];

      const results = await batchRequest(tasks);

      expect(results[0].status).toBe('rejected');
      expect((results[0] as any).reason).toBe(err1);
      expect(results[1].status).toBe('rejected');
      expect((results[1] as any).reason).toBe(err2);
    });

    it('does NOT abort remaining tasks when one task fails', async () => {
      const ran = jest.fn();
      const tasks = [
        makeFailingTask(new Error('first fails')),
        async () => { ran(); return 'second'; },
        async () => { ran(); return 'third'; },
      ];

      const results = await batchRequest(tasks, { concurrency: 1 });

      expect(ran).toHaveBeenCalledTimes(2); // second & third still executed
      expect(results[1]).toEqual({ status: 'fulfilled', value: 'second' });
      expect(results[2]).toEqual({ status: 'fulfilled', value: 'third' });
    });

    it('handles all tasks failing gracefully', async () => {
      const err = new Error('network error');
      const tasks = [makeFailingTask(err), makeFailingTask(err), makeFailingTask(err)];

      const results = await batchRequest(tasks);

      expect(results.every((r) => r.status === 'rejected')).toBe(true);
    });

    it('captures non-Error rejection reasons (string, object, etc.)', async () => {
      const tasks = [makeFailingTask('string error'), makeFailingTask(42)];
      const results = await batchRequest(tasks);

      expect((results[0] as any).reason).toBe('string error');
      expect((results[1] as any).reason).toBe(42);
    });
  });

  // -------------------------------------------------------------------------
  // Mixed workloads
  // -------------------------------------------------------------------------

  describe('mixed workloads', () => {
    it('handles large task arrays correctly', async () => {
      const size = 50;
      const tasks = Array.from({ length: size }, (_, i) => makeTask(i));

      const results = await batchRequest(tasks, { concurrency: 10 });

      expect(results).toHaveLength(size);
      results.forEach((r, i) => {
        expect(r).toEqual({ status: 'fulfilled', value: i });
      });
    });

    it('returns correct results for BigInt values', async () => {
      const tasks = [makeTask(100n), makeTask(200n)];
      const results = await batchRequest(tasks);

      expect(results[0]).toEqual({ status: 'fulfilled', value: 100n });
      expect(results[1]).toEqual({ status: 'fulfilled', value: 200n });
    });
  });
});

// ---------------------------------------------------------------------------
// batchRequestOrThrow()
// ---------------------------------------------------------------------------

describe('batchRequestOrThrow()', () => {
  it('returns array of values when all tasks succeed', async () => {
    const tasks = [makeTask('x'), makeTask('y'), makeTask('z')];
    const results = await batchRequestOrThrow(tasks);

    expect(results).toEqual(['x', 'y', 'z']);
  });

  it('throws AggregateError when any task fails', async () => {
    const tasks = [makeTask(1), makeFailingTask(new Error('oops')), makeTask(3)];

    await expect(batchRequestOrThrow(tasks)).rejects.toBeInstanceOf(AggregateError);
  });

  it('AggregateError message includes failure count', async () => {
    const tasks = [makeFailingTask('e1'), makeFailingTask('e2'), makeTask('ok')];

    await expect(batchRequestOrThrow(tasks)).rejects.toThrow('2 of 3 tasks failed');
  });

  it('AggregateError errors array contains all rejection reasons', async () => {
    const err1 = new Error('first');
    const err2 = new Error('second');
    const tasks = [makeFailingTask(err1), makeTask('mid'), makeFailingTask(err2)];

    try {
      await batchRequestOrThrow(tasks);
      fail('expected to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AggregateError);
      const agg = e as AggregateError;
      expect(agg.errors).toContain(err1);
      expect(agg.errors).toContain(err2);
      expect(agg.errors).toHaveLength(2);
    }
  });

  it('returns values in input order', async () => {
    const tasks = [makeTask(10), makeTask(20), makeTask(30)];
    const results = await batchRequestOrThrow(tasks);

    expect(results).toEqual([10, 20, 30]);
  });
});

// ---------------------------------------------------------------------------
// batchCall()
// ---------------------------------------------------------------------------

describe('batchCall()', () => {
  it('DEFAULT_BATCH_CONCURRENCY is 5', () => {
    expect(DEFAULT_BATCH_CONCURRENCY).toBe(5);
  });

  it('returns results in input order for successful calls', async () => {
    const calls = [makeTask('a'), makeTask('b'), makeTask('c')];
    const results = await batchCall(calls);

    expect(results).toEqual([
      { status: 'fulfilled', value: 'a' },
      { status: 'fulfilled', value: 'b' },
      { status: 'fulfilled', value: 'c' },
    ]);
  });

  it('failed calls do not abort remaining calls', async () => {
    const ran = jest.fn();
    const calls = [
      makeFailingTask(new Error('oops')),
      async () => { ran(); return 'ok'; },
    ];

    const results = await batchCall(calls);

    expect(ran).toHaveBeenCalledTimes(1);
    expect(results[0].status).toBe('rejected');
    expect(results[1]).toEqual({ status: 'fulfilled', value: 'ok' });
  });

  it('respects concurrency limit via options override', async () => {
    let running = 0;
    let maxRunning = 0;
    const calls = Array.from({ length: 10 }, () => async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await Promise.resolve();
      running--;
      return true;
    });

    await batchCall(calls, { concurrency: 2 });

    expect(maxRunning).toBeLessThanOrEqual(2);
  });

  it('defaults to concurrency 5 when not overridden', async () => {
    let running = 0;
    let maxRunning = 0;
    // 10 tasks each yielding once — only 5 should run simultaneously by default
    const calls = Array.from({ length: 10 }, () => async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await Promise.resolve();
      running--;
      return true;
    });

    await batchCall(calls);

    expect(maxRunning).toBeLessThanOrEqual(DEFAULT_BATCH_CONCURRENCY);
  });
});

// ---------------------------------------------------------------------------
// batchCallSequential()
// ---------------------------------------------------------------------------

describe('batchCallSequential()', () => {
  it('returns results in input order', async () => {
    const calls = [makeTask(1), makeTask(2), makeTask(3)];
    const results = await batchCallSequential(calls);

    expect(results).toEqual([
      { status: 'fulfilled', value: 1 },
      { status: 'fulfilled', value: 2 },
      { status: 'fulfilled', value: 3 },
    ]);
  });

  it('executes calls strictly in order', async () => {
    const order: number[] = [];
    const calls = [0, 1, 2].map((i) => async () => { order.push(i); return i; });

    await batchCallSequential(calls);

    expect(order).toEqual([0, 1, 2]);
  });

  it('failed calls do not abort remaining calls', async () => {
    const ran = jest.fn();
    const calls = [
      makeFailingTask(new Error('first')),
      async () => { ran(); return 'second'; },
      async () => { ran(); return 'third'; },
    ];

    const results = await batchCallSequential(calls);

    expect(ran).toHaveBeenCalledTimes(2);
    expect(results[0].status).toBe('rejected');
    expect(results[1]).toEqual({ status: 'fulfilled', value: 'second' });
    expect(results[2]).toEqual({ status: 'fulfilled', value: 'third' });
  });

  it('adds delay between calls when delayMs > 0', async () => {
    const timestamps: number[] = [];
    const delayMs = 20;
    const calls = [0, 1, 2].map(() => async () => {
      timestamps.push(Date.now());
      return true;
    });

    await batchCallSequential(calls, delayMs);

    expect(timestamps).toHaveLength(3);
    // Each call should start at least delayMs after the previous
    expect(timestamps[1] - timestamps[0]).toBeGreaterThanOrEqual(delayMs - 5);
    expect(timestamps[2] - timestamps[1]).toBeGreaterThanOrEqual(delayMs - 5);
  });

  it('handles empty array', async () => {
    const results = await batchCallSequential([]);
    expect(results).toEqual([]);
  });
});
