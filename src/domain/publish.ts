/**
 * publish.ts — build the YouTube publish pack from the finished case. The pack
 * is derived from the case files, never typed by hand: title, description, tags
 * (with the overflow dropped and named), chapters, language and thumbnail.
 *
 * A violent word at the start of the title, or in the first 2 seconds of the
 * narration, is reported and blocks `--execute`. The upload itself is the
 * publisher port's job; this module owns the channel rules.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { CaseMeta, Ports, PublishChapter, PublishPack, TimelineMap } from '../ports.ts';
import { fail, normalizeWords, round, truncate } from '../lib/util.ts';
import { readNarration, type NarrationBlock } from './narration.ts';
import { MAP_FILE, normalizeGaps } from './timeline.ts';

export const PACK_FILE = 'publicacao/PUBLICAR.json';
export const MANUAL_FILE = 'publicacao_manual.json';
export const META_FILE = '07_meta.yaml';
export const FINAL_SUFFIX = '_FINAL.mp4';

export const LIM_TITLE = 100;
export const LIM_DESCRIPTION = 5000;
export const LIM_TAGS = 500;
export const MIN_CHAPTER_S = 10;
export const MIN_CHAPTERS = 3;
export const THUMB_MIN_WIDTH = 640;
export const THUMB_MAX_BYTES = 2 * 1024 * 1024;
export const THUMB_RATIO = 16 / 9;
export const RATIO_TOLERANCE = 0.01;

export const DEFAULT_LANGUAGE = 'en';

/** Words that drop monetization when they open the title or the narration. */
export const VIOLENT_WORDS = [
  'kill', 'killed', 'killing', 'murder', 'murdered', 'murderer', 'dead', 'death',
  'deaths', 'died', 'dies', 'corpse', 'bodies', 'massacre', 'suicide', 'torture',
  'rape', 'gore', 'gruesome', 'blood', 'bloodbath', 'slaughter',
] as const;

export const DEFAULT_HASHTAGS = ['#darkhistory', '#unsolved', '#coldcase'];

const THUMB_CANDIDATES = [
  'publicacao/thumbnail_a.jpg',
  'publicacao/thumbnail_a.png',
  'publicacao/thumbnail.jpg',
  'publicacao/thumbnail.png',
  'publicacao/thumbnail_b.jpg',
  'publicacao/thumbnail_b.png',
];

const BASE_TAGS: Record<string, string[]> = {
  dark_history: ['dark history', 'unsolved mysteries', 'cold case files', 'disappearance documentary'],
  space_aviation: ['space history', 'aviation disasters', 'lost cosmonauts', 'declassified files'],
  engineering: ['engineering disasters', 'structural failure', 'industrial accident', 'forensic engineering'],
};

export interface ManualOverrides {
  titulo?: string;
  descricao?: string;
  gancho?: string;
  tags?: string | string[];
  tags_extra?: string[];
  hashtags?: string[];
  [key: string]: unknown;
}

export interface PublishBuild {
  pack: PublishPack;
  warnings: string[];
  /** Channel-rule failures that block `--execute`. */
  blocking: string[];
  tagsDropped: string[];
  chaptersOmitted: string | null;
  thumbnailPath: string | null;
  violence: string[];
}

function normalizeRel(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function humanizeStem(name: string): string {
  const stem = name.replace(/\.[^.]+$/, '');
  const cleaned = stem.replace(/^\d+[_-]?/, '').replace(/[_-]+/g, ' ').trim();
  const text = cleaned.length > 0 ? cleaned : stem;
  return text.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function firstWords(text: string, count: number): string {
  return text.trim().split(/\s+/).slice(0, count).join(' ');
}

function containsViolence(text: string): string[] {
  const haystack = ` ${normalizeWords(text)} `;
  return VIOLENT_WORDS.filter((word) => new RegExp(`\\b${word}\\b`).test(haystack));
}

/** PNG/JPEG pixel size, read from the header without any image library. */
export function imageSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length >= 24 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      const length = buffer.readUInt16BE(offset + 2);
      if (length <= 0) break;
      offset += 2 + length;
    }
  }
  return null;
}

interface ChapterDraft {
  title: string;
  startSeconds: number;
}

interface ChapterBuild {
  chapters: PublishChapter[];
  omitted: string | null;
  warnings: string[];
}

