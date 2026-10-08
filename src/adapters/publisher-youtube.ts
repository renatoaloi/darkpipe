/**
 * publisher-youtube.ts — the default Publisher: YouTube Data API v3 resumable
 * upload plus thumbnail set, through credentials the operator supplies.
 *
 * It refreshes an access token from YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET /
 * YOUTUBE_REFRESH_TOKEN. `credentials()` reports present/missing NAMES only.
 * No secret is ever printed, logged or written to a file.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { CredentialReport, PublishPack, Publisher } from '../ports.ts';
import type { AdapterFactory } from './registry.ts';
import { DarkpipeError } from '../lib/util.ts';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';
const THUMB_URL = 'https://www.googleapis.com/upload/youtube/v3/thumbnails/set';

const REQUIRED = ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_REFRESH_TOKEN'] as const;

function present(environment: NodeJS.ProcessEnv, name: string): boolean {
  const value = environment[name];
  return value !== undefined && value.trim().length > 0;
}

function mimeFor(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.mov') return 'video/quicktime';
  return 'video/mp4';
}

export const youtubePublisherFactory: AdapterFactory<Publisher> = {
  name: 'youtube',
  port: 'publisher',
  create(): Publisher {
    const credentials = (): CredentialReport => {
      const found = REQUIRED.filter((name) => present(process.env, name));
      const missing = REQUIRED.filter((name) => !present(process.env, name));
      return {
        ok: missing.length === 0,
        present: [...found],
        missing: [...missing],
      };
    };

    return {
      name: 'youtube',
      provider: 'youtube',

      credentials,

      async upload(pack: PublishPack): Promise<{ videoId: string; status: 'ok' }> {
        const report = credentials();
        if (!report.ok) {
          throw new DarkpipeError(`port publisher: missing credential ${report.missing.join(', ')}`, {
            port: 'publisher',
            hint: `set ${report.missing.join(', ')} in the environment (secrets never go in darkpipe.config.json)`,
          });
        }
        const clientId = String(process.env.YOUTUBE_CLIENT_ID);
        const clientSecret = String(process.env.YOUTUBE_CLIENT_SECRET);
        const refreshToken = String(process.env.YOUTUBE_REFRESH_TOKEN);

        const tokenResponse = await fetch(TOKEN_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: refreshToken,
            grant_type: 'refresh_token',
          }).toString(),
        });
        if (!tokenResponse.ok) {
          throw new DarkpipeError(`port publisher: the YouTube token refresh failed (HTTP ${tokenResponse.status})`, {
            port: 'publisher',
            hint: 'check YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET / YOUTUBE_REFRESH_TOKEN with the operator',
          });
        }
        const token = (await tokenResponse.json()) as { access_token?: string };
        const access = token.access_token;
        if (typeof access !== 'string' || access.length === 0) {
          throw new DarkpipeError('port publisher: the YouTube token refresh returned no access token', { port: 'publisher' });
        }

        if (pack.videoPath === null) {
          throw new DarkpipeError('port publisher: the pack has no video path to upload', { port: 'publisher' });
        }
        const videoBytes = fs.readFileSync(pack.videoPath);
        const metadata = {
          snippet: {
            title: pack.title,
            description: pack.description,
            tags: pack.tags,
            defaultLanguage: pack.language,
            defaultAudioLanguage: pack.language,
          },
          status: { privacyStatus: 'private', selfDeclaredMadeForKids: false },
        };

        const start = await fetch(`${UPLOAD_URL}?uploadType=resumable&part=snippet,status`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${access}`,
            'content-type': 'application/json; charset=UTF-8',
            'x-upload-content-type': mimeFor(pack.videoPath),
            'x-upload-content-length': String(videoBytes.length),
          },
          body: JSON.stringify(metadata),
        });
        if (!start.ok) {
          throw new DarkpipeError(`port publisher: the YouTube upload could not start (HTTP ${start.status})`, { port: 'publisher' });
        }
        const location = start.headers.get('location');
        if (location === null) {
          throw new DarkpipeError('port publisher: the YouTube upload returned no location header', { port: 'publisher' });
        }
        const sent = await fetch(location, {
          method: 'PUT',
          headers: { 'content-type': mimeFor(pack.videoPath) },
          body: videoBytes,
        });
        if (!sent.ok) {
          throw new DarkpipeError(`port publisher: the YouTube upload failed (HTTP ${sent.status})`, { port: 'publisher' });
        }
        const uploaded = (await sent.json()) as { id?: string };
        const videoId = uploaded.id;
        if (typeof videoId !== 'string' || videoId.length === 0) {
          throw new DarkpipeError('port publisher: the YouTube upload returned no video id', { port: 'publisher' });
        }

        if (pack.thumbPath !== null && fs.existsSync(pack.thumbPath)) {
          const thumbBytes = fs.readFileSync(pack.thumbPath);
          const thumb = await fetch(`${THUMB_URL}?videoId=${encodeURIComponent(videoId)}&uploadType=media`, {
            method: 'POST',
            headers: { authorization: `Bearer ${access}`, 'content-type': mimeFor(pack.thumbPath) },
            body: thumbBytes,
          });
          if (!thumb.ok) {
            throw new DarkpipeError(`port publisher: the video uploaded but the thumbnail set failed (HTTP ${thumb.status})`, {
              port: 'publisher',
              hint: `the video id is ${videoId}`,
            });
          }
        }

        return { videoId, status: 'ok' };
      },
    };
  },
};
