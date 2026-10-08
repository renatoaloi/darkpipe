/**
 * style — the case style card (`05_estilo.json`) and its registry. The card is
 * read and written through the files port; `--set` changes the combination.
 */

import type { Command } from '../command.ts';
import { DarkpipeError } from '../lib/util.ts';
import { flagValue, requirePositional } from '../lib/args.ts';
import type { CaseStyle } from '../domain/case.ts';

const CARD = '05_estilo.json';

function emptyCard(caseId: string): CaseStyle {
  return {
    case: caseId,
    combinacao: '',
    prefixo: '',
    sufixo: '',
    extra: '',
    variantes: [],
    passo: 1,
    extra_manual: '',
    origem: 'manual',
  };
}

export const styleCommand: Command = {
  name: 'style',
  summary: 'show or set the case style card',
  usage: ['darkpipe style <case_id> [--set <combination>]'],
  async run(ctx) {
    const caseId = requirePositional(ctx.args, 0, 'case id');
    const files = ctx.ports.files;
    if (!(await files.exists(caseId))) {
      throw new DarkpipeError(`case ${caseId} has no folder`, { hint: 'run `darkpipe case list` to see the registered cases' });
    }
    const set = flagValue(ctx.args, '--set');
    const existing = await files.readJson<CaseStyle>(caseId, CARD);

    if (set !== undefined) {
      const card = existing ?? emptyCard(caseId);
      card.case = caseId;
      card.combinacao = set;
      const written = await files.writeJson(caseId, CARD, card);
      return {
        data: { case: caseId, estilo: card, path: written },
        text: [`style ${caseId}: combinacao = ${set}`, `  written ${written}`],
      };
    }

    if (existing === null) {
      throw new DarkpipeError(`case ${caseId} has no ${CARD}`, {
        hint: 'run `darkpipe case new` (with research) to write the style card',
      });
    }
    const cardPath = files.resolve(caseId, CARD);
    return {
      data: { case: caseId, estilo: existing, path: cardPath },
      text: [
        `style ${caseId}: ${existing.combinacao || '(no combination)'}`,
        `  prefix ${existing.prefixo || '—'}`,
        `  suffix ${existing.sufixo || '—'}`,
        `  extra  ${existing.extra || '—'}`,
        `  variants ${Array.isArray(existing.variantes) ? existing.variantes.length : 0}`,
      ],
    };
  },
};
