import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { approvedWrite, REVIEWER_TOOLS, scopedFile, WORKER_TOOLS, MAX_TASK_FILES } from './belieber-policy.js';

/** Child-only, exact-model/loadout guard plus per-call file authorization. */
export default function guard(pi: ExtensionAPI): void {
  const mode = process.env.BELIEB_CHILD_MODE ?? 'reviewer';
  const worker = mode === 'worker';
  // Older parent sessions send only the model env var. They remain reviewers;
  // derive their read-only workspace locally so rebuilding does not break them.
  const root = process.env.BELIEB_CHILD_CWD ?? (worker ? undefined : realpathSync(process.cwd()));
  const allowed = new Set(worker ? WORKER_TOOLS : REVIEWER_TOOLS);
  const approved = new Set<string>();
  let policyError = '';
  try {
    if (mode !== 'worker' && mode !== 'reviewer') throw new Error('Invalid child mode.');
    if (!root || realpathSync(root) !== root) throw new Error('Invalid approved workspace.');
    if (worker) {
      const files: unknown = JSON.parse(process.env.BELIEB_CHILD_FILES ?? 'null');
      if (!Array.isArray(files) || !files.length || files.length > MAX_TASK_FILES) {
        throw new Error('Worker needs an approved file list.');
      }
      for (const file of files) approved.add(join(root, scopedFile(root, file)));
    }
  } catch (error) {
    policyError = error instanceof Error ? error.message : 'Invalid child scope.';
  }

  pi.on('session_start', async (_event, ctx) => {
    const expected = process.env.BELIEB_CHILD_MODEL;
    const actual = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    const unexpectedTools = pi.getActiveTools().some(name => !allowed.has(name));
    let workspaceMatches = false;
    try { workspaceMatches = realpathSync(ctx.cwd) === root; } catch { /* fail closed */ }
    const message = unexpectedTools ? 'Belieber refused an unexpected tool loadout.'
      : !expected || expected !== actual
        ? `Belieber model unavailable: expected ${expected ?? '(unset)'}, resolved ${actual ?? '(none)'}. No request was sent. Choose a model with /beliebers model; extension-defined providers are not loaded in children.`
        : policyError || (!workspaceMatches ? 'Belieber workspace mismatch.' : '');
    if (!message) return;
    // Fail before the first model request; this is a dedicated child process.
    await new Promise<never>(() => {
      process.stderr.write(`${message}\n`, () => process.exit(1));
    });
  });

  pi.on('tool_call', (event, ctx) => {
    if (!allowed.has(event.toolName)) return { block: true, reason: `Belieber cannot use ${event.toolName}.` };
    if (event.toolName !== 'edit' && event.toolName !== 'write') return undefined;
    try {
      if (policyError || !root || realpathSync(ctx.cwd) !== root) throw new Error(policyError || 'Worker workspace changed.');
      // Resolve again: a path approved before spawn may since have become a link.
      event.input.path = approvedWrite(root, approved, event.input.path);
    } catch (error) {
      return { block: true, reason: error instanceof Error ? error.message : 'Worker write blocked.' };
    }
    return undefined;
  });
}
