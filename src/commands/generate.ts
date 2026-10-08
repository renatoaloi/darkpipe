/**
 * generate — paid stills and clips through the media port. Owner: task 5.2.
 *
 * Rules ported from the legacy generator:
 *   - refuse when the plan is not anchored to the current narration (name the
 *     repair commands), unless `--no-check` is passed explicitly;
 *   - the `[A DEFINIR]` pending-prompt gate looks ONLY at the requested `--block`
 *     scope: a chapter with a written prompt is generated even when another
 *     chapter still has a placeholder — the whole-case run refuses and names the
 *     shots without a prompt;
 *   - one artifact per shot under `04_shots/`, the previous file backed up before
 *     it is redone (`--force`/`--no-backup` skip the backup);
 *   - dry run by default: the ledger byte size does not change;
 *   - long run: `--execute` without `--foreground` forks a job and returns its id.
 */

import type { Command, CommandContext } from '../command.ts';
import { flagNumber, flagSet, requirePositional } from '../lib/args.ts';
import { DarkpipeError } from '../lib/util.ts';
import { isExecute } from '../lib/guards.ts';
import { metered } from '../spend.ts';
import { anchoringProblem, pendingPromptShots, readPlanState } from '../domain/plan.ts';
import { artRelativePath, formatShotNumbers, shotsInBlock } from '../domain/generate.ts';

interface ArtItem {
  shot: number;
  kind: 'still' | 'clip';
  relative: string;
  prompt: string;
  seconds: number;
  exists: boolean;
}

/** A config section, read structurally so this command imports no config code. */
type Settings = Record<string, unknown>;

