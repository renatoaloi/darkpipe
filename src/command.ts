/**
 * command.ts — the shape every command module exposes, plus the context the CLI
 * hands it. Commands receive ports; they never build adapters.
 */

import type { Ports, PortName } from './ports.ts';
import type { DarkpipeConfig } from './config.ts';
import type { CommandResult, OutputSink } from './lib/util.ts';
import type { ParsedArgs } from './lib/args.ts';
import type { JobsApi } from './jobs.ts';

export interface CommandContext {
  args: ParsedArgs;
  config: DarkpipeConfig;
  configPath: string | null;
  /** Problems found in the config file, e.g. an inline secret. */
  configProblems: { key: string; reason: string }[];
  repoRoot: string;
  ports: Ports;
  /** Adapter names the registry knows, per port. Doctor reports these. */
  adaptersKnown: Record<PortName, string[]>;
  sink: OutputSink;
  jobs: JobsApi;
  /** Absolute path of the running CLI entry point, for `darkpipe jobs`. */
  cliPath: string;
}

export interface Command {
  name: string;
  summary: string;
  /** One line per form, printed by `--help`. */
  usage?: string[];
  /** Nested verbs, e.g. `timeline boundary`. */
  sub?: Record<string, Command>;
  /** True when the command forks a long run and reports a job id. */
  longRunning?: boolean;
  run(context: CommandContext): Promise<CommandResult>;
}
