import type {
  ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider, Theme, ThemeColor,
} from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth, type TUI } from '@earendil-works/pi-tui';

import { renderCard, type CardData } from './card.js';
import { checkKind, checkOrder, type CheckKind } from './checks.js';
import { Checkpoints, type UndoResult } from './checkpoints.js';
import type { BeliebConfig } from './config.js';
import { activeMcpServers, type McpServerInfo } from './mcp.js';
import { notificationSequence, notificationText, shouldNotify } from './notify.js';
import { moods, themeFor, type Mood } from './palettes.js';
import { PLAN_CONTEXT, planModeWriteTools } from './plan.js';
import { SubscriptionUsage } from './subscription-usage.js';
import {
  billedTokens, costSegment, emptyTotals, formatTokens, formatUsd, sessionTotals, type Totals,
} from './usage.js';

/** The flavor line shown while a tool runs. */
export function workingPhrase(toolName: string, args: unknown): string {
  if (toolName === 'edit' || toolName === 'write') return 'recording vocals…';
  if (toolName === 'read') return 'learning the choreography…';
  if (['grep', 'find', 'ls', 'glob'].includes(toolName)) return 'crate-digging for samples…';
  if (toolName === 'bash' || toolName === 'powershell') {
    const command = typeof (args as { command?: unknown } | undefined)?.command === 'string'
      ? (args as { command: string }).command
      : '';
    return /\bgit\b/.test(command) ? 'boarding the tour bus…' : 'soundcheck…';
  }
  return 'beliebing…';
}

/** About one thinking phase in a hundred gets this instead of the usual line. */
const rareThinkingLines = ['Freemasons run the country...'];

/**
 * Owns the terminal presentation for one session: theme, header, footer,
 * working messages and title. Every method is a no-op outside TUI mode, so
 * print, JSON and RPC output stay untouched.
 */
export class Belieb {
  config: BeliebConfig;
  private readonly pi: ExtensionAPI;
  private readonly themeLocked: boolean;
  private ctx: ExtensionContext | undefined;
  private baseTheme: Theme | undefined;
  private headerTui: TUI | undefined;
  private footerTui: TUI | undefined;
  private branch: string | null = null;
  private working = false;
  private phrase = 'beliebing…';
  private planMode = false;
  private savedTools: string[] | undefined;
  private turns = 0;
  private tools = 0;
  private readonly files = new Set<string>();
  private readonly bashCommands = new Map<string, string>();
  private readonly checkpoints = new Checkpoints();
  private readonly checks = new Map<CheckKind, boolean>();
  private runId = 0;
  private totals: Totals = emptyTotals();
  private runStartedAt = 0;
  private since = '';
  private readonly subscription = new SubscriptionUsage(() => this.refresh());

  constructor(pi: ExtensionAPI, config: BeliebConfig) {
    this.pi = pi;
    this.config = config;
    this.themeLocked = process.argv.some(argument => argument === '--use-theme' || argument.startsWith('--use-theme='));
    this.stampLogin();
  }

  start(ctx: ExtensionContext): void {
    this.subscription.stop();
    this.ctx = ctx;
    this.resetPlanMode();
    this.turns = 0;
    this.tools = 0;
    this.files.clear();
    this.checks.clear();
    this.working = false;
    this.phrase = 'beliebing…';
    this.stampLogin();
    this.refreshTotals();
    if (ctx.mode === 'tui') {
      this.baseTheme = ctx.ui.theme;
      ctx.ui.setStatus('belieb-checks', undefined);
      if (!this.config.plain) this.install();
    }
    if (this.pi.getFlag('plan') === true) this.setPlanMode(true);
  }

  stop(): void {
    this.subscription.stop();
    const ctx = this.ctx;
    if (!ctx || ctx.mode !== 'tui') return;
    if (!this.themeLocked && !process.env.NO_COLOR && this.baseTheme) {
      ctx.ui.setTheme(this.baseTheme);
    }
    ctx.ui.setHeader(undefined);
    ctx.ui.setFooter(undefined);
    ctx.ui.setWorkingMessage();
    ctx.ui.setWorkingIndicator();
    ctx.ui.setHiddenThinkingLabel();
    ctx.ui.setStatus('belieb-checks', undefined);
    ctx.ui.setTitle('');
    this.headerTui = undefined;
    this.footerTui = undefined;
  }

  enable(): void {
    this.config.plain = false;
    this.install();
  }

  disable(): void {
    this.config.plain = true;
    this.stop();
  }

  modelChanged(ctx: ExtensionContext): void {
    this.ctx = ctx;
    if (this.visible) this.subscription.start(ctx, this.config.openCodeUsage);
    this.refresh();
  }

