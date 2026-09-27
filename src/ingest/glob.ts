/**
 * Wildcard expansion for the ingest CLI.
 *
 * `npm run ingest -- test/fixtures/*.xlsx` works in bash because bash expands the
 * star before the program ever sees it. PowerShell and cmd.exe do not: the CLI was
 * handed the literal "test/fixtures/*.xlsx" and reported "File not found", so the
 * documented quick-start failed on Windows, the platform this project is built on.
 * Expanding here makes the command mean the same thing in every shell.
 *
 * Deliberately small: `*`, `?` and `[...]` within path segments, which is what the
 * documentation uses. No `**` and no braces. Node's own fs.glob is still marked
 * experimental, and a CLI that prints an experimental-feature warning on every run
 * reads as broken.
 */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const WILDCARD = /[*?[]/;

/** One path segment's pattern as an anchored regular expression. */
function segmentPattern(segment: string): RegExp {
  let out = '';
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (ch === '*') out += '[^/\\\\]*';
    else if (ch === '?') out += '[^/\\\\]';
    else if (ch === '[') {
      const close = segment.indexOf(']', i + 1);
      if (close < 0) {
        out += '\\[';
        continue;
      }
      const body = segment.slice(i + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\');
      out += `[${body}]`;
      i = close;
    } else out += ch.replace(/[.+^${}()|\\\]]/g, '\\$&');
  }
  // Windows file names are case-insensitive, and so is the shell glob people expect there.
  return new RegExp(`^${out}$`, process.platform === 'win32' ? 'i' : '');
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Expand one argument. An argument with no wildcard is returned as written, whether
 * or not it exists, so a mistyped name is reported by the reader rather than
 * vanishing. A pattern that matches nothing returns an empty list; the caller says so.
 */
export async function expandPattern(pattern: string): Promise<string[]> {
  if (!WILDCARD.test(pattern)) return [pattern];

  const normalised = pattern.replace(/\\/g, '/');
  const segments = normalised.split('/');
  // Keep an absolute or drive-letter root as it was written.
  let bases: string[] = [''];
  if (segments[0] === '') {
    bases = ['/'];
    segments.shift();
  } else if (/^[a-z]:$/i.test(segments[0]!)) {
    bases = [`${segments.shift()!}/`];
  }

  for (let s = 0; s < segments.length; s++) {
    const segment = segments[s]!;
    const last = s === segments.length - 1;
    const next: string[] = [];
    if (!WILDCARD.test(segment)) {
      for (const base of bases) next.push(base ? join(base, segment) : segment);
    } else {
      const re = segmentPattern(segment);
      for (const base of bases) {
        let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
        try {
          entries = await readdir(base || '.', { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          // As in a shell, a wildcard does not match a hidden name unless it asks to.
          if (e.name.startsWith('.') && !segment.startsWith('.')) continue;
          if (!re.test(e.name)) continue;
          next.push(base ? join(base, e.name) : e.name);
        }
      }
    }
    // Only real directories lead anywhere, and only real files are results.
    const keep = await Promise.all(
      next.map(async (p) => ((last ? await isFile(p) : await isDirectory(p)) ? p : null)),
    );
    bases = keep.filter((p): p is string => p !== null);
  }
  return bases.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
