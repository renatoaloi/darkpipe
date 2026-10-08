/**
 * config — read and write `darkpipe.config.json`. Adapter names and non-secret
 * settings only; `set` refuses a credential-shaped value.
 */

import path from 'node:path';
import type { Command } from '../command.ts';
import { DEFAULT_CONFIG, readConfigValue, writeConfigValue } from '../config.ts';
import { DarkpipeError, fail } from '../lib/util.ts';
import { requirePositional } from '../lib/args.ts';

const SECRET_VALUE = /^(sk-[A-Za-z0-9_\-]{8,}|[A-Za-z0-9_\-]{32,})$/;
const SECRET_KEY = /(api[_-]?key|secret|token|password|credential)/i;

export const configCommand: Command = {
  name: 'config',
  summary: 'read or write the adapter config file (never secrets)',
  usage: ['darkpipe config get <key>', 'darkpipe config set <key> <value>'],
  sub: {
    get: {
      name: 'get',
      summary: 'print one config value',
      async run(ctx) {
        const key = requirePositional(ctx.args, 0, 'config key');
        const value = readConfigValue(ctx.config, key);
        if (value === undefined) {
          fail(`config key "${key}" is not set`, { hint: 'try `darkpipe config get media`' });
        }
        const shown = typeof value === 'object' ? JSON.stringify(value) : String(value);
        return { data: { key, value }, text: [`${key} = ${shown}`] };
      },
    },
    set: {
      name: 'set',
      summary: 'write one config value',
      async run(ctx) {
        const key = requirePositional(ctx.args, 0, 'config key');
        const value = requirePositional(ctx.args, 1, 'config value');
        if (SECRET_KEY.test(key) || SECRET_VALUE.test(value)) {
          throw new DarkpipeError(
            `refusing to write "${key}": secrets belong in the environment, not in darkpipe.config.json`,
            { hint: 'export the variable instead, e.g. RUNWARE_API_KEY' },
          );
        }
        const target = ctx.configPath ?? path.join(ctx.repoRoot, 'darkpipe.config.json');
        writeConfigValue(target, key, value);
        return { data: { path: target, key, value }, text: [`${target}: ${key} = ${value}`] };
      },
    },
    defaults: {
      name: 'defaults',
      summary: 'print the built-in config',
      async run() {
        return {
          data: { defaults: DEFAULT_CONFIG },
          text: [JSON.stringify(DEFAULT_CONFIG, null, 2)],
        };
      },
    },
  },
  async run(ctx) {
    const rows = Object.entries(ctx.config)
      .map(([key, value]) => `${key} = ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
      .sort();
    return {
      data: { path: ctx.configPath, config: ctx.config, problems: ctx.configProblems },
      text: [`config file: ${ctx.configPath ?? '(built-in defaults)'}`, ...rows],
    };
  },
};
