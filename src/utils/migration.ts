import { ValidationError } from '@/errors';

/**
 * Migration compatibility utilities for CoralSwap SDK version transitions.
 *
 * Provides structured breaking-change definitions and a version compatibility
 * checker that generates actionable migration steps for consumers upgrading
 * across SDK versions.
 *
 * @module utils/migration
 */

/**
 * A single breaking change between two SDK versions.
 */
export interface BreakingChange {
  /** The SDK sub-system or module that changed (e.g. "Client", "Amounts"). */
  module: string;
  /** The previous (deprecated) API surface or behaviour. */
  oldAPI: string;
  /** The replacement API or expected new behaviour. */
  newAPI: string;
  /** Human-readable explanation of why the change was made and what to do. */
  description: string;
}

/**
 * Result of a version compatibility check.
 */
export interface CompatibilityReport {
  /** Whether the two versions are compatible with zero migration work. */
  isCompatible: boolean;
  /** List of individual breaking changes identified between the versions. */
  breakingChanges: BreakingChange[];
  /** Ordered steps a consumer should follow to migrate safely. */
  migrationSteps: string[];
}

/**
 * Registry of breaking changes keyed by version transition.
 *
 * Each key follows the pattern `"<from>-><to>"` using strict semver strings
 * (e.g. `"1.0.0->2.0.0"`).  Only non-trivial transitions (major or minor
 * bumps) are listed; patch-only bumps are treated as fully compatible.
 */
const BREAKING_CHANGES: Record<string, BreakingChange[]> = {
  "0.0.0->1.0.0": [
    {
      module: "Client",
      oldAPI: "`new CoralSwapClient(secretKey, rpcUrl)` — positional args",
      newAPI: "`new CoralSwapClient({ secretKey, rpcUrl, ... })` — config object",
      description:
        "The constructor was switched to a single config object to support optional fields (signer, logger, timeoutSec) without breaking overloads.",
    },
    {
      module: "Amounts",
      oldAPI: "`toSorobanAmount(n: number)` — returned `number`",
      newAPI:
        "`toSorobanAmount(s: string, decimals?: number)` — returns `bigint`",
      description:
        "All token amounts now use `bigint` to match Soroban's i128. Callers must supply decimal strings (e.g. `\"1.5\"`) instead of JavaScript numbers to avoid floating-point precision loss.",
    },
    {
      module: "Errors",
      oldAPI: "Plain `Error` thrown with a message string",
      newAPI:
        "Typed subclasses of `CoralSwapSDKError` (e.g. `NetworkError`, `ValidationError`) with `.code` and `.details`",
      description:
        "All SDK methods now throw typed errors. Callers should update catch blocks to use `instanceof` checks or inspect `error.code` for programmatic handling.",
    },
    {
      module: "Factory",
      oldAPI:
        "`factory.createPair(tokenA, tokenB)` — synchronous, returns `string`",
      newAPI:
        "`factory.createPair(tokenA, tokenB)` — `async`, returns `Promise<string>`",
      description:
        "Pair creation now requires an RPC round-trip for ledger simulation. The method is now asynchronous.",
    },
    {
      module: "Router",
      oldAPI:
        "`router.swapExactIn(amountIn, path, to, deadline)` — plain args",
      newAPI:
        "`router.swapExactIn({ amountIn, path, to, deadline, slippageBps? })` — options object",
      description:
        "Swap methods now accept a single options object to support optional slippage protection without positional clutter.",
    },
  ],
  "1.0.0->1.1.0": [
    {
      module: "Config",
      oldAPI:
        "`CoralSwapConfig` — `secretKey` only, no `signer` option",
      newAPI:
        "`CoralSwapConfig` — new optional `signer` field plus existing `secretKey`",
      description:
        "A `Signer` interface was added for external wallet integration. Existing `secretKey` usage continues to work unchanged (backward compatible).",
    },
  ],
  "1.1.0->2.0.0": [
    {
      module: "Signer",
      oldAPI:
        "`signer.signTransaction(xdr: string): Promise<string>` — raw XDR string",
      newAPI:
        "`signer.signTransaction(tx: Transaction): Promise<Transaction>` — full Transaction object",
      description:
        "The Signer interface now receives and returns a `Transaction` object instead of an XDR string, enabling richer wallet integrations (e.g. fee-bumping, multi-sig inspection).",
    },
    {
      module: "Router",
      oldAPI:
        "`Router` contract binding used for all swap operations",
      newAPI:
        "`RouterV2` contract binding — `Router` is deprecated",
      description:
        "The on-chain Router contract was upgraded to v2 with improved path encoding. Import `RouterV2` from the contracts module and replace all `Router` references.",
    },
    {
      module: "TWAP Oracle",
      oldAPI:
        "`oracle.getPrice(pair)` — returns `{ price: bigint, timestamp: number }`",
      newAPI:
        "`oracle.getPrice(pair)` — returns `{ price: bigint, confidence: bigint, timestamp: number }`",
      description:
        "The TWAP oracle now returns a `confidence` interval alongside the point estimate. Callers consuming the raw price must account for the new field in their type signatures.",
    },
    {
      module: "FlashLoan",
      oldAPI:
        "`flashLoan.borrow(amount, token, receiver)` — positional args",
      newAPI:
        "`flashLoan.borrow({ amount, token, receiver, data? })` — options object with optional `data` callback payload",
      description:
        "The borrow method now takes an options object to support the `data` payload forwarded to the receiver contract. Existing call sites must wrap positional args into an object literal.",
    },
    {
      module: "Events",
      oldAPI:
        "`decodeEvents(xdrStrings)` — returned `Record<string, unknown>[]`",
      newAPI:
        "`decodeEvents(xdrStrings, options?)` — returns typed event objects with `options` for topic filtering",
      description:
        "Event decoding now supports typed output and optional filtering. The return type changed from generic records to discriminated unions keyed by event topic.",
    },
  ],
};

