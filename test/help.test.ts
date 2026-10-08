/**
 * help.test.ts — task 8.1 verify, from the darkpipe-cli spec:
 * `darkpipe --help` names the operator surface and does NOT name agenda, seed or
 * calendar; every command the spec lists has help of its own, and the operator
 * guide documents it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRepo, writeFakeConfig, cli, PACKAGE_ROOT } from './helpers.ts';

const COMMANDS = [
  'doctor',
  'config',
  'case',
  'compete',
  'narrate',
  'voice',
  'plan',
  'prompts',
  'timeline',
  'generate',
  'still',
  'render',
  'style',
  'shorts',
  'posts',
  'costs',
  'jobs',
  'publish',
];

const FORBIDDEN = ['agenda', 'seed', 'calendar'];

test('--help names the surface and never the excluded areas', () => {
  const repo = makeTempRepo();
  try {
    writeFakeConfig(repo);
    const run = cli(repo.root, ['--help']);
    assert.equal(run.code, 0, run.stderr);
    for (const command of COMMANDS) {
      assert.match(run.stdout, new RegExp(`\\b${command}\\b`), `--help must name ${command}`);
    }
    for (const forbidden of FORBIDDEN) {
      assert.ok(
        !new RegExp(`\\b${forbidden}\\b`, 'i').test(run.stdout),
        `--help must not name ${forbidden}`,
      );
    }
    // The spec calls these out by name in the scenario.
    for (const required of ['case', 'plan', 'generate', 'render', 'publish', 'costs']) {
      assert.match(run.stdout, new RegExp(`\\b${required}\\b`));
    }
  } finally {
    repo.cleanup();
  }
});

test('every command has its own help', () => {
  const repo = makeTempRepo();
  try {
    writeFakeConfig(repo);
    for (const command of COMMANDS) {
      const run = cli(repo.root, [command, '--help']);
      assert.equal(run.code, 0, `${command} --help exited ${run.code}: ${run.stderr}`);
      assert.match(run.stdout, new RegExp(`\\b${command}\\b`), `${command} --help must name itself`);
    }
  } finally {
    repo.cleanup();
  }
});

test('the operator guide documents every command', () => {
  const guide = fs.readFileSync(path.join(PACKAGE_ROOT, 'docs', 'commands.md'), 'utf8');
  for (const command of COMMANDS) {
    assert.ok(guide.includes(`darkpipe ${command}`), `docs/commands.md must document ${command}`);
  }
  // The guide lists what is out of scope, which is where those words belong.
  for (const excluded of FORBIDDEN) {
    assert.match(guide, new RegExp(excluded, 'i'), `docs must state ${excluded} is out of scope`);
  }
  assert.match(guide, /cost totals|cost aggregation/i);
  assert.match(guide, /HTTP media server/i);
});
