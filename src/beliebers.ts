import { stripVTControlCharacters } from 'node:util';
import type {
  AgentToolResult, ExtensionAPI, ExtensionCommandContext, ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';

import type { Belieb } from './branding.js';
import { cappedText, emptyUsage, mergeUsage, runBeliebers, type BelieberResult } from './belieber-runner.js';
import { beliebersConfig, MAX_BELIEBERS, saveConfig, type BeliebersConfig } from './config.js';
import { prepareTasks, MAX_TASK_FILES, type BelieberTask } from './belieber-policy.js';
import { pickModel } from './model-picker.js';
import { formatUsd } from './usage.js';

interface BeliebersDetails {
  model: string | null;
  parallelism: number;
  access: 'read' | 'write';
  readOnly: boolean;
  plan: boolean;
  ready: boolean;
  results: BelieberResult[];
}

function modelAvailable(ctx: ExtensionContext, model: string | null): boolean {
  return Boolean(model && ctx.modelRegistry.getAvailable()
    .some(item => `${item.provider}/${item.id}` === model));
}

/** Strip control sequences from external text before showing compact terminal previews. */
function preview(text: string, length = 90): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, length);
}

function report(details: BeliebersDetails, expanded: boolean): string {
  if (details.results.length === 0) {
    return [
      `♥ beliebers · ${details.ready ? 'ready' : 'not ready'}`,
      `model: ${details.model ?? 'not configured — use /beliebers model'}`,
      `parallelism: ${details.parallelism} · ${details.readOnly ? 'read-only reviewers' : 'scoped workers enabled'}${details.plan ? ' · plan mode' : ''}`,
      ...(details.plan && details.access === 'write' ? ['Configured write access is overridden by plan mode.'] : []),
      ...(!details.ready && details.model ? ['Model unavailable. Check /login or choose another with /beliebers model.'] : []),
    ].join('\n');
  }
  const complete = details.results.filter(result => result.status === 'done').length;
  const lines = [`♥ beliebers · ${complete}/${details.results.length} done · ${details.model}`];
  for (const [index, result] of details.results.entries()) {
    const icon = result.status === 'done' ? '✓' : result.status === 'failed' ? '✗'
      : result.status === 'working' ? '♪' : result.status === 'cancelled' ? '−' : '·';
    lines.push(`${icon} ${index + 1}. [${result.mode ?? 'reviewer'}] ${preview(result.task)} · ${preview(result.activity, 30)}`);
    if (expanded) {
      if (result.files?.length) lines.push(`Assigned files: ${result.files.join(', ')}`);
      lines.push(result.task, result.error ?? (result.output || '(no output yet)'), formatUsd(result.usage.cost.total));
    } else if (result.error) {
      lines.push(`  ${preview(result.error)}`);
    }
  }
  if (!expanded) lines.push('Expand for results and usage.');
  return lines.join('\n');
}

