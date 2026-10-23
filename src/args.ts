const commands = new Set(['install', 'remove', 'uninstall', 'update', 'list', 'config', 'auth', 'mcp']);

/** Pi owns argument parsing; only add a presentation extension on a terminal. */
export function forwardArgs(args: readonly string[], terminal: boolean, extension: string): string[] {
  if (!terminal || commands.has(args[0] ?? '')) return [...args];
  return ['--extension', extension, ...args];
}
