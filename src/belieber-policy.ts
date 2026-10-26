import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

export type BelieberMode = 'reviewer' | 'worker';
export interface BelieberTask {
  task: string;
  mode: BelieberMode;
  /** Exact canonical workspace-relative files, not directory or glob grants. */
  files: string[];
}
export const REVIEWER_TOOLS = ['read', 'grep', 'find', 'ls'];
export const WORKER_TOOLS = [...REVIEWER_TOOLS, 'edit', 'write'];
export const MAX_TASK_FILES = 64;
const PROTECTED = new Set(['.git', '.pi', '.belieb', 'node_modules']);

export function effectiveMode(options: { mode?: BelieberMode; plan: boolean }): BelieberMode {
  return options.plan ? 'reviewer' : options.mode ?? 'reviewer';
}

/** Conservative collision key, including new names on case-insensitive filesystems. */
function ownershipKey(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

/**
 * Resolve every existing component, refusing symlinks (even in-tree aliases),
 * hardlinks and protected trees. Re-run immediately before each mutation.
 * This is a tool policy, not an OS sandbox or protection against external races.
 */
export function scopedFile(cwd: string, value: unknown, allowAbsolute = false): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096
    || /[\0\r\n*?\[\]{}]/.test(value) || value.startsWith('~') || value.startsWith('@')
    || (value.includes('\\') && (sep !== '\\' || !allowAbsolute))
    || (!allowAbsolute && /^[a-z]:/i.test(value))) {
    throw new Error('Use an exact workspace-relative file path (no globs or special prefixes).');
  }
  const root = realpathSync(cwd);
  if (isAbsolute(value) && !allowAbsolute) throw new Error('Assigned files must be workspace-relative.');
  const input = isAbsolute(value) ? relative(root, value) : value;
  const parts = input.split(/[\\/]/).filter(part => part && part !== '.');
  if (!parts.length || parts.includes('..')) throw new Error('File path must stay inside the workspace.');
  let current = root;
  for (const [index, part] of parts.entries()) {
    if (PROTECTED.has(part.toLowerCase())) throw new Error(`Protected path: ${part}.`);
    if (sep === '\\' && (/[. ]$/.test(part) || part.includes(':')
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
      throw new Error(`Unsupported Windows path component: ${part}.`);
    }
    current = join(current, part);
    let info;
    try { info = lstatSync(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error(`Worker paths cannot contain symlinks: ${value}.`);
    current = realpathSync(current); // normalize existing case aliases on macOS
    if (index === parts.length - 1) {
      if (!info.isFile()) throw new Error(`Expected a regular file, not a directory: ${value}.`);
      if (info.nlink > 1) throw new Error(`Worker paths cannot be hardlinked: ${value}.`);
    } else if (!info.isDirectory()) {
      throw new Error(`File path has a non-directory parent: ${value}.`);
    }
  }
  const result = relative(root, current);
  if (!result || result === '..' || result.startsWith(`..${sep}`) || isAbsolute(result)) {
    throw new Error('File path resolves outside the workspace.');
  }
  return result.split(sep).join('/');
}

/** Validate the entire batch before spawning anything, and assign one owner per file. */
export function prepareTasks(input: unknown, cwd: string, access: 'read' | 'write', plan: boolean): BelieberTask[] {
  if (!Array.isArray(input) || !input.length || input.length > 8) {
    throw new Error('Provide 1–8 non-empty tasks, each at most 16000 characters.');
  }
  const owned = new Map<string, number>();
  return input.map((entry, index) => {
    const spec = typeof entry === 'string' ? { task: entry, mode: 'reviewer' } : entry;
    if (!spec || typeof spec !== 'object' || typeof spec.task !== 'string'
      || !spec.task.trim() || spec.task.length > 16_000) {
      throw new Error('Provide 1–8 non-empty tasks, each at most 16000 characters.');
    }
    if (spec.mode !== 'reviewer' && spec.mode !== 'worker') {
      throw new Error(`Task ${index + 1} needs mode reviewer or worker.`);
    }
    const mode = effectiveMode({ mode: spec.mode, plan });
    if (mode === 'reviewer') return { task: spec.task, mode, files: [] };
    if (access !== 'write') throw new Error('Worker edits are disabled. Enable /beliebers access write first.');
    if (!Array.isArray(spec.files) || !spec.files.length || spec.files.length > MAX_TASK_FILES) {
      throw new Error(`Worker task ${index + 1} must list 1–${MAX_TASK_FILES} exact files.`);
    }
    const files: string[] = [];
    for (const raw of spec.files) {
      const file = scopedFile(cwd, raw);
      const key = ownershipKey(file);
      for (const [other, owner] of owned) {
        if (key === other || key.startsWith(other + '/') || other.startsWith(key + '/')) {
          throw new Error(`Overlapping files in tasks ${owner + 1} and ${index + 1}: ${file}. Assign each file to one worker.`);
        }
      }
      owned.set(key, index);
      files.push(file);
    }
    return { task: spec.task, mode, files };
  });
}

/** Return a canonical absolute path only when an actual mutation is authorized. */
export function approvedWrite(cwd: string, approved: ReadonlySet<string>, value: unknown): string {
  const file = scopedFile(cwd, value, true);
  const absolute = join(realpathSync(cwd), file);
  if (!approved.has(absolute)) throw new Error(`Blocked: ${String(value)} is not an assigned worker file.`);
  return absolute;
}
