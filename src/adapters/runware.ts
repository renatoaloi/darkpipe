/**
 * runware.ts — the default media, speech and text adapters (Runware HTTP).
 *
 * The vendor behaviour ported from the legacy Python tree:
 *   - one JSON array of tasks is POSTed to the endpoint with the key in
 *     `Authorization: Bearer …`;
 *   - a `deliveryMethod: sync` response has NO `status` field — only the artifact
 *     URL and `cost`. A parser that requires `status` swallows it;
 *   - a refused request comes back as `errors: [...]`, not an HTTP error;
 *   - an `async` request answers with an ACK and the artifact is fetched from
 *     `getResponse` until it is ready;
 *   - the artifact is a URL that must be downloaded to the requested `outPath`.
 *
 * `parseRunwareResponse` is PURE: a fixture goes in, a URL and a cost come out,
 * with no socket. The tests use it, so no test ever calls the vendor.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  MediaProvider,
  PortName,
  ProviderCallResult,
  SpeechProvider,
  TextProvider,
  TextResult,
} from '../ports.ts';
import type { AdapterSetting } from '../config.ts';
import type { AdapterContext, AdapterFactory } from './registry.ts';
import { DarkpipeError, round } from '../lib/util.ts';
import { requireCredentials } from '../lib/guards.ts';
import { ensureDir } from '../lib/paths.ts';

export const RUNWARE_ENDPOINT = 'https://api.runware.ai/v1';
export const RUNWARE_CREDENTIAL = 'RUNWARE_API_KEY';

/** Measured prices, used only when the response carries no `cost`. */
export const STILL_USD = 0.03;
export const CLIP_USD = 0.0807;
/** MiniMax Speech HD list price, used only for the speech estimate. */
export const SPEECH_USD_PER_CHAR = 0.0001;

const STILL_EXT = ['.jpg', '.jpeg', '.png', '.webp'];
const POLL_ATTEMPTS = 120;
const POLL_INTERVAL_MS = 5_000;
const FAILURE_STATUS = new Set(['error', 'failed', 'failure', 'rejected']);

export type RunwareKind = 'still' | 'clip' | 'speech' | 'text';

export interface RunwareParse {
  /** The artifact URL. For kind `text` it carries the model's text output. */
  url: string;
  cost: number;
  model: string;
  taskId: string | null;
  /** Model text output, mirrored when the kind is `text`. */
  text?: string;
  tokensIn?: number | null;
  tokensOut?: number | null;
}

