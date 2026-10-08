/**
 * generate.test.ts — task 5.2 verify (plus the narration/voice/copy commands
 * that share this cost path).
 *
 * Every case here runs the real CLI with the `fake` adapters, so no test opens a
 * socket to Runware or YouTube. The case folder is written by hand: a live plan,
 * a lock that anchors it to the recorded narration, and the audio files the lock
 * hashes were taken from.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeTempRepo, writeFakeConfig, cli, type TempRepo } from './helpers.ts';
import { narrationHash } from '../src/domain/narration.ts';

const READY = 'case_0101_ready';
const PENDING = 'case_0102_pending';
const UNANCHORED = 'case_0103_unanchored';
const NARRATE = 'case_0104_narrate';

const BLOCK_ONE = 'On Christmas Eve 1945 a house burned and four children were never found.';
const BLOCK_TWO = 'The file stayed open for eighty years and someone wrote to the same office every year.';

const SCRIPT = [
  '# Narration',
  '',
  '## §1 — salvar como `01_cold_open.mp3`',
  '',
  BLOCK_ONE,
  '',
  '## §2 — salvar como `02_file.mp3`',
  '',
  BLOCK_TWO,
  '',
].join('\n');

interface ShotSpec {
  shot_num: number;
  tipo: 'image' | 'video';
  bloco: number;
  prompt: string;
  ancora: string;
  duracao_s: number;
  span: [number, number];
}

function shots(placeholder: boolean): ShotSpec[] {
  return [
    { shot_num: 1, tipo: 'image', bloco: 2, prompt: 'a lone farmhouse on a hill at night, one lit window', ancora: BLOCK_ONE, duracao_s: 0, span: [0, 0.5] },
    { shot_num: 2, tipo: 'video', bloco: 2, prompt: 'flames and thick smoke rising over the farmhouse', ancora: BLOCK_ONE, duracao_s: 1, span: [0.5, 1] },
    { shot_num: 3, tipo: 'image', bloco: 3, prompt: 'an open case file on a desk in dim light', ancora: BLOCK_TWO, duracao_s: 0, span: [0, 0.5] },
    {
      shot_num: 4,
      tipo: 'image',
      bloco: 3,
      prompt: placeholder ? '[A DEFINIR] illustrate: someone wrote every year' : 'a handwritten letter on a desk, close up',
      ancora: BLOCK_TWO,
      duracao_s: 0,
      span: [0.5, 1],
    },
  ];
}

/** A lock whose block hashes match the narration the files port can read. */
function writeLock(repo: TempRepo, caseId: string): void {
  repo.write(
    `cases/${caseId}/03_plano_narracao.lock.json`,
    JSON.stringify(
      {
        case_id: caseId,
        gerado_em: '2026-10-06T00:00:00',
        fonte_texto: '02_narration_script.md',
        blocos: [
          { i: 0, mp3: '01_cold_open.mp3', dur: 10, hash: narrationHash(BLOCK_ONE), texto: BLOCK_ONE },
          { i: 1, mp3: '02_file.mp3', dur: 11, hash: narrationHash(BLOCK_TWO), texto: BLOCK_TWO },
        ],
      },
      null,
      2,
    ),
  );
}

interface CaseOptions {
  placeholder?: boolean;
  anchored?: boolean;
  audio?: boolean;
}

function writeCase(repo: TempRepo, caseId: string, options: CaseOptions = {}): void {
  const { placeholder = false, anchored = true, audio = true } = options;
  repo.write(`cases/${caseId}/02_narration_script.md`, SCRIPT);
  repo.write(
    `cases/${caseId}/03_shots.json`,
    JSON.stringify({ case_id: caseId, titulo: 'The Test Case', shots: shots(placeholder) }, null, 2),
  );
  repo.write(
    `cases/${caseId}/07_meta.yaml`,
    `id: ${caseId}\ntitle_en: "The Test Case"\nvertente: dark_history\nlanguage: en\nstatus: backlog\n`,
  );
  if (audio) {
    repo.write(`cases/${caseId}/02_narration_parts/01_cold_open.mp3`, '');
    repo.write(`cases/${caseId}/02_narration_parts/02_file.mp3`, '');
  }
  if (anchored) writeLock(repo, caseId);
}

