import type { Theme } from '@earendil-works/pi-coding-agent';
import {
  foregroundAnsi, rgbColor, truncateToWidth, type TerminalColorMode,
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

export interface CardData {
  mood: string;
  branch: string | null;
  views: number;
  since: string;
  playing: string;
  plan: boolean;
}

export interface PanelData {
  title: string;
  lines: string[];
}

/** Pink-to-lilac gradient for the wordmark, darker on light terminals. */
function gradient(text: string, mode: TerminalColorMode, light = false): string {
  const key = `${mode}|${light ? 1 : 0}|${text}`;
  const cached = gradientCache.get(key);
  if (cached !== undefined) return cached;
  const chars = [...text];
  const from = light ? [150, 55, 105] : [255, 158, 203];
  const to = light ? [106, 75, 168] : [177, 140, 240];
  const painted = chars.map((char, index) => {
    const t = chars.length === 1 ? 0 : index / (chars.length - 1);
    return foregroundAnsi(rgbColor(
      Math.round(from[0] + (to[0] - from[0]) * t),
      Math.round(from[1] + (to[1] - from[1]) * t),
      Math.round(from[2] + (to[2] - from[2]) * t),
    ), mode) + char;
  }).join('') + '\x1b[39m';
  // The header re-renders on every frame while streaming; the art is static.
  if (gradientCache.size > 256) gradientCache.clear();
  gradientCache.set(key, painted);
  return painted;
}

const gradientCache = new Map<string, string>();

function compose(left: string, right: string, width: number): string {
  if (!right) return left.slice(0, width).padEnd(width);
  const gap = width - left.length - right.length;
  if (gap < 1) return left.slice(0, width).padEnd(width);
  return left + ' '.repeat(gap) + right;
}

function colorMode(theme: Theme): TerminalColorMode {
  return typeof theme.getColorMode === 'function' ? theme.getColorMode() : 'truecolor';
}

function hasForeground(theme: Theme): boolean {
  return typeof theme.fg === 'function';
}

/** The Myspace profile card used as the startup header and by /belieb card. */
export function renderCard(width: number, theme: Theme, data: CardData): string[] {
  const color = !process.env.NO_COLOR && hasForeground(theme);
  const isLight = theme.appearance === 'light';
  const mode = colorMode(theme);
  type CardColor = 'accent' | 'muted' | 'mdHeading';
  const paint = (text: string, token: CardColor) => color ? theme.fg(token, text) : text;

  // Below 70 columns, or on a short terminal, the border card costs more
  // than it gives; collapse to a compact header, like Crush.
  const short = typeof process.stdout.rows === 'number'
    && process.stdout.rows > 0 && process.stdout.rows < 28;
  if (width < 70 || short) {
    const title = '♥ belieb ♥';
    const lines = [
      title + '  ·  powered by Pi',
      'mood: beliebing in your code',
      '/belieb  ·  /login  ·  /model  ·  Esc cancels',
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

  const branch = data.branch ? ` · ${data.branch}` : '';
  const details: [string, CardColor][] = [
    ['♥ welcome back, bestie', 'accent'],
    [data.plan ? 'mood: plan mode · read-only' : 'mood: beliebing in your code', 'mdHeading'],
    ['top friends: you, jb & git', 'muted'],
    [`♫ now playing: ${data.mood} · ${data.playing}${branch}`, 'muted'],
    ['/belieb  /login  /model  ·  Esc cancels', 'muted'],
    [`profile views: ${data.views}  ·  last login: ${data.since}`, 'muted'],
  ];

  const rows: string[] = [margin + top];
  for (let row = 0; row < avatarRows.length; row++) {
    const art = avatarRows[row];
    const left = (color ? gradient(art, mode, isLight) : art) + ' '.repeat(gap);
    let right: string;
    if (row >= 4 && row <= 7) {
      const word = logo[row - 4].padEnd(logoWidth + 2);
      const hack = (hackLines[row - 4] ?? '').padEnd(Math.max(0, textWidth - word.length));
      right = truncateToWidth(
        (color ? gradient(word, mode, isLight) : word) + paint(hack, 'muted'), textWidth, '', false,
      );
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
}

/** A small titled panel for /belieb stats and /belieb credits. */
export function renderPanel(width: number, theme: Theme, data: PanelData): string[] {
  const color = !process.env.NO_COLOR && hasForeground(theme);
  const paint = (text: string, token: 'accent' | 'muted' | 'dim') => color ? theme.fg(token, text) : text;
  const panelWidth = Math.min(Math.max(0, width), 96);
  const rule = '─'.repeat(Math.max(0, panelWidth - 2));
  const lines = [
    paint(`♥ ${data.title}`, 'accent'),
    paint(rule, 'dim'),
    ...data.lines.map(line => paint(line, 'muted')),
  ];
  return lines.map(line => truncateToWidth(line, Math.max(0, width), '', false));
}
