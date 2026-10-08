/**
 * ruler.ts — the channel ruler. Pure numbers and span math, no I/O.
 *
 * These are the rules the Python tree already enforces (scripts/timeline.py,
 * scripts/ancorar_shots.py) and that the specs repeat: none of them may live in
 * an adapter.
 */

/** Narration seconds per visual (the channel ruler). */
export const SECONDS_PER_CUT = 8.5;

/** Below this a cut "blinks" on screen. */
export const MIN_CUT_S = 4.0;

/** Above this the image saturates. */
export const MAX_CUT_S = 12.0;

/** Channel design: 3 stills for every 1 clip. */
export const STILLS_PER_CLIP = 3;

/** One clip covers this many seconds of narration. */
export const CLIP_SECONDS = 6;

/** Default pause after each narration block. */
export const DEFAULT_GAPS = [2.0, 0.8, 0.8, 0.8, 0.8];

/** Retiming a fixed-length clip is normal between these factors. */
export const RETIME_MIN = 0.5;
export const RETIME_MAX = 2.0;

/** A block gap above this is reported by validation. */
export const MAX_BLOCK_GAP_S = 1.5;

/** Tolerance for a cut computed from a span fraction (4.0 can come out 3.9996). */
export const CUT_FLOOR_TOLERANCE = 0.002;

/** Real photo target ratio for the still importer. */
export const REAL_STILL_RATIO = { width: 16, height: 9 };

export type Span = [number, number];

/** A span inside a block is a fraction of that block (0..1), as in the case files. */
export function spanToSeconds(span: Span, blockSeconds: number): [number, number] {
  return [span[0] * blockSeconds, span[1] * blockSeconds];
}

export function spanDuration(span: Span, blockSeconds: number): number {
  return (span[1] - span[0]) * blockSeconds;
}

/** Retime factor when a fixed-length clip must fill `seconds` on screen. */
export function retimeFactor(clipSeconds: number, seconds: number): number {
  if (clipSeconds <= 0) return Number.POSITIVE_INFINITY;
  return seconds / clipSeconds;
}

/** True when the factor is inside the channel range (0.5x..2x). */
export function withinRetimeRange(factor: number): boolean {
  return factor >= RETIME_MIN && factor <= RETIME_MAX;
}

/**
 * A step that moves closer to the range is always accepted, even when the cut
 * starts outside it (spec: montagem-e-tempo, "clipe fora da faixa volta pela mão").
 */
export function movesTowardRange(before: number, after: number): boolean {
  const distance = (f: number) => (f < RETIME_MIN ? RETIME_MIN - f : f > RETIME_MAX ? f - RETIME_MAX : 0);
  return distance(after) < distance(before);
}

/** Format seconds the way the case files and reports do. */
export function seconds(value: number): string {
  return `${value.toFixed(2)}s`;
}

export function overlaps(a: Span, b: Span): boolean {
  return a[0] < b[1] && b[0] < a[1];
}

export function overlapSeconds(a: Span, b: Span): number {
  return Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
}
