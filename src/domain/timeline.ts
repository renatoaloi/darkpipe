/**
 * timeline.ts — the cut map (`timeline.json`) rules. A span is a fraction of a
 * narration block; the on-screen time is span x block seconds. Validation and the
 * editing verbs live here so the rules are not in the ffmpeg adapter.
 */

import type { Ports, ShotKind, TimelineCut, TimelineMap } from '../ports.ts';
import {
  CUT_FLOOR_TOLERANCE,
  DEFAULT_GAPS,
  MAX_BLOCK_GAP_S,
  MIN_CUT_S,
  RETIME_MAX,
  RETIME_MIN,
  movesTowardRange,
  overlapSeconds,
  retimeFactor,
  seconds as fmtSeconds,
  spanDuration,
  withinRetimeRange,
  type Span,
} from '../ruler.ts';
import { round } from '../lib/util.ts';

/** Read a candidate span as a [start, end] tuple of numbers. */
export function toSpan(value: unknown): Span {
  if (Array.isArray(value) && value.length >= 2) {
    const start = Number(value[0]);
    const end = Number(value[1]);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) return [start, end];
  }
  return [0, 1];
}

export const MAP_FILE = 'timeline.json';
export const SHOTS_DIR = '04_shots';
export const STILL_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'] as const;

/** One cut with everything validation needs. `span` enables overlap/gap checks. */
export interface ValidatedCut {
  shot: string;
  block: number;
  kind: ShotKind;
  seconds: number;
  retime: number;
  path: string | null;
  /** Fraction span inside the block (0..1). Optional. */
  span?: [number, number];
  /** Duration of the block in seconds. Optional; enables second-level reports. */
  blockSeconds?: number;
}

export interface ValidationIssue {
  code: string;
  block: number;
  shot: string | null;
  seconds: number | null;
  message: string;
}

export interface ValidationReport {
  ok: boolean;
  blocking: ValidationIssue[];
  warnings: ValidationIssue[];
}

/** Zero-pad a shot number the way the case files do (`4` becomes `04`). */
export function padShot(shot: unknown): string {
  const digits = String(shot ?? '').replace(/\D+/g, '');
  if (digits.length === 0) return String(shot ?? '');
  return String(Number(digits)).padStart(2, '0');
}

/**
 * Runtime spelling of a clip in the case files. The port type also accepts the
 * spec's `clip`, but the real maps (cases/case_0002_bodom/timeline.json) and the
 * renderer say `video`, so that is the value we emit and read.
 */
export const CLIP_KIND: ShotKind = 'video';
export const STILL_KIND: ShotKind = 'still';

/** True for both spellings of a clip (`video` and the port's `clip`). */
export function isClipKind(kind: unknown): boolean {
  const value = String(kind ?? '').trim();
  return value === 'video' || value === 'clip';
}

/**
 * The cut kind the files use (`still` | `video`), accepting the port's `clip`
 * spelling too.
 */
export function kindOf(cut: { kind?: unknown }): ShotKind {
  return isClipKind(cut.kind) ? CLIP_KIND : STILL_KIND;
}

/** The cuts of the map that answer to a shot number. */
export function findCuts(map: TimelineMap, shot: unknown): TimelineCut[] {
  const wanted = padShot(shot);
  return (map.cuts ?? []).filter((cut) => padShot(cut.shot) === wanted);
}

/** The smallest span fraction a cut may keep so it never falls under the floor. */
export function minFraction(blockSeconds: number): number {
  if (!(blockSeconds > 0)) return 0.05;
  return Math.min(0.25, MIN_CUT_S / blockSeconds);
}

/** On-screen seconds for every cut, from the span fraction and the block length. */
export function resolveCutSeconds(
  map: TimelineMap,
  blockSeconds: Record<number, number>,
): Array<{ cut: TimelineCut; seconds: number }> {
  return (map.cuts ?? []).map((cut) => ({
    cut,
    seconds: round(spanDuration(toSpan(cut.span), blockSeconds[Number(cut.block)] ?? 0), 4),
  }));
}

/**
 * The validation rules shared by `darkpipe timeline validate` and `darkpipe render`.
 * A cut under the floor, a clip retimed outside 0.5x-2x, a missing file and an
 * overlapping span BLOCK when they fall inside the requested scope; outside the
 * scope they are warnings. A narration stretch with no visual is reported.
 */
