/**
 * costs-jobs.test.ts — task 7.1 verify.
 *
 * The costs document is a bare JSON array with no `total` key; `--case`/`--kind`
 * only drop events. Cancelling a job marks it `cancelled` and leaves the case
 * files written before the cancel on disk.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { makeTempRepo, writeFakeConfig, cli, type TempRepo } from './helpers.ts';

function event(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    at: '2026-10-06T12:00:00.000Z',
    case: 'case_0001_costs',
    shot: 1,
    kind: 'still',
    provider: 'fake',
    model: 'fake-still',
    usd: 0.03,
    tokens_in: null,
    tokens_out: null,
    latency_ms: 2,
    job_id: null,
    status: 'ok',
    ...overrides,
  };
}

function withLedger(repo: TempRepo): void {
  const lines = [
    event({ case: 'case_0001_costs', kind: 'still', usd: 0.03 }),
    event({ at: '2026-10-06T12:05:00.000Z', case: 'case_0002_costs', kind: 'clip', shot: 4, usd: 0.0807 }),
  ];
  repo.write('custos/gastos.jsonl', `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
}

test('costs --json prints a bare array and never a total', () => {
  const repo = makeTempRepo();
  try {
    writeFakeConfig(repo);
    withLedger(repo);

    const run = cli(repo.root, ['costs', '--json']);
    assert.equal(run.code, 0, run.stderr);
    assert.ok(Array.isArray(run.json), `stdout must be a bare array: ${run.stdout}`);
    assert.equal(run.json.length, 2);
    assert.ok(!run.stdout.includes('"total"'), 'the word total must not appear as a key');
    assert.ok(!('total' in run.json[0]), 'an event must carry no total');

    const text = cli(repo.root, ['costs']);
    assert.equal(text.code, 0, text.stderr);
    assert.equal(text.stdout.trim().split('\n').length, 2, 'text mode prints one line per event');
  } finally {
    repo.cleanup();
  }
});

test('cost filters only drop events', () => {
  const repo = makeTempRepo();
  try {
    writeFakeConfig(repo);
    withLedger(repo);

    const all = cli(repo.root, ['costs', '--json']);
    const byCase = cli(repo.root, ['costs', '--json', '--case', 'case_0001_costs']);
    assert.equal(byCase.code, 0, byCase.stderr);
    assert.equal(byCase.json.length, 1);
    assert.equal(byCase.json[0].case, 'case_0001_costs');
    assert.deepEqual(byCase.json[0], all.json[0], 'filtering must not rewrite the event');

    const byKind = cli(repo.root, ['costs', '--json', '--kind', 'clip']);
    assert.equal(byKind.code, 0, byKind.stderr);
    assert.equal(byKind.json.length, 1);
    assert.equal(byKind.json[0].kind, 'clip');

    assert.ok(!byKind.stdout.includes('"total"'), 'filters must not add an aggregate');
  } finally {
    repo.cleanup();
  }
});

test('cancelling a spawned job marks it cancelled and keeps the case folder', () => {
  const repo = makeTempRepo();
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
  child.unref();
  try {
    writeFakeConfig(repo);
    repo.write('cases/case_0001_jobs/keep.txt', 'bytes written before the cancel\n');
    const id = 'job_0001_test';
    repo.write(
      '.darkpipe/jobs.json',
      `${JSON.stringify(
        [
          {
            id,
            pid: child.pid,
            command: ['render', 'case_0001_jobs'],
            label: 'render case_0001_jobs',
            status: 'running',
            started_at: '2026-10-06T12:00:00.000Z',
            ended_at: null,
            exit_code: null,
            log: repo.path(`.darkpipe/logs/${id}.log`),
          },
        ],
        null,
        2,
      )}\n`,
    );

    const listed = cli(repo.root, ['jobs', '--json']);
    assert.equal(listed.code, 0, listed.stderr);
    assert.equal(listed.json.running, 1, 'the running job must be listed');

    const cancelled = cli(repo.root, ['jobs', 'cancel', id, '--json']);
    assert.equal(cancelled.code, 0, cancelled.stderr);
    assert.equal(cancelled.json.status, 'cancelled');

    const record = repo.json<Array<{ status: string }>>('.darkpipe/jobs.json');
    assert.equal(record?.[0].status, 'cancelled', 'the jobs document must show cancelled');
    assert.ok(repo.exists('cases/case_0001_jobs/keep.txt'), 'cancelling must not delete case files');
  } finally {
    try {
      process.kill(child.pid as number, 'SIGKILL');
    } catch {
      // already gone
    }
    repo.cleanup();
  }
});
