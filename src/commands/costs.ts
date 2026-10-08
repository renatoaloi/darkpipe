/**
 * costs — the spend ledger, as events only. Owner: task group 7.
 *
 * `--json` prints a BARE array of ledger events (no `{ok,...}` envelope) so a
 * third-party frontend can consolidate them. There is no total, no per-case sum
 * and no per-kind sum here, ever. `--case` and `--kind` only DROP events.
 */

import type { Command } from '../command.ts';
import type { CostEvent } from '../ports.ts';
import { flagValue } from '../lib/args.ts';

function field(event: CostEvent, name: string, legacy: string): unknown {
  return event[name] ?? event[legacy];
}

function line(event: CostEvent): string {
  const shotValue = field(event, 'shot', 'shot');
  const shot = shotValue === null || shotValue === undefined ? '-' : String(shotValue);
  const usdValue = field(event, 'usd', 'custo_usd');
  const usd = typeof usdValue === 'number' ? usdValue.toFixed(4) : String(usdValue ?? '');
  const at = String(field(event, 'at', 'quando') ?? '');
  const kind = String(field(event, 'kind', 'tipo') ?? '');
  const model = String(field(event, 'model', 'modelo') ?? '');
  const provider = event.provider ?? '';
  const status = event.status ?? '';
  const who = provider.length > 0 ? `${provider}/${model}` : model;
  return `${at}  ${event.case ?? '-'}  shot ${shot}  ${kind}  ${who}  $${usd}  ${status}`.trimEnd();
}

export const costsCommand: Command = {
  name: 'costs',
  summary: 'print the spend ledger events (no totals)',
  usage: ['darkpipe costs [--json] [--case <case_id>] [--kind <kind>]'],
  run: async (ctx) => {
    const events = await ctx.ports.ledger.read();
    const caseFilter = flagValue(ctx.args, '--case');
    const kindFilter = flagValue(ctx.args, '--kind');
    // Filters only drop events; they never add an aggregate.
    const filtered = events.filter((event) => {
      if (caseFilter !== undefined && event.case !== caseFilter) return false;
      if (kindFilter !== undefined && field(event, 'kind', 'tipo') !== kindFilter) return false;
      return true;
    });

    return {
      data: { events: filtered, count: filtered.length },
      text: filtered.length === 0 ? ['no cost events'] : filtered.map(line),
      rawJson: filtered,
    };
  },
};
