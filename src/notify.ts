import { basename } from 'node:path';

export const notifyThresholdMs = 20_000;

/** Only ping for runs long enough that the user probably tabbed away. */
export function shouldNotify(enabled: boolean, durationMs: number): boolean {
  return enabled && durationMs >= notifyThresholdMs;
}

/** OSC 9 desktop notification, wrapped for tmux passthrough when needed. */
export function notificationSequence(message: string, tmux: boolean): string {
  const safe = message.replace(/[\x00-\x1f\x7f]/g, ' ');
  const osc = `\x1b]9;${safe}\x07`;
  return tmux ? `\x1bPtmux;\x1b${osc}\x1b\\` : osc;
}

export function notificationText(cwd: string, durationMs: number, aborted = false): string {
  const repo = cwd.split(/[\\/]/).filter(Boolean).pop() ?? basename(cwd) ?? 'project';
  if (aborted) return `♥ belieb · ${repo} · cancelled`;
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  return `♥ belieb · ${repo} · done in ${seconds}s`;
}
