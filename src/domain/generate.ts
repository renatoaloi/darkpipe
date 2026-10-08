/**
 * generate.ts — the pure rules behind `darkpipe generate` and `darkpipe narrate`.
 *
 * A command scopes work by block/chapter on the same ruler as the timeline: the
 * plan's `bloco` is a 0-based chapter index and a narration block is indexed by
 * its position among the audio files, also from 0. Nothing here talks to a
 * vendor, a database or ffmpeg — the commands own the ports.
 */

import type { PlanShot, ShotPlan } from '../ports.ts';
import { padShot } from './timeline.ts';
import { NARRATION_DIR, NARRATION_SCRIPT } from './narration.ts';

export { NARRATION_DIR, NARRATION_SCRIPT };

/** The case layout the art lives in, matching the legacy folders. */
export const SHOTS_DIR = '04_shots';
export const SHORTS_FILE = 'shorts/shorts.json';
export const POSTS_FILE = 'publicacao/posts/posts.json';

/** `04_shots/shot_07_still.jpg`. */
export function stillRelative(shotNum: number): string {
  return `${SHOTS_DIR}/shot_${padShot(shotNum)}_still.jpg`;
}

/** `04_shots/shot_07.mp4`. */
export function clipRelative(shotNum: number): string {
  return `${SHOTS_DIR}/shot_${padShot(shotNum)}.mp4`;
}

/** The artifact a shot writes, following the existing case layout. */
export function artRelativePath(shot: { shot_num: number; tipo: string }): string {
  return shot.tipo === 'video' ? clipRelative(shot.shot_num) : stillRelative(shot.shot_num);
}

/** The shots a `--block` scope covers, or all of them when block is null. */
export function shotsInBlock(plan: ShotPlan, block: number | null): PlanShot[] {
  const shots = Array.isArray(plan.shots) ? plan.shots : [];
  if (block === null) return shots;
  return shots.filter((shot) => Number(shot.bloco ?? 0) === block);
}

/** English list for the refusal that names the shots with no prompt. */
export function formatShotNumbers(numbers: number[]): string {
  return numbers.map((n) => `shot ${n}`).join(', ');
}

// --------------------------------------------------------------- narration script

/** One `## §N — salvar como `NN_name.mp3`` block of `02_narration_script.md`. */
export interface NarrationScriptBlock {
  /** 0-based position among the blocks, the index the timeline uses. */
  index: number;
  /** The `§N` number written in the script (1-based). */
  number: number;
  /** basename of the audio file, e.g. `01_cold_open.mp3`. */
  name: string;
  /** case-relative path, e.g. `02_narration_parts/01_cold_open.mp3`. */
  relative: string;
  text: string;
}

const SECTION_PATTERN =
  /^##\s*§?\s*(\d+)\s*[—\-–:]*\s*salvar como\s*`?([^`\s]+\.(?:mp3|wav))`?/i;

/**
 * Parse the narration blocks from the script, INCLUDING blocks whose audio does
 * not exist yet — that is what `narrate` needs to know what to synthesize.
 */
export function parseNarrationScript(markdown: string): NarrationScriptBlock[] {
  const blocks: NarrationScriptBlock[] = [];
  let current: { number: number; name: string; lines: string[] } | null = null;

  const flush = (): void => {
    if (current === null) return;
    blocks.push({
      index: blocks.length,
      number: current.number,
      name: current.name,
      relative: `${NARRATION_DIR}/${current.name}`,
      text: current.lines.join('\n').trim(),
    });
  };

  for (const raw of (markdown ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    const match = SECTION_PATTERN.exec(line);
    if (match !== null) {
      flush();
      current = { number: Number(match[1]), name: match[2], lines: [] };
      continue;
    }
    if (line.startsWith('## ')) {
      flush();
      current = null;
      continue;
    }
    if (current === null) continue;
    if (line.length === 0 || line.startsWith('>')) continue;
    if (line.startsWith('*') || line.startsWith('-') || line.startsWith('|') || line.startsWith('#')) continue;
    current.lines.push(raw);
  }
  flush();
  return blocks;
}

// ------------------------------------------------------------------- model JSON

function braceSpan(text: string): string | null {
  const objectStart = text.indexOf('{');
  const arrayStart = text.indexOf('[');
  const candidates = [objectStart, arrayStart].filter((value) => value >= 0);
  if (candidates.length === 0) return null;
  const from = Math.min(...candidates);
  const close = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (close <= from) return null;
  return text.slice(from, close + 1);
}

/**
 * Best-effort JSON from a text model: strips code fences and a reasoning block,
 * then falls back to the outermost object/array. Returns null when there is none.
 */
export function parseModelJson(text: string): unknown {
  const cleaned = (text ?? '').replace(/```[a-z]*/gi, ' ').replace(/```/g, ' ').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Fall through to the brace slice.
  }
  const span = braceSpan(cleaned);
  if (span === null) return null;
  try {
    return JSON.parse(span) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The document a text-port artifact writes: the parsed model output at the top
 * level, with the provider metadata first so a payload key cannot shadow it.
 */
export function modelDocument(
  parsed: unknown,
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const payload = isRecord(parsed) ? parsed : { payload: parsed === null ? null : parsed };
  return { ...metadata, ...payload };
}

// ------------------------------------------------------------------- copy prompts

function caseContext(caseId: string, title: string, script: string): string {
  return [
    `Case: ${caseId}`,
    `Title: ${title}`,
    '',
    'Narration script (the source of truth):',
    script.trim().slice(0, 6000),
  ].join('\n');
}

/** The instruction behind `darkpipe shorts`. */
export function shortsInstruction(caseId: string, title: string, script: string): string {
  return [
    'You plan YouTube Shorts for a faceless dark-history channel. English only.',
    'Pick vertical teasers cut from the finished episode: a hook from the narration,',
    'the shots it covers, a title, a description and tags. Do not invent facts.',
    'Respond with JSON only: {"shorts":[{"title":"...","shot_nums":[1,2],"description":"...","tags":["..."]}]}',
    '',
    caseContext(caseId, title, script),
  ].join('\n');
}

/** The instruction behind `darkpipe posts`. */
export function postsInstruction(caseId: string, title: string, script: string): string {
  return [
    'You write YouTube community posts for a faceless dark-history channel. English only.',
    'Write short posts built from the narration: a premiere post, a mid-week question and a poll.',
    'Do not invent facts.',
    'Respond with JSON only: {"posts":[{"when":"...","title":"...","body":"..."}]}',
    '',
    caseContext(caseId, title, script),
  ].join('\n');
}
