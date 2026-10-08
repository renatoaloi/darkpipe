/**
 * case — open, list, inspect and move cases. Owner: task group 3.
 *
 * The command is thin: rules live in `src/domain/case.ts`, storage goes through
 * `ctx.ports.store`, files through `ctx.ports.files` and the research call
 * through `ctx.ports.text` + `ctx.ports.ledger` (`metered()`). No adapter is
 * imported here.
 *
 * VERIFY (tasks 3.2, 3.3):
 * - `exemplo` and `case_9_exemplo` are refused with no folder and no store row;
 * - a valid id creates the template files plus `02_narration_parts/` and
 *   `04_shots/v0/` with no `03_shots.json`;
 * - research writes `01_script.md` (researched, not the template) and
 *   `05_estilo.json`, and appends exactly one ledger event;
 * - `--no-research` warns in English and writes no ledger event.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Command, CommandContext } from '../command.ts';
import type { CasePatch, CaseRow } from '../ports.ts';
import { DarkpipeError, type CommandResult } from '../lib/util.ts';
import { flagValue, flagSet, requirePositional } from '../lib/args.ts';
import { metered } from '../spend.ts';
import {
  assertCaseId,
  assertState,
  assertTitle,
  assertVertical,
  buildResearchPrompt,
  CASE_OPEN_DIRS,
  CASE_OPEN_TEMPLATES,
  createdOn,
  nextPriority,
  parseResearch,
  renderGuide,
  renderTemplate,
  styleFromResearch,
} from '../domain/case.ts';

/** One line the operator can paste to retry a failed or skipped research. */
function rerunCommand(caseId: string, title: string, vertente: string): string {
  const quoted = title.replaceAll('"', '\\"');
  return `darkpipe case new ${caseId} "${quoted}" --vertical ${vertente}`;
}

/** Research was skipped on purpose: tell the operator how to run it later. */
function noResearchHint(caseId: string, title: string, vertente: string): string {
  return `the case and its template files were kept; research it later with: ${rerunCommand(caseId, title, vertente)}`;
}

/** Research failed: the case exists, so running the same command again fills it in. */
function reRunHint(caseId: string, title: string, vertente: string): string {
  return `the case and its template files were kept; run it again with: ${rerunCommand(caseId, title, vertente)}`;
}

async function openCase(ctx: CommandContext): Promise<CommandResult> {
  const id = requirePositional(ctx.args, 0, 'case id');
  const title = requirePositional(ctx.args, 1, 'English title');
  // Validation happens before any write: a refused id creates nothing.
  assertCaseId(id);
  assertTitle(title);
  const vertical = assertVertical(flagValue(ctx.args, '--vertical') ?? 'dark_history');

  const files = ctx.ports.files;
  const dir = files.caseDir(id);
  fs.mkdirSync(dir, { recursive: true });
  for (const sub of CASE_OPEN_DIRS) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }

  // Template files. An existing file is never overwritten: opening adds what is
  // missing and preserves what is already there. No 03_shots.json is ever made.
  const templatesDir = path.join(ctx.repoRoot, 'templates');
  const created: string[] = [];
  for (const name of CASE_OPEN_TEMPLATES) {
    const destination = path.join(dir, name);
    if (fs.existsSync(destination)) continue;
    const templatePath = path.join(templatesDir, name);
    if (!fs.existsSync(templatePath)) {
      ctx.sink.warn(`template ${name} not found at ${templatePath}; skipped`);
      continue;
    }
    const body = renderTemplate(fs.readFileSync(templatePath, 'utf8'), { caseId: id, titulo: title, vertente: vertical });
    await files.writeText(id, name, body);
    created.push(name);
  }

  // Store row: a recreated case behaves as a new project (new priority, today).
  const priority = nextPriority(await ctx.ports.store.maxPriority());
  await ctx.ports.store.createCase({
    id,
    titulo_en: title,
    vertente: vertical,
    estado: 'backlog',
    prioridade: priority,
    data_criacao: createdOn(),
    notas: '',
  });

  const skipResearch = flagSet(ctx.args, '--no-research') || flagSet(ctx.args, '--dry-run');
  let researched = false;
  if (skipResearch) {
    ctx.sink.warn(`case ${id} was created without context: no research ran. ${noResearchHint(id, title, vertical)}`);
  } else {
    const prompt = buildResearchPrompt(id, title, vertical);
    let text: string;
    try {
      const result = await metered(ctx.ports.ledger, { caseId: id, shot: null, kind: 'research' }, () =>
        ctx.ports.text.complete({ caseId: id, purpose: 'research', json: true, prompt }),
      );
      text = result.text;
    } catch (error) {
      throw new DarkpipeError(`research failed for ${id}: ${(error as Error).message}`, {
        hint: reRunHint(id, title, vertical),
      });
    }
    let document;
    try {
      document = parseResearch(text);
    } catch (error) {
      throw new DarkpipeError(`research for ${id} returned an unusable document: ${(error as Error).message}`, {
        hint: reRunHint(id, title, vertical),
      });
    }
    await files.writeText(id, '01_script.md', renderGuide(id, title, vertical, document.script_md));
    await files.writeJson(id, '05_estilo.json', styleFromResearch(id, document));
    researched = true;
  }

  const row = await ctx.ports.store.getCase(id);
  const data = {
    case: row,
    path: dir,
    created,
    priority,
    researched,
  };
  const text = [
    `case ${id}: opened at ${dir}`,
    `  title     ${title}`,
    `  vertical  ${vertical}`,
    `  state     backlog`,
    `  priority  ${priority}`,
    ...(created.length > 0 ? [`  templates ${created.join(', ')}`] : []),
    researched
      ? '  research  01_script.md + 05_estilo.json written'
      : '  research  skipped (--no-research)',
  ];
  return { data, text };
}

