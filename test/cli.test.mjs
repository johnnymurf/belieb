import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { forwardArgs } from '../dist/args.js';
import { sessionTotals } from '../dist/usage.js';
import extension from '../dist/extension.js';
import { checkKind } from '../dist/checks.js';
import { activeMcpServers } from '../dist/mcp.js';
import { pickMode } from '../dist/mode-picker.js';
import { notificationSequence, notificationText, shouldNotify } from '../dist/notify.js';
import { themeFor } from '../dist/palettes.js';
import { isSafePlanCommand } from '../dist/plan.js';
import { Theme } from '@earendil-works/pi-coding-agent';
import { colorToHex, parseColor, visibleWidth } from '@earendil-works/pi-tui';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

// Keep the 1-in-100 thinking easter egg deterministic unless a test opts in.
process.env.BELIEB_RARE = 'never';

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

function harness() {
  const handlers = new Map();
  const commands = new Map();
  const renderers = new Map();
  const shortcuts = new Map();
  const flags = new Map();
  const entries = [];
  const activeTools = ['read', 'bash', 'edit', 'write'];
  const pi = {
    on(name, callback) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(callback);
    },
    registerCommand(name, options) { commands.set(name, options); },
    registerEntryRenderer(type, renderer) { renderers.set(type, renderer); },
    registerShortcut(shortcut, options) { shortcuts.set(shortcut, options); },
    registerFlag(name, options) { flags.set(name, options.default ?? false); },
    getFlag(name) { return flags.get(name); },
    getActiveTools() { return [...activeTools]; },
    getAllTools() { return []; },
    setActiveTools(names) { activeTools.splice(0, activeTools.length, ...names); },
    appendEntry(type, data) { entries.push({ type, data }); },
  };
  return {
    pi, handlers, commands, renderers, shortcuts, flags, entries, activeTools,
    async emit(name, event = {}, ctx) {
      const results = [];
      for (const callback of handlers.get(name) ?? []) results.push(await callback(event, ctx));
      return results;
    },
  };
}

function tui(overrides = {}) {
  const calls = {
    themes: [], headers: [], footers: [], working: [], indicators: [], titles: [], hidden: [],
    notifications: [],
  };
  const statuses = new Map();
  const theme = {
    appearance: 'dark',
    colors: {},
    fg: (_token, text) => text,
    bold: text => text,
    getColorMode: () => 'truecolor',
  };
  const ui = {
    theme,
    setTheme(value) { calls.themes.push(value); return { success: true }; },
    setHeader(factory) { calls.headers.push(factory); },
    setFooter(factory) { calls.footers.push(factory); },
    setWorkingMessage(value) { calls.working.push(value ?? null); },
    setWorkingIndicator(value) { calls.indicators.push(value ?? null); },
    setHiddenThinkingLabel(value) { calls.hidden.push(value ?? null); },
    setStatus(key, value) {
      if (value === undefined) statuses.delete(key);
      else statuses.set(key, value);
    },
    setTitle(value) { calls.titles.push(value); },
    notify(message, type) { calls.notifications.push({ message, type }); },
    select: async () => undefined,
    ...overrides,
  };
  return { ui, calls, theme, statuses };
}

function context(mode, ui, extra = {}) {
  return {
    mode,
    ui,
    hasUI: true,
    cwd: '/tmp/project',
    model: { name: 'test-model' },
    getContextUsage: () => ({ tokens: 42_000, contextWindow: 100_000, percent: 42 }),
    ...extra,
  };
}

const footerData = {
  getGitBranch: () => 'main',
  getExtensionStatuses: () => new Map(),
};

function footerLine(factory, width) {
  const component = factory({ requestRender() {} }, tuiTheme(), footerData);
  return component.render(width)[0];
}

function tuiTheme() {
  return {
    appearance: 'dark',
    colors: {},
    fg: (_token, text) => text,
    bold: text => text,
    getColorMode: () => 'truecolor',
  };
}

test('forwarding preserves prompts, files, option values and -- without shell interpretation', () => {
  const args = ['--model', 'provider/model', '-e', './my extension.js', '@file name', '--', '--print', '$(touch nope)'];
  assert.deepEqual(forwardArgs(args, '/brand.js'), ['--extension', '/brand.js', ...args]);
  // Boolean extension flags must not swallow the prompt that follows them.
  assert.deepEqual(forwardArgs(['--print', '--plan', 'fix it'], '/brand.js'),
    ['--extension', '/brand.js', '--print', '--plan=true', 'fix it']);
  for (const command of ['auth', 'mcp', 'install', 'remove', 'uninstall', 'update', 'list', 'config']) {
    assert.deepEqual(forwardArgs([command, '--help'], '/brand.js'), [command, '--help']);
  }
});

