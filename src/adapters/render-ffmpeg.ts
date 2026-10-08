/**
 * render-ffmpeg.ts — the default Renderer: `ffmpeg`/`ffprobe` on PATH. It runs
 * the filter graph it is given and owns no channel rule: the domain decides what
 * to render and hands the argv here. A missing binary is named so the operator
 * knows what to install.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Renderer, RenderResult, RenderSpec } from '../ports.ts';
import type { AdapterFactory } from './registry.ts';
import { DarkpipeError } from '../lib/util.ts';
import { checksum } from '../lib/media.ts';
import { ensureDir } from '../lib/paths.ts';

export interface FfmpegSettings {
  ffmpeg?: string;
  ffprobe?: string;
}

interface RunOutcome {
  code: number;
  stdout: string;
  stderr: string;
  missing: boolean;
}

/** Run a binary, capturing both streams. `missing` marks ENOENT (not installed). */
function run(binary: string, args: string[]): Promise<RunOutcome> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error), missing: true });
      return;
    }
    let stdout = '';
    let stderr = '';
    let missing = false;
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      missing = code === 'ENOENT';
      stderr += `${error.message}\n`;
    });
    child.on('close', (code) => {
      resolve({ code: code ?? -1, stdout, stderr, missing });
    });
  });
}

function tail(text: string, lines = 8): string {
  const parts = text.trim().split(/\r?\n/).filter((line) => line.length > 0);
  return parts.slice(-lines).join('\n');
}

export const ffmpegRendererFactory: AdapterFactory<Renderer> = {
  name: 'ffmpeg',
  port: 'render',
  create(_context, settings): Renderer {
    const ffmpeg = String((settings as FfmpegSettings).ffmpeg ?? 'ffmpeg');
    const ffprobe = String((settings as FfmpegSettings).ffprobe ?? 'ffprobe');

    const probe = async (filePath: string): Promise<number | null> => {
      const result = await run(ffprobe, [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=nw=1:nk=1',
        filePath,
      ]);
      if (result.code !== 0) return null;
      const parsed = Number(result.stdout.trim());
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    };

    return {
      name: 'ffmpeg',

      probe,

      async probeOrFail(filePath: string): Promise<number> {
        const duration = await probe(filePath);
        if (duration === null) {
          throw new DarkpipeError(`cannot read the duration of ${filePath} with ${ffprobe}`, {
            port: 'render',
            hint: `check that ${ffprobe} is on PATH and that the file is valid media`,
          });
        }
        return duration;
      },

      async render(spec: RenderSpec): Promise<RenderResult> {
        ensureDir(path.dirname(spec.outPath));
        const result = await run(ffmpeg, spec.args);
        if (result.missing) {
          throw new DarkpipeError(`render port: the "${ffmpeg}" binary is not on PATH`, {
            port: 'render',
            hint: `install ffmpeg and put ${ffmpeg} on PATH — the npm package does not bundle it`,
          });
        }
        if (result.code !== 0) {
          throw new DarkpipeError(`ffmpeg failed (exit ${result.code}) writing ${spec.outPath}`, {
            port: 'render',
            hint: tail(result.stderr) || 'ffmpeg printed no diagnostics',
          });
        }
        if (!fs.existsSync(spec.outPath)) {
          throw new DarkpipeError(`ffmpeg reported success but ${spec.outPath} does not exist`, { port: 'render' });
        }
        const stats = fs.statSync(spec.outPath);
        return {
          path: path.resolve(spec.outPath),
          checksum: checksum(spec.outPath),
          bytes: stats.size,
        };
      },

      async available(): Promise<boolean> {
        const result = await run(ffmpeg, ['-version']);
        return !result.missing && result.code === 0;
      },
    };
  },
};
