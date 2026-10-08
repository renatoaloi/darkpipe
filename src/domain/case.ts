/**
 * case.ts — the rules for opening and inspecting a case. Pure functions: no
 * database, no vendor URL, no port. The `case` command wires these to ctx.ports.
 *
 * The id pattern, the vertical list, the folder layout, the templates a fresh
 * case receives and the research document shape are all defined here so the
 * command stays thin and the SQLite/files adapters stay rule-free.
 */

import type { CaseState, Vertical } from '../ports.ts';
import { CASE_STATES, VERTICALS } from '../ports.ts';
import { fail, localDate } from '../lib/util.ts';

/** `case_NNNN_slug`: exactly 4 digits, one underscore, a lowercase slug. */
export const CASE_ID_PATTERN = /^case_\d{4}_[a-z0-9_]+$/;

export function assertCaseId(id: string): string {
  if (!CASE_ID_PATTERN.test(id)) {
    fail(`case id "${id}" is invalid: it must match case_NNNN_slug (4 digits, e.g. case_0009_exemplo)`, {
      hint: 'examples that are accepted: case_0009_exemplo, case_0010_salish',
    });
  }
  return id;
}

export function assertTitle(title: string): string {
  if (title.trim().length === 0) {
    fail('a case needs an English title', {
      hint: 'darkpipe case new case_0009_exemplo "<English title>" --vertical dark_history',
    });
  }
  return title;
}

export function assertVertical(vertical: string): Vertical {
  if (!(VERTICALS as readonly string[]).includes(vertical)) {
    fail(`vertical "${vertical}" is invalid`, { hint: `choose one of: ${VERTICALS.join(', ')}` });
  }
  return vertical as Vertical;
}

export function assertState(state: string): CaseState {
  if (!(CASE_STATES as readonly string[]).includes(state)) {
    fail(`state "${state}" is invalid`, { hint: `choose one of: ${CASE_STATES.join(', ')}` });
  }
  return state as CaseState;
}

/** Directories a freshly opened case gets, relative to `cases/<id>/`. */
export const CASE_OPEN_DIRS = ['02_narration_parts', '04_shots/v0'];

/**
 * Template files a fresh case receives from `<repoRoot>/templates`. A shot plan
 * is DELIBERATELY absent: `03_shots.json` is created later, from the recorded
 * narration.
 */
export const CASE_OPEN_TEMPLATES = ['01_script.md', '02_narration_script.md', '07_meta.yaml'];

export interface TemplateVars {
  caseId: string;
  titulo: string;
  vertente: string;
}

/** Fill the `{CASE_ID}` / `{TITULO}` / `{VERTENTE}` placeholders, as novo_case.py did. */
export function renderTemplate(text: string, vars: TemplateVars): string {
  return text
    .replaceAll('{CASE_ID}', vars.caseId)
    .replaceAll('{TITULO}', vars.titulo)
    .replaceAll('{VERTENTE}', vars.vertente);
}

/** Each opened case sits at the end of the queue. */
export function nextPriority(max: number): number {
  return max + 1;
}

export function createdOn(now: Date = new Date()): string {
  return localDate(now);
}

// ------------------------------------------------------------------ research

/** What the text port must answer with when purpose is `research`. */
export interface ResearchStyle {
  combinacao: string;
  prefixo: string;
  sufixo: string;
  extra: string;
  variantes: string[];
}

export interface ResearchDocument {
  script_md: string;
  estilo: ResearchStyle;
}

/** The `05_estilo.json` shape, matching cases/case_0002_bodom/05_estilo.json. */
export interface CaseStyle {
  case: string;
  combinacao: string;
  prefixo: string;
  sufixo: string;
  extra: string;
  variantes: string[];
  passo: number;
  extra_manual: string;
  origem: string;
  [key: string]: unknown;
}

