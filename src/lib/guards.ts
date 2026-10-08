/**
 * guards.ts — pre-flight checks shared by commands: the adapter must exist, its
 * credential must be present, and a spend/upload command must be told `--execute`.
 * Errors name the port and the missing item, in English, without printing secrets.
 */

import type { PortName } from '../ports.ts';
import type { CommandContext } from '../command.ts';
import { SECRET_ENV } from '../config.ts';
import { DarkpipeError } from './util.ts';
import { flagSet } from './args.ts';
import type { DarkpipeConfig } from '../config.ts';

/** Fail unless every environment variable this port needs is set. */
export function requireCredentials(port: PortName, environment: NodeJS.ProcessEnv = process.env): void {
  const required = SECRET_ENV[port] ?? [];
  const missing = required.filter((name) => {
    const value = environment[name];
    return value === undefined || value.trim().length === 0;
  });
  if (missing.length > 0) {
    throw new DarkpipeError(
      `port ${port}: missing credential ${missing.join(', ')}`,
      {
        port,
        hint: `set ${missing.join(', ')} in the environment (secrets never go in darkpipe.config.json)`,
      },
    );
  }
}

export function requireAdapterCredentials(ctx: CommandContext, port: PortName): void {
  requireCredentials(port, process.env);
}

/** True when the operator asked for the real thing. */
export function isExecute(ctx: CommandContext): boolean {
  return flagSet(ctx.args, '--execute');
}

/** Fail unless `--execute` is present. Dry run is the default for spend/upload. */
export function requireExecute(ctx: CommandContext, what: string): void {
  if (!isExecute(ctx)) {
    throw new DarkpipeError(`${what} is a dry run: pass --execute to spend or upload`, {
      hint: 're-run with --execute when you mean it',
    });
  }
}

export function isDryRunOnly(ctx: CommandContext): boolean {
  return !flagSet(ctx.args, '--execute');
}

/** Config problems make `doctor` fail; other commands get a warning line. */
export function reportConfigProblems(ctx: CommandContext): void {
  for (const problem of ctx.configProblems) {
    ctx.sink.warn(`darkpipe.config.json: ${problem.key} — ${problem.reason}`);
  }
}

export function adapterName(config: DarkpipeConfig, port: PortName): string {
  return String(config[port].adapter);
}
