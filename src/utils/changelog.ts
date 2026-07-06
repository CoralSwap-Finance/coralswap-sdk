/**
 * A supported Keep a Changelog change type.
 *
 * The parser only recognizes the standard top-level categories
 * listed in the assignment requirements.
 */
export type ChangeType =
  | 'added'
  | 'changed'
  | 'deprecated'
  | 'removed'
  | 'fixed'
  | 'security';

/**
 * An individual changelog line item.
 */
export interface Change {
  type: ChangeType;
  description: string;
}

/**
 * A changelog release entry, containing version metadata and change items.
 */
export interface ChangelogEntry {
  version: string;
  date: string;
  changes: Change[];
}

const CHANGE_TYPE_MAP: Record<string, ChangeType> = {
  added: 'added',
  changed: 'changed',
  deprecated: 'deprecated',
  removed: 'removed',
  fixed: 'fixed',
  security: 'security',
};

/**
 * Regex for a Keep a Changelog release header.
 * Example: `## [1.1.0] - 2026-02-17`
 */
const VERSION_HEADER_REGEX = /^##\s*\[([^\]]+)\]\s*-\s*(\d{4}-\d{2}-\d{2})\s*$/;

/**
 * Regex for a section header like `### Added`.
 */
const SECTION_HEADER_REGEX = /^###\s+(.+?)\s*$/;

/**
 * Regex for a single bullet change item.
 */
const BULLET_REGEX = /^-\s*(.*)$/;

/**
 * Compare semver-style version strings in a natural descending order.
 *
 * This supports numeric parts and basic prerelease sorting for versions
 * like `1.2.0`, `1.2.0-beta`, and `1.10.0`.
 */
function compareVersionStrings(a: string, b: string): number {
  const normalize = (version: string) => {
    const trimmed = version.trim().replace(/^v/i, '');
    const [core, prerelease = ''] = trimmed.split('+')[0].split('-');
    const segments = core.split('.').map((segment) => {
      const value = Number(segment);
      return Number.isNaN(value) ? segment : value;
    });

    return { segments, prerelease };
  };

  const lhs = normalize(a);
  const rhs = normalize(b);
  const maxLen = Math.max(lhs.segments.length, rhs.segments.length);

  for (let index = 0; index < maxLen; index += 1) {
    const left = lhs.segments[index] ?? 0;
    const right = rhs.segments[index] ?? 0;

    if (typeof left === 'number' && typeof right === 'number') {
      if (left !== right) {
        return left < right ? -1 : 1;
      }
      continue;
    }

    const leftStr = String(left);
    const rightStr = String(right);
    if (leftStr !== rightStr) {
      return leftStr < rightStr ? -1 : 1;
    }
  }

  if (!lhs.prerelease && rhs.prerelease) {
    return 1;
  }

  if (lhs.prerelease && !rhs.prerelease) {
    return -1;
  }

  if (lhs.prerelease !== rhs.prerelease) {
    return lhs.prerelease < rhs.prerelease ? -1 : 1;
  }

  return 0;
}

/**
 * Parse a Keep a Changelog markdown document into structured release entries.
 *
 * The parser returns changelog entries sorted by version descending.
 * Unsupported sections are ignored and malformed lines produce clear errors.
 */
export function parseChangelog(content: string): ChangelogEntry[] {
  const normalizedContent = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalizedContent.split('\n');
  const entries: ChangelogEntry[] = [];

  let currentEntry: ChangelogEntry | null = null;
  let currentType: ChangeType | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const lineNumber = index + 1;
    const trimmedLine = rawLine.trim();

    if (!trimmedLine) {
      continue;
    }

    const versionMatch = VERSION_HEADER_REGEX.exec(trimmedLine);
    if (versionMatch) {
      const [, version, date] = versionMatch;
      currentEntry = {
        version: version.trim(),
        date: date.trim(),
        changes: [],
      };
      entries.push(currentEntry);
      currentType = null;
      continue;
    }

    if (/^##\s+/.test(trimmedLine)) {
      throw new Error(`Malformed changelog entry at line ${lineNumber}: invalid version header.`);
    }

    if (!currentEntry) {
      continue;
    }

    const sectionMatch = SECTION_HEADER_REGEX.exec(trimmedLine);
    if (sectionMatch) {
      const sectionName = sectionMatch[1].trim().toLowerCase();
      currentType = CHANGE_TYPE_MAP[sectionName] ?? null;
      continue;
    }

    const bulletMatch = BULLET_REGEX.exec(trimmedLine);
    if (bulletMatch) {
      if (!currentType) {
        continue;
      }

      const description = bulletMatch[1].trim();
      if (!description) {
        throw new Error(`Malformed changelog entry at line ${lineNumber}: missing bullet description.`);
      }

      currentEntry.changes.push({ type: currentType, description });
      continue;
    }

    if (trimmedLine.startsWith('-')) {
      throw new Error(`Malformed changelog entry at line ${lineNumber}: missing bullet description.`);
    }

    if (trimmedLine.startsWith('###')) {
      throw new Error(`Malformed changelog section at line ${lineNumber}: invalid section header.`);
    }

    throw new Error(`Malformed changelog content at line ${lineNumber}: ${rawLine}`);
  }

  return entries.sort((a, b) => compareVersionStrings(b.version, a.version));
}
