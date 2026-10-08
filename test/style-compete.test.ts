/**
 * style-compete.test.ts — task 3.3 verify for the two lighter commands:
 * `style` reads and writes the case style card through the files port, and
 * `compete` measures against the fake text adapter (no network).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRepo, writeFakeConfig, cli, PACKAGE_ROOT, type TempRepo } from './helpers.ts';

const REPO_TEMPLATES = path.resolve(PACKAGE_ROOT, '..', 'templates');

function seedTemplates(repo: TempRepo): void {
  for (const name of ['01_script.md', '02_narration_script.md', '07_meta.yaml']) {
    repo.write(`templates/${name}`, fs.readFileSync(path.join(REPO_TEMPLATES, name)));
  }
}

function openWithResearch(repo: TempRepo, id = 'case_0009_exemplo'): void {
  const run = cli(repo.root, ['case', 'new', id, 'The Example', '--vertical', 'dark_history', '--json']);
  assert.equal(run.code, 0, run.stderr);
}

test('style reads the card written by research', () => {
  const repo = makeTempRepo();
  try {
    seedTemplates(repo);
    writeFakeConfig(repo);
    openWithResearch(repo);

    const run = cli(repo.root, ['style', 'case_0009_exemplo', '--json']);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.json.ok, true);
    assert.equal(run.json.estilo.case, 'case_0009_exemplo');
    assert.equal(run.json.estilo.combinacao, 'fake documentary look');
    assert.ok(Array.isArray(run.json.estilo.variantes));
    assert.ok(path.isAbsolute(run.json.path));
  } finally {
    repo.cleanup();
  }
});

test('style --set rewrites the card through the files port', () => {
  const repo = makeTempRepo();
  try {
    seedTemplates(repo);
    writeFakeConfig(repo);
    openWithResearch(repo);

    const set = cli(repo.root, ['style', 'case_0009_exemplo', '--set', 'documentary 1960 · test', '--json']);
    assert.equal(set.code, 0, set.stderr);
    assert.equal(set.json.estilo.combinacao, 'documentary 1960 · test');

    const onDisk = repo.json<Record<string, unknown>>('cases/case_0009_exemplo/05_estilo.json');
    assert.equal(onDisk?.combinacao, 'documentary 1960 · test');
    assert.equal(onDisk?.case, 'case_0009_exemplo');
    // The rest of the card survives the edit.
    assert.ok(Array.isArray(onDisk?.variantes) && (onDisk?.variantes as unknown[]).length > 0);
  } finally {
    repo.cleanup();
  }
});

test('style refuses a case without a folder', () => {
  const repo = makeTempRepo();
  try {
    seedTemplates(repo);
    writeFakeConfig(repo);
    const run = cli(repo.root, ['style', 'case_0042_ghost', '--json']);
    assert.notEqual(run.code, 0);
    assert.match(String(run.json?.error), /has no folder|not registered/i);
  } finally {
    repo.cleanup();
  }
});

test('compete measures against the fake text adapter', () => {
  const repo = makeTempRepo();
  try {
    seedTemplates(repo);
    writeFakeConfig(repo);
    const run = cli(repo.root, ['compete', 'sodder children', '--json']);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.json.ok, true);
    assert.equal(run.json.subject, 'sodder children');
    assert.equal(run.json.measurement.note, 'fake competition measurement');

    // A paid attempt goes to the ledger, exactly once.
    const raw = repo.read('custos/gastos.jsonl');
    assert.ok(raw, 'compete records a cost event');
    const lines = String(raw).split('\n').filter((line) => line.trim().length > 0);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).kind, 'compete');
  } finally {
    repo.cleanup();
  }
});
