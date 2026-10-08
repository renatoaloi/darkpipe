/**
 * store-sqlite.ts — the default CaseStore: a SQLite file (`darkpipe.sqlite`).
 * Owned by the store adapter: the domain only asks for cases and shots.
 *
 * On the first read, when the new database has no cases and the legacy
 * `kanban.sqlite` exists, the `cases` and `shots` rows are copied once and the
 * import is recorded. Agenda tables are never copied. Every later read uses
 * only `darkpipe.sqlite`.
 *
 * VERIFY (tasks 3.1): first `listCases` copies the `cases` and `shots` rows out
 * of `kanban.sqlite` into an empty `darkpipe.sqlite` and records the import;
 * agenda tables are not copied; a second list does not open `kanban.sqlite`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CasePatch, CaseRecordInput, CaseRow, CaseStore, ShotRow } from '../ports.ts';
import type { AdapterSetting } from '../config.ts';
import type { AdapterContext, AdapterFactory } from './registry.ts';
import { DarkpipeError, isoNow } from '../lib/util.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,
  titulo_en TEXT NOT NULL DEFAULT '',
  vertente TEXT NOT NULL DEFAULT '',
  estado TEXT NOT NULL DEFAULT 'backlog',
  prioridade INTEGER NOT NULL DEFAULT 0,
  data_criacao TEXT NOT NULL DEFAULT '',
  notas TEXT
);
CREATE TABLE IF NOT EXISTS shots (
  case_id TEXT NOT NULL,
  shot_num INTEGER NOT NULL,
  tipo TEXT NOT NULL DEFAULT '',
  descricao TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  duracao_s REAL NOT NULL DEFAULT 0,
  origem TEXT,
  PRIMARY KEY (case_id, shot_num)
);
CREATE TABLE IF NOT EXISTS imports (
  source TEXT PRIMARY KEY,
  imported_at TEXT NOT NULL
);
`;

type Row = Record<string, unknown>;

function str(value: unknown, fallback = ''): string {
  return value === null || value === undefined ? fallback : String(value);
}

function pathFrom(repoRoot: string, value: unknown, fallback: string): string {
  const name = typeof value === 'string' && value.length > 0 ? value : fallback;
  return path.isAbsolute(name) ? name : path.resolve(repoRoot, name);
}

interface LegacyRow {
  id?: unknown;
  titulo_en?: unknown;
  vertente?: unknown;
  estado?: unknown;
  prioridade?: unknown;
  data_criacao?: unknown;
  notas?: unknown;
}

function createStore(context: AdapterContext, settings: AdapterSetting): CaseStore {
  const file = pathFrom(context.repoRoot, settings.file, 'darkpipe.sqlite');
  const legacyFile = pathFrom(context.repoRoot, settings.legacy, 'kanban.sqlite');

  let db: DatabaseSync | null = null;
  let importChecked = false;

  const handle = (): DatabaseSync => {
    if (db !== null) return db;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    db = new DatabaseSync(file);
    db.exec(SCHEMA);
    return db;
  };

  /** The one-time import. Runs at most once per process per store instance. */
  const importLegacyOnce = (): void => {
    if (importChecked) return;
    importChecked = true;
    const database = handle();
    const total = Number((database.prepare('SELECT COUNT(*) AS n FROM cases').get() as Row).n ?? 0);
    if (total > 0) return;
    if (!fs.existsSync(legacyFile)) return;
    const already = database.prepare('SELECT source FROM imports WHERE source = ?').get(legacyFile);
    if (already !== undefined) return;
    copyLegacy(database, legacyFile);
  };

  const copyLegacy = (database: DatabaseSync, legacy: string): void => {
    let source: DatabaseSync;
    try {
      source = new DatabaseSync(legacy, { readOnly: true });
    } catch (error) {
      throw new DarkpipeError(`store: could not open legacy database ${legacy}: ${(error as Error).message}`, {
        port: 'store',
      });
    }
    try {
      const tables = new Set(
        (source.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Row[]).map((row) =>
          String(row.name),
        ),
      );
      // Agenda tables are never in this list: only cases and shots travel.
      database.exec('BEGIN');
      try {
        if (tables.has('cases')) {
          const rows = source
            .prepare('SELECT id, titulo_en, vertente, estado, prioridade, data_criacao, notas FROM cases')
            .all() as LegacyRow[];
          const insert = database.prepare(
            'INSERT OR IGNORE INTO cases(id, titulo_en, vertente, estado, prioridade, data_criacao, notas) VALUES(?,?,?,?,?,?,?)',
          );
          for (const row of rows) {
            insert.run(
              str(row.id),
              str(row.titulo_en),
              str(row.vertente),
              str(row.estado, 'backlog'),
              Number(row.prioridade ?? 0),
              str(row.data_criacao),
              row.notas === null || row.notas === undefined ? null : String(row.notas),
            );
          }
        }
        if (tables.has('shots')) {
          const rows = source
            .prepare('SELECT case_id, shot_num, tipo, descricao, prompt, duracao_s, origem FROM shots')
            .all() as Row[];
          const insert = database.prepare(
            'INSERT OR IGNORE INTO shots(case_id, shot_num, tipo, descricao, prompt, duracao_s, origem) VALUES(?,?,?,?,?,?,?)',
          );
          for (const row of rows) {
            insert.run(
              str(row.case_id),
              Number(row.shot_num ?? 0),
              str(row.tipo),
              str(row.descricao),
              str(row.prompt),
              Number(row.duracao_s ?? 0),
              row.origem === null || row.origem === undefined ? null : String(row.origem),
            );
          }
        }
        database
          .prepare('INSERT OR REPLACE INTO imports(source, imported_at) VALUES(?, ?)')
          .run(legacy, isoNow());
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    } finally {
      source.close();
    }
  };

  const readRows = <T>(sql: string, params: unknown[] = []): T[] => {
    importLegacyOnce();
    return handle().prepare(sql).all(...(params as never[])) as T[];
  };

  return {
    name: 'sqlite',
    location: file,

    async listCases(): Promise<CaseRow[]> {
      return readRows<CaseRow>('SELECT id, titulo_en, vertente, estado, prioridade, data_criacao, notas FROM cases ORDER BY prioridade ASC, data_criacao ASC, id ASC');
    },

    async getCase(id: string): Promise<CaseRow | null> {
      const rows = readRows<CaseRow>(
        'SELECT id, titulo_en, vertente, estado, prioridade, data_criacao, notas FROM cases WHERE id = ?',
        [id],
      );
      return rows[0] ?? null;
    },

    async createCase(record: CaseRecordInput): Promise<void> {
      importLegacyOnce();
      handle()
        .prepare(
          'INSERT INTO cases(id, titulo_en, vertente, estado, prioridade, data_criacao, notas) VALUES(?,?,?,?,?,?,?) ' +
            'ON CONFLICT(id) DO UPDATE SET titulo_en = excluded.titulo_en, vertente = excluded.vertente, ' +
            'estado = excluded.estado, prioridade = excluded.prioridade, data_criacao = excluded.data_criacao, ' +
            'notas = excluded.notas',
        )
        .run(
          record.id,
          record.titulo_en,
          record.vertente,
          record.estado,
          record.prioridade,
          record.data_criacao,
          record.notas ?? null,
        );
    },

    async updateCase(id: string, patch: CasePatch): Promise<void> {
      importLegacyOnce();
      const sets: string[] = [];
      const values: unknown[] = [];
      for (const [column, value] of [
        ['titulo_en', patch.titulo_en],
        ['vertente', patch.vertente],
        ['estado', patch.estado],
        ['prioridade', patch.prioridade],
        ['notas', patch.notas],
      ] as const) {
        if (value === undefined) continue;
        sets.push(`${column} = ?`);
        values.push(value);
      }
      if (sets.length === 0) return;
      values.push(id);
      handle()
        .prepare(`UPDATE cases SET ${sets.join(', ')} WHERE id = ?`)
        .run(...(values as never[]));
    },

    async maxPriority(): Promise<number> {
      importLegacyOnce();
      const row = handle().prepare('SELECT COALESCE(MAX(prioridade), 0) AS max FROM cases').get() as Row;
      return Number(row.max ?? 0);
    },

    async listShots(caseId: string): Promise<ShotRow[]> {
      return readRows<ShotRow>(
        'SELECT case_id, shot_num, tipo, descricao, prompt, duracao_s, origem FROM shots WHERE case_id = ? ORDER BY shot_num ASC',
        [caseId],
      );
    },

    async replaceShots(caseId: string, shots: ShotRow[]): Promise<void> {
      importLegacyOnce();
      const database = handle();
      database.exec('BEGIN');
      try {
        database.prepare('DELETE FROM shots WHERE case_id = ?').run(caseId);
        const insert = database.prepare(
          'INSERT INTO shots(case_id, shot_num, tipo, descricao, prompt, duracao_s, origem) VALUES(?,?,?,?,?,?,?)',
        );
        for (const shot of shots) {
          insert.run(
            caseId,
            shot.shot_num,
            shot.tipo,
            shot.descricao,
            shot.prompt,
            shot.duracao_s,
            shot.origem ?? null,
          );
        }
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },

    async removeShots(caseId: string, shotNums: number[]): Promise<void> {
      importLegacyOnce();
      if (shotNums.length === 0) return;
      const placeholders = shotNums.map(() => '?').join(', ');
      handle()
        .prepare(`DELETE FROM shots WHERE case_id = ? AND shot_num IN (${placeholders})`)
        .run(caseId, ...(shotNums as never[]));
    },

    async close(): Promise<void> {
      if (db !== null) {
        db.close();
        db = null;
      }
    },
  };
}

export const sqliteStoreFactory: AdapterFactory<CaseStore> = {
  name: 'sqlite',
  port: 'store',
  create(context, settings): CaseStore {
    return createStore(context, settings);
  },
};
