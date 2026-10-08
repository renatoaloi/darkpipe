/**
 * plan.ts — the shot plan (`03_shots.json`), the pending proposal
 * (`03_shots_proposto.json`), the anchoring lock (`03_plano_narracao.lock.json`)
 * and the cut count on the channel ruler.
 *
 * A proposal is pending when its cuts differ from the live map in shot number,
 * block, span or kind — a proposal that only turns stills into clips is pending
 * too. Anchoring writes the lock and syncs shot rows through the store port, but
 * only when the case has a case row: a hand-copied folder is skipped with an
 * English warning and gains no shot row.
 */

import type { PlanShot, Ports, ShotPlan, ShotRow, TimelineCut, TimelineMap, ShotKind } from '../ports.ts';
import { CLIP_SECONDS, SECONDS_PER_CUT, MIN_CUT_S, STILLS_PER_CLIP } from '../ruler.ts';
import { fail, round } from '../lib/util.ts';
import {
  anchorForSpan,
  narrationHash,
  readNarration,
  readNarrationText,
  sentenceIndexesInSpan,
  type NarrationBlock,
  type NarrationRead,
} from './narration.ts';
import { CLIP_KIND, STILL_KIND, isClipKind, kindOf, normalizeGaps, padShot, toSpan } from './timeline.ts';

export const PLAN_FILE = '03_shots.json';
export const PROPOSAL_FILE = '03_shots_proposto.json';
export const MAP_FILE = 'timeline.json';
export const LOCK_FILE = '03_plano_narracao.lock.json';

export interface PlanState {
  plan: ShotPlan | null;
  map: TimelineMap | null;
  proposal: ShotPlan | null;
  proposalPending: boolean;
  anchored: boolean;
  lock: unknown;
}

interface LockBlock {
  i?: number;
  mp3?: string;
  dur?: number;
  palavras?: number;
  frases?: number;
  hash?: string;
  texto?: string;
}

interface LockShot {
  shot: string;
  bloco: number;
  kind: ShotKind;
  span: [number, number];
  ancora: string;
  frases: number[];
  prompt: string;
}

interface Lock {
  case_id: string;
  gerado_em: string;
  fonte_texto: string;
  blocos: LockBlock[];
  shots: LockShot[];
}

/** True when the prompt still wants a writer (`[A DEFINIR]` or empty). */
export function isPlaceholderPrompt(prompt: unknown): boolean {
  const value = typeof prompt === 'string' ? prompt.trim() : '';
  return value.length === 0 || value.includes('[A DEFINIR]');
}

/** Shot numbers whose prompt is still `[A DEFINIR]`, optionally scoped to a block. */
export function pendingPromptShots(plan: ShotPlan, block: number | null): number[] {
  return plan.shots
    .filter((shot) => isPlaceholderPrompt(shot.prompt))
    .filter((shot) => block === null || Number(shot.bloco ?? 0) === block)
    .map((shot) => shot.shot_num)
    .sort((a, b) => a - b);
}

/** The cuts a proposal would write, in the shape the live map uses. */
export function proposedCuts(proposal: ShotPlan): TimelineCut[] {
  return proposal.shots.map((shot) => ({
    shot: padShot(shot.shot_num),
    block: Number(shot.bloco ?? 0),
    span: [round(toSpan(shot.span)[0], 4), round(toSpan(shot.span)[1], 4)] as [number, number],
    kind: (shot.tipo === 'video' ? CLIP_KIND : STILL_KIND),
  }));
}

function cutKey(cut: TimelineCut): string {
  const span = toSpan(cut.span);
  return `${padShot(cut.shot)}|${Number(cut.block)}|${round(span[0], 4)}|${round(span[1], 4)}|${isClipKind(cut.kind) ? 'clip' : 'still'}`;
}

/** Pending when the proposed cuts differ from the live map in shot/block/span/kind. */
export function proposalPending(proposal: ShotPlan, map: TimelineMap | null): boolean {
  const proposed = proposedCuts(proposal);
  if (proposed.length === 0) return false;
  if (map === null || !Array.isArray(map.cuts) || map.cuts.length === 0) return true;
  const left = proposed.map(cutKey).sort();
  const right = (map.cuts ?? []).map(cutKey).sort();
  if (left.length !== right.length) return true;
  return left.some((key, index) => key !== right[index]);
}

