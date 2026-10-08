/**
 * plan.test.ts — task 4.1 verify: a fixture case with silent audio produces the
 * expected cut count, a clip-only delta is reported as a pending proposal, a
 * hand-copied case folder with no store row gains no shot rows when anchor runs
 * (and warns in English), and `prompts write` on a case with a waiting proposal
 * warns and does not touch 03_shots_proposto.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempRepo, silentAudio, fakeConfig, type TempRepo } from './helpers.ts';
import { parseArgs } from '../src/lib/args.ts';
import { wavDuration } from '../src/lib/media.ts';
import type { CommandContext } from '../src/command.ts';
import type {
  CaseFiles,
  CasePatch,
  CaseRecordInput,
  CaseRow,
  CaseStore,
  Ledger,
  MediaProvider,
  Ports,
  Publisher,
  Renderer,
  ShotRow,
  SpeechProvider,
  TextProvider,
  TextResult,
} from '../src/ports.ts';
import type { DarkpipeConfig } from '../src/config.ts';
import type { JobsApi } from '../src/jobs.ts';
import { planCommand } from '../src/commands/plan.ts';
import { promptsCommand } from '../src/commands/prompts.ts';
import { readPlanState } from '../src/domain/plan.ts';
import type { ShotPlan, TimelineMap } from '../src/ports.ts';

// ----------------------------------------------------------------- fake ports

let backupCounter = 0;

class FakeStore implements CaseStore {
  readonly name = 'fake';
  readonly location = null;
  cases = new Map<string, CaseRow>();
  shots = new Map<string, ShotRow[]>();
  replaceCalls = 0;
  async listCases(): Promise<CaseRow[]> {
    return [...this.cases.values()];
  }
  async getCase(id: string): Promise<CaseRow | null> {
    return this.cases.get(id) ?? null;
  }
  async createCase(record: CaseRecordInput): Promise<void> {
    this.cases.set(record.id, {
      id: record.id,
      titulo_en: record.titulo_en,
      vertente: record.vertente,
      estado: record.estado,
      prioridade: record.prioridade,
      data_criacao: record.data_criacao,
      notas: record.notas ?? null,
    });
  }
  async updateCase(id: string, patch: CasePatch): Promise<void> {
    const row = this.cases.get(id);
    if (row !== undefined) this.cases.set(id, { ...row, ...patch } as CaseRow);
  }
  async maxPriority(): Promise<number> {
    return 0;
  }
  async listShots(caseId: string): Promise<ShotRow[]> {
    return [...(this.shots.get(caseId) ?? [])];
  }
  async replaceShots(caseId: string, rows: ShotRow[]): Promise<void> {
    this.replaceCalls += 1;
    const existing = this.shots.get(caseId) ?? [];
    const kept = existing.filter((old) => !rows.some((row) => row.shot_num === old.shot_num));
    this.shots.set(caseId, [...kept, ...rows.map((row) => ({ ...row }))]);
  }
  async removeShots(caseId: string, shotNums: number[]): Promise<void> {
    this.shots.set(caseId, (this.shots.get(caseId) ?? []).filter((row) => !shotNums.includes(row.shot_num)));
  }
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
    const dir = path.join(this.root, 'cases');
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
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
    const base = this.caseDir(caseId);
    const out: string[] = [];
    const walk = (dir: string, prefix: string) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const relative = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), relative);
        else out.push(relative);
      }
    };
    walk(base, '');
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
    return fs
      .readdirSync(dir)
      .filter((entry) => entry.startsWith(`${name}.`) && entry.endsWith('.bak'))
      .sort((a, b) => Number(a.slice(a.lastIndexOf('.', a.length - 5) + 1, -4)) - Number(b.slice(b.lastIndexOf('.', b.length - 5) + 1, -4)));
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
  async complete(request): Promise<TextResult> {
    const numbers = [...request.prompt.matchAll(/"shot_num":\s*(\d+)/g)].map((match) => Number(match[1]));
    return {
      text: JSON.stringify({ prompts: numbers.map((shot_num) => ({ shot_num, prompt: `fake prompt ${shot_num}` })) }),
      path: null,
      usd: 0,
      provider: 'fake',
      model: 'fake',
      latencyMs: 1,
      jobId: null,
    };
  },
};

function emptyPort<T>(name: string): T {
  return { name, provider: name } as unknown as T;
}

interface Harness {
  repo: TempRepo;
  store: FakeStore;
  files: FakeFiles;
  lines: string[];
  ctx(argv: string[]): CommandContext;
}

function harness(): Harness {
  const repo = makeTempRepo();
  const store = new FakeStore();
  const files = new FakeFiles(repo.root);
  const lines: string[] = [];
  const ports: Ports = {
    store,
    files,
    media: emptyPort<MediaProvider>('fake'),
    speech: emptyPort<SpeechProvider>('fake'),
    text,
    render: renderer,
    ledger: { name: 'fake', location: null, async append() {}, async read() { return []; }, async size() { return 0; } } as Ledger,
    publisher: emptyPort<Publisher>('fake'),
  };
  const sink = {
    json: false,
    log: (line: string) => lines.push(line),
    warn: (line: string) => lines.push(`warning: ${line}`),
  };
  return {
    repo,
    store,
    files,
    lines,
    ctx: (argv: string[]): CommandContext => ({
      args: parseArgs(argv),
      config: fakeConfig() as unknown as DarkpipeConfig,
      configPath: null,
      configProblems: [],
      repoRoot: repo.root,
      ports,
      adaptersKnown: {} as never,
      sink,
      jobs: {} as JobsApi,
      cliPath: '',
    }),
  };
}

const CASE = 'case_0001_alpha';

function narrationScript(): string {
  return [
    '# case_0001_alpha',
    '',
    '## §1 — salvar como `01_a.wav`',
    '',
    'Alpha sentence number one is here. Beta sentence number two is here.',
    '',
    '---',
    '## §2 — salvar como `02_b.wav`',
    '',
    'Gamma sentence number three is here. Delta sentence number four is here.',
    '',
    '---',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------- tests

test('propose produces the expected cut count for a known narration length', async () => {
  const h = harness();
  try {
    h.repo.write(`cases/${CASE}/02_narration_script.md`, narrationScript());
    h.repo.write(`cases/${CASE}/02_narration_parts/01_a.wav`, silentAudio(25.5));
    h.repo.write(`cases/${CASE}/02_narration_parts/02_b.wav`, silentAudio(34));

    const result = await planCommand.sub!.propose.run(h.ctx(['plan', 'propose', CASE]));
    // 25.5s -> 3 cuts, 34s -> 4 cuts = 7 cuts on the 8.5s ruler.
    assert.equal(result.data.shots, 7, JSON.stringify(result.data));
    assert.equal(result.data.cuts, 7);

    const proposal = h.repo.json<ShotPlan>(`cases/${CASE}/03_shots_proposto.json`);
    assert.ok(proposal, 'the proposal file must be written');
    assert.equal(proposal!.shots.length, 7);
    const clip = proposal!.shots.find((shot) => shot.shot_num === 4);
    assert.equal(clip?.tipo, 'video', 'shot 4 is the one clip (3 stills per clip)');
    assert.equal(clip?.duracao_s, 6);
    assert.ok((clip?.ancora ?? '').length > 0, 'every shot is anchored to the narration on screen');
  } finally {
    h.repo.cleanup();
  }
});

test('a proposal that only turns stills into clips is reported pending', async () => {
  const h = harness();
  try {
    const spans: Array<[number, number]> = [[0, 0.25], [0.25, 0.5], [0.5, 0.75], [0.75, 1]];
    const proposal: ShotPlan = {
      case_id: CASE,
      shots: spans.map((span, index) => ({
        shot_num: index + 1,
        tipo: index === 3 ? 'video' : 'image',
        duracao_s: index === 3 ? 6 : 0,
        bloco: 0,
        span,
        prompt: '[A DEFINIR] ilustrar: something',
        ancora: `anchor ${index + 1}`,
      })),
    };
    const map: TimelineMap = {
      case_id: CASE,
      gaps: [2.0],
      cuts: spans.map((span, index) => ({ shot: String(index + 1).padStart(2, '0'), block: 0, span, kind: 'still' })),
    };
    h.repo.write(`cases/${CASE}/03_shots_proposto.json`, JSON.stringify(proposal, null, 2));
    h.repo.write(`cases/${CASE}/timeline.json`, JSON.stringify(map, null, 2));

    const state = await readPlanState(h.ctx(['case', 'show', CASE]).ports, CASE);
    assert.equal(state.proposalPending, true, 'a clip-only delta must be pending');

    // Same map, but the cut is already a clip: the proposal matches and is not pending.
    const synced: TimelineMap = structuredClone(map);
    (synced.cuts ?? [])[3].kind = 'clip';
    h.repo.write(`cases/${CASE}/timeline.json`, JSON.stringify(synced, null, 2));
    const after = await readPlanState(h.ctx(['case', 'show', CASE]).ports, CASE);
    assert.equal(after.proposalPending, false, 'an identical proposal is not pending');
  } finally {
    h.repo.cleanup();
  }
});

test('anchor on a hand-copied case folder inserts no shot row and warns in English', async () => {
  const h = harness();
  try {
    h.repo.write(`cases/${CASE}/02_narration_script.md`, narrationScript());
    h.repo.write(`cases/${CASE}/02_narration_parts/01_a.wav`, silentAudio(25.5));
    h.repo.write(`cases/${CASE}/02_narration_parts/02_b.wav`, silentAudio(34));
    const plan: ShotPlan = {
      case_id: CASE,
      shots: [
        { shot_num: 1, tipo: 'image', duracao_s: 0, bloco: 0, span: [0, 0.4], prompt: 'alpha beta image', ancora: '' },
        { shot_num: 2, tipo: 'video', duracao_s: 6, bloco: 1, span: [0, 0.5], prompt: 'gamma delta image', ancora: '' },
      ],
    };
    h.repo.write(`cases/${CASE}/03_shots.json`, JSON.stringify(plan, null, 2));

    const result = await planCommand.sub!.anchor.run(h.ctx(['plan', 'anchor', CASE]));
    assert.equal(result.data.registered, false);
    assert.equal(h.store.replaceCalls, 0, 'no shot row may be touched for an unregistered case');
    assert.deepEqual(await h.store.listShots(CASE), []);
    assert.ok(
      h.lines.some((line) => /not registered/.test(line)),
      `expected an English warning about the missing case row, got: ${JSON.stringify(h.lines)}`,
    );
    // The lock and the anchors are still written on disk.
    const lock = h.repo.json<{ shots: unknown[] }>(`cases/${CASE}/03_plano_narracao.lock.json`);
    assert.equal(lock?.shots.length, 2);
    const anchored = h.repo.json<ShotPlan>(`cases/${CASE}/03_shots.json`);
    assert.ok((anchored?.shots[0].ancora ?? '').length > 0);
  } finally {
    h.repo.cleanup();
  }
});

test('prompts write warns about a waiting proposal and never touches the proposal file', async () => {
  const h = harness();
  try {
    const plan: ShotPlan = {
      case_id: CASE,
      shots: [{ shot_num: 1, tipo: 'image', duracao_s: 0, bloco: 0, span: [0, 1], prompt: '[A DEFINIR] ilustrar: alpha', ancora: 'alpha' }],
    };
    const proposal: ShotPlan = {
      case_id: CASE,
      shots: [{ shot_num: 1, tipo: 'video', duracao_s: 6, bloco: 0, span: [0, 1], prompt: '[A DEFINIR] ilustrar: alpha', ancora: 'alpha' }],
    };
    h.repo.write(`cases/${CASE}/03_shots.json`, JSON.stringify(plan, null, 2));
    h.repo.write(`cases/${CASE}/03_shots_proposto.json`, JSON.stringify(proposal, null, 2));
    h.repo.write(
      `cases/${CASE}/timeline.json`,
      JSON.stringify({ case_id: CASE, gaps: [2.0], cuts: [{ shot: '01', block: 0, span: [0, 1], kind: 'still' }] }, null, 2),
    );
    const proposalBytes = h.repo.read(`cases/${CASE}/03_shots_proposto.json`);
    const planBytes = h.repo.read(`cases/${CASE}/03_shots.json`);

    const result = await promptsCommand.sub!.write.run(h.ctx(['prompts', 'write', CASE]));
    assert.equal(result.data.proposalPending, true);
    assert.ok(
      h.lines.some((line) => /proposal is waiting/.test(line)),
      `expected the waiting-proposal warning, got: ${JSON.stringify(h.lines)}`,
    );
    assert.equal(h.repo.read(`cases/${CASE}/03_shots_proposto.json`), proposalBytes, 'the proposal file must not change');
    assert.equal(h.repo.read(`cases/${CASE}/03_shots.json`), planBytes, 'a dry run must not change the live plan');
  } finally {
    h.repo.cleanup();
  }
});
