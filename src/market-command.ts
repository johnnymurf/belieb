import { type ExtensionAPI, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent';

import {
  configuredServerNames, marketSource, offline,
  popularPiPackages, searchMcpServers, searchPiPackages, type MarketEntry, type MarketSource,
} from './market.js';
import { browseMarket, entryItems, type MarketBrowserSource } from './market-browser.js';
import { installEntry } from './market-install.js';

const SOURCES: { value: MarketSource; label: string; hint: string }[] = [
  { value: 'pi', label: 'Pi packages', hint: 'extensions, skills, prompts and themes' },
  { value: 'mcp', label: 'MCP servers', hint: 'tools for the model, from the official registry' },
];

function sourceLabel(source: MarketSource): string {
  return source === 'pi' ? 'Pi package' : 'MCP server';
}

/** Exact `pi` command a listing would run, for the confirmation screen. */
function installCommand(entry: MarketEntry, scope: 'user' | 'project'): string {
  const args = entry.args ? [...entry.args, ...(scope === 'project' ? ['--local'] : [])] : [];
  return args.length > 0 ? `pi ${args.join(' ')}` : 'manual setup required';
}

export function detailLines(entry: MarketEntry, scope: 'user' | 'project'): string[] {
  return [
    `${sourceLabel(entry.source)} · ${entry.version}`,
    entry.description,
    `publishes as ${entry.name}`,
    ...(entry.homepage ? [`source ${entry.homepage}`] : []),
    `runs: ${installCommand(entry, scope)}`,
    ...entry.notes,
    ...(entry.blocked ? [`cannot install here: ${entry.blocked}`] : []),
  ];
}

/** Non-TUI modes cannot stream keystrokes, so they search once and select once. */
async function pickEntryWithSelect(
  ctx: ExtensionCommandContext, entries: MarketEntry[], source: MarketSource,
): Promise<MarketEntry | undefined> {
  const items = entryItems(entries);
  const choice = await ctx.ui.select(
    `${SOURCES.find(value => value.value === source)?.label ?? 'Market'} results`,
    items.map(item => `${item.label} (${item.description})`),
  );
  if (!choice) return;
  return entries.find(entry => choice.startsWith(entry.name));
}

/** One catalog per source: what an empty query shows, and what a query searches. */
function browserSource(source: MarketSource, cwd: string): MarketBrowserSource {
  if (source === 'pi') {
    return {
      label: 'npm pi-package',
      popularHint: 'most downloaded this month',
      searchHint: 'Pi packages',
      loadPopular: signal => popularPiPackages(signal),
      loadSearch: (query, signal) => searchPiPackages(query, signal),
    };
  }
  return {
    label: 'mcp registry',
    // The registry publishes no download counts and no popularity ordering.
    popularHint: 'first page of the registry (no download counts published)',
    searchHint: 'MCP servers',
    loadPopular: signal => searchMcpServers('', signal, undefined, configuredServerNames(cwd)),
    loadSearch: (query, signal) => searchMcpServers(query, signal, undefined, configuredServerNames(cwd)),
  };
}

async function chooseSource(ctx: ExtensionCommandContext): Promise<MarketSource | undefined> {
  const choice = await ctx.ui.select(
    '♥ market',
    SOURCES.map(source => `${source.label} — ${source.hint}`),
  );
  if (!choice) return;
  return SOURCES.find(source => choice.startsWith(source.label))?.value;
}

async function runMarket(
  args: string, ctx: ExtensionCommandContext, cliPath: string | undefined,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify('the marketplace needs an interactive terminal', 'info');
    return;
  }
  if (offline()) {
    ctx.ui.notify('marketplace needs network access; offline mode is on', 'warning');
    return;
  }

  let scope: 'user' | 'project' = 'user';
  const tokens: string[] = [];
  for (const token of args.trim().split(/\s+/).filter(Boolean)) {
    if (token === '--local' || token === '-l') scope = 'project';
    else tokens.push(token);
  }
  const parsed = tokens[0] ? marketSource(tokens[0]) : undefined;
  let source = parsed;
  const query = (parsed ? tokens.slice(1) : tokens).join(' ').trim();

  source ??= await chooseSource(ctx);
  if (!source) return;

  const catalog = browserSource(source, ctx.cwd);
  let entry: MarketEntry | undefined;

  if (ctx.mode === 'tui') {
    // No blocking prompt: the browser opens on the catalog and searches as you type.
    entry = await browseMarket(ctx, catalog, query || undefined);
    if (!entry) return;
  } else {
    const term = query || (await ctx.ui.input(
      `Search ${source === 'pi' ? 'Pi packages' : 'MCP servers'}`,
      source === 'pi' ? 'for example: usage, browser, memory' : 'for example: filesystem, github, sqlite',
    ))?.trim();
    if (!term) return;

    ctx.ui.notify(`searching ${source === 'pi' ? 'npm' : 'the mcp registry'} for “${term}”…`, 'info');
    let entries: MarketEntry[];
    try {
      entries = await catalog.loadSearch(term, AbortSignal.timeout(20_000));
    } catch (error) {
      ctx.ui.notify(`market: ${error instanceof Error ? error.message : String(error)}`, 'error');
      return;
    }
    if (entries.length === 0) {
      ctx.ui.notify(`no ${source === 'pi' ? 'Pi packages' : 'MCP servers'} matched “${term}”`, 'info');
      return;
    }

    entry = await pickEntryWithSelect(ctx, entries, source);
    if (!entry) return;
  }

  const confirmed = await ctx.ui.confirm(
    `Install ${entry.name}?`,
    `${detailLines(entry, scope).join('\n')}\n\nThis installs third-party code that runs with your user`
      + ` permissions.\nReview the source first. Nothing is installed until you confirm.`,
  );
  if (!confirmed) {
    ctx.ui.notify('nothing installed', 'info');
    return;
  }
  if (!entry.args) {
    ctx.ui.notify(`cannot install from here: ${entry.blocked ?? 'manual setup required'}`, 'warning');
    return;
  }

  ctx.ui.notify(`installing ${entry.name}…`, 'info');
  const result = await installEntry(entry, { cwd: ctx.cwd, scope, ...(cliPath ? { cliPath } : {}) });
  if (result.ok) {
    ctx.ui.notify(`♫ installed ${entry.name} · run /reload to load it`, 'info');
    return;
  }
  ctx.ui.notify(`market install failed: ${result.output.trim().split('\n').slice(-4).join(' ')}`, 'error');
}

export function registerMarket(pi: ExtensionAPI, options: { cliPath?: string } = {}): void {
  pi.registerCommand('market', {
    description: 'Browse and install Pi packages and MCP servers (ask before installing)',
    getArgumentCompletions: (prefix) => {
      const text = prefix.trimStart();
      if (!text.includes(' ')) {
        return ['pi', 'mcp']
          .filter(value => value.startsWith(text))
          .map(value => ({
            value, label: value,
            description: SOURCES.find(source => source.value === value)?.hint ?? '',
          }));
      }
      return [];
    },
    handler: async (args, ctx) => {
      await runMarket(args, ctx, options.cliPath);
    },
  });
}
