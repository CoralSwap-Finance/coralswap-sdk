/**
 * Migration downgrade-detection fixture corpus.
 *
 * Each fixture describes a version-pair scenario used to regression-test the
 * patch-downgrade detection fix in `checkCompatibility`.  The four canonical
 * cases are:
 *
 *  1. identical   — current === target  (always compatible, never a downgrade)
 *  2. down-patch  — same major.minor, lower patch  (downgrade MUST be flagged)
 *  3. up-patch    — same major.minor, higher patch (forward upgrade, compatible)
 *  4. empty-registry — version pair not present in BREAKING_CHANGES registry
 *                       (graceful no-known-changes path, still not a downgrade)
 *
 * The `expectDowngrade` field is the acceptance criterion: every fixture where
 * it is `true` MUST produce `isCompatible: false` with a step matching
 * /downgrade/i.
 */

export interface DowngradeFixture {
  /** Short human-readable label used as the test description. */
  readonly label: string;
  /** The version the consumer is currently running. */
  readonly currentVersion: string;
  /** The version the consumer wants to move to. */
  readonly targetVersion: string;
  /**
   * Whether this fixture represents a downgrade.
   * When `true` the test MUST assert `isCompatible === false` and at least one
   * `migrationSteps` entry matching `/downgrade/i`.
   */
  readonly expectDowngrade: boolean;
  /**
   * Whether the resulting report is expected to be compatible.
   * Used in parallel to `expectDowngrade` to make assertions self-documenting.
   */
  readonly expectCompatible: boolean;
}

/**
 * The canonical fixture corpus for downgrade-detection regression tests.
 *
 * @remarks
 * Fixtures are intentionally scoped to the same-minor axis to expose the
 * specific regression where `1.2.3 → 1.2.1` was silently treated as
 * compatible before the patch-downgrade guard was added.  Additional rows
 * covering major/minor downgrades are included to ensure the fix did not
 * regress those paths.
 */
