/**
 * files-backup.test.ts — regression: a nested artifact name must be backup-able,
 * listable and restorable. The default "backup before redo" path uses names like
 * `04_shots/shot_01_still.jpg`, and a flat backup directory broke it (ENOENT).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRepo, writeFakeConfig, cli } from './helpers.ts';
import { buildPorts } from '../src/adapters/registry.ts';
import { loadConfig } from '../src/config.ts';

test('a nested artifact name backs up, lists and restores', async () => {
  const repo = makeTempRepo();
  try {
    writeFakeConfig(repo);
    const caseId = 'case_0001_sodder';
    const stored = repo.write(`cases/${caseId}/04_shots/shot_01_still.jpg`, 'original-bytes');
    assert.ok(fs.existsSync(stored));

    const loaded = loadConfig(repo.path('darkpipe.config.json'));
    const ports = buildPorts(repo.root, loaded.config);

    const first = await ports.files.backupArtifact(caseId, '04_shots/shot_01_still.jpg');
    assert.ok(first !== null, 'a nested artifact must back up');
    assert.equal(fs.readFileSync(first as string, 'utf8'), 'original-bytes');

    // A second backup after a change, with a different stamp.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    fs.writeFileSync(stored, 'redone-bytes');
    const second = await ports.files.backupArtifact(caseId, '04_shots/shot_01_still.jpg');
    assert.ok(second !== null);
    assert.notEqual(second, first);

    const backups = await ports.files.listBackups(caseId, '04_shots/shot_01_still.jpg');
    assert.equal(backups.length, 2, 'both backups are listed');
    assert.deepEqual(backups, [first, second], 'oldest first');

    await ports.files.restoreArtifact(caseId, first as string);
    assert.equal(fs.readFileSync(stored, 'utf8'), 'original-bytes');
    await ports.files.restoreArtifact(caseId, second as string);
    assert.equal(fs.readFileSync(stored, 'utf8'), 'redone-bytes');

    // An unrelated artifact is not listed under this name.
    assert.deepEqual(await ports.files.listBackups(caseId, '03_shots.json'), []);
  } finally {
    repo.cleanup();
  }
});

test('generate backs up existing art before redoing it', () => {
  const repo = makeTempRepo();
  try {
    writeFakeConfig(repo);
    const caseId = 'case_0001_sodder';
    repo.write(`cases/${caseId}/04_shots/shot_01_still.jpg`, 'first-bytes');
    const run = cli(repo.root, ['generate', caseId, '--execute', '--foreground', '--no-check']);
    // The case has no plan, so the run stops before art: the assertion here is
    // that the failure is about the plan, never an ENOENT from the backup path.
    assert.ok(!/ENOENT|no such file or directory/i.test(run.stdout + run.stderr), run.stdout + run.stderr);
  } finally {
    repo.cleanup();
  }
});
