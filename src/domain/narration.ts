/**
 * narration.ts — read the narration a case already has: the blocks in
 * `02_narration_script.md`, the audio in `02_narration_parts/`, and each block's
 * measured duration through the render port. Block numbering matches the case
 * files: blocks are the audio files in name order, indexed from 0. A `02_narration_parts`
 * entry may be `.mp3` (the legacy layout) or `.wav` (a disposable case).
 */

import crypto from 'node:crypto';
import type { Ports } from '../ports.ts';
import { normalizeWords, round } from '../lib/util.ts';

/** One narration block before its audio is measured. */
export interface NarrationBlockText {
  index: number;
  /** basename of the audio file, e.g. `01_cold_open.mp3`. */
  name: string;
  /** case-relative path, e.g. `02_narration_parts/01_cold_open.mp3`. */
  relative: string;
  text: string;
  sentences: string[];
  words: number;
  hash: string;
}

/** One narration block with its measured audio. */
export interface NarrationBlock extends NarrationBlockText {
  /** absolute path of the audio file. */
  path: string;
  seconds: number;
}

export interface NarrationTextRead {
  blocks: NarrationBlockText[];
  warnings: string[];
}

export interface NarrationRead {
  blocks: NarrationBlock[];
  warnings: string[];
}

const AUDIO_PATTERN = /(^|\/)02_narration_parts\/[^/]+\.(mp3|wav)$/i;
const SECTION_PATTERN =
  /^##\s*§?\s*(\d+)\s*[—\-–:]*\s*salvar como\s*`?([^`\s]+\.(?:mp3|wav))`?/i;
const SENTENCE_SPLIT = /(?<=[.!?…])\s+/;

export const NARRATION_SCRIPT = '02_narration_script.md';
export const NARRATION_DIR = '02_narration_parts';

function basename(value: string): string {
  const cut = value.replace(/\\/g, '/');
  const at = cut.lastIndexOf('/');
  return at >= 0 ? cut.slice(at + 1) : cut;
}

function stem(name: string): string {
  const match = /^(.+)\.[^.]+$/.exec(name);
  return match ? match[1] : name;
}

function normalizeRel(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Sentence splitter matching the legacy script: line by line, then at `.?!…`. */
export function segmentSentences(text: string): string[] {
  const out: string[] = [];
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    for (const piece of line.split(SENTENCE_SPLIT)) {
      const sentence = piece.trim();
      if (sentence.length > 0) out.push(sentence);
    }
  }
  return out;
}

/**
 * Sentence indexes touched by the fraction span [ini,fim] of a block, weighted
 * by word count. Ported from `ancorar_shots.py::frases_na_faixa`.
 */
export function sentenceIndexesInSpan(sentences: string[], ini: number, fim: number): number[] {
  const counts = sentences.map((sentence) => sentence.split(/\s+/).filter(Boolean).length);
  const total = counts.reduce((sum, n) => sum + n, 0) || 1;
  const from = ini * total;
  const to = Math.max(ini * total + 1, fim * total);
  const out: number[] = [];
  let cursor = 0;
  sentences.forEach((_sentence, index) => {
    const n = counts[index];
    if (cursor < to && cursor + n > from) out.push(index);
    cursor += n;
  });
  if (out.length === 0 && sentences.length > 0) {
    let best = 0;
    let distance = Number.POSITIVE_INFINITY;
    cursor = 0;
    sentences.forEach((_sentence, index) => {
      const d = Math.abs(cursor - from);
      if (d < distance) {
        best = index;
        distance = d;
      }
      cursor += counts[index];
    });
    return [best];
  }
  return out;
}

/** The anchor text for a span: the sentences on screen, trimmed to `limit`. */
export function anchorForSpan(
  sentences: string[],
  ini: number,
  fim: number,
  limit = 320,
): string {
  const indexes = sentenceIndexesInSpan(sentences, ini, fim);
  let text = indexes.map((i) => sentences[i]).join(' ').trim();
  if (text.length > limit) {
    const cut = text.slice(0, limit);
    const space = cut.lastIndexOf(' ');
    text = `${space > 0 ? cut.slice(0, space) : cut}…`;
  }
  return text;
}