export function validateCuts(
  cuts: ValidatedCut[],
  opts: { blocks?: number[] | null } = {},
): ValidationReport {
  const blocking: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const scope = opts.blocks ?? null;
  const place = (issue: ValidationIssue) => {
    if (scope === null || scope.includes(issue.block)) blocking.push(issue);
    else warnings.push(issue);
  };

  for (const cut of cuts) {
    if (cut.seconds < MIN_CUT_S - CUT_FLOOR_TOLERANCE) {
      place({
        code: 'cut-too-short',
        block: cut.block,
        shot: cut.shot,
        seconds: cut.seconds,
        message: `shot ${cut.shot} lasts ${fmtSeconds(cut.seconds)} on screen (below the ${MIN_CUT_S}s floor)`,
      });
    }
    if (isClipKind(cut.kind) && (cut.retime < RETIME_MIN || cut.retime > RETIME_MAX)) {
      place({
        code: 'clip-retime',
        block: cut.block,
        shot: cut.shot,
        seconds: cut.seconds,
        message: `shot ${cut.shot} is a clip retimed ${cut.retime.toFixed(2)}x (the range is ${RETIME_MIN}x-${RETIME_MAX}x)`,
      });
    }
    if (cut.path === null) {
      place({
        code: 'missing-file',
        block: cut.block,
        shot: cut.shot,
        seconds: cut.seconds,
        message: `shot ${cut.shot} (${cut.kind}) has no file in ${SHOTS_DIR}/`,
      });
    }
  }

  // Overlapping spans in the same block: the neighbour must start where the
  // previous one ends; otherwise the block runs longer than the narration.
  const byBlock = new Map<number, ValidatedCut[]>();
  for (const cut of cuts) {
    if (cut.span === undefined) continue;
    const list = byBlock.get(cut.block) ?? [];
    list.push(cut);
    byBlock.set(cut.block, list);
  }
  for (const [block, list] of byBlock) {
    const sorted = [...list].sort((a, b) => (a.span![0] - b.span![0]));
    for (let i = 0; i + 1 < sorted.length; i += 1) {
      const a = sorted[i];
      const b = sorted[i + 1];
      const overlap = overlapSeconds(a.span!, b.span!);
      if (overlap <= 0.0001) continue;
      const blockSeconds = a.blockSeconds ?? b.blockSeconds ?? 0;
      const counted = overlap * blockSeconds;
      place({
        code: 'overlap',
        block,
        shot: a.shot,
        seconds: counted,
        message: `block ${block}: shots ${a.shot} and ${b.shot} overlap — ${fmtSeconds(counted)} are counted twice (${a.span![1].toFixed(3)} vs ${b.span![0].toFixed(3)})`,
      });
    }
  }

  // A narration stretch with no cut of its own (reported, never blocking).
  const coverage = new Map<number, number>();
  const blockSecondsByNumber = new Map<number, number>();
  for (const cut of cuts) {
    if (cut.span === undefined) continue;
    const span = cut.span;
    const covered = Math.max(0, Math.min(1, span[1]) - Math.max(0, span[0]));
    coverage.set(cut.block, (coverage.get(cut.block) ?? 0) + covered);
    if (cut.blockSeconds !== undefined) blockSecondsByNumber.set(cut.block, cut.blockSeconds);
  }
  for (const [block, covered] of coverage) {
    const blockSeconds = blockSecondsByNumber.get(block) ?? 0;
    if (!(blockSeconds > 0)) continue;
    const hole = Math.max(0, 1 - covered) * blockSeconds;
    if (hole > MAX_BLOCK_GAP_S) {
      warnings.push({
        code: 'block-gap',
        block,
        shot: null,
        seconds: round(hole, 4),
        message: `block ${block}: ${hole.toFixed(1)}s of narration without its own visual (over the ${MAX_BLOCK_GAP_S}s limit)`,
      });
    }
  }

  return { ok: blocking.length === 0, blocking, warnings };
}