const FALLBACK_USD: Record<RunwareKind, number> = {
  still: STILL_USD,
  clip: CLIP_USD,
  speech: 0,
  text: 0,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function artifact(entry: Record<string, unknown>, kind: RunwareKind): string | null {
  if (kind === 'text') {
    const text = entry.text;
    return typeof text === 'string' && text.length > 0 ? text : null;
  }
  const fields =
    kind === 'still' ? ['imageURL', 'videoURL'] : kind === 'clip' ? ['videoURL', 'imageURL'] : ['audioURL'];
  for (const field of fields) {
    const value = entry[field];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function project(entry: Record<string, unknown>, artifactValue: string, kind: RunwareKind): RunwareParse {
  const cost = numberOrNull(entry.cost);
  const usage = asRecord(entry.usage) ?? {};
  const parsed: RunwareParse = {
    url: artifactValue,
    cost: cost !== null ? cost : FALLBACK_USD[kind],
    model: typeof entry.model === 'string' ? entry.model : '',
    taskId: typeof entry.taskUUID === 'string' ? entry.taskUUID : null,
  };
  if (kind === 'text') {
    parsed.text = artifactValue;
    parsed.tokensIn =
      numberOrNull(entry.tokensIn) ?? numberOrNull(usage.inputTokens) ?? numberOrNull(usage.promptTokens);
    parsed.tokensOut =
      numberOrNull(entry.tokensOut) ?? numberOrNull(usage.outputTokens) ?? numberOrNull(usage.completionTokens);
  }
  return parsed;
}

function failureOf(root: Record<string, unknown>, kind: RunwareKind): DarkpipeError | null {
  const errors = asArray(root.errors);
  if (errors.length > 0) {
    const first = asRecord(errors[0]) ?? {};
    const code = typeof first.code === 'string' ? first.code : 'error';
    const message = typeof first.message === 'string' ? first.message : JSON.stringify(first).slice(0, 200);
    return new DarkpipeError(`runware ${kind} request was refused (${code}): ${message}`);
  }
  for (const raw of asArray(root.data)) {
    const entry = asRecord(raw);
    if (entry === null) continue;
    const status = entry.status;
    if (typeof status === 'string' && FAILURE_STATUS.has(status.toLowerCase())) {
      const message = typeof entry.message === 'string' ? entry.message : status;
      return new DarkpipeError(`runware ${kind} failed (${status}): ${message}`);
    }
  }
  return null;
}

/**
 * The ready entry of a response, or null when it is only an ACK. A sync response
 * without `status` is ready; a failure status raises. Never touches the network.
 */
function extract(payload: unknown, kind: RunwareKind): RunwareParse | null {
  const root = asRecord(payload);
  if (root === null) {
    throw new DarkpipeError(`runware ${kind} response is not a JSON object`);
  }
  const failure = failureOf(root, kind);
  if (failure !== null) throw failure;
  for (const raw of asArray(root.data)) {
    const entry = asRecord(raw);
    if (entry === null) continue;
    const artifactValue = artifact(entry, kind);
    if (artifactValue === null) continue;
    return project(entry, artifactValue, kind);
  }
  return null;
}

/**
 * Parse one Runware JSON response. Handles the legacy quirk where a sync response
 * OMITS `status` and still carries the URL and the cost. A response with an error
 * status (or an `errors` array) raises a DarkpipeError.
 */
export function parseRunwareResponse(payload: unknown, kind: RunwareKind): RunwareParse {
  const parsed = extract(payload, kind);
  if (parsed !== null) return parsed;
  throw new DarkpipeError(`runware ${kind} response carries no artifact`);
}

/** Raised after the vendor billed us but the artifact could not be kept. */
export class RunwareBilledError extends DarkpipeError {
  readonly usd: number;
  readonly provider: string;
  readonly model: string;

  constructor(
    message: string,
    opts: { usd: number; provider: string; model: string; port: PortName; hint?: string },
  ) {
    super(message, { port: opts.port, hint: opts.hint });
    this.usd = opts.usd;
    this.provider = opts.provider;
    this.model = opts.model;
  }
}

// ------------------------------------------------------------------- the client

interface RunwareSubmission {
  parsed: RunwareParse;
  latencyMs: number;
  raw: unknown;
}

interface RunwareClient {
  endpoint: string;
  key(): string;
  submit(task: Record<string, unknown>, kind: RunwareKind): Promise<RunwareSubmission>;
  download(url: string, outPath: string): Promise<string>;
}

function settingString(settings: AdapterSetting, name: string): string | null {
  const value = settings[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function settingNumber(settings: AdapterSetting, name: string): number | null {
  const value = settings[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function post(endpoint: string, key: string, tasks: unknown[]): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(tasks),
    });
  } catch (error) {
    throw new DarkpipeError(`runware is unreachable at ${endpoint}: ${(error as Error).message}`);
  }
  const body = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new DarkpipeError(`runware returned a non-JSON response (HTTP ${response.status})`);
  }
  const root = asRecord(payload) ?? {};
  if (!response.ok && asArray(root.errors).length === 0) {
    throw new DarkpipeError(`runware returned HTTP ${response.status}`);
  }
  return payload;
}

function makeClient(settings: AdapterSetting, port: PortName): RunwareClient {
  const endpoint = settingString(settings, 'endpoint') ?? RUNWARE_ENDPOINT;

  const key = (): string => {
    // Fails before any work, naming the port and the credential. Never prints it.
    requireCredentials(port);
    const value = process.env[RUNWARE_CREDENTIAL];
    if (value === undefined || value.trim().length === 0) {
      throw new DarkpipeError(`port ${port}: missing credential ${RUNWARE_CREDENTIAL}`, {
        port,
        hint: `set ${RUNWARE_CREDENTIAL} in the environment (secrets never go in darkpipe.config.json)`,
      });
    }
    return value.trim();
  };

  const submit = async (task: Record<string, unknown>, kind: RunwareKind): Promise<RunwareSubmission> => {
    const started = Date.now();
    const apiKey = key();
    const first = await post(endpoint, apiKey, [task]);
    const direct = extract(first, kind);
    if (direct !== null) return { parsed: direct, latencyMs: Date.now() - started, raw: first };
    const taskUUID = task.taskUUID;
    if (typeof taskUUID !== 'string' || taskUUID.length === 0) {
      throw new DarkpipeError(`runware ${kind} response carried no task id to poll`);
    }
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
      await sleep(POLL_INTERVAL_MS);
      const next = await post(endpoint, apiKey, [{ taskType: 'getResponse', taskUUID }]);
      const polled = extract(next, kind);
      if (polled !== null) return { parsed: polled, latencyMs: Date.now() - started, raw: next };
    }
    throw new DarkpipeError(
      `runware ${kind} did not finish within ${Math.round((POLL_ATTEMPTS * POLL_INTERVAL_MS) / 60_000)} minutes`,
    );
  };

  const download = async (url: string, outPath: string): Promise<string> => {
    let response: Response;
    try {
      response = await fetch(url);
    } catch (error) {
      throw new DarkpipeError(`could not download the runware artifact: ${(error as Error).message}`);
    }
    if (!response.ok) {
      throw new DarkpipeError(`could not download the runware artifact (HTTP ${response.status})`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    ensureDir(path.dirname(outPath));
    fs.writeFileSync(outPath, bytes);
    return path.resolve(outPath);
  };

  return { endpoint, key, submit, download };
}

function chargedFailure(error: unknown, parsed: RunwareParse, model: string, port: PortName): never {
  if (error instanceof DarkpipeError && !(error instanceof RunwareBilledError)) {
    throw new RunwareBilledError(error.message, {
      usd: parsed.cost,
      provider: 'runware',
      model: parsed.model.length > 0 ? parsed.model : model,
      port,
      hint: error.hint ?? undefined,
    });
  }
  throw error;
}

function stillResult(
  parsed: RunwareParse,
  written: string,
  model: string,
  latencyMs: number,
  raw: unknown,
): ProviderCallResult {
  return {
    path: written,
    usd: parsed.cost,
    provider: 'runware',
    model: parsed.model.length > 0 ? parsed.model : model,
    latencyMs,
    jobId: parsed.taskId,
    raw,
  };
}

function dataUri(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase().slice(1);
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
}

/** The still that is the first frame of a clip: `shot_07.mp4` -> `shot_07_still.*`. */
function siblingStill(outPath: string): string | null {
  const dir = path.dirname(outPath);
  const base = path.basename(outPath).replace(/\.[^.]+$/, '');
  for (const ext of STILL_EXT) {
    const candidate = path.join(dir, `${base}_still${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function withMotion(prompt: string): string {
  if (/motion/i.test(prompt)) return prompt;
  return `${prompt} Motion: slow, continuous camera move with subtle subject movement; no hard cuts.`;
}

// ------------------------------------------------------------------- media

export const runwareMediaFactory: AdapterFactory<MediaProvider> = {
  name: 'runware',
  port: 'media',
  create(_context: AdapterContext, settings: AdapterSetting): MediaProvider {
    const client = makeClient(settings, 'media');
    const stillModel = settingString(settings, 'modelStill') ?? settingString(settings, 'model') ?? 'bytedance:seedream@4.5';
    const videoModel = settingString(settings, 'modelVideo') ?? 'bytedance:2@2';
    const width = settingNumber(settings, 'width') ?? 1280;
    const height = settingNumber(settings, 'height') ?? 720;
    const seconds = settingNumber(settings, 'seconds') ?? 6;
    const resolution = settingString(settings, 'resolution') ?? '720p';
    const seed = settingNumber(settings, 'seed') ?? 42;

    return {
      name: 'runware',
      provider: 'runware',
      async still(request): Promise<ProviderCallResult> {
        const model = request.model ?? stillModel;
        const task: Record<string, unknown> = {
          taskType: 'imageInference',
          taskUUID: randomUUID(),
          model,
          positivePrompt: request.prompt,
          width: request.width ?? width,
          height: request.height ?? height,
          numberResults: 1,
          seed: seed + (request.shot ?? 0),
          outputFormat: 'JPG',
          includeCost: true,
          deliveryMethod: 'async',
        };
        const submission = await client.submit(task, 'still');
        let written: string;
        try {
          written = await client.download(submission.parsed.url, request.outPath);
        } catch (error) {
          chargedFailure(error, submission.parsed, model, 'media');
        }
        return stillResult(submission.parsed, written, model, submission.latencyMs, submission.raw);
      },
      async clip(request): Promise<ProviderCallResult> {
        const model = request.model ?? videoModel;
        const still = siblingStill(request.outPath);
        const task: Record<string, unknown> = {
          taskType: 'videoInference',
          taskUUID: randomUUID(),
          model,
          positivePrompt: withMotion(request.prompt),
          duration: request.seconds ?? seconds,
          resolution,
          includeCost: true,
          deliveryMethod: 'async',
        };
        if (still !== null) {
          task.frameImages = [{ image: dataUri(still), frame: 'first' }];
        }
        const submission = await client.submit(task, 'clip');
        let written: string;
        try {
          written = await client.download(submission.parsed.url, request.outPath);
        } catch (error) {
          chargedFailure(error, submission.parsed, model, 'media');
        }
        return stillResult(submission.parsed, written, model, submission.latencyMs, submission.raw);
      },
    };
  },
};

// ------------------------------------------------------------------- speech

export const runwareSpeechFactory: AdapterFactory<SpeechProvider> = {
  name: 'runware',
  port: 'speech',
  create(_context: AdapterContext, settings: AdapterSetting): SpeechProvider {
    const client = makeClient(settings, 'speech');
    const defaultModel = settingString(settings, 'model') ?? 'minimax:speech@2.8';
    const defaultVoice = settingString(settings, 'voice') ?? 'English_ManWithDeepVoice';
    const bitrate = settingNumber(settings, 'bitrate') ?? 128;

    return {
      name: 'runware',
      provider: 'runware',
      async synthesize(request): Promise<ProviderCallResult> {
        const model = request.model ?? defaultModel;
        const task: Record<string, unknown> = {
          taskType: 'audioInference',
          taskUUID: randomUUID(),
          model,
          speech: { text: request.text, voice: request.voice ?? defaultVoice },
          audioSettings: { bitrate },
          outputFormat: 'MP3',
          outputType: 'URL',
          numberResults: 1,
          includeCost: true,
          deliveryMethod: 'sync',
        };
        const submission = await client.submit(task, 'speech');
        let written: string;
        try {
          written = await client.download(submission.parsed.url, request.outPath);
        } catch (error) {
          chargedFailure(error, submission.parsed, model, 'speech');
        }
        const parsed = submission.parsed;
        const usd = parsed.cost > 0 ? parsed.cost : round(request.text.length * SPEECH_USD_PER_CHAR, 6);
        return {
          path: written,
          usd,
          provider: 'runware',
          model: parsed.model.length > 0 ? parsed.model : model,
          latencyMs: submission.latencyMs,
          jobId: parsed.taskId,
          tokensIn: request.text.length,
          tokensOut: null,
          raw: submission.raw,
        };
      },
    };
  },
};

// ------------------------------------------------------------------- text

export const runwareTextFactory: AdapterFactory<TextProvider> = {
  name: 'runware',
  port: 'text',
  create(_context: AdapterContext, settings: AdapterSetting): TextProvider {
    const client = makeClient(settings, 'text');
    const defaultModel = settingString(settings, 'model') ?? 'minimax-m3';
    const maxTokens = settingNumber(settings, 'maxTokens') ?? 1024;
    const temperature = settingNumber(settings, 'temperature') ?? 0.6;

    return {
      name: 'runware',
      provider: 'runware',
      async complete(request): Promise<TextResult> {
        const model = request.model ?? defaultModel;
        // Runware only accepts user/assistant/tool roles: the system prompt is
        // folded into the first user message, as the legacy script does.
        const messages: Array<{ role: string; content: string }> = [];
        const content = request.system !== undefined && request.system.length > 0
          ? `${request.system}\n\n${request.prompt}`
          : request.prompt;
        messages.push({ role: 'user', content });
        const task: Record<string, unknown> = {
          taskType: 'textInference',
          taskUUID: randomUUID(),
          model,
          messages,
          settings: { maxTokens, temperature },
          deliveryMethod: 'sync',
          includeCost: true,
          includeUsage: true,
        };
        const submission = await client.submit(task, 'text');
        const parsed = submission.parsed;
        return {
          text: parsed.text ?? parsed.url,
          path: null,
          usd: parsed.cost,
          provider: 'runware',
          model: parsed.model.length > 0 ? parsed.model : model,
          latencyMs: submission.latencyMs,
          jobId: parsed.taskId,
          tokensIn: parsed.tokensIn ?? null,
          tokensOut: parsed.tokensOut ?? null,
          raw: submission.raw,
        };
      },
    };
  },
};
