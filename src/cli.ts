#!/usr/bin/env node
/**
 * cli.ts — the composition root and the only entry point. It reads config,
 * builds adapters from the registry, and passes ports into a command.
 * Commands do not import adapters; this file does not contain pipeline rules.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseArgs, flagSet } from './lib/args.ts';
import { loadConfig, PORT_NAMES } from './config.ts';
import { buildPorts, allAdapterNames } from './adapters/registry.ts';
import { makeJobs, JOB_ID_ENV } from './jobs.ts';
import { findRepoRoot } from './lib/paths.ts';
import { DarkpipeError, isDarkpipeError, makeSink, type CommandResult } from './lib/util.ts';
import type { Command, CommandContext } from './command.ts';
import { COMMANDS, COMMAND_ORDER } from './commands/index.ts';
import { reportConfigProblems } from './lib/guards.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `src/cli.ts` in dev, `dist/cli.js` when installed. */
export const CLI_PATH = path.resolve(HERE, HERE.endsWith(`${path.sep}dist`) ? 'cli.js' : 'cli.ts');

function globalHelp(): string {
  const lines: string[] = [];
  lines.push('darkpipe — faceless dark-channel pipeline');
  lines.push('');
  lines.push('Usage: darkpipe <command> [subcommand] [options]');
  lines.push('');
  lines.push('Commands:');
  for (const name of COMMAND_ORDER) {
    const command = COMMANDS[name];
    if (command === undefined) continue;
    lines.push(`  ${name.padEnd(10)} ${command.summary}`);
  }
  lines.push('');
  lines.push('Global options:');
  lines.push('  --json            print one JSON document on stdout (progress stays on stderr)');
  lines.push('  --dry-run         the default for spend and upload commands');
  lines.push('  --execute         spend credit or upload; required to leave the dry run');
  lines.push('  --config <path>   use another config file (default: ./darkpipe.config.json)');
  lines.push('');
  lines.push('Docs: darkpipe/docs/commands.md');
  return lines.join('\n');
}

function commandHelp(command: Command, trail: string[]): string {
  const lines: string[] = [];
  lines.push(`${trail.join(' ')} — ${command.summary}`);
  lines.push('');
  for (const usage of command.usage ?? []) {
    lines.push(`  ${usage}`);
  }
  if (command.sub !== undefined) {
    lines.push('');
    lines.push('Subcommands:');
    for (const [name, sub] of Object.entries(command.sub)) {
      lines.push(`  ${name.padEnd(10)} ${sub.summary}`);
    }
  }
  return lines.join('\n');
}

function resolveCommand(trail: string[]): { command: Command | null; unknown: string | null; trail: string[] } {
  const [first, second] = trail;
  if (first === undefined) return { command: null, unknown: null, trail: [] };
  const root = COMMANDS[first];
  if (root === undefined) return { command: null, unknown: first, trail };
  if (second === undefined) return { command: root, unknown: null, trail: [first] };
  const sub = root.sub?.[second];
  if (sub === undefined) return { command: null, unknown: `${first} ${second}`, trail: [first, second] };
  return { command: sub, unknown: null, trail: [first, second] };
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const wantsHelp = flagSet(args, '--help');
  const { command, unknown, trail } = resolveCommand(args.command);

  if (unknown !== null) {
    process.stderr.write(`unknown command: ${unknown}\n`);
    process.stdout.write(`${globalHelp()}\n`);
    return 2;
  }

  if (command === null || (wantsHelp && trail.length === 0)) {
    process.stdout.write(`${globalHelp()}\n`);
    return 0;
  }

  if (wantsHelp) {
    process.stdout.write(`${commandHelp(command, trail)}\n`);
    return 0;
  }

  const sink = makeSink(flagSet(args, '--json'));
  const loaded = loadConfig(args.flags.get('--config') !== undefined ? String(args.flags.get('--config')) : undefined);

  let repoRoot: string | null = null;
  let code: number;
  try {
    repoRoot = findRepoRoot();
    const ports = buildPorts(repoRoot, loaded.config);
    const ctx: CommandContext = {
      args,
      config: loaded.config,
      configPath: loaded.path,
      configProblems: loaded.problems,
      repoRoot,
      ports,
      adaptersKnown: allAdapterNames(),
      sink,
      jobs: makeJobs(repoRoot, CLI_PATH),
      cliPath: CLI_PATH,
    };
    reportConfigProblems(ctx);
    const result = await command.run(ctx);
    await ports.store.close();
    emit(result, sink.json);
    code = 0;
  } catch (error) {
    const failure = normalizeError(error);
    emitFailure(failure, sink.json);
    code = failure.exitCode;
  }

  // A long run forks itself; only the child knows how it ended, so it closes its
  // own job record. The parent can see nothing but a dead pid.
  const jobId = process.env[JOB_ID_ENV];
  if (jobId !== undefined && jobId.length > 0 && repoRoot !== null) {
    try {
      await makeJobs(repoRoot, CLI_PATH).finish(jobId, code === 0 ? 'done' : 'failed', code);
    } catch {
      // The record is best-effort: the run itself already happened.
    }
  }
  return code;
}

function normalizeError(error: unknown): DarkpipeError {
  if (isDarkpipeError(error)) return error;
  if (error instanceof Error) {
    return new DarkpipeError(error.message, { hint: error.stack?.split('\n')[1]?.trim() });
  }
  return new DarkpipeError(String(error));
}

function emit(result: CommandResult, json: boolean): void {
  if (json) {
    const document = result.rawJson !== undefined ? result.rawJson : { ok: true, ...result.data };
    process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
    return;
  }
  for (const line of result.text) {
    process.stdout.write(`${line}\n`);
  }
  const path = result.data.path;
  if (typeof path === 'string' && !result.text.some((line) => line.includes(path))) {
    process.stdout.write(`${path}\n`);
  }
}

function emitFailure(error: DarkpipeError, json: boolean): void {
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: error.message, ...(error.hint ? { hint: error.hint } : {}) }, null, 2)}\n`,
    );
    return;
  }
  process.stdout.write(`error: ${error.message}\n`);
  if (error.hint) process.stdout.write(`hint: ${error.hint}\n`);
}

/** Used by tests: run the CLI in-process with a fake argv. */
export async function runCli(argv: string[]): Promise<number> {
  return main(argv);
}

export function knownPorts(): string[] {
  return PORT_NAMES;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
