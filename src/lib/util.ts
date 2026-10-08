/**
 * util.ts — errors, output, small filesystem helpers. No domain rules here.
 */

/** An operator-legible failure. `exitCode` is what the CLI returns. */
export class DarkpipeError extends Error {
  readonly exitCode: number;
  readonly hint: string | null;
  /** Port that failed, when the failure is an adapter/credential problem. */
  readonly port: string | null;

  constructor(message: string, opts: { exitCode?: number; hint?: string; port?: string } = {}) {
    super(message);
    this.name = 'DarkpipeError';
    this.exitCode = opts.exitCode ?? 1;
    this.hint = opts.hint ?? null;
    this.port = opts.port ?? null;
  }
}

export function fail(message: string, opts: { exitCode?: number; hint?: string; port?: string } = {}): never {
  throw new DarkpipeError(message, opts);
}

export function isDarkpipeError(value: unknown): value is DarkpipeError {
  return value instanceof DarkpipeError;
}

/** Everything a command reports back to the CLI. */
export interface CommandResult {
  /** Machine document printed under --json. */
  data: Record<string, unknown>;
  /** Human lines printed when --json is not passed. */
  text: string[];
  /**
   * Printed verbatim under --json instead of the `{ok, ...data}` envelope.
   * `darkpipe costs --json` uses it: the contract there is a bare event array.
   */
  rawJson?: unknown;
}

export interface OutputSink {
  readonly json: boolean;
  /** Progress/diagnostics. Always stderr. */
  log(line: string): void;
  warn(line: string): void;
}

export function makeSink(json: boolean): OutputSink {
  return {
    json,
    log(line: string) {
      process.stderr.write(`${line}\n`);
    },
    warn(line: string) {
      process.stderr.write(`warning: ${line}\n`);
    },
  };
}

/** `YYYY-MM-DD` in local time, the way case rows store it. */
export function localDate(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** `YYYYMMDD-HHMMSS`, used for timestamped backups. */
export function stamp(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

export function isoNow(now: Date = new Date()): string {
  return now.toISOString();
}

export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Lowercase, unaccented, punctuation-free — for comparing rewritten narration. */
export function normalizeWords(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function words(value: string): string[] {
  const normalized = normalizeWords(value);
  return normalized.length > 0 ? normalized.split(' ') : [];
}

export function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit);
}

export function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
