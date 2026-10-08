/**
 * render.ts — the channel rules for `darkpipe render`: read the map, measure the
 * narration, validate the cuts BEFORE spending minutes on ffmpeg, and assemble
 * the ffmpeg argv the render port runs. The adapter owns no rule; this module
 * owns no ffmpeg.
 *
 * A chapter preview (`--blocks`) uses the SAME ruler as the full video: a cut is
 * a fraction of its block, so its on-screen seconds do not change with scope.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Ports, RenderResult, RenderSpec, TimelineMap } from '../ports.ts';
import { fail, round } from '../lib/util.ts';
import { checksum } from '../lib/media.ts';
import { blockSecondsMap, readNarration, type NarrationBlock } from './narration.ts';
import {
  MAP_FILE,
  collectValidatedCuts,
  isClipKind,
  normalizeGaps,
  padShot,
  toSpan,
  validateCuts,
  type ValidatedCut,
  type ValidationIssue,
  type ValidationReport,
} from './timeline.ts';

export const WIDTH = 1920;
export const HEIGHT = 1080;
export const FPS = 24;
export const SAMPLE_RATE = 44100;

export const FINAL_SUFFIX = '_FINAL.mp4';
export const PREVIEW_MARK = '_blocks_';

export interface RenderInspection {
  caseId: string;
  map: TimelineMap;
  narration: NarrationBlock[];
  blockSeconds: Record<number, number>;
  gaps: number[];
  cuts: ValidatedCut[];
  report: ValidationReport;
  /** The requested chapter scope, or null for the whole video. */
  scope: number[] | null;
}

export function finalRelativeName(caseId: string): string {
  return `${caseId}${FINAL_SUFFIX}`;
}

/** `<case>_blocks_02-02.mp4` — the first and last requested block, zero padded. */
export function previewRelativeName(caseId: string, scope: number[]): string {
  const first = Math.min(...scope);
  const last = Math.max(...scope);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${caseId}${PREVIEW_MARK}${pad(first)}-${pad(last)}.mp4`;
}

export function outputRelativeName(caseId: string, scope: number[] | null): string {
  return scope === null || scope.length === 0 ? finalRelativeName(caseId) : previewRelativeName(caseId, scope);
}

/** Read the map and the narration, resolve the files and run the shared validator. */
export async function inspectRender(
  ports: Ports,
  caseId: string,
  scope: number[] | null,
): Promise<RenderInspection> {
  const map = await ports.files.readJson<TimelineMap>(caseId, MAP_FILE);
  if (map === null || !Array.isArray(map.cuts)) {
    fail(`no cut map (${MAP_FILE}) for ${caseId}`, {
      hint: `run \`darkpipe plan propose ${caseId}\`, then \`darkpipe plan apply ${caseId}\``,
    });
  }
  const narration = await readNarration(ports, caseId);
  if (narration.blocks.length === 0) {
    fail(`${caseId} has no narration audio in 02_narration_parts/`, {
      hint: `run \`darkpipe narrate ${caseId}\` first`,
    });
  }
  const blockSeconds = blockSecondsMap(narration);
  const cuts = await collectValidatedCuts(ports, caseId, map, blockSeconds);
  const gaps = normalizeGaps(map.gaps, narration.blocks.length);
  const report = validateCuts(cuts, { blocks: scope });
  return { caseId, map, narration: narration.blocks, blockSeconds, gaps, cuts, report, scope };
}

function shortPath(absolute: string, caseId: string): string {
  const marker = `${path.sep}${caseId}${path.sep}`;
  const at = absolute.indexOf(marker);
  return at >= 0 ? absolute.slice(at + marker.length) : path.basename(absolute);
}

