import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getKeybindings } from '@earendil-works/pi-tui';

import {
  configuredServerNames, displayText, installArgs, installSpec, mcpLocalName,
  marketSource, popularPiPackages, searchMcpServers, searchPiPackages, usableRemoteUrl,
  validPackageName, validVersion,
} from '../dist/market.js';
import { MarketBrowser, downloadsLabel, entryItems } from '../dist/market-browser.js';
import { installEntry, runMarketCommand } from '../dist/market-install.js';
import { registerMarket } from '../dist/market-command.js';

const fixture = fileURLToPath(new URL('./fixtures/market-child.mjs', import.meta.url));
const signal = () => new AbortController().signal;

const npmPayload = {
  objects: [
    { package: { name: 'pi-tools', version: '1.2.3', description: 'Useful\u0007 tools', keywords: ['pi-package'],
      links: { npm: 'https://www.npmjs.com/package/pi-tools', homepage: 'https://example.com/tools' } },
    downloads: { monthly: 1816192 } },
    { package: { name: 'not-a-pi-package', version: '9.9.9', description: 'unrelated', keywords: ['cli'] } },
    { package: { name: 'pi-tools', version: '1.2.3', keywords: ['pi-package'] } },
    { package: { name: '--registry=evil', version: '1.0.0', keywords: ['pi-package'] } },
    { package: { name: 'pi-quoted', version: '1.0.0', description: 'x'.repeat(400), keywords: ['pi-package'] },
      downloads: { monthly: 42 } },
    { package: { name: 'pi-unversioned', keywords: ['pi-package'] }, downloads: { monthly: 7 } },
    { package: null },
    null,
  ],
};

