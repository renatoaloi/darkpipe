/**
 * ports.ts — the seven/eight ports the domain talks to. Domain code imports
 * these types only: never a driver, a vendor URL, ffmpeg, or the YouTube SDK.
 * Swapping an implementation is a config change.
 */

export type CaseState = 'backlog' | 'scripted' | 'rendered' | 'published';

export const CASE_STATES: CaseState[] = ['backlog', 'scripted', 'rendered', 'published'];

export const VERTICALS = ['dark_history', 'space_aviation', 'engineering', 'pilot', 'pilot_mix'] as const;
export type Vertical = (typeof VERTICALS)[number];

/** Row shape of the case index. Column names match the legacy kanban table. */
export interface CaseRow {
  id: string;
  titulo_en: string;
  vertente: string;
  estado: string;
  prioridade: number;
  data_criacao: string;
  notas: string | null;
}

/** Row shape of the shot index. */
export interface ShotRow {
  case_id: string;
  shot_num: number;
  tipo: string;
  descricao: string;
  prompt: string;
  duracao_s: number;
  origem: string | null;
}

export interface CaseRecordInput {
  id: string;
  titulo_en: string;
  vertente: string;
  estado: CaseState;
  prioridade: number;
  data_criacao: string;
  notas?: string | null;
}

export interface CasePatch {
  titulo_en?: string;
  vertente?: string;
  estado?: string;
  prioridade?: number;
  notas?: string | null;
}

