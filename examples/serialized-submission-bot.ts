/**
 * Serialized-Submission Bot — CoralSwap SDK example
 *
 * The canonical pattern for a long-running bot that submits CoralSwap
 * transactions safely. Three guardrails work together:
 *
 * 1. **Quota-limited** — a sliding-window limiter caps how many submissions the
 *    bot can fire per minute. Every actual submission attempt — including
 *    retries — draws a permit, so the bot can never flood the RPC endpoint.
 *
 * 2. **Sequence-serialized** — a per-account async mutex guarantees that only
 *    one `submitTransaction()` is in flight at a time. `submitTransaction()`
 *    reads the account's current sequence number when it picks up the account,
 *    so two concurrent submissions for the same account can both read the same
 *    sequence. The second one then becomes a "bad sequence" transaction and is
 *    rejected on-chain. Serializing submissions per account eliminates that
 *    race entirely.
 *
 * 3. **Retry-with-status-check loop** — after each submission the bot checks
 *    the transaction status before deciding what to do next. A transaction that
 *    timed out locally may still land, so the bot probes the chain (rather than
 *    blindly re-submitting the same hash, which could double-execute). When a
 *    retry is safe, it re-builds and re-submits, which naturally picks up a
 *    fresh sequence number.
 *
 * The bot runs N swap jobs concurrently to demonstrate the mutex at work:
 * all jobs race to submit, but the per-account mutex queues them so each
 * submission observes the correct next sequence number.
 *
 * Run:   npm run examples:serialized-submission-bot
 *        (copy `.env.example` to `.env` first — see examples/README.md)
 */

import 'dotenv/config';
import { Network, TradeType } from '../src/types/common';
import { CoralSwapClient } from '../src/client';
import { SwapModule } from '../src/modules/swap';
import { xdr } from '@stellar/stellar-sdk';

// Canonical testnet tokens (USD Coin and a deJTRSY T-bill token). Override via
// CORALSWAP_TOKEN_A / CORALSWAP_TOKEN_B / CORALSWAP_RWA_TOKEN in `.env`.
const USDC_TESTNET = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const DEJTRSY_TESTNET =
  process.env.CORALSWAP_RWA_TOKEN ??
  'CDCYWK73YTYFJZZSJ5V7EDFNHYBG4GAQV2RKQXF4UDZ2KXHZSTLKL2C';

const QUOTA_WINDOW_MS = 60_000; // one minute

/**
 * A minimal async mutex (FIFO lock).
 *
 * This is the "sequence mutex": it wraps everything that needs to observe a
 * consistent account sequence number (fetch account -> build -> simulate ->
 * sign -> submit -> confirm) inside a critical section scoped to one account.
 * If the SDK ever exposes a client-level sequence mutex, replace this class
 * with a call to that mutex — the rest of the pattern stays the same.
 */
class SequenceMutex {
  /** The tail of the queue; every call chains onto it. */
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * Run `fn` once every previously queued callback has finished.
   * FIFO ordering keeps submissions for the same account strictly serial.
   */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous.then(() =>
      fn().finally(() => {
        release();
      }),
    );
  }
}

/**
 * Sliding-window quota limiter.
 *
 * Allows at most `maxPerWindow` acquisitions per `windowMs`. Combined with
 * `waitMsUntilNext()`, the bot can *wait* for a permit instead of failing,
 * which keeps the retry loop alive during busy windows.
 */
class QuotaLimiter {
  /** Timestamps (ms) of recent acquisitions, oldest first. */
  private readonly attempts: number[] = [];

  constructor(
    private readonly maxPerWindow: number,
    private readonly windowMs: number,
  ) {}

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.attempts.length > 0 && this.attempts[0] <= cutoff) {
      this.attempts.shift();
    }
  }

  /**
   * Attempt to acquire a permit without blocking.
   * @returns `true` when a permit was granted, `false` when the quota is full.
   */
  tryAcquire(now: number = Date.now()): boolean {
    this.prune(now);
    if (this.attempts.length >= this.maxPerWindow) return false;
    this.attempts.push(now);
    return true;
  }

  /** Milliseconds to wait until the next permit frees up (0 = available). */
  waitMsUntilNext(now: number = Date.now()): number {
    this.prune(now);
    if (this.attempts.length < this.maxPerWindow) return 0;
    return Math.max(0, this.attempts[0] + this.windowMs - now);
  }
}

