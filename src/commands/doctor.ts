/**
 * doctor — what is wired, what is missing. Never prints a secret value.
 *
 * VERIFY (task 2.2): `--json` lists each adapter name, reports RUNWARE_API_KEY as
 * present or missing without printing it, and exits non-zero when the config file
 * contains a secret-shaped value.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Command } from '../command.ts';
import { PORT_NAMES, SECRET_ENV } from '../config.ts';
import { DarkpipeError } from '../lib/util.ts';
import { adapterName } from '../lib/guards.ts';
import type { PortName } from '../ports.ts';

export const doctorCommand: Command = {
  name: 'doctor',
  summary: 'report adapters, credentials and binaries without printing secrets',
  usage: ['darkpipe doctor', 'darkpipe doctor --json'],
  async run(ctx) {
    const adapters: Record<string, string> = {};
    for (const port of PORT_NAMES) {
      adapters[port] = adapterName(ctx.config, port as PortName);
    }
    const known = ctx.adaptersKnown;

    // Credentials: names and presence only. Values never leave this function.
    const credentials: Record<string, 'present' | 'missing'> = {};
    for (const port of PORT_NAMES) {
      for (const name of SECRET_ENV[port] ?? []) {
        const value = process.env[name];
        credentials[name] = value !== undefined && value.trim().length > 0 ? 'present' : 'missing';
      }
    }

    const binaries: Record<string, 'present' | 'missing'> = {
      ffmpeg: which(String(ctx.config.render.ffmpeg ?? 'ffmpeg')),
      ffprobe: which(String(ctx.config.render.ffprobe ?? 'ffprobe')),
      node: 'present',
    };

    const storeLocation = ctx.ports.store.location;
    const store = {
      adapter: adapters.store,
      file: storeLocation,
      exists: storeLocation !== null && fs.existsSync(storeLocation),
      cases: 0,
    };
    try {
      store.cases = (await ctx.ports.store.listCases()).length;
    } catch {
      store.cases = 0;
    }

    const secrets = ctx.configProblems.map((problem) => problem.key);
    const issues: string[] = [];
    if (secrets.length > 0) {
      issues.push('darkpipe.config.json contains a credential-shaped value');
    }
    if (binaries.ffmpeg === 'missing') {
      issues.push(`render binary "ffmpeg" is not on PATH (adapter: ${adapters.render})`);
    }
    for (const [port, name] of Object.entries(adapters)) {
      const list = known[port as PortName] ?? [];
      if (!list.includes(name)) {
        issues.push(`unknown ${port} adapter "${name}" (known: ${list.join(', ')})`);
      }
    }

    const data = {
      adapters,
      unknownAdapter: null,
      credentials,
      binaries,
      store,
      config: { path: ctx.configPath, problems: ctx.configProblems },
      issues,
    };

    const text: string[] = [];
    text.push('darkpipe doctor');
    text.push('');
    text.push('Adapters');
    for (const port of PORT_NAMES) {
      const name = adapters[port];
      const mark = (known[port as PortName] ?? []).includes(name) ? 'ok' : 'UNKNOWN';
      text.push(`  ${port.padEnd(10)} ${name.padEnd(12)} ${mark}`);
    }
    text.push('');
    text.push('Credentials (names only — values are never printed)');
    for (const [name, state] of Object.entries(credentials)) {
      text.push(`  ${name.padEnd(24)} ${state}`);
    }
    text.push('');
    text.push('Binaries');
    for (const [name, state] of Object.entries(binaries)) {
      text.push(`  ${name.padEnd(24)} ${state}`);
    }
    text.push('');
    text.push('Store');
    text.push(`  file                     ${store.file ?? '(none)'}`);
    text.push(`  cases                    ${store.cases}`);

    if (issues.length > 0) {
      throw new DarkpipeError(`doctor found ${issues.length} problem(s): ${issues.join('; ')}`, {
        hint: secrets[0] ? `move ${secrets[0]} out of the config file into the environment` : undefined,
      });
    }

    return { data, text };
  },
};

function which(binary: string): 'present' | 'missing' {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter((entry) => entry.length > 0);
  // Windows resolves `ffmpeg` to `ffmpeg.exe` via PATHEXT. A bare name plus the
  // Unix execute bit misses that file, which is why doctor said ffmpeg was
  // absent in a shell where `ffmpeg` already ran.
  const suffixes = process.platform === 'win32'
    ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter((ext) => ext.length > 0)]
    : [''];
  const mode = process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK;
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const name = suffix.length > 0 && binary.toLowerCase().endsWith(suffix.toLowerCase())
        ? binary
        : `${binary}${suffix}`;
      try {
        fs.accessSync(path.join(dir, name), mode);
        return 'present';
      } catch {
        // keep looking
      }
    }
  }
  return 'missing';
}
