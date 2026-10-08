/**
 * jobs-status.test.ts — regression: a forked long run must end `done` when it
 * succeeded and `failed` when it did not. The parent can only see a dead pid, so
 * the child closes its own record; before the fix every finished job read
 * `failed`, even one that had written its output.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempRepo, writeFakeConfig, CLI_ENTRY } from './helpers.ts';
import { makeJobs } from '../src/jobs.ts';

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 20000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

test('a forked run that succeeds ends done', async () => {
  const repo = makeTempRepo();
  try {
    writeFakeConfig(repo);
    const jobs = makeJobs(repo.root, CLI_ENTRY);
    const record = await jobs.spawn(['doctor'], 'doctor');
    assert.equal(record.status, 'running');

    const settled = await waitFor(async () => (await jobs.get(record.id))?.status !== 'running');
    assert.ok(settled, 'the job never settled');
    const finished = await jobs.get(record.id);
    assert.equal(finished?.status, 'done', JSON.stringify(finished));
    assert.equal(finished?.exit_code, 0);
    assert.ok(finished?.ended_at);
  } finally {
    repo.cleanup();
  }
});

test('a forked run that fails ends failed with its exit code', async () => {
  const repo = makeTempRepo();
  try {
    writeFakeConfig(repo);
    const jobs = makeJobs(repo.root, CLI_ENTRY);
    const record = await jobs.spawn(['case', 'show', 'case_9999_missing'], 'case show');

    const settled = await waitFor(async () => (await jobs.get(record.id))?.status !== 'running');
    assert.ok(settled, 'the job never settled');
    const finished = await jobs.get(record.id);
    assert.equal(finished?.status, 'failed', JSON.stringify(finished));
    assert.equal(finished?.exit_code, 1);
  } finally {
    repo.cleanup();
  }
});
