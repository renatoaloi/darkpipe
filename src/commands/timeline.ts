/**
 * timeline — the cut map verbs. Owner: task group 4.
 *
 * Every operation that changes the map writes a backup first through the files
 * port. `undo` restores the previous map bytes and keeps the map that was live as
 * a backup. A retime step that moves a clip toward 0.5x-2x is accepted even when
 * the clip started outside it.
 *
 * VERIFY (task 4.3): undo restores the previous map bytes, and a 2.2x clip
 * shortened toward the range is accepted.
 */

import type { Command, CommandContext } from '../command.ts';
import type { CommandResult } from '../lib/util.ts';
import { fail } from '../lib/util.ts';
import { flagNumber, flagSet, flagValue, parseBlocks, requirePositional } from '../lib/args.ts';
import { DEFAULT_GAPS, seconds as fmtSeconds } from '../ruler.ts';
import type { ShotKind, ShotPlan, TimelineMap } from '../ports.ts';
import {
  MAP_FILE,
  SHOTS_DIR,
  CLIP_KIND,
  STILL_KIND,
  collectValidatedCuts,
  findCuts,
  isClipKind,
  normalizeGaps,
  opBoundary,
  opEndcard,
  opGaps,
  opInclude,
  opRemove,
  opSlide,
  opSnap,
  opSpan,
  opSwap,
  padShot,
  toSpan,
  validateCuts,
  type OpResult,
} from '../domain/timeline.ts';
import { blockSecondsMap, readNarration } from '../domain/narration.ts';
import { PLAN_FILE } from '../domain/plan.ts';

const SHOT_PLAN_FILE = PLAN_FILE;

async function loadMap(ctx: CommandContext, caseId: string): Promise<TimelineMap> {
  const map = await ctx.ports.files.readJson<TimelineMap>(caseId, MAP_FILE);
  if (map === null || !Array.isArray(map.cuts)) {
    fail(`no timeline.json for ${caseId}`, { hint: `run \`darkpipe plan apply ${caseId}\` first` });
  }
  return map;
}

async function narrationInfo(ctx: CommandContext, caseId: string): Promise<{ blockSeconds: Record<number, number>; sentences: Record<number, string[]>; blocks: number }> {
  const narration = await readNarration(ctx.ports, caseId);
  for (const warning of narration.warnings) ctx.sink.warn(warning);
  const sentences: Record<number, string[]> = {};
  for (const block of narration.blocks) sentences[block.index] = block.sentences;
  return { blockSeconds: blockSecondsMap(narration), sentences, blocks: narration.blocks.length };
}

async function clipFileSeconds(ctx: CommandContext, caseId: string, shot: string): Promise<number | null> {
  const absolute = ctx.ports.files.resolve(caseId, `${SHOTS_DIR}/shot_${padShot(shot)}.mp4`);
  try {
    const value = await ctx.ports.render.probe(absolute);
    return value !== null && value > 0 ? value : null;
  } catch {
    return null;
  }
}

async function persist(ctx: CommandContext, caseId: string, map: TimelineMap): Promise<string> {
  await ctx.ports.files.backupArtifact(caseId, MAP_FILE);
  return ctx.ports.files.writeJson(caseId, MAP_FILE, map);
}

function opResult(ctx: CommandContext, caseId: string, result: OpResult, extra: Record<string, unknown> = {}): CommandResult {
  if (result.refused) fail(result.messages[0] ?? `the map was not changed for ${caseId}`);
  const changedMessages = result.changed ? result.messages : ['nothing changed'];
  const text = changedMessages.length > 0 ? changedMessages : ['nothing changed'];
  return {
    data: {
      case: caseId,
      changed: result.changed,
      cuts: (result.map.cuts ?? []).length,
      ...extra,
    },
    text,
  };
}

async function show(ctx: CommandContext): Promise<CommandResult> {
  const caseId = requirePositional(ctx.args, 0, 'case_id');
  const map = await loadMap(ctx, caseId);
  const { blockSeconds, blocks } = await narrationInfo(ctx, caseId);
  const cuts = await collectValidatedCuts(ctx.ports, caseId, map, blockSeconds);
  const report = validateCuts(cuts);
  const text = [`case ${caseId}: ${cuts.length} cut(s) across ${blocks} narration block(s)`];
  for (const cut of cuts) {
    text.push(
      `  ${cut.shot}  block ${cut.block}  ${cut.kind.padEnd(5)}  span [${toSpan(cut.span)[0].toFixed(3)},${toSpan(cut.span)[1].toFixed(3)}]  ${fmtSeconds(cut.seconds).padStart(7)}  ${cut.path !== null ? cut.path : `(no file in ${SHOTS_DIR}/)`}`,
    );
  }
  text.push(`blocking issues: ${report.blocking.length}, warnings: ${report.warnings.length}`);
  return {
    data: {
      case: caseId,
      blocks,
      gaps: map.gaps ?? [],
      cuts: cuts.map((cut) => ({
        shot: cut.shot,
        block: cut.block,
        kind: cut.kind,
        span: cut.span,
        seconds: cut.seconds,
        retime: cut.retime,
        path: cut.path,
      })),
      blocking: report.blocking.length,
      warnings: report.warnings.length,
    },
    text,
  };
}

