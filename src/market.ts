import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type MarketSource = 'pi' | 'mcp';

export interface MarketEntry {
  source: MarketSource;
  /** Stable picker identity: `pi:<name>` or `mcp:<registry name>`. */
  key: string;
  /** Package name or registry server name, as published. */
  name: string;
  version: string;
  description: string;
  homepage?: string;
  /** Exact Pi CLI arguments when one-click install is safe and possible. */
  args?: string[];
  /** Why this listing cannot be installed from here. Browsing stays available. */
  blocked?: string;
  /** npm monthly downloads. The only popularity signal either registry publishes. */
  downloads?: number;
  notes: string[];
}

export type JsonFetcher = (url: URL, signal: AbortSignal) => Promise<unknown>;

const NPM_SEARCH = 'https://registry.npmjs.org/-/v1/search';
const MCP_SERVERS = 'https://registry.modelcontextprotocol.io/v0/servers';
const MAX_RESULTS = 25;
/** npm pages cap at 250; ranking by downloads needs a full page to be meaningful. */
const POPULAR_FETCH_SIZE = 250;
const MAX_POPULAR = 100;
const MAX_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
/** Registry data reaches a terminal: keep it printable, single-line and short. */
const MAX_TEXT = 160;

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const VERSION = /^[0-9a-z][0-9a-z.+-]{0,63}$/i;
const LOOPBACK = /^(?:localhost|127\.0\.0\.1|\[::1\])$/;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** Registry text is untrusted: strip control characters and bound the length. */
export function displayText(value: unknown, max = MAX_TEXT): string {
  if (typeof value !== 'string') return '';
  const clean = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function validPackageName(name: string): boolean {
  return PACKAGE_NAME.test(name) && name.length <= 214;
}

export function validVersion(version: string): boolean {
  return VERSION.test(version) && !version.includes('..');
}

/** `pi install` specifications are pinned; nothing floats to whatever is newest later. */
export function installSpec(name: string, version: string): string {
  if (!validPackageName(name)) throw new Error(`Refusing an invalid package name: ${name}`);
  if (!validVersion(version)) throw new Error(`Refusing an invalid package version: ${version}`);
  return `npm:${name}@${version}`;
}

/**
 * Pi server names allow letters, digits, `_` and `-`, and names differing only in
 * `-`/`_` collide. Registry names contain `@`, `/` and `.`, so derive a stable
 * local name from them rather than trusting the published text.
 */
export function mcpLocalName(name: string): string {
  const derived = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
  return derived.length === 0 ? '' : derived.slice(0, 48);
}

/** Only HTTPS, or HTTP on loopback, may be written into `mcp.json`. */
export function usableRemoteUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  if (url.protocol === 'https:') return url.toString();
  if (url.protocol === 'http:' && LOOPBACK.test(url.hostname)) return url.toString();
  return;
}

async function readBounded(response: Response, signal: AbortSignal): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    await response.body?.cancel();
    throw new Error('registry response is too large');
  }
  if (!response.body) throw new Error('market registry returned no body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    if (signal.aborted) throw signal.reason ?? new Error('aborted');
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error('registry response is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Fixed official registries only; no redirects, no credentials, bounded body. */
export async function registryJson(url: URL, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`market registry returned HTTP ${response.status}`);
  }
  return await readBounded(response, signal);
}

/** Monthly npm downloads, when the search payload carries a usable number. */
function monthlyDownloads(object: Record<string, unknown>): number | undefined {
  const downloads = record(object.downloads);
  const monthly = downloads.monthly;
  if (typeof monthly !== 'number' || !Number.isFinite(monthly) || monthly < 0) return;
  return Math.min(Math.floor(monthly), 1_000_000_000);
}

