import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseChangelog, type ChangelogEntry } from '../src/utils/changelog';

const REPO_ROOT = join(__dirname, '..');
const CHANGELOG_PATH = join(REPO_ROOT, 'CHANGELOG.md');

function diffChangedFiles(baseRef: string, headRef: string): string[] {
  return execSync(`git diff --name-only ${baseRef}...${headRef}`, {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function getChangedFiles(): string[] {
  const baseSha = process.env.BASE_SHA;
  const headSha = process.env.HEAD_SHA;

  if (baseSha && headSha) {
    return diffChangedFiles(baseSha, headSha);
  }

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath && existsSync(eventPath)) {
    const event = JSON.parse(readFileSync(eventPath, 'utf8'));
    const pr = event.pull_request;
    if (pr?.base?.sha && pr?.head?.sha) {
      return diffChangedFiles(pr.base.sha, pr.head.sha);
    }
  }

  return diffChangedFiles('origin/main', 'HEAD');
}

function findUnreleased(entries: ChangelogEntry[]): ChangelogEntry | undefined {
  return entries.find((entry) => entry.version.toLowerCase() === 'unreleased');
}

function main(): void {
  const changedFiles = getChangedFiles();

  console.log(`Changed files (${changedFiles.length}):`);
  for (const file of changedFiles) {
    console.log(`  - ${file}`);
  }

  const touchesSrc = changedFiles.some((file) => file.startsWith('src/'));
  if (!touchesSrc) {
    console.log('No files under src/ changed; CHANGELOG entry not required.');
    return;
  }

  let entries: ChangelogEntry[];
  try {
    entries = parseChangelog(readFileSync(CHANGELOG_PATH, 'utf8'));
  } catch (error) {
    console.error('ERROR: CHANGELOG.md failed to parse.');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const unreleased = findUnreleased(entries);
  if (!unreleased) {
    console.error(
      'ERROR: src/ changed but no `## [Unreleased]` section found in CHANGELOG.md.',
    );
    console.error('Add an entry under a new `## [Unreleased]` section describing your change.');
    process.exit(1);
  }

  if (unreleased.changes.length === 0) {
    console.error('ERROR: `## [Unreleased]` section exists but contains no change entries.');
    process.exit(1);
  }

  console.log(`OK: CHANGELOG parses cleanly and has ${unreleased.changes.length} unreleased change(s).`);
}

main();
