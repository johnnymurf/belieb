import type { ToolInfo } from '@earendil-works/pi-coding-agent';

export interface McpServerInfo {
  name: string;
  tools: number;
}

/**
 * Pi's built-in MCP support registers each connected server's tools under an
 * `mcp__<server>` namespace, so that is the only "connected" signal an extension
 * gets. shortcut: a server that failed to connect or exposes zero tools is not
 * listed; run Pi's `/mcp` for connection errors.
 */
export function activeMcpServers(tools: readonly Pick<ToolInfo, 'name' | 'namespace'>[]): McpServerInfo[] {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    const namespace = tool.namespace?.name;
    if (!namespace?.startsWith('mcp__')) continue;
    const name = namespace.slice('mcp__'.length);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, tools]) => ({ name, tools })).sort((a, b) => a.name.localeCompare(b.name));
}
