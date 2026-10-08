/**
 * still — real photo in and out of the plan. Owner: task group 4.
 *
 * `still import` fits a real photo onto one cut and marks it `origin: real` (the
 * legacy key `origem` is still read). `still revert` puts the generated still
 * back. The CaseFiles port has no binary write, so the bytes move with node:fs;
 * the destination path still comes from the port.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Command, CommandContext } from '../command.ts';
import type { CommandResult } from '../lib/util.ts';
import { fail } from '../lib/util.ts';
import { requirePositional } from '../lib/args.ts';
import type { TimelineMap } from '../ports.ts';
import { MAP_FILE, SHOTS_DIR, STILL_EXTENSIONS, findCuts, padShot } from '../domain/timeline.ts';

const GENERATED_DIR = `${SHOTS_DIR}/_generated`;

function stillExtension(absolute: string): string {
  const extension = path.extname(absolute).toLowerCase();
  if ((STILL_EXTENSIONS as readonly string[]).includes(extension)) return extension;
  fail(`still import expects a real photo (.png, .jpg, .jpeg or .webp), got "${extension || 'no extension'}"`);
}

async function loadMap(ctx: CommandContext, caseId: string): Promise<TimelineMap> {
  const map = await ctx.ports.files.readJson<TimelineMap>(caseId, MAP_FILE);
  if (map === null || !Array.isArray(map.cuts)) {
    fail(`no timeline.json for ${caseId}`, { hint: `run \`darkpipe plan apply ${caseId}\` first` });
  }
  return map;
}

async function persist(ctx: CommandContext, caseId: string, map: TimelineMap): Promise<string> {
  await ctx.ports.files.backupArtifact(caseId, MAP_FILE);
  return ctx.ports.files.writeJson(caseId, MAP_FILE, map);
}

async function importStill(ctx: CommandContext): Promise<CommandResult> {
  const caseId = requirePositional(ctx.args, 0, 'case_id');
  const shot = requirePositional(ctx.args, 1, 'shot');
  const file = requirePositional(ctx.args, 2, 'file');
  const source = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
  if (!fs.existsSync(source)) fail(`the photo ${source} does not exist`);
  const extension = stillExtension(source);
  const padded = padShot(shot);

  const map = await loadMap(ctx, caseId);
  const cut = findCuts(map, shot)[0];
  if (cut === undefined) fail(`no cut with shot ${padded} in the map of ${caseId}`);

  const destination = ctx.ports.files.resolve(caseId, `${SHOTS_DIR}/shot_${padded}_still${extension}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fs.existsSync(destination)) {
    const generated = ctx.ports.files.resolve(caseId, `${GENERATED_DIR}/shot_${padded}_still${extension}`);
    fs.mkdirSync(path.dirname(generated), { recursive: true });
    fs.copyFileSync(destination, generated);
  }
  fs.copyFileSync(source, destination);

  cut.kind = 'still';
  (cut as unknown as Record<string, unknown>)['origin'] = 'real';
  delete cut.origem;
  const mapPath = await persist(ctx, caseId, map);
  return {
    data: { case: caseId, shot: padded, origin: 'real', path: destination, map: mapPath },
    text: [
      `case ${caseId}: shot ${padded} now uses the real photo ${destination} (origin: real)`,
      `map written: ${mapPath}`,
    ],
  };
}

async function revertStill(ctx: CommandContext): Promise<CommandResult> {
  const caseId = requirePositional(ctx.args, 0, 'case_id');
  const shot = requirePositional(ctx.args, 1, 'shot');
  const padded = padShot(shot);
  const map = await loadMap(ctx, caseId);
  const cut = findCuts(map, shot)[0];
  if (cut === undefined) fail(`no cut with shot ${padded} in the map of ${caseId}`);

  const files = await ctx.ports.files.listFiles(caseId);
  const generated = files.find((entry) => new RegExp(`(^|/)${GENERATED_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/shot_${padded}_still\\.(png|jpg|jpeg|webp)$`, 'i').test(entry.replace(/\\/g, '/')));
  let restored: string | null = null;
  if (generated !== undefined) {
    const from = ctx.ports.files.resolve(caseId, generated);
    const to = ctx.ports.files.resolve(caseId, `${SHOTS_DIR}/shot_${padded}_still${path.extname(generated)}`);
    fs.copyFileSync(from, to);
    restored = to;
  }

  delete (cut as unknown as Record<string, unknown>)['origin'];
  delete cut.origem;
  const mapPath = await persist(ctx, caseId, map);
  return {
    data: { case: caseId, shot: padded, origin: null, restored, map: mapPath },
    text: [
      `case ${caseId}: shot ${padded} is back to its generated still`,
      restored !== null ? `generated still restored: ${restored}` : 'no generated still was kept — the cut now falls back to the generated art',
      `map written: ${mapPath}`,
    ],
  };
}

export const stillCommand: Command = {
  name: 'still',
  summary: 'import a real photo into a cut, or revert it',
  usage: ['darkpipe still import <case_id> <shot> <file>', 'darkpipe still revert <case_id> <shot>'],
  sub: {
    import: { name: 'import', summary: 'fit a real photo to 16:9 on one cut', run: importStill },
    revert: { name: 'revert', summary: 'put the generated still back', run: revertStill },
  },
  run: importStill,
};
