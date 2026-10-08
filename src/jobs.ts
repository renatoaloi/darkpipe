/**
 * jobs.ts — long runs report a job id. There is no daemon: each long command
 * forks a child process and the record lives in `.darkpipe/jobs.json`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureDir, darkpipeStateDir } from './lib/paths.ts';
import { DarkpipeError, isoNow } from './lib/util.ts';

export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface JobRecord {
  id: string;
  pid: number;
  command: string[];
  label: string;
  status: JobStatus;
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
  log: string;
}

export interface JobsApi {
  /** Path of the jobs document, for reports. */
  readonly file: string;
  list(): Promise<JobRecord[]>;
  get(id: string): Promise<JobRecord | null>;
  /** Fork a long run and return its record. The child is detached. */
  spawn(command: string[], label: string): Promise<JobRecord>;
  cancel(id: string): Promise<JobRecord>;
  /**
   * Record the outcome of a run that this process IS the child of. The child
   * knows its own exit code; the parent's `refresh` can only see a dead pid.
   */
  finish(id: string, status: Exclude<JobStatus, 'running' | 'cancelled'>, exitCode: number): Promise<void>;
}

/** Set by `spawn` on the child, so the child can close its own record. */
export const JOB_ID_ENV = 'DARKPIPE_JOB_ID';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

export function makeJobs(repoRoot: string, cliPath: string): JobsApi {
  const dir = darkpipeStateDir(repoRoot);
  const file = path.join(dir, 'jobs.json');
  const logDir = path.join(dir, 'logs');

  const read = (): JobRecord[] => {
    if (!fs.existsSync(file)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(parsed) ? (parsed as JobRecord[]) : [];
    } catch {
      return [];
    }
  };

  const write = (records: JobRecord[]): void => {
    ensureDir(dir);
    fs.writeFileSync(file, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  };

  const refresh = (records: JobRecord[]): JobRecord[] => {
    let changed = false;
    for (const record of records) {
      if (record.status !== 'running') continue;
      if (!alive(record.pid)) {
        record.status = 'failed';
        record.ended_at = record.ended_at ?? isoNow();
        changed = true;
      }
    }
    if (changed) write(records);
    return records;
  };

  return {
    file,
    async list() {
      return refresh(read());
    },
    async get(id) {
      return refresh(read()).find((record) => record.id === id) ?? null;
    },
    async spawn(command, label) {
      ensureDir(logDir);
      const records = read();
      const id = `job_${String(records.length + 1).padStart(4, '0')}_${Date.now().toString(36)}`;
      const log = path.join(logDir, `${id}.log`);
      const descriptor = fs.openSync(log, 'a');
      const child = spawn(process.execPath, [cliPath, ...command], {
        detached: true,
        stdio: ['ignore', descriptor, descriptor],
        cwd: repoRoot,
        env: { ...process.env, [JOB_ID_ENV]: id },
      });
      child.unref();
      fs.closeSync(descriptor);
      const record: JobRecord = {
        id,
        pid: child.pid ?? -1,
        command,
        label,
        status: 'running',
        started_at: isoNow(),
        ended_at: null,
        exit_code: null,
        log,
      };
      records.push(record);
      write(records);
      return record;
    },
    async cancel(id) {
      const records = read();
      const record = records.find((entry) => entry.id === id);
      if (record === undefined) {
        throw new DarkpipeError(`unknown job "${id}"`, { hint: 'run `darkpipe jobs` to list the job ids' });
      }
      if (record.status === 'running') {
        try {
          process.kill(record.pid, 'SIGTERM');
        } catch {
          // Already gone: the record is still marked cancelled.
        }
        record.status = 'cancelled';
        record.ended_at = isoNow();
        write(records);
      }
      return record;
    },
    async finish(id, status, exitCode) {
      const records = read();
      const record = records.find((entry) => entry.id === id);
      // A cancelled record wins: the operator stopped it, we only report the exit.
      if (record === undefined || record.status === 'cancelled') return;
      record.status = status;
      record.exit_code = exitCode;
      record.ended_at = isoNow();
      write(records);
    },
  };
}
