import {
  existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

interface Snapshot {
  path: string;
  tool: string;
  /** File content before the first change in this group; null when it did not exist. */
  before: Buffer | null;
  /** File content after the last successful change; null until finalized. */
  after: Buffer | null;
  finalized: boolean;
  /** Tool calls that share this snapshot, so a failed call can be dropped alone. */
  calls: Set<string>;
  bytes: number;
}

/** One undo unit: every file the agent touched between two user prompts. */
interface Group {
  id: number;
  snapshots: Snapshot[];
}

function groupBytes(group: Group): number {
  return group.snapshots.reduce((total, snapshot) => total + snapshot.bytes, 0);
}

export interface UndoResult {
  /** Files written back to their previous content. */
  restored: string[];
  /** Files deleted because the agent created them. */
  removed: string[];
  /** Files whose redo image was unavailable and is therefore skipped. */
  skipped: number;
}

/**
 * Session-local history of files before and after `edit`/`write`, grouped per
 * agent run so one `/undo` reverts a whole turn. Deliberately small: it protects
 * against a bad turn, not against arbitrary bash commands or a crashed process.
 */
export class Checkpoints {
  private groups: Group[] = [];
  private redoStack: Group[] = [];
  private totalBytes = 0;

  constructor(
    private readonly maxGroups = 30,
    private readonly maxFileBytes = 512 * 1024,
    private readonly maxTotalBytes = 8 * 1024 * 1024,
  ) {}

  /** Snapshot a file before a tool touches it; repeated calls reuse the group's image. */
  capture(toolCallId: string, tool: string, filePath: string, cwd: string, groupId = 0): void {
    const absolute = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
    const group = this.group(groupId);
    const existing = group.snapshots.find(snapshot => snapshot.path === absolute);
    if (existing) {
      existing.calls.add(toolCallId);
      return;
    }
    if (group.snapshots.some(snapshot => snapshot.calls.has(toolCallId))) return;

    let before: Buffer | null = null;
    if (existsSync(absolute)) {
      try {
        const stat = statSync(absolute);
        if (!stat.isFile() || stat.size > this.maxFileBytes) return;
        before = readFileSync(absolute);
      } catch {
        return;
      }
    }

    // New work invalidates a pending redo chain.
    this.redoStack.length = 0;
    const snapshot: Snapshot = {
      path: absolute,
      tool,
      before,
      after: null,
      finalized: false,
      calls: new Set([toolCallId]),
      bytes: before?.length ?? 0,
    };
    group.snapshots.push(snapshot);
    this.totalBytes += snapshot.bytes;
    this.prune();
  }

  /** Record the post-change content so `/redo` can replay the turn. */
  finalize(toolCallId: string): void {
    const found = this.locate(toolCallId);
    if (!found) return;
    const { snapshot } = found;
    try {
      const stat = statSync(snapshot.path);
      if (!stat.isFile() || stat.size > this.maxFileBytes) return;
      const after = readFileSync(snapshot.path);
      this.totalBytes += after.length - (snapshot.after?.length ?? 0);
      snapshot.after = after;
      snapshot.bytes = (snapshot.before?.length ?? 0) + after.length;
      snapshot.finalized = true;
    } catch {
      // The file is gone or unreadable; keep the pre-image so undo still works.
    }
  }

  /** Drop a call that failed, along with its snapshot if nobody else needs it. */
  discard(toolCallId: string): void {
    const found = this.locate(toolCallId);
    if (!found) return;
    const { group, snapshot } = found;
    snapshot.calls.delete(toolCallId);
    if (snapshot.calls.size > 0 || snapshot.finalized) return;
    const index = group.snapshots.indexOf(snapshot);
    if (index >= 0) group.snapshots.splice(index, 1);
    this.totalBytes -= snapshot.bytes;
  }

  /** Revert the most recent turn that changed files. */
  undo(cwd: string): UndoResult | undefined {
    this.dropEmptyTail();
    const index = this.lastNonEmptyGroup();
    if (index < 0) return undefined;
    const [group] = this.groups.splice(index, 1);
    const result: UndoResult = { restored: [], removed: [], skipped: 0 };
    for (const snapshot of [...group.snapshots].reverse()) {
      const label = this.label(snapshot.path, cwd);
      try {
        if (snapshot.before === null) {
          if (existsSync(snapshot.path)) unlinkSync(snapshot.path);
          result.removed.push(label);
        } else {
          writeFileSync(snapshot.path, snapshot.before);
          result.restored.push(label);
        }
      } catch {
        result.skipped += 1;
      }
    }
    this.totalBytes -= groupBytes(group);
    this.redoStack.push(group);
    return result;
  }

  /** Re-apply the turn most recently undone. */
  redo(): UndoResult | undefined {
    const group = this.redoStack.pop();
    if (!group) return undefined;
    const result: UndoResult = { restored: [], removed: [], skipped: 0 };
    for (const snapshot of group.snapshots) {
      const label = basename(snapshot.path);
      if (!snapshot.finalized) {
        result.skipped += 1;
        continue;
      }
      try {
        if (snapshot.after === null) {
          result.skipped += 1;
          continue;
        }
        mkdirSync(dirname(snapshot.path), { recursive: true });
        writeFileSync(snapshot.path, snapshot.after);
        result.restored.push(label);
      } catch {
        result.skipped += 1;
      }
    }
    this.groups.push(group);
    this.totalBytes += groupBytes(group);
    this.prune();
    return result;
  }

  get size(): number {
    return this.groups.reduce((count, group) => count + group.snapshots.length, 0);
  }

  get redoCount(): number {
    return this.redoStack.reduce((count, group) => count + group.snapshots.length, 0);
  }

  private group(id: number): Group {
    let group = this.groups.find(candidate => candidate.id === id);
    if (!group) {
      group = { id, snapshots: [] };
      this.groups.push(group);
    }
    return group;
  }

  private locate(toolCallId: string): { group: Group; snapshot: Snapshot } | undefined {
    for (let index = this.groups.length - 1; index >= 0; index--) {
      const group = this.groups[index];
      for (const snapshot of group.snapshots) {
        if (snapshot.calls.has(toolCallId)) return { group, snapshot };
      }
    }
    return undefined;
  }

  private lastNonEmptyGroup(): number {
    for (let index = this.groups.length - 1; index >= 0; index--) {
      if (this.groups[index].snapshots.length > 0) return index;
    }
    return -1;
  }

  private dropEmptyTail(): void {
    while (this.groups.length > 0 && this.groups[this.groups.length - 1].snapshots.length === 0) {
      this.groups.pop();
    }
  }

  /** Keep history bounded without ever leaving a half-snapshotted group behind. */
  private prune(): void {
    while (this.groups.length > this.maxGroups || this.totalBytes > this.maxTotalBytes) {
      const dropped = this.groups.shift();
      if (!dropped) return;
      this.totalBytes -= groupBytes(dropped);
    }
  }

  private label(path: string, cwd: string): string {
    const rel = relative(cwd, path);
    return rel && !rel.startsWith('..') ? rel : basename(path);
  }
}
