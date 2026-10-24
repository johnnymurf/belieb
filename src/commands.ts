import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type { AutocompleteItem } from '@earendil-works/pi-tui';

import type { Belieb } from './branding.js';
import type { UndoResult } from './checkpoints.js';
import { saveConfig, type BeliebConfig } from './config.js';
import { pickMode } from './mode-picker.js';
import { isMood, moodNames, moods } from './palettes.js';

const subcommands: AutocompleteItem[] = [
  { value: 'mode', label: 'mode', description: 'Choose between plan and belieb' },
  { value: 'mood', label: 'mood', description: 'Switch the accent palette' },
  { value: 'undo', label: 'undo', description: 'Revert the last turn' },
  { value: 'redo', label: 'redo', description: 'Re-apply the last undone turn' },
  { value: 'cost', label: 'cost', description: 'Show session tokens and spend' },
  { value: 'notify', label: 'notify', description: 'Turn finish notifications on or off' },
  { value: 'plan', label: 'plan', description: 'Enter read-only plan mode' },
  { value: 'belieb', label: 'belieb', description: 'Return to full belieb mode' },
  { value: 'off', label: 'off', description: 'Turn decoration off, back to plain Pi' },
  { value: 'on', label: 'on', description: 'Turn decoration back on' },
  { value: 'card', label: 'card', description: 'Print the Myspace profile card' },
  { value: 'mcp', label: 'mcp', description: 'List active MCP servers' },
  { value: 'stats', label: 'stats', description: 'Show tour stats for this session' },
  { value: 'credits', label: 'credits', description: 'Show attribution' },
];

function completions(prefix: string): AutocompleteItem[] {
  const text = prefix.trimStart();
  if (text.startsWith('mood ')) {
    const fragment = text.slice('mood '.length).trim();
    return moodNames
      .filter(name => name.startsWith(fragment))
      .map(name => ({ value: name, label: name, description: moods[name].label }));
  }
  const fragment = text.split(/\s+/)[0] ?? '';
  return subcommands.filter(item => item.value.startsWith(fragment));
}

export function registerBeliebCommands(pi: ExtensionAPI, belieb: Belieb): void {
  pi.registerCommand('belieb', {
    description: 'Belieb extras: mode, mood, undo/redo, cost, plain mode, card, stats, credits',
    getArgumentCompletions: completions,
    handler: async (args, ctx) => {
      await run(args, ctx, pi, belieb);
    },
  });

  pi.registerCommand('mode', {
    description: 'Choose plan or belieb mode',
    handler: async (_args, ctx) => {
      await chooseMode(ctx, belieb);
    },
  });

  pi.registerCommand('undo', {
    description: 'Revert every file change from the last turn',
    handler: async (_args, ctx) => {
      undoLast(ctx, belieb);
    },
  });

  pi.registerCommand('redo', {
    description: 'Re-apply the change reverted by /undo',
    handler: async (_args, ctx) => {
      redoLast(ctx, belieb);
    },
  });

  pi.registerCommand('cost', {
    description: 'Show session tokens and spend',
    handler: async (_args, ctx) => {
      showCost(ctx, pi, belieb);
    },
  });
}

/** "↩ restored a.txt" for one file, "↩ restored 3 files · removed 1" for a turn. */
function changeMessage(prefix: string, result: UndoResult): string {
  const parts: string[] = [];
  if (result.restored.length === 1) parts.push(`restored ${result.restored[0]}`);
  else if (result.restored.length > 1) parts.push(`restored ${result.restored.length} files`);
  if (result.removed.length === 1) parts.push(`removed ${result.removed[0]}`);
  else if (result.removed.length > 1) parts.push(`removed ${result.removed.length} files`);
  if (result.skipped > 0) parts.push(`skipped ${result.skipped}`);
  return `${prefix} ${parts.join(' · ')}`;
}

