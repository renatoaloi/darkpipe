/**
 * store.test.ts — task 3.1 verify: the SQLite store copies `cases` and `shots`
 * rows out of a fixture `kanban.sqlite` once, never copies agenda tables, and a
 * second read does not open the legacy database.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sqliteStoreFactory } from '../src/adapters/store-sqlite.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import type { CaseStore } from '../src/ports.ts';

function makeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'darkpipe-store-'));
  fs.mkdirSync(path.join(root, 'cases'), { recursive: true });
  fs.mkdirSync(path.join(root, 'openspec'), { recursive: true });
  return root;
}

function makeStore(repoRoot: string): CaseStore {
  const config = structuredClone(DEFAULT_CONFIG);
  return sqliteStoreFactory.create({ repoRoot, config }, config.store);
}

/** A legacy `kanban.sqlite` with cases, shots and an agenda table to ignore. */
function writeLegacyKanban(repoRoot: string): string {
  const file = path.join(repoRoot, 'kanban.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE cases(
      id TEXT PRIMARY KEY, titulo_en TEXT, vertente TEXT, estado TEXT, prioridade INTEGER,
      data_criacao TEXT, notas TEXT);
    CREATE TABLE shots(
      case_id TEXT, shot_num INTEGER, tipo TEXT, descricao TEXT, prompt TEXT, duracao_s REAL, origem TEXT);
    CREATE TABLE agenda(
      id INTEGER PRIMARY KEY, case_id TEXT, quando TEXT, o_que TEXT);
  `);
  const insertCase = db.prepare(
    'INSERT INTO cases(id, titulo_en, vertente, estado, prioridade, data_criacao, notas) VALUES(?,?,?,?,?,?,?)',
  );
  insertCase.run('case_0001_alpha', 'Alpha', 'dark_history', 'published', 1, '2026-09-01', 'note a');
  insertCase.run('case_0002_beta', 'Beta', 'pilot', 'backlog', 2, '2026-09-02', null);
  const insertShot = db.prepare(
    'INSERT INTO shots(case_id, shot_num, tipo, descricao, prompt, duracao_s, origem) VALUES(?,?,?,?,?,?,?)',
  );
  insertShot.run('case_0002_beta', 1, 'image', 'a', 'prompt a', 8.5, 'runware bytedance:2@2');
  insertShot.run('case_0002_beta', 2, 'video', 'b', 'prompt b', 6, null);
  insertShot.run('case_0001_alpha', 1, 'image', 'c', 'prompt c', 4, 'image.png');
  const insertAgenda = db.prepare('INSERT INTO agenda(id, case_id, quando, o_que) VALUES(?,?,?,?)');
  insertAgenda.run(1, 'case_0002_beta', '2026-09-09', 'render');
  insertAgenda.run(2, 'case_0001_alpha', '2026-09-10', 'publish');
  db.close();
  return file;
}

function tableNames(dbFile: string): string[] {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map((row) => row.name)
      .sort();
  } finally {
    db.close();
  }
}

test('first read copies cases and shots once and records the import', async () => {
  const repo = makeRepo();
  const store = makeStore(repo);
  try {
    const legacy = writeLegacyKanban(repo);
    const cases = await store.listCases();
    assert.equal(cases.length, 2);
    assert.deepEqual(
      cases.map((row) => row.id),
      ['case_0001_alpha', 'case_0002_beta'],
    );
    assert.equal(cases[0].estado, 'published');

    const shots = await store.listShots('case_0002_beta');
    assert.deepEqual(
      shots.map((shot) => shot.shot_num),
      [1, 2],
    );
    assert.equal(shots[0].origem, 'runware bytedance:2@2');
    assert.equal(shots[1].duracao_s, 6);

    const dbFile = path.join(repo, 'darkpipe.sqlite');
    const names = tableNames(dbFile);
    assert.ok(names.includes('cases'), 'new store has a cases table');
    assert.ok(names.includes('shots'), 'new store has a shots table');
    assert.ok(names.includes('imports'), 'the one-time import is recorded');
    assert.ok(!names.includes('agenda'), 'agenda tables are never copied');

    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      const imported = db.prepare('SELECT source, imported_at FROM imports').all() as {
        source: string;
        imported_at: string;
      }[];
      assert.equal(imported.length, 1);
      assert.equal(imported[0].source, legacy);
      assert.ok(imported[0].imported_at.length > 0);
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM cases').get() as { n: number }).n, 2);
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM shots').get() as { n: number }).n, 3);
    } finally {
      db.close();
    }
  } finally {
    await store.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('a second read never opens kanban.sqlite', async () => {
  const repo = makeRepo();
  const store = makeStore(repo);
  try {
    writeLegacyKanban(repo);
    const first = await store.listCases();
    assert.equal(first.length, 2);

    // Prove the legacy file is not needed: hide it, then read again.
    fs.renameSync(path.join(repo, 'kanban.sqlite'), path.join(repo, 'kanban.sqlite.gone'));
    const second = await store.listCases();
    assert.deepEqual(second, first);

    // A brand new adapter (as in the next CLI run) also works without the file.
    const other = makeStore(repo);
    try {
      assert.equal((await other.listCases()).length, 2);
      assert.equal((await other.listShots('case_0001_alpha')).length, 1);
    } finally {
      await other.close();
    }
  } finally {
    await store.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('the store round-trips writes and never re-reads the legacy file', async () => {
  const repo = makeRepo();
  const store = makeStore(repo);
  try {
    assert.equal(await store.maxPriority(), 0);
    await store.createCase({
      id: 'case_0009_exemplo',
      titulo_en: 'The Example Case',
      vertente: 'space_aviation',
      estado: 'backlog',
      prioridade: 1,
      data_criacao: '2026-10-06',
      notas: '',
    });
    assert.equal(await store.maxPriority(), 1);
    await store.updateCase('case_0009_exemplo', { estado: 'scripted', notas: 'moved on' });
    const row = await store.getCase('case_0009_exemplo');
    assert.equal(row?.estado, 'scripted');
    assert.equal(row?.notas, 'moved on');
    assert.equal(await store.getCase('case_9999_missing'), null);

    // A recreated case behaves as a new project even when the id existed.
    await store.createCase({
      id: 'case_0009_exemplo',
      titulo_en: 'The Example Case Again',
      vertente: 'space_aviation',
      estado: 'backlog',
      prioridade: 2,
      data_criacao: '2026-10-07',
      notas: '',
    });
    const again = await store.getCase('case_0009_exemplo');
    assert.equal(again?.prioridade, 2);
    assert.equal(again?.estado, 'backlog');
    assert.equal(again?.titulo_en, 'The Example Case Again');
  } finally {
    await store.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
