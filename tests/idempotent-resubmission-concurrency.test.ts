import { SorobanRpc } from '@stellar/stellar-sdk';
import {
  getTransactionStatus,
  shouldRetrySubmission,
} from '../src/utils/idempotent-resubmission';

/**
 * Concurrency proof for idempotent resubmission.
 *
 * Two callers resolve the SAME transaction hash at the same time after a
 * client-side timeout. The danger case is an *indeterminate* result (the
 * on-chain status check itself errored): if resolution ever told a caller it
 * is safe to retry on that unknown state, two racing callers could each
 * rebuild and resubmit, double-executing the operation.
 *
 * These tests exercise every status across two concurrent callers sharing a
 * single hash and assert that:
 *   - both callers always reach the *same* decision (consistent resolution),
 *   - a genuinely-final status (SUCCESS / FAILED) never resubmits,
 *   - NOT_FOUND (the only positively-safe state) allows a retry,
 *   - the indeterminate ERROR status blocks resubmission for BOTH callers,
 *     so no double submission can occur.
 */
describe('idempotent-resubmission concurrency (same hash, two callers)', () => {
  const TX_HASH = 'shared-timed-out-tx-hash';

  type StatusCase =
    | { label: 'SUCCESS'; resolve: unknown }
    | { label: 'FAILED'; resolve: unknown }
    | { label: 'NOT_FOUND'; resolve: unknown }
    | { label: 'ERROR'; reject: unknown };

  /**
   * A server shared by both callers. It resolves or rejects `getTransaction`
   * for every caller, with a small randomized delay so the two callers
   * genuinely interleave rather than run in lock-step.
   */
  function makeSharedServer(testCase: StatusCase): {
    server: SorobanRpc.Server;
    calls: () => number;
  } {
    let callCount = 0;
    const server = {
      getTransaction: jest.fn(async () => {
        callCount += 1;
        await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 5)));
        if (testCase.label === 'ERROR') {
          throw testCase.reject;
        }
        return testCase.resolve;
      }),
    } as unknown as SorobanRpc.Server;

    return { server, calls: () => callCount };
  }

  /**
   * Model of one caller's resubmission path: resolve the shared hash, then
   * (re)submit only if resolution says it is safe. A shared counter records
   * every actual second submission so the test can detect a double submit.
   */
  async function resolveAndMaybeResubmit(
    server: SorobanRpc.Server,
    hash: string,
    submissions: { count: number },
  ) {
    const status = await getTransactionStatus(server, hash);
    const decision = shouldRetrySubmission(status);
    if (decision.shouldRetry) {
      submissions.count += 1;
    }
    return { status: status.status, decision };
  }

  const cases: StatusCase[] = [
    { label: 'SUCCESS', resolve: { status: 'SUCCESS', ledger: 12345 } },
    { label: 'FAILED', resolve: { status: 'FAILED', ledger: 12345 } },
    { label: 'NOT_FOUND', resolve: { status: 'NOT_FOUND' } },
    { label: 'ERROR', reject: new Error('rpc unavailable') },
  ];

  it.each(cases)(
    'resolves the same hash consistently for both callers on $label',
    async (testCase) => {
      const { server } = makeSharedServer(testCase);
      const submissions = { count: 0 };

      const [callerA, callerB] = await Promise.all([
        resolveAndMaybeResubmit(server, TX_HASH, submissions),
        resolveAndMaybeResubmit(server, TX_HASH, submissions),
      ]);

      expect(callerA.status).toBe(testCase.label);
      expect(callerB.status).toBe(testCase.label);
      expect(callerA.decision.shouldRetry).toBe(callerB.decision.shouldRetry);

      if (testCase.label === 'NOT_FOUND') {
        expect(callerA.decision.shouldRetry).toBe(true);
        expect(submissions.count).toBe(2);
      } else {
        expect(callerA.decision.shouldRetry).toBe(false);
        expect(submissions.count).toBe(0);
      }
    },
  );

  it('never double-submits when two callers race on an indeterminate (ERROR) status', async () => {
    const { server } = makeSharedServer({ label: 'ERROR', reject: new Error('connection reset') });
    const submissions = { count: 0 };

    const results = await Promise.all(
      Array.from({ length: 2 }, () =>
        resolveAndMaybeResubmit(server, TX_HASH, submissions),
      ),
    );

    for (const result of results) {
      expect(result.status).toBe('ERROR');
      expect(result.decision.shouldRetry).toBe(false);
      expect(result.decision.reason).toContain('indeterminate');
    }

    expect(submissions.count).toBe(0);
  });
});
