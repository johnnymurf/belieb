const commands = new Set(['install', 'remove', 'uninstall', 'update', 'list', 'config', 'auth', 'mcp']);

/**
 * Pi parses extension flags in a pre-pass where an unknown `--flag` swallows the
 * next bare token, so `belieb --plan "fix the tests"` would lose the prompt.
 * Writing the boolean value inline (`--plan=true`) keeps the prompt intact.
 */
function normalize(args: readonly string[]): string[] {
  return args.map(argument => argument === '--plan' ? '--plan=true' : argument);
}

/**
 * Pi owns argument parsing; belieb only adds its presentation extension.
 *
 * The extension is loaded in every mode, not just on a terminal, so extension
 * flags such as `--plan` and the bundled prompt templates also work for
 * `--print`, JSON, RPC, and piped output. Every UI call is gated on
 * `ctx.mode === 'tui'`, so headless output stays untouched.
 */
export function forwardArgs(args: readonly string[], extension: string): string[] {
  if (commands.has(args[0] ?? '')) return [...args];
  return ['--extension', extension, ...normalize(args)];
}