test('extension never touches UI in print, JSON or RPC modes', async () => {
  const run = harness();
  extension(run.pi);
  const headless = (mode) => ({
    mode,
    cwd: '/tmp/project',
    hasUI: false,
    get ui() { throw new Error('headless UI access'); },
    getContextUsage: () => undefined,
  });
  for (const mode of ['print', 'json', 'rpc']) {
    const ctx = headless(mode);
    await run.emit('session_start', {}, ctx);
    await run.emit('agent_start', {}, ctx);
    await run.emit('tool_execution_start', { toolName: 'edit', args: { path: 'a.ts' } }, ctx);
    await run.emit('turn_start', {}, ctx);
    await run.emit('agent_settled', {}, ctx);
  }
});

test('TUI startup installs the avatar, footer and real working label, clipping narrow terminals', async () => {
  const previous = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  try {
    const run = harness();
    extension(run.pi);
    const { ui, calls } = tui();
    const ctx = context('tui', ui);
    await run.emit('session_start', {}, ctx);

    assert.equal(calls.working[0], 'beliebing…');
    assert.equal(calls.titles.at(-1), '♥ belieb · project');
    assert.equal(calls.hidden.at(-1), 'beliebing…');
    assert.ok(calls.indicators.at(-1).frames.length > 0);

    const header = calls.headers.at(-1)({ requestRender() {} }, tuiTheme());
    assert.ok(header.render(80).some(line => line.includes('mood: beliebing in your code')));
    assert.ok(header.render(120).some(line => line.includes('top friends: you, jb & git')));
    assert.ok(header.render(80).every(line => !line.includes('Unofficial Bieber-inspired parody.')));
    assert.ok(header.render(8).every(line => line.length <= 8));
    assert.ok(header.render(0).every(line => line === ''));

    const footer = footerLine(calls.footers.at(-1), 120);
    assert.ok(footer.includes('belieb'));
    assert.ok(footer.includes('test-model'));
    assert.ok(footer.includes('main'));
    assert.ok(footer.includes('ctx 42%'));
    assert.ok(footer.includes('♥ belieb'));
    assert.ok(footerLine(calls.footers.at(-1), 20).length <= 20);
  } finally {
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
  }
});

