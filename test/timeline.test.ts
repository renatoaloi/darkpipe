/**
 * timeline.test.ts — task 4.1 verify: undo restores the previous map bytes and
 * keeps the replaced map as a backup, a 2.2x clip shortened toward the range is
 * accepted, validate names both shots and the double-counted seconds for an
 * overlapping span, and a 3 second cut blocks.
 */

import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempRepo, silentAudio, fakeConfig, type TempRepo } from './helpers.ts';
import { parseArgs } from '../src/lib/args.ts';
import { wavDuration } from '../src/lib/media.ts';
import type { CommandContext } from '../src/command.ts';
import type { CaseFiles, CaseRow, CaseStore, Ledger, Ports, Renderer, ShotRow, TextProvider } from '../src/ports.ts';
import type { DarkpipeConfig } from '../src/config.ts';
import type { JobsApi } from '../src/jobs.ts';
import { timelineCommand } from '../src/commands/timeline.ts';
import { stillCommand } from '../src/commands/still.ts';
import { validateCuts, type ValidatedCut } from '../src/domain/timeline.ts';

const CASE = 'case_0009_alpha';
const CLIP_SECONDS = 6;

let backupCounter = 0;

class StubStore implements CaseStore {
  readonly name = 'stub';
  readonly location = null;
  async listCases(): Promise<CaseRow[]> {
    return [];
  }
  async getCase(): Promise<CaseRow | null> {
    return null;
  }
  async createCase(): Promise<void> {}
  async updateCase(): Promise<void> {}
  async maxPriority(): Promise<number> {
    return 0;
  }
  async listShots(): Promise<ShotRow[]> {
    return [];
  }
  async replaceShots(): Promise<void> {}
  async removeShots(): Promise<void> {}
  async close(): Promise<void> {}
}

class FakeFiles implements CaseFiles {
  readonly name = 'fake';
  private readonly root: string;
  constructor(root: string) {
    this.root = root;
  }
  caseDir(caseId: string): string {
    return path.join(this.root, 'cases', caseId);
  }
  private abs(caseId: string, relative: string): string {
    return path.join(this.caseDir(caseId), relative);
  }
  async exists(caseId: string): Promise<boolean> {
    return fs.existsSync(this.caseDir(caseId));
  }
  async listCaseIds(): Promise<string[]> {
    return [];
  }
  async readText(caseId: string, name: string): Promise<string | null> {
    const file = this.abs(caseId, name);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  }
  async writeText(caseId: string, name: string, text: string): Promise<string> {
    const file = this.abs(caseId, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  }
  async readJson<T = unknown>(caseId: string, name: string): Promise<T | null> {
    const raw = await this.readText(caseId, name);
    return raw === null ? null : (JSON.parse(raw) as T);
  }
  async writeJson(caseId: string, name: string, value: unknown): Promise<string> {
    return this.writeText(caseId, name, `${JSON.stringify(value, null, 2)}\n`);
  }
  async readMeta(): Promise<null> {
    return null;
  }
  async writeMeta(caseId: string, meta: unknown): Promise<string> {
    return this.writeJson(caseId, 'case.meta.json', meta);
  }
  async listFiles(caseId: string): Promise<string[]> {
    const out: string[] = [];
    const walk = (dir: string, prefix: string) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const relative = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), relative);
        else out.push(relative);
      }
    };
    walk(this.caseDir(caseId), '');
    return out.sort();
  }
  async backupArtifact(caseId: string, name: string): Promise<string | null> {
    const source = this.abs(caseId, name);
    if (!fs.existsSync(source)) return null;
    backupCounter += 1;
    const backup = `${name}.${backupCounter}.bak`;
    fs.copyFileSync(source, this.abs(caseId, backup));
    return backup;
  }
  async listBackups(caseId: string, name: string): Promise<string[]> {
    const dir = this.caseDir(caseId);
    if (!fs.existsSync(dir)) return [];
    const number = (entry: string) => Number(entry.slice(entry.lastIndexOf('.', entry.length - 5) + 1, -4));
    return fs
      .readdirSync(dir)
      .filter((entry) => entry.startsWith(`${name}.`) && entry.endsWith('.bak'))
      .sort((a, b) => number(a) - number(b));
  }
  async restoreArtifact(caseId: string, backupPath: string): Promise<string> {
    const target = backupPath.replace(/\.\d+\.bak$/, '');
    fs.copyFileSync(this.abs(caseId, backupPath), this.abs(caseId, target));
    return this.abs(caseId, target);
  }
  resolve(caseId: string, relative: string): string {
    return this.abs(caseId, relative);
  }
  readOrigin(shot: { origin?: string; origem?: string }): string | null {
    return shot.origin ?? shot.origem ?? null;
  }
}