  setUsageSource(openCode: boolean): void {
    this.config.openCodeUsage = openCode;
    if (this.visible && this.ctx) this.subscription.start(this.ctx, openCode);
    this.refresh();
  }

  setMood(mood: Mood): boolean {
    this.config.mood = mood;
    const ctx = this.ctx;
    if (!ctx || ctx.mode !== 'tui' || this.config.plain || this.themeLocked
      || process.env.NO_COLOR || !this.baseTheme) {
      return false;
    }
    ctx.ui.setTheme(themeFor(this.baseTheme, mood));
    ctx.ui.setWorkingIndicator({ frames: this.frames(), intervalMs: 180 });
    this.refresh();
    return true;
  }

  get inPlanMode(): boolean {
    return this.planMode;
  }

  /** Switch between read-only plan mode and normal belieb mode. */
  setPlanMode(enabled: boolean): boolean {
    if (this.planMode === enabled) return false;
    if (enabled) {
      this.savedTools = this.pi.getActiveTools();
      this.pi.setActiveTools(this.savedTools.filter(name => !planModeWriteTools.has(name)));
    } else {
      this.restorePlanTools();
    }
    this.planMode = enabled;
    this.setTitle();
    this.refresh();
    return true;
  }

  togglePlanMode(): boolean {
    this.setPlanMode(!this.planMode);
    return this.planMode;
  }

  planMessage(): { customType: string; content: string; display: boolean } {
    return { customType: 'belieb-plan-context', content: PLAN_CONTEXT, display: false };
  }

  checkpoint(toolCallId: string, tool: string, path: string, cwd: string): void {
    this.checkpoints.capture(toolCallId, tool, path, cwd, this.runId);
  }

  undo(cwd: string): UndoResult | undefined {
    return this.checkpoints.undo(cwd);
  }

  redo(): UndoResult | undefined {
    return this.checkpoints.redo();
  }

  get checkpointCount(): number {
    return this.checkpoints.size;
  }

  turn(): void {
    this.turns++;
    this.setThinkingMessage();
    this.refresh();
  }

  agentStart(): void {
    this.working = true;
    this.runId += 1;
    this.runStartedAt = Date.now();
    this.setThinkingMessage();
    this.refresh();
  }

  toolStart(toolCallId: string, toolName: string, args: unknown): void {
    this.working = true;
    this.tools++;
    if ((toolName === 'edit' || toolName === 'write') && typeof (args as { path?: unknown } | undefined)?.path === 'string') {
      this.files.add((args as { path: string }).path);
    }
    if ((toolName === 'bash' || toolName === 'powershell')
      && typeof (args as { command?: unknown } | undefined)?.command === 'string') {
      this.bashCommands.set(toolCallId, (args as { command: string }).command);
    }
    this.phrase = workingPhrase(toolName, args);
    if (this.visible) this.ctx?.ui.setWorkingMessage(this.phrase);
    this.setTitle();
    this.refresh();
  }

  toolEnd(toolCallId: string, toolName: string, isError: boolean): void {
    if (isError) this.checkpoints.discard(toolCallId);
    else this.checkpoints.finalize(toolCallId);
    const command = this.bashCommands.get(toolCallId);
    this.bashCommands.delete(toolCallId);
    if (command && (toolName === 'bash' || toolName === 'powershell')) {
      this.updateCheckStatus(command, isError);
    }
    // Usage lands with the assistant message that requested this tool.
    this.refreshTotals();
    this.setThinkingMessage();
    this.refresh();
  }

  settled(aborted: boolean): void {
    const elapsed = this.runStartedAt > 0 ? Date.now() - this.runStartedAt : 0;
    this.runStartedAt = 0;
    this.working = false;
    this.phrase = 'beliebing…';
    this.refreshTotals();
    if (this.visible) {
      void this.subscription.refresh();
      this.ctx?.ui.setWorkingMessage('beliebing…');
      this.ctx?.ui.setHiddenThinkingLabel('beliebing…');
    }
    this.setTitle();
    this.refresh();
    if (this.shouldNotify(elapsed)) this.sendNotification(elapsed, aborted);
  }

  dispose(): void {
    this.subscription.stop();
    this.resetPlanMode();
    this.ctx = undefined;
    this.headerTui = undefined;
    this.footerTui = undefined;
  }

  snapshot(): CardData {
    return {
      mood: moods[this.config.mood].label,
      branch: this.branch,
      views: this.turns,
      since: this.since,
      playing: 'lofi & lints',
      plan: this.planMode,
    };
  }