async function settings(args: string, ctx: ExtensionCommandContext, state: Belieb): Promise<void> {
  if (!ctx.hasUI) return;
  const current = beliebersConfig(state.config.beliebers);
  const [command, ...rest] = args.trim().split(/\s+/).filter(Boolean);
  let action: string | undefined = command;
  if (!action) {
    const choice = await ctx.ui.select(
      `♥ beliebers · ${current.model ?? 'choose a model'} · ${current.parallelism} parallel · ${current.access === 'write' ? 'scoped workers enabled' : 'read-only'}`,
      ['Choose model', 'Set parallelism', 'Set access', 'Turn off'],
    );
    action = choice === 'Choose model' ? 'model' : choice === 'Set parallelism' ? 'parallel'
      : choice === 'Set access' ? 'access' : choice === 'Turn off' ? 'off' : undefined;
    if (!action) return;
  }
  const next = { ...current };
  if (action === 'model') {
    const models = ctx.modelRegistry.getAvailable()
      .map(model => ({ provider: model.provider, id: model.id }))
      .sort((left, right) => `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`));
    const available = models.map(model => `${model.provider}/${model.id}`);
    let selected = rest.join(' ');
    if (!selected) {
      if (!models.length) {
        ctx.ui.notify('No models available. Use /login first, then /beliebers model.', 'warning');
        return;
      }
      selected = await pickModel(ctx, models, current.model) ?? '';
      if (!selected) return;
    }
    if (!available.includes(selected)) {
      ctx.ui.notify('Model unavailable. Use an exact provider/model ID, or /beliebers model to choose.', 'warning');
      return;
    }
    next.model = selected;
  } else if (action === 'parallel') {
    const selected = rest[0] ?? await ctx.ui.select('Maximum parallel Beliebers', ['1', '2', '3', '4']);
    if (selected === undefined) return;
    const parallelism = Number(selected);
    if (!Number.isInteger(parallelism) || parallelism < 1 || parallelism > MAX_BELIEBERS || rest.length > 1) {
      ctx.ui.notify(`Use /beliebers parallel <1-${MAX_BELIEBERS}>.`, 'warning');
      return;
    }
    next.parallelism = parallelism;
  } else if (action === 'access') {
    const access = rest[0] ?? await ctx.ui.select('Beliebers access', ['read', 'write']);
    if (access === undefined) return;
    if ((access !== 'read' && access !== 'write') || rest.length > 1) {
      ctx.ui.notify('Use /beliebers access read|write.', 'warning');
      return;
    }
    if (access === 'write' && current.access !== 'write' && !(await ctx.ui.confirm(
      'Enable Belieber workers?',
      'Workers can edit/create assigned files directly using your user permissions. '
        + 'Each task requires an exact file list; no bash or MCP. The main agent reviews and tests. '
        + 'Child writes are not covered by the main /undo. This is not an OS sandbox.',
    ))) return;
    next.access = access;
  } else if (action === 'off' && rest.length === 0) {
    next.model = null;
  } else {
    ctx.ui.notify('/beliebers [model [provider/id] | parallel <1-4> | access read|write | off]', 'info');
    return;
  }
  try {
    saveConfig({ ...state.config, beliebers: next });
    state.config.beliebers = next;
    ctx.ui.notify(next.model
      ? `♥ beliebers · ${next.model} · ${next.parallelism} parallel · ${next.access === 'write' ? 'scoped workers enabled' : 'read-only'}`
      : 'Beliebers off. Choose a model with /beliebers model to enable them.', 'info');
  } catch {
    ctx.ui.notify('Could not save Beliebers settings. Previous settings are unchanged.', 'error');
  }
}