/** Every `.mp4` fixture is a 6 second clip; every other file is a WAV. */
const renderer: Renderer = {
  name: 'fake',
  async probe(file) {
    if (file.endsWith('.mp4')) return CLIP_SECONDS;
    try {
      const value = wavDuration(fs.readFileSync(file));
      return value > 0 ? value : null;
    } catch {
      return null;
    }
  },
  async probeOrFail(file) {
    const value = await this.probe(file);
    if (value === null) throw new Error(`probe failed for ${file}`);
    return value;
  },
  async render() {
    throw new Error('render is not used in these tests');
  },
  async available() {
    return true;
  },
};

const text: TextProvider = {
  name: 'fake',
  provider: 'fake',
  async complete() {
    return { text: '{}', path: null, usd: 0, provider: 'fake', model: 'fake', latencyMs: 1, jobId: null };
  },
};

interface Harness {
  repo: TempRepo;
  files: FakeFiles;
  lines: string[];
  ctx(argv: string[]): CommandContext;
}

function harness(): Harness {
  const repo = makeTempRepo();
  const files = new FakeFiles(repo.root);
  const lines: string[] = [];
  const ports: Ports = {
    store: new StubStore(),
    files,
    media: { name: 'fake', provider: 'fake' } as never,
    speech: { name: 'fake', provider: 'fake' } as never,
    text,
    render: renderer,
    ledger: { name: 'fake', location: null, append: async () => {}, read: async () => [], size: async () => 0 } as unknown as Ledger,
    publisher: { name: 'fake', provider: 'fake' } as never,
  };
  return {
    repo,
    files,
    lines,
    ctx: (argv) => ({
      args: parseArgs(argv),
      config: fakeConfig() as unknown as DarkpipeConfig,
      configPath: null,
      configProblems: [],
      repoRoot: repo.root,
      ports,
      adaptersKnown: {} as never,
      sink: { json: false, log: (line) => lines.push(line), warn: (line) => lines.push(`warning: ${line}`) },
      jobs: {} as JobsApi,
      cliPath: '',
    }),
  };
}

function seed(h: Harness): void {
  h.repo.write(`cases/${CASE}/02_narration_script.md`, '# case\n\n## §1 — salvar como `01_a.wav`\n\nAlpha sentence number one is here.\n');
  h.repo.write(`cases/${CASE}/02_narration_parts/01_a.wav`, silentAudio(60));
}

// ---------------------------------------------------------------------- tests

test('undo restores the previous map bytes and keeps the replaced map as a backup', async () => {
  const h = harness();
  try {
    seed(h);
    const original = { case_id: CASE, gaps: [2.0], cuts: [{ shot: '01', block: 0, span: [0, 0.5], kind: 'still' }] };
    h.repo.write(`cases/${CASE}/timeline.json`, JSON.stringify(original, null, 2));
    const originalBytes = h.repo.read(`cases/${CASE}/timeline.json`);

    await timelineCommand.sub!.span.run(h.ctx(['timeline', 'span', CASE, '01', '0.1', '0.2']));
    const replacedBytes = h.repo.read(`cases/${CASE}/timeline.json`);
    assert.notEqual(replacedBytes, originalBytes, 'the span verb must change the map');

    await timelineCommand.sub!.undo.run(h.ctx(['timeline', 'undo', CASE]));
    const restoredBytes = h.repo.read(`cases/${CASE}/timeline.json`);
    assert.equal(restoredBytes, originalBytes, 'undo must restore the previous map bytes');

    const backups = await h.files.listBackups(CASE, 'timeline.json');
    const kept = backups.map((name) => h.repo.read(`cases/${CASE}/${name}`));
    assert.ok(kept.includes(replacedBytes), 'the replaced map must be kept as a backup');
  } finally {
    h.repo.cleanup();
  }
});

