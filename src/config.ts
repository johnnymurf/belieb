import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { isMood, type Mood } from './palettes.js';

export interface BeliebConfig {
  mood: Mood;
  plain: boolean;
  notify: boolean;
}

const defaults: BeliebConfig = { mood: 'purpose', plain: false, notify: false };

/** BELIEB_DIR keeps this separate from Pi's own agent directory. */
export function configDir(): string {
  return process.env.BELIEB_DIR || join(homedir(), '.belieb');
}

export function configPath(): string {
  return join(configDir(), 'config.json');
}

export function loadConfig(): BeliebConfig {
  const forcedPlain = process.env.BELIEB_PLAIN === '1';
  const forcedNotify = process.env.BELIEB_NOTIFY;
  try {
    const value = JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<BeliebConfig>;
    return {
      mood: typeof value.mood === 'string' && isMood(value.mood) ? value.mood : defaults.mood,
      plain: forcedPlain || value.plain === true,
      notify: forcedNotify === '1' ? true : forcedNotify === '0' ? false : value.notify === true,
    };
  } catch {
    return {
      ...defaults,
      plain: forcedPlain,
      notify: forcedNotify === '1',
    };
  }
}

export function saveConfig(config: BeliebConfig): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`);
}
