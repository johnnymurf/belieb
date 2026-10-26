/** Rebrand only Pi's terminal exit hint, without changing its config/session paths. */
export function installResumeHint(stream: Pick<NodeJS.WriteStream, 'isTTY' | 'write'> = process.stdout): void {
  if (!stream.isTTY) return;

  const write = stream.write.bind(stream);
  stream.write = ((...args: Parameters<typeof stream.write>) => {
    const [chunk, ...rest] = args;
    // Pi writes this as one string after stopping the TUI. Keep its ANSI dim
    // styling, session ID and optional (shell-quoted) session directory intact.
    const output = typeof chunk === 'string'
      ? chunk.replace(/^((?:\x1b\[[0-9;]*m)*To resume this session:(?:\x1b\[[0-9;]*m)* )pi(?= --session(?:-dir)? )/, '$1belieb')
      : chunk;
    return write(output, ...rest);
  }) as typeof stream.write;
}