/** Port 1: the case/shot index. */
export interface CaseStore {
  readonly name: string;
  /** Absolute path of the store, when the adapter has one. */
  readonly location: string | null;
  listCases(): Promise<CaseRow[]>;
  getCase(id: string): Promise<CaseRow | null>;
  createCase(record: CaseRecordInput): Promise<void>;
  updateCase(id: string, patch: CasePatch): Promise<void>;
  /** Current maximum priority, or 0 when the store is empty. */
  maxPriority(): Promise<number>;
  listShots(caseId: string): Promise<ShotRow[]>;
  replaceShots(caseId: string, shots: ShotRow[]): Promise<void>;
  removeShots(caseId: string, shotNums: number[]): Promise<void>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------- vocabularies

/**
 * How a cut is filled. `video` is the legacy on-disk spelling of a clip: the case
 * files (timeline.json) and the renderer use it, so both spellings are legal.
 */
export type ShotKind = 'still' | 'clip' | 'video';

/** One cut in the live map (`timeline.json`). Selection spans are block fractions. */
export interface TimelineCut {
  shot: string;
  block: number;
  span: [number, number];
  kind: ShotKind;
  origem?: string;
  /** Legacy key the files adapter must still read. */
  origem_legado?: string;
}

export interface TimelineMap {
  case_id: string;
  gaps: number[];
  gaps_fill?: string;
  grammar?: string;
  cuts: TimelineCut[];
  [key: string]: unknown;
}

/** One visual in the plan (`03_shots.json`). */
export interface PlanShot {
  shot_num: number;
  tipo: 'image' | 'video';
  duracao_s: number;
  bloco: number;
  span: [number, number];
  prompt: string;
  ancora?: string;
  origem?: string;
  descricao?: string;
  [key: string]: unknown;
}

export interface ShotPlan {
  case_id: string;
  titulo?: string;
  shots: PlanShot[];
  [key: string]: unknown;
}

export interface CaseMeta {
  id?: string;
  title_en?: string;
  vertente?: string;
  language?: string;
  status?: string;
  [key: string]: unknown;
}

/** Port 2: the case folder. `origem` and `origin` are both read; writes use `origin`. */
export interface CaseFiles {
  readonly name: string;
  caseDir(caseId: string): string;
  exists(caseId: string): Promise<boolean>;
  listCaseIds(): Promise<string[]>;
  readText(caseId: string, name: string): Promise<string | null>;
  writeText(caseId: string, name: string, text: string): Promise<string>;
  readJson<T = unknown>(caseId: string, name: string): Promise<T | null>;
  writeJson(caseId: string, name: string, value: unknown): Promise<string>;
  readMeta(caseId: string): Promise<CaseMeta | null>;
  writeMeta(caseId: string, meta: CaseMeta): Promise<string>;
  /** Relative paths of everything in the case folder, sorted. */
  listFiles(caseId: string): Promise<string[]>;
  /** Copy the current file aside under a timestamped name; null when it does not exist. */
  backupArtifact(caseId: string, name: string): Promise<string | null>;
  /** Timestamped backups of one artifact, oldest first. */
  listBackups(caseId: string, name: string): Promise<string[]>;
  /** Byte-for-byte restore from a backup path returned by this port. */
  restoreArtifact(caseId: string, backupPath: string): Promise<string>;
  /** Absolute path of a case-relative path, created if needed. */
  resolve(caseId: string, relative: string): string;
  /** `origin` (new key) with `origem` (legacy key) as fallback. */
  readOrigin(shot: { origin?: string; origem?: string }): string | null;
}

// ---------------------------------------------------------------- providers

export interface ProviderCallResult {
  /** Absolute path of the artifact the provider wrote. */
  path: string | null;
  /** USD charged for this attempt, even when the attempt failed after being billed. */
  usd: number;
  provider: string;
  model: string;
  latencyMs: number | null;
  jobId: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  /** Raw response kept for fixtures and diagnostics. */
  raw?: unknown;
}

export interface StillRequest {
  caseId: string;
  shot: number | null;
  prompt: string;
  outPath: string;
  width?: number;
  height?: number;
  model?: string;
}

export interface ClipRequest {
  caseId: string;
  shot: number | null;
  prompt: string;
  outPath: string;
  seconds?: number;
  model?: string;
}

/** Port 3: paid image/video generation. */
export interface MediaProvider {
  readonly name: string;
  readonly provider: string;
  still(request: StillRequest): Promise<ProviderCallResult>;
  clip(request: ClipRequest): Promise<ProviderCallResult>;
}

export interface SpeechRequest {
  caseId: string;
  block: number | null;
  text: string;
  outPath: string;
  voice?: string;
  model?: string;
}

/** Port 4: narration speech synthesis. */
export interface SpeechProvider {
  readonly name: string;
  readonly provider: string;
  synthesize(request: SpeechRequest): Promise<ProviderCallResult>;
}

export interface TextRequest {
  caseId: string;
  purpose: 'research' | 'plan' | 'prompts' | 'style' | 'posts' | 'shorts' | 'compete';
  prompt: string;
  system?: string;
  model?: string;
  /** Ask the adapter for JSON and return the parsed value when it can. */
  json?: boolean;
}

export interface TextResult extends ProviderCallResult {
  text: string;
}

/** Port 5: paid text generation. */
export interface TextProvider {
  readonly name: string;
  readonly provider: string;
  complete(request: TextRequest): Promise<TextResult>;
}

export interface RenderSpec {
  /** Absolute path of the file to write. */
  outPath: string;
  /** Inputs in order, each with its absolute path and the seconds it covers. */
  segments: Array<{ path: string; seconds: number; retime: number; kind: ShotKind }>;
  gaps: number[];
  audioPath: string | null;
  /** Command line the adapter must run, already assembled by domain code. */
  args: string[];
  filterGraph?: string;
}

export interface RenderResult {
  path: string;
  checksum: string;
  bytes: number;
}

/** Port 6: ffmpeg/ffprobe on PATH. Runs the graph it is given; it owns no rules. */
export interface Renderer {
  readonly name: string;
  /** Duration in seconds, or null when the file cannot be probed. */
  probe(path: string): Promise<number | null>;
  probeOrFail(path: string): Promise<number>;
  render(spec: RenderSpec): Promise<RenderResult>;
  available(): Promise<boolean>;
}

/** One spend/generation attempt. Field names are the cost-events contract. */
export interface CostEvent {
  at: string;
  case: string | null;
  shot: number | null;
  kind: string;
  provider: string;
  model: string;
  usd: number;
  tokens_in: number | null;
  tokens_out: number | null;
  latency_ms: number | null;
  job_id: string | null;
  status: 'ok' | 'error';
  [key: string]: unknown;
}

/** Port 7: append-only ledger. */
export interface Ledger {
  readonly name: string;
  readonly location: string | null;
  append(event: CostEvent): Promise<void>;
  read(): Promise<CostEvent[]>;
  /** Byte size, used by tests to prove a dry-run wrote nothing. */
  size(): Promise<number>;
}

export interface PublishChapter {
  title: string;
  startSeconds: number;
}

export interface PublishPack {
  case: string;
  title: string;
  description: string;
  tags: string[];
  language: string;
  chapters: PublishChapter[];
  videoPath: string | null;
  thumbPath: string | null;
  videoId?: string | null;
  warnings?: string[];
  [key: string]: unknown;
}

export interface CredentialReport {
  ok: boolean;
  missing: string[];
  /** Names only. Values never leave the adapter. */
  present: string[];
}

/** Port 8: YouTube Data API v3. */
export interface Publisher {
  readonly name: string;
  readonly provider: string;
  credentials(): CredentialReport;
  upload(pack: PublishPack): Promise<{ videoId: string; status: 'ok' }>;
}

export interface Ports {
  store: CaseStore;
  files: CaseFiles;
  media: MediaProvider;
  speech: SpeechProvider;
  text: TextProvider;
  render: Renderer;
  ledger: Ledger;
  publisher: Publisher;
}

export type PortName = keyof Ports;