async function listCases(ctx: CommandContext): Promise<CommandResult> {
  const wanted = flagValue(ctx.args, '--state');
  const all = await ctx.ports.store.listCases();
  const rows = wanted === undefined ? all : all.filter((row) => row.estado === wanted);
  const data = { cases: rows, state: wanted ?? null };
  const text = rows.map(
    (row) => `${String(row.prioridade).padStart(4)}  ${row.id.padEnd(28)} ${row.estado.padEnd(10)} ${row.titulo_en ?? ''}`,
  );
  return { data, text: text.length > 0 ? text : ['(no cases)'] };
}

async function showCase(ctx: CommandContext): Promise<CommandResult> {
  const id = requirePositional(ctx.args, 0, 'case id');
  const row = await ctx.ports.store.getCase(id);
  if (row === null) {
    throw new DarkpipeError(`case ${id} is not registered`, { hint: 'run `darkpipe case list` to see the registered cases' });
  }
  const dir = ctx.ports.files.caseDir(id);
  const names = await ctx.ports.files.listFiles(id);
  const files = names.map((name) => path.join(dir, name));
  const data = { case: row, path: dir, files };
  const text = [
    `${row.id} — ${row.titulo_en} [${row.estado}] vertical ${row.vertente} priority ${row.prioridade}`,
    `folder: ${dir}`,
    ...files,
  ];
  return { data, text };
}

async function statusCase(ctx: CommandContext): Promise<CommandResult> {
  const id = requirePositional(ctx.args, 0, 'case id');
  const set = flagValue(ctx.args, '--set');
  const notes = flagValue(ctx.args, '--notes');
  const row = await ctx.ports.store.getCase(id);
  if (row === null) {
    throw new DarkpipeError(`case ${id} is not registered`, { hint: 'run `darkpipe case list` to see the registered cases' });
  }
  const patch: CasePatch = {};
  if (set !== undefined) patch.estado = assertState(set);
  if (notes !== undefined) patch.notas = notes;
  if (Object.keys(patch).length > 0) {
    await ctx.ports.store.updateCase(id, patch);
  }
  const updated: CaseRow | null = await ctx.ports.store.getCase(id);
  const data = { case: updated, changed: Object.keys(patch) };
  const text = [`${id}: state ${updated?.estado ?? row.estado}`];
  if (notes !== undefined) text.push(`  notes ${notes}`);
  return { data, text };
}

const NEEDS_SUBCOMMAND = new DarkpipeError('case needs a subcommand: list, new, show or status', {
  hint: 'darkpipe case list | new | show | status',
});

export const caseCommand: Command = {
  name: 'case',
  summary: 'open, list and inspect cases',
  usage: [
    'darkpipe case new <case_id> "<English title>" [--vertical <v>] [--no-research]',
    'darkpipe case list [--state <state>]',
    'darkpipe case show <case_id>',
    'darkpipe case status <case_id> [--set <state>] [--notes "<text>"]',
  ],
  sub: {
    new: { name: 'new', summary: 'open a case from the templates and research it', run: openCase },
    list: { name: 'list', summary: 'list cases in queue order', run: listCases },
    show: { name: 'show', summary: 'show one case and its files', run: showCase },
    status: { name: 'status', summary: 'read or set the case state', run: statusCase },
  },
  async run() {
    throw NEEDS_SUBCOMMAND;
  },
};