async function validate(ctx: CommandContext): Promise<CommandResult> {
  const caseId = requirePositional(ctx.args, 0, 'case_id');
  const blocks = parseBlocks(flagValue(ctx.args, '--blocks'));
  const map = await loadMap(ctx, caseId);
  const { blockSeconds } = await narrationInfo(ctx, caseId);
  const cuts = await collectValidatedCuts(ctx.ports, caseId, map, blockSeconds);
  const report = validateCuts(cuts, { blocks });
  if (!report.ok) {
    const head = report.blocking.slice(0, 3).map((issue) => issue.message).join('; ');
    fail(`timeline validation failed: ${report.blocking.length} blocking issue(s) — ${head}`, {
      hint: 'fix the map with `darkpipe timeline` verbs, then re-run validate',
    });
  }
  const text = [`case ${caseId}: the map is coherent${blocks !== null ? ` in block(s) ${blocks.join(', ')}` : ''}`];
  for (const warning of report.warnings) text.push(`  (warning) ${warning.message}`);
  return {
    data: {
      case: caseId,
      ok: true,
      blocks,
      blocking: [],
      warnings: report.warnings.map((issue) => issue.message),
    },
    text,
  };
}

async function span(ctx: CommandContext): Promise<CommandResult> {
  const caseId = requirePositional(ctx.args, 0, 'case_id');
  const shot = requirePositional(ctx.args, 1, 'shot');
  const map = await loadMap(ctx, caseId);
  const ini = flagNumber(ctx.args, '--ini') ?? (ctx.args.positionals[2] !== undefined ? Number(ctx.args.positionals[2]) : undefined);
  const fim = flagNumber(ctx.args, '--fim') ?? (ctx.args.positionals[3] !== undefined ? Number(ctx.args.positionals[3]) : undefined);
  const kindFlag = flagValue(ctx.args, '--kind');
  const originFlag = flagValue(ctx.args, '--origin');
  if (ini === undefined && fim === undefined && kindFlag === undefined && originFlag === undefined) {
    fail('nothing to change: pass [start end], --kind still|video or --origin real|generated');
  }
  const normalizedKind: ShotKind | undefined =
    kindFlag === undefined
      ? undefined
      : kindFlag === 'still'
        ? STILL_KIND
        : kindFlag === 'video' || kindFlag === 'clip'
          ? CLIP_KIND
          : undefined;
  if (kindFlag !== undefined && normalizedKind === undefined) {
    fail(`--kind accepts still or video, got "${kindFlag}"`);
  }
  if (ini !== undefined && fim !== undefined && !(0 <= ini && ini < fim && fim <= 1)) {
    fail(`span must satisfy 0 <= start < end <= 1 (a block fraction), got [${ini},${fim}]`);
  }
  const result = opSpan(map, shot, {
    ...(ini !== undefined && fim !== undefined ? { span: [ini, fim] as [number, number] } : {}),
    ...(normalizedKind !== undefined ? { kind: normalizedKind } : {}),
    ...(originFlag !== undefined ? { origin: originFlag === '' ? null : originFlag } : {}),
  });
  if (result.refused) fail(result.messages[0]);
  await persist(ctx, caseId, result.map);
  return opResult(ctx, caseId, result);
}

async function boundary(ctx: CommandContext): Promise<CommandResult> {
  const caseId = requirePositional(ctx.args, 0, 'case_id');
  const shot = requirePositional(ctx.args, 1, 'shot');
  const value = requirePositional(ctx.args, 2, 'delta');
  const map = await loadMap(ctx, caseId);
  const { blockSeconds } = await narrationInfo(ctx, caseId);
  const target = findCuts(map, shot)[0];
  const clipSeconds = target !== undefined && isClipKind(target.kind) ? await clipFileSeconds(ctx, caseId, shot) : null;
  const result = opBoundary(map, shot, value, blockSeconds, clipSeconds);
  if (result.refused) fail(result.messages[0]);
  if (result.changed) await persist(ctx, caseId, result.map);
  return opResult(ctx, caseId, result);
}

async function slide(ctx: CommandContext): Promise<CommandResult> {
  const caseId = requirePositional(ctx.args, 0, 'case_id');
  const shot = requirePositional(ctx.args, 1, 'shot');
  const value = requirePositional(ctx.args, 2, 'delta');
  const map = await loadMap(ctx, caseId);
  const { blockSeconds } = await narrationInfo(ctx, caseId);
  const result = opSlide(map, shot, value, blockSeconds);
  if (result.refused) fail(result.messages[0]);
  if (result.changed) await persist(ctx, caseId, result.map);
  return opResult(ctx, caseId, result);
}