async function isAnchored(
  ports: Ports,
  caseId: string,
  plan: ShotPlan | null,
  lock: Lock | null,
): Promise<boolean> {
  if (plan === null || !Array.isArray(plan.shots) || plan.shots.length === 0) return false;
  if (!plan.shots.every((shot) => typeof shot.ancora === 'string' && shot.ancora.trim().length > 0)) {
    return false;
  }
  if (lock === null || !Array.isArray(lock.blocos)) return false;
  let narration;
  try {
    narration = await readNarrationText(ports, caseId);
  } catch {
    return false;
  }
  if (narration.blocks.length !== lock.blocos.length) return false;
  for (const block of lock.blocos) {
    const index = Number(block.i ?? 0);
    const current = narration.blocks[index];
    if (current === undefined) return false;
    const expected = typeof block.hash === 'string' && block.hash.length > 0 ? block.hash : narrationHash(block.texto ?? '');
    if (narrationHash(current.text) !== expected) return false;
  }
  return true;
}

/** Read the live plan, map, proposal and lock in one pass. */
export async function readPlanState(ports: Ports, caseId: string): Promise<PlanState> {
  const [plan, proposal, map, lock] = await Promise.all([
    ports.files.readJson<ShotPlan>(caseId, PLAN_FILE),
    ports.files.readJson<ShotPlan>(caseId, PROPOSAL_FILE),
    ports.files.readJson<TimelineMap>(caseId, MAP_FILE),
    ports.files.readJson<Lock>(caseId, LOCK_FILE),
  ]);
  const pending = proposal !== null && Array.isArray(proposal.shots) ? proposalPending(proposal, map) : false;
  const anchored = await isAnchored(ports, caseId, plan, lock);
  return { plan, map, proposal, proposalPending: pending, anchored, lock };
}

/**
 * The English sentence that says why the plan cannot be spent on yet, or null.
 * It always names `darkpipe plan anchor` and `darkpipe plan check`.
 */
export function anchoringProblem(state: PlanState): string | null {
  if (state.plan === null) {
    return 'the case has no shot plan yet; run `darkpipe plan propose <case_id>`, then `darkpipe plan anchor <case_id>` and `darkpipe plan check <case_id>`';
  }
  if (!state.anchored) {
    return 'the plan is not anchored to the current narration; run `darkpipe plan anchor <case_id>` and then `darkpipe plan check <case_id>`';
  }
  return null;
}

// -------------------------------------------------------------------- propose

export interface ProposalBuild {
  proposal: ShotPlan;
  cuts: TimelineCut[];
  warnings: string[];
}

/**
 * Chunk the narration on the channel ruler: target 8.5s per cut, never under 4s,
 * one clip for every 3 stills, span stored as a block fraction, and each shot
 * anchored to the narration sentence on screen when it starts.
 */
export function buildProposal(caseId: string, title: string | undefined, narration: NarrationRead): ProposalBuild {
  const shots: PlanShot[] = [];
  const cuts: TimelineCut[] = [];
  const warnings: string[] = [];
  let next = 1;
  narration.blocks.forEach((block) => {
    const seconds = block.seconds;
    let count = Math.max(1, Math.round(seconds / SECONDS_PER_CUT));
    while (count > 1 && seconds / count < MIN_CUT_S) count -= 1;
    const step = 1 / count;
    for (let index = 0; index < count; index += 1) {
      const span: [number, number] = [round(index * step, 4), round((index + 1) * step, 4)];
      const number = next;
      next += 1;
      const isClip = number % (STILLS_PER_CLIP + 1) === 0;
      const anchor = anchorForSpan(block.sentences, span[0], span[1]);
      cuts.push({ shot: padShot(number), block: block.index, span, kind: isClip ? 'clip' : 'still' });
      shots.push({
        shot_num: number,
        tipo: isClip ? 'video' : 'image',
        duracao_s: isClip ? CLIP_SECONDS : 0,
        bloco: block.index,
        span,
        prompt: `[A DEFINIR] ilustrar: ${anchor.slice(0, 200)}`,
        ancora: anchor,
      });
    }
  });
  if (shots.length === 0) warnings.push('the narration produced no cuts — check 02_narration_parts/');
  return { proposal: { case_id: caseId, ...(title !== undefined ? { titulo: title } : {}), shots }, cuts, warnings };
}

export interface ProposeResult {
  proposal: ShotPlan;
  cuts: TimelineCut[];
  path: string;
  blocks: number;
  warnings: string[];
}