  stats(): string[] {
    const usage = this.ctx?.getContextUsage?.();
    const percent = usage?.percent;
    const tokens = usage?.tokens;
    const window = usage?.contextWindow;
    const totals = this.totals;
    return [
      `mode       ${this.planMode ? 'plan' : 'belieb'}`,
      `mood       ${moods[this.config.mood].label}`,
      `model      ${this.ctx?.model?.name ?? 'no model'}`,
      `context    ${percent === null || percent === undefined ? 'unknown' : `${Math.round(percent)}%`}`
        + (tokens && window ? ` (${formatTokens(tokens)} / ${formatTokens(window)})` : ''),
      `turns      ${this.turns}`,
      `tools      ${this.tools}`,
      `files      ${this.files.size}`,
      `undo       ${this.checkpoints.size} snapshot${this.checkpoints.size === 1 ? '' : 's'}`
        + (this.checkpoints.redoCount > 0 ? ` · ${this.checkpoints.redoCount} redoable` : ''),
      `notify     ${this.config.notify ? 'on' : 'off'}`,
      `limits     ${this.config.openCodeUsage ? 'OpenCode login for native OpenAI (may be a different account)' : 'Pi login'}`,
      `mcp        ${this.mcpServers().map(server => server.name).join(', ') || 'none'}`,
      `branch     ${this.branch ?? 'none'}`,
      `plain      ${this.config.plain ? 'on' : 'off'}`,
      ...costLines(totals),
    ];
  }

  mcpServers(): McpServerInfo[] {
    return activeMcpServers(this.pi.getAllTools());
  }

  /** Cost/token panel for `/cost`. */
  costPanel(): string[] {
    this.refreshTotals();
    const usage = this.ctx?.getContextUsage?.();
    const lines = costLines(this.totals);
    if (usage?.percent !== null && usage?.percent !== undefined) {
      lines.push(`context    ${Math.round(usage.percent)}% of ${formatTokens(usage.contextWindow)}`);
    }
    if (this.totals.cost > 0 && this.totals.cacheRead > 0) {
      // Cache reads usually cost a fraction of fresh input tokens.
      lines.push(`cache      ${formatTokens(this.totals.cacheRead)} read · ${formatTokens(this.totals.cacheWrite)} write`);
    }
    return lines;
  }

  private refreshTotals(): void {
    try {
      this.totals = sessionTotals(this.ctx?.sessionManager?.getEntries?.());
    } catch {
      this.totals = emptyTotals();
    }
  }

  private get visible(): boolean {
    return this.ctx?.mode === 'tui' && !this.config.plain;
  }

  private stampLogin(): void {
    const now = new Date();
    this.since = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  }

  private rollRareLine(): string | undefined {
    const mode = process.env.BELIEB_RARE;
    if (mode === 'never' || mode === '0') return undefined;
    if (mode === 'always' || mode === '1') return rareThinkingLines[0];
    return Math.random() < 0.01 ? rareThinkingLines[0] : undefined;
  }

  /**
   * The label while the model thinks: "beliebing…", or roughly one time in a
   * hundred the rare line instead. Rolled per thinking phase, so the joke is a
   * rare flash rather than a whole-run theme.
   */
  private setThinkingMessage(): void {
    this.phrase = this.rollRareLine() ?? 'beliebing…';
    if (this.visible) {
      this.ctx?.ui.setWorkingMessage(this.phrase);
      this.ctx?.ui.setHiddenThinkingLabel(this.phrase);
    }
    this.setTitle();
  }

  private updateCheckStatus(command: string, isError: boolean): void {
    const kind = checkKind(command);
    if (!kind || !this.visible) return;
    this.checks.set(kind, !isError);
    // Keep every kind visible, not just whichever command ran last.
    const badge = checkOrder
      .filter(name => this.checks.has(name))
      .map(name => `${name} ${this.checks.get(name) ? '✓' : '✗'}`)
      .join(' · ');
    this.ctx?.ui.setStatus('belieb-checks', badge);
  }

  private shouldNotify(elapsed: number): boolean {
    return shouldNotify(this.config.notify, elapsed)
      && this.ctx?.mode === 'tui'
      && Boolean(process.stdout.isTTY);
  }

  private sendNotification(elapsed: number, aborted: boolean): void {
    const cwd = this.ctx?.cwd ?? process.cwd();
    const message = notificationText(cwd, elapsed, aborted);
    process.stdout.write(notificationSequence(message, Boolean(process.env.TMUX)));
    if (this.visible) this.ctx?.ui.setTitle(aborted ? '♥ belieb · cancelled' : '♥ belieb · done');
  }

  private restorePlanTools(): void {
    if (!this.savedTools) return;
    this.pi.setActiveTools(this.savedTools);
    this.savedTools = undefined;
  }

  private resetPlanMode(): void {
    this.restorePlanTools();
    this.planMode = false;
  }

