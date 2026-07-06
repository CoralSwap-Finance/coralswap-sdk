#!/usr/bin/env ts-node
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createModuleContext, TOKEN_A, TOKEN_B, TOKEN_C, PAIR_AB, OWNER, SWAP_AMOUNT } from './fixtures';
import { TradeType } from '../src/types/common';
import { AlertModule } from '../src/modules/alerts';
import { RateLimiter } from '../src/utils/rate-limiter';

const CONFIG = {
  concurrentUsers: 50,
  rampUpMs: 5_000,
  durationMs: 60_000,
  rpcLatencyMs: 10,
  thinkTimeMs: { min: 20, max: 100 },
  rateLimitCapacity: 100,
  rateLimitRefillMs: 1_000,
  rateLimitRefillRate: 10,
};

const OPERATION_WEIGHTS = {
  swapQuote: 0.35,
  swapMultiHop: 0.15,
  portfolioQuery: 0.25,
  alertCheck: 0.25,
};

type OpType = keyof typeof OPERATION_WEIGHTS;

interface OperationResult {
  op: OpType | 'rate_limiter_wait';
  latencyMs: number;
  success: boolean;
  error?: string;
  timestamp: number;
}

interface MemorySnapshot {
  timestamp: number;
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
}

interface PhaseReport {
  durationMs: number;
  opsTotal: number;
  opsSuccess: number;
  opsFailed: number;
  throughputOpsSec: number;
  errorRatePct: number;
  latencyMs: {
    min: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
    avg: number;
  };
  opBreakdown: Record<string, { count: number; errors: number; latencyAvgMs: number }>;
}

interface ScenarioReport {
  withoutRateLimiter: { opsSec: number; errorRatePct: number };
  withRateLimiter: { opsSec: number; errorRatePct: number };
}

