import {
  DynamicBorder, type ExtensionCommandContext, type KeybindingsManager, type Theme,
} from '@earendil-works/pi-coding-agent';
import {
  Container, Input, SelectList, Text, getKeybindings,
  type Component, type Focusable, type SelectItem, type TUI,
} from '@earendil-works/pi-tui';

import type { MarketEntry } from './market.js';

/** Quiet period after the last keystroke before the registry is asked again. */
export const SEARCH_DEBOUNCE_MS = 250;

// Rows the picker keeps for borders, title, search box, status, scroll indicator and
// the editor beneath it. One row of slack keeps a full-height list off the cursor line.
const CHROME_ROWS = 12;
const MIN_VISIBLE_ROWS = 3;
const MAX_VISIBLE_ROWS = 18;

export interface MarketBrowserSource {
  /** Catalog label shown in the title, e.g. `npm pi-package`. */
  label: string;
  /** What an empty query lists, e.g. `most downloaded this month`. */
  popularHint: string;
  /** What a query searches, e.g. `Pi packages`. */
  searchHint: string;
  loadPopular(signal: AbortSignal): Promise<MarketEntry[]>;
  loadSearch(query: string, signal: AbortSignal): Promise<MarketEntry[]>;
}

function visibleRows(rows: number | undefined, count: number): number {
  const room = Math.floor((rows ?? 24) - CHROME_ROWS);
  return Math.max(MIN_VISIBLE_ROWS, Math.min(count, MAX_VISIBLE_ROWS, room));
}

