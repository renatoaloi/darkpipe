/**
 * doctor.test.ts — task 2.2 verify: `doctor --json` lists each adapter name,
 * reports RUNWARE_API_KEY as present or missing without printing its value, and
 * exits non-zero when the config file carries a secret-shaped value.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempRepo, writeFakeConfig, cli, fakeConfig } from './helpers.ts';

test('doctor lists the adapters and never prints a secret value', () => {
  const repo = makeTempRepo();
  try {
    const secret = 'Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lm';
    writeFakeConfig(repo);
    const run = cli(repo.root, ['doctor', '--json'], { RUNWARE_API_KEY: secret });
    assert.equal(run.code, 0, run.stderr);
    assert.ok(run.json, `stdout must be JSON: ${run.stdout}`);
    assert.equal(run.json.ok, true);
    for (const port of ['store', 'files', 'media', 'speech', 'text', 'render', 'ledger', 'publisher']) {
      assert.ok(run.json.adapters[port], `doctor must name the ${port} adapter`);
    }
    assert.equal(run.json.credentials.RUNWARE_API_KEY, 'present');
    assert.ok(!run.stdout.includes(secret), 'the key value must not appear in the output');
    assert.ok(!run.stderr.includes(secret), 'the key value must not appear on stderr');
  } finally {
    repo.cleanup();
  }
});

test('doctor reports a missing credential without failing', () => {
  const repo = makeTempRepo();
  try {
    writeFakeConfig(repo);
    const run = cli(repo.root, ['doctor', '--json'], { RUNWARE_API_KEY: '' });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.json.credentials.RUNWARE_API_KEY, 'missing');
  } finally {
    repo.cleanup();
  }
});

test('doctor exits non-zero when the config carries a secret', () => {
  const repo = makeTempRepo();
  try {
    const secret = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';
    const config = fakeConfig();
    (config.media as Record<string, unknown>).api_key = secret;
    repo.write('darkpipe.config.json', JSON.stringify(config, null, 2));
    const run = cli(repo.root, ['doctor', '--json']);
    assert.notEqual(run.code, 0, 'an inline secret must fail doctor');
    assert.match(run.stdout + run.stderr, /api_key/);
    assert.ok(!run.stdout.includes(secret), 'doctor must not print the secret');
  } finally {
    repo.cleanup();
  }
});

test('config get prints one value and config set refuses a secret', () => {
  const repo = makeTempRepo();
  try {
    writeFakeConfig(repo);
    const get = cli(repo.root, ['config', 'get', 'media.adapter', '--json']);
    assert.equal(get.code, 0, get.stderr);
    assert.equal(get.json.value, 'fake');

    const set = cli(repo.root, ['config', 'set', 'media.adapter', 'AbCdEfGhIjKlMnOpQrStUvWxYz012345']);
    assert.notEqual(set.code, 0);
  } finally {
    repo.cleanup();
  }
});