/** The readable map: one row per cut, its file and its on-screen seconds. */
export function mapLines(inspection: RenderInspection): string[] {
  const lines: string[] = [];
  const scope = inspection.scope;
  const where = scope === null || scope.length === 0 ? 'whole video' : `chapters ${scope.join(',')}`;
  lines.push(`case ${inspection.caseId} — ${inspection.cuts.length} cut(s) · ${where}`);
  lines.push('');
  lines.push('  #  block  shot  kind   span            seconds  file');
  inspection.cuts.forEach((cut, index) => {
    const span = cut.span ?? toSpan(undefined);
    const file = cut.path === null ? '<missing in 04_shots/>' : shortPath(cut.path, inspection.caseId);
    lines.push(
      `  ${String(index + 1).padStart(2)} ${String(cut.block).padStart(5)}  ${padShot(cut.shot).padStart(4)}  ` +
        `${cut.kind.padEnd(5)}  [${span[0].toFixed(3)},${span[1].toFixed(3)}]  ` +
        `${cut.seconds.toFixed(2).padStart(7)}s  ${file}`,
    );
  });
  lines.push('');
  inspection.narration.forEach((block) => {
    lines.push(`  block ${block.index}: ${block.name} — ${block.seconds.toFixed(2)}s`);
  });
  return lines;
}

function issueLine(issue: ValidationIssue): string {
  const shot = issue.shot === null ? '-' : padShot(issue.shot);
  return `  - block ${issue.block} shot ${shot}: ${issue.message}`;
}

/** The problem lines, blocking first, then warnings. */
export function issueLines(report: ValidationReport): string[] {
  const lines: string[] = [];
  for (const issue of report.blocking) lines.push(issueLine(issue));
  for (const issue of report.warnings) lines.push(`  ~ warning: ${issue.message}`);
  return lines;
}

function selectedCuts(inspection: RenderInspection): ValidatedCut[] {
  const scope = inspection.scope;
  return inspection.cuts
    .filter((cut) => cut.path !== null && (scope === null || scope.length === 0 || scope.includes(cut.block)))
    .sort((a, b) => (a.block - b.block) || (toSpan(a.span)[0] - toSpan(b.span)[0]));
}

/**
 * Build the ffmpeg argv the render port runs. Stills get a slow frame held for
 * their span; clips are retimed to fill it. Narration blocks are concatenated
 * with their gaps and the track is padded/trimmed to the video length so an
 * imperfect map still produces a valid file.
 */