interface BotConfig {
  /** Number of swap jobs to dispatch (run concurrently under the mutex). */
  iterations: number;
  /** Max submissions — including retries — per minute. */
  maxPerMinute: number;
  /** Max retry attempts per job after a failed/timeouted submission. */
  maxRetries: number;
  /** Base backoff delay between retries (grows linearly per attempt). */
  retryBackoffMs: number;
  /** Swap amount in token units (7-decimal precision for testnet tokens). */
  amount: bigint;
  tokenIn: string;
  tokenOut: string;
  /** When true, simulate each job instead of submitting to the network. */
  dryRun: boolean;
}

interface JobOutcome {
  jobId: number;
  status: 'SUCCESS' | 'FAILED' | 'TIMEOUT';
  txHash?: string;
  attempts: number;
  lastError?: string;
}

interface SubmitOutcome {
  success: boolean;
  txHash?: string;
  errorCode?: string;
  errorMessage?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatAmount(amount: bigint, decimals: number = 7): string {
  const divisor = BigInt(10 ** decimals);
  return `${amount / divisor}.${(amount % divisor).toString().padStart(decimals, '0')}`;
}

/**
 * Single submission attempt. The caller is responsible for holding the
 * per-account mutex and a quota permit while this runs.
 */
async function submitOnce(
  client: CoralSwapClient,
  op: xdr.Operation,
  dryRun: boolean,
): Promise<SubmitOutcome> {
  if (dryRun) {
    const sim = await client.simulateTransaction([op], {});
    return {
      success: sim.success,
      errorCode: sim.success ? undefined : 'SIMULATION_FAILED',
      errorMessage: sim.success ? undefined : sim.error ?? 'Simulation failed',
    };
  }

  const result = await client.submitTransaction([op]);
  return {
    success: result.success,
    txHash: result.txHash,
    errorCode: result.error?.code,
    errorMessage: result.error?.message,
  };
}

/** Probe the chain for a submitted transaction's status. */
async function checkTxStatus(
  client: CoralSwapClient,
  txHash: string,
): Promise<'SUCCESS' | 'FAILED' | 'NOT_FOUND'> {
  try {
    const status = await client.server.getTransaction(txHash);
    return status.status;
  } catch {
    // Transient RPC error: treat as not-yet-visible so the caller re-checks.
    return 'NOT_FOUND';
  }
}

/**
 * Decide whether it is safe to retry a failed submission.
 *
 * `TxStatus.TX_FAILED` means the transaction was executed and rejected
 * on-chain (e.g. `tx_bad_seq` after a race elsewhere), so re-submitting the
 * same hash would be pointless — but *re-building* the transaction with a
 * fresh sequence number is exactly what the retry does. Production bots should
 * inspect `details.status` (e.g. `tx_bad_seq`) to pick a targeted response.
 */
function isRetryable(errorCode?: string): boolean {
  switch (errorCode) {
    case undefined:
    case 'SIMULATION_FAILED':
    case 'SUBMIT_FAILED':
    case 'TX_FAILED':
    case 'TX_TIMEOUT':
    case 'UNEXPECTED_ERROR':
      return true;
    default:
      return false;
  }
}

/**
 * Execute one swap job with the full guardrail stack:
 *
 *   quota gate -> (mutex + submit) -> status check -> backoff -> retry
 */
async function runSwapJob(
  jobId: number,
  client: CoralSwapClient,
  swapModule: SwapModule,
  mutex: SequenceMutex,
  quota: QuotaLimiter,
  config: BotConfig,
): Promise<JobOutcome> {
  // Quote and build the operation once, outside the critical section.
  const quote = await swapModule.getQuote({
    tokenIn: config.tokenIn,
    tokenOut: config.tokenOut,
    amount: config.amount,
    tradeType: TradeType.EXACT_IN,
  });
  const op = client.router.buildSwapExactIn(
    client.publicKey,
    config.tokenIn,
    config.tokenOut,
    quote.amountIn,
    quote.amountOutMin,
    quote.deadline,
  );

  console.log(
    `[job ${jobId}] Swapping ${formatAmount(config.amount)} ${config.tokenIn} -> ${config.tokenOut}` +
      (config.dryRun ? ' (DRY RUN — simulated only)' : ''),
  );

  let attempts = 0;

  while (attempts <= config.maxRetries) {
    attempts += 1;

    // --- 1. Quota gate: wait for a permit instead of spiking the RPC. -------
    const waitMs = quota.waitMsUntilNext();
    if (waitMs > 0) {
      console.log(
        `[job ${jobId}] Quota exhausted — waiting ${Math.round(waitMs / 1000)}s for the next permit`,
      );
      await sleep(waitMs);
    }
    if (!quota.tryAcquire()) continue; // another job took the slot; re-check

    // --- 2. Submit inside the per-account sequence mutex. -------------------
    // Holding the mutex for the whole call (including confirmation polling)
    // guarantees each submission reads a fresh, unconsumed sequence number.
    const outcome = await mutex.runExclusive(() =>
      submitOnce(client, op, config.dryRun),
    );

    if (outcome.success) {
      console.log(
        `[job ${jobId}] ✅ Submission ${attempts === 1 ? 'succeeded' : 'succeeded on retry'} on attempt ${attempts}` +
          (outcome.txHash ? ` — tx ${outcome.txHash}` : ''),
      );
      return {
        jobId,
        status: 'SUCCESS',
        txHash: outcome.txHash,
        attempts,
      };
    }

    // --- 3. Status check before retrying. -----------------------------------
    // A locally timed-out transaction may still have landed. Probe the chain
    // first: if it confirmed, the job is done; only re-submit when the chain
    // has no record of it (or unequivocally failed it).
    if (outcome.txHash) {
      const chainStatus = await checkTxStatus(client, outcome.txHash);
      if (chainStatus === 'SUCCESS') {
        console.log(
          `[job ${jobId}] ✅ Confirmed on-chain after local timeout — tx ${outcome.txHash}`,
        );
        return { jobId, status: 'SUCCESS', txHash: outcome.txHash, attempts };
      }
      console.log(
        `[job ${jobId}] ⚠️  Chain status for ${outcome.txHash}: ${chainStatus}`,
      );
    }

    const errorCode = outcome.errorCode ?? 'UNKNOWN';
    const lastError = outcome.errorMessage ?? 'Unknown submission error';

    if (!isRetryable(errorCode) || attempts > config.maxRetries) {
      console.error(`[job ${jobId}] ❌ Giving up after ${attempts} attempt(s): ${lastError}`);
      return { jobId, status: 'FAILED', attempts, lastError };
    }

    const backoff = config.retryBackoffMs * attempts;
    console.log(
      `[job ${jobId}] 🔁 Attempt ${attempts} failed (${errorCode}: ${lastError}) — retrying in ${Math.round(backoff / 1000)}s with a fresh sequence`,
    );
    await sleep(backoff);
  }

  return { jobId, status: 'TIMEOUT', attempts };
}

function readConfig(): BotConfig {
  const iterations = Number(process.env.CORALSWAP_BOT_ITERATIONS ?? 3);
  const maxPerMinute = Number(process.env.CORALSWAP_BOT_MAX_PER_MINUTE ?? 4);
  const maxRetries = Number(process.env.CORALSWAP_BOT_MAX_RETRIES ?? 3);
  const retryBackoffMs = Number(process.env.CORALSWAP_BOT_RETRY_BACKOFF_MS ?? 5000);
  const dryRun =
    (process.env.CORALSWAP_BOT_DRY_RUN ?? 'false').toLowerCase() === 'true';

  return {
    iterations: Number.isFinite(iterations) && iterations > 0 ? iterations : 3,
    maxPerMinute: Number.isFinite(maxPerMinute) && maxPerMinute > 0 ? maxPerMinute : 4,
    maxRetries: Number.isFinite(maxRetries) && maxRetries >= 0 ? maxRetries : 3,
    retryBackoffMs:
      Number.isFinite(retryBackoffMs) && retryBackoffMs >= 0 ? retryBackoffMs : 5000,
    amount: BigInt(process.env.CORALSWAP_SWAP_AMOUNT ?? '100000000'), // 10 USDC (7 dp)
    tokenIn: process.env.CORALSWAP_TOKEN_A ?? USDC_TESTNET,
    tokenOut: process.env.CORALSWAP_TOKEN_B ?? DEJTRSY_TESTNET,
    dryRun,
  };
}

async function main(): Promise<void> {
  const secretKey = process.env.CORALSWAP_SECRET_KEY;
  const publicKey = process.env.CORALSWAP_PUBLIC_KEY;
  if (!secretKey || !publicKey) {
    console.error(
      'Missing required environment variables (CORALSWAP_SECRET_KEY, CORALSWAP_PUBLIC_KEY). ' +
        'Copy .env.example to .env and fill in the values.',
    );
    process.exit(1);
  }

  const config = readConfig();
  const network =
    (process.env.CORALSWAP_NETWORK ?? 'testnet') === 'mainnet'
      ? Network.MAINNET
      : Network.TESTNET;
  const rpcUrl = process.env.CORALSWAP_RPC_URL;

  const client = new CoralSwapClient({
    network,
    ...(rpcUrl ? { rpcUrl } : {}),
    secretKey,
    publicKey,
  });

  // This SDK build ships without hardcoded deployment addresses, so the bot
  // accepts them via env (same override the SDK's own tests use). Keep them in
  // sync with the CoralSwap deployment you are targeting.
  if (process.env.CORALSWAP_FACTORY_ADDRESS) {
    client.networkConfig.factoryAddress = process.env.CORALSWAP_FACTORY_ADDRESS;
  }
  if (process.env.CORALSWAP_ROUTER_ADDRESS) {
    client.networkConfig.routerAddress = process.env.CORALSWAP_ROUTER_ADDRESS;
  }

  const swapModule = new SwapModule(client);
  const mutex = new SequenceMutex();
  const quota = new QuotaLimiter(config.maxPerMinute, QUOTA_WINDOW_MS);

  console.log('Serialized-submission bot');
  console.log('-------------------------');
  console.log(`  Account:      ${client.publicKey}`);
  console.log(`  Network:      ${network}`);
  console.log(`  Jobs:         ${config.iterations} (submitted concurrently)`);
  console.log(`  Quota:        ${config.maxPerMinute} submissions/minute`);
  console.log(`  Max retries:  ${config.maxRetries}/job`);
  console.log(`  Dry run:      ${config.dryRun}`);
  console.log('');

  // Dispatch all jobs at once: they race for the mutex, which serializes their
  // submissions so each one sees the correct account sequence number.
  const jobIds = Array.from({ length: config.iterations }, (_, i) => i + 1);
  const outcomes = await Promise.all(
    jobIds.map((jobId) =>
      runSwapJob(jobId, client, swapModule, mutex, quota, config),
    ),
  );

  const succeeded = outcomes.filter((o) => o.status === 'SUCCESS').length;
  console.log('\nSummary');
  console.log('-------');
  for (const outcome of outcomes) {
    console.log(
      `  Job ${outcome.jobId}: ${outcome.status}${outcome.txHash ? ` (${outcome.txHash})` : ''}` +
        (outcome.lastError ? ` — ${outcome.lastError}` : ''),
    );
  }
  console.log(`\n${succeeded}/${outcomes.length} jobs completed successfully.`);
  if (config.dryRun) {
    console.log('No transactions were submitted (dry run). Set CORALSWAP_BOT_DRY_RUN=false to submit.');
  }
}

main().catch((err) => {
  console.error('Error running serialized-submission bot:', err);
  process.exit(1);
});