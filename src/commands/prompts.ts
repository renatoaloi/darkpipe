/**
 * prompts — write shot prompts on the live plan. Owner: task group 4.
 *
 * Dry run by default. It operates on `03_shots.json` only and never writes on
 * `03_shots_proposto.json`. Hand-written prompts survive: only `[A DEFINIR]`
 * placeholders are filled. When a proposal is waiting it says so in English and
 * still shows the live plan's prompts.
 *
 * VERIFY (task 4.2): a waiting proposal is reported and prompts are still taken
 * from the live plan, never from `03_shots_proposto.json`.
 */

import type { Command, CommandContext } from '../command.ts';
import type { CommandResult } from '../lib/util.ts';
import { flagNumber, flagSet, requirePositional } from '../lib/args.ts';
import { fail, truncate } from '../lib/util.ts';
import { PLAN_FILE, PROPOSAL_FILE, isPlaceholderPrompt, pendingPromptShots, readPlanState } from '../domain/plan.ts';
import type { PlanShot, ShotPlan } from '../ports.ts';

interface GeneratedPrompt {
  shot_num: number;
  prompt: string;
}

function parsePrompts(text: string): GeneratedPrompt[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { prompts?: unknown }).prompts)
      ? ((parsed as { prompts: unknown[] }).prompts)
      : [];
  return list
    .filter((entry): entry is { shot_num: unknown; prompt: unknown } => entry !== null && typeof entry === 'object')
    .map((entry) => ({ shot_num: Number(entry.shot_num), prompt: String(entry.prompt ?? '') }))
    .filter((entry) => Number.isFinite(entry.shot_num) && entry.prompt.length > 0);
}

async function write(ctx: CommandContext): Promise<CommandResult> {
  const caseId = requirePositional(ctx.args, 0, 'case_id');
  const block = flagNumber(ctx.args, '--block') ?? null;
  const execute = flagSet(ctx.args, '--execute');

  const plan = await ctx.ports.files.readJson<ShotPlan>(caseId, PLAN_FILE);
  if (plan === null || !Array.isArray(plan.shots)) {
    fail(`no live shot plan (${PLAN_FILE}) for ${caseId}`, {
      hint: `run \`darkpipe plan apply ${caseId}\` first`,
    });
  }

  const state = await readPlanState(ctx.ports, caseId);
  if (state.proposalPending) {
    ctx.sink.warn(
      `a plan proposal is waiting to be applied for ${caseId} — run \`darkpipe plan apply ${caseId}\` to make it live; writing prompts on the live plan (${PLAN_FILE}), never on ${PROPOSAL_FILE}`,
    );
  }

  const targets = pendingPromptShots(plan, block);
  const scopeText = block === null ? 'all blocks' : `block ${block}`;
  const text = [
    `case ${caseId}: ${targets.length} shot(s) still need a prompt (${scopeText})`,
    state.proposalPending
      ? `a proposal is waiting (${PROPOSAL_FILE}) — this run reads the live plan.`
      : 'reading the live plan.',
  ];

  if (!execute) {
    for (const shot of plan.shots.filter((entry) => targets.includes(entry.shot_num)).slice(0, 8)) {
      text.push(`  shot ${String(shot.shot_num).padStart(2, '0')}: ${truncate(String(shot.prompt ?? ''), 90) || '(empty)'}`);
    }
    text.push('dry run: pass --execute to write the prompts.');
    return {
      data: {
        case: caseId,
        execute: false,
        block,
        pending: targets.length,
        shots: targets,
        proposalPending: state.proposalPending,
        path: null,
      },
      text,
    };
  }

  if (targets.length === 0) {
    text.push('nothing to write: every shot in scope already has a prompt.');
    return {
      data: { case: caseId, execute: true, block, written: 0, shots: [], proposalPending: state.proposalPending, path: null },
      text,
    };
  }

  const wanted = plan.shots.filter((entry) => targets.includes(entry.shot_num));
  const response = await ctx.ports.text.complete({
    caseId,
    purpose: 'prompts',
    prompt: JSON.stringify({ shots: wanted.map((entry) => ({ shot_num: entry.shot_num, bloco: entry.bloco, ancora: entry.ancora })) }),
    system: 'Return JSON: {"prompts": [{"shot_num": <n>, "prompt": "<image prompt>"}]}',
    json: true,
  });
  const generated = parsePrompts(response.text);
  const byNumber = new Map(generated.map((entry) => [entry.shot_num, entry.prompt]));

  let written = 0;
  const shots: PlanShot[] = plan.shots.map((shot) => {
    if (!targets.includes(shot.shot_num) || !isPlaceholderPrompt(shot.prompt)) return shot;
    const fresh = byNumber.get(shot.shot_num);
    if (fresh === undefined || fresh.length === 0) return shot;
    written += 1;
    return { ...shot, prompt: fresh };
  });

  if (written === 0) {
    ctx.sink.warn('the text provider returned no usable prompt — the plan was left unchanged');
    return {
      data: { case: caseId, execute: true, block, written: 0, shots: [], proposalPending: state.proposalPending, path: null },
      text,
    };
  }

  const backup = await ctx.ports.files.backupArtifact(caseId, PLAN_FILE);
  const path = await ctx.ports.files.writeJson(caseId, PLAN_FILE, { ...plan, shots });
  text.push(`wrote ${written} prompt(s) on the live plan`);
  if (backup !== null) text.push(`previous plan backed up: ${backup}`);
  return {
    data: { case: caseId, execute: true, block, written, shots: targets, backup, path, proposalPending: state.proposalPending },
    text,
  };
}

export const promptsCommand: Command = {
  name: 'prompts',
  summary: 'write shot prompts on the live plan',
  usage: ['darkpipe prompts write <case_id> [--execute] [--block <n>]'],
  sub: {
    write: { name: 'write', summary: 'write prompts for shots that need one', run: write },
  },
  run: write,
};