/** Chapters start at 00:00; a short block is merged, and an invalid list is dropped. */
export function buildChapters(blocks: NarrationBlock[], starts: number[], total: number): ChapterBuild {
  const warnings: string[] = [];
  if (blocks.length < MIN_CHAPTERS) {
    return { chapters: [], omitted: `only ${blocks.length} chapter(s); YouTube needs at least ${MIN_CHAPTERS}`, warnings };
  }
  let drafts: ChapterDraft[] = blocks.map((block, index) => ({
    title: humanizeStem(block.name),
    startSeconds: round(starts[index] ?? 0, 3),
  }));
  const durationOf = (index: number): number => {
    const end = index + 1 < drafts.length ? drafts[index + 1].startSeconds : total;
    return end - drafts[index].startSeconds;
  };
  let merged = 0;
  for (;;) {
    if (drafts.length < MIN_CHAPTERS) break;
    const short = drafts.findIndex((_draft, index) => durationOf(index) < MIN_CHAPTER_S);
    if (short === -1) break;
    if (short === 0) {
      if (drafts.length <= 1) break;
      drafts.splice(1, 1); // the first stays and covers both, so 00:00 is kept
    } else {
      drafts.splice(short, 1); // the previous chapter absorbs it
    }
    merged += 1;
  }
  if (merged > 0) warnings.push(`${merged} short chapter(s) merged into their neighbour`);
  if (drafts.length < MIN_CHAPTERS) {
    return { chapters: [], omitted: 'the chapters left after merging would be under three', warnings };
  }
  if (drafts[0].startSeconds !== 0) {
    return { chapters: [], omitted: 'the first chapter does not start at 00:00', warnings };
  }
  const bad = drafts.findIndex((_draft, index) => durationOf(index) < MIN_CHAPTER_S);
  if (bad !== -1) {
    return { chapters: [], omitted: `a chapter would be under ${MIN_CHAPTER_S}s`, warnings };
  }
  return { chapters: drafts.map((draft) => ({ title: draft.title, startSeconds: draft.startSeconds })), omitted: null, warnings };
}

function mmss(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

export function buildTags(title: string, vertente: string, manual: ManualOverrides | null): { tags: string[]; dropped: string[] } {
  const raw: string[] = [];
  const manualTags = manual?.tags;
  if (typeof manualTags === 'string') raw.push(...manualTags.split(','));
  else if (Array.isArray(manualTags)) raw.push(...manualTags.map((t) => String(t)));
  if (Array.isArray(manual?.tags_extra)) raw.push(...manual.tags_extra.map((t) => String(t)));
  const verticalTags = BASE_TAGS[vertente] ?? BASE_TAGS.dark_history;
  raw.push(...verticalTags);
  if (title.includes('|')) {
    const subject = title.split('|').pop()?.trim().toLowerCase();
    if (subject !== undefined && subject.length > 0) raw.push(subject);
  }
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const tag of raw) {
    const value = tag.replace(/\s+/g, ' ').trim().toLowerCase();
    if (value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    cleaned.push(value);
  }
  const count = (list: string[]) => list.reduce((sum, tag) => sum + tag.length, 0) + Math.max(0, list.length - 1);
  const dropped: string[] = [];
  while (count(cleaned) > LIM_TAGS && cleaned.length > 3) {
    dropped.unshift(cleaned.pop() as string);
  }
  return { tags: cleaned, dropped };
}

export function buildDescription(
  hook: string,
  chapters: PublishChapter[],
  manual: ManualOverrides | null,
): string {
  const parts: string[] = [];
  if (hook.length > 0) parts.push(hook);
  if (chapters.length > 0) parts.push(chapters.map((chapter) => `${mmss(chapter.startSeconds)} ${chapter.title}`).join('\n'));
  const hashtags = Array.isArray(manual?.hashtags) && manual!.hashtags!.length > 0 ? manual!.hashtags! : DEFAULT_HASHTAGS;
  parts.push(hashtags.join(' '));
  return truncate(parts.join('\n\n').trim(), LIM_DESCRIPTION);
}

function thumbnailFor(
  ports: Ports,
  caseId: string,
  present: string[],
): { relative: string | null; problems: string[]; warnings: string[] } {
  const relative = THUMB_CANDIDATES.find((candidate) => present.includes(candidate)) ?? null;
  if (relative === null) {
    return { relative: null, problems: ['no thumbnail found (looked for publicacao/thumbnail_a.jpg)'], warnings: [] };
  }
  const absolute = ports.files.resolve(caseId, relative);
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(absolute);
  } catch (error) {
    return { relative, problems: [`cannot read the thumbnail ${relative}: ${(error as Error).message}`], warnings: [] };
  }
  const size = imageSize(buffer);
  if (size === null) return { relative, problems: [`the thumbnail ${relative} is not a PNG or JPEG`], warnings: [] };
  const problems: string[] = [];
  if (size.width < THUMB_MIN_WIDTH) problems.push(`the thumbnail is ${size.width}px wide (minimum ${THUMB_MIN_WIDTH}px)`);
  if (Math.abs(size.width / size.height - THUMB_RATIO) > RATIO_TOLERANCE) {
    problems.push(`the thumbnail is ${size.width}x${size.height}, not 16:9`);
  }
  if (buffer.length > THUMB_MAX_BYTES) {
    problems.push(`the thumbnail is ${(buffer.length / 1024 / 1024).toFixed(2)} MB (maximum 2 MB)`);
  }
  return { relative, problems, warnings: [] };
}