function piEntries(payload: unknown, limit: number): MarketEntry[] {
  const objects = record(payload).objects;
  const entries: MarketEntry[] = [];
  const seen = new Set<string>();
  for (const object of Array.isArray(objects) ? objects : []) {
    if (entries.length >= limit) break;
    const pkg = record(record(object).package);
    const name = typeof pkg.name === 'string' ? pkg.name : '';
    const version = typeof pkg.version === 'string' ? pkg.version : '';
    // Fuzzy search returns unrelated packages; the keyword is the opt-in signal.
    const keywords = Array.isArray(pkg.keywords) ? pkg.keywords : [];
    if (!keywords.includes('pi-package') || !validPackageName(name) || seen.has(name)) continue;
    seen.add(name);
    const links = record(pkg.links);
    const notes = ['Runs with your user permissions once installed.'];
    let args: string[] | undefined;
    let blocked: string | undefined;
    try {
      args = ['install', installSpec(name, version)];
    } catch {
      blocked = 'this listing has no usable published version';
    }
    const homepage = usableRemoteUrl(links.homepage) ?? usableRemoteUrl(links.npm);
    if (homepage) notes.push(`source ${homepage}`);
    const downloads = monthlyDownloads(record(object));
    entries.push({
      source: 'pi',
      key: `pi:${name}`,
      name,
      version,
      description: displayText(pkg.description) || '(no description)',
      homepage,
      args,
      blocked,
      ...(downloads === undefined ? {} : { downloads }),
      notes,
    });
  }
  return entries;
}

/** Pi packages are npm packages that opted in with the `pi-package` keyword. */
export async function searchPiPackages(
  query: string, signal: AbortSignal, fetchJson: JsonFetcher = registryJson,
): Promise<MarketEntry[]> {
  const url = new URL(NPM_SEARCH);
  url.searchParams.set('text', `keywords:pi-package ${query}`);
  url.searchParams.set('size', String(MAX_RESULTS * 2));
  return piEntries(await fetchJson(url, signal), MAX_RESULTS);
}

/**
 * Browsing without a query: the busiest Pi packages first. npm's own relevance
 * ranking mixes quality and maintenance, so sort by published monthly downloads
 * instead — it is the one number a reader can interpret.
 */
export async function popularPiPackages(
  signal: AbortSignal, fetchJson: JsonFetcher = registryJson,
): Promise<MarketEntry[]> {
  const url = new URL(NPM_SEARCH);
  url.searchParams.set('text', 'keywords:pi-package');
  url.searchParams.set('size', String(POPULAR_FETCH_SIZE));
  const entries = piEntries(await fetchJson(url, signal), POPULAR_FETCH_SIZE);
  return entries
    .sort((lhs, rhs) => {
      const delta = (rhs.downloads ?? 0) - (lhs.downloads ?? 0);
      if (delta !== 0) return delta;
      if (lhs.name !== rhs.name) return lhs.name < rhs.name ? -1 : 1;
      return 0;
    })
    .slice(0, MAX_POPULAR);
}

interface EndpointPlan {
  args?: string[];
  blocked?: string;
}

function remotePlan(server: Record<string, unknown>): EndpointPlan {
  const remotes = Array.isArray(server.remotes) ? server.remotes.map(record) : [];
  const remote = remotes.find(value => value.type === 'streamable-http');
  if (!remote) return {};
  const url = usableRemoteUrl(remote.url);
  if (!url) return { blocked: 'the published endpoint is not HTTPS or loopback HTTP' };
  const headers = Array.isArray(remote.headers) ? remote.headers.map(record) : [];
  if (headers.some(header => header.isRequired === true || header.value !== undefined)) {
    return { blocked: 'the published endpoint needs credentials; add it with `pi mcp add`' };
  }
  return { args: ['--url', url] };
}

