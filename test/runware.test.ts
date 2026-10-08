/**
 * runware.test.ts — task 5.1 verify.
 *
 * No test may open a socket to Runware. The vendor responses are parsed through
 * the pure `parseRunwareResponse`, and the fake media adapter runs with
 * `globalThis.fetch` replaced by a function that throws.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRepo } from './helpers.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { DarkpipeError } from '../src/lib/util.ts';
import { fakeMediaFactory } from '../src/adapters/fakes.ts';
import { runwareMediaFactory, parseRunwareResponse } from '../src/adapters/runware.ts';

const CONTEXT = { repoRoot: '/tmp/darkpipe-runware-unit', config: DEFAULT_CONFIG };

/** A sync response shaped like the legacy `deliveryMethod: sync` answer: NO status. */
function syncResponse(fields: Record<string, unknown>): Record<string, unknown> {
  return { data: [{ taskUUID: 'task-1', ...fields }] };
}

test('a sync response without `status` still yields a URL and a cost', () => {
  const still = syncResponse({ imageURL: 'https://cdn.runware.example/still.jpg', cost: 0.03, model: 'bytedance:seedream@4.5' });
  const stillEntries = still.data as Array<Record<string, unknown>>;
  assert.ok(!('status' in stillEntries[0]), 'the fixture must omit `status`');

  const parsedStill = parseRunwareResponse(still, 'still');
  assert.equal(parsedStill.url, 'https://cdn.runware.example/still.jpg');
  assert.equal(parsedStill.cost, 0.03);
  assert.equal(parsedStill.model, 'bytedance:seedream@4.5');
  assert.equal(parsedStill.taskId, 'task-1');

  const clip = parseRunwareResponse(
    syncResponse({ videoURL: 'https://cdn.runware.example/clip.mp4', cost: 0.0807 }),
    'clip',
  );
  assert.equal(clip.url, 'https://cdn.runware.example/clip.mp4');
  assert.equal(clip.cost, 0.0807);

  const speech = parseRunwareResponse(
    syncResponse({ audioURL: 'https://cdn.runware.example/voice.mp3', cost: 0.0021 }),
    'speech',
  );
  assert.equal(speech.url, 'https://cdn.runware.example/voice.mp3');
  assert.equal(speech.cost, 0.0021);
});

test('a status-less response with no cost falls back to the measured price', () => {
  const still = parseRunwareResponse(syncResponse({ imageURL: 'https://cdn.runware.example/s.jpg' }), 'still');
  assert.equal(still.cost, 0.03, 'a still defaults to the measured US$ 0.03');
  const clip = parseRunwareResponse(syncResponse({ videoURL: 'https://cdn.runware.example/c.mp4' }), 'clip');
  assert.equal(clip.cost, 0.0807, 'a 6s clip defaults to the measured US$ 0.0807');
});

test('a data entry with an error status raises a DarkpipeError', () => {
  const failure = { data: [{ taskUUID: 'task-2', status: 'error', message: 'the model was rate limited' }] };
  assert.throws(() => parseRunwareResponse(failure, 'still'), (error: unknown) => {
    assert.ok(error instanceof DarkpipeError, 'must be a DarkpipeError');
    assert.match((error as Error).message, /rate limited/);
    return true;
  });
});

test('an errors array raises a DarkpipeError naming the vendor code', () => {
  const refused = { errors: [{ code: 'invalidApiKey', message: 'the key is not valid' }] };
  assert.throws(() => parseRunwareResponse(refused, 'speech'), (error: unknown) => {
    assert.ok(error instanceof DarkpipeError);
    assert.match((error as Error).message, /invalidApiKey/);
    return true;
  });
});

test('a missing RUNWARE_API_KEY fails naming the port and the credential, before any socket', async () => {
  const saved = process.env.RUNWARE_API_KEY;
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls += 1;
    throw new Error('the test must not open a socket');
  }) as typeof fetch;
  delete process.env.RUNWARE_API_KEY;
  try {
    const media = runwareMediaFactory.create(CONTEXT, { adapter: 'runware' });
    await assert.rejects(
      () => media.still({ caseId: 'case_x', shot: 1, prompt: 'a house', outPath: '/tmp/darkpipe-never.jpg' }),
      (error: unknown) => {
        assert.ok(error instanceof DarkpipeError, 'must be a DarkpipeError');
        const message = (error as Error).message;
        assert.match(message, /media/, 'the error must name the port');
        assert.match(message, /RUNWARE_API_KEY/, 'the error must name the credential');
        assert.equal((error as DarkpipeError).port, 'media');
        return true;
      },
    );
    assert.equal(fetchCalls, 0, 'the credential must be checked before any request');
  } finally {
    globalThis.fetch = originalFetch;
    if (saved === undefined) delete process.env.RUNWARE_API_KEY;
    else process.env.RUNWARE_API_KEY = saved;
  }
});

test('an unreachable vendor error never prints the key value', async () => {
  const saved = process.env.RUNWARE_API_KEY;
  const secret = 'RunwareSecretValue0123456789';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error('connection refused');
  }) as typeof fetch;
  process.env.RUNWARE_API_KEY = secret;
  try {
    const media = runwareMediaFactory.create(CONTEXT, { adapter: 'runware' });
    await assert.rejects(
      () => media.still({ caseId: 'case_x', shot: 1, prompt: 'a house', outPath: '/tmp/darkpipe-never.jpg' }),
      (error: unknown) => {
        assert.ok(error instanceof DarkpipeError);
        assert.ok(!(error as Error).message.includes(secret), 'the key value must never be printed');
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (saved === undefined) delete process.env.RUNWARE_API_KEY;
    else process.env.RUNWARE_API_KEY = saved;
  }
});

test('the fake media adapter opens no socket', async () => {
  const repo = makeTempRepo();
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls += 1;
    throw new Error('no network for the fake adapter');
  }) as typeof fetch;
  try {
    const media = fakeMediaFactory.create(CONTEXT, { adapter: 'fake' });
    const stillPath = path.join(repo.root, 'shot_01_still.png');
    const still = await media.still({ caseId: 'case_x', shot: 1, prompt: 'a house', outPath: stillPath, width: 64, height: 36 });
    assert.equal(still.provider, 'fake');
    assert.ok(still.path !== null && fs.existsSync(still.path), 'the fake still must be written');

    const clipPath = path.join(repo.root, 'shot_02.mp4');
    const clip = await media.clip({ caseId: 'case_x', shot: 2, prompt: 'a house on fire', outPath: clipPath, seconds: 1 });
    assert.equal(clip.provider, 'fake');
    assert.ok(clip.path !== null && fs.existsSync(clip.path), 'the fake clip must be written');

    assert.equal(fetchCalls, 0, 'the fake adapter must not call fetch');
  } finally {
    globalThis.fetch = originalFetch;
    repo.cleanup();
  }
});