function shortNumber(monthly: number): string {
  if (monthly >= 1_000_000) return `${(monthly / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (monthly >= 1_000) return `${(monthly / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(monthly);
}

/** `1.8M/mo`, compact enough for a picker row and explicit about the period. */
export function downloadsLabel(monthly: number): string {
  return `${shortNumber(Math.max(0, Math.floor(monthly)))}/mo`;
}

/** Picker rows: the published name, then popularity, pinned version and description. */
export function entryItems(entries: MarketEntry[]): SelectItem[] {
  return entries.map(entry => ({
    value: entry.key,
    label: entry.name,
    description: [
      entry.downloads === undefined ? undefined : downloadsLabel(entry.downloads),
      entry.version,
      entry.blocked ? 'manual setup' : entry.description,
    ].filter((part): part is string => part !== undefined).join(' · '),
  }));
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export interface MarketBrowserOptions {
  source: MarketBrowserSource;
  initialQuery?: string;
  debounceMs?: number;
  keybindings?: KeybindingsManager;
}

/**
 * Browse a registry without blocking on a prompt: an empty query lists the
 * catalog's default order and typing re-queries as you go. Results update in
 * place, so Enter always selects something the reader can currently see.
 */
export class MarketBrowser implements Component, Focusable {
  private readonly container = new Container();
  private readonly results = new Container();
  private readonly input: Input;
  private readonly status: Text;
  private list: SelectList;
  private items: SelectItem[] = [];
  private entries = new Map<string, MarketEntry>();
  private requestId = 0;
  private controller?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private _focused = false;

  constructor(
    private readonly tui: Pick<TUI, 'requestRender' | 'terminal'>,
    private readonly theme: Theme,
    private readonly options: MarketBrowserOptions,
    private readonly finish: (entry: MarketEntry | null) => void,
  ) {
    const { source } = options;
    this.status = new Text('');

    this.container.addChild(new DynamicBorder((text: string) => theme.fg('accent', text)));
    this.container.addChild(new Text(theme.fg('accent', theme.bold(`♥ market · ${source.label}`))));

    this.input = new Input({
      prompt: theme.fg('accent', '› '),
      placeholder: `type to search ${source.searchHint} · enter picks · esc cancels`,
      placeholderStyle: (text: string) => theme.fg('dim', text),
    });
    this.input.setValue(options.initialQuery ?? '');
    this.container.addChild(this.input);

    this.list = this.makeList([]);
    this.results.addChild(this.status);
    this.results.addChild(this.list);
    this.container.addChild(this.results);

    this.container.addChild(new Text(theme.fg('dim',
      'type to search · ↑↓ scroll · enter details · esc clears the query, then cancels')));
    this.container.addChild(new DynamicBorder((text: string) => theme.fg('accent', text)));

    void this.refresh((options.initialQuery ?? '').trim(), 0);
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  render(width: number): string[] {
    return this.container.render(width);
  }

  invalidate(): void {
    this.container.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    this.controller = undefined;
  }

  handleInput(data: string): void {
    const keybindings = this.options.keybindings ?? getKeybindings();
    // Navigation and confirmation belong to the list; everything else edits the query.
    if (
      keybindings.matches(data, 'tui.select.up')
      || keybindings.matches(data, 'tui.select.down')
    ) {
      this.list.handleInput(data);
      this.tui.requestRender();
      return;
    }
    if (keybindings.matches(data, 'tui.select.confirm')) {
      this.selectCurrent();
      return;
    }
    if (keybindings.matches(data, 'tui.select.cancel')) {
      // A non-empty query is cleared first, so escape never loses the catalog.
      if (this.input.getValue().length > 0) {
        this.input.setValue('');
        this.schedule(0);
      } else {
        this.finish(null);
      }
      this.tui.requestRender();
      return;
    }

    const before = this.input.getValue();
    this.input.handleInput(data);
    if (this.input.getValue() !== before) this.schedule();
    this.tui.requestRender();
  }

  /** Debounced so a burst of keystrokes costs one registry request, not one each. */
  private schedule(delay = this.options.debounceMs ?? SEARCH_DEBOUNCE_MS): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh(this.input.getValue().trim());
    }, delay);
  }

  private async refresh(query: string, requestId = ++this.requestId): Promise<void> {
    if (this.disposed) return;
    this.requestId = requestId;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.setStatus(this.theme.fg('dim', query ? `searching for “${query}”…` : 'loading…'));

    try {
      const entries = query
        ? await this.options.source.loadSearch(query, controller.signal)
        : await this.options.source.loadPopular(controller.signal);
      // A slower earlier request must never overwrite a newer query's results.
      if (this.disposed || requestId !== this.requestId) return;
      this.show(query, entries);
    } catch (error) {
      if (this.disposed || requestId !== this.requestId) return;
      const message = error instanceof Error ? error.message : String(error);
      this.show(query, [], this.theme.fg('warning', `market: ${message}`));
    }
    this.tui.requestRender();
  }

  private show(query: string, entries: MarketEntry[], warning?: string): void {
    this.entries = new Map(entries.map(entry => [entry.key, entry]));
    this.items = entryItems(entries);
    const selected = this.list.getSelectedItem();
    this.list = this.makeList(this.items);
    if (selected) this.list.setSelectedIndex(this.items.findIndex(item => item.value === selected.value));

    this.results.clear();
    const { source } = this.options;
    this.setStatus(warning ?? this.theme.fg('dim', entries.length === 0
      ? (query ? `no ${source.searchHint} matched “${query}”` : 'nothing to browse right now')
      : query
        ? `${plural(entries.length, 'match', 'matches')} for “${query}”`
        : `${source.popularHint} · ${plural(entries.length, 'entry', 'entries')}`));
    this.results.addChild(this.status);
    if (entries.length > 0) this.results.addChild(this.list);
    this.container.invalidate();
  }

  private setStatus(text: string): void {
    this.status.setText(text);
  }

  private makeList(items: SelectItem[]): SelectList {
    const { theme } = this;
    const list = new SelectList(items, visibleRows(this.tui.terminal?.rows, items.length), {
      selectedPrefix: (text: string) => theme.fg('accent', text),
      selectedText: (text: string) => theme.fg('accent', text),
      description: (text: string) => theme.fg('muted', text),
      scrollInfo: (text: string) => theme.fg('dim', text),
      noMatch: (text: string) => theme.fg('warning', text),
    }, { minPrimaryColumnWidth: 20, maxPrimaryColumnWidth: 38 });
    list.onSelect = item => this.finish(this.entries.get(item.value) ?? null);
    list.onCancel = () => this.finish(null);
    return list;
  }

  private selectCurrent(): void {
    const item = this.list.getSelectedItem();
    if (item) this.finish(this.entries.get(item.value) ?? null);
  }
}

/** Browse in the TUI; other modes fall back to the caller's prompt-then-select path. */
export async function browseMarket(
  ctx: ExtensionCommandContext,
  source: MarketBrowserSource,
  initialQuery?: string,
): Promise<MarketEntry | undefined> {
  const entry = await ctx.ui.custom<MarketEntry | null>((tui, theme, keybindings, done) => {
    const browser = new MarketBrowser(tui, theme, {
      source,
      keybindings,
      ...(initialQuery ? { initialQuery } : {}),
    }, done);
    return browser;
  });
  return entry ?? undefined;
}
