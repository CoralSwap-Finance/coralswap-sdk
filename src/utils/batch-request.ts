/**
 * Concurrent batch request processor.
 *
 * Executes an array of async tasks with a configurable concurrency cap.
 * Each task runs independently — a failure in one task does NOT abort
 * the others (error isolation).  Results are returned in the same order
 * as the input array, regardless of completion order.
 */

export interface BatchRequestOptions {
  /**
   * Maximum number of tasks that may run simultaneously.
   * Defaults to the length of the task array (i.e. all at once).
   */
  concurrency?: number;
}

export type BatchResult<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown };

/**
 * Run `tasks` with at most `options.concurrency` running in parallel.
 *
 * @param tasks  - Array of zero-argument async factory functions.
 * @param options - Optional configuration (concurrency limit).
 * @returns Array of `BatchResult` objects in input order.
 *
 * @example
 * const results = await batchRequest(
 *   tokens.map(t => () => fetchPrice(t)),
 *   { concurrency: 5 },
 * );
 * results.forEach((r, i) => {
 *   if (r.status === 'fulfilled') console.log(tokens[i], r.value);
 *   else console.error(tokens[i], r.reason);
 * });
 */
export async function batchRequest<T>(
  tasks: Array<() => Promise<T>>,
  options: BatchRequestOptions = {},
): Promise<BatchResult<T>[]> {
  const concurrency = Math.max(1, options.concurrency ?? (tasks.length || 1));
  const results: BatchResult<T>[] = new Array(tasks.length);

  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      const index = nextIndex++;
      try {
        results[index] = { status: 'fulfilled', value: await tasks[index]() };
      } catch (err) {
        results[index] = { status: 'rejected', reason: err };
      }
    }
  }

  // Spin up `concurrency` worker coroutines; each worker picks up tasks
  // until the queue is empty.
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrency, tasks.length); i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results;
}

/**
 * Convenience wrapper that returns only the fulfilled values, throwing if
 * any task failed.  Use `batchRequest` directly for partial-failure handling.
 *
 * @throws {AggregateError} if one or more tasks failed.
 */
export async function batchRequestOrThrow<T>(
  tasks: Array<() => Promise<T>>,
  options: BatchRequestOptions = {},
): Promise<T[]> {
  const results = await batchRequest(tasks, options);
  const errors = results
    .filter((r): r is Extract<BatchResult<T>, { status: 'rejected' }> => r.status === 'rejected')
    .map((r) => r.reason);

  if (errors.length > 0) {
    throw new AggregateError(errors, `${errors.length} of ${tasks.length} tasks failed`);
  }

  return results.map((r) => (r as Extract<BatchResult<T>, { status: 'fulfilled' }>).value);
}
