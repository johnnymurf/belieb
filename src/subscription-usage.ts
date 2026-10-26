import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { OpenCodeUsageAuthError, readOpenCodeUsageAuth } from './opencode-usage.js';

const REFRESH_MS = 60_000;
const BACKOFF_MS = 5 * REFRESH_MS;
const supported = new Set(['anthropic', 'openai-codex', 'openai']);
type UsageContext = Pick<ExtensionContext, 'mode' | 'model' | 'modelRegistry'>;

export interface QuotaWindow {
  label: string;
  remaining: number;
  resetsAt?: number;
}

export interface QuotaSegment {
  text: string;
  low: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function window(label: string, used: unknown, resetsAt?: number): QuotaWindow | undefined {
  if (typeof used !== 'number' || !Number.isFinite(used)) return;
  return {
    label,
    remaining: Math.max(0, Math.min(100, 100 - used)),
    resetsAt: resetsAt !== undefined && Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt : undefined,
  };
}

/** Provider-reported percentages only; missing windows are not unlimited windows. */
export function parseQuota(provider: string, payload: unknown): QuotaWindow[] {
  const data = record(payload);
  const windows: (QuotaWindow | undefined)[] = [];
  if (provider === 'anthropic') {
    for (const [key, label] of [['five_hour', '5h'], ['seven_day', 'week']]) {
      const value = record(data[key]);
      windows.push(window(label, value.utilization,
        typeof value.resets_at === 'string' ? Date.parse(value.resets_at) : undefined));
    }
  } else if (provider === 'openai-codex') {
    const limits = record(data.rate_limit);
    for (const key of ['primary_window', 'secondary_window']) {
      const value = record(limits[key]);
      const seconds = value.limit_window_seconds;
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) continue;
      const label = seconds === 604800 ? 'week'
        : seconds % 3600 === 0 ? `${seconds / 3600}h` : `${Math.ceil(seconds / 60)}m`;
      windows.push(window(label, value.used_percent,
        typeof value.reset_at === 'number' ? value.reset_at * 1000 : undefined));
    }
  }
  return windows.filter((value): value is QuotaWindow => value !== undefined);
}

export function quotaSegments(windows: readonly QuotaWindow[], now = Date.now()): QuotaSegment[] {
  return windows.map(value => {
    // A reset passing does not prove the allowance is now 100%; wait for fresh data.
    const expired = value.resetsAt !== undefined && value.resetsAt <= now;
    const percent = value.remaining > 0 && value.remaining < 1 ? '<1' : String(Math.floor(value.remaining));
    return {
      text: expired ? `${value.label} —` : `${value.label} ${percent}% left`,
      low: !expired && value.remaining <= 20,
    };
  });
}

/** Background usage polling. OpenCode credentials are read only with explicit opt-in. */
export class SubscriptionUsage {
  private ctx?: UsageContext;
  private useOpenCode = false;
  private timer?: ReturnType<typeof setInterval>;
  private controller?: AbortController;
  private pending?: Promise<void>;
  private nextAt = 0;
  private windows: QuotaWindow[] = [];
  private unavailableText = 'limits unavailable';
  private status: 'hidden' | 'loading' | 'ready' | 'unavailable' = 'hidden';

  constructor(
    private readonly changed: () => void,
    private readonly fetchUsage: typeof fetch = (...args) => globalThis.fetch(...args),
    private readonly now: () => number = Date.now,
    private readonly openCodeAuth = readOpenCodeUsageAuth,
  ) {}

  start(ctx: UsageContext, useOpenCode = false): void {
    useOpenCode = useOpenCode && ctx.model?.provider === 'openai';
    if (this.ctx?.model?.provider === ctx.model?.provider && this.useOpenCode === useOpenCode && this.timer) {
      this.ctx = ctx;
      void this.refresh();
      return;
    }
    this.stop();
    if (ctx.mode !== 'tui' || !supported.has(ctx.model?.provider ?? '') || offline()) return;
    this.ctx = ctx;
    this.useOpenCode = useOpenCode;
    this.timer = setInterval(() => { void this.refresh(); }, REFRESH_MS);
    this.timer.unref();
    void this.refresh();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.controller?.abort();
    this.ctx = undefined;
    this.useOpenCode = false;
    this.timer = undefined;
    this.controller = undefined;
    this.pending = undefined;
    this.nextAt = 0;
    this.windows = [];
    this.unavailableText = 'limits unavailable';
    this.status = 'hidden';
  }

