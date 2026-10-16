#!/usr/bin/env node
/**
 * CoralSwap SDK performance benchmark runner.
 *
 * Outputs JSON to stdout (or --output file) for CI benchmark tracking.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseConfigFromEnv, runAllBenchmarks } from './harness';
import { buildOperations } from './operations';

function parseArgs(argv: string[]): { outputPath?: string } {
  const outputIdx = argv.indexOf('--output');
  if (outputIdx !== -1 && argv[outputIdx + 1]) {
    return { outputPath: argv[outputIdx + 1] };
  }
  return {};
}

async function main(): Promise<void> {
  const config = parseConfigFromEnv();
  const operations = buildOperations(config.rpcLatencyMs ?? 5);
  const report = await runAllBenchmarks(operations, config);

  const json = JSON.stringify(report, null, 2);
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