async function snap(ctx: CommandContext): Promise<CommandResult> {
  const caseId = requirePositional(ctx.args, 0, 'case_id');
  const shot = requirePositional(ctx.args, 1, 'shot');
  const map = await loadMap(ctx, caseId);
  const { blockSeconds, sentences } = await narrationInfo(ctx, caseId);
  const result = opSnap(map, shot, sentences, blockSeconds);
  if (result.refused) fail(result.messages[0]);
  if (result.changed) await persist(ctx, caseId, result.map);
  return opResult(ctx, caseId, result);
}

async function include(ctx: CommandContext): Promise<CommandResult> {
  const caseId = requirePositional(ctx.args, 0, 'case_id');
  const shot = requirePositional(ctx.args, 1, 'shot');
  const map = await loadMap(ctx, caseId);
  const plan = await ctx.ports.files.readJson<ShotPlan>(caseId, SHOT_PLAN_FILE);
  const planShot = (plan?.shots ?? []).find((entry) => padShot(entry.shot_num) === padShot(shot)) ?? null;
  const result = opInclude(
    map,
    shot,
    planShot !== null ? { bloco: Number(planShot.bloco ?? 0), span: toSpan(planShot.span), tipo: planShot.tipo } : null,
  );
  if (result.refused) fail(result.messages[0]);
  if (result.changed) await persist(ctx, caseId, result.map);
  return opResult(ctx, caseId, result);
}

async function remove(ctx: CommandContext): Promise<CommandResult> {
  const caseId = requirePositional(ctx.args, 0, 'case_id');
  const shot = requirePositional(ctx.args, 1, 'shot');
  const map = await loadMap(ctx, caseId);
  const result = opRemove(map, shot);
  if (result.refused) fail(result.messages[0]);
  if (result.changed) await persist(ctx, caseId, result.map);
  return opResult(ctx, caseId, result);
}

async function swap(ctx: CommandContext): Promise<CommandResult> {
  const caseId = requirePositional(ctx.args, 0, 'case_id');
  const a = requirePositional(ctx.args, 1, 'shot_a');
  const b = requirePositional(ctx.args, 2, 'shot_b');
  const map = await loadMap(ctx, caseId);
  const result = opSwap(map, a, b);
  if (result.refused) fail(result.messages[0]);
  if (result.changed) await persist(ctx, caseId, result.map);
  return opResult(ctx, caseId, result);
}

async function gaps(ctx: CommandContext): Promise<CommandResult> {
  const caseId = requirePositional(ctx.args, 0, 'case_id');
  const map = await loadMap(ctx, caseId);
  const { blocks } = await narrationInfo(ctx, caseId);
  const count = blocks > 0 ? blocks : Math.max(1, new Set((map.cuts ?? []).map((cut) => Number(cut.block))).size);
  const defaultGap = flagNumber(ctx.args, '--default');
  const opening = flagNumber(ctx.args, '--opening');
  const jsonRaw = flagValue(ctx.args, '--json');
  const reset = flagSet(ctx.args, '--reset');
  const fill = flagValue(ctx.args, '--fill');
  const touches = defaultGap !== undefined || opening !== undefined || jsonRaw !== undefined || reset || fill !== undefined;

  if (!touches) {
    const current = normalizeGaps(map.gaps, count);
    const text = [`case ${caseId}: ${count} block(s), pauses after each block:`];
    current.forEach((pause, index) => {
      text.push(`  block ${index}: ${index < count - 1 ? `${pause.toFixed(1)}s` : '(nothing follows: ignored)'}`);
    });
    text.push(`gaps_fill: ${String(map.gaps_fill ?? 'still05')}`);
    return { data: { case: caseId, blocks: count, gaps: current, gaps_fill: map.gaps_fill ?? 'still05' }, text };
  }

  let next = normalizeGaps(map.gaps, count);
  if (reset) next = normalizeGaps(DEFAULT_GAPS, count);
  if (defaultGap !== undefined) next = next.map(() => defaultGap);
  if (opening !== undefined) next[0] = opening;
  if (jsonRaw !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonRaw);
    } catch {
      fail(`--json expects a JSON array, got "${jsonRaw}"`);
    }
    if (!Array.isArray(parsed)) fail('--json expects a JSON array of seconds, e.g. \'[2.0,0.8,0.8]\'');
    next = normalizeGaps(parsed, parsed.length);
  }
  const result = opGaps(map, next, fill);
  await persist(ctx, caseId, result.map);
  return opResult(ctx, caseId, result, { gaps: result.map.gaps });
}