/** Build the validated cuts of a map: file paths and clip durations included. */
export async function collectValidatedCuts(
  ports: Ports,
  caseId: string,
  map: TimelineMap,
  blockSeconds: Record<number, number>,
): Promise<ValidatedCut[]> {
  const files = await ports.files.listFiles(caseId);
  const present = new Set(files.map((file) => file.replace(/\\/g, '/').replace(/^\.\//, '')));
  const out: ValidatedCut[] = [];
  for (const cut of map.cuts ?? []) {
    const shot = padShot(cut.shot);
    const block = Number(cut.block);
    const blockLength = blockSeconds[block] ?? 0;
    const span = toSpan(cut.span);
    const onScreen = round(spanDuration(span, blockLength), 4);
    const kind = kindOf(cut);
    const clip = isClipKind(cut.kind);
    let relative: string | null = null;
    if (clip) {
      const candidate = `${SHOTS_DIR}/shot_${shot}.mp4`;
      if (present.has(candidate)) relative = candidate;
    } else {
      for (const extension of STILL_EXTENSIONS) {
        const candidate = `${SHOTS_DIR}/shot_${shot}_still${extension}`;
        if (present.has(candidate)) {
          relative = candidate;
          break;
        }
      }
    }
    const absolute = relative !== null ? ports.files.resolve(caseId, relative) : null;
    let retime = 1;
    if (clip && absolute !== null) {
      const clipSeconds = await ports.render.probe(absolute);
      if (clipSeconds !== null && clipSeconds > 0) retime = round(retimeFactor(clipSeconds, onScreen), 4);
    }
    out.push({ shot, block, kind, seconds: onScreen, retime, path: absolute, span, blockSeconds: blockLength });
  }
  return out;
}

/** Ratio of an on-screen duration to the clip file, or null when unknown. */
export async function clipRetime(
  ports: Ports,
  caseId: string,
  shot: string,
  onScreen: number,
): Promise<number | null> {
  const absolute = ports.files.resolve(caseId, `${SHOTS_DIR}/shot_${padShot(shot)}.mp4`);
  try {
    const clipSeconds = await ports.render.probe(absolute);
    if (clipSeconds === null || clipSeconds <= 0) return null;
    return round(retimeFactor(clipSeconds, onScreen), 4);
  } catch {
    return null;
  }
}

/** Pad a gaps list to one entry per narration block. */
export function normalizeGaps(gaps: unknown, blockCount: number): number[] {
  if (blockCount <= 0) return [...DEFAULT_GAPS];
  const parsed = Array.isArray(gaps)
    ? gaps.map((value) => Number(value)).filter((value) => Number.isFinite(value))
    : [];
  const list = parsed.length > 0 ? parsed.slice() : [...DEFAULT_GAPS];
  while (list.length < blockCount) list.push(0.8);
  return list.slice(0, blockCount);
}

// ----------------------------------------------------------------- operations

export interface OpResult {
  map: TimelineMap;
  changed: boolean;
  refused: boolean;
  messages: string[];
}

function cloneMap(map: TimelineMap): TimelineMap {
  return structuredClone(map);
}

function tuple(a: number, b: number): [number, number] {
  return [round(a, 4), round(b, 4)];
}

function siblings(map: TimelineMap, block: number): TimelineCut[] {
  return (map.cuts ?? [])
    .filter((cut) => Number(cut.block) === block)
    .sort((a, b) => toSpan(a.span)[0] - toSpan(b.span)[0]);
}

function refuse(map: TimelineMap, message: string): OpResult {
  return { map, changed: false, refused: true, messages: [message] };
}

/** `timeline span`: set a cut's span window, kind and/or origin. */
export function opSpan(
  map: TimelineMap,
  shot: unknown,
  patch: { span?: [number, number]; kind?: ShotKind; origin?: string | null },
): OpResult {
  const next = cloneMap(map);
  const targets = findCuts(next, shot);
  if (targets.length === 0) return refuse(next, `no cut with shot ${padShot(shot)} in the map`);
  const messages: string[] = [];
  for (const cut of targets) {
    const before = toSpan(cut.span);
    if (patch.span !== undefined) cut.span = tuple(patch.span[0], patch.span[1]);
    if (patch.kind !== undefined) cut.kind = patch.kind;
    if (patch.origin !== undefined) {
      const record = cut as unknown as Record<string, unknown>;
      if (patch.origin === null) {
        delete record['origin'];
        delete record['origem'];
      } else {
        record['origin'] = patch.origin;
        delete record['origem'];
      }
    }
    messages.push(
      `cut block ${cut.block} shot ${padShot(shot)}: ${before[0]} ${before[1]} -> ${toSpan(cut.span)[0]} ${toSpan(cut.span)[1]} (${cut.kind})`,
    );
  }
  return { map: next, changed: true, refused: false, messages };
}

/**
 * `timeline boundary`: give/take time from one cut by moving its end boundary and
 * the neighbour's start together. `request` is `+0.5` (more), `-0.5` (less) or a
 * bare number (target seconds on screen). A clip step that moves toward the
 * 0.5x-2x range is accepted even when the clip started outside it.
 */
export function opBoundary(
  map: TimelineMap,
  shot: unknown,
  request: string,
  blockSeconds: Record<number, number>,
  clipSeconds: number | null,
): OpResult {
  const next = cloneMap(map);
  const targets = findCuts(next, shot);
  if (targets.length === 0) return refuse(next, `no cut with shot ${padShot(shot)} in the map`);
  const raw = request.trim();
  const signed = raw.startsWith('+') || raw.startsWith('-');
  const value = Number(raw);
  if (!Number.isFinite(value)) return refuse(next, `could not read "${request}" as seconds`);
  const messages: string[] = [];
  let changed = false;
  for (const cut of targets) {
    const block = Number(cut.block);
    const blockLength = blockSeconds[block] ?? 0;
    if (!(blockLength > 0)) {
      messages.push(`shot ${padShot(shot)}: the block duration is unknown — not changed`);
      continue;
    }
    const list = siblings(next, block);
    const index = list.indexOf(cut);
    const previous = index > 0 ? list[index - 1] : null;
    const following = index >= 0 && index + 1 < list.length ? list[index + 1] : null;
    const span = toSpan(cut.span);
    const min = minFraction(blockLength);
    const before = (span[1] - span[0]) * blockLength;
    const wanted = Math.max(MIN_CUT_S, signed ? before + value : value);
    if (isClipKind(cut.kind) && clipSeconds !== null && clipSeconds > 0) {
      const retimeBefore = before / clipSeconds;
      const retimeAfter = wanted / clipSeconds;
      if (!withinRetimeRange(retimeAfter) && !movesTowardRange(retimeBefore, retimeAfter)) {
        messages.push(
          `shot ${padShot(shot)}: would be ${retimeAfter.toFixed(2)}x, outside ${RETIME_MIN}x-${RETIME_MAX}x and further from it — not changed`,
        );
        continue;
      }
      if (!withinRetimeRange(retimeAfter)) {
        messages.push(
          `shot ${padShot(shot)}: still outside the range (${retimeAfter.toFixed(2)}x) but this step moves toward it — accepted`,
        );
      }
    }
    let end = span[0] + Math.max(min, wanted / blockLength);
    const limit = following !== null ? toSpan(following.span)[1] - min : 1;
    end = Math.min(end, limit);
    end = Math.max(end, span[0] + min);
    end = round(end, 4);
    if (Math.abs(end - span[1]) < 1e-6) {
      messages.push(`shot ${padShot(shot)}: nothing to change (the ${MIN_CUT_S}s floor or the chapter limit)`);
      continue;
    }
    cut.span = tuple(span[0], end);
    if (following !== null) following.span = tuple(end, toSpan(following.span)[1]);
    changed = true;
    messages.push(
      `shot ${padShot(shot)}: ${fmtSeconds(before)} -> ${fmtSeconds((end - span[0]) * blockLength)} on screen (span [${end >= 0 ? round(span[0], 4).toFixed(3) : '0'},${end.toFixed(3)}])`,
    );
    if (previous !== null && Number(cut.block) === Number(previous.block)) {
      messages.push(`shot ${padShot(previous.shot)} keeps ${fmtSeconds((toSpan(previous.span)[1] - toSpan(previous.span)[0]) * blockLength)} on screen`);
    }
  }
  return { map: next, changed, refused: false, messages };
}

/** `timeline slide`: move a cut window without changing its length. */
export function opSlide(
  map: TimelineMap,
  shot: unknown,
  request: string,
  blockSeconds: Record<number, number>,
): OpResult {
  const next = cloneMap(map);
  const targets = findCuts(next, shot);
  if (targets.length === 0) return refuse(next, `no cut with shot ${padShot(shot)} in the map`);
  const raw = request.trim();
  const signed = raw.startsWith('+') || raw.startsWith('-');
  const value = Number(raw);
  if (!Number.isFinite(value)) return refuse(next, `could not read "${request}" as seconds`);
  const messages: string[] = [];
  let changed = false;
  for (const cut of targets) {
    const block = Number(cut.block);
    const blockLength = blockSeconds[block] ?? 0;
    if (!(blockLength > 0)) {
      messages.push(`shot ${padShot(shot)}: the block duration is unknown — not changed`);
      continue;
    }
    const list = siblings(next, block);
    const index = list.indexOf(cut);
    const previous = index > 0 ? list[index - 1] : null;
    const following = index >= 0 && index + 1 < list.length ? list[index + 1] : null;
    const span = toSpan(cut.span);
    const width = span[1] - span[0];
    const min = minFraction(blockLength);
    let start = signed ? span[0] + value / blockLength : value / blockLength;
    start = previous !== null ? Math.max(start, toSpan(previous.span)[0] + min) : Math.max(start, 0);
    start = following !== null ? Math.min(start, toSpan(following.span)[1] - min - width) : Math.min(start, 1 - width);
    start = round(Math.max(0, start), 4);
    if (Math.abs(start - span[0]) < 1e-6) {
      messages.push(`shot ${padShot(shot)}: nothing to change (the neighbour needs ${MIN_CUT_S}s on screen)`);
      continue;
    }
    const end = round(start + width, 4);
    cut.span = tuple(start, end);
    if (previous !== null) previous.span = tuple(toSpan(previous.span)[0], start);
    if (following !== null) following.span = tuple(end, toSpan(following.span)[1]);
    changed = true;
    messages.push(
      `shot ${padShot(shot)}: starts at ${(start * blockLength).toFixed(1)}s of the chapter (still ${fmtSeconds(width * blockLength)} on screen)`,
    );
  }
  return { map: next, changed, refused: false, messages };
}

/** `timeline snap`: move a cut's start to the nearest narration sentence change. */
export function opSnap(
  map: TimelineMap,
  shot: unknown,
  sentencesByBlock: Record<number, string[]>,
  blockSeconds: Record<number, number>,
): OpResult {
  const next = cloneMap(map);
  const targets = findCuts(next, shot);
  if (targets.length === 0) return refuse(next, `no cut with shot ${padShot(shot)} in the map`);
  const messages: string[] = [];
  let changed = false;
  for (const cut of targets) {
    const block = Number(cut.block);
    const sentences = sentencesByBlock[block] ?? [];
    if (sentences.length === 0) {
      messages.push(`shot ${padShot(shot)}: no narration for block ${block} — not snapped`);
      continue;
    }
    const counts = sentences.map((sentence) => sentence.split(/\s+/).filter(Boolean).length);
    const total = counts.reduce((sum, n) => sum + n, 0) || 1;
    const boundaries: number[] = [];
    let cursor = 0;
    for (const count of counts) {
      boundaries.push(cursor / total);
      cursor += count;
    }
    const span = toSpan(cut.span);
    let target = boundaries[0];
    let distance = Math.abs(boundaries[0] - span[0]);
    for (const boundary of boundaries) {
      const d = Math.abs(boundary - span[0]);
      if (d < distance) {
        target = boundary;
        distance = d;
      }
    }
    target = round(target, 4);
    if (Math.abs(target - span[0]) < 1e-6) {
      messages.push(`shot ${padShot(shot)}: already starts on a sentence change`);
      continue;
    }
    const blockLength = blockSeconds[block] ?? 0;
    const min = blockLength > 0 ? minFraction(blockLength) : 0.01;
    if (target >= span[1] - min) {
      messages.push(`shot ${padShot(shot)}: the nearest sentence change would leave under ${MIN_CUT_S}s — not snapped`);
      continue;
    }
    const list = siblings(next, block);
    const index = list.indexOf(cut);
    const previous = index > 0 ? list[index - 1] : null;
    if (previous !== null && target <= toSpan(previous.span)[0] + min) {
      messages.push(`shot ${padShot(shot)}: the previous shot would fall under ${MIN_CUT_S}s — not snapped`);
      continue;
    }
    cut.span = tuple(target, span[1]);
    if (previous !== null) previous.span = tuple(toSpan(previous.span)[0], target);
    changed = true;
    messages.push(`shot ${padShot(shot)}: starts on the sentence change at ${target.toFixed(3)} of the block`);
  }
  return { map: next, changed, refused: false, messages };
}

/** `timeline include`: bring a plan shot that left the map back into it. */
export function opInclude(
  map: TimelineMap,
  shot: unknown,
  planShot: { bloco?: number; span?: [number, number]; tipo?: string } | null,
): OpResult {
  const next = cloneMap(map);
  const wanted = padShot(shot);
  if (findCuts(next, shot).length > 0) return refuse(next, `shot ${wanted} is already in the map`);
  if (planShot === null) return refuse(next, `shot ${wanted} is not in the live plan — nothing to include`);
  const block = Number(planShot.bloco ?? 0);
  const span = toSpan(planShot.span);
  const cut: TimelineCut = {
    shot: wanted,
    block,
    span: tuple(span[0], span[1]),
    kind: planShot.tipo === 'video' ? CLIP_KIND : STILL_KIND,
  };
  const cuts = [...(next.cuts ?? []), cut].sort((a, b) => {
    const blockDelta = Number(a.block) - Number(b.block);
    return blockDelta !== 0 ? blockDelta : toSpan(a.span)[0] - toSpan(b.span)[0];
  });
  next.cuts = cuts;
  return { map: next, changed: true, refused: false, messages: [`shot ${wanted} is back in block ${block} (${cut.kind})`] };
}

/** `timeline remove`: take a cut out and hand its time to the neighbour. */
export function opRemove(map: TimelineMap, shot: unknown): OpResult {
  const next = cloneMap(map);
  const targets = findCuts(next, shot);
  if (targets.length === 0) return refuse(next, `shot ${padShot(shot)} is not in the map (nothing to do)`);
  const messages: string[] = [];
  for (const cut of targets) {
    const block = Number(cut.block);
    const span = toSpan(cut.span);
    const list = siblings(next, block);
    const index = list.indexOf(cut);
    const previous = index > 0 ? list[index - 1] : null;
    const following = index >= 0 && index + 1 < list.length ? list[index + 1] : null;
    next.cuts = (next.cuts ?? []).filter((candidate) => candidate !== cut);
    if (previous !== null) {
      previous.span = tuple(toSpan(previous.span)[0], span[1]);
      messages.push(`shot ${padShot(shot)} left block ${block}; shot ${padShot(previous.shot)} absorbs the time`);
    } else if (following !== null) {
      following.span = tuple(span[0], toSpan(following.span)[1]);
      messages.push(`shot ${padShot(shot)} left block ${block}; shot ${padShot(following.shot)} absorbs the time`);
    } else {
      messages.push(`shot ${padShot(shot)} left block ${block}; the block has no cuts left`);
    }
  }
  return { map: next, changed: true, refused: false, messages };
}

/** `timeline swap`: exchange the image (shot number and kind) of two cuts. */
export function opSwap(map: TimelineMap, shotA: unknown, shotB: unknown): OpResult {
  const next = cloneMap(map);
  const a = padShot(shotA);
  const b = padShot(shotB);
  if (a === b) return refuse(next, 'the same shot was given twice — pick two different numbers');
  const cutsA = findCuts(next, a);
  const cutsB = findCuts(next, b);
  if (cutsA.length === 0 || cutsB.length === 0) {
    const missing = [cutsA.length === 0 ? a : null, cutsB.length === 0 ? b : null].filter(Boolean);
    return refuse(next, `no cut with shot ${missing.join(', ')} in the map`);
  }
  const idA = cutsA.map((cut) => ({ shot: cut.shot, kind: cut.kind }));
  const idB = cutsB.map((cut) => ({ shot: cut.shot, kind: cut.kind }));
  const left = idB.length === 1 ? idB : cutsA.map(() => idB[0]);
  const right = idA.length === 1 ? idA : cutsB.map(() => idA[0]);
  cutsA.forEach((cut, i) => {
    cut.shot = left[i % left.length].shot;
    cut.kind = left[i % left.length].kind;
  });
  cutsB.forEach((cut, i) => {
    cut.shot = right[i % right.length].shot;
    cut.kind = right[i % right.length].kind;
  });
  return { map: next, changed: true, refused: false, messages: [`swapped shot ${a} and shot ${b}`] };
}

/** `timeline gaps`: write the pause list between blocks. */
export function opGaps(map: TimelineMap, gaps: number[], fill?: string): OpResult {
  const next = cloneMap(map);
  next.gaps = gaps.map((value) => round(value, 4));
  if (fill !== undefined) next.gaps_fill = fill;
  return { map: next, changed: true, refused: false, messages: [`gaps written (${gaps.length} entries for the narration blocks)`] };
}

/** `timeline endcard`: point the channel stamp at a shot and/or a duration. */
export function opEndcard(map: TimelineMap, patch: { shot?: string; seconds?: number }): OpResult {
  const next = cloneMap(map);
  const messages: string[] = [];
  if (patch.shot !== undefined) {
    next.end_card = padShot(patch.shot);
    messages.push(`channel stamp (end_card): shot ${next.end_card as string}`);
  }
  if (patch.seconds !== undefined) {
    next.end_card_seconds = round(patch.seconds, 4);
    messages.push(`channel stamp duration: ${fmtSeconds(patch.seconds)}`);
  }
  return { map: next, changed: messages.length > 0, refused: false, messages };
}
