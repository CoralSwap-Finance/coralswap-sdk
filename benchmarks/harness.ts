import { performance } from 'node:perf_hooks';
import os from 'node:os';
import type {
  BenchmarkMemoryMetrics,
  BenchmarkOperation,
  BenchmarkReport,
  BenchmarkResult,
} from './types';

export interface HarnessConfig {
  rpcLatencyMs: number;
  iterations: number;
  varianceTargetPercent: number;
}

const DEFAULT_CONFIG: HarnessConfig = {
  rpcLatencyMs: 5,
  iterations: 50,
  varianceTargetPercent: 10,
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function stddev(values: number[], avg: number): number {
  if (values.length === 0) return 0;
  const variance =
    values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function snapshotMemory(): BenchmarkMemoryMetrics {
  const mem = process.memoryUsage();
  return {
    heap_used_bytes: Math.round(mem.heapUsed),
    rss_bytes: Math.round(mem.rss),
    external_bytes: Math.round(mem.external),
  };
}

async function timeOnce(fn: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

/**
 * Run a single benchmark operation and collect latency + memory metrics.
 */
export async function runBenchmark(
  operation: BenchmarkOperation,
  config: HarnessConfig,
): Promise<BenchmarkResult> {
  const latencies: number[] = [];

  let coldStartMs = 0;
  if (operation.coldStart !== false) {
    coldStartMs = await timeOnce(operation.run);
  }

  for (let i = 0; i < config.iterations; i++) {
    latencies.push(await timeOnce(operation.run));
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const avg = mean(latencies);
  const memory = snapshotMemory();

  return {
    name: operation.name,
    group: operation.group,
    unit: 'milliseconds',
    cold_start_ms: round(coldStartMs),
    avg_latency_ms: round(avg),
    p99_latency_ms: round(percentile(sorted, 99)),
    min_latency_ms: round(sorted[0] ?? 0),
    max_latency_ms: round(sorted[sorted.length - 1] ?? 0),
    stddev_ms: round(stddev(latencies, avg)),
    iterations: config.iterations,
    memory,
  };
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Execute all benchmark operations and assemble a CI-ready JSON report.
 */
export async function runAllBenchmarks(
  operations: BenchmarkOperation[],
  partialConfig: Partial<HarnessConfig> = {},
): Promise<BenchmarkReport> {
  const config: HarnessConfig = { ...DEFAULT_CONFIG, ...partialConfig };
  const results: BenchmarkResult[] = [];

  for (const operation of operations) {
    results.push(await runBenchmark(operation, config));
  }

  return {
    schema_version: '1.0',
    tool: 'coralswap-sdk-benchmarks',
    timestamp: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
    },
    config: {
      rpc_latency_ms: config.rpcLatencyMs,
      iterations: config.iterations,
      variance_target_percent: config.varianceTargetPercent,
    },
    results,
  };
}

export function parseConfigFromEnv(): Partial<HarnessConfig> {
  const rpcLatencyMs = parseInt(process.env.BENCHMARK_RPC_LATENCY_MS ?? '5', 10);
  const iterations = parseInt(process.env.BENCHMARK_ITERATIONS ?? '50', 10);
  const varianceTargetPercent = parseInt(
    process.env.BENCHMARK_VARIANCE_TARGET ?? '10',
    10,
  );

  return {
    rpcLatencyMs: Number.isFinite(rpcLatencyMs) ? rpcLatencyMs : 5,
    iterations: Number.isFinite(iterations) ? iterations : 50,
    varianceTargetPercent: Number.isFinite(varianceTargetPercent)
      ? varianceTargetPercent
      : 10,
  };
}