async function endcard(ctx: CommandContext): Promise<CommandResult> {
  const caseId = requirePositional(ctx.args, 0, 'case_id');
  const map = await loadMap(ctx, caseId);
  const shot = flagValue(ctx.args, '--shot');
  const secs = flagNumber(ctx.args, '--seconds');
  if (shot === undefined && secs === undefined) {
    const text = [
      `case ${caseId}: channel stamp (end_card) is shot ${String(map.end_card ?? '06')}`,
      `duration: ${map.end_card_seconds !== undefined ? fmtSeconds(Number(map.end_card_seconds)) : '(default)'}`,
    ];
    return { data: { case: caseId, end_card: map.end_card ?? '06', end_card_seconds: map.end_card_seconds ?? null }, text };
  }
  const result = opEndcard(map, {
    ...(shot !== undefined ? { shot } : {}),
    ...(secs !== undefined ? { seconds: secs } : {}),
  });
  await persist(ctx, caseId, result.map);
  return opResult(ctx, caseId, result);
}

async function undo(ctx: CommandContext): Promise<CommandResult> {
  const caseId = requirePositional(ctx.args, 0, 'case_id');
  const current = await ctx.ports.files.readText(caseId, MAP_FILE);
  if (current === null) fail(`no timeline.json for ${caseId} to undo`);
  const backups = await ctx.ports.files.listBackups(caseId, MAP_FILE);
  if (backups.length === 0) {
    return { data: { case: caseId, changed: false, backups: 0 }, text: ['nothing to undo: the map was never changed (no backup)'] };
  }
  let target: string | null = null;
  for (let index = backups.length - 1; index >= 0; index -= 1) {
    let bytes: string | null = null;
    try {
      bytes = await ctx.ports.files.readText(caseId, backups[index]);
    } catch {
      bytes = null;
    }
    if (bytes === null || bytes !== current) {
      target = backups[index];
      break;
    }
  }
  if (target === null) {
    return { data: { case: caseId, changed: false, backups: backups.length }, text: ['nothing to undo: every backup matches the live map'] };
  }
  const previous = await ctx.ports.files.readText(caseId, target).catch(() => null);
  const kept = await ctx.ports.files.backupArtifact(caseId, MAP_FILE);
  const warnings: string[] = [];
  // Some adapters name a backup with one-second resolution, so the "kept" copy can
  // reuse the restore point's name. Rewrite the restore point from memory so the
  // undo still lands on the previous bytes.
  if (kept !== null && previous !== null && kept === target) {
    await ctx.ports.files.writeText(caseId, target, previous);
    warnings.push('the backup name collided with the restore point; it was rewritten from the live map');
  }
  await ctx.ports.files.restoreArtifact(caseId, target);
  for (const warning of warnings) ctx.sink.warn(warning);
  return {
    data: { case: caseId, changed: true, undone: target, kept, previous: current.length },
    text: [
      `case ${caseId}: restored the previous map from ${target}`,
      kept !== null && kept !== target
        ? `the replaced map was kept as a backup: ${kept}`
        : 'the replaced map was kept as a backup under the same stamp',
    ],
  };
}

function verb(summary: string, run: (ctx: CommandContext) => Promise<CommandResult>): Command {
  return { name: summary, summary, run };
}

export const timelineCommand: Command = {
  name: 'timeline',
  summary: 'inspect and adjust the cut map',
  usage: [
    'darkpipe timeline show <case_id>',
    'darkpipe timeline span <case_id> <shot> <seconds>',
    'darkpipe timeline boundary <case_id> <shot> <delta>',
    'darkpipe timeline slide <case_id> <shot> <delta>',
    'darkpipe timeline snap <case_id> <shot>',
    'darkpipe timeline include <case_id> <shot>',
    'darkpipe timeline remove <case_id> <shot>',
    'darkpipe timeline swap <case_id> <shot_a> <shot_b>',
    'darkpipe timeline gaps <case_id> [--default <s> | --opening <s> | --reset]',
    'darkpipe timeline endcard <case_id> [--seconds <s>]',
    'darkpipe timeline validate <case_id> [--blocks <n[,m]>]',
    'darkpipe timeline undo <case_id>',
  ],
  sub: {
    show: verb('print the cut map', show),
    span: verb('set the on-screen time of one cut', span),
    boundary: verb('move one boundary and its neighbour together', boundary),
    slide: verb('move a cut window', slide),
    snap: verb('snap a cut to the narration sentence change', snap),
    include: verb('bring a removed cut back', include),
    remove: verb('take a cut out of the map', remove),
    swap: verb('exchange two cuts', swap),
    gaps: verb('set the pauses between blocks', gaps),
    endcard: verb('set the closing card', endcard),
    validate: verb('report cut, retime, gap and overlap problems', validate),
    undo: verb('restore the previous map', undo),
  },
  run: show,
};
