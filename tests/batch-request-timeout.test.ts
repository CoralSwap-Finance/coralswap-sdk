import { describe, it, expect, beforeEach } from 'vitest';
import { batchRequest, batchRequestOrThrow, batchCall } from '@/utils/batch-request';

describe('batchRequest with taskTimeoutMs', () => {
  describe('without timeout', () => {
    it('completes normal tasks', async () => {
      const tasks = [
        () => Promise.resolve(1),
        () => Promise.resolve(2),
        () => Promise.resolve(3),
      ];

      const results = await batchRequest(tasks);
      expect(results).toHaveLength(3);
      expect(results[0]).toEqual({ status: 'fulfilled', value: 1 });
      expect(results[1]).toEqual({ status: 'fulfilled', value: 2 });
      expect(results[2]).toEqual({ status: 'fulfilled', value: 3 });
    });

    it('captures failures without aborting others', async () => {
      const tasks = [
        () => Promise.resolve(1),
        () => Promise.reject(new Error('Task 2 failed')),
        () => Promise.resolve(3),
      ];

      const results = await batchRequest(tasks);
      expect(results[0]).toEqual({ status: 'fulfilled', value: 1 });
      expect(results[1].status).toBe('rejected');
      expect(results[2]).toEqual({ status: 'fulfilled', value: 3 });
    });
  });

  describe('with taskTimeoutMs', () => {
    it('rejects tasks that exceed timeout', async () => {
      const tasks = [
        () => Promise.resolve(1),
        () => new Promise((resolve) => setTimeout(() => resolve(2), 500)),
        () => Promise.resolve(3),
      ];

      const results = await batchRequest(tasks, { taskTimeoutMs: 100 });
      expect(results[0]).toEqual({ status: 'fulfilled', value: 1 });
      expect(results[1].status).toBe('rejected');
      expect(results[1].reason).toBeInstanceOf(Error);
      expect((results[1].reason as Error).message).toContain('Task timeout after 100ms');
      expect(results[2]).toEqual({ status: 'fulfilled', value: 3 });
    });

    it('allows tasks that complete before timeout', async () => {
      const tasks = [
        () => new Promise((resolve) => setTimeout(() => resolve(1), 10)),
        () => new Promise((resolve) => setTimeout(() => resolve(2), 20)),
        () => new Promise((resolve) => setTimeout(() => resolve(3), 30)),
      ];

      const results = await batchRequest(tasks, { taskTimeoutMs: 100 });
      expect(results[0]).toEqual({ status: 'fulfilled', value: 1 });
      expect(results[1]).toEqual({ status: 'fulfilled', value: 2 });
      expect(results[2]).toEqual({ status: 'fulfilled', value: 3 });
    });

    it('respects concurrency with timeout', async () => {
      let concurrent = 0;
      let maxConcurrent = 0;

      const tasks = Array(6)
        .fill(null)
        .map((_, i) => () => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          return new Promise<number>((resolve) => {
            setTimeout(() => {
              concurrent--;
              resolve(i);
            }, 50);
          });
        });

      const results = await batchRequest(tasks, { concurrency: 2, taskTimeoutMs: 1000 });
      expect(maxConcurrent).toBeLessThanOrEqual(2);
      expect(results).toHaveLength(6);
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    });

    it('returns error reason as Error object', async () => {
      const tasks = [
        () => new Promise((resolve) => setTimeout(() => resolve(1), 1000)),
      ];

      const results = await batchRequest(tasks, { taskTimeoutMs: 50 });
      expect(results[0].status).toBe('rejected');
      const reason = results[0].reason as any;
      expect(reason).toBeInstanceOf(Error);
      expect(reason.message).toMatch(/Task timeout after 50ms/);
    });
  });

  describe('batchRequestOrThrow with timeout', () => {
    it('throws AggregateError when tasks timeout', async () => {
      const tasks = [
        () => Promise.resolve(1),
        () => new Promise((resolve) => setTimeout(() => resolve(2), 500)),
      ];

      await expect(
        batchRequestOrThrow(tasks, { taskTimeoutMs: 100 }),
      ).rejects.toThrow(AggregateError);
    });

    it('returns values when all tasks complete', async () => {
      const tasks = [
        () => Promise.resolve(1),
        () => Promise.resolve(2),
        () => Promise.resolve(3),
      ];

      const results = await batchRequestOrThrow(tasks, { taskTimeoutMs: 1000 });
      expect(results).toEqual([1, 2, 3]);
    });
  });

  describe('batchCall with timeout', () => {
    it('applies default concurrency with timeout', async () => {
      const tasks = Array(10)
        .fill(null)
        .map((_, i) => () => Promise.resolve(i));

      const results = await batchCall(tasks, { taskTimeoutMs: 1000 });
      expect(results).toHaveLength(10);
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    });

    it('respects taskTimeoutMs parameter', async () => {
      const tasks = [
        () => Promise.resolve(1),
        () => new Promise((resolve) => setTimeout(() => resolve(2), 500)),
      ];

      const results = await batchCall(tasks, { taskTimeoutMs: 100 });
      expect(results[0]).toEqual({ status: 'fulfilled', value: 1 });
      expect(results[1].status).toBe('rejected');
    });
  });
});
