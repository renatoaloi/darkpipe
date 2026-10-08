/**
 * render — validate the map and assemble the video through the render port.
 *
 * Owner: task group 6. `--check` only reports; `--blocks` writes a chapter
 * preview that uses the same time ruler and never touches the final video; the
 * previous final is kept under a timestamped name. A long run forks through
 * `ctx.jobs` unless `--foreground` is given.
 */

import type { Command } from '../command.ts';
import { DarkpipeError } from '../lib/util.ts';
import { flagSet, flagValue, parseBlocks, requirePositional } from '../lib/args.ts';
import {
  caseFile,
  fileChecksum,
  finalRelativeName,
  inspectRender,
  issueLines,
  mapLines,
  outputRelativeName,
  renderTo,
} from '../domain/render.ts';

export const renderCommand: Command = {
  name: 'render',
  summary: 'validate the map and assemble the video through the render port',
  usage: ['darkpipe render <case_id> [--blocks <n[,m]>] [--no-backup] [--check] [--foreground]'],
  longRunning: true,
  run: async (ctx) => {
    const caseId = requirePositional(ctx.args, 0, 'case id');
    const scope = parseBlocks(flagValue(ctx.args, '--blocks'));
    const check = flagSet(ctx.args, '--check');
    const backup = !flagSet(ctx.args, '--no-backup');
    const foreground = flagSet(ctx.args, '--foreground');

    const inspection = await inspectRender(ctx.ports, caseId, scope);
    const lines = mapLines(inspection);

    if (!inspection.report.ok) {
      const problems = issueLines(inspection.report);
      throw new DarkpipeError(
        [
          ...lines,
          '',
          `render refused: ${inspection.report.blocking.length} problem(s) in ${caseId}`,
          ...problems,
        ].join('\n'),
        { hint: 'fix the map with `darkpipe timeline`, then run render again — nothing was written' },
      );
    }
    for (const issue of inspection.report.warnings) {
      ctx.sink.warn(`${caseId}: ${issue.message}`);
    }

    if (check) {
      lines.push('', `ok: the map is coherent${scope === null ? '' : ` inside chapters ${scope.join(',')}`} — nothing was rendered.`);
      return {
        data: {
          case: caseId,
          blocks: scope,
          check: true,
          cuts: inspection.cuts.length,
          warnings: inspection.report.warnings,
        },
        text: lines,
      };
    }

    const relative = outputRelativeName(caseId, scope);
    const out = await caseFile(ctx.ports, caseId, relative);

    if (!foreground) {
      const job = await ctx.jobs.spawn([...ctx.args.raw, '--foreground'], `render ${caseId}`);
      return {
        data: { case: caseId, blocks: scope, jobId: job.id, status: job.status, path: out.absolute },
        text: [`render started as job ${job.id}`, 'follow it with `darkpipe jobs` — cancel with `darkpipe jobs cancel <id>`'],
      };
    }

    if (!(await ctx.ports.render.available())) {
      const binary = String(ctx.config.render.ffmpeg ?? 'ffmpeg');
      throw new DarkpipeError(`render port: the "${binary}" binary is not on PATH`, {
        port: 'render',
        hint: `install ffmpeg and put ${binary} on PATH — the operator installs it, darkpipe does not bundle it`,
      });
    }

    lines.push('');
    let previous: { path: string; checksum: string } | null = null;
    if (scope === null && backup) {
      const final = await caseFile(ctx.ports, caseId, finalRelativeName(caseId));
      if (final.exists) {
        const backupPath = await ctx.ports.files.backupArtifact(caseId, finalRelativeName(caseId));
        if (backupPath !== null) {
          previous = { path: backupPath, checksum: fileChecksum(backupPath) };
          lines.push(`previous final kept as ${backupPath}`);
        }
      }
    }

    const outcome = await renderTo(ctx.ports, inspection, out.absolute);
    lines.push(`wrote ${outcome.absolute}`);
    lines.push(`  ${outcome.segments} segment(s) · ${outcome.seconds.toFixed(2)}s · ${outcome.result.bytes} bytes`);
    lines.push(`  checksum sha256 ${outcome.result.checksum}`);
    if (previous !== null) {
      lines.push(`  previous ${previous.path} checksum ${previous.checksum}`);
      if (previous.checksum === outcome.result.checksum) {
        lines.push('  warning: the backup has the same checksum as the new file');
      }
    } else if (scope !== null) {
      const final = await caseFile(ctx.ports, caseId, finalRelativeName(caseId));
      if (final.exists) {
        lines.push(`  final video untouched: ${final.absolute} checksum ${fileChecksum(final.absolute)}`);
      }
    }

    return {
      data: {
        case: caseId,
        blocks: scope,
        path: outcome.absolute,
        checksum: outcome.result.checksum,
        bytes: outcome.result.bytes,
        seconds: outcome.seconds,
        segments: outcome.segments,
        previous: previous?.path ?? null,
      },
      text: lines,
    };
  },
};
