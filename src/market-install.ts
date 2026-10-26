import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { cappedText } from './belieber-runner.js';
import { installArgs, type MarketEntry } from './market.js';

export interface InstallOptions {
  cwd: string;
  scope: 'user' | 'project';
  /** Injectable entry point for credential-free process tests. */
  cliPath?: string;
  timeoutMs?: number;
  killAfterMs?: number;
}

export interface InstallResult {
  ok: boolean;
  output: string;
  args: string[];
}

/** The pinned Pi CLI, spawnable without a shell. */
export function piCliPath(): string {
  return fileURLToPath(new URL('./bundle/cli.js', import.meta.resolve('@earendil-works/pi-coding-agent')));
}

/**
 * Run one Pi package or MCP command with an argument array. Registry data never
 * becomes a shell string, and the process gets no stdin, so a listing cannot
 * inject a second command or answer a prompt on the user's behalf.
 */
export async function runMarketCommand(args: string[], options: InstallOptions): Promise<InstallResult> {
  const cli = options.cliPath ?? piCliPath();
  const timeoutMs = options.timeoutMs ?? 120_000;
  return await new Promise<InstallResult>(resolve => {
    let output = '';
    let settled = false;
    const finish = (ok: boolean, note = '') => {
      if (settled) return;
      settled = true;
      resolve({ ok, output: cappedText(output + note, 16 * 1024), args });
    };
    let proc: ReturnType<typeof spawn>;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      proc.kill('SIGTERM');
      // A package manager may ignore SIGTERM; escalate even after the caller gave up.
      killTimer = setTimeout(() => proc.kill('SIGKILL'), options.killAfterMs ?? 1000);
      killTimer.unref();
    };
    try {
      proc = spawn(process.execPath, [cli, ...args], {
        cwd: options.cwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PI_TELEMETRY: '0' },
      });
    } catch (error) {
      finish(false, `could not start Pi: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const timer = setTimeout(() => {
      stop();
      finish(false, `Pi did not finish within ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`}`);
    }, timeoutMs);
    timer.unref();

    for (const stream of [proc.stdout, proc.stderr]) {
      stream?.setEncoding('utf8');
      stream?.on('data', (chunk: string) => {
        if (output.length < 64 * 1024) output += chunk;
      });
    }
    proc.on('error', error => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      finish(false, `could not start Pi: ${error.message}`);
    });
    proc.on('close', code => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      finish(code === 0, code === 0 ? '' : `Pi exited with code ${code ?? 'unknown'}`);
    });
  });
}

/** Install one confirmed listing. Never called without an explicit user confirmation. */
export async function installEntry(entry: MarketEntry, options: InstallOptions): Promise<InstallResult> {
  return await runMarketCommand(installArgs(entry, options.scope), options);
}
