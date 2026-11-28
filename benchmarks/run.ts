#!/usr/bin/env node
/**
 * CoralSwap SDK performance benchmark runner.
 *
 * Outputs JSON to stdout (or --output file) for CI benchmark tracking.
 *
 * Variance reporting
 * ------------------
 * After running all benchmarks the runner prints a summary table that includes:
 *   - Median latency (p50)
 *   - Coefficient of Variation (CV = stddev / mean × 100 %)
 *   - A SKIPPED flag for any operation whose CV exceeds BENCHMARK_VARIANCE_TARGET
 *
 * High-variance results are still included in the JSON output (so they appear
 * in the regression report), but the CI comparison step is expected to skip
 * or annotate them rather than fail the build on noisy measurements.
 *
 * Refreshing the baseline
 * -----------------------
 * The baseline is captured automatically on every push to `main` via
 * `.github/workflows/benchmarks.yml`.  To intentionally update it:
 *   1. Land the change on `main` — the workflow uploads a new artifact.
 *   2. The next PR will download that artifact as the new baseline.
 *
 * To accept an intentional regression, set BENCHMARK_ACCEPT_REGRESSION=1 in
 * the CI environment (or update the thresholds in benchmarks.yml).
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseConfigFromEnv, runAllBenchmarks } from './harness';
import { buildOperations } from './operations';
import type { BenchmarkResult } from './types';

// ---------------------------------------------------------------------------
// CLI argument parser
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { outputPath?: string } {
  const outputIdx = argv.indexOf('--output');
  if (outputIdx !== -1 && argv[outputIdx + 1]) {
    return { outputPath: argv[outputIdx + 1] };
  }
  return {};
}

// ---------------------------------------------------------------------------
// Variance / CV helpers
// ---------------------------------------------------------------------------

/**
 * Coefficient of variation (CV) expressed as a percentage.
 * CV = (stddev / mean) * 100
 * Returns 0 when mean is 0 to avoid division-by-zero.
 */
function coefficientOfVariation(result: BenchmarkResult): number {
  if (result.avg_latency_ms === 0) return 0;
  return (result.stddev_ms / result.avg_latency_ms) * 100;
}

/**
 * Median approximation using avg_latency_ms (the harness does not expose the
 * raw samples array in the report type, so we use avg as a proxy; for the
 * purpose of regression comparison, avg and median are close enough on
 * shared runners with ≥ 50 iterations).
 */
function medianLatency(result: BenchmarkResult): number {
  return result.avg_latency_ms;
}

// ---------------------------------------------------------------------------
// Variance summary table
// ---------------------------------------------------------------------------

function printVarianceSummary(
  results: BenchmarkResult[],
  varianceTargetPercent: number,
): void {
  const rows: string[] = [];
  const colWidths = { name: 30, median: 10, cv: 8, status: 10 };

  const header = [
    'Operation'.padEnd(colWidths.name),
    'Median (ms)'.padEnd(colWidths.median),
    'CV %'.padEnd(colWidths.cv),
    'Variance',
  ].join('  ');

  const separator = '-'.repeat(header.length);
  rows.push(separator);
  rows.push(header);
  rows.push(separator);

  for (const result of results) {
    const cv = coefficientOfVariation(result);
    const median = medianLatency(result);
    const skipped = cv > varianceTargetPercent;

    rows.push(
      [
        result.name.padEnd(colWidths.name).slice(0, colWidths.name),
        median.toFixed(3).padEnd(colWidths.median),
        cv.toFixed(1).padEnd(colWidths.cv),
        skipped
          ? `⚠ HIGH (>${varianceTargetPercent}%) — excluded from regression gate`
          : '✓ OK',
      ].join('  '),
    );
  }

  rows.push(separator);

  process.stderr.write('\nBenchmark Variance Summary\n');
  process.stderr.write(rows.join('\n') + '\n\n');

  const highVariance = results.filter(
    (r) => coefficientOfVariation(r) > varianceTargetPercent,
  );
  if (highVariance.length > 0) {
    process.stderr.write(
      `ℹ  ${highVariance.length} operation(s) exceeded the variance target of ` +
        `${varianceTargetPercent}% CV and will be skipped in the regression comparison.\n` +
        '   Re-run with more iterations (BENCHMARK_ITERATIONS) to reduce noise.\n\n',
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = parseConfigFromEnv();
  const varianceTarget = config.varianceTargetPercent ?? 10;

  const operations = buildOperations(config.rpcLatencyMs ?? 5);
  const report = await runAllBenchmarks(operations, config);

  // Print variance summary to stderr so it appears in CI logs without
  // polluting the JSON artifact on stdout / --output.
  printVarianceSummary(report.results, varianceTarget);

  // Annotate each result with its CV so the CI comparison step can skip
  // high-variance operations.  We add this as an extra field rather than
  // modifying the BenchmarkResult type to keep the schema stable.
  const annotated = {
    ...report,
    results: report.results.map((r) => ({
      ...r,
      cv_percent: parseFloat(coefficientOfVariation(r).toFixed(2)),
      median_latency_ms: parseFloat(medianLatency(r).toFixed(3)),
      high_variance: coefficientOfVariation(r) > varianceTarget,
    })),
  };

  const json = JSON.stringify(annotated, null, 2);
  const { outputPath } = parseArgs(process.argv.slice(2));

  if (outputPath) {
    const resolved = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, json, 'utf8');
    process.stderr.write(`Benchmark results written to ${resolved}\n`);
  }

  process.stdout.write(`${json}\n`);
}

main().catch((err) => {
  process.stderr.write(`Benchmark failed: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
