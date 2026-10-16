/**
 * Regression tests: downgrade-detection in checkCompatibility.
 *
 * Tracks the fix for the same-minor patch-downgrade regression where a call
 * such as checkCompatibility('1.2.3', '1.2.1') silently returned
 * isCompatible: true instead of flagging the version as a downgrade.
 *
 * Acceptance criterion (from issue):
 *   "Down-patch migration flagged in every fixture."
 *
 * The test suite is driven by the fixture corpus in
 * tests/fixtures/migration-downgrade.ts which covers four canonical scenarios:
 *
 *   1. identical   — same version, always compatible
 *   2. down-patch  — same major.minor, lower patch (MUST be flagged)
 *   3. up-patch    — same major.minor, higher patch (always compatible)
 *   4. empty-registry — forward upgrade with no BREAKING_CHANGES entry
 */

import { checkCompatibility } from '../src/utils/migration';
import {
  DOWNGRADE_FIXTURES,
  DOWNGRADE_ONLY_FIXTURES,
  NON_DOWNGRADE_FIXTURES,
} from './fixtures/migration-downgrade';

// ---------------------------------------------------------------------------
// Primary acceptance criterion
// ---------------------------------------------------------------------------

describe('downgrade-detection regression — acceptance criterion', () => {
  /**
   * For every fixture marked expectDowngrade, the report MUST be incompatible
   * and at least one migrationStep must match /downgrade/i.
   *
   * This is the single assertion the issue requires to be green in every
   * fixture, including (and especially) the same-minor patch-downgrade cases.
   */
  describe('every downgrade fixture is flagged', () => {
    test.each(DOWNGRADE_ONLY_FIXTURES.map((f) => [f.label, f] as const))(
      '%s',
      async (_label, fixture) => {
        const report = await checkCompatibility(
          fixture.currentVersion,
          fixture.targetVersion,
        );

        // Acceptance criterion: must be incompatible
        expect(report.isCompatible).toBe(false);

        // Acceptance criterion: at least one step must name the downgrade
        const hasDowngradeStep = report.migrationSteps.some((step) =>
          /downgrade/i.test(step),
        );
        expect(hasDowngradeStep).toBe(true);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Case 1 — Identical path
// ---------------------------------------------------------------------------

describe('identical path fixtures', () => {
  const identicalFixtures = DOWNGRADE_FIXTURES.filter(
    (f) => f.currentVersion === f.targetVersion,
  );

  test.each(identicalFixtures.map((f) => [f.label, f] as const))(
    '%s',
    async (_label, fixture) => {
      const report = await checkCompatibility(
        fixture.currentVersion,
        fixture.targetVersion,
      );

      expect(report.isCompatible).toBe(true);
      expect(report.breakingChanges).toHaveLength(0);
      expect(report.migrationSteps).toHaveLength(0);

      // Must NOT mention a downgrade
      const hasDowngradeStep = report.migrationSteps.some((step) =>
        /downgrade/i.test(step),
      );
      expect(hasDowngradeStep).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// Case 2 — Down-patch (same-minor patch regression)
// ---------------------------------------------------------------------------

describe('down-patch fixtures — same-minor patch downgrade', () => {
  const downPatchFixtures = DOWNGRADE_ONLY_FIXTURES.filter((f) => {
    // Isolate the cases where the version pair is within the same major.minor
    const [curMaj, curMin] = f.currentVersion.split('.').map(Number);
    const [tgtMaj, tgtMin] = f.targetVersion.split('.').map(Number);
    return curMaj === tgtMaj && curMin === tgtMin;
  });

  test.each(downPatchFixtures.map((f) => [f.label, f] as const))(
    '%s',
    async (_label, fixture) => {
      const report = await checkCompatibility(
        fixture.currentVersion,
        fixture.targetVersion,
      );

      // The core regression: patch downgrade must be incompatible
      expect(report.isCompatible).toBe(false);

      // No breaking-change entries — just warning steps
      expect(report.breakingChanges).toHaveLength(0);

      // Downgrade must be mentioned in steps
      expect(
        report.migrationSteps.some((step) => /downgrade/i.test(step)),
      ).toBe(true);

      // Steps should reference both versions to aid diagnosis
      const stepsText = report.migrationSteps.join(' ');
      expect(stepsText).toContain(fixture.currentVersion);
      expect(stepsText).toContain(fixture.targetVersion);
    },
  );
});

describe('down-minor and down-major fixtures — pre-existing guard not regressed', () => {
  const downMinorMajorFixtures = DOWNGRADE_ONLY_FIXTURES.filter((f) => {
    const [curMaj, curMin] = f.currentVersion.split('.').map(Number);
    const [tgtMaj, tgtMin] = f.targetVersion.split('.').map(Number);
    // Either different major or different minor (not same-minor patch)
    return tgtMaj < curMaj || (tgtMaj === curMaj && tgtMin < curMin);
  });

  test.each(downMinorMajorFixtures.map((f) => [f.label, f] as const))(
    '%s',
    async (_label, fixture) => {
      const report = await checkCompatibility(
        fixture.currentVersion,
        fixture.targetVersion,
      );

      expect(report.isCompatible).toBe(false);
      expect(
        report.migrationSteps.some((step) => /downgrade/i.test(step)),
      ).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// Case 3 — Up-patch
// ---------------------------------------------------------------------------

describe('up-patch fixtures — forward patch upgrade is always compatible', () => {
  const upPatchFixtures = NON_DOWNGRADE_FIXTURES.filter((f) => {
    const [curMaj, curMin, curPat] = f.currentVersion.split('.').map(Number);
    const [tgtMaj, tgtMin, tgtPat] = f.targetVersion.split('.').map(Number);
    return curMaj === tgtMaj && curMin === tgtMin && tgtPat > curPat;
  });

  test.each(upPatchFixtures.map((f) => [f.label, f] as const))(
    '%s',
    async (_label, fixture) => {
      const report = await checkCompatibility(
        fixture.currentVersion,
        fixture.targetVersion,
      );

      expect(report.isCompatible).toBe(true);
      expect(report.breakingChanges).toHaveLength(0);

      // Must NOT be a downgrade warning
      const hasDowngradeStep = report.migrationSteps.some((step) =>
        /downgrade/i.test(step),
      );
      expect(hasDowngradeStep).toBe(false);

      // The patch-bump note should be present
      const hasPatchNote = report.migrationSteps.some((step) =>
        /patch bump/i.test(step),
      );
      expect(hasPatchNote).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// Case 4 — Empty registry
// ---------------------------------------------------------------------------

describe('empty-registry fixtures — graceful fallback for unknown forward transitions', () => {
  const emptyRegistryFixtures = NON_DOWNGRADE_FIXTURES.filter((f) => {
    // All non-downgrade, non-identical, non-same-minor-patch fixtures are
    // registry-lookup paths (minor or major forward bumps not in BREAKING_CHANGES).
    const [curMaj, curMin, curPat] = f.currentVersion.split('.').map(Number);
    const [tgtMaj, tgtMin, tgtPat] = f.targetVersion.split('.').map(Number);
    const isIdentical = curMaj === tgtMaj && curMin === tgtMin && curPat === tgtPat;
    const isUpPatch = curMaj === tgtMaj && curMin === tgtMin && tgtPat > curPat;
    return !isIdentical && !isUpPatch;
  });

  test.each(emptyRegistryFixtures.map((f) => [f.label, f] as const))(
    '%s',
    async (_label, fixture) => {
      const report = await checkCompatibility(
        fixture.currentVersion,
        fixture.targetVersion,
      );

      expect(report.isCompatible).toBe(true);
      expect(report.breakingChanges).toHaveLength(0);

      // Must NOT be treated as a downgrade
      const hasDowngradeStep = report.migrationSteps.some((step) =>
        /downgrade/i.test(step),
      );
      expect(hasDowngradeStep).toBe(false);

      // Should produce at least one informational step (no-known-changes note)
      expect(report.migrationSteps.length).toBeGreaterThan(0);
    },
  );
});

// ---------------------------------------------------------------------------
// Full corpus smoke-test — expectCompatible matches actual isCompatible
// ---------------------------------------------------------------------------

describe('full corpus — isCompatible matches expectCompatible for every fixture', () => {
  test.each(DOWNGRADE_FIXTURES.map((f) => [f.label, f] as const))(
    '%s',
    async (_label, fixture) => {
      const report = await checkCompatibility(
        fixture.currentVersion,
        fixture.targetVersion,
      );

      expect(report.isCompatible).toBe(fixture.expectCompatible);
    },
  );
});

// ---------------------------------------------------------------------------
// Canonical regression case — explicit single-scenario pinning
// ---------------------------------------------------------------------------

describe('canonical regression case — 1.2.3 → 1.2.1 (same-minor patch downgrade)', () => {
  /**
   * This is the exact scenario from the issue.  Before the fix, this call
   * returned isCompatible: true.  After the fix it must return false with a
   * downgrade warning.
   */
  it('flags 1.2.3 → 1.2.1 as incompatible downgrade', async () => {
    const report = await checkCompatibility('1.2.3', '1.2.1');

    expect(report.isCompatible).toBe(false);
    expect(report.breakingChanges).toHaveLength(0);
    expect(report.migrationSteps).not.toHaveLength(0);
    expect(report.migrationSteps[0]).toMatch(/downgrade/i);
  });

  it('migration steps for 1.2.3 → 1.2.1 reference both versions', async () => {
    const report = await checkCompatibility('1.2.3', '1.2.1');
    const text = report.migrationSteps.join('\n');

    expect(text).toContain('1.2.3');
    expect(text).toContain('1.2.1');
  });

  it('migration steps for 1.2.3 → 1.2.1 advise staying on current or upgrading', async () => {
    const report = await checkCompatibility('1.2.3', '1.2.1');

    // At least one advisory step should exist beyond the initial warning
    expect(report.migrationSteps.length).toBeGreaterThanOrEqual(2);
  });

  /**
   * Symmetry check: the reverse path (1.2.1 → 1.2.3) must be compatible.
   * This guards against over-eager guards that reject forward patches.
   */
  it('reverse 1.2.1 → 1.2.3 is a compatible up-patch', async () => {
    const report = await checkCompatibility('1.2.1', '1.2.3');

    expect(report.isCompatible).toBe(true);
    expect(report.breakingChanges).toHaveLength(0);
    expect(report.migrationSteps.some((s) => /patch bump/i.test(s))).toBe(true);
  });
});
