import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '..', '..');
const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };
const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8')) as { version: string; packages: Record<string, { version?: string }> };
// (A Windows checkout may have CRLF line ends.)
const headings = changelog.split(/\r?\n/).filter((l) => l.startsWith('## '));

/**
 * The Release workflow releases whatever `version` says once CI is green, and takes the notes
 * from the changelog section with that heading. These keep the three in step.
 */
describe('changelog and version', () => {
  it('heads every section with a version that starts with v', () => {
    expect(headings.length).toBeGreaterThan(0);
    for (const h of headings) expect(h).toMatch(/^## v\d+\.\d+\.\d+$/);
  });

  it('has the version of package.json as its topmost section', () => {
    expect(headings[0]).toBe(`## v${pkg.version}`);
  });

  it('lists versions newest first, each once', () => {
    const versions = headings.map((h) => h.slice(4).split('.').map(Number));
    const key = (v: number[]) => v[0] * 1e6 + v[1] * 1e3 + v[2];
    for (let i = 1; i < versions.length; i++) expect(key(versions[i - 1])).toBeGreaterThan(key(versions[i]));
  });

  it('has notes for the version about to be released', () => {
    const start = changelog.indexOf(headings[0]) + headings[0].length;
    const end = headings[1] ? changelog.indexOf(headings[1]) : changelog.length;
    expect(changelog.slice(start, end).trim().length).toBeGreaterThan(20);
  });

  it('package-lock.json carries the same version', () => {
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[''].version).toBe(pkg.version);
  });
});