function ledgerRows(repo: TempRepo): Array<Record<string, unknown>> {
  const raw = repo.read('custos/gastos.jsonl') ?? '';
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function ledgerSize(repo: TempRepo): number {
  const file = repo.path('custos/gastos.jsonl');
  return fs.existsSync(file) ? fs.statSync(file).size : 0;
}

// --------------------------------------------------------------- generate

test('a dry run leaves the ledger byte size unchanged and writes no art', () => {
  const repo = makeTempRepo();
  try {
    writeFakeConfig(repo);
    writeCase(repo, READY);
    const before = ledgerSize(repo);

    const run = cli(repo.root, ['generate', READY, '--json']);
    assert.equal(run.code, 0, run.stderr + run.stdout);
    assert.equal(run.json.ok, true, run.stdout);
    assert.equal(run.json.dry_run, true);
    assert.equal(run.json.shots.length, 4, 'a whole-case dry run lists every shot');

    assert.equal(ledgerSize(repo), before, 'a dry run must not append a ledger event');
    assert.equal(before, 0, 'the fixture starts with no ledger');
    assert.ok(!repo.exists(`cases/${READY}/04_shots/shot_01_still.jpg`), 'a dry run writes no still');
  } finally {
    repo.cleanup();
  }
});

test('an unanchored plan is refused, naming the repair commands', () => {
  const repo = makeTempRepo();
  try {
    writeFakeConfig(repo);
    writeCase(repo, UNANCHORED, { anchored: false });

    const run = cli(repo.root, ['generate', UNANCHORED, '--json']);
    assert.notEqual(run.code, 0, 'an unanchored plan must be refused');
    assert.equal(run.json.ok, false);
    assert.match(String(run.json.error), /plan anchor/, 'must name `darkpipe plan anchor`');
    assert.match(String(run.json.error), /plan check/, 'must name `darkpipe plan check`');
    assert.equal(ledgerSize(repo), 0, 'a refusal spends nothing');
    assert.ok(!repo.exists(`cases/${UNANCHORED}/04_shots/shot_01_still.jpg`));

    // `--no-check` overrides ONLY that refusal, and only when passed explicitly.
    const forced = cli(repo.root, ['generate', UNANCHORED, '--no-check', '--json']);
    assert.equal(forced.code, 0, forced.stderr + forced.stdout);
    assert.equal(forced.json.dry_run, true);
  } finally {
    repo.cleanup();
  }
});

test('--execute without --foreground forks a job and returns its id', () => {
  const repo = makeTempRepo();
  try {
    writeFakeConfig(repo);
    writeCase(repo, READY);

    const run = cli(repo.root, ['generate', READY, '--execute', '--json']);
    assert.equal(run.code, 0, run.stderr + run.stdout);
    assert.equal(run.json.ok, true, run.stdout);
    assert.match(String(run.json.job_id), /^job_/, 'the JSON must carry the job id');
    assert.equal(run.json.status, 'running');
    assert.ok(repo.exists('.darkpipe/jobs.json'), 'the job record must be written');
  } finally {
    repo.cleanup();
  }
});

test('--block does not refuse on a pending prompt outside the block; the whole case does', () => {
  const repo = makeTempRepo();
  try {
    writeFakeConfig(repo);
    writeCase(repo, PENDING, { placeholder: true });

    const scoped = cli(repo.root, ['generate', PENDING, '--block', '2', '--json']);
    assert.equal(scoped.code, 0, scoped.stderr + scoped.stdout);
    assert.equal(scoped.json.ok, true, scoped.stdout);
    assert.deepEqual(
      scoped.json.shots.map((shot: { shot: number }) => shot.shot),
      [1, 2],
      'only block 2 is in scope',
    );

    const whole = cli(repo.root, ['generate', PENDING, '--json']);
    assert.notEqual(whole.code, 0, 'the whole-case run must refuse');
    assert.equal(whole.json.ok, false);
    assert.match(String(whole.json.error), /shot 4/, 'the refusal names the shot with no prompt');
    assert.match(String(whole.json.error), /A DEFINIR/);
    assert.equal(ledgerSize(repo), 0);
  } finally {
    repo.cleanup();
  }
});

test('every executed attempt appends exactly one event with the cost-events fields', () => {
  const repo = makeTempRepo();
  try {
    writeFakeConfig(repo);
    writeCase(repo, READY);

    const run = cli(repo.root, ['generate', READY, '--execute', '--foreground', '--json']);
    assert.equal(run.code, 0, run.stderr + run.stdout);
    assert.equal(run.json.ok, true, run.stdout);
    assert.equal(run.json.dry_run, undefined);

    const rows = ledgerRows(repo);
    assert.equal(rows.length, 4, `one event per attempt, got ${JSON.stringify(rows)}`);
    const required = ['at', 'case', 'shot', 'kind', 'provider', 'model', 'usd', 'tokens_in', 'tokens_out', 'latency_ms', 'job_id', 'status'];
    for (const event of rows) {
      for (const field of required) assert.ok(field in event, `event is missing ${field}: ${JSON.stringify(event)}`);
      assert.equal(event.case, READY);
      assert.equal(event.status, 'ok');
      assert.equal(typeof event.usd, 'number');
      assert.equal(typeof event.at, 'string');
      assert.ok(!Number.isNaN(Date.parse(String(event.at))), '`at` must be an ISO-8601 timestamp');
    }
    assert.deepEqual(
      rows.map((event) => Number(event.shot)).sort((a, b) => a - b),
      [1, 2, 3, 4],
    );
    assert.deepEqual([...new Set(rows.map((event) => String(event.kind)))].sort(), ['clip', 'still']);

    for (const relative of ['04_shots/shot_01_still.jpg', '04_shots/shot_02.mp4', '04_shots/shot_03_still.jpg', '04_shots/shot_04_still.jpg']) {
      assert.ok(repo.exists(`cases/${READY}/${relative}`), `${relative} must be written`);
    }
  } finally {
    repo.cleanup();
  }
});

// --------------------------------------------------------------- redo

test('--force redoes existing art and records the second run too', () => {
  const repo = makeTempRepo();
  try {
    writeFakeConfig(repo);
    writeCase(repo, READY);

    const first = cli(repo.root, ['generate', READY, '--execute', '--foreground', '--json']);
    assert.equal(first.code, 0, first.stderr + first.stdout);
    assert.equal(ledgerRows(repo).length, 4);

    const redo = cli(repo.root, ['generate', READY, '--execute', '--foreground', '--force', '--json']);
    assert.equal(redo.code, 0, redo.stderr + redo.stdout);
    assert.equal(ledgerRows(repo).length, 8, 'every attempt of the redo is recorded');
    assert.ok(repo.exists(`cases/${READY}/04_shots/shot_01_still.jpg`), 'the art is rewritten');
  } finally {
    repo.cleanup();
  }
});

// --------------------------------------------------------------- narrate

test('narrate is a dry run by default and never overwrites recorded narration', () => {
  const repo = makeTempRepo();
  try {
    writeFakeConfig(repo);
    writeCase(repo, READY); // audio already recorded
    const recordedBefore = repo.read(`cases/${READY}/02_narration_parts/01_cold_open.mp3`);

    const dry = cli(repo.root, ['narrate', READY, '--json']);
    assert.equal(dry.code, 0, dry.stderr + dry.stdout);
    assert.equal(dry.json.dry_run, true);
    assert.deepEqual(dry.json.to_synthesize, [], 'an existing recording is kept');
    assert.equal(ledgerSize(repo), 0, 'a narrate dry run writes nothing');

    // A case with a script but no audio yet: the dry run lists the blocks.
    writeCase(repo, NARRATE, { anchored: false, audio: false });
    const plan = cli(repo.root, ['narrate', NARRATE, '--json']);
    assert.equal(plan.code, 0, plan.stderr + plan.stdout);
    assert.equal(plan.json.to_synthesize.length, 2);
    assert.equal(ledgerSize(repo), 0);

    const execute = cli(repo.root, ['narrate', NARRATE, '--execute', '--foreground', '--json']);
    assert.equal(execute.code, 0, execute.stderr + execute.stdout);
    assert.ok(repo.exists(`cases/${NARRATE}/02_narration_parts/01_cold_open.mp3`));
    assert.ok(repo.exists(`cases/${NARRATE}/02_narration_parts/02_file.mp3`));
    const events = ledgerRows(repo);
    assert.equal(events.length, 2);
    assert.deepEqual([...new Set(events.map((event) => String(event.kind)))], ['narration']);

    assert.equal(repo.read(`cases/${READY}/02_narration_parts/01_cold_open.mp3`), recordedBefore, 'another case is untouched');
  } finally {
    repo.cleanup();
  }
});

// --------------------------------------------------------------- voice test

test('voice test writes a sample and never the case narration', () => {
  const repo = makeTempRepo();
  try {
    writeFakeConfig(repo);
    writeCase(repo, READY);
    const before = repo.path(`cases/${READY}`);

    const dry = cli(repo.root, ['voice', 'test', 'A short narration sample.', '--json']);
    assert.equal(dry.code, 0, dry.stderr + dry.stdout);
    assert.equal(dry.json.dry_run, true);
    assert.match(String(dry.json.out), /\.darkpipe\/voice_test\.mp3$/);
    assert.ok(!repo.exists('.darkpipe/voice_test.mp3'), 'a dry run writes no sample');
    assert.equal(ledgerSize(repo), 0);

    const run = cli(repo.root, ['voice', 'test', 'A short narration sample.', '--execute', '--json']);
    assert.equal(run.code, 0, run.stderr + run.stdout);
    assert.ok(repo.exists('.darkpipe/voice_test.mp3'), 'the sample must be written under .darkpipe/');
    assert.ok(fs.existsSync(before), 'the case folder must be untouched');
    assert.deepEqual(
      fs.readdirSync(repo.path(`cases/${READY}/02_narration_parts`)).sort(),
      ['01_cold_open.mp3', '02_file.mp3'],
      'voice test must not write the case narration',
    );
    const events = ledgerRows(repo);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'voice-test');
  } finally {
    repo.cleanup();
  }
});