test('wide colour terminal gets the Myspace profile card', async () => {
  const previous = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  process.argv.push('--use-theme');
  try {
    const run = harness();
    extension(run.pi);
    const { ui, calls, theme } = tui();
    await run.emit('session_start', {}, context('tui', ui));
    const header = calls.headers.at(-1)({ requestRender() {} }, theme);
    const lines = header.render(120);
    assert.ok(lines.some(line => line.replace(/\x1b\[[0-9;]*m/g, '').includes('|___/___|')));
    assert.ok(lines.some(line => line.includes('top friends: you, jb & git')));
    assert.ok(lines.some(line => line.includes('now playing: Purpose')));
    assert.ok(lines.every(line => visibleWidth(line) <= 120));
    assert.ok(lines.length <= 24);
  } finally {
    process.argv.pop();
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
  }
});

test('tool activity drives the working message and the footer state', async () => {
  const previous = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  try {
    const run = harness();
    extension(run.pi);
    const { ui, calls } = tui();
    const ctx = context('tui', ui);
    await run.emit('session_start', {}, ctx);

    await run.emit('tool_execution_start', { toolName: 'read', args: {} }, ctx);
    assert.equal(calls.working.at(-1), 'learning the choreography…');
    await run.emit('tool_execution_start', { toolName: 'edit', args: { path: 'src/a.ts' } }, ctx);
    assert.equal(calls.working.at(-1), 'recording vocals…');
    await run.emit('tool_execution_start', { toolName: 'bash', args: { command: 'npm test' } }, ctx);
    assert.equal(calls.working.at(-1), 'soundcheck…');
    await run.emit('tool_execution_start', { toolName: 'bash', args: { command: 'git status' } }, ctx);
    assert.equal(calls.working.at(-1), 'boarding the tour bus…');
    assert.ok(calls.titles.at(-1).startsWith('♪ boarding the tour bus'));

    const footer = calls.footers.at(-1)({ requestRender() {} }, tuiTheme(), footerData);
    assert.ok(footer.render(120)[0].includes('♪ working'));

    await run.emit('tool_execution_end', { toolName: 'bash' }, ctx);
    assert.equal(calls.working.at(-1), 'beliebing…');

    await run.emit('turn_start', {}, ctx);
    await run.emit('agent_settled', {}, ctx);
    assert.equal(calls.working.at(-1), 'beliebing…');
    assert.ok(footer.render(120)[0].includes('♥ belieb'));
    assert.ok(!footer.render(120)[0].includes('♪ working'));

    const header = calls.headers.at(-1)({ requestRender() {} }, tuiTheme());
    assert.ok(header.render(120).some(line => line.includes('profile views: 1')));
  } finally {
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
  }
});

test('prompt templates ship with the extension and are discovered without user writes', async () => {
  const run = harness();
  extension(run.pi);
  const [result] = await run.emit('resources_discover', { type: 'resources_discover', cwd: '/tmp/project', reason: 'startup' });
  assert.ok(result);
  assert.equal(result.promptPaths.length, 1);
  const dir = result.promptPaths[0];
  assert.equal(fileURLToPath(new URL('../prompts', import.meta.url)), dir);
  assert.deepEqual(readdirSync(dir).sort(), [
    'encore.md', 'purpose.md', 'setlist.md', 'sorry.md', 'soundcheck.md',
  ]);

  process.argv.push('--no-prompt-templates');
  try {
    const disabled = harness();
    extension(disabled.pi);
    const [off] = await disabled.emit('resources_discover', { type: 'resources_discover', cwd: '/tmp/project', reason: 'startup' });
    assert.equal(off, undefined);
  } finally {
    process.argv.pop();
  }
});

test('the /belieb command switches moods, persists config and restores plain Pi', async () => {
  const home = mkdtempSync(join(tmpdir(), 'belieb-config-'));
  const previous = { dir: process.env.BELIEB_DIR, color: process.env.NO_COLOR };
  process.env.BELIEB_DIR = home;
  process.env.NO_COLOR = '1';
  try {
    const run = harness();
    extension(run.pi);
    const { ui, calls } = tui();
    const ctx = context('tui', ui);
    await run.emit('session_start', {}, ctx);

    const command = run.commands.get('belieb');
    assert.ok(command);
    assert.deepEqual(
      command.getArgumentCompletions('mood p').map(item => item.value),
      ['purpose', 'peaches'],
    );
    assert.deepEqual(
      command.getArgumentCompletions('st').map(item => item.value),
      ['stats'],
    );

    await command.handler('mood peaches', ctx);
    assert.ok(calls.notifications.at(-1).message.includes('Peaches'));
    const saved = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
    assert.equal(saved.mood, 'peaches');

    await command.handler('card', ctx);
    assert.equal(run.entries.at(-1).type, 'belieb-card');
    assert.equal(run.entries.at(-1).data.mood, 'Peaches');
    const card = run.renderers.get('belieb-card')({ data: run.entries.at(-1).data }, {}, tuiTheme());
    assert.ok(card.render(120).some(line => line.includes('♥ belieb')));
    assert.ok(card.render(120).some(line => line.includes('now playing: Peaches')));

    await command.handler('stats', ctx);
    assert.equal(run.entries.at(-1).type, 'belieb-panel');
    assert.ok(run.entries.at(-1).data.lines.some(line => line.startsWith('turns')));
    const panel = run.renderers.get('belieb-panel')({ data: run.entries.at(-1).data }, {}, tuiTheme());
    assert.ok(panel.render(80).some(line => line.includes('tour stats')));
    assert.ok(panel.render(80).every(line => visibleWidth(line) <= 80));

    await command.handler('notify on', ctx);
    assert.equal(calls.notifications.at(-1).message, 'notifications on');
    assert.equal(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).notify, true);
    await command.handler('notify off', ctx);
    assert.equal(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).notify, false);

    await command.handler('off', ctx);
    assert.equal(calls.headers.at(-1), undefined);
    assert.equal(calls.footers.at(-1), undefined);
    assert.equal(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).plain, true);

    await command.handler('on', ctx);
    assert.equal(typeof calls.headers.at(-1), 'function');
    assert.equal(typeof calls.footers.at(-1), 'function');
    assert.equal(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).plain, false);
  } finally {
    if (previous.dir === undefined) delete process.env.BELIEB_DIR;
    else process.env.BELIEB_DIR = previous.dir;
    if (previous.color === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous.color;
    rmSync(home, { recursive: true, force: true });
  }
});

