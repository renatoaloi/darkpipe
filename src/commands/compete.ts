/**
 * compete — measure the competition for a candidate subject before a case is
 * opened. Terminal-only: it asks the text port and prints the measurement. It
 * writes no case file; the cost event goes to the ledger through `metered()`.
 */

import type { Command } from '../command.ts';
import { requirePositional } from '../lib/args.ts';
import { metered } from '../spend.ts';

function buildCompetePrompt(subject: string): string {
  return [
    'Measure the English-language YouTube competition for this subject before a documentary is made:',
    `"${subject}".`,
    'Answer with ONE JSON object: "results" (how many videos really cover the subject),',
    '"estimated" (the raw estimate when available), "views_sum", "views_median", "views_max",',
    '"leaders" (the channels that dominate, with views) and "note" (one line on whether the niche is crowded).',
    'Use only public search figures. Never invent numbers: use null when you do not know.',
  ].join('\n');
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  const candidate = trimmed.startsWith('{') ? trimmed : trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

export const competeCommand: Command = {
  name: 'compete',
  summary: 'measure the competition for a candidate case',
  usage: ['darkpipe compete "<subject>" [--json]'],
  async run(ctx) {
    const subject = requirePositional(ctx.args, 0, 'subject');
    const result = await metered(ctx.ports.ledger, { caseId: null, shot: null, kind: 'compete' }, () =>
      ctx.ports.text.complete({ caseId: subject, purpose: 'compete', json: true, prompt: buildCompetePrompt(subject) }),
    );
    const measurement = tryParseJson(result.text);
    const data = {
      subject,
      measurement: measurement ?? result.text,
      provider: result.provider,
      model: result.model,
      usd: result.usd,
    };
    const text = [
      `competition for "${subject}"`,
      measurement === null ? result.text : JSON.stringify(measurement, null, 2),
    ];
    return { data, text };
  },
};
