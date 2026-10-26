import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { effectiveMode, prepareTasks, REVIEWER_TOOLS, WORKER_TOOLS,
  type BelieberMode, type BelieberTask } from './belieber-policy.js';
import { fileURLToPath } from 'node:url';
import type { AgentToolResult, JsonAgentSessionEvent } from '@earendil-works/pi-coding-agent';

export type Usage = NonNullable<AgentToolResult['usage']>;
export type BelieberStatus = 'queued' | 'working' | 'done' | 'failed' | 'cancelled';

export interface BelieberResult {
  task: string;
  mode: BelieberMode;
  files: string[];
  status: BelieberStatus;
  activity: string;
  output: string;
  error?: string;
  usage: Usage;
}

export function emptyUsage(): Usage {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function mergeUsage(total: Usage, usage?: Usage): void {
  if (!usage) return;
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const) {
    total[key] += usage[key] ?? 0;
  }
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const) {
    total.cost[key] += usage.cost?.[key] ?? 0;
  }
}

const OUTPUT_CAP = 32 * 1024;
const LINE_CAP = 2 * 1024 * 1024;

export function cappedText(text: string, cap = OUTPUT_CAP): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= cap) return text;
  // Drop an incomplete trailing UTF-8 sequence rather than emitting a replacement character.
  let end = cap;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return `${bytes.subarray(0, end).toString('utf8')}\n[Output truncated.]`;
}

const CHILD_PROMPT = `You are a Belieber, a general-purpose read-only subagent of belieb.
Complete only the delegated task. You have an isolated context: the parent conversation
is not available, so use the task and repository instructions as your context.
Inspect files with read, grep, find and ls. Do not modify files, execute commands,
or delegate to other agents. Report concise findings with file paths, evidence,
and any limitations. The main agent will decide what to change.`;

const WORKER_PROMPT = `You are a Belieber worker, an implementation subagent of belieb.
Complete only the delegated task. Your isolated context does not include the parent conversation.
Read with read, grep, find and ls. Produce the implementation DIRECTLY in the assigned files using
edit/write; never touch any other file. No bash, MCP, package managers, tests, or nested agents.
Respect repository instructions and preserve unrelated changes. Read your edits back to inspect them.
Finish with a short summary of files changed, unfinished work and checks for the main agent.
Do not paste complete generated files or patches into your final response. The main agent reviews
actual file changes and runs verification instead of regenerating your implementation.`;

export interface RunOptions {
  cwd: string;
  model: string;
  task: string;
  plan: boolean;
  trusted: boolean;
  mode?: BelieberMode;
  files?: string[];
  signal?: AbortSignal;
  onUpdate?: (result: BelieberResult) => void;
  /** Injectable entry point and timing for credential-free process tests. */
  cliPath?: string;
  timeoutMs?: number;
  killAfterMs?: number;
}

export function childArgs(options: RunOptions): string[] {
  const slash = options.model.indexOf('/');
  if (slash <= 0 || slash === options.model.length - 1) throw new Error('Expected provider/model.');
  const task = prepareTasks([{ task: options.task, mode: effectiveMode(options), files: options.files }],
    options.cwd, 'write', options.plan)[0];
  const worker = task.mode === 'worker';
  const prompt = worker ? `${WORKER_PROMPT}\nAssigned files:\n${task.files.map(file => `- ${file}`).join('\n')}` : CHILD_PROMPT;
  return [
    '--mode', 'json', '--print', '--no-session',
    '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes',
    '--extension', fileURLToPath(new URL('./belieber-guard.js', import.meta.url)),
    options.trusted ? '--approve' : '--no-approve',
    '--provider', options.model.slice(0, slash), '--model', options.model.slice(slash + 1),
    '--tools', (worker ? WORKER_TOOLS : REVIEWER_TOOLS).join(','),
    '--append-system-prompt', `${prompt}${options.plan ? '\nThe parent is in PLAN MODE. Return findings and a numbered plan; do not claim edits.' : ''}`,
    // Piped stdin is literal: tasks cannot become options, @file attachments or prompt templates.
  ];
}

