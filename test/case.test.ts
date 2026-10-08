/**
 * case.test.ts — tasks 3.2 and 3.3 verify, run through the real CLI in a
 * throwaway repo root:
 * - `exemplo` and `case_9_exemplo` are refused with no folder and no store row;
 * - a valid id creates the template files plus `02_narration_parts/` and
 *   `04_shots/v0/` with NO `03_shots.json`;
 * - the store row is backlog with priority max+1 and a reopened case advances;
 * - research writes a researched `01_script.md` and `05_estilo.json` and one
 *   ledger event; a failing text adapter keeps the templates and exits non-zero;
 *   `--no-research` warns in English and writes no ledger event.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRepo, writeFakeConfig, cli, PACKAGE_ROOT, type TempRepo } from './helpers.ts';

const REPO_TEMPLATES = path.resolve(PACKAGE_ROOT, '..', 'templates');
const TEMPLATES = ['01_script.md', '02_narration_script.md', '07_meta.yaml'];

/** Copy the channel templates into the throwaway repo root the CLI runs in. */
function seedTemplates(repo: TempRepo): void {
  for (const name of TEMPLATES) {
    repo.write(`templates/${name}`, fs.readFileSync(path.join(REPO_TEMPLATES, name)));
  }
}

function ledgerLines(repo: TempRepo): string[] {
  const raw = repo.read('custos/gastos.jsonl');
  if (raw === null) return [];
  return raw.split('\n').filter((line) => line.trim().length > 0);
}

test('refuses an id outside case_NNNN_slug and creates nothing', () => {
  const repo = makeTempRepo();
  try {
    seedTemplates(repo);
    writeFakeConfig(repo);
    for (const bad of ['exemplo', 'case_9_exemplo']) {
      const run = cli(repo.root, ['case', 'new', bad, 'A Title', '--vertical', 'dark_history', '--json']);
      assert.notEqual(run.code, 0, `${bad} must be refused`);
      assert.equal(run.json?.ok, false);
      assert.match(String(run.json?.error), /case_NNNN_slug|invalid/);
    }
    assert.ok(!repo.exists('cases/exemplo'), 'no folder for a refused id');
    assert.ok(!repo.exists('cases/case_9_exemplo'), 'no folder for a refused id');
    const list = cli(repo.root, ['case', 'list', '--json']);
    assert.equal(list.code, 0, list.stderr);
    assert.deepEqual(list.json.cases, [], 'no store row for a refused id');
  } finally {
    repo.cleanup();
  }
});

test('a valid id creates the templates and folders, and stores a backlog row', () => {
  const repo = makeTempRepo();
  try {
    seedTemplates(repo);
    writeFakeConfig(repo);
    const run = cli(repo.root, [
      'case',
      'new',
      'case_0009_exemplo',
      'The Example Case',
      '--vertical',
      'space_aviation',
      '--no-research',
      '--json',
    ]);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.json.ok, true);
    assert.equal(run.json.researched, false);

    for (const name of TEMPLATES) {
      assert.ok(repo.exists(`cases/case_0009_exemplo/${name}`), `${name} must exist`);
    }
    assert.ok(repo.exists('cases/case_0009_exemplo/02_narration_parts'), 'narration parts dir');
    assert.ok(repo.exists('cases/case_0009_exemplo/04_shots/v0'), 'shot version dir');
    assert.ok(!repo.exists('cases/case_0009_exemplo/03_shots.json'), 'a new case has no shot plan');

    // The template placeholders were filled.
    const meta = repo.read('cases/case_0009_exemplo/07_meta.yaml');
    assert.match(String(meta), /id: case_0009_exemplo/);
    assert.match(String(meta), /vertente: space_aviation/);

    const list = cli(repo.root, ['case', 'list', '--json']);
    assert.equal(list.json.cases.length, 1);
    const row = list.json.cases[0];
    assert.equal(row.id, 'case_0009_exemplo');
    assert.equal(row.estado, 'backlog');
    assert.equal(row.prioridade, 1);
    assert.match(String(row.data_criacao), /^\d{4}-\d{2}-\d{2}$/);
  } finally {
    repo.cleanup();
  }
});

test('a reopened case takes the next priority and moves to the end of the queue', () => {
  const repo = makeTempRepo();
  try {
    seedTemplates(repo);
    writeFakeConfig(repo);
    const open = (id: string) =>
      cli(repo.root, ['case', 'new', id, `Title ${id}`, '--vertical', 'pilot', '--no-research', '--json']);
    assert.equal(open('case_0009_exemplo').json.priority, 1);
    assert.equal(open('case_0002_beta').json.priority, 2);
    assert.equal(open('case_0009_exemplo').json.priority, 3, 'a reopened case is a new project');

    const list = cli(repo.root, ['case', 'list', '--json']);
    const ids = list.json.cases.map((row: { id: string }) => row.id);
    assert.deepEqual(ids, ['case_0002_beta', 'case_0009_exemplo'], 'queue order by priority');
    assert.equal(list.json.cases[1].prioridade, 3);
  } finally {
    repo.cleanup();
  }
});

