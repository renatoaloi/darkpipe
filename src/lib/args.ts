/**
 * args.ts — the command line reader. Flags are English, the shape follows the
 * Hermes CLI: `--json`, `--dry-run`, `--execute`, `--config`.
 */

import { fail } from './util.ts';

/** Flags that never take a value. Anything else swallows the next token. */
export const BOOLEAN_FLAGS = new Set([
  '--json',
  '--dry-run',
  '--execute',
  '--no-research',
  '--no-check',
  '--no-backup',
  '--force',
  '--help',
  '-h',
  '--yes',
  '--all',
  '--check',
  '--foreground',
  '--no-fork',
]);

/**
 * Command roots whose first word is a group and whose second word is a verb
 * (`darkpipe case new`, `darkpipe plan propose`). Only these absorb a second
 * command word; every other command treats its first plain token as an argument
 * (`darkpipe compete "sodder children"`), so a free-text subject is never
 * mistaken for a subcommand.
 */
export const VERB_COMMAND_ROOTS = new Set([
  'case',
  'config',
  'jobs',
  'plan',
  'prompts',
  'still',
  'timeline',
  'voice',
]);


export interface ParsedArgs {
  command: string[];
  flags: Map<string, string | boolean>;
  positionals: string[];
  raw: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];
  const command: string[] = [];

  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith('--') || (token.startsWith('-') && token.length === 2)) {
      const eq = token.indexOf('=');
      if (eq > 0) {
        flags.set(token.slice(0, eq), token.slice(eq + 1));
        i += 1;
        continue;
      }
      if (BOOLEAN_FLAGS.has(token)) {
        // A repeated boolean keeps its true value; `--flag=false` is the way out.
        flags.set(token, true);
        i += 1;
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags.set(token, true);
        i += 1;
        continue;
      }
      flags.set(token, next);
      i += 2;
      continue;
    }
    // The first plain token(s) are the command path; the rest are arguments.
    // Only a verb group absorbs a second word (`case new`, `plan propose`); a
    // free-text argument such as `compete "sodder children"` stays a positional.
    const takesVerb = command.length === 0 || (command.length === 1 && VERB_COMMAND_ROOTS.has(command[0]));
    if (positionals.length === 0 && command.length < 2 && takesVerb && !looksLikeCaseId(token)) {
      command.push(token);
    } else {
      positionals.push(token);
    }
    i += 1;
  }

  return { command, flags, positionals, raw: argv };
}

function looksLikeCaseId(token: string): boolean {
  return /^case_\d+/.test(token);
}

export function flagValue(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  if (value === undefined || value === true) return undefined;
  return String(value);
}

export function flagSet(args: ParsedArgs, name: string): boolean {
  const value = args.flags.get(name);
  return value !== undefined && value !== false;
}

/** Number flag with the English error the specs ask for. */
export function flagNumber(args: ParsedArgs, name: string): number | undefined {
  const raw = flagValue(args, name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    fail(`${name} expects a number, got "${raw}"`);
  }
  return parsed;
}

export function requirePositional(args: ParsedArgs, index: number, what: string): string {
  const value = args.positionals[index];
  if (value === undefined || value.length === 0) {
    fail(`missing ${what}`, { hint: 'run `darkpipe --help` for the command shape' });
  }
  return value;
}

/** `--blocks 2`, `--blocks 2,3`, `--blocks 2-4`. */
export function parseBlocks(raw: string | undefined): number[] | null {
  if (raw === undefined || raw === '') return null;
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    const piece = part.trim();
    if (piece.length === 0) continue;
    const range = /^(\d+)-(\d+)$/.exec(piece);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (to < from) fail(`--blocks range "${piece}" is backwards`);
      for (let n = from; n <= to; n += 1) out.add(n);
      continue;
    }
    const single = Number(piece);
    if (!Number.isInteger(single)) fail(`--blocks expects block numbers, got "${piece}"`);
    out.add(single);
  }
  if (out.size === 0) fail('--blocks got no block number');
  return [...out].sort((a, b) => a - b);
}
