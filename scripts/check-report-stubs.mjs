#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const reportPath = /(report|metric|analytics|quote|estimate|balance|price)/i;

// Only TypeScript sources, and never build output. src/pair is a Cargo crate,
// so a local build fills src/pair/target with artifacts that are not source.
const files = execFileSync('git', ['ls-files', 'src'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .filter((file) => /\.(ts|tsx|mts|cts)$/.test(file))
  .filter((file) => !file.includes('/target/') && !file.includes('/node_modules/'));

const stub =
  /(?:function\s+\w+\s*\([^)]*\)|(?:async\s*)?\([^)]*\)\s*=>)\s*\{?\s*return\s+(?:0(?:\.0)?n?|null|"0"|'')\s*;?\s*\}?|(?:async\s*)?\([^)]*\)\s*=>\s*(?:0(?:\.0)?n?|null|"0"|'')\b/m;

const findings = files
  .filter((file) => reportPath.test(file) && stub.test(readFileSync(file, 'utf8')))
  .map((file) => `- ${file}`);

if (findings.length) {
  console.error('Stub-shaped literal return found in report-related source:');
  console.error(findings.join('\n'));
  process.exit(1);
}
console.log(`Report stub scan passed (${files.length} source files checked).`);