/** Build the pack from the case files and run the channel-rule checks. */
export async function buildPack(ports: Ports, caseId: string): Promise<PublishBuild> {
  const meta = (await ports.files.readMeta(caseId)) as CaseMeta | null;
  const manual = (await ports.files.readJson<ManualOverrides>(caseId, MANUAL_FILE)) ?? null;
  const present = (await ports.files.listFiles(caseId)).map(normalizeRel);
  const narration = await readNarration(ports, caseId);
  if (narration.blocks.length === 0) {
    fail(`${caseId} has no narration audio in 02_narration_parts/`, { hint: `run \`darkpipe narrate ${caseId}\` first` });
  }
  const map = await ports.files.readJson<TimelineMap>(caseId, MAP_FILE);
  const gaps = normalizeGaps(map?.gaps, narration.blocks.length);
  const starts: number[] = [];
  let cursor = 0;
  narration.blocks.forEach((block, index) => {
    starts.push(round(cursor, 3));
    const gap = index < gaps.length ? gaps[index] : 0.8;
    cursor = round(cursor + block.seconds + gap, 3);
  });
  const total = round((starts[narration.blocks.length - 1] ?? 0) + narration.blocks[narration.blocks.length - 1].seconds, 3);

  const rawTitle = String(manual?.titulo ?? meta?.title_en ?? '').trim();
  if (rawTitle.length === 0) {
    fail(`${caseId} has no title (${META_FILE} title_en / ${MANUAL_FILE} titulo)`, {
      hint: 'set the title before publishing',
    });
  }
  const title = truncate(rawTitle, LIM_TITLE);

  const chapterBuild = buildChapters(narration.blocks, starts, total);
  const warnings: string[] = [...narration.warnings, ...chapterBuild.warnings];
  const chapterLines = chapterBuild.chapters.map((chapter) => `${mmss(chapter.startSeconds)} ${chapter.title}`).join('\n');
  const hook = (manual?.gancho ?? manual?.descricao ?? firstWords(narration.blocks[0].text, 40)).trim();
  const body = manual?.descricao !== undefined
    ? truncate(String(manual.descricao), LIM_DESCRIPTION)
    : truncate([hook, chapterLines].filter((part) => part.length > 0).join('\n\n'), LIM_DESCRIPTION);
  const description = buildDescription(body.length > 0 ? body : hook, chapterBuild.chapters, manual);

  const vertente = String(meta?.vertente ?? 'dark_history');
  const tagBuild = buildTags(title, vertente, manual);
  const thumb = thumbnailFor(ports, caseId, present);
  const finalRelative = `${caseId}${FINAL_SUFFIX}`;
  const hasFinal = present.includes(finalRelative);
  const videoPath = hasFinal ? ports.files.resolve(caseId, finalRelative) : null;

  const blocking: string[] = [];
  const titleViolence = containsViolence([firstWords(title, 2), title.slice(0, 34)].join(' '));
  const narrationViolence = containsViolence(firstWords(narration.blocks[0].text, 6));
  const violence = [...new Set([...titleViolence, ...narrationViolence])];
  if (violence.length > 0) {
    blocking.push(`violent word at the start of the title or in the first 2s of narration: ${violence.join(', ')} (it drops monetization)`);
  }
  if (thumb.problems.length > 0) blocking.push(...thumb.problems);
  if (!hasFinal) blocking.push(`no final video (${finalRelative}) in the case folder`);

  if (chapterBuild.omitted !== null) warnings.push(`chapters omitted: ${chapterBuild.omitted}`);
  if (tagBuild.dropped.length > 0) warnings.push(`tags over ${LIM_TAGS} characters dropped: ${tagBuild.dropped.join(', ')}`);

  const pack: PublishPack = {
    case: caseId,
    title,
    description,
    tags: tagBuild.tags,
    language: DEFAULT_LANGUAGE,
    chapters: chapterBuild.chapters,
    videoPath,
    thumbPath: thumb.relative !== null ? ports.files.resolve(caseId, thumb.relative) : null,
    videoId: null,
    warnings,
  };
  return {
    pack,
    warnings,
    blocking,
    tagsDropped: tagBuild.dropped,
    chaptersOmitted: chapterBuild.omitted,
    thumbnailPath: pack.thumbPath,
    violence,
  };
}

/** Write the pack into the case folder (`publicacao/PUBLICAR.json`). */
export async function writePack(ports: Ports, caseId: string, pack: PublishPack): Promise<string> {
  const dir = path.dirname(PACK_FILE);
  ports.files.resolve(caseId, dir); // ensures the folder exists
  return ports.files.writeJson(caseId, PACK_FILE, pack);
}