const mcpPayload = {
  servers: [
    { server: { name: 'sh.remote/filesystem', version: '2.0.0', description: 'Remote files',
      remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/fs' }] } },
    { server: { name: 'sh.remote/filesystem', version: '1.0.0', remotes: [{ type: 'streamable-http', url: 'https://old.example.com/fs' }] } },
    { server: { name: 'sh.insecure/http', version: '1.0.0', remotes: [{ type: 'streamable-http', url: 'http://example.com/mcp' }] } },
    { server: { name: 'sh.local/http', version: '1.0.0', remotes: [{ type: 'streamable-http', url: 'http://127.0.0.1:8080/mcp' }] } },
    { server: { name: 'sh.oauth/github', version: '1.0.0',
      remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/gh',
        headers: [{ name: 'Authorization', value: 'Bearer {token}', isSecret: true }] }] } },
    { server: { name: 'sh.stdio/sqlite', version: '0.4.1', packages: [{ registryType: 'npm',
      identifier: '@database-mcp/sqlite', version: '0.4.1', transport: { type: 'stdio' }, environmentVariables: [] }] } },
    { server: { name: 'sh.stdio/needs-env', version: '1.0.0', packages: [{ registryType: 'npm',
      identifier: 'needs-env-mcp', version: '1.0.0', transport: { type: 'stdio' },
      environmentVariables: [{ name: 'API_KEY', isRequired: true }] }] } },
    { server: { name: 'sh.oci/container', version: '0.1.0', packages: [{ registryType: 'oci',
      identifier: 'ghcr.io/x/y:0.1.0', transport: { type: 'streamable-http', url: 'http://localhost:8080/mcp' } }] } },
    { server: { name: 'sh.existing/tools', version: '1.0.0', remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/t' }] } },
    { server: null },
  ],
};

function fetchJson(payload) {
  return async () => payload;
}

test('Pi package search keeps only opted-in packages and pins versions', async () => {
  let requested;
  const entries = await searchPiPackages('tools & more', signal(), async (url) => {
    requested = url;
    return npmPayload;
  });
  assert.equal(requested.origin, 'https://registry.npmjs.org');
  assert.equal(requested.searchParams.get('text'), 'keywords:pi-package tools & more');
  assert.deepEqual(entries.map(entry => entry.name), ['pi-tools', 'pi-quoted', 'pi-unversioned']);
  const tools = entries[0];
  assert.equal(tools.version, '1.2.3');
  assert.deepEqual(tools.args, ['install', 'npm:pi-tools@1.2.3']);
  assert.equal(tools.description, 'Useful tools', 'control characters are stripped');
  assert.match(tools.homepage, /^https:\/\/example\.com\/tools$/);
  assert.ok(entries[1].description.endsWith('…'), 'long descriptions stay bounded');
  assert.equal(entries[2].args, undefined, 'an unversioned listing is not installed');
  assert.match(entries[2].blocked, /version/);
});

test('registry failures are reported, never turned into results', async () => {
  const boom = async () => { throw new Error('market registry returned HTTP 503'); };
  await assert.rejects(searchPiPackages('x', signal(), boom), /HTTP 503/);
  await assert.rejects(searchMcpServers('x', signal(), boom), /HTTP 503/);
  const huge = async () => ({ objects: [] });
  assert.deepEqual(await searchPiPackages('x', signal(), huge), []);
  assert.deepEqual(await searchMcpServers('x', signal(), huge), []);
});

test('MCP search dedupes versions and blocks anything unsafe to install', async () => {
  let requested;
  const entries = await searchMcpServers('tools', signal(), async (url) => {
    requested = url;
    return mcpPayload;
  }, new Set(['sh-existing-tools']));
  assert.equal(requested.origin, 'https://registry.modelcontextprotocol.io');
  assert.equal(requested.searchParams.get('version'), 'latest');
  assert.equal(requested.searchParams.get('search'), 'tools');

  const byName = new Map(entries.map(entry => [entry.name, entry]));
  assert.deepEqual(byName.get('sh.remote/filesystem').args,
    ['mcp', 'add', 'sh-remote-filesystem', '--url', 'https://mcp.example.com/fs']);
  assert.match(byName.get('sh.remote/filesystem').notes[0], /installs as sh-remote-filesystem/);
  assert.deepEqual(byName.get('sh.local/http').args,
    ['mcp', 'add', 'sh-local-http', '--url', 'http://127.0.0.1:8080/mcp']);
  assert.deepEqual(byName.get('sh.stdio/sqlite').args,
    ['mcp', 'add', 'sh-stdio-sqlite', '--', 'npx', '-y', '@database-mcp/sqlite@0.4.1']);
  assert.match(byName.get('sh.insecure/http').blocked, /not HTTPS/);
  assert.match(byName.get('sh.oauth/github').blocked, /credentials/);
  assert.match(byName.get('sh.stdio/needs-env').blocked, /API_KEY/);
  assert.match(byName.get('sh.oci/container').blocked, /no supported/);
  assert.match(byName.get('sh.existing/tools').blocked, /pi mcp remove sh-existing-tools/);
});

test('names, versions and endpoints are validated before they become arguments', () => {
  assert.equal(validPackageName('@scope/name'), true);
  assert.equal(validPackageName('name'), true);
  for (const bad of ['--registry=evil', 'a/b', '@scope/', '', 'name with space', '../x']) {
    assert.equal(validPackageName(bad), false, bad);
  }
  assert.equal(validVersion('1.2.3'), true);
  assert.equal(validVersion('latest'), true);
  for (const bad of ['', '-1.0.0', '1.0.0 --force']) assert.equal(validVersion(bad), false, bad);
  assert.throws(() => installSpec('bad name', '1.0.0'), /invalid package name/);
  assert.throws(() => installSpec('ok', '1.0.0; rm -rf /'), /invalid package version/);
  assert.equal(installSpec('ok', '1.0.0'), 'npm:ok@1.0.0');

  assert.equal(mcpLocalName('ai.smithery/@user/GitHub MCP'), 'ai-smithery-user-github-mcp');
  assert.equal(mcpLocalName('///'), '');
  assert.equal(usableRemoteUrl('https://example.com/mcp'), 'https://example.com/mcp');
  assert.equal(usableRemoteUrl('http://localhost:8080/mcp'), 'http://localhost:8080/mcp');
  assert.equal(usableRemoteUrl('http://example.com/mcp'), undefined);
  assert.equal(usableRemoteUrl('file:///etc/passwd'), undefined);
  assert.equal(usableRemoteUrl('javascript:alert(1)'), undefined);
  assert.equal(displayText('a\u001b[31mred\u2028line'), 'a [31mred line');
  assert.equal(marketSource('packages'), 'pi');
  assert.equal(marketSource('servers'), 'mcp');
  assert.equal(marketSource('nope'), undefined);
});

test('install arguments add project scope only when asked', async () => {
  const [entry] = await searchMcpServers('x', signal(), fetchJson(mcpPayload));
  assert.deepEqual(installArgs(entry, 'user'), ['mcp', 'add', 'sh-remote-filesystem', '--url', 'https://mcp.example.com/fs']);
  assert.deepEqual(installArgs(entry, 'project'), [
    'mcp', 'add', 'sh-remote-filesystem', '--url', 'https://mcp.example.com/fs', '--local',
  ]);
  const [pkg] = await searchPiPackages('x', signal(), fetchJson(npmPayload));
  assert.deepEqual(installArgs(pkg, 'project'), ['install', 'npm:pi-tools@1.2.3', '--local']);
  const blocked = { source: 'pi', key: 'k', name: 'n', version: '1', description: '', notes: [], blocked: 'nope' };
  assert.throws(() => installArgs(blocked, 'user'), /nope/);
});

test('configured server names come from user and project configuration only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'belieb-market-'));
  const agent = join(dir, 'agent');
  mkdirSync(join(agent), { recursive: true });
  mkdirSync(join(dir, 'project', '.pi'), { recursive: true });
  writeFileSync(join(agent, 'mcp.json'), JSON.stringify({ mcpServers: { docs: {}, tools: {} } }));
  writeFileSync(join(dir, 'project', '.pi', 'mcp.json'), JSON.stringify({ mcpServers: { local: {} } }));
  try {
    const names = configuredServerNames(join(dir, 'project'), agent);
    assert.deepEqual([...names].sort(), ['docs', 'local', 'tools']);
    assert.equal(configuredServerNames(join(dir, 'missing'), agent).size, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the install runner spawns Pi without a shell and reports failures and timeouts', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'belieb-run-'));
  try {
    const ok = await runMarketCommand(['install', 'npm:pi-tools@1.2.3'], { cwd, cliPath: fixture });
    assert.equal(ok.ok, true);
    assert.deepEqual(JSON.parse(ok.output.trim()).args, ['install', 'npm:pi-tools@1.2.3']);

    const failed = await runMarketCommand(['explode'], { cwd, cliPath: fixture });
    assert.equal(failed.ok, false);
    assert.match(failed.output, /registry says no/);
    assert.match(failed.output, /code 3/);

    const started = Date.now();
    const timedOut = await runMarketCommand(['slow'], { cwd, cliPath: fixture, timeoutMs: 300, killAfterMs: 100 });
    assert.equal(timedOut.ok, false);
    assert.match(timedOut.output, /did not finish/);
    assert.ok(Date.now() - started < 5000);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function commandHarness() {
  const commands = new Map();
  const pi = { registerCommand(name, options) { commands.set(name, options); } };
  return { pi, commands };
}

const theme = {
  fg: (_token, text) => text,
  bold: text => text,
};

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const fakeTui = { requestRender() {}, terminal: { rows: 30 } };

/**
 * Type like a person — one key at a time, no pause between keys — then wait out
 * the debounce so the request the burst earned has landed.
 */
async function typeInto(component, text, settleMs = 320) {
  for (const character of text) component.handleInput(character);
  await wait(settleMs);
}

function dialogUi(answers) {
  const calls = { selects: [], inputs: [], confirms: [], notifications: [], renders: [] };
  const ui = {
    select: async (_title, options) => { calls.selects.push(options); return answers.select?.(options); },
    input: async (title) => { calls.inputs.push(title); return answers.input; },
    confirm: async (title, message) => { calls.confirms.push({ title, message }); return answers.confirm ?? false; },
    custom: async (factory) => {
      let settle;
      const finished = new Promise(resolve => { settle = resolve; });
      const component = factory(fakeTui, theme, getKeybindings(), settle);
      // The browser loads its catalog before anything is worth rendering.
      await wait(80);
      calls.renders.push(component.render(80));
      try {
        await answers.drive?.(component);
      } finally {
        component.dispose?.();
      }
      return await Promise.race([finished, wait(20).then(() => undefined)]);
    },
    notify: (message, type) => { calls.notifications.push({ message, type }); },
  };
  return { ui, calls };
}

function context(ui, mode = 'tui', cwd = '/tmp/project') {
  return { mode, hasUI: true, cwd, ui, getContextUsage: () => undefined };
}

test('the command asks before installing and never installs on cancel or refusal', async () => {
  const originalFetch = globalThis.fetch;
  const cwd = mkdtempSync(join(tmpdir(), 'belieb-market-cmd-'));
  const previous = { agent: process.env.PI_CODING_AGENT_DIR, offline: process.env.PI_OFFLINE };
  process.env.PI_CODING_AGENT_DIR = join(cwd, 'agent');
  delete process.env.PI_OFFLINE;
  let requests = 0;
  globalThis.fetch = async () => { requests++; return Response.json(npmPayload); };
  try {
    const { pi, commands } = commandHarness();
    registerMarket(pi, { cliPath: fixture });
    const command = commands.get('market');
    assert.ok(command);
    const project = mkdtempSync(join(tmpdir(), 'belieb-market-cwd-'));
    assert.deepEqual(command.getArgumentCompletions('p').map(item => item.value), ['pi']);
    assert.deepEqual(command.getArgumentCompletions('pi tools'), []);

    const cancel = dialogUi({ confirm: false, drive: component => component.handleInput('\u001b') });
    await command.handler('pi', context(cancel.ui, 'tui', project));
    assert.equal(requests, 1, 'browsing costs one request: the catalog, with no search prompt');
    assert.ok(cancel.calls.renders.at(-1).some(line => line.includes('♥ market · npm pi-package')));
    assert.ok(cancel.calls.renders.at(-1).some(line => line.includes('pi-tools')));
    assert.ok(cancel.calls.renders.at(-1).some(line => line.includes('most downloaded this month')));
    assert.deepEqual(cancel.calls.inputs, [], 'no blocking search prompt before the browser');
    assert.equal(cancel.calls.confirms.length, 0, 'escape cancels without a confirmation');

    const accept = dialogUi({ confirm: true, drive: component => component.handleInput('\r') });
    await command.handler('pi', context(accept.ui, 'tui', project));
    assert.match(accept.calls.confirms.at(-1).message, /runs with your user permissions/);
    assert.match(accept.calls.confirms.at(-1).message, /runs: pi install npm:pi-tools@1\.2\.3/);
    assert.match(accept.calls.notifications.at(-1).message, /installed pi-tools · run \/reload/);

    const typed = dialogUi({ confirm: true, drive: component => component.handleInput('\r') });
    await command.handler('pi tools', context(typed.ui, 'tui', project));
    assert.deepEqual(typed.calls.inputs, [], 'a query in the command skips the prompt');
    assert.ok(typed.calls.renders.at(-1).some(line => /3 matches for “tools”/.test(line)),
      'the query is already applied in the browser');
    assert.match(typed.calls.notifications.at(-1).message, /installed pi-tools/);

    const rpc = dialogUi({
      select: options => options.find(option => option.startsWith('pi-tools')),
      confirm: true,
    });
    await command.handler('pi tools', context(rpc.ui, 'rpc', project));
    assert.match(rpc.calls.notifications.at(-1).message, /installed pi-tools/);

    const headless = dialogUi({ input: 'tools', confirm: true });
    await command.handler('pi tools', { ...context(headless.ui, 'print', project), hasUI: false });
    rmSync(project, { recursive: true, force: true });
    assert.match(headless.calls.notifications.at(-1).message, /interactive terminal/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous.agent;
    if (previous.offline !== undefined) process.env.PI_OFFLINE = previous.offline;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('blocked listings are browsable but cannot be installed', async () => {
  const originalFetch = globalThis.fetch;
  const previous = process.env.PI_OFFLINE;
  delete process.env.PI_OFFLINE;
  const searches = [];
  globalThis.fetch = async (url) => {
    const search = new URL(String(url)).searchParams.get('search') ?? '';
    searches.push(search);
    if (!search.includes('oauth')) return Response.json(mcpPayload);
    const match = mcpPayload.servers.filter(server => server.server?.name === 'sh.oauth/github');
    return Response.json({ servers: match });
  };
  try {
    const { pi, commands } = commandHarness();
    registerMarket(pi, { cliPath: fixture });
    const command = commands.get('market');
    const view = dialogUi({
      confirm: true,
      drive: async component => {
        assert.ok(component.render(80).some(line => line.includes('sh.remote/filesystem')),
          'the whole first page is browsable before searching');
        await typeInto(component, 'sh.oauth');
        const rendered = component.render(80);
        assert.ok(rendered.some(line => line.includes('sh.oauth/github')));
        assert.ok(rendered.every(line => !line.includes('sh.remote/filesystem')),
          'the registry answer replaces the list; there is no local name filter');
        assert.ok(rendered.some(line => line.includes('1 match for “sh.oauth”')));
        assert.deepEqual(searches, ['', 'sh.oauth'], 'one debounced request for the typed word');
        component.handleInput('\r');
      },
    });
    await command.handler('mcp', context(view.ui));
    const rejection = view.calls.notifications.at(-1).message;
    assert.match(rejection, /cannot install from here: the published endpoint needs credentials/);
    assert.doesNotMatch(rejection, /installed/);
    assert.doesNotMatch(view.calls.notifications.map(note => note.message).join('\n'), /installed sh\.oauth/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous !== undefined) process.env.PI_OFFLINE = previous;
  }
});

test('offline mode refuses to search', async () => {
  const previous = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = '1';
  try {
    const { pi, commands } = commandHarness();
    registerMarket(pi, { cliPath: fixture });
    const view = dialogUi({});
    await commands.get('market').handler('pi tools', context(view.ui));
    assert.match(view.calls.notifications.at(-1).message, /offline mode/);
    assert.equal(view.calls.confirms.length, 0);
  } finally {
    if (previous === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previous;
  }
});

test('browsing without a query lists the most downloaded Pi packages first', async () => {
  let requested;
  const entries = await popularPiPackages(signal(), async (url) => {
    requested = url;
    return npmPayload;
  });
  assert.equal(requested.searchParams.get('text'), 'keywords:pi-package',
    'an empty query asks for the whole keyword, not a fuzzy term');
  assert.equal(requested.searchParams.get('size'), '250', 'a full npm page, so ranking means something');
  assert.deepEqual(entries.map(entry => entry.name), ['pi-tools', 'pi-quoted', 'pi-unversioned']);
  assert.equal(entries[0].downloads, 1816192);
  assert.equal(entryItems(entries)[0].description.split(' · ')[0], '1.8M/mo', 'downloads lead the row');
  assert.equal(downloadsLabel(1234), '1.2k/mo');
  assert.equal(downloadsLabel(999), '999/mo');

  const garbled = await popularPiPackages(signal(), async () => ({
    objects: [{ package: { name: 'pi-garbled', version: '1.0.0', keywords: ['pi-package'] },
      downloads: { monthly: 'lots' } }],
  }));
  assert.equal(garbled[0].downloads, undefined, 'an unusable download count is dropped, not rendered');
});

function browserSource(overrides = {}) {
  return {
    label: 'test catalog',
    popularHint: 'most downloaded',
    searchHint: 'things',
    loadPopular: async () => [],
    loadSearch: async () => [],
    ...overrides,
  };
}

function entry(name) {
  return { source: 'pi', key: `pi:${name}`, name, version: '1.0.0', description: `${name} description`,
    args: ['install', `npm:${name}@1.0.0`], notes: [] };
}

test('the browser loads a catalog first, then searches as you type', async () => {
  const calls = [];
  const source = browserSource({
    loadPopular: async () => { calls.push('popular'); return [entry('alpha')]; },
    loadSearch: async query => { calls.push(`search:${query}`); return [entry('beta')]; },
  });
  const browser = new MarketBrowser(fakeTui, theme, { source, debounceMs: 10 }, () => {});
  try {
    await wait(40);
    assert.deepEqual(calls, ['popular'], 'opening the browser browses without a query');
    assert.ok(browser.render(80).some(line => line.includes('alpha')));
    assert.ok(browser.render(80).some(line => line.includes('most downloaded · 1 entry')));

    await typeInto(browser, 'beta', 40);
    assert.deepEqual(calls, ['popular', 'search:beta'], 'a four-key burst earns exactly one request');
    const rendered = browser.render(80);
    assert.ok(rendered.some(line => line.includes('beta')), 'results arrive while typing');
    assert.ok(rendered.every(line => !line.includes('alpha')));
    assert.ok(rendered.some(line => line.includes('1 match for “beta”')));
  } finally {
    browser.dispose();
  }
});

test('a slow earlier search never overwrites a newer one', async () => {
  const source = browserSource({
    loadSearch: async query => {
      await wait(query === 'slow' ? 120 : 10);
      return [entry(query)];
    },
  });
  const browser = new MarketBrowser(fakeTui, theme, { source, debounceMs: 5 }, () => {});
  try {
    await wait(20);
    await typeInto(browser, 'slow', 20);
    for (let index = 0; index < 4; index++) browser.handleInput('\u007f');
    await typeInto(browser, 'fast', 40);
    assert.ok(browser.render(80).some(line => line.includes('fast')));
    await wait(160);
    const rendered = browser.render(80);
    assert.ok(rendered.some(line => line.includes('fast')), 'the current query stays on screen');
    assert.ok(rendered.every(line => !line.includes('slow')), 'the stale answer is dropped');
  } finally {
    browser.dispose();
  }
});

test('escape clears the query before it cancels', async () => {
  const calls = [];
  let finished;
  const source = browserSource({
    loadPopular: async () => { calls.push('popular'); return [entry('alpha')]; },
    loadSearch: async query => { calls.push(`search:${query}`); return [entry(query)]; },
  });
  const browser = new MarketBrowser(fakeTui, theme, { source, debounceMs: 5 }, value => { finished = value; });
  try {
    await wait(20);
    await typeInto(browser, 'beta', 30);
    assert.deepEqual(calls, ['popular', 'search:beta']);

    browser.handleInput('\u001b');
    assert.equal(finished, undefined, 'the first escape only clears the query');
    await wait(30);
    assert.deepEqual(calls.at(-1), 'popular', 'clearing the query returns to the catalog');
    assert.ok(browser.render(80).some(line => line.includes('alpha')));

    browser.handleInput('\u001b');
    assert.equal(finished, null, 'the second escape cancels');
  } finally {
    browser.dispose();
  }
});
