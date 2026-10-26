import { DynamicBorder, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { Container, SelectList, Text, type SelectItem } from '@earendil-works/pi-tui';

/** A model from Pi's registry, shown as `provider/id`. */
export interface ModelChoice {
  provider: string;
  id: string;
}

// Rows the picker keeps for its borders, title, hint, scroll indicator, and the editor beneath it.
const CHROME_ROWS = 10;
const MIN_VISIBLE_ROWS = 3;
const MAX_VISIBLE_ROWS = 20;

/**
 * Bound the list to the terminal so a long model registry scrolls inside the
 * picker instead of pushing the cursor below the visible screen.
 */
function visibleRows(rows: number | undefined, count: number): number {
  const room = Math.floor((rows ?? 24) - CHROME_ROWS);
  return Math.max(MIN_VISIBLE_ROWS, Math.min(count, MAX_VISIBLE_ROWS, room));
}

function itemsFor(models: ModelChoice[], current: string | null): SelectItem[] {
  return models.map(model => ({
    value: `${model.provider}/${model.id}`,
    label: model.id,
    description: `${model.provider}${`${model.provider}/${model.id}` === current ? ' · current' : ''}`,
  }));
}

/** Pick a Beliebers model with a scrolling list, falling back to Pi's selector for RPC. */
export async function pickModel(
  ctx: ExtensionCommandContext,
  models: ModelChoice[],
  current: string | null,
): Promise<string | undefined> {
  const items = itemsFor(models, current);
  if (ctx.mode !== 'tui') {
    return await ctx.ui.select('Beliebers model', items.map(item => item.value));
  }

  const result = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((text: string) => theme.fg('accent', text)));
    container.addChild(new Text(theme.fg('accent', theme.bold('♥ beliebers model'))));

    const list = new SelectList(items, visibleRows(tui.terminal?.rows, items.length), {
      selectedPrefix: (text: string) => theme.fg('accent', text),
      selectedText: (text: string) => theme.fg('accent', text),
      description: (text: string) => theme.fg('muted', text),
      scrollInfo: (text: string) => theme.fg('dim', text),
      noMatch: (text: string) => theme.fg('warning', text),
    }, {
      minPrimaryColumnWidth: 24,
      maxPrimaryColumnWidth: 40,
    });
    const currentIndex = items.findIndex(item => item.value === current);
    if (currentIndex >= 0) list.setSelectedIndex(currentIndex);
    list.onSelect = item => done(item.value);
    list.onCancel = () => done(null);
    container.addChild(list);

    container.addChild(new Text(theme.fg('dim', '↑↓ scroll · enter select · esc cancel')));
    container.addChild(new DynamicBorder((text: string) => theme.fg('accent', text)));

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        list.handleInput(data);
        tui.requestRender();
      },
    };
  });

  return result ?? undefined;
}