/** `plan propose`: cut the recorded narration and write `03_shots_proposto.json`. */
export async function proposePlan(ports: Ports, caseId: string): Promise<ProposeResult> {
  const narration = await readNarration(ports, caseId);
  const warnings = [...narration.warnings];
  if (narration.blocks.length === 0) {
    fail(`no narration audio found in 02_narration_parts/ for ${caseId}`, {
      hint: 'record the narration first with `darkpipe narrate`',
    });
  }
  const live = await ports.files.readJson<ShotPlan>(caseId, PLAN_FILE);
  const built = buildProposal(caseId, live?.titulo, narration);
  warnings.push(...built.warnings);
  const path = await ports.files.writeJson(caseId, PROPOSAL_FILE, built.proposal);
  return { proposal: built.proposal, cuts: built.cuts, path, blocks: narration.blocks.length, warnings };
}

// ---------------------------------------------------------------------- apply

function sameAnchor(a: unknown, b: unknown): boolean {
  return String(a ?? '').trim() === String(b ?? '').trim();
}

function preservePrompts(next: PlanShot[], previous: PlanShot[]): { shots: PlanShot[]; preserved: number[] } {
  const byNumber = new Map(previous.map((shot) => [shot.shot_num, shot]));
  const preserved: number[] = [];
  const shots = next.map((shot) => {
    const old = byNumber.get(shot.shot_num);
    if (old !== undefined && !isPlaceholderPrompt(old.prompt) && sameAnchor(old.ancora, shot.ancora)) {
      preserved.push(shot.shot_num);
      return { ...shot, prompt: old.prompt };
    }
    return { ...shot };
  });
  return { shots, preserved };
}

export interface ApplyResult {
  shots: number;
  cuts: number;
  planBackup: string | null;
  mapBackup: string | null;
  preserved: number[];
  warnings: string[];
}

/** `plan apply`: move the proposal into the live plan and map, keeping a backup. */
export async function applyPlan(ports: Ports, caseId: string): Promise<ApplyResult> {
  const proposal = await ports.files.readJson<ShotPlan>(caseId, PROPOSAL_FILE);
  if (proposal === null || !Array.isArray(proposal.shots) || proposal.shots.length === 0) {
    fail(`no plan proposal to apply for ${caseId}`, {
      hint: `run \`darkpipe plan propose ${caseId}\` first`,
    });
  }
  const narration = await readNarration(ports, caseId);
  const live = await ports.files.readJson<ShotPlan>(caseId, PLAN_FILE);
  const { shots, preserved } = preservePrompts(proposal.shots, live?.shots ?? []);
  const planBackup = live !== null ? await ports.files.backupArtifact(caseId, PLAN_FILE) : null;
  const plan: ShotPlan = { ...proposal, shots };
  await ports.files.writeJson(caseId, PLAN_FILE, plan);

  const map = await ports.files.readJson<TimelineMap>(caseId, MAP_FILE);
  const blockCount = narration.blocks.length;
  const cuts: TimelineCut[] = shots
    .map((shot) => ({
      shot: padShot(shot.shot_num),
      block: Number(shot.bloco ?? 0),
      span: [round(toSpan(shot.span)[0], 4), round(toSpan(shot.span)[1], 4)] as [number, number],
      kind: (shot.tipo === 'video' ? CLIP_KIND : STILL_KIND),
    }))
    .sort((a, b) => Number(a.block) - Number(b.block) || toSpan(a.span)[0] - toSpan(b.span)[0]);
  const mapBackup = map !== null ? await ports.files.backupArtifact(caseId, MAP_FILE) : null;
  const nextMap: TimelineMap = {
    ...(map ?? {}),
    case_id: caseId,
    gaps: normalizeGaps(map?.gaps, blockCount),
    cuts,
    blocos_narracao: narration.blocks.map((block) => block.name),
  };
  if (typeof nextMap.gaps_fill !== 'string') nextMap.gaps_fill = 'anterior';
  if (typeof nextMap.grammar !== 'string') {
    nextMap.grammar = 'v3: 1 visual por corte (>=6s), corte na mudança de frase-núcleo';
  }
  await ports.files.writeJson(caseId, MAP_FILE, nextMap);
  return { shots: shots.length, cuts: cuts.length, planBackup, mapBackup, preserved, warnings: narration.warnings };
}

// --------------------------------------------------------------------- anchor

export interface AnchorResult {
  shots: number;
  blocks: number;
  lockPath: string;
  planBackup: string | null;
  registered: boolean;
  inserted: number;
  removed: number;
  warnings: string[];
  lock: Lock;
}