  private install(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.mode !== 'tui') return;
    // --use-theme and NO_COLOR keep the palette the user asked for.
    if (!this.themeLocked && !process.env.NO_COLOR && this.baseTheme) {
      ctx.ui.setTheme(themeFor(this.baseTheme, this.config.mood));
    }
    ctx.ui.setWorkingMessage('beliebing…');
    ctx.ui.setWorkingIndicator({ frames: this.frames(), intervalMs: 180 });
    ctx.ui.setHiddenThinkingLabel('beliebing…');
    ctx.ui.setTitle(this.title());
    ctx.ui.setHeader((tui, theme) => {
      this.headerTui = tui;
      return {
        invalidate() {},
        render: (width: number) => renderCard(width, theme, this.snapshot()),
      };
    });
    ctx.ui.setFooter((tui, theme, data) => {
      this.footerTui = tui;
      return {
        invalidate() {},
        render: (width: number) => this.renderFooter(width, theme, data),
      };
    });
    this.subscription.start(ctx, this.config.openCodeUsage);
  }

  private frames(): string[] {
    const frames = ['♪', '♫', '♪', '♬'];
    if (process.env.NO_COLOR) return frames;
    const theme = this.ctx?.ui.theme;
    if (!theme || typeof theme.fg !== 'function') return frames;
    return frames.map((frame, index) => theme.fg(index === 3 ? 'borderAccent' : 'accent', frame));
  }

  private title(): string {
    const repo = this.ctx?.cwd.split(/[\\/]/).filter(Boolean).pop() ?? 'belieb';
    if (this.planMode) {
      return `⏸ plan · ${repo}`;
    }
    if (this.working) {
      return `♪ ${this.phrase.replace(/…$/, '')} · ${repo}`;
    }
    return `♥ belieb · ${repo}`;
  }

  private setTitle(): void {
    if (!this.visible) return;
    this.ctx?.ui.setTitle(this.title());
  }

  private renderFooter(width: number, theme: Theme, data: ReadonlyFooterDataProvider): string[] {
    this.branch = data.getGitBranch();
    const color = !process.env.NO_COLOR && typeof theme.fg === 'function';
    const paint = (token: ThemeColor, text: string) => color ? theme.fg(token, text) : text;
    const segments: string[] = [];
    const add = (segment: string | undefined) => {
      if (!segment) return;
      if (visibleWidth([...segments, segment].join(' · ')) <= width) segments.push(segment);
    };

    add(this.planMode ? paint('warning', '⏸ plan') : paint('accent', '♥ belieb'));
    // Allowances take priority over model/branch metadata on narrow terminals.
    for (const quota of this.subscription.segments()) add(paint(quota.low ? 'warning' : 'dim', quota.text));
    if (width >= 78 && this.ctx?.model?.name) add(paint('muted', this.ctx.model.name));
    if (width >= 58 && this.branch) add(paint('mdHeading', this.branch));
    const percent = this.ctx?.getContextUsage?.()?.percent;
    if (width >= 40 && percent !== null && percent !== undefined) {
      add(paint(percent >= 80 ? 'warning' : 'dim', `ctx ${Math.round(percent)}%`));
    }
    const spend = costSegment(this.totals);
    if (width >= 56 && spend) add(paint('dim', spend));
    const mcp = width >= 50 ? this.mcpServers() : [];
    if (mcp.length > 0) add(paint('dim', `mcp ${mcp.length}`));
    if (this.working) add(paint('accent', '♪ working'));

    // Keep other extensions' setStatus() text visible; the built-in footer would show it.
    const statuses = typeof data.getExtensionStatuses === 'function'
      ? [...data.getExtensionStatuses()]
      : [];
    for (const [key, status] of statuses) {
      // pi-usage cannot use OpenCode's login. Its native ChatGPT fallback would
      // contradict the explicitly selected source; leave all other statuses alone.
      if (key === 'usage' && this.config.openCodeUsage && this.ctx?.model?.provider === 'openai'
        && status.startsWith('chatgpt ')) continue;
      const token: ThemeColor = key === 'belieb-checks'
        ? status.includes('✗') ? 'error' : 'success'
        : 'muted';
      add(paint(token, status));
    }

    const line = segments.length > 0 ? segments.join(' · ') : paint('accent', '♥ belieb');
    return [truncateToWidth(line, Math.max(0, width), '', false)];
  }

  private refresh(): void {
    this.headerTui?.requestRender();
    this.footerTui?.requestRender();
  }
}

function costLines(totals: Totals): string[] {
  const total = billedTokens(totals);
  return [
    `cost       ${formatUsd(totals.cost)}`,
    `tokens     ${formatTokens(total)} total (${formatTokens(totals.input)} in · ${formatTokens(totals.output)} out)`,
  ];
}
