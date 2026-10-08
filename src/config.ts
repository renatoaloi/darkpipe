/**
 * config.ts — `darkpipe.config.json` at the repo root: adapter names and
 * non-secret settings only. Secrets are environment only. `darkpipe doctor`
 * fails when the file carries anything that looks like a key.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { PortName } from './ports.ts';
import { DarkpipeError, fail } from './lib/util.ts';
import { findRepoRoot } from './lib/paths.ts';

export interface AdapterSetting {
  adapter: string;
  [key: string]: unknown;
}

export interface DarkpipeConfig {
  casesDir: string;
  store: AdapterSetting;
  files: AdapterSetting;
  media: AdapterSetting;
  speech: AdapterSetting;
  text: AdapterSetting;
  render: AdapterSetting;
  ledger: AdapterSetting;
  publisher: AdapterSetting;
}

export const DEFAULT_CONFIG: DarkpipeConfig = {
  casesDir: 'cases',
  store: { adapter: 'sqlite', file: 'darkpipe.sqlite', legacy: 'kanban.sqlite' },
  files: { adapter: 'casefs', casesDir: 'cases' },
  media: {
    adapter: 'runware',
    modelStill: 'bytedance:seedream@4.5',
    modelVideo: 'bytedance:2@2',
    width: 1280,
    height: 720,
    seconds: 6,
  },
  speech: { adapter: 'runware', model: 'minimax:speech@2.8', voice: 'English_ManWithDeepVoice' },
  text: { adapter: 'runware', model: 'minimax-m3' },
  render: { adapter: 'ffmpeg', ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
  ledger: { adapter: 'jsonl', file: 'costs/events.jsonl' },
  publisher: { adapter: 'youtube', channel: '' },
};

export const PORT_NAMES: PortName[] = [
  'store',
  'files',
  'media',
  'speech',
  'text',
  'render',
  'ledger',
  'publisher',
];

/** Environment variables that hold secrets. `doctor` reports presence, never values. */
export const SECRET_ENV: Record<string, string[]> = {
  store: [],
  files: [],
  media: ['RUNWARE_API_KEY'],
  speech: ['RUNWARE_API_KEY'],
  text: ['RUNWARE_API_KEY'],
  render: [],
  ledger: [],
  publisher: ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_REFRESH_TOKEN'],
};

const SECRET_KEY_PATTERN = /(api[_-]?key|secret|token|password|passwd|credential|bearer)/i;
const SECRET_VALUE_PATTERN = /^(sk-[A-Za-z0-9_\-]{8,}|[A-Za-z0-9_\-]{32,}|[A-Za-z0-9+/]{40,}={0,2})$/;

export interface ConfigProblem {
  /** Dotted path of the offending config key. */
  key: string;
  reason: string;
}

/**
 * Find anything in the config that must live in the environment instead.
 * Returns both key-shaped names and key-shaped values.
 */
export function findInlineSecrets(config: unknown, prefix = ''): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const walk = (value: unknown, trail: string) => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${trail}[${index}]`));
      return;
    }
    if (typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const next = trail.length === 0 ? key : `${trail}.${key}`;
        if (SECRET_KEY_PATTERN.test(key)) {
          problems.push({ key: next, reason: `key name "${key}" belongs in the environment` });
        }
        walk(child, next);
      }
      return;
    }
    if (typeof value === 'string' && SECRET_VALUE_PATTERN.test(value) && !isAdapterName(trail, value)) {
      problems.push({ key: trail, reason: 'value looks like a credential' });
    }
  };
  walk(config, prefix);
  return problems;
}

/** Adapter names are short and known; they are never mistaken for a credential. */
function isAdapterName(trail: string, value: string): boolean {
  return trail.endsWith('.adapter') && /^[a-z][a-z0-9_-]*$/.test(value);
}

export interface LoadedConfig {
  config: DarkpipeConfig;
  path: string | null;
  problems: ConfigProblem[];
}

export function configPath(explicit?: string): string | null {
  if (explicit !== undefined && explicit.length > 0) return path.resolve(explicit);
  if (process.env.DARKPIPE_CONFIG) return path.resolve(process.env.DARKPIPE_CONFIG);
  const inCwd = path.join(process.cwd(), 'darkpipe.config.json');
  if (fs.existsSync(inCwd)) return inCwd;
  const atRoot = path.join(findRepoRoot(), 'darkpipe.config.json');
  if (atRoot !== inCwd && fs.existsSync(atRoot)) return atRoot;
  return null;
}

function mergeSection(base: AdapterSetting, override: unknown, port: PortName): AdapterSetting {
  if (override === undefined) return { ...base };
  if (typeof override === 'string') return { ...base, adapter: override };
  if (override === null || typeof override !== 'object' || Array.isArray(override)) {
    throw new DarkpipeError(`config section "${port}" must be an object or an adapter name`);
  }
  const section = { ...base, ...(override as Record<string, unknown>) } as AdapterSetting;
  if (typeof section.adapter !== 'string' || section.adapter.length === 0) {
    throw new DarkpipeError(`config section "${port}" has no adapter name`);
  }
  return section;
}

export function loadConfig(explicitPath?: string): LoadedConfig {
  const resolved = configPath(explicitPath);
  if (resolved === null) {
    return { config: structuredClone(DEFAULT_CONFIG), path: null, problems: [] };
  }
  if (!fs.existsSync(resolved)) {
    fail(`config file not found at ${resolved}`, { hint: 'remove --config or create the file' });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (error) {
    fail(`config file ${resolved} is not valid JSON: ${(error as Error).message}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`config file ${resolved} must contain a JSON object`);
  }
  const source = raw as Record<string, unknown>;
  const config: DarkpipeConfig = {
    casesDir: typeof source.casesDir === 'string' ? source.casesDir : DEFAULT_CONFIG.casesDir,
    store: mergeSection(DEFAULT_CONFIG.store, source.store, 'store'),
    files: mergeSection(DEFAULT_CONFIG.files, source.files, 'files'),
    media: mergeSection(DEFAULT_CONFIG.media, source.media, 'media'),
    speech: mergeSection(DEFAULT_CONFIG.speech, source.speech, 'speech'),
    text: mergeSection(DEFAULT_CONFIG.text, source.text, 'text'),
    render: mergeSection(DEFAULT_CONFIG.render, source.render, 'render'),
    ledger: mergeSection(DEFAULT_CONFIG.ledger, source.ledger, 'ledger'),
    publisher: mergeSection(DEFAULT_CONFIG.publisher, source.publisher, 'publisher'),
  };
  return { config, path: resolved, problems: findInlineSecrets(source) };
}

export function writeConfigValue(configPathName: string, key: string, value: string): void {
  let current: Record<string, unknown> = {};
  if (fs.existsSync(configPathName)) {
    try {
      current = JSON.parse(fs.readFileSync(configPathName, 'utf8')) as Record<string, unknown>;
    } catch (error) {
      fail(`config file ${configPathName} is not valid JSON: ${(error as Error).message}`);
    }
  }
  const parts = key.split('.');
  let cursor: Record<string, unknown> = current;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    const next = cursor[part];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
  fs.writeFileSync(configPathName, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
}

export function readConfigValue(config: DarkpipeConfig, key: string): unknown {
  const parts = key.split('.');
  let cursor: unknown = config;
  for (const part of parts) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
    if (cursor === undefined) return undefined;
  }
  return cursor;
}