/** Run the pinned Pi CLI with only the internal guard, never presentation or delegation. */
export async function runBelieber(options: RunOptions, result: BelieberResult): Promise<void> {
  result.mode = effectiveMode(options);
  result.files = result.mode === 'worker' ? [...(options.files ?? [])] : [];
  if (options.signal?.aborted) {
    result.status = 'cancelled';
    result.activity = 'cancelled';
    return;
  }
  const cli = options.cliPath ?? fileURLToPath(
    new URL('./bundle/cli.js', import.meta.resolve('@earendil-works/pi-coding-agent')),
  );
  let args: string[];
  let root: string;
  try {
    args = childArgs(options);
    root = realpathSync(options.cwd);
  } catch (error) {
    result.status = 'failed'; result.activity = 'failed';
    result.error = error instanceof Error ? error.message : String(error);
    return;
  }
  result.status = 'working';
  result.activity = 'starting';
  options.onUpdate?.(result);

  await new Promise<void>((resolve) => {
    const proc = spawn(process.execPath, [cli, ...args], {
      cwd: options.cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PI_TELEMETRY: '0', BELIEB_CHILD_MODEL: options.model,
        BELIEB_CHILD_MODE: result.mode, BELIEB_CHILD_FILES: JSON.stringify(result.files), BELIEB_CHILD_CWD: root },
    });
    let buffer = '';
    let stderr = '';
    let closed = false;
    let settled = false;
    let stopReason = '';
    let lastError = '';
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const terminate = (reason: string, cancelled = false) => {
      if (result.error) return;
      result.error = reason;
      result.status = cancelled ? 'cancelled' : 'failed';
      if (closed) return;
      proc.kill('SIGTERM');
      killTimer = setTimeout(() => { if (!closed) proc.kill('SIGKILL'); }, options.killAfterMs ?? 1000);
      killTimer.unref();
    };
    const abort = () => terminate('Belieber cancelled.', true);
    const timeout = setTimeout(() => terminate('Belieber exceeded its time limit (default: 5 minutes).'), options.timeoutMs ?? 300_000);
    timeout.unref();

    const processLine = (line: string) => {
      if (!line.trim() || result.error) return;
      let event: JsonAgentSessionEvent;
      try {
        event = JSON.parse(line);
        if (!event || typeof event !== 'object') throw new Error('Not an event');
      } catch {
        terminate('Invalid JSON from Belieber.');
        return;
      }
      try {
        if (event.type === 'message_end') {
          const message = event.message;
          if (message.role === 'assistant') {
            mergeUsage(result.usage, message.usage);
            result.output = cappedText(message.content
              .filter(part => part.type === 'text').map(part => part.text).join('\n'));
            stopReason = message.stopReason;
            lastError = message.errorMessage ?? '';
            result.activity = 'thinking';
            options.onUpdate?.(result);
          } else if (message.role === 'toolResult') {
            mergeUsage(result.usage, message.usage);
          }
        } else if (event.type === 'tool_execution_start') {
          result.activity = event.toolName;
          options.onUpdate?.(result);
        } else if (event.type === 'compaction_end') {
          mergeUsage(result.usage, event.result?.usage);
        } else if (event.type === 'agent_settled') {
          settled = true;
          if (event.aborted) terminate('Belieber cancelled.', true);
        }
      } catch {
        terminate('Invalid JSON event from Belieber.');
      }
    };

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > LINE_CAP) terminate('Belieber JSON record exceeded 2 MB.');
        else processLine(line);
      }
      if (Buffer.byteLength(buffer) > LINE_CAP) {
        buffer = '';
        terminate('Belieber JSON record exceeded 2 MB.');
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => { stderr = cappedText(stderr + chunk, 16 * 1024); });
    proc.on('error', error => { result.error = `Could not start Belieber: ${error.message}`; });
    // An early CLI failure may close stdin before the task is consumed.
    proc.stdin.on('error', () => {});
    proc.stdin.end(`Delegated task:\n${options.task}`);
    proc.on('close', (code, signal) => {
      closed = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
      if (buffer.trim()) processLine(buffer);
      if (result.status !== 'cancelled') {
        if (!result.error && (code !== 0 || !settled || stopReason !== 'stop' || !result.output.trim())) {
          result.error = lastError || stderr || `Belieber did not complete (exit ${code ?? signal}, ${stopReason || 'no response'}).`;
        }
        result.status = result.error ? 'failed' : 'done';
      }
      result.activity = result.status;
      options.onUpdate?.(result);
      resolve();
    });
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}

/** One sequential tool call owns a bounded pool; queued tasks never start after cancellation. */
export async function runBeliebers(
  tasks: Array<string | BelieberTask>, parallelism: number,
  options: Omit<RunOptions, 'task' | 'mode' | 'files' | 'onUpdate'> & { onUpdate?: (results: BelieberResult[]) => void },
  runner = runBelieber,
): Promise<BelieberResult[]> {
  const results: BelieberResult[] = tasks.map(task => {
    const spec = typeof task === 'string' ? { task, mode: 'reviewer' as const, files: [] } : task;
    const mode = effectiveMode({ mode: spec.mode, plan: options.plan });
    return { task: spec.task, mode, files: mode === 'worker' ? [...spec.files] : [],
      status: 'queued', activity: 'queued', output: '', usage: emptyUsage() };
  });
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, parallelism), tasks.length) }, async () => {
    while (next < results.length) {
      const result = results[next++];
      if (options.signal?.aborted) {
        result.status = 'cancelled';
        result.activity = 'cancelled';
      } else {
        try {
          await runner({ ...options, task: result.task, mode: result.mode, files: result.files,
            onUpdate: () => options.onUpdate?.(results) }, result);
        } catch (error) {
          result.status = 'failed';
          result.activity = 'failed';
          result.error = error instanceof Error ? error.message : String(error);
        }
      }
      options.onUpdate?.(results);
    }
  }));
  return results;
}