export function registerBeliebers(pi: ExtensionAPI, state: Belieb): void {
  const running = new Map<AbortController, Promise<void>>();
  pi.on('session_shutdown', async () => {
    for (const controller of running.keys()) controller.abort();
    await Promise.all(running.values());
  });
  pi.registerCommand('beliebers', {
    description: 'Choose the model, parallelism and read/write access for Belieber subagents',
    getArgumentCompletions(prefix) {
      if (prefix.startsWith('parallel ')) {
        return ['1', '2', '3', '4'].filter(value => value.startsWith(prefix.slice(9)))
          .map(value => ({ value: `parallel ${value}`, label: value }));
      }
      if (prefix.startsWith('access ')) {
        return ['read', 'write'].filter(value => value.startsWith(prefix.slice(7)))
          .map(value => ({ value: `access ${value}`, label: value }));
      }
      return ['model', 'parallel', 'access', 'off'].filter(value => value.startsWith(prefix))
        .map(value => ({ value, label: value }));
    },
    handler: (args, ctx) => settings(args, ctx, state),
  });
  pi.registerTool({
    name: 'beliebers',
    label: 'Beliebers',
    description: 'Check configured Beliebers (action=list) or delegate up to 8 tasks (action=run). '
      + 'A string is a read-only reviewer. Objects are {task, mode: reviewer|worker, files?: string[]}. '
      + 'Workers produce implementation directly in exact workspace-relative files and require user-enabled write access. '
      + 'No bash, MCP, other extension tools, or nested agents. Plan mode forces reviewers. '
      + 'Each task uses the user-selected model in an isolated context; include necessary context. '
      + 'Configuration is user-controlled through /beliebers; never substitute models or escalate access.',
    promptSnippet: 'Check and run the user-configured Belieber subagents.',
    promptGuidelines: [
      'When the user asks to use subagents, check beliebers with action=list before delegating with action=run.',
      'Only use Beliebers when the user requests subagents or Beliebers. If unconfigured or unavailable, explain how to use /beliebers model.',
      'When the user requests implementation delegation and write access is enabled, delegate bulk code, tests, scripts and docs to worker tasks; the main agent specifies requirements and reviews actual file changes.',
      'Workers write directly with edit/write and return short summaries. Do not ask them for large code blocks and regenerate or copy that implementation yourself. Send targeted revisions back when useful.',
      'Give each worker an explicit, non-overlapping files list of exact workspace-relative paths. Do not edit owned files while workers run; review dependent work only after the batch finishes.',
      'Workers cannot run commands or tests. Inspect their diffs, preserve unrelated changes, and run verification yourself. Cancellation/failure may leave partial edits; inspect every assigned file before accepting work.',
      'Strings and reviewer tasks are read-only. If write access is disabled, ask the user to enable /beliebers access write for implementation delegation; never silently treat reviewers as workers.',
      'Plan mode forces read-only reviewers. Include context in every task and reconcile reports; children do not see this conversation.',
    ],
    exposure: 'model-only',
    executionMode: 'sequential',
    parameters: Type.Object({
      action: Type.Union([Type.Literal('list'), Type.Literal('run')]),
      tasks: Type.Optional(Type.Array(Type.Union([
        Type.String({ minLength: 1, maxLength: 16_000 }),
        Type.Object({
          task: Type.String({ minLength: 1, maxLength: 16_000 }),
          mode: Type.Union([Type.Literal('reviewer'), Type.Literal('worker')]),
          files: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), {
            minItems: 1, maxItems: MAX_TASK_FILES,
            description: 'Required for workers: exact workspace-relative files, no directory/glob grants.',
          })),
        }),
      ]), { minItems: 1, maxItems: 8, description: 'Focused tasks with context; strings are reviewers.' })),
    }),
    async execute(_id, params, signal, onUpdate, ctx): Promise<AgentToolResult<BeliebersDetails>> {
      const config = beliebersConfig(state.config.beliebers);
      const details: BeliebersDetails = {
        ...config, readOnly: config.access !== 'write' || state.inPlanMode, plan: state.inPlanMode,
        ready: modelAvailable(ctx, config.model), results: [],
      };
      const response = (text: string, isError = false): AgentToolResult<BeliebersDetails> => {
        const usage = emptyUsage();
        for (const result of details.results) mergeUsage(usage, result.usage);
        return { content: [{ type: 'text', text }], details: structuredClone(details), usage, isError };
      };
      if (params.action === 'list') {
        if (params.tasks) return response('Use action=run to delegate tasks.', true);
        return response(report(details, true));
      }
      let tasks: BelieberTask[];
      try {
        tasks = prepareTasks(params.tasks, ctx.cwd, config.access, state.inPlanMode);
      } catch (error) {
        return response(error instanceof Error ? error.message : 'Invalid task input.', true);
      }
      if (!details.ready || !config.model) return response(report(details, true), true);
      const controller = new AbortController();
      let finished!: () => void;
      running.set(controller, new Promise<void>(resolve => { finished = resolve; }));
      try {
        details.results = await runBeliebers(tasks, config.parallelism, {
          cwd: ctx.cwd, model: config.model, plan: state.inPlanMode,
          trusted: ctx.isProjectTrusted(),
          signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
          onUpdate(results) {
            details.results = results;
            onUpdate?.(response(report(details, false)));
          },
        });
        const output = details.results.map((result, index) =>
          `## Belieber ${index + 1} — ${result.status} (${result.mode})\nTask: ${result.task}\n`
          + (result.files.length ? `Assigned files: ${result.files.join(', ')}\n` : '')
          + `\n${cappedText(result.error ?? result.output)}`,
        ).join('\n\n');
        return response(output, details.results.some(result => result.status !== 'done'));
      } finally {
        running.delete(controller);
        finished();
      }
    },
    renderCall(args, theme) {
      return new Text(theme.fg('toolTitle', theme.bold('♥ beliebers'))
        + theme.fg('muted', args.action === 'run' ? ` · ${args.tasks?.length ?? 0} tasks` : ' · check configuration'), 0, 0);
    },
    renderResult(result, { expanded }, _theme) {
      const details = result.details as BeliebersDetails | undefined;
      const text = result.content.find(part => part.type === 'text');
      const output = details && !(result.isError && details.results.length === 0)
        ? report(details, expanded) : text?.type === 'text' ? text.text : '(no output)';
      return new Text(stripVTControlCharacters(output).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ''), 0, 0);
    },
  });
}