test('a saved plain preference leaves Pi\'s own UI untouched', async () => {
  const home = mkdtempSync(join(tmpdir(), 'belieb-plain-'));
  const previous = { dir: process.env.BELIEB_DIR, color: process.env.NO_COLOR };
  process.env.BELIEB_DIR = home;
  process.env.NO_COLOR = '1';
  writeFileSync(join(home, 'config.json'), JSON.stringify({ mood: 'justice', plain: true }));
  try {
    const run = harness();
    extension(run.pi);
    const { ui, calls } = tui();
    await run.emit('session_start', {}, context('tui', ui));
    await run.emit('agent_start', {}, context('tui', ui));
    assert.deepEqual(calls.headers, []);
    assert.deepEqual(calls.footers, []);
    assert.deepEqual(calls.working, []);
    assert.deepEqual(calls.titles, []);
    assert.deepEqual(calls.themes, []);

    // The command can bring decoration back without a restart.
    await run.commands.get('belieb').handler('on', context('tui', ui));
    assert.equal(typeof calls.headers.at(-1), 'function');
    assert.equal(typeof calls.footers.at(-1), 'function');
  } finally {
    if (previous.dir === undefined) delete process.env.BELIEB_DIR;
    else process.env.BELIEB_DIR = previous.dir;
    if (previous.color === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous.color;
    rmSync(home, { recursive: true, force: true });
  }
});

test('plan mode is read-only and the footer names the current mode', async () => {
  const previous = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  try {
    const run = harness();
    extension(run.pi);
    const { ui, calls } = tui();
    const ctx = context('tui', ui);
    await run.emit('session_start', {}, ctx);
    assert.deepEqual(run.activeTools, ['read', 'bash', 'edit', 'write']);

    const plan = run.commands.get('plan');
    assert.ok(plan);
    await plan.handler('', ctx);
    assert.deepEqual(run.activeTools, ['read', 'bash']);
    assert.equal(calls.notifications.at(-1).message, '⏸ plan mode: read-only');
    assert.equal(calls.titles.at(-1), '⏸ plan · project');
    const footer = calls.footers.at(-1)({ requestRender() {} }, tuiTheme(), footerData);
    assert.ok(footer.render(120)[0].includes('⏸ plan'));

    const [injected] = await run.emit('before_agent_start', {
      type: 'before_agent_start', messageType: 'user', prompt: 'plan it',
    }, ctx);
    assert.equal(injected.message.customType, 'belieb-plan-context');

    const [blocked] = await run.emit('tool_call', {
      type: 'tool_call', toolName: 'bash', input: { command: 'git commit -m "nope"' },
    }, ctx);
    assert.equal(blocked.block, true);
    const [allowed] = await run.emit('tool_call', {
      type: 'tool_call', toolName: 'bash', input: { command: 'git status --short' },
    }, ctx);
    assert.equal(allowed, undefined);
    assert.equal(isSafePlanCommand('git diff | head'), true);
    assert.equal(isSafePlanCommand('git status && rm -rf /'), false);
    assert.equal(isSafePlanCommand('echo $(rm x)'), false);

    // Toggling back restores the tools and stops injecting plan context.
    await plan.handler('', ctx);
    assert.deepEqual(run.activeTools, ['read', 'bash', 'edit', 'write']);
    assert.equal(calls.titles.at(-1), '♥ belieb · project');
    const [quiet] = await run.emit('before_agent_start', {
      type: 'before_agent_start', messageType: 'user', prompt: 'build it',
    }, ctx);
    assert.equal(quiet, undefined);

    const [filtered] = await run.emit('context', {
      type: 'context',
      messages: [
        { role: 'custom', customType: 'belieb-plan-context', content: 'stale' },
        { role: 'user', content: 'hello' },
      ],
    }, ctx);
    assert.equal(filtered.messages.length, 1);
    assert.equal(filtered.messages[0].role, 'user');
  } finally {
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
  }
});

test('--plan starts the session in plan mode and the hub can switch modes', async () => {
  const previous = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  try {
    const run = harness();
    extension(run.pi);
    run.flags.set('plan', true);
    const { ui, calls } = tui();
    const ctx = context('tui', ui);
    await run.emit('session_start', {}, ctx);
    assert.deepEqual(run.activeTools, ['read', 'bash']);
    assert.equal(calls.titles.at(-1), '⏸ plan · project');

    const hub = run.commands.get('belieb');
    await hub.handler('belieb', ctx);
    assert.deepEqual(run.activeTools, ['read', 'bash', 'edit', 'write']);
    assert.equal(calls.notifications.at(-1).message, '♥ belieb mode: full access');
    await hub.handler('plan', ctx);
    assert.deepEqual(run.activeTools, ['read', 'bash']);
    assert.equal(calls.notifications.at(-1).message, '⏸ plan mode: read-only');
  } finally {
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
  }
});

test('one run in a hundred thinks about the Freemasons instead', async () => {
  const previous = { rare: process.env.BELIEB_RARE, color: process.env.NO_COLOR };
  process.env.BELIEB_RARE = 'always';
  process.env.NO_COLOR = '1';
  try {
    const run = harness();
    extension(run.pi);
    const { ui, calls } = tui();
    const ctx = context('tui', ui);
    await run.emit('session_start', {}, ctx);

    await run.emit('agent_start', {}, ctx);
    assert.equal(calls.working.at(-1), 'Freemasons run the country...');
    assert.equal(calls.hidden.at(-1), 'Freemasons run the country...');

    await run.emit('turn_start', {}, ctx);
    assert.equal(calls.working.at(-1), 'Freemasons run the country...');

    await run.emit('tool_execution_start', { toolName: 'read', args: {} }, ctx);
    assert.equal(calls.working.at(-1), 'learning the choreography…');
    await run.emit('tool_execution_end', { toolName: 'read' }, ctx);
    assert.equal(calls.working.at(-1), 'Freemasons run the country...');

    await run.emit('agent_settled', {}, ctx);
    assert.equal(calls.working.at(-1), 'beliebing…');
    assert.equal(calls.hidden.at(-1), 'beliebing…');
  } finally {
    if (previous.rare === undefined) delete process.env.BELIEB_RARE;
    else process.env.BELIEB_RARE = previous.rare;
    if (previous.color === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous.color;
  }
});

test('the thinking label is "beliebing…" almost always, with a per-phase rare roll', async () => {
  const previous = { rare: process.env.BELIEB_RARE, color: process.env.NO_COLOR, random: Math.random };
  delete process.env.BELIEB_RARE;
  process.env.NO_COLOR = '1';
  try {
    const run = harness();
    extension(run.pi);
    const { ui, calls } = tui();
    const ctx = context('tui', ui);
    await run.emit('session_start', {}, ctx);

    Math.random = () => 0.5;
    await run.emit('agent_start', {}, ctx);
    assert.equal(calls.working.at(-1), 'beliebing…');
    await run.emit('turn_start', {}, ctx);
    assert.equal(calls.working.at(-1), 'beliebing…');
    assert.equal(calls.hidden.at(-1), 'beliebing…');

    // Inside the 1% band: this phase uses the rare line.
    Math.random = () => 0.005;
    await run.emit('turn_start', {}, ctx);
    assert.equal(calls.working.at(-1), 'Freemasons run the country...');
    assert.equal(calls.hidden.at(-1), 'Freemasons run the country...');
    assert.ok(calls.titles.at(-1).includes('Freemasons run the country'));

    // The next phase rolls again, so the joke never sticks for the run.
    Math.random = () => 0.5;
    await run.emit('turn_start', {}, ctx);
    assert.equal(calls.working.at(-1), 'beliebing…');
    assert.equal(calls.hidden.at(-1), 'beliebing…');

    // Tool activity still owns its own flavor line, then thinking resumes.
    await run.emit('tool_execution_start', { toolName: 'read', args: {} }, ctx);
    assert.equal(calls.working.at(-1), 'learning the choreography…');
    await run.emit('tool_execution_end', { toolName: 'read' }, ctx);
    assert.equal(calls.working.at(-1), 'beliebing…');
  } finally {
    Math.random = previous.random;
    if (previous.rare === undefined) delete process.env.BELIEB_RARE;
    else process.env.BELIEB_RARE = previous.rare;
    if (previous.color === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous.color;
  }
});

test('the mode picker renders both modes with their descriptions', async () => {
  const previous = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  try {
    let component;
    let finish;
    const base = tui();
    const ui = {
      ...base.ui,
      custom: (factory) => new Promise(resolve => {
        finish = resolve;
        component = factory({ requestRender() {} }, tuiTheme(), {}, resolve);
      }),
    };
    const choice = pickMode(context('tui', ui), 'belieb');
    const lines = component.render(80);
    assert.ok(lines.some(line => line.includes('choose your mode')));
    assert.ok(lines.some(line => line.includes("You're the next chart hit")));
    assert.ok(lines.some(line => line.includes('Never say never')));
    assert.ok(lines.some(line => line.includes('plan')));
    assert.ok(lines.some(line => line.includes('belieb') && line.includes('(active)')));
    finish(null);
    assert.equal(await choice, undefined);
  } finally {
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
  }
});

test('/mode and /belieb mode apply the picker selection', async () => {
  const previous = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  try {
    const run = harness();
    extension(run.pi);
    const { ui, calls } = tui();
    ui.custom = async () => 'plan';
    const ctx = context('tui', ui);
    await run.emit('session_start', {}, ctx);

    await run.commands.get('mode').handler('', ctx);
    assert.deepEqual(run.activeTools, ['read', 'bash']);
    assert.equal(calls.notifications.at(-1).message, '⏸ plan mode: read-only');

    ui.custom = async () => 'belieb';
    await run.commands.get('belieb').handler('mode', ctx);
    assert.deepEqual(run.activeTools, ['read', 'bash', 'edit', 'write']);
    assert.equal(calls.notifications.at(-1).message, '♥ belieb mode: full access');
  } finally {
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
  }
});

test('edit snapshots restore with /undo, and failed edits are discarded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'belieb-undo-'));
  const file = join(dir, 'a.txt');
  const created = join(dir, 'new.txt');
  const previous = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  writeFileSync(file, 'before');
  try {
    const run = harness();
    extension(run.pi);
    const { ui, calls } = tui();
    const ctx = context('tui', ui, { cwd: dir });
    await run.emit('session_start', {}, ctx);

    await run.emit('tool_call', {
      type: 'tool_call', toolCallId: 'e1', toolName: 'edit',
      input: { path: 'a.txt', edits: [{ oldText: 'before', newText: 'after' }] },
    }, ctx);
    writeFileSync(file, 'after');
    await run.emit('tool_execution_end', { toolCallId: 'e1', toolName: 'edit', isError: false }, ctx);
    await run.commands.get('undo').handler('', ctx);
    assert.equal(readFileSync(file, 'utf8'), 'before');
    assert.ok(calls.notifications.at(-1).message.includes('restored a.txt'));

    await run.emit('tool_call', {
      type: 'tool_call', toolCallId: 'w1', toolName: 'write',
      input: { path: 'new.txt', content: 'made' },
    }, ctx);
    writeFileSync(created, 'made');
    await run.emit('tool_execution_end', { toolCallId: 'w1', toolName: 'write', isError: false }, ctx);
    await run.commands.get('undo').handler('', ctx);
    assert.equal(existsSync(created), false);

    await run.emit('tool_call', {
      type: 'tool_call', toolCallId: 'e2', toolName: 'edit',
      input: { path: 'a.txt', edits: [] },
    }, ctx);
    await run.emit('tool_execution_end', { toolCallId: 'e2', toolName: 'edit', isError: true }, ctx);
    await run.commands.get('undo').handler('', ctx);
    assert.equal(readFileSync(file, 'utf8'), 'before');
    assert.ok(calls.notifications.at(-1).message.includes('nothing to undo'));
  } finally {
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('test, lint and build runs set a footer badge', async () => {
  const previous = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  try {
    const run = harness();
    extension(run.pi);
    const { ui, calls, statuses } = tui();
    const ctx = context('tui', ui);
    await run.emit('session_start', {}, ctx);

    await run.emit('tool_execution_start', {
      toolCallId: 'b1', toolName: 'bash', args: { command: 'npm test' },
    }, ctx);
    await run.emit('tool_execution_end', { toolCallId: 'b1', toolName: 'bash', isError: true }, ctx);
    assert.equal(statuses.get('belieb-checks'), 'tests ✗');

    const footer = calls.footers.at(-1)(
      { requestRender() {} },
      tuiTheme(),
      { getGitBranch: () => 'main', getExtensionStatuses: () => statuses },
    );
    assert.ok(footer.render(120)[0].includes('tests ✗'));

    await run.emit('tool_execution_start', {
      toolCallId: 'b2', toolName: 'bash', args: { command: 'npm run lint' },
    }, ctx);
    await run.emit('tool_execution_end', { toolCallId: 'b2', toolName: 'bash', isError: false }, ctx);
    assert.equal(statuses.get('belieb-checks'), 'tests ✗ · lint ✓');

    assert.equal(checkKind('swift test'), 'tests');
    assert.equal(checkKind('tsc --noEmit'), 'lint');
    assert.equal(checkKind('xcodebuild build'), 'build');
    assert.equal(checkKind('git status'), undefined);
  } finally {
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
  }
});

test('finish notifications only fire for long runs and sanitize OSC text', () => {
  assert.equal(shouldNotify(false, 60_000), false);
  assert.equal(shouldNotify(true, 19_999), false);
  assert.equal(shouldNotify(true, 20_000), true);
  assert.equal(notificationText('/tmp/Purpose', 42_000), '♥ belieb · Purpose · done in 42s');
  assert.equal(notificationText('/tmp/Purpose', 42_000, true), '♥ belieb · Purpose · cancelled');
  assert.equal(notificationSequence('hi\x07there', false), '\x1b]9;hi there\x07');
  assert.ok(notificationSequence('hi', true).startsWith('\x1bPtmux;'));
});

test('mood palettes layer on a real Pi theme and keep semantic colors', () => {
  const themeFile = fileURLToPath(new URL(
    '../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json',
    import.meta.url,
  ));
  const raw = JSON.parse(readFileSync(themeFile, 'utf8'));
  const vars = raw.vars ?? {};
  const resolve = (value) => {
    let current = value;
    for (let depth = 0; depth < 10 && typeof current === 'string' && current in vars; depth++) {
      current = vars[current];
    }
    return colorToHex(parseColor(current));
  };
  const colors = Object.fromEntries(
    Object.entries(raw.colors).map(([token, value]) => [token, resolve(value)]),
  );
  const base = new Theme(colors, colors, 'truecolor', { name: 'base', appearance: 'dark' });
  const peaches = themeFor(base, 'peaches');
  assert.equal(peaches.name, 'belieb-peaches');
  assert.equal(peaches.appearance, 'dark');
  assert.notEqual(peaches.getFgAnsi('accent'), base.getFgAnsi('accent'));
  assert.equal(peaches.getFgAnsi('error'), base.getFgAnsi('error'));
  assert.equal(peaches.getFgAnsi('toolDiffAdded'), base.getFgAnsi('toolDiffAdded'));
});

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

test('one undo reverts a whole turn and /redo replays it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'belieb-turn-'));
  const previous = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  const a = join(dir, 'a.txt');
  const b = join(dir, 'b.txt');
  const made = join(dir, 'made.txt');
  writeFileSync(a, 'a1');
  writeFileSync(b, 'b1');
  try {
    const run = harness();
    extension(run.pi);
    const { ui, calls } = tui();
    const ctx = context('tui', ui, { cwd: dir });
    await run.emit('session_start', {}, ctx);

    // Turn 1 touches a.txt.
    await run.emit('agent_start', {}, ctx);
    await run.emit('tool_call', { toolCallId: 't1', toolName: 'edit', input: { path: 'a.txt' } }, ctx);
    writeFileSync(a, 'a2');
    await run.emit('tool_execution_end', { toolCallId: 't1', toolName: 'edit', isError: false }, ctx);

    // Turn 2 touches a.txt again, creates made.txt and edits b.txt.
    await run.emit('agent_start', {}, ctx);
    for (const [id, path, tool] of [['t2', 'a.txt', 'edit'], ['t3', 'made.txt', 'write'], ['t4', 'b.txt', 'edit']]) {
      await run.emit('tool_call', { toolCallId: id, toolName: tool, input: { path } }, ctx);
    }
    writeFileSync(a, 'a3');
    writeFileSync(made, 'new');
    writeFileSync(b, 'b2');
    for (const id of ['t2', 't3', 't4']) {
      await run.emit('tool_execution_end', { toolCallId: id, toolName: 'edit', isError: false }, ctx);
    }

    await run.commands.get('undo').handler('', ctx);
    assert.equal(readFileSync(a, 'utf8'), 'a2', 'turn 2 pre-image, not turn 1');
    assert.equal(readFileSync(b, 'utf8'), 'b1');
    assert.equal(existsSync(made), false);
    assert.equal(calls.notifications.at(-1).message, '↩ restored 2 files · removed made.txt');

    await run.commands.get('undo').handler('', ctx);
    assert.equal(readFileSync(a, 'utf8'), 'a1');
    assert.equal(calls.notifications.at(-1).message, '↩ restored a.txt');

    await run.commands.get('redo').handler('', ctx);
    assert.equal(readFileSync(a, 'utf8'), 'a2');
    assert.equal(calls.notifications.at(-1).message, '↪ restored a.txt');
    await run.commands.get('redo').handler('', ctx);
    assert.equal(readFileSync(a, 'utf8'), 'a3');
    assert.equal(readFileSync(made, 'utf8'), 'new');
    assert.equal(readFileSync(b, 'utf8'), 'b2');
    assert.equal(calls.notifications.at(-1).message, '↪ restored 3 files');

    await run.commands.get('redo').handler('', ctx);
    assert.equal(calls.notifications.at(-1).message, 'nothing to redo');
  } finally {
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('new work after an undo clears the redo chain', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'belieb-redo-'));
  const previous = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  const file = join(dir, 'a.txt');
  writeFileSync(file, 'one');
  try {
    const run = harness();
    extension(run.pi);
    const { ui, calls } = tui();
    const ctx = context('tui', ui, { cwd: dir });
    await run.emit('session_start', {}, ctx);

    await run.emit('agent_start', {}, ctx);
    await run.emit('tool_call', { toolCallId: 'x1', toolName: 'write', input: { path: 'a.txt' } }, ctx);
    writeFileSync(file, 'two');
    await run.emit('tool_execution_end', { toolCallId: 'x1', toolName: 'write', isError: false }, ctx);
    await run.commands.get('undo').handler('', ctx);
    assert.equal(readFileSync(file, 'utf8'), 'one');

    await run.emit('agent_start', {}, ctx);
    await run.emit('tool_call', { toolCallId: 'x2', toolName: 'write', input: { path: 'a.txt' } }, ctx);
    writeFileSync(file, 'three');
    await run.emit('tool_execution_end', { toolCallId: 'x2', toolName: 'write', isError: false }, ctx);

    await run.commands.get('redo').handler('', ctx);
    assert.equal(calls.notifications.at(-1).message, 'nothing to redo');
    assert.equal(readFileSync(file, 'utf8'), 'three');
  } finally {
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('session cost sums assistant, usage and compaction entries', () => {
  const totals = sessionTotals([
    { type: 'message', message: { role: 'assistant', usage: {
      input: 1_000, output: 200, cacheRead: 4_000, cacheWrite: 100,
      cost: { input: 0.002, output: 0.004, cacheRead: 0.0004, cacheWrite: 0.0001, total: 0.0065 },
    } } },
    { type: 'message', message: { role: 'user' } },
    { type: 'usage', usage: { input: 10, output: 0, cost: { total: 0.001 } } },
    { type: 'compaction', usage: { input: 5, output: 5, cost: { total: 0.0005 } } },
    null,
    { type: 'message' },
  ]);
  assert.equal(totals.input, 1_015);
  assert.equal(totals.output, 205);
  assert.equal(totals.cacheRead, 4_000);
  assert.equal(totals.cacheWrite, 100);
  assert.equal(totals.cost.toFixed(4), '0.0080');
  assert.equal(sessionTotals(undefined).cost, 0);
});

test('/cost reports spend and the footer shows it once the session is priced', async () => {
  const previous = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  try {
    const run = harness();
    extension(run.pi);
    const { ui, calls } = tui();
    const entries = [
      { type: 'message', message: { role: 'assistant', usage: {
        input: 12_000, output: 2_000, cacheRead: 30_000, cacheWrite: 0,
        cost: { total: 0.0342 },
      } } },
    ];
    const ctx = context('tui', ui, {
      sessionManager: { getEntries: () => entries },
      getContextUsage: () => ({ tokens: 60_000, contextWindow: 200_000, percent: 30 }),
    });
    await run.emit('session_start', {}, ctx);

    const footer = footerLine(calls.footers.at(-1), 120);
    assert.ok(footer.includes('$0.034'), footer);
    assert.ok(!footerLine(calls.footers.at(-1), 40).includes('$'));

    await run.commands.get('cost').handler('', ctx);
    const panel = run.entries.at(-1);
    assert.equal(panel.type, 'belieb-panel');
    assert.ok(panel.data.lines.some(line => line.includes('$0.034')));
    assert.ok(panel.data.lines.some(line => line.includes('44k total')));
    assert.ok(panel.data.lines.some(line => line.startsWith('context')));

    await run.commands.get('belieb').handler('stats', ctx);
    const stats = run.entries.at(-1).data.lines;
    assert.ok(stats.some(line => line.startsWith('cost') && line.includes('$0.034')));
    assert.ok(stats.some(line => line.startsWith('tokens')));
  } finally {
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
  }
});

test('plan mode tolerates descriptor redirects and blocks curl writes', () => {
  assert.equal(isSafePlanCommand('git diff 2>&1 | head'), true);
  assert.equal(isSafePlanCommand('rg TODO src 2>/dev/null'), true);
  assert.equal(isSafePlanCommand('git status > out.txt'), false);
  assert.equal(isSafePlanCommand('curl -s https://example.com/api'), true);
  assert.equal(isSafePlanCommand('curl -s -o secrets.txt https://example.com'), false);
  assert.equal(isSafePlanCommand('curl --output=secrets.txt https://example.com'), false);
  assert.equal(isSafePlanCommand('curl -X POST https://example.com'), false);
  assert.equal(isSafePlanCommand('curl -d @payload https://example.com'), false);
});

test('--plan is a real flag in headless runs, not an unknown option', () => {
  const result = isolated(['--no-session', '--print', '--plan', 'Say hello']);
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout + result.stderr, /Unknown option/);
  assert.match(result.stdout + result.stderr, /API key|credentials|authentication/i);
});

test('active MCP servers are derived from connected tool namespaces', () => {
  const tools = [
    { name: 'read' },
    { name: 'mcp__docs__search', namespace: { name: 'mcp__docs' } },
    { name: 'mcp__docs__fetch', namespace: { name: 'mcp__docs' } },
    { name: 'mcp__my_repo__list', namespace: { name: 'mcp__my_repo' } },
  ];
  assert.deepEqual(activeMcpServers(tools), [{ name: 'docs', tools: 2 }, { name: 'my_repo', tools: 1 }]);
  assert.deepEqual(activeMcpServers([{ name: 'read' }]), []);
});