export function buildRenderSpec(inspection: RenderInspection, outPath: string): RenderSpec {
  const selected = selectedCuts(inspection);
  if (selected.length === 0) {
    const scope = inspection.scope;
    const knownBlocks = [...new Set(inspection.cuts.map((cut) => cut.block))].sort((a, b) => a - b);
    const outside = scope === null || scope.length === 0 ? [] : scope.filter((block) => !knownBlocks.includes(block));
    if (outside.length > 0 && outside.length === scope?.length) {
      fail(`case ${inspection.caseId} has no chapter ${outside.join(', ')}`, {
        hint: `the map has chapter(s) ${knownBlocks.join(', ')}; run \`darkpipe timeline show ${inspection.caseId}\` to see it`,
      });
    }
    fail(`nothing to render in ${inspection.caseId}: no cut with a file inside the requested chapters`, {
      hint: 'generate the missing art with `darkpipe generate`, or pick another chapter with --blocks',
    });
  }
  const scopeBlocks = [...new Set(selected.map((cut) => cut.block))].sort((a, b) => a - b);
  const blockByIndex = new Map(inspection.narration.map((block) => [block.index, block]));
  const total = round(selected.reduce((sum, cut) => sum + cut.seconds, 0), 3);

  const inputs: string[] = [];
  selected.forEach((cut) => {
    if (isClipKind(cut.kind)) {
      inputs.push('-i', cut.path as string);
    } else {
      inputs.push('-loop', '1', '-framerate', String(FPS), '-t', cut.seconds.toFixed(3), '-i', cut.path as string);
    }
  });
  scopeBlocks.forEach((block) => {
    const record = blockByIndex.get(block);
    if (record !== undefined) inputs.push('-i', record.path);
  });

  const scale = `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
  const graph: string[] = [];
  selected.forEach((cut, index) => {
    const trim = `trim=duration=${cut.seconds.toFixed(3)}`;
    if (isClipKind(cut.kind)) {
      graph.push(`[${index}:v]${scale},fps=${FPS},setpts=${cut.retime.toFixed(4)}*PTS,${trim},setpts=PTS-STARTPTS[v${index}]`);
    } else {
      graph.push(`[${index}:v]${scale},fps=${FPS},${trim},setpts=PTS-STARTPTS[v${index}]`);
    }
  });
  const videoLabel = selected.length > 1 ? 'vout' : 'v0';
  if (selected.length > 1) {
    graph.push(`${selected.map((_cut, index) => `[v${index}]`).join('')}concat=n=${selected.length}:v=1:a=0[vout]`);
  }

  const audioLabels: string[] = [];
  scopeBlocks.forEach((block, index) => {
    const record = blockByIndex.get(block);
    const inputIndex = selected.length + index;
    const seconds = record?.seconds ?? inspection.blockSeconds[block] ?? 0;
    const isLast = block >= inspection.narration.length - 1;
    const gap = isLast ? 0 : (inspection.gaps[block] ?? 0.8);
    const chain = `[${inputIndex}:a]aresample=${SAMPLE_RATE},aformat=channel_layouts=mono`;
    if (gap > 0) {
      graph.push(`${chain},apad=pad_dur=${gap.toFixed(3)},atrim=0:${(seconds + gap).toFixed(3)}[a${index}]`);
    } else {
      graph.push(`${chain},atrim=0:${seconds.toFixed(3)}[a${index}]`);
    }
    audioLabels.push(`[a${index}]`);
  });

  const hasAudio = audioLabels.length > 0;
  if (hasAudio) {
    if (audioLabels.length > 1) {
      graph.push(`${audioLabels.join('')}concat=n=${audioLabels.length}:v=0:a=1[acat]`);
      graph.push(`[acat]apad,atrim=0:${total.toFixed(3)},aformat=channel_layouts=stereo[aout]`);
    } else {
      graph.push(`[a0]apad,atrim=0:${total.toFixed(3)},aformat=channel_layouts=stereo[aout]`);
    }
  }

  const args: string[] = ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', graph.join(';')];
  args.push('-map', `[${videoLabel}]`);
  if (hasAudio) args.push('-map', '[aout]');
  args.push('-t', total.toFixed(3), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-movflags', '+faststart');
  if (hasAudio) args.push('-c:a', 'aac', '-b:a', '128k');
  args.push(outPath);

  return {
    outPath,
    segments: selected.map((cut) => ({
      path: cut.path as string,
      seconds: cut.seconds,
      retime: cut.retime,
      kind: cut.kind,
    })),
    gaps: inspection.gaps,
    audioPath: scopeBlocks.length > 0 ? blockByIndex.get(scopeBlocks[0])?.path ?? null : null,
    args,
    filterGraph: graph.join(';'),
  };
}

export interface RenderOutcome {
  result: RenderResult;
  relative: string;
  absolute: string;
  seconds: number;
  segments: number;
}

/** Assemble the video through the render port and report the file it wrote. */
export async function renderTo(ports: Ports, inspection: RenderInspection, outPath: string): Promise<RenderOutcome> {
  const spec = buildRenderSpec(inspection, outPath);
  const result = await ports.render.render(spec);
  const seconds = await ports.render.probe(result.path);
  return {
    result,
    relative: path.basename(result.path),
    absolute: result.path,
    seconds: seconds ?? 0,
    segments: spec.segments.length,
  };
}

/** The absolute path of a case file, and whether it is already on disk. */
export async function caseFile(ports: Ports, caseId: string, relative: string): Promise<{ absolute: string; exists: boolean }> {
  const absolute = ports.files.resolve(caseId, relative);
  const present = await ports.files.listFiles(caseId);
  const normalized = present.map((file) => file.replace(/\\/g, '/'));
  return { absolute, exists: normalized.includes(relative) || fs.existsSync(absolute) };
}

/** Checksum of a file already on disk, for the render report. */
export function fileChecksum(absolute: string): string {
  return checksum(absolute);
}