/**
 * Parse a strict semver string into its components.
 *
 * Accepts versions of the form `"X.Y.Z"` where X, Y, Z are non-negative
 * integers.  Pre-release and build-metadata suffixes are **not** supported.
 *
 * @param version - The semver string to parse.
 * @returns An object with `major`, `minor`, and `patch` fields.
 * @throws {ValidationError} If the string is not valid semver.
 */
function parseSemver(version: string): { major: number; minor: number; patch: number } {
  const trimmed = version.trim();
  const match = trimmed.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw new ValidationError(
      `Invalid semver version string: "${version}". Expected format "X.Y.Z" (e.g. "1.0.0").`,
      { version },
    );
  }
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
  };
}

/**
 * Check whether two SDK versions are compatible and, if not, produce a report
 * of breaking changes and migration steps.
 *
 * **Compatibility rules:**
 * - Patch bumps (e.g. `1.0.0` → `1.0.1`) are always compatible — no migration
 *   needed.
 * - Minor and major bumps are looked up in the built-in `BREAKING_CHANGES`
 *   registry.  If no entry exists for the transition the versions are treated
 *   as compatible with a warning note in `migrationSteps`.
 * - Pre-release identifiers are not supported — pass the base release version.
 *
 * @param currentVersion - The version the consumer is currently on (e.g. `"1.0.0"`).
 * @param targetVersion  - The version the consumer wants to upgrade to (e.g. `"2.0.0"`).
 * @returns A `CompatibilityReport` describing breaking changes and migration steps.
 *
 * @example
 * // Patch bump — always compatible
 * const report = await checkCompatibility("1.0.0", "1.0.5");
 * // => { isCompatible: true, breakingChanges: [], migrationSteps: [] }
 *
 * @example
 * // Major bump with known breaking changes
 * const report = await checkCompatibility("1.1.0", "2.0.0");
 * // => { isCompatible: false, breakingChanges: [...], migrationSteps: [...] }
 *
 * @example
 * // Unknown version pair — graceful fallback
 * const report = await checkCompatibility("0.5.0", "1.0.0");
 * // => { isCompatible: false, breakingChanges: [], migrationSteps: ["Unknown..."] }
 */
export async function checkCompatibility(
  currentVersion: string,
  targetVersion: string,
): Promise<CompatibilityReport> {
  const current = parseSemver(currentVersion);
  const target = parseSemver(targetVersion);

  // Same version — always compatible
  if (
    current.major === target.major &&
    current.minor === target.minor &&
    current.patch === target.patch
  ) {
    return {
      isCompatible: true,
      breakingChanges: [],
      migrationSteps: [],
    };
  }

  // Patch bump within the same major.minor — always compatible
  if (
    current.major === target.major &&
    current.minor === target.minor &&
    current.patch < target.patch
  ) {
    return {
      isCompatible: true,
      breakingChanges: [],
      migrationSteps: [
        `Patch bump ${currentVersion} → ${targetVersion}: no breaking changes.`,
      ],
    };
  }

  // Downgrade — warn but treat as potentially incompatible
  if (
    target.major < current.major ||
    (target.major === current.major && target.minor < current.minor)
  ) {
    return {
      isCompatible: false,
      breakingChanges: [],
      migrationSteps: [
        `Downgrade from ${currentVersion} to ${targetVersion} is not recommended.`,
        `Some features available in ${currentVersion} may not exist in ${targetVersion}.`,
        `Consider staying on ${currentVersion} or upgrading to a newer release.`,
      ],
    };
  }

  // Look up the transition in the registry.
  // We check both direct keys and collect all applicable transitions between
  // the current and target version (e.g. 1.0.0→1.1.0→2.0.0 for a 1.0.0→2.0.0 jump).
  const discovered: BreakingChange[] = [];
  const versionsInOrder = collectVersionTransitions(current, target);

  for (const transitionKey of versionsInOrder) {
    const changes = BREAKING_CHANGES[transitionKey];
    if (changes) {
      discovered.push(...changes);
    }
  }

  if (discovered.length === 0) {
    return {
      isCompatible: true,
      breakingChanges: [],
      migrationSteps: [
        `No known breaking changes between ${currentVersion} and ${targetVersion}.`,
        `We recommend reviewing the full CHANGELOG at https://github.com/CoralSwap-Finance/coralswap-sdk/releases`,
        `before upgrading in production.`,
      ],
    };
  }

  // Build actionable migration steps from the breaking changes
  const migrationSteps = generateMigrationSteps(
    currentVersion,
    targetVersion,
    discovered,
  );

  return {
    isCompatible: false,
    breakingChanges: discovered,
    migrationSteps,
  };
}

