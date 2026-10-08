/**
 * posts — community posts for a case through the text port. Owner: task 5.2.
 *
 * The artifact follows the filename the existing cases already use:
 * `cases/<case>/publicacao/posts/posts.json`. Dry run by default; `--execute`
 * spends and writes one metered ledger event.
 */

import type { Command, CommandContext } from '../command.ts';
import { flagSet, requirePositional } from '../lib/args.ts';
import { DarkpipeError, isoNow } from '../lib/util.ts';
import { metered } from '../spend.ts';
import {
  NARRATION_SCRIPT,
  POSTS_FILE,
  modelDocument,
  parseModelJson,
  postsInstruction,
} from '../domain/generate.ts';

export async function runPosts(
  ctx: CommandContext,
): Promise<{ data: Record<string, unknown>; text: string[] }> {
  const caseId = requirePositional(ctx.args, 0, 'case_id');
  if (!(await ctx.ports.files.exists(caseId))) {
    throw new DarkpipeError(`case ${caseId} is not on disk`, {
      hint: 'run `darkpipe case list` to see the registered cases',
    });
  }
  const meta = await ctx.ports.files.readMeta(caseId);
  const title = typeof meta?.title_en === 'string' && meta.title_en.length > 0 ? meta.title_en : caseId;
  const script =
    (await ctx.ports.files.readText(caseId, NARRATION_SCRIPT)) ??
    (await ctx.ports.files.readText(caseId, '01_script.md')) ??
    '';
  const prompt = postsInstruction(caseId, title, script);
  const model = typeof ctx.config.text.model === 'string' ? ctx.config.text.model : undefined;
  const outRelative = POSTS_FILE;
  const outPath = ctx.ports.files.resolve(caseId, outRelative);

  if (!flagSet(ctx.args, '--execute')) {
    return {
      data: { ok: true, dry_run: true, case_id: caseId, out: outPath, chars: prompt.length },
      text: [`posts ${caseId}: ${script.length} chars of narration`, `out: ${outPath}`, 'dry run — pass --execute to write'],
    };
  }

  const result = await metered(ctx.ports.ledger, { caseId, shot: null, kind: 'posts' }, () =>
    ctx.ports.text.complete({ caseId, purpose: 'posts', prompt, json: true, model }),
  );
  const parsed = parseModelJson(result.text);
  const document = modelDocument(parsed ?? { text: result.text }, {
    case_id: caseId,
    generated_at: isoNow(),
    purpose: 'posts',
    provider: result.provider,
    model: result.model,
    usd: result.usd,
  });
  const written = await ctx.ports.files.writeJson(caseId, outRelative, document);

  return {
    data: { ok: true, case_id: caseId, path: written, usd: result.usd, model: result.model },
    text: [`posts ${caseId} written to ${written}`, `cost: US$ ${result.usd.toFixed(4)}`],
  };
}

export const postsCommand: Command = {
  name: 'posts',
  summary: 'write the community posts for a case',
  usage: ['darkpipe posts <case_id> [--execute]'],
  run: runPosts,
};
