/**
 * render.test.ts — task 6.1 verify, with real files and the real ffmpeg port.
 *
 * A disposable case (silence-as-WAV narration, solid PNG stills) proves the
 * domain rules: a 3 second cut and an overlapping span are refused without
 * touching an existing final file; a `--blocks` preview uses the same ruler and
 * leaves the final alone; a full render refuses while a chapter is missing art.
 * ffmpeg-dependent tests skip cleanly when the binary is absent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { makeTempRepo, writeFakeConfig, cli, type TempRepo } from './helpers.ts';
import { silentWav, solidPng } from '../src/lib/media.ts';

const CASE = 'case_0001_render';

const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0;

function checksum(absolute: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
}

interface Cut {
  shot: string;
  block: number;
  span: [number, number];
  kind: 'still' | 'video';
}

/** Build the case skeleton: narration blocks and a cut map. */
function buildCase(repo: TempRepo, blockSeconds: number[], cuts: Cut[]): void {
  blockSeconds.forEach((seconds, index) => {
    repo.write(`cases/${CASE}/02_narration_parts/${String(index + 1).padStart(2, '0')}_part.wav`, silentWav(seconds));
  });
  repo.write(
    `cases/${CASE}/timeline.json`,
    `${JSON.stringify({ case_id: CASE, gaps: blockSeconds.map(() => 0), gaps_fill: 'anterior', cuts }, null, 2)}\n`,
  );
  repo.write(`cases/${CASE}/07_meta.yaml`, `id: ${CASE}\ntitle_en: Render probe\nvertice: dark_history\nstatus: rendered\n`);
}

function still(repo: TempRepo, shot: number): void {
  repo.write(`cases/${CASE}/04_shots/shot_${String(shot).padStart(2, '0')}_still.png`, solidPng(1280, 720));
}

test('a cut under 4 seconds is refused and the previous final keeps its checksum', () => {
  const repo = makeTempRepo();
  try {
    writeFakeConfig(repo);
    buildCase(repo, [10, 10, 10], [
      { shot: '01', block: 0, span: [0, 0.3], kind: 'still' },
      { shot: '02', block: 0, span: [0.3, 1], kind: 'still' },
      { shot: '03', block: 1, span: [0, 1], kind: 'still' },
      { shot: '04', block: 2, span: [0, 1], kind: 'still' },
    ]);
    for (const shot of [1, 2, 3, 4]) still(repo, shot);

    const finalAbs = repo.path(`cases/${CASE}/${CASE}_FINAL.mp4`);
    fs.writeFileSync(finalAbs, Buffer.from('previous final bytes'));
    const before = checksum(finalAbs);

    const run = cli(repo.root, ['render', CASE]);
    assert.notEqual(run.code, 0, 'a 3 second cut must refuse the assembly');
    const output = `${run.stdout}\n${run.stderr}`;
    assert.match(output, /shot 01/, 'the report must name the cut');
    assert.match(output, /4s floor|below the 4/i, 'the report must give the reason');
    assert.ok(fs.existsSync(finalAbs), 'the previous final must still exist');
    assert.equal(checksum(finalAbs), before, 'the previous final must be byte-identical');
  } finally {
    repo.cleanup();
  }
});

test('an overlapping span is refused naming both shots', () => {
  const repo = makeTempRepo();
  try {
    writeFakeConfig(repo);
    buildCase(repo, [10, 10, 10], [
      { shot: '01', block: 0, span: [0, 0.6], kind: 'still' },
      { shot: '02', block: 0, span: [0.5, 1.0], kind: 'still' },
      { shot: '03', block: 1, span: [0, 1], kind: 'still' },
      { shot: '04', block: 2, span: [0, 1], kind: 'still' },
    ]);
    for (const shot of [1, 2, 3, 4]) still(repo, shot);

    const run = cli(repo.root, ['render', CASE]);
    assert.notEqual(run.code, 0, 'an overlapping span must refuse the assembly');
    const output = `${run.stdout}\n${run.stderr}`;
    assert.match(output, /shots 01 and 02 overlap/i, 'the report must name both shots');
  } finally {
    repo.cleanup();
  }
});

