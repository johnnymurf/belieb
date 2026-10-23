#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { forwardArgs } from './args.js';

// Use the pinned package's shipped CLI: it performs Pi's setup, signal handling,
// argument parsing and terminal cleanup in this process (no shell or child relay).
const entry = new URL('./bundle/cli.js', import.meta.resolve('@earendil-works/pi-coding-agent'));
const extension = fileURLToPath(new URL('./extension.js', import.meta.url));
process.argv = [process.execPath, fileURLToPath(entry), ...forwardArgs(
  process.argv.slice(2), Boolean(process.stdin.isTTY && process.stdout.isTTY), extension,
)];
await import(entry.href);
