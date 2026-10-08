/**
 * helpers.ts — test fixtures shared by every test file: a throwaway repo root,
 * a fake-adapter config, and a CLI runner that speaks JSON.
 *
 * No test may call Runware or YouTube: every test config selects `fake`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { silentWav } from '../src/lib/media.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(HERE, '..');
export const CLI_ENTRY = path.join(PACKAGE_ROOT, 'src', 'cli.ts');

export interface TempRepo {
  root: string;
  /** Absolute path inside the repo. */
  path(relative: string): string;
  /** Write a file, creating parents. */
  write(relative: string, content: string | Buffer): string;
  /** Read a file, or null. */
  read(relative: string): string | null;
  /** JSON.parse a file, or null. */
  json<T = any>(relative: string): T | null;
  exists(relative: string): boolean;
  cleanup(): void;
}

export function makeTempRepo(files: Record<string, string | Buffer> = {}): TempRepo {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'darkpipe-test-'));
  fs.mkdirSync(path.join(root, 'cases'), { recursive: true });
  fs.mkdirSync(path.join(root, 'openspec'), { recursive: true });
  fs.mkdirSync(path.join(root, 'custos'), { recursive: true });
  const repo: TempRepo = {
    root,
    path: (relative) => path.join(root, relative),
    write(relative, content) {
      const target = path.join(root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
      return target;
    },
    read(relative) {
      const target = path.join(root, relative);
      return fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    },
    json<T = any>(relative: string): T | null {
      const raw = repo.read(relative);
      return raw === null ? null : (JSON.parse(raw) as T);
    },
    exists(relative) {
      return fs.existsSync(path.join(root, relative));
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
  for (const [relative, content] of Object.entries(files)) {
    repo.write(relative, content);
  }
  return repo;
}

/** The config every test uses: no network anywhere. */
export function fakeConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    casesDir: 'cases',
    store: { adapter: 'sqlite', file: 'darkpipe.sqlite', legacy: 'kanban.sqlite' },
    files: { adapter: 'casefs', casesDir: 'cases' },
    media: { adapter: 'fake' },
    speech: { adapter: 'fake' },
    text: { adapter: 'fake' },
    render: { adapter: 'ffmpeg' },
    ledger: { adapter: 'jsonl', file: 'custos/gastos.jsonl' },
    publisher: { adapter: 'fake' },
    ...overrides,
  };
}

export function writeFakeConfig(repo: TempRepo, overrides: Record<string, unknown> = {}): void {
  repo.write('darkpipe.config.json', `${JSON.stringify(fakeConfig(overrides), null, 2)}\n`);
}

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
  /** Parsed stdout when it is JSON, else null. */
  json: any;
}

/** Run the CLI as the operator would, in a throwaway repo root. */
export function cli(root: string, args: string[], env: NodeJS.ProcessEnv = {}): CliRun {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  const stdout = result.stdout ?? '';
  let json: any = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = null;
  }
  return { code: result.status ?? -1, stdout, stderr: result.stderr ?? '', json };
}

export function readJsonFile<T = any>(absolute: string): T {
  return JSON.parse(fs.readFileSync(absolute, 'utf8')) as T;
}

export function exists(absolute: string): boolean {
  return fs.existsSync(absolute);
}

/** A narration block file the pipeline can measure: silence of `seconds`. */
export function silentAudio(seconds: number): Buffer {
  return silentWav(seconds);
}
