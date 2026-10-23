/**
 * Session cost and token accounting.
 *
 * Pi records per-message usage (tokens plus provider cost) on assistant
 * messages and on synthetic `usage` entries. This module sums whatever the
 * session actually contains, so an unknown or unpriced model simply reports
 * zero cost instead of failing.
 */

export interface Totals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

interface EntryLike {
  type?: string;
  message?: { role?: string; usage?: UsageLike };
  usage?: UsageLike;
}

export function emptyTotals(): Totals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

/** Add one usage record, tolerating providers that omit fields. */
export function addUsage(totals: Totals, usage: UsageLike | undefined): void {
  if (!usage) return;
  totals.input += usage.input ?? 0;
  totals.output += usage.output ?? 0;
  totals.cacheRead += usage.cacheRead ?? 0;
  totals.cacheWrite += usage.cacheWrite ?? 0;
  totals.cost += usage.cost?.total ?? 0;
}

/** True spend for the whole session, including abandoned branches and compaction. */
export function sessionTotals(entries: readonly unknown[] | undefined): Totals {
  const totals = emptyTotals();
  for (const value of entries ?? []) {
    const entry = value as EntryLike;
    if (!entry || typeof entry !== 'object') continue;
    if (entry.type === 'message') {
      // Some providers bill tool results as separate prompt tokens.
      if (entry.message?.role === 'assistant' || entry.message?.role === 'toolResult') {
        addUsage(totals, entry.message.usage);
      }
      continue;
    }
    if (entry.type === 'usage' || entry.type === 'compaction' || entry.type === 'branch_summary') {
      addUsage(totals, entry.usage);
    }
  }
  return totals;
}

export function billedTokens(totals: Totals): number {
  return totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(Math.round(value));
}

/** Sub-cent amounts keep enough precision to be meaningful. */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 10) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

/** Footer-friendly cost segment, omitted when the session is free of charge. */
export function costSegment(totals: Totals): string | undefined {
  return totals.cost > 0 ? formatUsd(totals.cost) : undefined;
}