test('research writes the guide and the style card and exactly one ledger event', () => {
  const repo = makeTempRepo();
  try {
    seedTemplates(repo);
    writeFakeConfig(repo);
    const run = cli(repo.root, [
      'case',
      'new',
      'case_0009_exemplo',
      'The Example Case',
      '--vertical',
      'dark_history',
      '--json',
    ]);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.json.researched, true);

    const guide = String(repo.read('cases/case_0009_exemplo/01_script.md'));
    assert.match(guide, /The case happened on a date the operator will check/, 'the guide is the researched script');
    assert.ok(!guide.includes('O roteiro do episódio'), 'the empty template was replaced');
    assert.ok(!guide.includes('## [0:00] COLD OPEN'), 'the guide is not the empty template');

    const style = repo.json<Record<string, unknown>>('cases/case_0009_exemplo/05_estilo.json');
    assert.ok(style, '05_estilo.json must exist');
    assert.equal(style.case, 'case_0009_exemplo');
    for (const key of ['combinacao', 'prefixo', 'sufixo', 'extra', 'variantes', 'passo', 'extra_manual', 'origem']) {
      assert.ok(key in (style as Record<string, unknown>), `style card has ${key}`);
    }
    assert.ok(Array.isArray(style.variantes) && style.variantes.length > 0, 'framing variants present');

    const lines = ledgerLines(repo);
    assert.equal(lines.length, 1, 'exactly one research cost event');
    const event = JSON.parse(lines[0]);
    assert.equal(event.kind, 'research');
    assert.equal(event.case, 'case_0009_exemplo');
    assert.equal(event.status, 'ok');
    assert.equal(typeof event.usd, 'number');
  } finally {
    repo.cleanup();
  }
});

test('a failing text adapter keeps the templates and exits non-zero', () => {
  const repo = makeTempRepo();
  try {
    seedTemplates(repo);
    writeFakeConfig(repo, { text: { adapter: 'failing' } });
    const run = cli(repo.root, [
      'case',
      'new',
      'case_0011_fail',
      'Failing Text Case',
      '--vertical',
      'engineering',
      '--json',
    ]);
    assert.notEqual(run.code, 0, 'a failed research must exit non-zero');
    assert.equal(run.json?.ok, false);
    assert.match(String(run.json?.error), /research failed/i);

    assert.ok(repo.exists('cases/case_0011_fail/01_script.md'), 'the template is kept');
    assert.match(String(repo.read('cases/case_0011_fail/01_script.md')), /O roteiro do episódio/);
    assert.ok(!repo.exists('cases/case_0011_fail/05_estilo.json'), 'no style card on failure');
    assert.ok(!repo.exists('cases/case_0011_fail/03_shots.json'));

    // Re-runnable: the same id can be opened again and filled in.
    writeFakeConfig(repo);
    const retry = cli(repo.root, [
      'case',
      'new',
      'case_0011_fail',
      'Failing Text Case',
      '--vertical',
      'engineering',
      '--json',
    ]);
    assert.equal(retry.code, 0, retry.stderr);
    assert.equal(retry.json.researched, true);
    assert.match(
      String(repo.read('cases/case_0011_fail/01_script.md')),
      /The case happened on a date the operator will check/,
    );
  } finally {
    repo.cleanup();
  }
});

test('--no-research warns in English and writes no ledger event', () => {
  const repo = makeTempRepo();
  try {
    seedTemplates(repo);
    writeFakeConfig(repo);
    const run = cli(repo.root, [
      'case',
      'new',
      'case_0009_exemplo',
      'The Example Case',
      '--vertical',
      'pilot',
      '--no-research',
      '--json',
    ]);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stderr, /without context|no research ran/i, 'the warning is English');
    assert.equal(ledgerLines(repo).length, 0, 'no research event was written');
    assert.ok(repo.exists('cases/case_0009_exemplo/01_script.md'), 'the template is written');
    assert.ok(!repo.exists('cases/case_0009_exemplo/05_estilo.json'));
  } finally {
    repo.cleanup();
  }
});

test('case show lists absolute file paths and refuses an unregistered id', () => {
  const repo = makeTempRepo();
  try {
    seedTemplates(repo);
    writeFakeConfig(repo);
    assert.equal(
      cli(repo.root, ['case', 'new', 'case_0009_exemplo', 'The Example', '--vertical', 'pilot', '--json']).code,
      0,
    );
    const show = cli(repo.root, ['case', 'show', 'case_0009_exemplo', '--json']);
    assert.equal(show.code, 0, show.stderr);
    assert.equal(show.json.ok, true);
    assert.equal(show.json.case.id, 'case_0009_exemplo');
    assert.ok(Array.isArray(show.json.files) && show.json.files.length > 0);
    for (const file of show.json.files as string[]) {
      assert.ok(path.isAbsolute(file), `${file} must be absolute`);
      assert.ok(file.startsWith(repo.path('cases/case_0009_exemplo')));
    }
    assert.ok(
      !(show.json.files as string[]).some((file) => file.endsWith('03_shots.json')),
      'no shot plan is listed',
    );

    const missing = cli(repo.root, ['case', 'show', 'case_0042_ghost', '--json']);
    assert.notEqual(missing.code, 0);
    assert.match(String(missing.json?.error), /not registered/i);
    assert.ok(!repo.exists('cases/case_0042_ghost'), 'show never creates a folder');
  } finally {
    repo.cleanup();
  }
});

test('case status refuses an unknown state', () => {
  const repo = makeTempRepo();
  try {
    seedTemplates(repo);
    writeFakeConfig(repo);
    assert.equal(
      cli(repo.root, ['case', 'new', 'case_0009_exemplo', 'The Example', '--vertical', 'pilot', '--no-research', '--json'])
        .code,
      0,
    );
    const bad = cli(repo.root, ['case', 'status', 'case_0009_exemplo', '--set', 'on_fire', '--json']);
    assert.notEqual(bad.code, 0);
    assert.match(String(bad.json?.error), /invalid/i);

    const ok = cli(repo.root, ['case', 'status', 'case_0009_exemplo', '--set', 'rendered', '--json']);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(ok.json.case.estado, 'rendered');
  } finally {
    repo.cleanup();
  }
});