/** The prompt the text port receives on open. */
export function buildResearchPrompt(caseId: string, titulo: string, vertente: string): string {
  return [
    'You research a case for a dark-history documentary channel (unresolved cases).',
    'Answer with ONE valid JSON object and nothing else — no markdown fence, no comment.',
    '',
    'Produce exactly these keys:',
    '- "script_md": the episode guide script in markdown, in English, with concrete facts in telling',
    '  order. Use these sections, in this order: "## [0:00] COLD OPEN", "## [0:25] THE FILE",',
    '  "## [1:10] TIMELINE", "## [2:40] TIMELINE 2", "## [4:00] INVESTIGATION",',
    '  "## [6:30] THE UNRESOLVED", "## [8:40] CLOSING". Never invent a name, a date or a place.',
    '- "estilo": an object with "combinacao" (the look name), "prefixo" (the start of the image prompt,',
    '  with the correct decade), "sufixo" (the archival documentary look), "extra" (what is specific to',
    '  this case: region, climate, period objects, clothing, vehicles) and "variantes" (four framing',
    '  variants that rotate shot to shot).',
    '',
    'Channel rules the style must not break: no legible text in the image, no recognisable real people,',
    'no brand or logo.',
    '',
    '=== THE CASE ===',
    `id: ${caseId}`,
    `title: ${titulo}`,
    `vertical: ${vertente}`,
  ].join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

/**
 * Parse the text port's research answer. Tolerates a markdown fence or stray
 * prose around the object, the way the Python research did.
 */
export function parseResearch(text: string): ResearchDocument {
  const stripped = text.replace(/<think[\s\S]*?<\/think>/gi, ' ').trim();
  let candidate = stripped;
  if (!candidate.startsWith('{')) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) {
      fail('research answer did not contain a JSON object', {
        hint: 'the text provider must answer with {"script_md": ..., "estilo": {...}}',
      });
    }
    candidate = candidate.slice(start, end + 1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    fail(`research answer was not valid JSON: ${(error as Error).message}`);
  }
  if (!isRecord(parsed)) fail('research answer was not a JSON object');
  const script = parsed.script_md;
  if (typeof script !== 'string' || script.trim().length === 0) {
    fail('research answer had no "script_md" string', { hint: 'the guide script is required to open the case' });
  }
  const estiloRaw = parsed.estilo;
  if (!isRecord(estiloRaw)) {
    fail('research answer had no "estilo" object', { hint: 'prefix, suffix, extra and variants are required' });
  }
  const variantes = Array.isArray(estiloRaw.variantes)
    ? estiloRaw.variantes.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0)
    : [];
  return {
    script_md: script.trim(),
    estilo: {
      combinacao: asString(estiloRaw.combinacao),
      prefixo: asString(estiloRaw.prefixo),
      sufixo: asString(estiloRaw.sufixo),
      extra: asString(estiloRaw.extra),
      variantes,
    },
  };
}

/** The researched guide, with the operator-facing header nova_case's guide used. */
export function renderGuide(caseId: string, titulo: string, vertente: string, scriptMd: string, on: string = localDate()): string {
  const header = [
    `# ${caseId} — ${titulo || '(title to define)'}`,
    '',
    `**Vertical:** ${vertente || 'dark_history'} · **guide script researched on ${on}** ` +
      '(check the facts before recording the narration)',
    '',
  ].join('\n');
  const body = scriptMd.replace(/^#\s.*\n/, '').trim();
  return `${header}${body}\n`;
}

/** Build the `05_estilo.json` document from a successful research answer. */
export function styleFromResearch(caseId: string, document: ResearchDocument): CaseStyle {
  const estilo = document.estilo;
  return {
    case: caseId,
    combinacao: estilo.combinacao,
    prefixo: estilo.prefixo,
    sufixo: estilo.sufixo,
    extra: estilo.extra,
    variantes: estilo.variantes,
    passo: 1,
    extra_manual: '',
    origem: 'pesquisa',
  };
}