// --------------------------------------------------------------- shorts / posts

test('shorts and posts write the case files the existing cases use, once each', () => {
  const repo = makeTempRepo();
  try {
    writeFakeConfig(repo);
    writeCase(repo, READY);

    const dryShorts = cli(repo.root, ['shorts', READY, '--json']);
    assert.equal(dryShorts.code, 0, dryShorts.stderr + dryShorts.stdout);
    assert.equal(dryShorts.json.dry_run, true);
    assert.equal(ledgerSize(repo), 0);

    const shorts = cli(repo.root, ['shorts', READY, '--execute', '--json']);
    assert.equal(shorts.code, 0, shorts.stderr + shorts.stdout);
    assert.ok(repo.exists(`cases/${READY}/shorts/shorts.json`), 'shorts/shorts.json is the legacy name');
    const shortsDoc = repo.json<Record<string, unknown>>(`cases/${READY}/shorts/shorts.json`);
    assert.ok(Array.isArray(shortsDoc?.shorts), 'the text-port payload is written at the top level');
    assert.equal(shortsDoc?.case_id, READY);

    const posts = cli(repo.root, ['posts', READY, '--execute', '--json']);
    assert.equal(posts.code, 0, posts.stderr + posts.stdout);
    assert.ok(repo.exists(`cases/${READY}/publicacao/posts/posts.json`), 'publicacao/posts/posts.json is the legacy name');
    const postsDoc = repo.json<Record<string, unknown>>(`cases/${READY}/publicacao/posts/posts.json`);
    assert.ok(Array.isArray(postsDoc?.posts));

    const events = ledgerRows(repo);
    assert.deepEqual(events.map((event) => String(event.kind)).sort(), ['posts', 'shorts']);
    for (const event of events) assert.equal(event.status, 'ok');
  } finally {
    repo.cleanup();
  }
});
