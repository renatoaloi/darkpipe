/**
 * voice — synthesize a short sample without writing the case narration.
 * Owner: task 5.2.
 *
 * `darkpipe voice test "<text>"` writes the sample to `--out` (default
 * `.darkpipe/voice_test.mp3`) and never touches a case's `02_narration_parts/`.
 * Dry run by default; `--execute` spends.
 */

import path from 'node:path';
import type { Command, CommandContext } from '../command.ts';
import { flagValue, flagSet, requirePositional } from '../lib/args.ts';
import { DarkpipeError } from '../lib/util.ts';
import { metered } from '../spend.ts';
import { darkpipeStateDir } from '../lib/paths.ts';

const DEFAULT_SAMPLE = 'voice_test.mp3';

async function test(ctx: CommandContext): Promise<{ data: Record<string, unknown>; text: string[] }> {
  const text = requirePositional(ctx.args, 0, 'text');
  const requested = flagValue(ctx.args, '--out');
  const outPath =
    requested !== undefined && requested.length > 0
      ? path.resolve(ctx.repoRoot, requested)
      : path.join(darkpipeStateDir(ctx.repoRoot), DEFAULT_SAMPLE);

  const voice = typeof ctx.config.speech.voice === 'string' ? ctx.config.speech.voice : undefined;
  const model = typeof ctx.config.speech.model === 'string' ? ctx.config.speech.model : undefined;

  if (!flagSet(ctx.args, '--execute')) {
    return {
      data: {
        ok: true,
        dry_run: true,
        out: outPath,
        chars: text.length,
        voice: voice ?? null,
        model: model ?? null,
      },
      text: [
        `voice test: ${text.length} characters`,
        `out: ${outPath}`,
        'dry run — pass --execute to synthesize the sample',
      ],
    };
  }

  const result = await metered(ctx.ports.ledger, { caseId: null, shot: null, kind: 'voice-test' }, () =>
    ctx.ports.speech.synthesize({
      caseId: 'voice-test',
      block: null,
      text,
      outPath,
      voice,
      model,
    }),
  );

  return {
    data: {
      ok: true,
      out: result.path !== null ? path.resolve(result.path) : outPath,
      chars: text.length,
      usd: result.usd,
      provider: result.provider,
      model: result.model,
    },
    text: [`voice test written to ${result.path ?? outPath}`, `cost: US$ ${result.usd.toFixed(4)}`],
  };
}

export const voiceCommand: Command = {
  name: 'voice',
  summary: 'test a narration voice without writing the case narration',
  usage: ['darkpipe voice test "<text>" [--execute] [--out <file>]'],
  sub: {
    test: {
      name: 'test',
      summary: 'synthesize a short sample to --out (default .darkpipe/)',
      run: test,
    },
  },
  run: async (ctx): Promise<never> => {
    throw new DarkpipeError('voice needs the `test` subcommand', {
      hint: 'run `darkpipe voice test "<text>"`',
    });
  },
};