function undoLast(ctx: ExtensionCommandContext, belieb: Belieb): void {
  try {
    const result = belieb.undo(ctx.cwd);
    if (!ctx.hasUI) return;
    if (!result) {
      ctx.ui.notify('nothing to undo yet', 'info');
      return;
    }
    ctx.ui.notify(changeMessage('↩', result), 'info');
  } catch (error) {
    if (ctx.hasUI) {
      ctx.ui.notify(
        `undo failed: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
    }
  }
}

function redoLast(ctx: ExtensionCommandContext, belieb: Belieb): void {
  try {
    const result = belieb.redo();
    if (!ctx.hasUI) return;
    if (!result) {
      ctx.ui.notify('nothing to redo', 'info');
      return;
    }
    ctx.ui.notify(changeMessage('↪', result), 'info');
  } catch (error) {
    if (ctx.hasUI) {
      ctx.ui.notify(
        `redo failed: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
    }
  }
}

function showCost(ctx: ExtensionCommandContext, pi: ExtensionAPI, belieb: Belieb): void {
  const lines = belieb.costPanel();
  if (ctx.mode === 'tui') {
    pi.appendEntry('belieb-panel', { title: 'tour costs', lines });
    return;
  }
  if (ctx.hasUI) ctx.ui.notify(lines.join('\n'), 'info');
}

async function chooseMode(ctx: ExtensionCommandContext, belieb: Belieb): Promise<void> {
  const current = belieb.inPlanMode ? 'plan' : 'belieb';
  const choice = await pickMode(ctx, current);
  if (!choice) return;
  const changed = belieb.setPlanMode(choice === 'plan');
  if (!ctx.hasUI) return;
  ctx.ui.notify(
    changed
      ? choice === 'plan' ? '⏸ plan mode: read-only' : '♥ belieb mode: full access'
      : `already in ${choice} mode`,
    'info',
  );
}

function persist(ctx: ExtensionCommandContext, config: BeliebConfig): void {
  try {
    saveConfig(config);
  } catch {
    ctx.ui.notify('could not save belieb settings', 'warning');
  }
}

async function run(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  belieb: Belieb,
): Promise<void> {
  const [subcommand = '', ...rest] = args.trim().split(/\s+/).filter(Boolean);

  // Modes, undo/redo and cost are functional, so the hub offers them in every dialog-capable mode.
  if (subcommand === 'mode') {
    await chooseMode(ctx, belieb);
    return;
  }
  if (subcommand === 'undo') {
    undoLast(ctx, belieb);
    return;
  }
  if (subcommand === 'redo') {
    redoLast(ctx, belieb);
    return;
  }
  if (subcommand === 'cost') {
    showCost(ctx, pi, belieb);
    return;
  }

  // The remaining extras only make sense in the TUI.
  if (ctx.mode !== 'tui') {
    if (ctx.hasUI) ctx.ui.notify('belieb extras need the interactive terminal', 'info');
    return;
  }

  switch (subcommand) {
    case '':
    case 'help': {
      ctx.ui.notify('♥ /belieb mode|mood|undo|redo|cost|notify|plan|belieb|off|on|card|mcp|stats|credits', 'info');
      return;
    }
    case 'plan': {
      const changed = belieb.setPlanMode(true);
      ctx.ui.notify(changed ? '⏸ plan mode: read-only' : 'already in plan mode', 'info');
      return;
    }
    case 'belieb': {
      const changed = belieb.setPlanMode(false);
      ctx.ui.notify(changed ? '♥ belieb mode: full access' : 'already in belieb mode', 'info');
      return;
    }
    case 'notify': {
      const value = rest[0];
      if (value === 'on' || value === 'off') {
        belieb.config.notify = value === 'on';
        persist(ctx, belieb.config);
        ctx.ui.notify(`notifications ${value}`, 'info');
      } else {
        ctx.ui.notify(
          `notifications: ${belieb.config.notify ? 'on' : 'off'} (use /belieb notify on|off)`,
          'info',
        );
      }
      return;
    }
    case 'mood': {
      let chosen = rest[0];
      if (!chosen) {
        const pick = await ctx.ui.select(
          '♥ choose a mood',
          moodNames.map(name => `${name} — ${moods[name].label}`),
        );
        if (!pick) return;
        chosen = pick.split(' — ')[0];
      }
      if (!isMood(chosen)) {
        ctx.ui.notify(`unknown mood: ${chosen} (${moodNames.join(', ')})`, 'warning');
        return;
      }
      const applied = belieb.setMood(chosen);
      persist(ctx, belieb.config);
      ctx.ui.notify(
        applied
          ? `mood: ${moods[chosen].label} ♥`
          : belieb.config.plain
            ? `mood saved: ${moods[chosen].label} (plain mode is on)`
            : `mood saved: ${moods[chosen].label} (keeping your theme)`,
        'info',
      );
      return;
    }
    case 'off': {
      belieb.disable();
      persist(ctx, belieb.config);
      ctx.ui.notify('plain mode: decoration off', 'info');
      return;
    }
    case 'on': {
      belieb.enable();
      persist(ctx, belieb.config);
      ctx.ui.notify('♥ decoration back on', 'info');
      return;
    }
    case 'card': {
      pi.appendEntry('belieb-card', belieb.snapshot());
      return;
    }
    case 'mcp': {
      const servers = belieb.mcpServers();
      pi.appendEntry('belieb-panel', {
        title: 'mcp servers',
        lines: servers.length > 0
          ? servers.map(server => `${server.name}  ${server.tools} tool${server.tools === 1 ? '' : 's'}`)
          : ['none connected. Add one: belieb mcp add <name> -- <command>', 'then /reload. Pi\'s /mcp shows errors and sign-in.'],
      });
      return;
    }
    case 'stats': {
      pi.appendEntry('belieb-panel', { title: 'tour stats', lines: belieb.stats() });
      return;
    }
    case 'credits': {
      pi.appendEntry('belieb-panel', {
        title: 'credits',
        lines: [
          'Portrait adapted from "Justin Bieber" by Kevin Aranibar (CC BY 2.0).',
          'Original: Wikimedia Commons / Flickr. Changed: cropped, dithered to Braille.',
          'Runtime: Pi 1.4.0 (MIT). independent project, not affiliated with Pi.',
          'Full attribution ships in NOTICE.',
        ],
      });
      return;
    }
    default: {
      ctx.ui.notify(`unknown belieb command: ${subcommand}`, 'warning');
    }
  }
}