/**
 * Collect all version-transition keys that apply when going from `current` to
 * `target`, walking forward through every minor and major bump.
 *
 * For example: `1.0.0` → `2.0.0` produces `["1.0.0->1.1.0", "1.1.0->2.0.0"]`.
 *
 * @param current - Parsed current version.
 * @param target  - Parsed target version.
 * @returns An ordered array of `"<from>-><to>"` transition keys.
 */
function collectVersionTransitions(
  current: { major: number; minor: number; patch: number },
  target: { major: number; minor: number; patch: number },
): string[] {
  const transitions: string[] = [];

  // If same major, walk minor versions
  if (current.major === target.major) {
    for (let m = current.minor; m < target.minor; m++) {
      transitions.push(`${current.major}.${m}.0->${current.major}.${m + 1}.0`);
    }
    return transitions;
  }

  // Walk through known minor transitions in the current major
  let lastKnownMinor = current.minor;
  for (let m = current.minor; ; m++) {
    const from = `${current.major}.${m}.0`;
    const to = `${current.major}.${m + 1}.0`;
    const key = `${from}->${to}`;
    if (BREAKING_CHANGES[key]) {
      transitions.push(key);
      lastKnownMinor = m + 1;
    } else {
      break;
    }
  }

  // Cross-major jump from the last known minor in the current major
  const crossKey = `${current.major}.${lastKnownMinor}.0->${target.major}.0.0`;
  if (BREAKING_CHANGES[crossKey]) {
    transitions.push(crossKey);
  } else if (lastKnownMinor !== 0) {
    // Fallback to the catch-all major.0.0 transition
    const fallbackKey = `${current.major}.0.0->${target.major}.0.0`;
    if (BREAKING_CHANGES[fallbackKey]) {
      transitions.push(fallbackKey);
    }
  } else {
    // Push the key anyway so the caller can check it
    transitions.push(crossKey);
  }

  // Walk minor versions within the target major up to the target minor
  for (let m = 0; m < target.minor; m++) {
    transitions.push(`${target.major}.${m}.0->${target.major}.${m + 1}.0`);
  }

  return transitions;
}

/**
 * Generate human-readable migration steps from a list of breaking changes.
 *
 * @param current     - The version being upgraded from (for display).
 * @param target      - The version being upgraded to (for display).
 * @param changes     - The breaking changes identified between the versions.
 * @returns An ordered list of migration step strings.
 */
function generateMigrationSteps(
  current: string,
  target: string,
  changes: BreakingChange[],
): string[] {
  const steps: string[] = [
    `Upgrade from ${current} to ${target} contains ${changes.length} breaking change(s).`,
    "",
  ];

  // Group changes by module for clearer steps
  const byModule = new Map<string, BreakingChange[]>();
  for (const change of changes) {
    const list = byModule.get(change.module) ?? [];
    list.push(change);
    byModule.set(change.module, list);
  }

  for (const [module, moduleChanges] of byModule) {
    steps.push(`--- ${module} ---`);
    for (const change of moduleChanges) {
      steps.push(`  • ${change.description}`);
      steps.push(`    Old: ${change.oldAPI}`);
      steps.push(`    New: ${change.newAPI}`);
      steps.push("");
    }
  }

  steps.push(
    "After applying the changes above, run your test suite to verify compatibility.",
  );
  steps.push(
    `Full changelog: https://github.com/CoralSwap-Finance/coralswap-sdk/releases/tag/v${target}`,
  );

  return steps;
}
