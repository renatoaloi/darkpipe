/**
 * publish.test.ts — task 7.2 verify.
 *
 * A dry run writes the pack into the case folder and calls no upload; a missing
 * publisher credential makes `publish --execute` exit non-zero naming the
 * credential with no secret value in the output; the fake publisher records a
 * video id and the case status is unchanged; a short last narration block is
 * merged or the chapter list is dropped, never emitted invalid.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempRepo, writeFakeConfig, cli, type TempRepo } from './helpers.ts';
import { silentWav, solidPng } from '../src/lib/media.ts';

const CASE = 'case_0001_publish';
const PACK = `cases/${CASE}/publicacao/PUBLICAR.json`;

const CLEAN_OPENING = 'The lake kept its secret for sixty years. The file was closed and the names forgotten.';

function buildCase(repo: TempRepo, lastBlockSeconds: number): void {
  const seconds = [12, 12, 12, lastBlockSeconds];
  const names = ['01_part.wav', '02_part.wav', '03_part.wav', '04_part.wav'];
  names.forEach((name, index) => {
    repo.write(`cases/${CASE}/02_narration_parts/${name}`, silentWav(seconds[index]));
  });
  repo.write(
    `cases/${CASE}/02_narration_script.md`,
    [
      `## 1 — salvar como \`${names[0]}\``,
      '',
      CLEAN_OPENING,
      '',
      `## 2 — salvar como \`${names[1]}\``,
      '',
      'The search returned nothing that could be proven in court.',
      '',
      `## 3 — salvar como \`${names[2]}\``,
      '',
      'A witness changed the story, and the trail went cold again.',
      '',
      `## 4 — salvar como \`${names[3]}\``,
      '',
      'The case stays open to this day.',
      '',
    ].join('\n'),
  );
  repo.write(`cases/${CASE}/07_meta.yaml`, `id: ${CASE}\ntitle_en: The Bodom File | Lake Bodom 1960\nvertente: dark_history\nlanguage: en\nstatus: rendered\n`);
  repo.write(`cases/${CASE}/publicacao_manual.json`, `${JSON.stringify({ titulo: 'The Bodom File | Lake Bodom 1960' }, null, 2)}\n`);
  repo.write(`cases/${CASE}/timeline.json`, `${JSON.stringify({ case_id: CASE, gaps: [0, 0, 0, 0], cuts: [] }, null, 2)}\n`);
  repo.write(`cases/${CASE}/publicacao/thumbnail_a.png`, solidPng(1920, 1080));
  repo.write(`cases/${CASE}/${CASE}_FINAL.mp4`, Buffer.from('fake final video bytes'));
}

test('a dry run writes the pack into the case folder and calls no upload', () => {
  const repo = makeTempRepo();
  try {
    writeFakeConfig(repo);
    buildCase(repo, 12);

    const run = cli(repo.root, ['publish', CASE]);
    assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
    assert.ok(repo.exists(PACK), 'the pack must be written into the case folder');
    const pack = repo.json<Record<string, unknown>>(PACK);
    assert.equal(pack?.case, CASE);
    assert.equal(pack?.language, 'en');
    assert.equal(pack?.videoId, null, 'a dry run must not store a video id');
    assert.match(run.stdout, /dry run/i);
  } finally {
    repo.cleanup();
  }
});

test('publish --execute without the publisher credential exits non-zero without printing a secret', () => {
  const repo = makeTempRepo();
  try {
    writeFakeConfig(repo);
    buildCase(repo, 12);

    const secret = 'pub-client-id-DO-NOT-PRINT-1234567890';
    const run = cli(repo.root, ['publish', CASE, '--execute'], {
      YOUTUBE_CLIENT_ID: secret,
      YOUTUBE_CLIENT_SECRET: '',
      YOUTUBE_REFRESH_TOKEN: '',
    });
    assert.notEqual(run.code, 0, 'a missing publisher credential must fail --execute');
    const output = `${run.stdout}\n${run.stderr}`;
    assert.match(output, /publisher/, 'the error must name the port');
    assert.match(output, /YOUTUBE_CLIENT_SECRET/, 'the error must name the missing credential');
    assert.match(output, /YOUTUBE_REFRESH_TOKEN/);
    assert.ok(!output.includes(secret), 'no credential value may be printed');
    assert.ok(!repo.exists(PACK), 'nothing may be built or uploaded without credentials');
  } finally {
    repo.cleanup();
  }
});

test('the fake publisher records a video id and the case status is unchanged', () => {
  const repo = makeTempRepo();
  try {
    writeFakeConfig(repo);
    buildCase(repo, 12);
    const metaBefore = repo.read(`cases/${CASE}/07_meta.yaml`);

    const run = cli(repo.root, ['publish', CASE, '--execute'], {
      YOUTUBE_CLIENT_ID: 'pub-client-id',
      YOUTUBE_CLIENT_SECRET: 'pub-client-secret',
      YOUTUBE_REFRESH_TOKEN: 'pub-refresh-token',
    });
    assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);

    const pack = repo.json<Record<string, unknown>>(PACK);
    assert.equal(pack?.videoId, `fake-${CASE}`, 'the pack must store the uploaded video id');
    assert.match(run.stdout, /case status is unchanged/i);
    assert.ok(!run.stdout.includes('pub-client-secret'), 'no credential value may be printed');

    assert.equal(repo.read(`cases/${CASE}/07_meta.yaml`), metaBefore, 'the case status must not change');
  } finally {
    repo.cleanup();
  }
});

test('a last narration block under 10 seconds merges instead of emitting an invalid chapter list', () => {
  const repo = makeTempRepo();
  try {
    writeFakeConfig(repo);
    buildCase(repo, 5); // 12, 12, 12, 5

    const run = cli(repo.root, ['publish', CASE, '--json']);
    assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
    const chapters = run.json.pack.chapters as Array<{ title: string; startSeconds: number }>;
    // Either the list is dropped, or every chapter is legal: starts at 00:00 and no chapter under 10s.
    if (chapters.length > 0) {
      assert.equal(chapters[0].startSeconds, 0, 'the first chapter must start at 00:00');
      assert.ok(chapters.length >= 3, 'a chapter list needs at least three chapters');
      for (let index = 0; index < chapters.length; index += 1) {
        const end = index + 1 < chapters.length ? chapters[index + 1].startSeconds : 41;
        assert.ok(end - chapters[index].startSeconds >= 10, `chapter ${index} is under 10s`);
      }
    }
  } finally {
    repo.cleanup();
  }
});

test('a violent word in the first seconds of narration blocks --execute', () => {
  const repo = makeTempRepo();
  try {
    writeFakeConfig(repo);
    buildCase(repo, 12);
    repo.write(
      `cases/${CASE}/02_narration_script.md`,
      `## 1 — salvar como \`01_part.wav\`\n\nThe murderer was never named. The file stayed closed.\n`,
    );

    const run = cli(repo.root, ['publish', CASE, '--execute'], {
      YOUTUBE_CLIENT_ID: 'pub-client-id',
      YOUTUBE_CLIENT_SECRET: 'pub-client-secret',
      YOUTUBE_REFRESH_TOKEN: 'pub-refresh-token',
    });
    assert.notEqual(run.code, 0, 'a violent opening must block the upload');
    const output = `${run.stdout}\n${run.stderr}`;
    assert.match(output, /murder/i);
    assert.ok(!repo.exists(PACK), 'a blocked execute must upload nothing');
  } finally {
    repo.cleanup();
  }
});
