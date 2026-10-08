/**
 * publish — build the YouTube pack (dry run by default) and upload with
 * `--execute`. Owner: task group 7.
 *
 * `--execute` calls `requireCredentials('publisher')` BEFORE any work. A channel
 * rule failure blocks the upload. A successful upload stores the video id in the
 * pack and does NOT mark the case published — the operator sets that with
 * `darkpipe case status`.
 */

import type { Command } from '../command.ts';
import { DarkpipeError } from '../lib/util.ts';
import { requirePositional } from '../lib/args.ts';
import { isExecute, requireCredentials } from '../lib/guards.ts';
import { buildPack, writePack, LIM_TAGS } from '../domain/publish.ts';

export const publishCommand: Command = {
  name: 'publish',
  summary: 'build the YouTube pack (dry run) and upload with --execute',
  usage: ['darkpipe publish <case_id> [--execute]'],
  longRunning: true,
  run: async (ctx) => {
    const caseId = requirePositional(ctx.args, 0, 'case id');
    const execute = isExecute(ctx);

    // Credentials first: `--execute` never does work without them.
    if (execute) requireCredentials('publisher');

    const build = await buildPack(ctx.ports, caseId);
    for (const warning of build.warnings) ctx.sink.warn(`${caseId}: ${warning}`);

    if (execute && build.blocking.length > 0) {
      throw new DarkpipeError(
        [`publish refused: ${build.blocking.length} channel-rule problem(s) in ${caseId}`, ...build.blocking.map((line) => `  - ${line}`)].join('\n'),
        { hint: 'fix the pack, then run `darkpipe publish <case_id> --execute` again — nothing was uploaded' },
      );
    }

    let videoId: string | null = null;
    if (execute) {
      const credentials = ctx.ports.publisher.credentials();
      if (!credentials.ok) {
        throw new DarkpipeError(`port publisher: missing credential ${credentials.missing.join(', ')}`, {
          port: 'publisher',
          hint: `set ${credentials.missing.join(', ')} in the environment — nothing was uploaded`,
        });
      }
      const result = await ctx.ports.publisher.upload(build.pack);
      build.pack.videoId = result.videoId;
      videoId = result.videoId;
    }

    const packPath = await writePack(ctx.ports, caseId, build.pack);
    const pack = build.pack;
    const tagChars = pack.tags.reduce((sum, tag) => sum + tag.length, 0) + Math.max(0, pack.tags.length - 1);
    const lines: string[] = [];
    lines.push(`${execute ? 'published pack' : 'dry run'} for ${caseId}`);
    lines.push(`  title       ${pack.title.length} chars  ${pack.title}`);
    lines.push(`  description ${pack.description.length} chars`);
    lines.push(`  tags        ${pack.tags.length} tags · ${tagChars}/${LIM_TAGS} chars`);
    if (build.tagsDropped.length > 0) lines.push(`  tags dropped over the limit: ${build.tagsDropped.join(', ')}`);
    lines.push(`  chapters    ${pack.chapters.length === 0 ? 'omitted' : `${pack.chapters.length} (first at 00:00)`}`);
    lines.push(`  language    ${pack.language}`);
    lines.push(`  video       ${pack.videoPath ?? '(missing)'}`);
    lines.push(`  thumbnail   ${pack.thumbPath ?? '(missing)'}`);
    for (const warning of build.warnings) lines.push(`  warning: ${warning}`);
    if (execute) {
      lines.push(`  video id    ${videoId}`);
      lines.push('the case status is unchanged — set it yourself with `darkpipe case status`');
    } else {
      lines.push('this was a dry run: no upload was made (pass --execute to upload)');
    }
    lines.push(`  pack        ${packPath}`);

    return {
      data: {
        case: caseId,
        dryRun: !execute,
        path: packPath,
        videoId,
        pack,
        blocking: build.blocking,
      },
      text: lines,
    };
  },
};
