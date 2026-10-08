/**
 * check.ts — `darkpipe plan check`: the report of what needs a human eye. It lists
 * orphan shots, narration stretches with no visual, suspect shots (a prompt with no
 * word in common with its block) and cuts under the 4 second floor. A cut marked
 * `origin: real` is never suspect — its prompt is irrelevant by definition.
 *
 * The report is written to `03_shots_revisar.md`; the report holds the detail and
 * the command summary counts each category.
 */

import type { PlanShot, Ports, ShotPlan, TimelineMap } from '../ports.ts';
import { CUT_FLOOR_TOLERANCE, MIN_CUT_S, seconds as fmtSeconds } from '../ruler.ts';
import { fail, truncate } from '../lib/util.ts';
import { anchorCoverage, promptMatchesBlock, readNarration, tokenCoverage } from './narration.ts';
import { LOCK_FILE, MAP_FILE, PLAN_FILE } from './plan.ts';
import { padShot, toSpan } from './timeline.ts';

export const REPORT_FILE = '03_shots_revisar.md';

const ORPHAN_COVERAGE = 0.8;
const STRETCH_COVERAGE = 0.6;
const STRETCH_MIN_WORDS = 5;

export interface CheckIssue {
  code: string;
  shot: string | null;
  block: number | null;
  detail: string;
}

export interface CheckReport {
  ok: boolean;
  orphans: CheckIssue[];
  stretches: CheckIssue[];
  suspects: CheckIssue[];
  attention: CheckIssue[];
  counts: { orphans: number; stretches: number; suspects: number; attention: number };
  markdown: string;
  warnings: string[];
}

interface LockBlock {
  i?: number;
  mp3?: string;
  dur?: number;
  hash?: string;
  texto?: string;
}

interface LockShot {
  shot?: string;
  bloco?: number;
  kind?: string;
  span?: [number, number];
  ancora?: string;
  prompt?: string;
}

interface Lock {
  case_id?: string;
  gerado_em?: string;
  blocos?: LockBlock[];
  shots?: LockShot[];
}

function shotNumber(value: unknown): number {
  const digits = String(value ?? '').replace(/\D+/g, '');
  return digits.length === 0 ? 0 : Number(digits);
}

function originOf(ports: Ports, cut: unknown, planShot: PlanShot | undefined): string | null {
  if (cut !== undefined && cut !== null) {
    const value = ports.files.readOrigin(cut as { origin?: string; origem?: string });
    if (value !== null) return value;
  }
  if (planShot !== undefined) return ports.files.readOrigin(planShot as { origin?: string; origem?: string });
  return null;
}

