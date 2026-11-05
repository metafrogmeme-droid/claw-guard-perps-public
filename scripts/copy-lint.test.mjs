// Tests for scripts/copy-lint.mjs. Banned words are built from pieces so this
// file itself stays clean under the lint it tests.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXCLUDED, findBanned } from './copy-lint.mjs';

const S = ['sa', 'fe'].join('');
const C = ['sc', 'am'].join('');
const SCRIPT = resolve(import.meta.dirname, 'copy-lint.mjs');

describe('findBanned', () => {
  it('finds both words, any case, inside other words, with line and column', () => {
    const hits = findBanned(`ok line\nThis is ${S.toUpperCase()}.\nno-${C}mer here, is${S}()`);
    expect(hits).toEqual([
      { line: 2, col: 9, word: S.toUpperCase() },
      { line: 3, col: 4, word: C },
      { line: 3, col: 20, word: S },
    ]);
  });

  it('returns nothing for clean text', () => {
    expect(findBanned('Allowed: within your limits\nBlocked by your rule: PAUSED\n')).toEqual([]);
  });

  it('excludes only the lockfile', () => {
    expect([...EXCLUDED].sort()).toEqual(['pnpm-lock.yaml']);
  });
});

describe('copy-lint CLI (self-test with a planted word)', () => {
  /** @type {string} */
  let dir = '';
  /** @param {string[]} args */
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  const run = () => spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'copy-lint-'));
    git('init', '-q');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 and names the file when a tracked file has a banned word', () => {
    writeFileSync(join(dir, 'README.md'), `This gate is ${S}.\n`);
    git('add', 'README.md');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('README.md:1:14');
  });

  it('exits 0 for clean tracked files and ignores excluded and untracked files', () => {
    writeFileSync(join(dir, 'README.md'), 'Allowed: within your limits\n');
    writeFileSync(join(dir, 'pnpm-lock.yaml'), `name: ${C}-pkg\n`);
    writeFileSync(join(dir, 'untracked.md'), `${S}\n`);
    git('add', 'README.md', 'pnpm-lock.yaml');
    expect(run().status).toBe(0);
  });

  it('skips binary files', () => {
    writeFileSync(join(dir, 'img.bin'), Buffer.from([0, 1, 2, ...Buffer.from(S)]));
    git('add', 'img.bin');
    expect(run().status).toBe(0);
  });
});
