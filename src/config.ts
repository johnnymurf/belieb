import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { isMood, type Mood } from './palettes.js';

export interface BeliebersConfig {
  model: string | null;
  parallelism: number;
  access: 'read' | 'write';
}

export interface BeliebConfig {
  mood: Mood;
  plain: boolean;
  notify: boolean;
  openCodeUsage: boolean;
  beliebers: BeliebersConfig;
}

export const MAX_BELIEBERS = 4;

export function beliebersConfig(value?: Partial<BeliebersConfig> | null): BeliebersConfig {
  const parallelism = value?.parallelism;
  return {
    model: typeof value?.model === 'string' && /^[^\s/]+\/\S+$/.test(value.model)
      ? value.model : null,
    parallelism: typeof parallelism === 'number' && Number.isInteger(parallelism)
      && parallelism >= 1 && parallelism <= MAX_BELIEBERS ? parallelism : 2,
    access: value?.access === 'write' ? 'write' : 'read',
  };
}

const defaults = { mood: 'purpose' as Mood, plain: false, notify: false, openCodeUsage: false };

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
      openCodeUsage: value.openCodeUsage === true,
      beliebers: beliebersConfig(value.beliebers),
    };
  } catch {
    return {
      ...defaults,
      plain: forcedPlain,
      notify: forcedNotify === '1',
      beliebers: beliebersConfig(),
    };
  }
}

export function saveConfig(config: BeliebConfig): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`);
}