interface LoadTestReport {
  schema_version: '1.0';
  tool: 'coralswap-sdk-load-test';
  timestamp: string;
  config: typeof CONFIG;
  environment: { node: string; platform: string; arch: string; cpus: number };
  phases: { steadyState: PhaseReport };
  memory: { baselineMb: number; peakMb: number; finalMb: number; growthMb: number };
  rateLimitScenario?: ScenarioReport;
  findings: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function weightedChoice<T extends string>(weights: Record<T, number>): T {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (const [key, weight] of Object.entries(weights)) {
    r -= weight as number;
    if (r <= 0) return key as T;
  }
  return Object.keys(weights)[0] as T;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function snapshotMemory(): MemorySnapshot {
  const mem = process.memoryUsage();
  return {
    timestamp: Date.now(),
    heapUsed: Math.round(mem.heapUsed),
    heapTotal: Math.round(mem.heapTotal),
    rss: Math.round(mem.rss),
    external: Math.round(mem.external),
  };
}

async function virtualUser(
  ctx: ReturnType<typeof createModuleContext>,
  alerts: AlertModule,
  rateLimiter: RateLimiter | null,
  config: typeof CONFIG,
  results: OperationResult[],
  abortSignal: () => boolean,
): Promise<void> {
  await alerts.createAlert({ type: 'price', target: PAIR_AB, threshold: 100, direction: 'below' });
  await alerts.createAlert({ type: 'il', target: PAIR_AB, threshold: 500, direction: 'above' });
  await alerts.createAlert({ type: 'health', target: PAIR_AB, threshold: 500, direction: 'above' });
  await alerts.createAlert({ type: 'volume', target: PAIR_AB, threshold: 100_000, direction: 'above' });

  while (!abortSignal()) {
    if (rateLimiter) {
      await rateLimiter.acquire();
    }

    const opType = weightedChoice<OpType>(OPERATION_WEIGHTS);
    const start = performance.now();
    let success = false;
    let errorMsg: string | undefined;

    try {
      switch (opType) {
        case 'swapQuote':
          await ctx.swap.getQuote({
            tokenIn: TOKEN_A,
            tokenOut: TOKEN_B,
            amount: SWAP_AMOUNT,
            tradeType: TradeType.EXACT_IN,
          });
          break;
        case 'swapMultiHop':
          await ctx.swap.getQuote({
            tokenIn: TOKEN_A,
            tokenOut: TOKEN_C,
            amount: SWAP_AMOUNT,
            tradeType: TradeType.EXACT_IN,
            path: [TOKEN_A, TOKEN_B, TOKEN_C],
          });
          break;
        case 'portfolioQuery':
          await ctx.positions.getPositions(OWNER, { pairAddresses: [PAIR_AB], includeEmpty: false });
          break;
        case 'alertCheck':
          await alerts.checkAlerts(PAIR_AB);
          break;
      }
      success = true;
    } catch (err) {
      errorMsg = err instanceof Error ? err.message.slice(0, 120) : String(err);
    }

    results.push({
      op: opType,
      latencyMs: performance.now() - start,
      success,
      error: success ? undefined : errorMsg,
      timestamp: Date.now(),
    });

    if (!abortSignal()) {
      await sleep(randomInt(config.thinkTimeMs.min, config.thinkTimeMs.max));
    }
  }
}

async function runPhase(
  durationMs: number,
  userCount: number,
  useRateLimiter: boolean,
  config: typeof CONFIG,
): Promise<PhaseReport> {
  const ctx = createModuleContext(config.rpcLatencyMs);
  const alerts = new AlertModule(ctx.client);
  const rateLimiter = useRateLimiter
    ? new RateLimiter({ capacity: config.rateLimitCapacity, refillRate: config.rateLimitRefillRate, refillIntervalMs: config.rateLimitRefillMs })
    : null;

  const results: OperationResult[] = [];
  let aborted = false;
  const abortSignal = () => aborted;
  const deadline = Date.now() + durationMs;

  const userPromises: Promise<void>[] = [];
  for (let i = 0; i < userCount; i++) {
    const delay = Math.floor((i / userCount) * config.rampUpMs);
    userPromises.push(
      (async () => {
        await sleep(delay);
        return virtualUser(ctx, alerts, rateLimiter, config, results, abortSignal);
      })(),
    );
  }

  while (Date.now() < deadline) {
    await sleep(100);
  }

  aborted = true;
  await Promise.allSettled(userPromises);

  const elapsedSec = (Date.now() + durationMs - deadline) / 1000;
  if (elapsedSec <= 0) return createEmptyPhase();

  const opTypeGroups = new Map<string, { count: number; errors: number; totalLatency: number }>();
  const successLatencies: number[] = [];

  let opsSuccess = 0;
  let opsFailed = 0;

  for (const r of results) {
    if (r.success) {
      opsSuccess++;
      successLatencies.push(r.latencyMs);
    } else {
      opsFailed++;
    }

    if (!opTypeGroups.has(r.op)) {
      opTypeGroups.set(r.op, { count: 0, errors: 0, totalLatency: 0 });
    }
    const g = opTypeGroups.get(r.op)!;
    g.count++;
    if (!r.success) g.errors++;
    if (r.success) g.totalLatency += r.latencyMs;
  }

  const sorted = [...successLatencies].sort((a, b) => a - b);
  const opBreakdown: Record<string, { count: number; errors: number; latencyAvgMs: number }> = {};

  for (const [op, g] of opTypeGroups) {
    opBreakdown[op] = {
      count: g.count,
      errors: g.errors,
      latencyAvgMs: g.count > g.errors ? Math.round((g.totalLatency / (g.count - g.errors)) * 100) / 100 : 0,
    };
  }

  return {
    durationMs,
    opsTotal: opsSuccess + opsFailed,
    opsSuccess,
    opsFailed,
    throughputOpsSec: elapsedSec > 0 ? Math.round((opsSuccess / elapsedSec) * 100) / 100 : 0,
    errorRatePct: (opsSuccess + opsFailed) > 0 ? Math.round((opsFailed / (opsSuccess + opsFailed)) * 10000) / 100 : 0,
    latencyMs: {
      min: sorted.length > 0 ? Math.round(sorted[0] * 100) / 100 : 0,
      p50: Math.round(percentile(sorted, 50) * 100) / 100,
      p95: Math.round(percentile(sorted, 95) * 100) / 100,
      p99: Math.round(percentile(sorted, 99) * 100) / 100,
      max: sorted.length > 0 ? Math.round(sorted[sorted.length - 1] * 100) / 100 : 0,
      avg: Math.round(mean(sorted) * 100) / 100,
    },
    opBreakdown,
  };
}

function createEmptyPhase(): PhaseReport {
  return {
    durationMs: 0, opsTotal: 0, opsSuccess: 0, opsFailed: 0,
    throughputOpsSec: 0, errorRatePct: 0,
    latencyMs: { min: 0, p50: 0, p95: 0, p99: 0, max: 0, avg: 0 },
    opBreakdown: {},
  };
}

async function main(): Promise<void> {
  console.error(`CoralSwap SDK Load Test`);
  console.error(`=======================`);
  console.error(`  Concurrent users: ${CONFIG.concurrentUsers}`);
  console.error(`  Ramp-up:          ${CONFIG.rampUpMs}ms`);
  console.error(`  Steady-state:     ${CONFIG.durationMs}ms`);
  console.error(`  RPC latency:      ${CONFIG.rpcLatencyMs}ms`);
  console.error(`  Think time:       ${CONFIG.thinkTimeMs.min}-${CONFIG.thinkTimeMs.max}ms`);

  const memBaseline = snapshotMemory();
  console.error(`\n  Baseline heap:    ${Math.round(memBaseline.heapUsed / 1024 / 1024 * 100) / 100} MB`);

  const memSnapshots: MemorySnapshot[] = [memBaseline];
  const memMonitor = setInterval(() => {
    memSnapshots.push(snapshotMemory());
  }, 2_000);

  console.error(`\n  [Phase 1] Running ${CONFIG.concurrentUsers} concurrent users for ${CONFIG.durationMs / 1000}s...`);
  const steadyState = await runPhase(CONFIG.durationMs, CONFIG.concurrentUsers, false, CONFIG);

  console.error(`  [Phase 2] Rate limiter bottleneck scenario...`);
  const noRL = await runPhase(15_000, CONFIG.concurrentUsers, false, CONFIG);
  const withRL = await runPhase(15_000, CONFIG.concurrentUsers, true, CONFIG);

  clearInterval(memMonitor);
  const memFinal = snapshotMemory();

  const heapValues = memSnapshots.map((m) => m.heapUsed);
  const peakHeap = Math.max(...heapValues);
  const growthMb = Math.round((peakHeap - memBaseline.heapUsed) / 1024 / 1024 * 100) / 100;

  console.error(`\n  Memory summary:`);
  console.error(`    Baseline: ${Math.round(memBaseline.heapUsed / 1024 / 1024 * 100) / 100} MB`);
  console.error(`    Peak:     ${Math.round(peakHeap / 1024 / 1024 * 100) / 100} MB`);
  console.error(`    Growth:   ${growthMb} MB`);
  console.error(`    Final:    ${Math.round(memFinal.heapUsed / 1024 / 1024 * 100) / 100} MB`);

  const findings: string[] = [];
  const opsTotal = steadyState.opsTotal;

  if (opsTotal === 0) {
    findings.push('ERROR: No operations completed — test may be misconfigured.');
  } else {
    findings.push(
      `COMPLETED: ${steadyState.opsSuccess} successful ops, ${steadyState.opsFailed} failed ops ` +
      `across ${CONFIG.concurrentUsers} concurrent users without crashing.`,
    );

    if (steadyState.errorRatePct < 1) {
      findings.push(`OK: Error rate ${steadyState.errorRatePct}% is below 1% threshold.`);
    } else {
      findings.push(`FAIL: Error rate ${steadyState.errorRatePct}% exceeds 1% threshold.`);
    }
  }

  const throughputDrop = noRL.throughputOpsSec > 0
    ? Math.round((1 - withRL.throughputOpsSec / noRL.throughputOpsSec) * 10000) / 100
    : 0;

  if (throughputDrop > 30) {
    findings.push(
      `CONFIRMED: Rate limiter is a bottleneck — throughput dropped ${throughputDrop}% ` +
      `(${noRL.throughputOpsSec} → ${withRL.throughputOpsSec} ops/sec).`,
    );
  } else {
    findings.push(
      `INFO: Rate limiter reduced throughput by ${throughputDrop}% ` +
      `(${noRL.throughputOpsSec} → ${withRL.throughputOpsSec} ops/sec).`,
    );
  }

  if (growthMb > 50) {
    findings.push(`WARN: Memory grew ${growthMb} MB — possible leak. Investigate unbounded caches or listeners.`);
  } else {
    findings.push(`OK: Memory growth (${growthMb} MB) is bounded.`);
  }

  const rateLimitScenario: ScenarioReport = {
    withoutRateLimiter: { opsSec: noRL.throughputOpsSec, errorRatePct: noRL.errorRatePct },
    withRateLimiter: { opsSec: withRL.throughputOpsSec, errorRatePct: withRL.errorRatePct },
  };

  const report: LoadTestReport = {
    schema_version: '1.0',
    tool: 'coralswap-sdk-load-test',
    timestamp: new Date().toISOString(),
    config: CONFIG,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
    },
    phases: { steadyState },
    memory: {
      baselineMb: Math.round(memBaseline.heapUsed / 1024 / 1024 * 100) / 100,
      peakMb: Math.round(peakHeap / 1024 / 1024 * 100) / 100,
      finalMb: Math.round(memFinal.heapUsed / 1024 / 1024 * 100) / 100,
      growthMb,
    },
    rateLimitScenario,
    findings,
  };

  const json = JSON.stringify(report, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value, 2);

  const outputIdx = process.argv.indexOf('--output');
  if (outputIdx !== -1 && process.argv[outputIdx + 1]) {
    const resolved = path.resolve(process.argv[outputIdx + 1]);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, json, 'utf8');
    console.error(`\n  Report written to ${resolved}`);
  }

  process.stdout.write(`${json}\n`);
}

main().catch((err) => {
  process.stderr.write(`Load test failed: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