function packagePlan(server: Record<string, unknown>): EndpointPlan {
  const packages = Array.isArray(server.packages) ? server.packages.map(record) : [];
  const pkg = packages.find(value => record(value.transport).type === 'stdio' && value.registryType === 'npm');
  if (!pkg) return {};
  const identifier = typeof pkg.identifier === 'string' ? pkg.identifier : '';
  const version = typeof pkg.version === 'string' ? pkg.version : '';
  if (!validPackageName(identifier) || !validVersion(version)) {
    return { blocked: 'the published npm package or version is invalid' };
  }
  const env = Array.isArray(pkg.environmentVariables) ? pkg.environmentVariables.map(record) : [];
  const needed = env.filter(value => value.isRequired === true).map(value => displayText(value.name, 48));
  if (needed.length > 0) {
    return { blocked: `needs configuration (${needed.join(', ')}); add it with \`pi mcp add\`` };
  }
  return { args: ['--', 'npx', '-y', `${identifier}@${version}`] };
}

/** Local Pi servers that already use a derived name; replacing them would be silent. */
export function configuredServerNames(cwd: string, agentDir = getAgentDir()): Set<string> {
  const names = new Set<string>();
  for (const path of [join(agentDir, 'mcp.json'), join(cwd, '.pi', 'mcp.json')]) {
    try {
      const servers = record(JSON.parse(readFileSync(path, 'utf8')).mcpServers);
      for (const name of Object.keys(servers)) names.add(name);
    } catch {
      // Missing or unreadable configuration contributes no names.
    }
  }
  return names;
}

/** Anonymous registry access: no credentials are ever sent to these endpoints. */
export async function searchMcpServers(
  query: string,
  signal: AbortSignal,
  fetchJson: JsonFetcher = registryJson,
  existing: ReadonlySet<string> = new Set(),
): Promise<MarketEntry[]> {
  const url = new URL(MCP_SERVERS);
  url.searchParams.set('search', query);
  url.searchParams.set('version', 'latest');
  url.searchParams.set('limit', String(MAX_RESULTS * 2));
  const payload = record(await fetchJson(url, signal));
  const servers = Array.isArray(payload.servers) ? payload.servers.map(record) : [];
  const entries: MarketEntry[] = [];
  const seen = new Set<string>();
  for (const wrapped of servers) {
    if (entries.length >= MAX_RESULTS) break;
    const server = record(wrapped.server);
    const name = typeof server.name === 'string' ? server.name : '';
    const version = typeof server.version === 'string' ? server.version : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const local = mcpLocalName(name);
    const notes = ['Tools are reached through codemode by default.'];
    const repo = record(server.repository ?? server.repo);
    const homepage = usableRemoteUrl(repo.url);
    if (homepage) notes.push(`source ${homepage}`);
    let plan: EndpointPlan = remotePlan(server);
    if (!plan.args && !plan.blocked) plan = packagePlan(server);
    let blocked = plan.blocked;
    if (!plan.args && !blocked) {
      blocked = 'no supported streamable-HTTP endpoint or configuration-free npm server';
    }
    if (plan.args && local.length === 0) blocked = 'the published server name has no usable local name';
    if (plan.args && existing.has(local)) {
      blocked = `a server named ${local} already exists; run \`pi mcp remove ${local}\` first`;
    }
    entries.push({
      source: 'mcp',
      key: `mcp:${name}`,
      name,
      version: displayText(version, 32) || 'unversioned',
      description: displayText(server.description ?? server.title) || '(no description)',
      homepage,
      args: blocked ? undefined : ['mcp', 'add', local, ...plan.args!],
      blocked,
      notes: local ? [`installs as ${local}`, ...notes] : notes,
    });
  }
  return entries;
}

/** User scope by default; project scope must be asked for explicitly. */
export function installArgs(entry: MarketEntry, scope: 'user' | 'project'): string[] {
  if (!entry.args) throw new Error(entry.blocked ?? 'this entry cannot be installed from here');
  return scope === 'project' ? [...entry.args, '--local'] : [...entry.args];
}

export function marketSource(value: string): MarketSource | undefined {
  if (value === 'pi' || value === 'packages') return 'pi';
  if (value === 'mcp' || value === 'servers') return 'mcp';
  return;
}

export function offline(): boolean {
  return /^(1|true|yes)$/i.test(process.env.PI_OFFLINE ?? '') || process.argv.includes('--offline');
}
