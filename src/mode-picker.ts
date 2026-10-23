import { DynamicBorder, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { Container, SelectList, Text, type SelectItem } from '@earendil-works/pi-tui';

export type ModeName = 'plan' | 'belieb';

const descriptions: Record<ModeName, string> = {
  plan: "You're the next chart hit — read-only.",
  belieb: 'Never say never — full tools and edits.',
};

/** A native selector for plan/belieb, with a plain fallback for RPC. */
export async function pickMode(
  ctx: ExtensionCommandContext,
  current: ModeName,
): Promise<ModeName | undefined> {
  if (ctx.mode !== 'tui') {
    if (!ctx.hasUI) return undefined;
    const options = (Object.keys(descriptions) as ModeName[])
      .map(name => `${name} — ${descriptions[name]}`);
    const picked = await ctx.ui.select('♥ choose your mode', options);
    const name = picked?.split(' — ')[0];
    return name === 'plan' || name === 'belieb' ? name : undefined;
  }

  const items: SelectItem[] = (Object.keys(descriptions) as ModeName[]).map(name => ({
    value: name,
    label: `${name === 'plan' ? '⏸' : '♥'} ${name}${name === current ? '  (active)' : ''}`,
    description: descriptions[name],
  }));

  const result = await ctx.ui.custom<ModeName | null>((tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((text: string) => theme.fg('accent', text)));
    container.addChild(new Text(theme.fg('accent', theme.bold('♥ choose your mode'))));

    const list = new SelectList(items, items.length, {
      selectedPrefix: (text: string) => theme.fg('accent', text),
      selectedText: (text: string) => theme.fg('accent', text),
      description: (text: string) => theme.fg('muted', text),
      scrollInfo: (text: string) => theme.fg('dim', text),
      noMatch: (text: string) => theme.fg('warning', text),
    }, {
      minPrimaryColumnWidth: 14,
      maxPrimaryColumnWidth: 22,
    });
    list.onSelect = item => done(item.value === 'plan' ? 'plan' : 'belieb');
    list.onCancel = () => done(null);
    container.addChild(list);

    container.addChild(new Text(theme.fg('dim', '↑↓ navigate · enter select · esc cancel')));
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
