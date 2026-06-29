import { checkCompatibility } from '../src/utils/migration';

describe('Migration Compatibility', () => {
  describe('checkCompatibility', () => {
    it('returns isCompatible true with no breaking changes for a patch bump', async () => {
      const report = await checkCompatibility('1.0.0', '1.0.1');

      expect(report.isCompatible).toBe(true);
      expect(report.breakingChanges).toHaveLength(0);
    });

    it('returns isCompatible true with a note in migrationSteps for a patch bump', async () => {
      const report = await checkCompatibility('1.0.0', '1.0.5');

      expect(report.isCompatible).toBe(true);
      expect(report.migrationSteps).toHaveLength(1);
      expect(report.migrationSteps[0]).toMatch(/patch bump/i);
    });

    it('returns isCompatible true with no breaking changes for same version', async () => {
      const report = await checkCompatibility('1.0.0', '1.0.0');

      expect(report.isCompatible).toBe(true);
      expect(report.breakingChanges).toHaveLength(0);
      expect(report.migrationSteps).toHaveLength(0);
    });

    it('detects breaking changes for a known minor version bump', async () => {
      const report = await checkCompatibility('1.0.0', '1.1.0');

      expect(report.isCompatible).toBe(false);
      expect(report.breakingChanges.length).toBeGreaterThan(0);
    });

    it('returns correct breaking change module for 1.0.0 to 1.1.0', async () => {
      const report = await checkCompatibility('1.0.0', '1.1.0');

      expect(report.breakingChanges[0].module).toBe('Config');
    });

    it('detects breaking changes for a known major version bump', async () => {
      const report = await checkCompatibility('1.1.0', '2.0.0');

      expect(report.isCompatible).toBe(false);
      expect(report.breakingChanges.length).toBeGreaterThan(0);
    });

    it('returns all breaking changes from 1.1.0 to 2.0.0', async () => {
      const report = await checkCompatibility('1.1.0', '2.0.0');

      expect(report.breakingChanges).toHaveLength(5);
      const modules = report.breakingChanges.map((c) => c.module);
      expect(modules).toContain('Signer');
      expect(modules).toContain('Router');
      expect(modules).toContain('TWAP Oracle');
      expect(modules).toContain('FlashLoan');
      expect(modules).toContain('Events');
    });

    it('generates actionable migration steps for a major bump', async () => {
      const report = await checkCompatibility('1.1.0', '2.0.0');

      expect(report.migrationSteps.length).toBeGreaterThan(5);
      expect(report.migrationSteps[0]).toMatch(/upgrade/i);
      expect(report.migrationSteps.some((s) => s.includes('---'))).toBe(true);
      expect(report.migrationSteps.some((s) => s.includes('Old:'))).toBe(true);
      expect(report.migrationSteps.some((s) => s.includes('New:'))).toBe(true);
    });

    it('handles unknown current version gracefully', async () => {
      const report = await checkCompatibility('2.0.0', '2.1.0');

      expect(report.isCompatible).toBe(true);
      expect(report.breakingChanges).toHaveLength(0);
      expect(report.migrationSteps[0]).toMatch(/no known breaking changes/i);
    });

    it('handles unknown target version gracefully', async () => {
      const report = await checkCompatibility('1.1.0', '1.2.0');

      expect(report.isCompatible).toBe(true);
      expect(report.breakingChanges).toHaveLength(0);
      expect(report.migrationSteps[0]).toMatch(/no known breaking changes/i);
    });

    it('handles unknown major version transition gracefully', async () => {
      const report = await checkCompatibility('2.0.0', '3.0.0');

      expect(report.isCompatible).toBe(true);
      expect(report.breakingChanges).toHaveLength(0);
      expect(report.migrationSteps[0]).toMatch(/no known breaking changes/i);
    });

    it('aggregates breaking changes across multiple minor bumps', async () => {
      const report = await checkCompatibility('1.0.0', '2.0.0');

      expect(report.isCompatible).toBe(false);
      // 1.0.0->1.1.0 (1 change) + 1.1.0->2.0.0 (5 changes)
      expect(report.breakingChanges).toHaveLength(6);
    });

    it('reports downgrade as incompatible with warning steps', async () => {
      const report = await checkCompatibility('2.0.0', '1.0.0');

      expect(report.isCompatible).toBe(false);
      expect(report.breakingChanges).toHaveLength(0);
      expect(report.migrationSteps[0]).toMatch(/downgrade/i);
    });

    it('throws ValidationError for invalid semver in currentVersion', async () => {
      await expect(checkCompatibility('not-a-version', '1.0.0')).rejects.toThrow();
    });

    it('throws ValidationError for invalid semver in targetVersion', async () => {
      await expect(checkCompatibility('1.0.0', 'latest')).rejects.toThrow();
    });

    it('throws ValidationError for incomplete semver strings', async () => {
      await expect(checkCompatibility('1.0', '2.0.0')).rejects.toThrow();
      await expect(checkCompatibility('1.0.0', '2.0')).rejects.toThrow();
    });
  });
});
