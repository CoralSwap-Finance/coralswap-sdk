#!/usr/bin/env node
/**
 * Bundle-size budget check for the public surface exported from src/index.ts.
 *
 * Bundles the public entrypoint with esbuild in tree-shaking mode, minifies
 * it, and compares the resulting size against a fixed budget. Runtime
 * dependencies (@stellar/stellar-sdk, zod) are marked external so the budget
 * reflects the SDK's own code, not vendored dependency size.
 *
 * A dead export that gets reintroduced during a refactor will only inflate
 * this number if it drags genuinely unused code back in with it -- pure
 * re-exports of already-referenced code are still tree-shaken out. This
 * makes the check meaningful, not just a proxy for "did the export list
 * change."
 *
 * Usage: node scripts/check-bundle-size.mjs
 * Exit code: 0 if under budget, 1 if over budget or on build error.
 */

import esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

// Budget for the bundled, minified, tree-shaken public surface (src/index.ts).
// Keep this in sync with the "Bundle Size" section of README.md.
const BUDGET_KIB = 200;
const BUDGET_BYTES = BUDGET_KIB * 1024;

// Runtime dependencies are not part of this SDK's own code footprint.
const EXTERNAL_DEPS = ["@stellar/stellar-sdk", "zod"];

async function main() {
  const result = await esbuild.build({
    entryPoints: [path.join(rootDir, "src/index.ts")],
    bundle: true,
    minify: true,
    treeShaking: true,
    format: "esm",
    platform: "node",
    target: "es2020",
    tsconfig: path.join(rootDir, "tsconfig.json"),
    external: EXTERNAL_DEPS,
    write: false,
    metafile: true,
    logLevel: "silent",
  });

  const output = result.outputFiles[0];
  const sizeBytes = output.contents.byteLength;
  const sizeKiB = sizeBytes / 1024;

  console.log("Bundle size check — src/index.ts (public surface)");
  console.log("--------------------------------------------------");
  console.log(`  Minified, tree-shaken size : ${sizeKiB.toFixed(2)} KiB`);
  console.log(`  Budget                     : ${BUDGET_KIB.toFixed(2)} KiB`);
  console.log(`  External (not counted)     : ${EXTERNAL_DEPS.join(", ")}`);
  console.log("");

  if (sizeBytes > BUDGET_BYTES) {
    const overBy = ((sizeBytes - BUDGET_BYTES) / 1024).toFixed(2);
    console.error(`FAIL: bundle exceeds budget by ${overBy} KiB.`);
    console.error("");
    console.error(
      "If this growth is expected, update BUDGET_KIB in " +
        "scripts/check-bundle-size.mjs and the matching value in README.md, " +
        "and explain why in the PR description."
    );

    const analysis = await esbuild.analyzeMetafile(result.metafile, {
      verbose: false,
    });
    console.error("Bundle breakdown:");
    console.error(analysis);

    process.exit(1);
  }

  console.log(`PASS: within budget (${(BUDGET_BYTES / 1024 - sizeKiB).toFixed(2)} KiB to spare).`);
}

main().catch((err) => {
  console.error("Bundle size check failed to run:");
  console.error(err);
  process.exit(1);
});