function settingNumber(settings: Settings, name: string): number | null {
  const value = settings[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function settingString(settings: Settings, name: string): string | null {
  const value = settings[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function run(ctx: CommandContext): Promise<{ data: Record<string, unknown>; text: string[] }> {
  const caseId = requirePositional(ctx.args, 0, 'case_id');
  const block = flagNumber(ctx.args, '--block') ?? null;
  const noCheck = flagSet(ctx.args, '--no-check');
  const force = flagSet(ctx.args, '--force');
  const noBackup = force || flagSet(ctx.args, '--no-backup');
  const execute = isExecute(ctx);

  if (!(await ctx.ports.files.exists(caseId))) {
    throw new DarkpipeError(`case ${caseId} is not on disk`, {
      hint: 'run `darkpipe case list` to see the registered cases',
    });
  }

  const state = await readPlanState(ctx.ports, caseId);
  if (!noCheck) {
    const problem = anchoringProblem(state);
    if (problem !== null) {
      throw new DarkpipeError(problem, {
        hint: 'run `darkpipe plan anchor <case_id>` and `darkpipe plan check <case_id>`',
      });
    }
  }
  if (state.plan === null) {
    throw new DarkpipeError(`case ${caseId} has no shot plan`, {
      hint: 'run `darkpipe plan propose <case_id>`, then `darkpipe plan anchor <case_id>` and `darkpipe plan check <case_id>`',
    });
  }

  const pending = pendingPromptShots(state.plan, block);
  if (pending.length > 0) {
    const scopeText = block === null ? 'the whole case' : `block ${block}`;
    throw new DarkpipeError(
      `${formatShotNumbers(pending)} still have an [A DEFINIR] prompt in ${scopeText} — write the prompts before spending`,
      { hint: 'run `darkpipe prompts write <case_id>`' },
    );
  }

  const scope = shotsInBlock(state.plan, block);
  if (scope.length === 0) {
    throw new DarkpipeError(
      `no shots in ${block === null ? 'the plan' : `block ${block}`}`,
      { hint: 'run `darkpipe plan check <case_id>` to see which blocks have shots' },
    );
  }

  const media = ctx.config.media;
  const width = settingNumber(media, 'width') ?? 1280;
  const height = settingNumber(media, 'height') ?? 720;
  const defaultSeconds = settingNumber(media, 'seconds') ?? 6;
  const model = settingString(media, 'model');

  const present = new Set(await ctx.ports.files.listFiles(caseId));
  const items: ArtItem[] = scope.map((shot) => ({
    shot: shot.shot_num,
    kind: shot.tipo === 'video' ? 'clip' : 'still',
    relative: artRelativePath(shot),
    prompt: shot.prompt,
    seconds: shot.tipo === 'video' ? Number(shot.duracao_s || defaultSeconds) : 0,
    exists: present.has(artRelativePath(shot)),
  }));
  const scopeText = block === null ? 'the whole case' : `block ${block}`;

  if (!execute) {
    return {
      data: {
        ok: true,
        dry_run: true,
        case_id: caseId,
        block,
        scope: scopeText,
        anchored: state.anchored,
        shots_dir: ctx.ports.files.resolve(caseId, '04_shots'),
        ledger: ctx.ports.ledger.location,
        shots: items,
      },
      text: [
        `generate ${caseId} — ${scopeText}: ${items.length} shot(s)`,
        ...items.map(
          (item) =>
            `  shot ${item.shot} [${item.kind}] -> ${item.relative}${item.exists ? ' (exists — would be backed up)' : ''}`,
        ),
        'dry run — the ledger is untouched; pass --execute to spend',
      ],
    };
  }

  if (!flagSet(ctx.args, '--foreground') && !flagSet(ctx.args, '--no-fork')) {
    const job = await ctx.jobs.spawn([...ctx.args.raw, '--foreground'], `generate ${caseId}`);
    return {
      data: {
        ok: true,
        job_id: job.id,
        status: job.status,
        command: job.command,
        case_id: caseId,
        block,
        shots: items.map((item) => ({ shot: item.shot, kind: item.kind, relative: item.relative })),
      },
      text: [`generate ${caseId}: running as ${job.id}`, 'watch it with `darkpipe jobs`'],
    };
  }

  const generated: Array<Record<string, unknown>> = [];
  for (const item of items) {
    if (item.exists && !noBackup) {
      try {
        await ctx.ports.files.backupArtifact(caseId, item.relative);
      } catch (error) {
        throw new DarkpipeError(
          `could not back up ${item.relative} before redoing it: ${(error as Error).message}`,
          {
            port: 'files',
            hint: 'nothing was overwritten. Pass --force to redo without a backup.',
          },
        );
      }
    }
    const outPath = ctx.ports.files.resolve(caseId, item.relative);
    const shotNumber = item.shot;
    const result = await metered(ctx.ports.ledger, { caseId, shot: shotNumber, kind: item.kind }, () =>
      item.kind === 'clip'
        ? ctx.ports.media.clip({
            caseId,
            shot: shotNumber,
            prompt: item.prompt,
            outPath,
            seconds: item.seconds,
            model: model ?? undefined,
          })
        : ctx.ports.media.still({
            caseId,
            shot: shotNumber,
            prompt: item.prompt,
            outPath,
            width,
            height,
            model: model ?? undefined,
          }),
    );
    generated.push({
      shot: item.shot,
      kind: item.kind,
      relative: item.relative,
      path: result.path,
      usd: result.usd,
      model: result.model,
    });
  }

  return {
    data: {
      ok: true,
      case_id: caseId,
      block,
      scope: scopeText,
      shots_dir: ctx.ports.files.resolve(caseId, '04_shots'),
      ledger: ctx.ports.ledger.location,
      generated,
    },
    text: [
      `generate ${caseId}: ${generated.length} shot(s) written`,
      ...generated.map(
        (entry) =>
          `  shot ${String(entry.shot)} [${String(entry.kind)}] -> ${String(entry.path)} (US$ ${Number(entry.usd).toFixed(4)})`,
      ),
      'every attempt is in the ledger (`darkpipe costs --json`)',
    ],
  };
}

export const generateCommand: Command = {
  name: 'generate',
  summary: 'generate stills and clips (dry run unless --execute)',
  usage: [
    'darkpipe generate <case_id> [--execute] [--block <n>] [--no-check] [--force] [--foreground]',
  ],
  longRunning: true,
  run,
};
