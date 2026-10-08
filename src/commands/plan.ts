/**
 * plan — propose, apply, anchor and check the shot plan. Owner: task group 4.
 *
 * VERIFY (task 4.1): a fixture case with silent audio produces the expected cut
 * count; a clip-only delta is reported pending; a hand-copied folder with no
 * store row does not gain shot rows.
 */

import type { Command, CommandContext } from '../command.ts';
import { requirePositional } from '../lib/args.ts';
import type { CommandResult } from '../lib/util.ts';
import {
  anchorPlan,
  anchoringProblem,
  applyPlan,
  proposePlan,
  readPlanState,
} from '../domain/plan.ts';
import { checkPlan, REPORT_FILE } from '../domain/check.ts';

async function propose(ctx: CommandContext): Promise<CommandResult> {
  const caseId = requirePositional(ctx.args, 0, 'case_id');
  const result = await proposePlan(ctx.ports, caseId);
  for (const warning of result.warnings) ctx.sink.warn(warning);
  const text = [
    `case ${caseId}: proposed ${result.proposal.shots.length} shot(s) across ${result.blocks} narration block(s)`,
    `map: ${result.cuts.length} cut(s) on the ${8.5}s ruler`,
    `proposal written: ${result.path}`,
    'next: run `darkpipe plan apply <case_id>`, then `darkpipe prompts write <case_id>`',
  ];
  return {
    data: {
      case: caseId,
      shots: result.proposal.shots.length,
      cuts: result.cuts.length,
      blocks: result.blocks,
      path: result.path,
    },
    text,
  };
}

async function apply(ctx: CommandContext): Promise<CommandResult> {
  const caseId = requirePositional(ctx.args, 0, 'case_id');
  const result = await applyPlan(ctx.ports, caseId);
  for (const warning of result.warnings) ctx.sink.warn(warning);
  const text = [
    `case ${caseId}: ${result.shots} shot(s) moved into the live plan (${result.cuts} cut(s))`,
    result.planBackup !== null ? `previous plan backed up: ${result.planBackup}` : 'the live plan did not exist before (nothing to back up)',
    result.mapBackup !== null ? `previous map backed up: ${result.mapBackup}` : 'the map was created from the proposal',
  ];
  if (result.preserved.length > 0) {
    text.push(`hand-written prompts preserved for shot(s): ${result.preserved.join(', ')}`);
  }
  return {
    data: {
      case: caseId,
      shots: result.shots,
      cuts: result.cuts,
      planBackup: result.planBackup,
      mapBackup: result.mapBackup,
      preserved: result.preserved,
    },
    text,
  };
}

async function anchor(ctx: CommandContext): Promise<CommandResult> {
  const caseId = requirePositional(ctx.args, 0, 'case_id');
  const result = await anchorPlan(ctx.ports, caseId);
  for (const warning of result.warnings) ctx.sink.warn(warning);
  const text = [
    `case ${caseId}: ${result.shots} shot(s) anchored across ${result.blocks} narration block(s)`,
    `lock written: ${result.lockPath}`,
  ];
  if (result.registered) {
    text.push(`store: ${result.inserted} shot row(s) inserted, ${result.removed} removed`);
  } else {
    text.push('store: the case is not registered — shot rows were not synced');
  }
  return {
    data: {
      case: caseId,
      shots: result.shots,
      blocks: result.blocks,
      lockPath: result.lockPath,
      registered: result.registered,
      inserted: result.inserted,
      removed: result.removed,
    },
    text,
  };
}

async function check(ctx: CommandContext): Promise<CommandResult> {
  const caseId = requirePositional(ctx.args, 0, 'case_id');
  const report = await checkPlan(ctx.ports, caseId);
  for (const warning of report.warnings) ctx.sink.warn(warning);
  const reportPath = await ctx.ports.files.writeText(caseId, REPORT_FILE, report.markdown);
  const { counts } = report;
  const text = [
    `case ${caseId}: ${counts.orphans} orphan(s) · ${counts.stretches} narration stretch(es) with no visual · ${counts.suspects} suspect(s) · ${counts.attention} attention point(s)`,
    `report: ${reportPath}`,
  ];
  if (counts.orphans > 0) {
    text.push(`orphans: ${report.orphans.map((issue) => issue.shot).join(', ')}`);
  }
  return {
    data: {
      case: caseId,
      orphans: counts.orphans,
      stretches: counts.stretches,
      suspects: counts.suspects,
      attention: counts.attention,
      report: reportPath,
      ok: counts.orphans === 0 && counts.suspects === 0 && counts.attention === 0,
    },
    text,
  };
}

async function show(ctx: CommandContext): Promise<CommandResult> {
  const caseId = requirePositional(ctx.args, 0, 'case_id');
  const state = await readPlanState(ctx.ports, caseId);
  const problem = anchoringProblem(state);
  const text = [
    `case ${caseId}: ${state.plan !== null ? `${state.plan.shots.length} shot(s)` : 'no shot plan'}`,
    state.proposalPending ? 'a plan proposal is waiting to be applied (`darkpipe plan apply`).' : 'no plan proposal is waiting.',
    state.anchored ? 'the plan is anchored.' : 'the plan is NOT anchored.',
  ];
  if (problem !== null) text.push(`action: ${problem}`);
  return {
    data: {
      case: caseId,
      shots: state.plan?.shots.length ?? 0,
      proposalPending: state.proposalPending,
      anchored: state.anchored,
      problem,
    },
    text,
  };
}

export const planCommand: Command = {
  name: 'plan',
  summary: 'propose, apply, anchor and check the shot plan',
  usage: [
    'darkpipe plan propose <case_id> [--json]',
    'darkpipe plan apply <case_id>',
    'darkpipe plan anchor <case_id>',
    'darkpipe plan check <case_id>',
    'darkpipe plan show <case_id>',
  ],
  sub: {
    propose: { name: 'propose', summary: 'propose cuts from the recorded narration', run: propose },
    apply: { name: 'apply', summary: 'move the proposal into the live plan', run: apply },
    anchor: { name: 'anchor', summary: 'lock the plan to the narration and sync the store', run: anchor },
    check: { name: 'check', summary: 'list what needs a human eye', run: check },
    show: { name: 'show', summary: 'report the plan, the proposal and the lock', run: show },
  },
  run: show,
};