/** Fraction of `a`'s content tokens that also appear in `b` (0..1). */
export function tokenCoverage(a: string, b: string): number {
  const left = new Set(words(a));
  const right = new Set(words(b));
  if (left.size === 0) return 1;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / left.size;
}

/** Coverage of an anchor against a block's current text (0..1). */
export function anchorCoverage(anchor: string, text: string): number {
  return tokenCoverage(anchor, text);
}

function words(value: string): string[] {
  const normalized = normalizeWords(value);
  return normalized.length > 0 ? normalized.split(' ') : [];
}

/**
 * Heuristic: does the prompt share any content word (first 5 chars) with the
 * block text? Empty prompts count as matching — the filter only flags shots whose
 * prompt is clearly about something else.
 */
export function promptMatchesBlock(prompt: string, blockText: string): boolean {
  const key = (word: string) => word.slice(0, 5);
  const p = new Set(words(prompt).filter((w) => w.length > 3).map(key));
  const a = new Set(words(blockText).filter((w) => w.length > 3).map(key));
  if (p.size === 0 || a.size === 0) return true;
  for (const word of p) if (a.has(word)) return true;
  return false;
}

/** `sha1:…`, the same shape the legacy lock file stores. */
export function narrationHash(text: string): string {
  const digest = crypto.createHash('sha1').update(normalizeWords(text), 'utf8').digest('hex');
  return `sha1:${digest.slice(0, 12)}`;
}

/** Block seconds keyed by block number. */
export function blockSecondsMap(read: { blocks: Array<{ index: number; seconds?: number }> }): Record<number, number> {
  const out: Record<number, number> = {};
  for (const block of read.blocks) out[block.index] = block.seconds ?? 0;
  return out;
}

function parseScript(markdown: string): Map<string, string> {
  const byStem = new Map<string, string>();
  const lines = markdown.split(/\r?\n/);
  let current: { key: string; lines: string[] } | null = null;
  const flush = () => {
    if (current !== null) byStem.set(current.key, current.lines.join('\n').trim());
  };
  for (const raw of lines) {
    const line = raw.trim();
    const match = SECTION_PATTERN.exec(line);
    if (match !== null) {
      flush();
      current = { key: stem(match[2]), lines: [] };
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
  return byStem;
}

/** Read the narration text per block; no audio is measured. */
export async function readNarrationText(ports: Ports, caseId: string): Promise<NarrationTextRead> {
  const warnings: string[] = [];
  const script = (await ports.files.readText(caseId, NARRATION_SCRIPT)) ?? '';
  if (script.trim().length === 0) {
    warnings.push(`${NARRATION_SCRIPT} is missing or empty — shot anchors will be empty`);
  }
  const texts = parseScript(script);
  const files = await ports.files.listFiles(caseId);
  const audio = files
    .map(normalizeRel)
    .filter((file) => AUDIO_PATTERN.test(file))
    .sort((a, b) => basename(a).localeCompare(basename(b)));
  const blocks: NarrationBlockText[] = audio.map((relative, index) => {
    const name = basename(relative);
    const text = texts.get(stem(name)) ?? '';
    if (text.length === 0) {
      warnings.push(`${name}: no section found in ${NARRATION_SCRIPT} — its anchors will be empty`);
    }
    const sentences = segmentSentences(text);
    const wordCount = sentences.reduce((sum, s) => sum + s.split(/\s+/).filter(Boolean).length, 0);
    return { index, name, relative, text, sentences, words: wordCount, hash: narrationHash(text) };
  });
  return { blocks, warnings };
}

/** Read the narration text and measure each block through the render port. */
export async function readNarration(ports: Ports, caseId: string): Promise<NarrationRead> {
  const base = await readNarrationText(ports, caseId);
  const warnings = [...base.warnings];
  const blocks: NarrationBlock[] = [];
  for (const block of base.blocks) {
    const absolute = ports.files.resolve(caseId, block.relative);
    let seconds = 0;
    try {
      seconds = (await ports.render.probe(absolute)) ?? 0;
    } catch {
      seconds = 0;
    }
    if (!(seconds > 0)) warnings.push(`${block.name}: could not measure the audio duration`);
    blocks.push({ ...block, path: absolute, seconds: round(seconds, 4) });
  }
  return { blocks, warnings };
}