  segments(): QuotaSegment[] {
    if (this.status === 'hidden') return [];
    const prefix = this.useOpenCode ? 'OpenCode ' : '';
    if (this.status === 'loading') return [{ text: `${prefix}limits …`, low: false }];
    if (this.status === 'unavailable') return [{ text: prefix + this.unavailableText, low: false }];
    return quotaSegments(this.windows, this.now()).map((segment, index) => ({
      ...segment, text: index === 0 ? prefix + segment.text : segment.text,
    }));
  }

  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    const ctx = this.ctx;
    if (!ctx || !ctx.model || this.now() < this.nextAt) return Promise.resolve();
    const controller = new AbortController();
    this.controller = controller;
    this.nextAt = this.now() + REFRESH_MS;
    this.pending = this.load(ctx, controller).finally(() => {
      if (this.controller === controller) this.pending = undefined;
    });
    return this.pending;
  }

  private async load(ctx: UsageContext, controller: AbortController): Promise<void> {
    const model = ctx.model!;
    const provider = model.provider;
    const current = () => this.controller === controller && !controller.signal.aborted;
    try {
      if (!ctx.modelRegistry?.isUsingOAuth?.(model)) {
        this.status = 'hidden';
        this.windows = [];
        this.changed();
        return;
      }
      if (this.status === 'hidden') {
        this.status = 'loading';
        this.changed();
      }
      // Native OpenAI credentials never reach ChatGPT. The optional OpenCode
      // source supplies its own independently validated bearer and account ID.
      if (provider === 'openai' && !this.useOpenCode) throw new Error('Usage is not exposed by this auth method');
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]);
      const auth = await ctx.modelRegistry.getProviderAuth(provider);
      if (!current()) return;
      signal.throwIfAborted();
      let token = auth?.auth.apiKey;
      if (!token) throw new Error('Missing subscription credentials');
      const expectedOrigin = provider === 'anthropic' ? 'https://api.anthropic.com'
        : provider === 'openai' ? 'https://api.openai.com' : 'https://chatgpt.com';
      for (const baseUrl of [model.baseUrl, auth?.auth.baseUrl]) {
        if (baseUrl && new URL(baseUrl).origin !== expectedOrigin) throw new Error('Custom subscription endpoint');
      }
      let companionAccount: string | undefined;
      if (provider === 'openai') {
        const companion = await this.openCodeAuth(signal);
        if (!current()) return;
        signal.throwIfAborted();
        token = companion.access;
        companionAccount = companion.accountId;
      }
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
      let url: string;
      if (provider === 'anthropic') {
        url = 'https://api.anthropic.com/api/oauth/usage';
        headers['anthropic-beta'] = 'oauth-2025-04-20';
      } else {
        url = 'https://chatgpt.com/backend-api/wham/usage';
        const payload = record(JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')));
        const accountId = companionAccount ?? record(payload['https://api.openai.com/auth']).chatgpt_account_id;
        if (typeof accountId !== 'string' || !accountId) throw new Error('Missing subscription account');
        headers['ChatGPT-Account-Id'] = accountId;
      }
      // Only official, fixed endpoints; never forward credentials through redirects.
      const response = await this.fetchUsage(url, { headers, signal, redirect: 'error' });
      if (!current()) return;
      if (!response.ok) {
        this.nextAt = this.now() + BACKOFF_MS;
        if (response.status === 429) {
          const raw = response.headers.get('retry-after');
          const seconds = raw?.trim() ? Number(raw) : NaN;
          const retryAt = Number.isFinite(seconds) ? this.now() + Math.max(0, seconds) * 1000
            : raw ? Date.parse(raw) : NaN;
          if (Number.isFinite(retryAt)) this.nextAt = Math.max(this.nextAt, retryAt);
        }
        // Do not log provider bodies: they can include account information.
        await response.body?.cancel();
        throw new Error('Subscription usage unavailable');
      }
      const windows = parseQuota(provider === 'openai' ? 'openai-codex' : provider, await response.json());
      if (!current()) return;
      if (windows.length === 0) throw new Error('No usage windows returned');
      this.windows = windows;
      this.status = 'ready';
    } catch (error) {
      if (!current()) return;
      this.windows = [];
      this.unavailableText = this.useOpenCode && error instanceof OpenCodeUsageAuthError
        ? `login ${error.reason}` : 'limits unavailable';
      this.status = 'unavailable';
    }
    if (current()) this.changed();
  }
}

function offline(): boolean {
  return /^(1|true|yes)$/i.test(process.env.PI_OFFLINE ?? '') || process.argv.includes('--offline');
}
