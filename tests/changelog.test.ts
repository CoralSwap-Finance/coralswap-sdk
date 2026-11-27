import { readFileSync } from 'fs';
import { join } from 'path';
import { parseChangelog } from '../src/utils/changelog';

describe('Changelog Parser', () => {
  const sampleChangelog = `# Changelog

## [1.1.0] - 2026-02-17

### Added
- Pluggable \`Signer\` interface in \`src/types/common.ts\` for wallet adapter support
- \`KeypairSigner\` default implementation in \`src/utils/signer.ts\`

### Changed
- \`CoralSwapClient\` now accepts both \`secretKey\` and \`signer\` config options
- \`submitTransaction()\` now awaits \`signer.signTransaction()\`

### Backward Compatible
- Existing \`secretKey\` usage continues to work unchanged
`;

  it('parses entries with supported change types and ignores unsupported sections', () => {
    const entries = parseChangelog(sampleChangelog);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      version: '1.1.0',
      date: '2026-02-17',
      changes: [
        {
          type: 'added',
          description: 'Pluggable `Signer` interface in `src/types/common.ts` for wallet adapter support',
        },
        {
          type: 'added',
          description: '`KeypairSigner` default implementation in `src/utils/signer.ts`',
        },
        {
          type: 'changed',
          description: '`CoralSwapClient` now accepts both `secretKey` and `signer` config options',
        },
        {
          type: 'changed',
          description: '`submitTransaction()` now awaits `signer.signTransaction()`',
        },
      ],
    });
  });

  it('sorts entries by version descending', () => {
    const content = `# Changelog

## [1.0.0] - 2025-12-31

### Added
- First release

## [1.2.0] - 2026-01-15

### Fixed
- Minor bug fix

## [1.1.0] - 2026-01-01

### Changed
- Updated behavior
`;

    const entries = parseChangelog(content);
    expect(entries.map((entry) => entry.version)).toEqual(['1.2.0', '1.1.0', '1.0.0']);
  });

  it('throws when a version header is malformed', () => {
    const invalidChangelog = `# Changelog

## 1.0.0 - 2025-12-31

### Added
- First release
`;

    expect(() => parseChangelog(invalidChangelog)).toThrow('invalid version header');
  });

  it('throws when a bullet has no description', () => {
    const invalidChangelog = `# Changelog

## [1.0.1] - 2026-03-03

### Fixed
-   
`;

    expect(() => parseChangelog(invalidChangelog)).toThrow('missing bullet description');
  });

  it('parses an [Unreleased] entry without a date', () => {
    const content = `# Changelog

## [Unreleased]

### Added
- CI check requiring a changelog entry for src/ changes

## [1.0.0] - 2026-01-01

### Changed
- First release
`;

    const entries = parseChangelog(content);
    const unreleased = entries.find((entry) => entry.version === 'Unreleased');

    expect(unreleased).toBeDefined();
    expect(unreleased?.date).toBeUndefined();
    expect(unreleased?.changes).toEqual([
      { type: 'added', description: 'CI check requiring a changelog entry for src/ changes' },
    ]);
  });

  it('throws when an unreleased header is malformed (missing brackets)', () => {
    const invalidChangelog = `# Changelog

## Unreleased

### Added
- Some change
`;

    expect(() => parseChangelog(invalidChangelog)).toThrow('invalid version header');
  });

  it('parses a [HEAD] entry without a date', () => {
    const content = `# Changelog

## [HEAD]

### Added
- Work in progress not yet cut as a release

## [1.0.0] - 2026-01-01

### Changed
- First release
`;

    const entries = parseChangelog(content);
    const head = entries.find((entry) => entry.version === 'HEAD');

    expect(head).toBeDefined();
    expect(head?.date).toBeUndefined();
    expect(head?.changes).toEqual([
      { type: 'added', description: 'Work in progress not yet cut as a release' },
    ]);
  });

  it('parses both [Unreleased] and [HEAD] headers in the same changelog', () => {
    const content = `# Changelog

## [Unreleased]

### Fixed
- An unreleased fix

## [HEAD]

### Added
- A head entry

## [1.1.0] - 2026-02-17

### Changed
- A released change
`;

    const entries = parseChangelog(content);

    expect(entries.map((entry) => entry.version)).toEqual(
      expect.arrayContaining(['Unreleased', 'HEAD', '1.1.0']),
    );

    // Undated headers must not pick up a date from a neighbouring release.
    expect(entries.find((e) => e.version === 'Unreleased')?.date).toBeUndefined();
    expect(entries.find((e) => e.version === 'HEAD')?.date).toBeUndefined();
    expect(entries.find((e) => e.version === '1.1.0')?.date).toBe('2026-02-17');
  });

  it("parses the repository's own CHANGELOG.md, which opens with [Unreleased]", () => {
    const repoChangelog = readFileSync(join(__dirname, '..', 'CHANGELOG.md'), 'utf8');

    const entries = parseChangelog(repoChangelog);

    expect(entries.length).toBeGreaterThan(0);

    const unreleased = entries.find((entry) => entry.version === 'Unreleased');
    expect(unreleased).toBeDefined();
    expect(unreleased?.date).toBeUndefined();
    expect(unreleased!.changes.length).toBeGreaterThan(0);

    // A dated release must still parse with its date intact.
    const dated = entries.filter((entry) => entry.date !== undefined);
    expect(dated.length).toBeGreaterThan(0);
    for (const entry of dated) {
      expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
