#!/usr/bin/env node
// copy-lint: fail if any tracked text file contains a banned word (product wording rule:
// only the three verdict strings, never a verdict-like label).
// The words are matched case-insensitively anywhere, including inside identifiers, because our own helpers
// must not be named with them either. The pattern is built from pieces so this file stays clean.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const BANNED = new RegExp([['sa', 'fe'].join(''), ['sc', 'am'].join('')].join('|'), 'gi');

/** Only the lockfile (third-party identifiers). Every other tracked file, docs included, is checked. */
export const EXCLUDED = new Set(['pnpm-lock.yaml']);

/**
 * @param {string} text
 * @returns {{ line: number, col: number, word: string }[]}
 */
export function findBanned(text) {
  /** @type {{ line: number, col: number, word: string }[]} */
  const hits = [];
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(BANNED)) hits.push({ line: i + 1, col: m.index + 1, word: m[0] });
  });
  return hits;
}

function main() {
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  let count = 0;
  for (const file of files) {
    if (EXCLUDED.has(file)) continue;
    const buf = readFileSync(file);
    if (buf.includes(0)) continue; // binary
    for (const h of findBanned(buf.toString('utf8'))) {
      console.error(`${file}:${String(h.line)}:${String(h.col)}: banned word "${h.word}"`);
      count++;
    }
  }
  if (count > 0) {
    console.error(`copy-lint: ${String(count)} banned word(s). Use only the three verdict strings.`);
    process.exitCode = 1;
  } else {
    console.log(`copy-lint: ${String(files.length)} tracked files checked, no banned words.`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
