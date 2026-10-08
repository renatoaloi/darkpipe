/**
 * fakes.ts — non-network adapters. A pipeline command must be able to run with
 * these selected in config, and no test may call Runware or YouTube.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type {
  MediaProvider,
  ProviderCallResult,
  Publisher,
  PublishPack,
  SpeechProvider,
  TextProvider,
  TextResult,
} from '../ports.ts';
import type { AdapterFactory } from './registry.ts';
import { solidPng, silentWav } from '../lib/media.ts';
import { ensureDir } from '../lib/paths.ts';
import { DarkpipeError, round, truncate } from '../lib/util.ts';

function writeArtifact(outPath: string, bytes: Buffer): string {
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, bytes);
  return path.resolve(outPath);
}

function clipPlaceholder(outPath: string, seconds: number): { path: string; ffmpeg: boolean } {
  ensureDir(path.dirname(outPath));
  const probe = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (probe.status === 0) {
    const run = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        `color=c=0x0b0f17:s=1280x720:d=${seconds}:r=24`,
        '-pix_fmt',
        'yuv420p',
        outPath,
      ],
      { encoding: 'utf8' },
    );
    if (run.status === 0) return { path: path.resolve(outPath), ffmpeg: true };
  }
  // No ffmpeg here: leave a named placeholder. Tests only assert the artifact exists.
  fs.writeFileSync(outPath, Buffer.from(`fake-clip ${seconds}s\n`, 'utf8'));
  return { path: path.resolve(outPath), ffmpeg: false };
}

export const FAKE_MEDIA_STILL_USD = 0.03;
export const FAKE_MEDIA_CLIP_USD = 0.0807;

export const fakeMediaFactory: AdapterFactory<MediaProvider> = {
  name: 'fake',
  port: 'media',
  create(): MediaProvider {
    return {
      name: 'fake',
      provider: 'fake',
      async still(request): Promise<ProviderCallResult> {
        const text = Buffer.from(request.prompt, 'utf8');
        const bytes = solidPng(request.width ?? 1280, request.height ?? 720, {
          r: 11,
          g: 15,
          b: 23 + (text.length % 40),
        });
        const written = writeArtifact(request.outPath, bytes);
        return {
          path: written,
          usd: FAKE_MEDIA_STILL_USD,
          provider: 'fake',
          model: request.model ?? 'fake-still',
          latencyMs: 1,
          jobId: null,
          raw: { fake: true, kind: 'still' },
        };
      },
      async clip(request): Promise<ProviderCallResult> {
        const seconds = request.seconds ?? 6;
        const written = clipPlaceholder(request.outPath, seconds);
        return {
          path: written.path,
          usd: FAKE_MEDIA_CLIP_USD,
          provider: 'fake',
          model: request.model ?? 'fake-clip',
          latencyMs: 1,
          jobId: null,
          raw: { fake: true, kind: 'clip', ffmpeg: written.ffmpeg },
        };
      },
    };
  },
};

export const FAKE_SPEECH_USD = 0.0012;

export const fakeSpeechFactory: AdapterFactory<SpeechProvider> = {
  name: 'fake',
  port: 'speech',
  create(): SpeechProvider {
    return {
      name: 'fake',
      provider: 'fake',
      async synthesize(request): Promise<ProviderCallResult> {
        // Roughly one word per 0.42s, which is what the narration files measure.
        const seconds = Math.max(1.5, request.text.trim().split(/\s+/).length * 0.42);
        const written = writeArtifact(request.outPath, silentWav(round(seconds, 2)));
        return {
          path: written,
          usd: FAKE_SPEECH_USD,
          provider: 'fake',
          model: request.model ?? 'fake-speech',
          latencyMs: 1,
          jobId: null,
          raw: { fake: true, kind: 'speech', seconds: round(seconds, 2) },
        };
      },
    };
  },
};

/** The document the fake text adapter answers with, keyed by purpose. */
export function fakeTextDocument(purpose: string, prompt: string): string {
  switch (purpose) {
    case 'research':
      return JSON.stringify({
        script_md: [
          '# Guide script (fake research)',
          '',
          '## Facts',
          '- The case happened on a date the operator will check.',
          '',
          '## Telling order',
          '00:00 Cold open. 01:30 File. 03:00 Timeline. 05:00 Investigation. 07:00 Unresolved.',
          '',
          '## Blocks',
          '1. Cold open — 8.5s per cut.',
          '2. File — 8.5s per cut.',
        ].join('\n'),
        estilo: {
          combinacao: 'fake documentary look',
          prefixo: '',
          sufixo: '',
          extra: 'period detail, no modern objects',
          variantes: ['wide shot', 'object detail', 'figure from behind', 'close on face'],
        },
      });
    case 'prompts': {
      const numbers = [...prompt.matchAll(/shot_num["':\s]+(\d+)/g)].map((m) => Number(m[1]));
      const unique = [...new Set(numbers)];
      return JSON.stringify({
        prompts: unique.map((shot_num) => ({
          shot_num,
          prompt: `fake prompt for shot ${shot_num}: documentary still, desaturated`,
        })),
      });
    }
    case 'plan':
      return JSON.stringify({ cuts: [] });
    case 'style':
      return JSON.stringify({ prefixo: '', sufixo: '', extra: 'fake style extra' });
    case 'posts':
      return JSON.stringify({ posts: ['fake community post'] });
    case 'shorts':
      return JSON.stringify({ shorts: [{ title: 'fake short', shot_nums: [1, 2, 3] }] });
    case 'compete':
      return JSON.stringify({ note: 'fake competition measurement' });
    default:
      return JSON.stringify({ text: 'fake response' });
  }
}

export const fakeTextFactory: AdapterFactory<TextProvider> = {
  name: 'fake',
  port: 'text',
  create(): TextProvider {
    return {
      name: 'fake',
      provider: 'fake',
      async complete(request): Promise<TextResult> {
        const text = fakeTextDocument(request.purpose, request.prompt);
        return {
          text,
          path: null,
          usd: 0.0004,
          provider: 'fake',
          model: request.model ?? 'fake-text',
          latencyMs: 1,
          jobId: null,
          tokensIn: text.length,
          tokensOut: Math.round(text.length / 4),
          raw: { fake: true, purpose: request.purpose },
        };
      },
    };
  },
};

/** A text adapter that always fails, for the "research failed" test. */
export const failingTextFactory: AdapterFactory<TextProvider> = {
  name: 'failing',
  port: 'text',
  create(): TextProvider {
    return {
      name: 'failing',
      provider: 'failing',
      async complete(): Promise<TextResult> {
        throw new DarkpipeError('text provider refused the request (fake failure)', { port: 'text' });
      },
    };
  },
};

export interface FakePublisherRecord {
  packs: PublishPack[];
  uploads: number;
}

export const fakePublisherFactory: AdapterFactory<Publisher> = {
  name: 'fake',
  port: 'publisher',
  create(): Publisher {
    const record: FakePublisherRecord = { packs: [], uploads: 0 };
    const publisher: Publisher & { record: FakePublisherRecord } = {
      name: 'fake',
      provider: 'fake',
      record,
      credentials() {
        return { ok: true, present: ['FAKE_PUBLISHER'], missing: [] };
      },
      async upload(pack) {
        record.packs.push(pack);
        record.uploads += 1;
        return { videoId: `fake-${pack.case}`, status: 'ok' };
      },
    };
    return publisher;
  },
};

/** Same document the CLI writes for a publish pack, truncated for logs. */
export function describePack(pack: PublishPack): string {
  return `title="${truncate(pack.title, 60)}" tags=${pack.tags.length} chapters=${pack.chapters.length}`;
}
