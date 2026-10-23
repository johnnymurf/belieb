import { Theme, type ExtensionAPI, type ThemeToken } from '@earendil-works/pi-coding-agent';
import {
  colorToHex, foregroundAnsi, rgbColor, type TerminalColorMode,
} from '@earendil-works/pi-tui';

import { avatarRows, avatarWidth } from './portrait.js';

const logo = [
  ' ___ ___ _    ___ ___ ___ ',
  '| _ ) __| |  |_ _| __| _ )',
  '| _ \\ _|| |__ | || _|| _ \\',
  '|___/___|____|___|___|___/',
];
const logoWidth = 26;
const hackLines = ["", ">_ sudo beliebe --now", "[##########] 100%", "0x1337 ▓▒░ pi/ok"];

/** Pink-to-lilac gradient for the wordmark, darker on light terminals. */
function gradient(text: string, mode: TerminalColorMode, light = false): string {
  const chars = [...text];
  const from = light ? [150, 55, 105] : [255, 158, 203];
  const to = light ? [106, 75, 168] : [177, 140, 240];
  return chars.map((char, index) => {
    const t = chars.length === 1 ? 0 : index / (chars.length - 1);
    return foregroundAnsi(rgbColor(
      Math.round(from[0] + (to[0] - from[0]) * t),
      Math.round(from[1] + (to[1] - from[1]) * t),
      Math.round(from[2] + (to[2] - from[2]) * t),
    ), mode) + char;
  }).join('') + '\x1b[39m';
}

function compose(left: string, right: string, width: number): string {
  if (!right) return left.slice(0, width).padEnd(width);
  const gap = width - left.length - right.length;
  if (gap < 1) return left.slice(0, width).padEnd(width);
  return left + ' '.repeat(gap) + right;
}

export default function belieb(pi: ExtensionAPI): void {
  pi.on('session_start', (_event, ctx) => {
    // hasUI alone includes RPC. Branding must never enter protocol output.
    if (ctx.mode !== 'tui') return;
    const base = ctx.ui.theme;
    const light = base.appearance === 'light';
    const colors = {
      ...Object.fromEntries(Object.entries(base.colors).map(([key, value]) => [key, colorToHex(value)])) as Record<ThemeToken, string>,
      accent: light ? '#963769' : '#e8a0c5',
      border: light ? '#7851a9' : '#aa8bd1',
      borderAccent: light ? '#963769' : '#e8a0c5',
      mdHeading: light ? '#7851a9' : '#c6ace4',
    };
    // Preserve readable text, backgrounds, syntax and semantic error/diff colors.
    if (!process.env.NO_COLOR && !process.argv.includes('--use-theme')) {
      ctx.ui.setTheme(new Theme(colors, colors, base.getColorMode(), {
        name: 'belieb', appearance: base.appearance,
      }));
    }
    ctx.ui.setWorkingMessage('beliebing…');
    ctx.ui.setHeader((_tui, theme) => ({
      invalidate() {},
      render(width: number) {
        const color = !process.env.NO_COLOR;
        const isLight = theme.appearance === 'light';
        const mode: TerminalColorMode = typeof theme.getColorMode === 'function'
          ? theme.getColorMode() : 'truecolor';
        type HeaderColor = 'accent' | 'muted' | 'mdHeading';
        const paint = (text: string, token: HeaderColor) => color ? theme.fg(token, text) : text;

        const details: [string, HeaderColor][] = [
          ['♥ welcome back, bestie', 'accent'],
          ['mood: beliebing in your code', 'mdHeading'],
          ['top friends: you, jb & git', 'muted'],
          ['♫ now playing: lofi & lints', 'muted'],
          ['/login  /model  /resume  ·  Esc cancels', 'muted'],
          ['profile views: 1  ·  last login: now', 'muted'],
        ];

        // Below 70 columns, or on a short terminal, the border card costs more
        // than it gives; collapse to a compact header, like Crush.
        const short = typeof process.stdout.rows === 'number'
          && process.stdout.rows > 0 && process.stdout.rows < 28;
        if (width < 70 || short) {
          const title = '♥ belieb ♥';
          const lines = [
            title + '  ·  powered by Pi',
            'mood: beliebing in your code',
            '/login  /model  /resume  ·  Esc cancels',
          ];
          const first = color && width >= 30
            ? gradient(title, mode, isLight) + paint('  ·  powered by Pi', 'muted')
            : lines[0];
          if (color && width >= 30) {
            return [first, ...lines.slice(1).map(line => line.slice(0, width)), ''];
          }
          return [first, ...lines.slice(1), ''].map(line => line.slice(0, Math.max(0, width)));
        }

        const boxWidth = Math.min(width, 96);
        const margin = ' '.repeat(Math.max(0, Math.floor((width - boxWidth) / 2)));
        const inner = boxWidth - 2;
        const avatarCols = avatarWidth;
        const gap = 3;
        const textWidth = inner - avatarCols - gap - 2;

        const title = '♥ belieb ♥';
        const fill = Math.max(0, boxWidth - title.length - 5);
        const top = paint('╭─ ', 'accent')
          + (color ? gradient(title, mode, isLight) : title)
          + paint(' ' + '─'.repeat(fill) + '╮', 'accent');

        const rows: string[] = [margin + top];
        for (let row = 0; row < avatarRows.length; row++) {
          const art = avatarRows[row];
          const left = (color ? gradient(art, mode, isLight) : art) + ' '.repeat(gap);
          let right: string;
          if (row >= 4 && row <= 7) {
            const word = logo[row - 4].padEnd(logoWidth + 2);
            const hack = (hackLines[row - 4] ?? '').padEnd(Math.max(0, textWidth - word.length));
            right = (color ? gradient(word, mode, isLight) : word) + paint(hack, 'muted');
          } else if (row >= 9 && row <= 14) {
            const detail = details[row - 9];
            right = paint(compose(detail[0], row === 9 ? '● online' : '', textWidth), detail[1]);
          } else {
            right = ' '.repeat(textWidth);
          }
          rows.push(margin + paint('│', 'accent') + ' ' + left + right + ' ' + paint('│', 'accent'));
        }
        rows.push(margin + paint('╰' + '─'.repeat(boxWidth - 2) + '╯', 'accent'), '');
        return rows;
      },
    }));
  });
}
