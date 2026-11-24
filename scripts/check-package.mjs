#!/usr/bin/env node
// Release metadata check (issue #889). Fails when:
//   - package.json has duplicate keys in any object (JSON.parse silently keeps
//     the last one, so the first definition a reader sees may not be the one used),
//   - the version is not valid semver,
//   - package.json, package-lock.json and .release-please-manifest.json disagree.
//
// Usage: node scripts/check-package.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function isValidSemver(version) {
  return typeof version === 'string' && SEMVER.test(version);
}

/**
 * Returns the dotted paths of keys that appear more than once in the same
 * object of a JSON text. Walks the raw text, so it sees what JSON.parse hides.
 */
export function findDuplicateKeys(text) {
  const duplicates = [];
  const stack = []; // each entry: { type: 'object' | 'array', keys: Set, path: string }
  let i = 0;

  const skipSpace = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };

  const readString = () => {
    // text[i] is the opening quote
    let out = '';
    i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\') {
        out += text[i] + text[i + 1];
        i += 2;
      } else {
        out += text[i++];
      }
    }
    i++; // closing quote
    return out;
  };

  let pendingKey = null;
  while (i < text.length) {
    skipSpace();
    const ch = text[i];
    const top = stack[stack.length - 1];
    if (ch === '{') {
      const path = top && pendingKey !== null ? (top.path ? `${top.path}.${pendingKey}` : pendingKey) : top ? top.path : '';
      stack.push({ type: 'object', keys: new Set(), path });
      pendingKey = null;
      i++;
    } else if (ch === '[') {
      const path = top && pendingKey !== null ? (top.path ? `${top.path}.${pendingKey}` : pendingKey) : top ? top.path : '';
      stack.push({ type: 'array', keys: new Set(), path });
      pendingKey = null;
      i++;
    } else if (ch === '}' || ch === ']') {
      stack.pop();
      pendingKey = null;
      i++;
    } else if (ch === '"') {
      const str = readString();
      skipSpace();
      if (top && top.type === 'object' && text[i] === ':') {
        if (top.keys.has(str)) duplicates.push(top.path ? `${top.path}.${str}` : str);
        top.keys.add(str);
        pendingKey = str;
        i++;
      } else {
        pendingKey = null;
      }
    } else if (ch === ',' || ch === ':') {
      if (ch === ',') pendingKey = null;
      i++;
    } else {
      // number, true, false, null
      while (i < text.length && !/[\s,}\]]/.test(text[i])) i++;
      pendingKey = null;
    }
  }
  return duplicates;
}

/** Everything wrong with the release metadata; an empty list means it is consistent. */
export function checkReleaseMetadata({ packageText, lockText, manifestText }) {
  const problems = [];

  for (const key of findDuplicateKeys(packageText)) {
    problems.push(`package.json has a duplicate key: ${key}`);
  }

  const pkg = JSON.parse(packageText);
  const lock = JSON.parse(lockText);
  const manifest = JSON.parse(manifestText);

  const versions = {
    'package.json': pkg.version,
    'package-lock.json': lock.version,
    'package-lock.json packages[""]': lock.packages?.['']?.version,
    '.release-please-manifest.json': manifest['.'],
  };

  for (const [source, version] of Object.entries(versions)) {
    if (!isValidSemver(version)) problems.push(`${source} has an invalid semver version: ${JSON.stringify(version)}`);
  }
  if (new Set(Object.values(versions)).size > 1) {
    problems.push(`versions disagree: ${JSON.stringify(versions)}`);
  }

  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = checkReleaseMetadata({
    packageText: readFileSync('package.json', 'utf8'),
    lockText: readFileSync('package-lock.json', 'utf8'),
    manifestText: readFileSync('.release-please-manifest.json', 'utf8'),
  });
  if (problems.length > 0) {
    for (const p of problems) console.error(`✗ ${p}`);
    process.exit(1);
  }
  console.log('✓ package metadata is consistent');
}