test('render without --blocks is refused while a chapter is missing art, naming the cuts', () => {
  const repo = makeTempRepo();
  try {
    writeFakeConfig(repo);
    buildCase(repo, [10, 10, 10], [
      { shot: '01', block: 0, span: [0, 1], kind: 'still' },
      { shot: '02', block: 1, span: [0, 1], kind: 'still' },
      { shot: '03', block: 2, span: [0, 1], kind: 'still' },
    ]);
    still(repo, 3); // art only in chapter 2

    const run = cli(repo.root, ['render', CASE]);
    assert.notEqual(run.code, 0, 'a full render must refuse while art is missing');
    const output = `${run.stdout}\n${run.stderr}`;
    assert.match(output, /shot 01/, 'the report must name the cut with no file');
    assert.match(output, /shot 02/, 'the report must name the cut with no file');
    assert.match(output, /no file/i);
  } finally {
    repo.cleanup();
  }
});

test('--blocks 2 writes the preview and leaves the final video untouched', (t) => {
  if (!ffmpegAvailable) {
    t.skip('ffmpeg is not on PATH');
    return;
  }
  const repo = makeTempRepo();
  try {
    writeFakeConfig(repo);
    buildCase(repo, [10, 10, 10], [
      { shot: '01', block: 0, span: [0, 1], kind: 'still' },
      { shot: '02', block: 1, span: [0, 1], kind: 'still' },
      { shot: '03', block: 2, span: [0, 1], kind: 'still' },
    ]);
    still(repo, 3); // art only in chapter 2

    const finalAbs = repo.path(`cases/${CASE}/${CASE}_FINAL.mp4`);
    fs.writeFileSync(finalAbs, Buffer.from('previous final bytes'));
    const before = checksum(finalAbs);

    const run = cli(repo.root, ['render', CASE, '--blocks', '2', '--foreground']);
    assert.equal(run.code, 0, `preview render failed:\n${run.stdout}\n${run.stderr}`);
    const previewAbs = repo.path(`cases/${CASE}/${CASE}_blocks_02-02.mp4`);
    assert.ok(fs.existsSync(previewAbs), 'the chapter preview must be written');
    assert.ok(fs.statSync(previewAbs).size > 0, 'the preview must not be empty');

    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', previewAbs], { encoding: 'utf8' });
    assert.equal(probe.status, 0);
    assert.ok(Number(probe.stdout.trim()) > 5, 'the preview must hold the chapter audio and video');

    assert.equal(checksum(finalAbs), before, "the preview must not touch the final file's checksum");
  } finally {
    repo.cleanup();
  }
});

test('a full render keeps the previous final under a timestamped name and prints both checksums', (t) => {
  if (!ffmpegAvailable) {
    t.skip('ffmpeg is not on PATH');
    return;
  }
  const repo = makeTempRepo();
  try {
    writeFakeConfig(repo);
    buildCase(repo, [10], [{ shot: '01', block: 0, span: [0, 1], kind: 'still' }]);
    still(repo, 1);

    const finalAbs = repo.path(`cases/${CASE}/${CASE}_FINAL.mp4`);
    fs.writeFileSync(finalAbs, Buffer.from('previous final bytes'));
    const before = checksum(finalAbs);

    const run = cli(repo.root, ['render', CASE, '--foreground']);
    assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
    assert.ok(fs.existsSync(finalAbs), 'the new final must exist');
    const after = checksum(finalAbs);
    assert.notEqual(after, before, 'the new final must replace the previous one');

    const backupDir = repo.path(`.darkpipe/backups/${CASE}`);
    assert.ok(fs.existsSync(backupDir), 'the previous final must be kept under a timestamped name');
    const backups = fs.readdirSync(backupDir);
    assert.ok(backups.some((name) => name.includes(`${CASE}_FINAL.mp4`) && name.endsWith('.bak')), backups.join(','));

    assert.match(run.stdout, new RegExp(after), 'the report must print the new checksum');
    assert.match(run.stdout, new RegExp(before), 'the report must print the previous checksum');
  } finally {
    repo.cleanup();
  }
});

test('render --check only reports', () => {
  const repo = makeTempRepo();
  try {
    writeFakeConfig(repo);
    buildCase(repo, [10], [{ shot: '01', block: 0, span: [0, 1], kind: 'still' }]);
    still(repo, 1);
    const run = cli(repo.root, ['render', CASE, '--check']);
    assert.equal(run.code, 0, run.stderr);
    assert.ok(!repo.exists(`cases/${CASE}/${CASE}_FINAL.mp4`), '--check must not render');
    assert.match(run.stdout, /nothing was rendered/i);
  } finally {
    repo.cleanup();
  }
});
