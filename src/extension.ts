import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Key } from '@earendil-works/pi-tui';

import { Belieb } from './branding.js';
import { registerBeliebers } from './beliebers.js';
import { renderCard, renderPanel, type CardData, type PanelData } from './card.js';
import { registerBeliebCommands } from './commands.js';
import { loadConfig } from './config.js';
import { registerMarket } from './market-command.js';
import { isPlanContext, isSafePlanCommand } from './plan.js';

// Shipped with the package; discovered without writing to the user's agent dir.
const promptsDir = fileURLToPath(new URL('../prompts', import.meta.url));

export default function belieb(pi: ExtensionAPI): void {
  const state = new Belieb(pi, loadConfig());

  pi.registerFlag('plan', {
    description: 'Start in plan mode (read-only exploration)',
    type: 'boolean',
    default: false,
  });

  pi.registerCommand('plan', {
    description: 'Toggle plan mode (read-only)',
    handler: async (_args, ctx) => {
      const enabled = state.togglePlanMode();
      if (ctx.hasUI) {
        ctx.ui.notify(enabled ? '⏸ plan mode: read-only' : '♥ belieb mode: full access', 'info');
      }
    },
  });

  pi.registerShortcut(Key.ctrlAlt('p'), {
    description: 'Toggle plan mode',
    handler: (ctx) => {
      const enabled = state.togglePlanMode();
      if (ctx.hasUI) {
        ctx.ui.notify(enabled ? '⏸ plan mode: read-only' : '♥ belieb mode: full access', 'info');
      }
    },
  });

  pi.on('resources_discover', () => {
    const disabled = process.argv.includes('--no-prompt-templates') || process.argv.includes('-np');
    return !disabled && existsSync(promptsDir) ? { promptPaths: [promptsDir] } : undefined;
  });
  pi.on('session_start', (_event, ctx) => {
    state.start(ctx);
  });
  pi.on('model_select', (_event, ctx) => {
    state.modelChanged(ctx);
  });
  pi.on('before_agent_start', (event) => {
    if (!state.inPlanMode || event.messageType !== 'user') return;
    return { message: state.planMessage() };
  });
  pi.on('context', (event) => {
    if (state.inPlanMode) return;
    return {
      messages: event.messages.filter(message => !isPlanContext(message as { customType?: string })),
    };
  });
  pi.on('tool_call', (event, ctx) => {
    if (event.toolName === 'edit' || event.toolName === 'write') {
      const filePath = (event.input as { path?: unknown }).path;
      if (typeof filePath === 'string') {
        state.checkpoint(event.toolCallId, event.toolName, filePath, ctx.cwd);
      }
    }
    if (!state.inPlanMode || event.toolName !== 'bash') return;
    const command = (event.input as { command?: unknown }).command;
    if (typeof command !== 'string' || !isSafePlanCommand(command)) {
      return {
        block: true,
        reason: 'Plan mode is read-only. Switch to belieb mode with /plan before running a command that can change files.',
      };
    }
    return undefined;
  });
  pi.on('turn_start', () => {
    state.turn();
  });
  pi.on('agent_start', () => {
    state.agentStart();
  });
  pi.on('tool_execution_start', (event) => {
    state.toolStart(event.toolCallId, event.toolName, event.args);
  });
  pi.on('tool_execution_end', (event) => {
    state.toolEnd(event.toolCallId, event.toolName, event.isError);
  });
  pi.on('agent_settled', (event) => {
    state.settled(event.aborted);
  });
  pi.on('session_shutdown', () => {
    state.dispose();
  });

  pi.registerEntryRenderer<CardData>('belieb-card', (entry, _options, theme) => ({
    invalidate() {},
    render(width) {
      return renderCard(width, theme, entry.data ?? state.snapshot());
    },
  }));
  pi.registerEntryRenderer<PanelData>('belieb-panel', (entry, _options, theme) => ({
    invalidate() {},
    render(width) {
      return renderPanel(width, theme, entry.data ?? { title: '♥ belieb', lines: [] });
    },
  }));

  registerBeliebCommands(pi, state);
  registerBeliebers(pi, state);
  registerMarket(pi);
}