export const DOWNGRADE_FIXTURES: readonly DowngradeFixture[] = [
  // ─────────────────────────────────────────────────────────────────────────
  // Case 1 — Identical: current and target are the same version.
  // Expected: compatible, not a downgrade.
  // ─────────────────────────────────────────────────────────────────────────
  {
    label: 'identical path — 1.0.0 → 1.0.0',
    currentVersion: '1.0.0',
    targetVersion: '1.0.0',
    expectDowngrade: false,
    expectCompatible: true,
  },
  {
    label: 'identical path — 1.1.0 → 1.1.0',
    currentVersion: '1.1.0',
    targetVersion: '1.1.0',
    expectDowngrade: false,
    expectCompatible: true,
  },
  {
    label: 'identical path — 2.0.0 → 2.0.0',
    currentVersion: '2.0.0',
    targetVersion: '2.0.0',
    expectDowngrade: false,
    expectCompatible: true,
  },
  {
    label: 'identical path — 1.2.5 → 1.2.5 (non-zero patch)',
    currentVersion: '1.2.5',
    targetVersion: '1.2.5',
    expectDowngrade: false,
    expectCompatible: true,
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Case 2 — Down-patch: same major.minor, lower patch.
  // This is the regression scenario.  MUST be flagged as a downgrade.
  // ─────────────────────────────────────────────────────────────────────────
  {
    label: 'down-patch — 1.0.1 → 1.0.0',
    currentVersion: '1.0.1',
    targetVersion: '1.0.0',
    expectDowngrade: true,
    expectCompatible: false,
  },
  {
    label: 'down-patch — 1.0.5 → 1.0.1',
    currentVersion: '1.0.5',
    targetVersion: '1.0.1',
    expectDowngrade: true,
    expectCompatible: false,
  },
  {
    label: 'down-patch — 1.1.3 → 1.1.1',
    currentVersion: '1.1.3',
    targetVersion: '1.1.1',
    expectDowngrade: true,
    expectCompatible: false,
  },
  {
    label: 'down-patch — 2.0.10 → 2.0.2',
    currentVersion: '2.0.10',
    targetVersion: '2.0.2',
    expectDowngrade: true,
    expectCompatible: false,
  },
  {
    label: 'down-patch — 1.2.3 → 1.2.1 (canonical regression case)',
    currentVersion: '1.2.3',
    targetVersion: '1.2.1',
    expectDowngrade: true,
    expectCompatible: false,
  },
  {
    label: 'down-patch — 1.0.100 → 1.0.99 (large patch numbers)',
    currentVersion: '1.0.100',
    targetVersion: '1.0.99',
    expectDowngrade: true,
    expectCompatible: false,
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Case 2 (extra): minor and major downgrades — must still be flagged.
  // These verify the pre-existing guard was not regressed by the patch fix.
  // ─────────────────────────────────────────────────────────────────────────
  {
    label: 'down-minor — 2.0.0 → 1.0.0 (major downgrade)',
    currentVersion: '2.0.0',
    targetVersion: '1.0.0',
    expectDowngrade: true,
    expectCompatible: false,
  },
  {
    label: 'down-minor — 1.1.0 → 1.0.0 (minor downgrade)',
    currentVersion: '1.1.0',
    targetVersion: '1.0.0',
    expectDowngrade: true,
    expectCompatible: false,
  },
  {
    label: 'down-minor — 1.2.0 → 1.1.5 (minor downgrade, non-zero target patch)',
    currentVersion: '1.2.0',
    targetVersion: '1.1.5',
    expectDowngrade: true,
    expectCompatible: false,
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Case 3 — Up-patch: same major.minor, higher patch.
  // Forward patch upgrade — always compatible, never a downgrade.
  // ─────────────────────────────────────────────────────────────────────────
  {
    label: 'up-patch — 1.0.0 → 1.0.1',
    currentVersion: '1.0.0',
    targetVersion: '1.0.1',
    expectDowngrade: false,
    expectCompatible: true,
  },
  {
    label: 'up-patch — 1.0.0 → 1.0.5',
    currentVersion: '1.0.0',
    targetVersion: '1.0.5',
    expectDowngrade: false,
    expectCompatible: true,
  },
  {
    label: 'up-patch — 1.1.2 → 1.1.9',
    currentVersion: '1.1.2',
    targetVersion: '1.1.9',
    expectDowngrade: false,
    expectCompatible: true,
  },
  {
    label: 'up-patch — 2.0.0 → 2.0.3',
    currentVersion: '2.0.0',
    targetVersion: '2.0.3',
    expectDowngrade: false,
    expectCompatible: true,
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Case 4 — Empty registry: version pair absent from BREAKING_CHANGES.
  // Forward upgrade with no registered entry — compatible via fallback path,
  // and definitely not a downgrade.
  // ─────────────────────────────────────────────────────────────────────────
  {
    label: 'empty registry — 2.0.0 → 2.1.0 (unknown minor, no registry entry)',
    currentVersion: '2.0.0',
    targetVersion: '2.1.0',
    expectDowngrade: false,
    expectCompatible: true,
  },
  {
    label: 'empty registry — 2.0.0 → 3.0.0 (unknown major, no registry entry)',
    currentVersion: '2.0.0',
    targetVersion: '3.0.0',
    expectDowngrade: false,
    expectCompatible: true,
  },
  {
    label: 'empty registry — 1.1.0 → 1.2.0 (next minor, no registry entry)',
    currentVersion: '1.1.0',
    targetVersion: '1.2.0',
    expectDowngrade: false,
    expectCompatible: true,
  },
  {
    label: 'empty registry — 99.0.0 → 99.1.0 (far-future, no registry entry)',
    currentVersion: '99.0.0',
    targetVersion: '99.1.0',
    expectDowngrade: false,
    expectCompatible: true,
  },
] as const;

/**
 * Convenience sub-set: only the fixtures that represent a downgrade scenario.
 *
 * The acceptance criterion from the issue states:
 * > "Down-patch migration flagged in every fixture."
 *
 * Iterating this subset in tests makes that assertion explicit and exhaustive.
 */
export const DOWNGRADE_ONLY_FIXTURES: readonly DowngradeFixture[] =
  DOWNGRADE_FIXTURES.filter((f) => f.expectDowngrade);

/**
 * Convenience sub-set: fixtures that must NOT be treated as a downgrade.
 */
export const NON_DOWNGRADE_FIXTURES: readonly DowngradeFixture[] =
  DOWNGRADE_FIXTURES.filter((f) => !f.expectDowngrade);
