/**
 * files-casefs.ts — the default CaseFiles: `cases/<case_id>/` on disk with the
 * current file names. Reads `origem`, writes `origin`.
 *
 * Writes are atomic (write a temp file in the same directory, then rename).
 * `backupArtifact` keeps timestamped copies under `.darkpipe/backups/`. Templates
 * live in `<repoRoot>/templates/<name>`; the `case` command renders them and
 * writes through this port.
 *
 * VERIFY (tasks 3.2, 4.3): template files are written on open; `backupArtifact`
 * keeps timestamped copies and `restoreArtifact` restores previous bytes.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { CaseFiles, CaseMeta } from '../ports.ts';
import type { AdapterSetting } from '../config.ts';
import type { AdapterContext, AdapterFactory } from './registry.ts';
import { casesDir as resolveCasesDir, darkpipeStateDir, ensureDir } from '../lib/paths.ts';
import { stamp } from '../lib/util.ts';

const BACKUP_STAMP = /^(?<name>.+)\.\d{8}-\d{6}\.bak$/;

interface LegacyShot {
  origin?: string;
  origem?: string;
}

function atomicWrite(target: string, text: string): void {
  ensureDir(path.dirname(target));
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temp, text, 'utf8');
  fs.renameSync(temp, target);
}

/** Flat `key: value` YAML for the 07_meta.yaml shape the pipeline uses. */
function parseMetaYaml(text: string): CaseMeta {
  const meta: CaseMeta = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (match === null) continue;
    const key = match[1];
    let value = match[2].trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }
  return meta;
}

function serializeMetaYaml(meta: CaseMeta): string {
  const order = ['id', 'title_en', 'vertente', 'language', 'status'];
  const keys = [...order.filter((key) => meta[key] !== undefined), ...Object.keys(meta).filter((key) => !order.includes(key))];
  const lines: string[] = [];
  for (const key of keys) {
    const value = meta[key];
    if (value === undefined || value === null) continue;
    const asString = String(value);
    const needsQuotes = /[:#'"]/.test(asString) || asString.length === 0;
    lines.push(`${key}: ${needsQuotes ? JSON.stringify(asString) : asString}`);
  }
  return `${lines.join('\n')}\n`;
}

function walk(relativeDir: string, base: string, out: string[]): void {
  for (const entry of fs.readdirSync(relativeDir, { withFileTypes: true })) {
    const absolute = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      walk(absolute, base, out);
    } else if (entry.isFile()) {
      out.push(path.relative(base, absolute));
    }
  }
}

function createFiles(context: AdapterContext, settings: AdapterSetting): CaseFiles {
  const casesRoot = resolveCasesDir(
    context.repoRoot,
    typeof settings.casesDir === 'string' ? settings.casesDir : context.config.casesDir,
  );
  const backupsRoot = path.join(darkpipeStateDir(context.repoRoot), 'backups');

  const caseDir = (caseId: string): string => {
    if (caseId.length === 0 || caseId.includes('/') || caseId.includes('\\') || caseId === '.' || caseId === '..') {
      throw new Error(`invalid case id "${caseId}"`);
    }
    return path.join(casesRoot, caseId);
  };

  const artifactPath = (caseId: string, name: string): string => path.join(caseDir(caseId), name);

  const backupDir = (caseId: string): string => path.join(backupsRoot, caseId);

  /** Backups mirror the artifact's relative name, so `04_shots/x.jpg` stays nested. */
  const backupName = (caseId: string, backupPath: string): string | null => {
    const relative = path.relative(backupDir(caseId), backupPath);
    if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    const match = BACKUP_STAMP.exec(relative.split(path.sep).join('/'));
    return match?.groups?.name ?? null;
  };

  /** Every backup file under the case's backup root, oldest first. */
  const allBackups = (caseId: string): string[] => {
    const root = backupDir(caseId);
    if (!fs.existsSync(root)) return [];
    const out: string[] = [];
    walk(root, root, out);
    return out
      .filter((relative) => BACKUP_STAMP.test(relative.split(path.sep).join('/')))
      .sort()
      .map((relative) => path.join(root, relative));
  };

  return {
    name: 'casefs',

    caseDir,

    async exists(caseId: string): Promise<boolean> {
      try {
        return fs.statSync(caseDir(caseId)).isDirectory();
      } catch {
        return false;
      }
    },

    async listCaseIds(): Promise<string[]> {
      if (!fs.existsSync(casesRoot)) return [];
      return fs
        .readdirSync(casesRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    },

    async readText(caseId: string, name: string): Promise<string | null> {
      const target = artifactPath(caseId, name);
      return fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    },

    async writeText(caseId: string, name: string, text: string): Promise<string> {
      const target = artifactPath(caseId, name);
      atomicWrite(target, text);
      return target;
    },

    async readJson<T = unknown>(caseId: string, name: string): Promise<T | null> {
      const raw = await this.readText(caseId, name);
      if (raw === null) return null;
      return JSON.parse(raw) as T;
    },

    async writeJson(caseId: string, name: string, value: unknown): Promise<string> {
      return this.writeText(caseId, name, `${JSON.stringify(value, null, 2)}\n`);
    },

    async readMeta(caseId: string): Promise<CaseMeta | null> {
      const raw = await this.readText(caseId, '07_meta.yaml');
      return raw === null ? null : parseMetaYaml(raw);
    },

    async writeMeta(caseId: string, meta: CaseMeta): Promise<string> {
      return this.writeText(caseId, '07_meta.yaml', serializeMetaYaml(meta));
    },

    async listFiles(caseId: string): Promise<string[]> {
      const dir = caseDir(caseId);
      if (!fs.existsSync(dir)) return [];
      const out: string[] = [];
      walk(dir, dir, out);
      return out.map((entry) => entry.split(path.sep).join('/')).sort();
    },

    async backupArtifact(caseId: string, name: string): Promise<string | null> {
      const source = artifactPath(caseId, name);
      if (!fs.existsSync(source)) return null;
      const target = path.join(backupDir(caseId), `${name}.${stamp()}.bak`);
      ensureDir(path.dirname(target));
      fs.copyFileSync(source, target);
      return target;
    },

    async listBackups(caseId: string, name: string): Promise<string[]> {
      return allBackups(caseId).filter((entry) => backupName(caseId, entry) === name);
    },

    async restoreArtifact(caseId: string, backupPath: string): Promise<string> {
      const name = backupName(caseId, backupPath);
      if (name === null) {
        throw new Error(`not a darkpipe backup path: ${backupPath}`);
      }
      if (!fs.existsSync(backupPath)) {
        throw new Error(`backup not found: ${backupPath}`);
      }
      const target = artifactPath(caseId, name);
      ensureDir(path.dirname(target));
      const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
      fs.copyFileSync(backupPath, temp);
      fs.renameSync(temp, target);
      return target;
    },

    resolve(caseId: string, relative: string): string {
      const target = path.join(caseDir(caseId), relative);
      ensureDir(path.dirname(target));
      return target;
    },

    readOrigin(shot: LegacyShot): string | null {
      const value = shot.origin ?? shot.origem;
      return typeof value === 'string' && value.length > 0 ? value : null;
    },
  };
}

export const caseFilesFactory: AdapterFactory<CaseFiles> = {
  name: 'casefs',
  port: 'files',
  create(context, settings): CaseFiles {
    return createFiles(context, settings);
  },
};
