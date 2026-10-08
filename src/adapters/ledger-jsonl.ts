/**
 * ledger-jsonl.ts — the default Ledger: append-only JSON lines.
 * The built-in path is `costs/events.jsonl`. An operator config can point `file`
 * at an existing log; lines already stored are never rewritten.
 *
 * `read()` parses every line, oldest first, and passes a legacy line that lacks
 * the new cost-event fields through exactly as stored — it never invents a `usd`,
 * an `at` or a `status`. A missing file is an empty ledger, not an error.
 * `size()` is the byte size, which tests use to prove a dry run wrote nothing.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { CostEvent, Ledger } from '../ports.ts';
import type { AdapterContext, AdapterFactory } from './registry.ts';
import { ensureDir } from '../lib/paths.ts';

export const DEFAULT_LEDGER_FILE = 'costs/events.jsonl';

export const jsonlLedgerFactory: AdapterFactory<Ledger> = {
  name: 'jsonl',
  port: 'ledger',
  create(context: AdapterContext, settings): Ledger {
    const configured =
      typeof settings.file === 'string' && settings.file.length > 0 ? settings.file : DEFAULT_LEDGER_FILE;
    const file = path.isAbsolute(configured) ? configured : path.resolve(context.repoRoot, configured);

    return {
      name: 'jsonl',
      location: file,
      async append(event: CostEvent): Promise<void> {
        ensureDir(path.dirname(file));
        fs.appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8');
      },
      async read(): Promise<CostEvent[]> {
        if (!fs.existsSync(file)) return [];
        const raw = fs.readFileSync(file, 'utf8');
        const events: CostEvent[] = [];
        for (const line of raw.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          try {
            events.push(JSON.parse(trimmed) as CostEvent);
          } catch {
            // Keep the ledger readable: a corrupt line is skipped, not invented.
          }
        }
        return events;
      },
      async size(): Promise<number> {
        return fs.existsSync(file) ? fs.statSync(file).size : 0;
      },
    };
  },
};
