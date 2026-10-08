/**
 * registry.test.ts — task 2.1 verify: the composition root fails by port name
 * when config names an unknown adapter, and every port resolves from config.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPorts, allAdapterNames, adapterNames } from '../src/adapters/registry.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { DarkpipeError } from '../src/lib/util.ts';

test('default config builds every port', () => {
  const ports = buildPorts('/tmp/darkpipe-registry-test', structuredClone(DEFAULT_CONFIG));
  assert.equal(ports.store.name, 'sqlite');
  assert.equal(ports.files.name, 'casefs');
  assert.equal(ports.media.name, 'runware');
  assert.equal(ports.speech.name, 'runware');
  assert.equal(ports.text.name, 'runware');
  assert.equal(ports.render.name, 'ffmpeg');
  assert.equal(ports.ledger.name, 'jsonl');
  assert.equal(ports.publisher.name, 'youtube');
});

test('unknown adapter fails and names the port', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.media = { adapter: 'nope' } as never;
  let captured: unknown = null;
  try {
    buildPorts('/tmp/darkpipe-registry-test', config);
  } catch (error) {
    captured = error;
  }
  assert.ok(captured instanceof DarkpipeError, 'must throw a DarkpipeError');
  const failure = captured as DarkpipeError;
  assert.equal(failure.port, 'media');
  assert.match(failure.message, /media/);
  assert.match(failure.message, /nope/);
});

test('every port reports its known adapters', () => {
  const known = allAdapterNames();
  for (const port of Object.keys(known) as Array<keyof typeof known>) {
    assert.ok(known[port].length > 0, `port ${port} lists no adapter`);
  }
  assert.deepEqual(adapterNames('media').sort(), ['fake', 'runware']);
});
