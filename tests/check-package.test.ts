import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'check-package.mjs');

function run(files: { pkg: string; lock?: string; manifest?: string }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-package-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), files.pkg);
    fs.writeFileSync(
      path.join(dir, 'package-lock.json'),
      files.lock ?? JSON.stringify({ version: '2.0.0', packages: { '': { version: '2.0.0' } } }),
    );
    fs.writeFileSync(path.join(dir, '.release-please-manifest.json'), files.manifest ?? '{ ".": "2.0.0" }');
    const result = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' });
    return { code: result.status, out: `${result.stdout}${result.stderr}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const goodPkg = JSON.stringify({ name: 'x', version: '2.0.0', scripts: { lint: 'eslint' } }, null, 2);

describe('scripts/check-package.mjs (#889)', () => {
  it('passes when the three versions agree and no key is duplicated', () => {
    expect(run({ pkg: goodPkg }).code).toBe(0);
  });

  it('fails on an invalid semver version', () => {
    const bad = goodPkg.replace('2.0.0', 'x.1.0');
    const r = run({ pkg: bad });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/invalid semver/);
  });

  it('fails when package.json and the release manifest disagree', () => {
    const r = run({ pkg: goodPkg, manifest: '{ ".": "2.1.0" }' });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/versions disagree/);
  });

  it('fails when package-lock.json has a different version', () => {
    const lock = JSON.stringify({ version: '1.9.0', packages: { '': { version: '1.9.0' } } });
    expect(run({ pkg: goodPkg, lock }).code).toBe(1);
  });

  it('fails on a duplicate script key and names it', () => {
    const dup = '{ "name": "x", "version": "2.0.0", "scripts": { "lint": "a", "lint": "b" } }';
    const r = run({ pkg: dup });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/duplicate key: scripts\.lint/);
  });

  it('does not flag the same key in different objects', () => {
    const ok = '{ "name": "x", "version": "2.0.0", "scripts": { "a": "1" }, "other": { "a": "2" } }';
    expect(run({ pkg: ok }).code).toBe(0);
  });
});