function anchorOf(block: NarrationBlock | undefined, span: [number, number]): { anchor: string; indexes: number[] } {
  if (block === undefined) return { anchor: '', indexes: [] };
  return {
    anchor: anchorForSpan(block.sentences, span[0], span[1]),
    indexes: sentenceIndexesInSpan(block.sentences, span[0], span[1]),
  };
}

/**
 * `plan anchor`: lock the plan to the exact narration text, give every shot its
 * anchor, and sync shot rows through the store port when the case is registered.
 */
export async function anchorPlan(ports: Ports, caseId: string): Promise<AnchorResult> {
  const narration = await readNarration(ports, caseId);
  const warnings = [...narration.warnings];
  const plan = await ports.files.readJson<ShotPlan>(caseId, PLAN_FILE);
  if (plan === null || !Array.isArray(plan.shots)) {
    fail(`no shot plan (${PLAN_FILE}) for ${caseId}`, { hint: `run \`darkpipe plan propose ${caseId}\` and apply it first` });
  }
  const map = await ports.files.readJson<TimelineMap>(caseId, MAP_FILE);
  const cutsByShot = new Map((map?.cuts ?? []).map((cut) => [padShot(cut.shot), cut]));

  const lockShots: LockShot[] = [];
  for (const shot of plan.shots) {
    const cut = cutsByShot.get(padShot(shot.shot_num));
    const block = cut !== undefined ? Number(cut.block) : Number(shot.bloco ?? 0);
    const span = toSpan(cut !== undefined ? cut.span : shot.span);
    const kind: ShotKind = cut !== undefined ? (kindOf(cut) === 'clip' || shot.tipo === 'video' ? 'clip' : 'still') : shot.tipo === 'video' ? 'clip' : 'still';
    const { anchor, indexes } = anchorOf(narration.blocks[block], span);
    shot.bloco = block;
    shot.span = [round(span[0], 4), round(span[1], 4)];
    shot.ancora = anchor;
    if (isClipKind(kind)) shot.tipo = 'video';
    lockShots.push({
      shot: padShot(shot.shot_num),
      bloco: block,
      kind,
      span: [round(span[0], 4), round(span[1], 4)],
      ancora: anchor,
      frases: indexes,
      prompt: String(shot.prompt ?? ''),
    });
  }

  const lock: Lock = {
    case_id: caseId,
    gerado_em: new Date().toISOString(),
    fonte_texto: '02_narration_script.md',
    blocos: narration.blocks.map((block) => ({
      i: block.index,
      mp3: block.name,
      dur: round(block.seconds, 3),
      palavras: block.words,
      frases: block.sentences.length,
      hash: block.hash,
      texto: block.text,
    })),
    shots: lockShots,
  };

  const planBackup = await ports.files.backupArtifact(caseId, PLAN_FILE);
  await ports.files.writeJson(caseId, PLAN_FILE, plan);
  const lockPath = await ports.files.writeJson(caseId, LOCK_FILE, lock);

  const caseRow = await ports.store.getCase(caseId);
  let inserted = 0;
  let removed = 0;
  const registered = caseRow !== null;
  if (registered) {
    const existing = await ports.store.listShots(caseId);
    const rows: ShotRow[] = plan.shots.map((shot) => {
      const current = existing.find((row) => row.shot_num === shot.shot_num);
      return {
        case_id: caseId,
        shot_num: shot.shot_num,
        tipo: String(shot.tipo ?? 'image'),
        descricao: String(shot.ancora ?? '').slice(0, 160),
        prompt: String(shot.prompt ?? ''),
        duracao_s: Number(shot.duracao_s ?? 0),
        origem: current?.origem ?? null,
      };
    });
    await ports.store.replaceShots(caseId, rows);
    const planNumbers = new Set(rows.map((row) => row.shot_num));
    const removedNumbers = existing.filter((row) => !planNumbers.has(row.shot_num)).map((row) => row.shot_num);
    if (removedNumbers.length > 0) await ports.store.removeShots(caseId, removedNumbers);
    inserted = rows.filter((row) => !existing.some((old) => old.shot_num === row.shot_num)).length;
    removed = removedNumbers.length;
  } else {
    warnings.push(
      `case ${caseId} is not registered in the store — shot rows were not synced (a hand-copied case folder would create orphan rows)`,
    );
  }

  return {
    shots: lockShots.length,
    blocks: narration.blocks.length,
    lockPath,
    planBackup,
    registered,
    inserted,
    removed,
    warnings,
    lock,
  };
}