/** Run the check and build the report markdown. */
export async function checkPlan(ports: Ports, caseId: string): Promise<CheckReport> {
  const lock = await ports.files.readJson<Lock>(caseId, LOCK_FILE);
  if (lock === null || !Array.isArray(lock.shots)) {
    fail(`no anchoring lock (${LOCK_FILE}) for ${caseId}`, {
      hint: `run \`darkpipe plan anchor ${caseId}\` first`,
    });
  }
  const narration = await readNarration(ports, caseId);
  const map = await ports.files.readJson<TimelineMap>(caseId, MAP_FILE);
  const plan = await ports.files.readJson<ShotPlan>(caseId, PLAN_FILE);
  const cutsByShot = new Map((map?.cuts ?? []).map((cut) => [padShot(cut.shot), cut]));
  const planByNumber = new Map<number, PlanShot>((plan?.shots ?? []).map((shot) => [shot.shot_num, shot]));
  const blockByIndex = new Map(narration.blocks.map((block) => [block.index, block]));

  const orphans: CheckIssue[] = [];
  const suspects: CheckIssue[] = [];
  const attention: CheckIssue[] = [];
  const tableRows: string[] = [];

  for (const record of lock.shots) {
    const shot = padShot(record.shot);
    const blockIndex = Number(record.bloco ?? 0);
    const block = blockByIndex.get(blockIndex);
    const anchor = String(record.ancora ?? '');
    const planShot = planByNumber.get(shotNumber(record.shot));
    const prompt = String(record.prompt ?? planShot?.prompt ?? '');
    const span = toSpan(record.span);
    const onScreen = block !== undefined ? (span[1] - span[0]) * block.seconds : null;

    let orphan: { reason: string } | null = null;
    if (block === undefined) {
      orphan = { reason: 'its narration block no longer exists' };
    } else {
      const coverage = anchorCoverage(anchor, block.text);
      if (coverage < ORPHAN_COVERAGE) {
        orphan = { reason: `only ${Math.round(coverage * 100)}% of its anchor text still exists` };
      }
    }

    if (orphan !== null) {
      orphans.push({
        code: 'orphan',
        shot,
        block: blockIndex,
        detail: `shot ${shot} (block ${blockIndex}, ${onScreen !== null ? fmtSeconds(onScreen) : '?'} on screen) — ${orphan.reason}; anchor: “${truncate(anchor, 180)}”`,
      });
      tableRows.push(`| ${shot} | ${blockIndex} | ${onScreen !== null ? onScreen.toFixed(1) : '?'}s | ${truncate(anchor, 110).replace(/\|/g, '/')} | ${truncate(prompt, 90).replace(/\|/g, '/')} | ORPHAN |`);
      continue;
    }

    if (onScreen !== null && onScreen < MIN_CUT_S - CUT_FLOOR_TOLERANCE) {
      attention.push({
        code: 'cut-too-short',
        shot,
        block: blockIndex,
        detail: `shot ${shot}: ${fmtSeconds(onScreen)} on screen (below the ${MIN_CUT_S}s floor)`,
      });
    }

    const origin = originOf(ports, cutsByShot.get(shot), planShot);
    if (origin !== 'real' && block !== undefined && !promptMatchesBlock(prompt, block.text)) {
      suspects.push({
        code: 'suspect',
        shot,
        block: blockIndex,
        detail: `shot ${shot} (block ${blockIndex}) — prompt shares no word with the block: “${truncate(prompt, 150)}”`,
      });
      tableRows.push(`| ${shot} | ${blockIndex} | ${onScreen !== null ? onScreen.toFixed(1) : '?'}s | ${truncate(anchor, 110).replace(/\|/g, '/')} | ${truncate(prompt, 90).replace(/\|/g, '/')} | check |`);
    } else {
      tableRows.push(`| ${shot} | ${blockIndex} | ${onScreen !== null ? onScreen.toFixed(1) : '?'}s | ${truncate(anchor, 110).replace(/\|/g, '/')} | ${truncate(prompt, 90).replace(/\|/g, '/')} | ok |`);
    }
  }

  // Narration stretches with no shot of their own.
  const stretches: CheckIssue[] = [];
  for (const block of narration.blocks) {
    const anchors = lock.shots.filter((record) => Number(record.bloco ?? 0) === block.index).map((record) => String(record.ancora ?? ''));
    for (const sentence of block.sentences) {
      if (sentence.split(/\s+/).filter(Boolean).length < STRETCH_MIN_WORDS) continue;
      const best = anchors.reduce((max, anchor) => Math.max(max, tokenCoverage(sentence, anchor)), 0);
      if (best < STRETCH_COVERAGE) {
        stretches.push({
          code: 'no-visual',
          shot: null,
          block: block.index,
          detail: `block ${block.index} (${block.name}): “${truncate(sentence, 180)}”`,
        });
      }
    }
  }

  const markdown = buildMarkdown(caseId, lock, orphans, suspects, stretches, attention, tableRows);
  const counts = {
    orphans: orphans.length,
    stretches: stretches.length,
    suspects: suspects.length,
    attention: attention.length,
  };
  return {
    ok: orphans.length === 0 && suspects.length === 0 && attention.length === 0,
    orphans,
    stretches,
    suspects,
    attention,
    counts,
    markdown,
    warnings: narration.warnings,
  };
}

function buildMarkdown(
  caseId: string,
  lock: Lock,
  orphans: CheckIssue[],
  suspects: CheckIssue[],
  stretches: CheckIssue[],
  attention: CheckIssue[],
  tableRows: string[],
): string {
  const lines: string[] = [];
  lines.push(`# ${caseId} — shots to review`);
  lines.push('');
  lines.push(`Generated ${new Date().toISOString()}. Narration lock: ${lock.gerado_em ?? '?'}.`);
  lines.push('');
  lines.push('Anchor = the narration stretch on screen while the shot plays. A broken anchor means the');
  lines.push('image was made for a text that no longer exists. Coherence between image and anchor is the');
  lines.push('operator’s read: this report sees no image.');
  lines.push('');
  if (orphans.length > 0) {
    lines.push(`## Orphans (${orphans.length}) — the anchor text left the narration`);
    lines.push('');
    for (const issue of orphans) lines.push(`- ${issue.detail}`);
    lines.push('');
  }
  if (suspects.length > 0) {
    lines.push(`## Check first (${suspects.length}) — the prompt says nothing about the block`);
    lines.push('');
    for (const issue of suspects) lines.push(`- ${issue.detail}`);
    lines.push('');
  }
  if (stretches.length > 0) {
    lines.push(`## Narration with no visual (${stretches.length}) — new text, no shot covers it`);
    lines.push('');
    for (const issue of stretches) lines.push(`- ${issue.detail}`);
    lines.push('');
  }
  if (attention.length > 0) {
    lines.push(`## Attention points (${attention.length})`);
    lines.push('');
    for (const issue of attention) lines.push(`- ${issue.detail}`);
    lines.push('');
  }
  lines.push('## Full table');
  lines.push('');
  lines.push('| shot | block | on screen | anchor (narration) | prompt | status |');
  lines.push('|---|---|---|---|---|---|');
  lines.push(...tableRows);
  lines.push('');
  return lines.join('\n');
}
