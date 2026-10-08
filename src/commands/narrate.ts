/**
 * narrate — speech synthesis for the narration blocks. Owner: task 5.2.
 *
 * One audio file per block under `02_narration_parts/`, named exactly as the
 * script's `## §N — salvar como `NN_name.mp3`` heading says. Dry run by default:
 * no ledger event is appended and no existing recording is overwritten (pass
 * `--force` to re-record a block, keeping the previous file as a backup).
 */

import type { Command, CommandContext } from '../command.ts';
import type { ProviderCallResult } from '../ports.ts';
import { flagNumber, flagSet, requirePositional } from '../lib/args.ts';
import { DarkpipeError } from '../lib/util.ts';
import { metered } from '../spend.ts';
import {
  NARRATION_DIR,
  NARRATION_SCRIPT,
  parseNarrationScript,
  type NarrationScriptBlock,
} from '../domain/generate.ts';

interface BlockRow {
  block: number;
  number: number;
  file: string;
  relative: string;
  chars: number;
}

function row(block: NarrationScriptBlock): BlockRow {
  return {
    block: block.index,
    number: block.number,
    file: block.name,
    relative: block.relative,
    chars: block.text.length,
  };
}

async function run(ctx: CommandContext): Promise<{ data: Record<string, unknown>; text: string[] }> {
  const caseId = requirePositional(ctx.args, 0, 'case_id');
  const block = flagNumber(ctx.args, '--block') ?? null;
  const force = flagSet(ctx.args, '--force');

  if (!(await ctx.ports.files.exists(caseId))) {
    throw new DarkpipeError(`case ${caseId} is not on disk`, {
      hint: 'run `darkpipe case list` to see the registered cases',
    });
  }
  const script = await ctx.ports.files.readText(caseId, NARRATION_SCRIPT);
  if (script === null || script.trim().length === 0) {
    throw new DarkpipeError(`case ${caseId} has no ${NARRATION_SCRIPT}`, {
      hint: `write the narration script at cases/${caseId}/${NARRATION_SCRIPT} first`,
    });
  }
  const all = parseNarrationScript(script);
  if (all.length === 0) {
    throw new DarkpipeError(`no narration blocks found in ${NARRATION_SCRIPT}`, {
      hint: 'each block needs a heading like `## §1 — salvar como `01_cold_open.mp3``',
    });
  }
  const scope = block === null ? all : all.filter((entry) => entry.index === block);
  if (scope.length === 0) {
    throw new DarkpipeError(`block ${block} is not in ${NARRATION_SCRIPT}`, {
      hint: `this script has block indexes 0..${all.length - 1}`,
    });
  }

  const present = new Set(await ctx.ports.files.listFiles(caseId));
  const skipped = scope.filter((entry) => !force && present.has(entry.relative));
  const empty = scope.filter((entry) => entry.text.length === 0);
  const pending = scope.filter((entry) => (force || !present.has(entry.relative)) && entry.text.length > 0);
  const audioDir = ctx.ports.files.resolve(caseId, NARRATION_DIR);
  const scopeText = block === null ? 'the whole case' : `block ${block}`;

  if (!flagSet(ctx.args, '--execute')) {
    return {
      data: {
        ok: true,
        dry_run: true,
        case_id: caseId,
        block,
        scope: scopeText,
        audio_dir: audioDir,
        blocks: scope.map(row),
        to_synthesize: pending.map(row),
        keeping: skipped.map(row),
        empty: empty.map(row),
      },
      text: [
        `narrate ${caseId} — ${scopeText}: ${pending.length} block(s) to synthesize, ${skipped.length} kept`,
        ...pending.map((entry) => `  will synthesize ${entry.name} (${entry.text.length} chars)`),
        ...skipped.map((entry) => `  keeping ${entry.name} (already recorded)`),
        ...empty.map((entry) => `  ${entry.name} has no text — write the block`),
        'dry run — pass --execute to synthesize',
      ],
    };
  }

  if (pending.length === 0) {
    return {
      data: { ok: true, case_id: caseId, block, generated: [], keeping: skipped.map(row) },
      text: [`narrate ${caseId}: nothing to synthesize — every block already has audio`],
    };
  }

  if (!flagSet(ctx.args, '--foreground') && !flagSet(ctx.args, '--no-fork')) {
    const job = await ctx.jobs.spawn([...ctx.args.raw, '--foreground'], `narrate ${caseId}`);
    return {
      data: {
        ok: true,
        job_id: job.id,
        status: job.status,
        command: job.command,
        case_id: caseId,
        block,
        to_synthesize: pending.map(row),
      },
      text: [`narrate ${caseId}: running as ${job.id}`, 'watch it with `darkpipe jobs`'],
    };
  }

  const voice = typeof ctx.config.speech.voice === 'string' ? ctx.config.speech.voice : undefined;
  const model = typeof ctx.config.speech.model === 'string' ? ctx.config.speech.model : undefined;
  const generated: Array<Record<string, unknown>> = [];
  for (const entry of pending) {
    if (force && present.has(entry.relative)) {
      await ctx.ports.files.backupArtifact(caseId, entry.relative);
    }
    const outPath = ctx.ports.files.resolve(caseId, entry.relative);
    const result: ProviderCallResult = await metered(
      ctx.ports.ledger,
      { caseId, shot: null, kind: 'narration' },
      () =>
        ctx.ports.speech.synthesize({
          caseId,
          block: entry.index,
          text: entry.text,
          outPath,
          voice,
          model,
        }),
    );
    generated.push({ block: entry.index, file: entry.name, path: result.path, usd: result.usd, model: result.model });
  }

  return {
    data: { ok: true, case_id: caseId, block, audio_dir: audioDir, generated, keeping: skipped.map(row) },
    text: [
      `narrate ${caseId}: ${generated.length} block(s) written`,
      ...generated.map((entry) => `  ${String(entry.file)} -> ${String(entry.path)} (US$ ${Number(entry.usd).toFixed(4)})`),
    ],
  };
}

export const narrateCommand: Command = {
  name: 'narrate',
  summary: 'write the narration audio for a case (dry run unless --execute)',
  usage: ['darkpipe narrate <case_id> [--execute] [--block <n>] [--force] [--foreground]'],
  longRunning: true,
  run,
};
