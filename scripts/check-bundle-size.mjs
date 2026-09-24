#!/usr/bin/env node
/**
 * Bundle-size regression budget (tree-shaking verified).
 *
 * Bundles the SDK's public surface at `src/index.ts` with esbuild in
 * tree-shaking mode, minifies it, and enforces a byte budget on the result.
 *
 * Why this catches dead-exports regressions that a raw entry-file byte count
 * cannot: esbuild drops any module that isn't reachable from the entry's used
 * bindings, but a re-exported binding (e.g. `export { deadThing } from
 * "./mod"`) forces that module's code into the bundle. Reintroducing a removed
 * dead export therefore measurably inflates the minified bundle, which this
 * script turns into a CI failure. Legitimate, tree-shakeable module growth is
 * dropped away and does not trip the budget.
 *
 * Third-party runtime dependencies (`@stellar/stellar-sdk`, `zod`) are marked
 * external so the budget measures the SDK's own shipped surface, not deps.
 *
 * Budget rationale
 * ----------------
 * Measured baseline: the minified ESM bundle of src/index is ~192 KiB
 * (196,781 bytes). The guarded number is the post-bundle, post-minify byte
 * size with third-party deps externalized, so it reflects only the SDK's own
 * reachable surface. Each genuinely-reintroduced dead module adds roughly
 * 1-3 KiB of minified code.
 *
 * Budget: 200 KiB (204800 bytes) -- ~4% headroom over the measured baseline.
 * Tight enough to trip on dead-exports reintroduction (a couple of removed
 * modules worth of code) while tolerant of normal legitimate growth. Anything
 * larger than 200 KiB is a deliberate, talked-about decision -- bump
 * `BUNDLE_SIZE_BUDGET_BYTES` here and in the docs alongside a justification.
 */

import fs from 'node:fs';
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const BUNDLE_SIZE_BUDGET_BYTES = 204800; // 200 KiB
const ENTRY = path.join(root, 'src', 'index.ts');
const SKIP_IF_SRC_MISSING = process.env.BUNDLE_SKIP_IF_NOT_BUILT === '1';

function humanize(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB (${bytes} bytes)`;
}

async function measure() {
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    minify: true,
    format: 'esm',
    platform: 'node',
    external: ['@stellar/stellar-sdk', 'zod'],
    alias: { '@': path.join(root, 'src') },
    write: false,
    logLevel: 'silent',
    metafile: true,
  });

  let size = 0;
  for (const out of result.outputFiles) {
    size += out.contents.byteLength;
  }
  return size;
}

async function main() {
  if (!fs.existsSync(path.join(root, 'node_modules'))) {
    process.stderr.write('check-bundle-size: node_modules missing — run `npm ci` first.\n');
    process.exit(1);
  }

  if (!fs.existsSync(ENTRY)) {
    if (SKIP_IF_SRC_MISSING) {
      process.stderr.write('check-bundle-size: src/index.ts missing. Skipping.\n');
      process.exit(0);
    }
    process.stderr.write('check-bundle-size: src/index.ts not found. Run `npm install` first.\n');
    process.exit(1);
  }

  let size;
  try {
    size = await measure();
  } catch (err) {
    process.stderr.write(
      `check-bundle-size: failed to bundle public surface.\n${err instanceof Error ? err.message : err}\n`,
    );
    process.exit(2);
  }

  const ok = size <= BUNDLE_SIZE_BUDGET_BYTES;
  const flag = ok ? '✅' : '❌';

  process.stdout.write(
    `${flag} src/index.ts (minified bundle): ${humanize(size)} ` +
      `(budget ${humanize(BUNDLE_SIZE_BUDGET_BYTES)})\n`,
  );

  if (!ok) {
    process.stderr.write(
      '\n❌ Bundle-size budget exceeded.\n' +
        `Budget: ${humanize(BUNDLE_SIZE_BUDGET_BYTES)}\n` +
        'A dead export or unintended re-export was likely reintroduced into src/index.ts.\n' +
        'Remove it, or deliberately raise BUNDLE_SIZE_BUDGET_BYTES and document why.\n',
    );
    process.exit(1);
  }

  process.stdout.write(
    `\n✅ Bundle-size within budget — public surface tree-shake checked, ` +
      `limit ${humanize(BUNDLE_SIZE_BUDGET_BYTES)}.\n`,
  );

  if (fs.existsSync(path.join(root, 'benchmarks'))) {
    fs.writeFileSync(
      path.join(root, 'benchmarks', 'bundle-size.json'),
      JSON.stringify(
        {
          entry: 'src/index.ts',
          minified_bundle_bytes: size,
          budget_bytes: BUNDLE_SIZE_BUDGET_BYTES,
          external: ['@stellar/stellar-sdk', 'zod'],
          generated_at: new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf8',
    );
  }
}

main().catch((err) => {
  process.stderr.write(`check-bundle-size: unexpected error.\n${err}\n`);
  process.exit(1);
});
