import { Theme, type ThemeToken } from '@earendil-works/pi-coding-agent';
import { colorToHex } from '@earendil-works/pi-tui';

/** Colors that carry the mood; everything else stays as readable as Pi's base theme. */
export interface MoodPalette {
  accent: string;
  border: string;
  borderAccent: string;
  mdHeading: string;
}

/**
 * Five restrained palettes named after albums. Each has a light and dark variant so
 * a mood never fights the terminal's background.
 */
export const moods = {
  purpose: {
    label: 'Purpose',
    dark: { accent: '#e8a0c5', border: '#aa8bd1', borderAccent: '#e8a0c5', mdHeading: '#c6ace4' },
    light: { accent: '#963769', border: '#7851a9', borderAccent: '#963769', mdHeading: '#7851a9' },
  },
  changes: {
    label: 'Changes',
    dark: { accent: '#b9a6ff', border: '#8478d8', borderAccent: '#b9a6ff', mdHeading: '#a294f0' },
    light: { accent: '#5442ac', border: '#6b5bb5', borderAccent: '#5442ac', mdHeading: '#56459f' },
  },
  justice: {
    label: 'Justice',
    dark: { accent: '#7fd4e8', border: '#4f9fc4', borderAccent: '#7fd4e8', mdHeading: '#a7e3f2' },
    light: { accent: '#176b8a', border: '#2a6f94', borderAccent: '#176b8a', mdHeading: '#1d5f7d' },
  },
  peaches: {
    label: 'Peaches',
    dark: { accent: '#ffb59b', border: '#e0927f', borderAccent: '#ffb59b', mdHeading: '#ffd0bd' },
    light: { accent: '#b4523a', border: '#b86b52', borderAccent: '#b4523a', mdHeading: '#9c4934' },
  },
  myworld: {
    label: 'My World',
    dark: { accent: '#8fe8c4', border: '#4fb59a', borderAccent: '#8fe8c4', mdHeading: '#b3f2da' },
    light: { accent: '#166f57', border: '#2a7a63', borderAccent: '#166f57', mdHeading: '#1c6350' },
  },
} satisfies Record<string, { label: string; dark: MoodPalette; light: MoodPalette }>;

export type Mood = keyof typeof moods;

export const moodNames = Object.keys(moods) as Mood[];

export function isMood(value: string): value is Mood {
  return Object.hasOwn(moods, value);
}

/** Build a Pi theme from the base theme's colors plus one mood palette. */
export function themeFor(base: Theme, mood: Mood): Theme {
  const palette = moods[mood][base.appearance === 'light' ? 'light' : 'dark'];
  const colors = {
    ...Object.fromEntries(
      Object.entries(base.colors).map(([key, value]) => [key, colorToHex(value)]),
    ) as Record<ThemeToken, string>,
    ...palette,
  } as Record<ThemeToken, string>;
  // Preserve readable text, backgrounds, syntax and semantic error/diff colors.
  return new Theme(colors, colors, base.getColorMode(), {
    name: `belieb-${mood}`,
    appearance: base.appearance,
  });
}
