import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { forwardArgs } from '../dist/args.js';
import extension from '../dist/extension.js';
import { visibleWidth } from '@earendil-works/pi-tui';

test('forwarding preserves prompts, files, option values and -- without shell interpretation', () => {
  const args = ['--model', 'provider/model', '-e', './my extension.js', '@file name', '--', '--print', '$(touch nope)'];
  assert.deepEqual(forwardArgs(args, true, '/brand.js'), ['--extension', '/brand.js', ...args]);
  assert.deepEqual(forwardArgs(args, false, '/brand.js'), args);
  for (const command of ['auth', 'mcp', 'install', 'remove', 'uninstall', 'update', 'list', 'config']) {
    assert.deepEqual(forwardArgs([command, '--help'], true, '/brand.js'), [command, '--help']);
  }
});

test('extension never touches UI in print, JSON or RPC modes', async () => {
  let start;
  extension({ on(name, callback) { assert.equal(name, 'session_start'); start = callback; } });
  for (const mode of ['print', 'json', 'rpc']) {
    await start({}, { mode, get ui() { throw new Error('headless UI access'); } });
  }
});

test('TUI startup installs the avatar and real working label, clipping narrow terminals', async () => {
  let start, header, working;
  extension({ on(_name, callback) { start = callback; } });
  const previous = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  try {
    await start({}, { mode: 'tui', ui: {
      theme: { appearance: 'dark', colors: {} },
      setWorkingMessage(value) { working = value; },
      setHeader(factory) { header = factory({}, {}); },
    } });
    assert.equal(working, 'beliebing…');
    assert.ok(header.render(80).some(line => line.includes('mood: beliebing in your code')));
    assert.ok(header.render(120).some(line => line.includes('top friends: you, jb & git')));
    assert.ok(header.render(80).every(line => !line.includes('Unofficial Bieber-inspired parody.')));
    assert.ok(header.render(8).every(line => line.length <= 8));
    assert.ok(header.render(0).every(line => line === ''));
  } finally {
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
  }
});

test('wide colour terminal gets the Myspace profile card', async () => {
  let start, header;
  extension({ on(_name, callback) { start = callback; } });
  const previous = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  process.argv.push('--use-theme');
  try {
    const theme = {
      appearance: 'dark', colors: {},
      getColorMode: () => 'truecolor',
      fg: (_token, text) => text,
    };
    await start({}, { mode: 'tui', ui: {
      theme,
      setWorkingMessage() {},
      setHeader(factory) { header = factory({}, theme); },
    } });
    const lines = header.render(120);
    assert.ok(lines.some(line => line.replace(/\x1b\[[0-9;]*m/g, '').includes('|___/___|')));
    assert.ok(lines.some(line => line.includes('top friends: you, jb & git')));
    assert.ok(lines.every(line => visibleWidth(line) <= 120));
    assert.ok(lines.length <= 24);
  } finally {
    process.argv.pop();
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
  }
});

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
function isolated(args, input = '') {
  const home = mkdtempSync(join(tmpdir(), 'belieb-test-'));
  try {
    return spawnSync(process.execPath, [cli, ...args], {
      cwd: home, input, encoding: 'utf8', timeout: 30000,
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home,
        PI_CODING_AGENT_DIR: join(home, 'agent'), PI_OFFLINE: '1', PI_TELEMETRY: '0', NO_COLOR: '1' },
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

test('real shipped CLI help and version work without credentials', () => {
  const help = isolated(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--resume/);
  assert.match(help.stdout, /--mode/);
  assert.doesNotMatch(help.stdout, /beliebing|Unofficial|~~~~/);
  const version = isolated(['--version']);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), '1.4.0');
});

test('real print invocation fails honestly without credentials and without branding', () => {
  const result = isolated(['--no-session', '--no-extensions', '--no-skills', '--no-context-files',
    '--provider', 'anthropic', '--model', 'claude-sonnet-4-5', '--print', 'Say hello']);
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /API key|credentials|authentication/i);
  assert.doesNotMatch(result.stdout + result.stderr, /beliebing|Unofficial|~~~~/);
});

test('RPC keeps stdout valid JSON and returns real state without credentials', () => {
  const result = isolated(['--mode', 'rpc', '--no-session', '--no-extensions', '--no-skills', '--no-context-files'],
    '{"id":"smoke","type":"get_state"}\n');
  assert.equal(result.status, 0, result.stderr);
  const records = result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.ok(records.some(record => record.id === 'smoke' && record.success === true));
  assert.doesNotMatch(result.stdout, /beliebing|Unofficial|~~~~/);
});
