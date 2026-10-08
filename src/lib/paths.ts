/**
 * paths.ts — repo root discovery and case paths. The default layout is
 * `cases/<case_id>/`, so an existing case folder stays readable.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fail } from './util.ts';

/** Walk up from `from` until a directory that looks like the pipeline repo. */
export function findRepoRoot(from: string = process.cwd()): string {
  let current = path.resolve(from);
  for (;;) {
    if (fs.existsSync(path.join(current, 'cases')) && fs.existsSync(path.join(current, 'openspec'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(from);
}

export function casesDir(repoRoot: string, casesDirName = 'cases'): string {
  return path.isAbsolute(casesDirName) ? casesDirName : path.join(repoRoot, casesDirName);
}

export function casePath(repoRoot: string, caseId: string, casesDirName = 'cases'): string {
  return path.join(casesDir(repoRoot, casesDirName), caseId);
}

export function requireCaseDir(repoRoot: string, caseId: string, casesDirName = 'cases'): string {
  const dir = casePath(repoRoot, caseId, casesDirName);
  if (!fs.existsSync(dir)) {
    fail(`case ${caseId} not found at ${dir}`, { hint: 'run `darkpipe case list` to see the registered cases' });
  }
  return dir;
}

export function darkpipeStateDir(repoRoot: string): string {
  return path.join(repoRoot, '.darkpipe');
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function relPath(repoRoot: string, absolute: string): string {
  const rel = path.relative(repoRoot, absolute);
  return rel.length === 0 ? '.' : rel;
}