test('a 2.2x clip shortened toward the range is accepted', async () => {
  const h = harness();
  try {
    seed(h);
    h.repo.write(`cases/${CASE}/04_shots/shot_04.mp4`, 'fake clip bytes');
    const map = { case_id: CASE, gaps: [2.0], cuts: [{ shot: '04', block: 0, span: [0, 0.22], kind: 'clip' }] };
    h.repo.write(`cases/${CASE}/timeline.json`, JSON.stringify(map, null, 2));

    const result = await timelineCommand.sub!.boundary.run(h.ctx(['timeline', 'boundary', CASE, '04', '-1.2']));
    assert.equal(result.data.changed, true, JSON.stringify({ data: result.data, text: result.text }));
    const after = h.repo.json<{ cuts: Array<{ span: [number, number] }> }>(`cases/${CASE}/timeline.json`);
    const seconds = (after!.cuts[0].span[1] - after!.cuts[0].span[0]) * 60;
    assert.ok(Math.abs(seconds - 12) < 0.01, `expected 12.00s on screen, got ${seconds}`);
    assert.ok(Math.abs(seconds / CLIP_SECONDS - 2.0) < 0.01, 'the clip is back at 2.0x, inside the range');
  } finally {
    h.repo.cleanup();
  }
});

test('validate names both shots and the double-counted seconds for an overlapping span', () => {
  const cuts: ValidatedCut[] = [
    { shot: '01', block: 0, kind: 'still', seconds: 5, retime: 1, path: '/x/01.png', span: [0, 0.5], blockSeconds: 20 },
    { shot: '02', block: 0, kind: 'still', seconds: 5, retime: 1, path: '/x/02.png', span: [0.4, 0.9], blockSeconds: 20 },
  ];
  const report = validateCuts(cuts);
  assert.equal(report.ok, false);
  const overlap = report.blocking.find((issue) => issue.code === 'overlap');
  assert.ok(overlap, `expected an overlap issue, got ${JSON.stringify(report.blocking)}`);
  assert.match(overlap!.message, /01/);
  assert.match(overlap!.message, /02/);
  assert.match(overlap!.message, /2\.0/, `expected the double-counted seconds, got: ${overlap!.message}`);
});

test('a 3 second cut blocks', () => {
  const cuts: ValidatedCut[] = [
    { shot: '05', block: 0, kind: 'still', seconds: 3, retime: 1, path: '/x/05.png', span: [0, 0.15], blockSeconds: 20 },
  ];
  const report = validateCuts(cuts);
  assert.equal(report.ok, false);
  const short = report.blocking.find((issue) => issue.code === 'cut-too-short');
  assert.ok(short, `expected a short-cut issue, got ${JSON.stringify(report.blocking)}`);
  assert.match(short!.message, /05/);
});

test('still import marks the cut real and revert puts the generated still back', async () => {
  const h = harness();
  try {
    seed(h);
    h.repo.write(`cases/${CASE}/04_shots/shot_02_still.png`, 'GENERATED');
    h.repo.write(`cases/${CASE}/timeline.json`, JSON.stringify({ case_id: CASE, gaps: [2.0], cuts: [{ shot: '02', block: 0, span: [0, 0.5], kind: 'clip' }] }, null, 2));
    h.repo.write('photo.jpg', 'PHOTO');

    await stillCommand.sub!.import.run(h.ctx(['still', 'import', CASE, '02', h.repo.path('photo.jpg')]));
    const imported = h.repo.json<{ cuts: Array<Record<string, unknown>> }>(`cases/${CASE}/timeline.json`);
    assert.equal(imported!.cuts[0].origin, 'real');
    assert.equal(imported!.cuts[0].kind, 'still');
    assert.equal(h.repo.read(`cases/${CASE}/04_shots/shot_02_still.jpg`), 'PHOTO');

    await stillCommand.sub!.revert.run(h.ctx(['still', 'revert', CASE, '02']));
    const reverted = h.repo.json<{ cuts: Array<Record<string, unknown>> }>(`cases/${CASE}/timeline.json`);
    assert.equal(reverted!.cuts[0].origin, undefined);
    assert.equal(h.repo.read(`cases/${CASE}/04_shots/shot_02_still.png`), 'GENERATED', 'the generated still must be back');
  } finally {
    h.repo.cleanup();
  }
});
