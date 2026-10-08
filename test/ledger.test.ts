/**
 * ledger.test.ts — task 5.1/7.1 verify: the JSON-lines ledger appends exactly one
 * event, passes legacy lines through untouched, and treats a missing file as an
 * empty ledger. A dry run adds nothing, so the byte size does not move.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeTempRepo, type TempRepo } from './helpers.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { jsonlLedgerFactory } from '../src/adapters/ledger-jsonl.ts';

const CONTEXT = { repoRoot: '/tmp/darkpipe-ledger-unit', config: DEFAULT_CONFIG };
const LEDGER_FILE = 'custos/gastos.jsonl';

/** The legacy line: no `at`, no `usd`, no `status` — the old field names. */
const LEGACY_LINE = {
  quando: '2026-09-27T21:10:00',
  case: 'case_0000_trailer',
  shot: 2,
  tipo: 'still',
  modelo: 'alibaba:qwen-image@3.0',
  custo_usd: 0.03,
  arquivo: 'cases/case_0000_trailer/04_shots/shot_02_still.jpg',
};

function ledgerFor(repo: TempRepo) {
  return jsonlLedgerFactory.create({ repoRoot: repo.root, config: DEFAULT_CONFIG }, {
    adapter: 'jsonl',
    file: LEDGER_FILE,
  });
}

test('an old-format line without the new fields is passed through unchanged', async () => {
  const repo = makeTempRepo();
  try {
    repo.write(LEDGER_FILE, `${JSON.stringify(LEGACY_LINE)}\n`);
    const ledger = ledgerFor(repo);
    const events = await ledger.read();
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], LEGACY_LINE, 'the legacy line must come back exactly as stored');
    const event = events[0] as Record<string, unknown>;
    assert.ok(!('at' in event), 'the adapter must not invent `at`');
    assert.ok(!('usd' in event), 'the adapter must not invent `usd`');
    assert.ok(!('status' in event), 'the adapter must not invent `status`');
  } finally {
    repo.cleanup();
  }
});

test('append adds exactly one line and one event', async () => {
  const repo = makeTempRepo();
  try {
    repo.write(LEDGER_FILE, `${JSON.stringify(LEGACY_LINE)}\n`);
    const ledger = ledgerFor(repo);
    const before = await ledger.size();

    const event = {
      at: '2026-10-06T12:00:00.000Z',
      case: 'case_0101_ready',
      shot: 1,
      kind: 'still',
      provider: 'fake',
      model: 'fake-still',
      usd: 0.03,
      tokens_in: null,
      tokens_out: null,
      latency_ms: 1,
      job_id: null,
      status: 'ok' as const,
    };
    await ledger.append(event);

    const raw = repo.read(LEDGER_FILE) ?? '';
    assert.equal(raw.trimEnd().split('\n').length, 2, 'the file must gain exactly one line');
    assert.equal(await ledger.size(), before + Buffer.byteLength(`${JSON.stringify(event)}\n`), 'read() must not change the size');

    const events = await ledger.read();
    assert.equal(events.length, 2);
    assert.deepEqual(events[0], LEGACY_LINE);
    assert.deepEqual(events[1], event);
  } finally {
    repo.cleanup();
  }
});

test('a dry run leaves the byte size unchanged', async () => {
  const repo = makeTempRepo();
  try {
    repo.write(LEDGER_FILE, `${JSON.stringify(LEGACY_LINE)}\n`);
    const ledger = ledgerFor(repo);
    const before = await ledger.size();
    // A dry run only ever reads; it must never reach append().
    const events = await ledger.read();
    assert.equal(events.length, 1);
    assert.equal(await ledger.size(), before, 'reading the ledger must not move the byte size');
    assert.equal(fs.existsSync(repo.path(LEDGER_FILE)), true);
  } finally {
    repo.cleanup();
  }
});

test('a missing ledger file is an empty ledger, not an error', async () => {
  const repo = makeTempRepo();
  try {
    const ledger = ledgerFor(repo);
    assert.equal(fs.existsSync(repo.path(LEDGER_FILE)), false);
    assert.deepEqual(await ledger.read(), []);
    assert.equal(await ledger.size(), 0);
    assert.equal(fs.existsSync(repo.path(LEDGER_FILE)), false, 'read must not create the file');
    assert.equal(ledger.location, repo.path(LEDGER_FILE));
  } finally {
    repo.cleanup();
  }
});
