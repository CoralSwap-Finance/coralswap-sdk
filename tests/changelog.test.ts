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
});
