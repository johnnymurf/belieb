import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface OpenCodeUsageAuth {
  access: string;
  accountId: string;
}

export class OpenCodeUsageAuthError extends Error {
  constructor(readonly reason: 'missing' | 'expired' | 'invalid') {
    super(`OpenCode login ${reason}`);
  }
}

export function openCodeAuthPaths(
  env = process.env, home = homedir(), platform = process.platform,
): string[] {
  const paths = [join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'opencode', 'auth.json')];
  if (platform === 'win32') {
    const legacy = join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'opencode', 'auth.json');
    if (!paths.includes(legacy)) paths.push(legacy);
  }
  return paths;
}

/** Explicit opt-in only. Read in memory; never copy, refresh, write or log credentials. */
export async function readOpenCodeUsageAuth(
  signal: AbortSignal, paths = openCodeAuthPaths(), now = Date.now(),
): Promise<OpenCodeUsageAuth> {
  for (const path of paths) {
    signal.throwIfAborted();
    let text: string;
    try {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error();
        text = await handle.readFile({ encoding: 'utf8', signal });
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      throw new OpenCodeUsageAuthError('invalid');
    }
    signal.throwIfAborted();
    try {
      const auth = JSON.parse(text).openai;
      if (auth?.type !== 'oauth' || typeof auth.access !== 'string' || !auth.access
        || typeof auth.accountId !== 'string' || !auth.accountId) throw new Error();
      if (auth.expires !== undefined) {
        if (typeof auth.expires !== 'number' || !Number.isFinite(auth.expires)) throw new Error();
        if (auth.expires <= now) throw new OpenCodeUsageAuthError('expired');
      }
      // Match the saved account to its bearer, not Pi's distinct native grant.
      const claims = JSON.parse(Buffer.from(auth.access.split('.')[1] ?? '', 'base64url').toString('utf8'));
      if (claims?.['https://api.openai.com/auth']?.chatgpt_account_id !== auth.accountId) throw new Error();
      if (claims.exp !== undefined) {
        if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) throw new Error();
        if (claims.exp * 1000 <= now) throw new OpenCodeUsageAuthError('expired');
      }
      return { access: auth.access, accountId: auth.accountId };
    } catch (error) {
      if (error instanceof OpenCodeUsageAuthError) throw error;
      throw new OpenCodeUsageAuthError('invalid');
    }
  }
  throw new OpenCodeUsageAuthError('missing');
}
