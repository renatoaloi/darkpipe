/**
 * check.test.ts — task 4.2 verify: the check summary counts orphans, stretches
 * without a visual, suspects and attention points, and a cut with origin `real`
 * and a placeholder prompt is not suspect.
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
import { planCommand } from '../src/commands/plan.ts';

const CASE = 'case_0007_alpha';

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
  async backupArtifact(): Promise<string | null> {
    return null;
  }
  async listBackups(): Promise<string[]> {
    return [];
  }
  async restoreArtifact(): Promise<string> {
    return '';
  }
  resolve(caseId: string, relative: string): string {
    return this.abs(caseId, relative);
  }
  readOrigin(shot: { origin?: string; origem?: string }): string | null {
    return shot.origin ?? shot.origem ?? null;
  }
}

const renderer: Renderer = {
  name: 'fake',
  async probe(file) {
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

function harness(): { repo: TempRepo; ctx: CommandContext; lines: string[] } {
  const repo = makeTempRepo();
  const ports: Ports = {
    store: new StubStore(),
    files: new FakeFiles(repo.root),
    media: { name: 'fake', provider: 'fake' } as never,
    speech: { name: 'fake', provider: 'fake' } as never,
    text,
    render: renderer,
    ledger: { name: 'fake', location: null, append: async () => {}, read: async () => [], size: async () => 0 } as unknown as Ledger,
    publisher: { name: 'fake', provider: 'fake' } as never,
  };
  const lines: string[] = [];
  const ctx: CommandContext = {
    args: parseArgs(['plan', 'check', CASE]),
    config: fakeConfig() as unknown as DarkpipeConfig,
    configPath: null,
    configProblems: [],
    repoRoot: repo.root,
    ports,
    adaptersKnown: {} as never,
    sink: { json: false, log: (line) => lines.push(line), warn: (line) => lines.push(`warning: ${line}`) },
    jobs: {} as JobsApi,
    cliPath: '',
  };
  return { repo, ctx, lines };
}

/** Block 0 covers three sentences; block 1 covers a fourth with no shot of its own. */
function seed(repo: TempRepo): void {
  repo.write(
    `cases/${CASE}/02_narration_script.md`,
    [
      '# case_0007_alpha',
      '',
      '## §1 — salvar como `01_a.wav`',
      '',
      'Alpha sentence number one is here. Beta sentence number two is here. Gamma sentence number three is here.',
      '',
      '## §2 — salvar como `02_b.wav`',
      '',
      'Delta sentence number four is here.',
      '',
    ].join('\n'),
  );
  repo.write(`cases/${CASE}/02_narration_parts/01_a.wav`, silentAudio(20));
  repo.write(`cases/${CASE}/02_narration_parts/02_b.wav`, silentAudio(20));

  const lock = {
    case_id: CASE,
    gerado_em: '2026-01-01T00:00:00.000Z',
    fonte_texto: '02_narration_script.md',
    blocos: [
      { i: 0, mp3: '01_a.wav', dur: 20, texto: 'Alpha sentence number one is here. Beta sentence number two is here. Gamma sentence number three is here.' },
      { i: 1, mp3: '02_b.wav', dur: 20, texto: 'Delta sentence number four is here.' },
    ],
    shots: [
      { shot: '01', bloco: 0, kind: 'still', span: [0, 0.3], ancora: 'Alpha sentence number one is here.', prompt: 'alpha sentence number one here' },
      { shot: '02', bloco: 0, kind: 'still', span: [0.3, 0.6], ancora: 'Beta sentence number two is here.', prompt: 'courthouse staircase' },
      { shot: '03', bloco: 0, kind: 'still', span: [0.6, 0.75], ancora: 'Gamma sentence number three is here.', prompt: 'transition' },
      { shot: '77', bloco: 5, kind: 'still', span: [0, 0.5], ancora: 'ghost text', prompt: 'ghost' },
    ],
  };
  repo.write(`cases/${CASE}/03_plano_narracao.lock.json`, JSON.stringify(lock, null, 2));
  repo.write(
    `cases/${CASE}/timeline.json`,
    JSON.stringify(
      {
        case_id: CASE,
        gaps: [2.0, 0.8],
        cuts: [
          { shot: '01', block: 0, span: [0, 0.3], kind: 'still' },
          { shot: '02', block: 0, span: [0.3, 0.6], kind: 'still' },
          { shot: '03', block: 0, span: [0.6, 0.75], kind: 'still', origem: 'real' },
        ],
      },
      null,
      2,
    ),
  );
  repo.write(
    `cases/${CASE}/03_shots.json`,
    JSON.stringify(
      {
        case_id: CASE,
        shots: [
          { shot_num: 1, tipo: 'image', duracao_s: 0, bloco: 0, span: [0, 0.3], prompt: 'alpha sentence number one here', ancora: 'Alpha sentence number one is here.' },
          { shot_num: 2, tipo: 'image', duracao_s: 0, bloco: 0, span: [0.3, 0.6], prompt: 'courthouse staircase', ancora: 'Beta sentence number two is here.' },
          { shot_num: 3, tipo: 'image', duracao_s: 0, bloco: 0, span: [0.6, 0.75], prompt: 'transition', ancora: 'Gamma sentence number three is here.', origem: 'real' },
        ],
      },
      null,
      2,
    ),
  );
}

test('the check summary counts orphans, stretches, suspects and attention points', async () => {
  const h = harness();
  try {
    seed(h.repo);
    const result = await planCommand.sub!.check.run(h.ctx);
    assert.equal(result.data.orphans, 1, JSON.stringify(result.data));
    assert.equal(result.data.stretches, 1);
    assert.equal(result.data.suspects, 1);
    assert.equal(result.data.attention, 1);

    const report = h.repo.read(`cases/${CASE}/03_shots_revisar.md`);
    assert.ok(report !== null, 'the report must be written');
    assert.match(report!, /## Orphans \(1\)/);
    assert.match(report!, /## Check first \(1\)/);
    assert.match(report!, /## Narration with no visual \(1\)/);
    assert.match(report!, /## Attention points \(1\)/);
  } finally {
    h.repo.cleanup();
  }
});

test('a cut with origin real and a placeholder prompt is not suspect', async () => {
  const h = harness();
  try {
    seed(h.repo);
    const result = await planCommand.sub!.check.run(h.ctx);
    const report = h.repo.read(`cases/${CASE}/03_shots_revisar.md`) ?? '';
    assert.match(report, /shot 02 \(block 0\) — prompt shares no word with the block/);
    assert.doesNotMatch(report, /shot 03 \(block 0\) — prompt shares no word with the block/);
    assert.equal(result.data.suspects, 1);
  } finally {
    h.repo.cleanup();
  }
});
