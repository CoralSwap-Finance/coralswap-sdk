/**
 * JSON schema types for CoralSwap SDK benchmark output.
 *
 * Compatible with CI benchmark tracking tools (Bencher, GitHub Actions
 * benchmark comparators) that expect structured metric objects.
 */

export interface BenchmarkMemoryMetrics {
  heap_used_bytes: number;
  rss_bytes: number;
  external_bytes: number;
}

export interface BenchmarkResult {
  name: string;
  group: string;
  unit: 'milliseconds';
  cold_start_ms: number;
  avg_latency_ms: number;
  p99_latency_ms: number;
  min_latency_ms: number;
  max_latency_ms: number;
  stddev_ms: number;
  iterations: number;
  memory: BenchmarkMemoryMetrics;
}

export interface BenchmarkReport {
  schema_version: '1.0';
  tool: 'coralswap-sdk-benchmarks';
  timestamp: string;
  environment: Record<string, string | number>;
  config: {
    rpc_latency_ms: number;
    iterations: number;
    variance_target_percent: number;
  };
  results: BenchmarkResult[];
}

export interface BenchmarkOperation {
  name: string;
  group: string;
  run: () => Promise<unknown>;
  /** When true, a fresh execution context is created for the cold-start sample. */
  coldStart?: boolean;
}
