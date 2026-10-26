import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { visibleWidth } from '@earendil-works/pi-tui';
import { cappedText, childArgs, emptyUsage, runBelieber, runBeliebers } from '../dist/belieber-runner.js';
import { beliebersConfig, loadConfig, saveConfig } from '../dist/config.js';
import { registerBeliebers } from '../dist/beliebers.js';
import { pickModel } from '../dist/model-picker.js';
import { sessionTotals } from '../dist/usage.js';

const fixture = fileURLToPath(new URL('./fixtures/belieber-child.mjs', import.meta.url));
const model = { provider: 'local', id: 'test-model', name: 'Test model' };
const modelId = `${model.provider}/${model.id}`;
const theme = { fg: (_color, text) => text, bold: text => text };

function harness(options = {}) {
  const commands = new Map();
  const tools = new Map();
  const handlers = new Map();
  const notifications = [];
  const state = {
    config: { mood: 'purpose', plain: false, notify: false, beliebers: { model: null, parallelism: 2 } },
    inPlanMode: false,
  };
  const pi = {
    registerCommand(name, value) { commands.set(name, value); },
    registerTool(tool) { tools.set(tool.name, tool); },
    on(name, callback) { handlers.set(name, callback); },
  };
  const ctx = {
    cwd: tmpdir(), hasUI: true, mode: 'tui',
    isProjectTrusted: () => false,
    modelRegistry: { getAvailable: () => [model] },
    ui: {
      notify(message, type) { notifications.push({ message, type }); },
      select: async () => undefined,
      custom: async () => undefined,
    },
    ...options,
  };
  registerBeliebers(pi, state);
  return { state, ctx, commands, tool: tools.get('beliebers'), handlers, notifications };
}

function options(task, extra = {}) {
  return { task, cwd: tmpdir(), model: modelId, plan: false, trusted: false, cliPath: fixture, ...extra };
}
function result(task) {
  return { task, status: 'queued', activity: 'queued', output: '', usage: emptyUsage() };
}
async function isolatedConfig(fn) {
  const home = mkdtempSync(join(tmpdir(), 'beliebers-config-'));
  const old = process.env.BELIEB_DIR;
  process.env.BELIEB_DIR = home;
  try { return await fn(home); } finally {
    if (old === undefined) delete process.env.BELIEB_DIR;
    else process.env.BELIEB_DIR = old;
    rmSync(home, { recursive: true, force: true });
  }
}

test('Beliebers config migrates older preferences, validates values, and round-trips', async () => {
  await isolatedConfig(home => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ mood: 'justice', plain: true }));
    const config = loadConfig();
    assert.deepEqual(config.beliebers, { model: null, parallelism: 2, access: 'read' });
    config.beliebers = { model: 'openrouter/provider/model', parallelism: 4, access: 'read' };
    saveConfig(config);
    assert.deepEqual(loadConfig(), config);
    assert.equal(loadConfig().mood, 'justice');
    assert.deepEqual(beliebersConfig({ model: 'fuzzy-name', parallelism: 100 }), { model: null, parallelism: 2, access: 'read' });
    for (const value of [0, -1, 1.5, '2', null]) assert.equal(beliebersConfig({ parallelism: value }).parallelism, 2);
  });
});

test('/beliebers uses the scrolling model picker and persists without changing the main model', async () => {
  await isolatedConfig(async home => {
    const run = harness();
    const picks = ['Choose model'];
    run.ctx.ui.select = async () => picks.shift();
    run.ctx.ui.custom = async () => modelId;
    await run.commands.get('beliebers').handler('', run.ctx);
    assert.equal(run.state.config.beliebers.model, modelId);
    const completion = run.commands.get('beliebers').getArgumentCompletions('parallel 3')[0];
    assert.equal(completion.value, 'parallel 3'); // Pi replaces the whole argument string
    await run.commands.get('beliebers').handler(completion.value, run.ctx);
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'config.json'))).beliebers, { model: modelId, parallelism: 3, access: 'read' });
    assert.equal(loadConfig().mood, 'purpose');
    await run.commands.get('beliebers').handler('parallel 9', run.ctx);
    assert.equal(run.state.config.beliebers.parallelism, 3);
    await run.commands.get('beliebers').handler('model unknown/model', run.ctx);
    assert.equal(run.state.config.beliebers.model, modelId);
    await run.commands.get('beliebers').handler('off', run.ctx);
    assert.equal(run.state.config.beliebers.model, null);
  });
});

test('settings handle cancelled pickers, missing auth, headless mode, and save failures', async () => {
  await isolatedConfig(async home => {
    const run = harness();
    const handler = run.commands.get('beliebers').handler;
    await handler('', run.ctx);
    assert.equal(run.notifications.length, 0);
    run.ctx.modelRegistry.getAvailable = () => [];
    await handler('model', run.ctx);
    assert.match(run.notifications.at(-1).message, /login/);
    await handler('off', { hasUI: false, get ui() { throw Error('headless UI'); } });
    run.ctx.modelRegistry.getAvailable = () => [model];
    mkdirSync(join(home, 'config.json'));
    await handler(`model ${modelId}`, run.ctx);
    assert.equal(run.state.config.beliebers.model, null);
    assert.equal(run.notifications.at(-1).type, 'error');
  });
});

test('the model picker keeps long model lists on screen and scrolls to the last one', async () => {
  const models = Array.from({ length: 40 }, (_, index) => ({
    provider: 'test-provider',
    id: `model-${String(index).padStart(2, '0')}`,
  }));
  let component;
  const ctx = {
    mode: 'tui', hasUI: true,
    ui: {
      select: async () => assert.fail('the TUI picker must not fall back to ctx.ui.select'),
      custom: factory => new Promise(resolve => {
        const tui = { terminal: { rows: 20, columns: 100 }, requestRender() {} };
        component = factory(tui, theme, {}, resolve);
      }),
    },
  };

  const choice = pickModel(ctx, models, 'test-provider/model-00');
  const lines = component.render(100);
  assert.ok(lines.length <= 20, `${lines.length} lines rendered in a 20 row terminal`);
  assert.ok(lines.some(line => line.includes('model-00')));
  assert.ok(!lines.some(line => line.includes('model-39')));

  for (let step = 1; step < models.length; step += 1) component.handleInput('\x1b[B');
  const scrolled = component.render(100);
  assert.ok(scrolled.length <= 20, `${scrolled.length} lines rendered after scrolling`);
  assert.ok(scrolled.some(line => line.includes('model-39')), 'the last model scrolls into view');
  assert.ok(scrolled.some(line => line.includes('(40/40)')), 'the scroll indicator tracks the position');

  component.handleInput('\r');
  assert.equal(await choice, 'test-provider/model-39');
});

test('the model picker falls back to the built-in selector outside the TUI', async () => {
  const titles = [];
  const models = [{ provider: 'local', id: 'one' }, { provider: 'local', id: 'two' }];
  const ctx = {
    mode: 'rpc', hasUI: true,
    ui: { select: async (title, options) => { titles.push(title); return options.at(-1); } },
  };
  assert.equal(await pickModel(ctx, models, null), 'local/two');
  assert.deepEqual(titles, ['Beliebers model']);
});

test('tool checks configuration, does not substitute models, and explains invalid requests', async () => {
  const run = harness();
  assert.equal(run.tool.executionMode, 'sequential');
  assert.equal(run.tool.exposure, 'model-only');
  assert.match(run.tool.promptGuidelines.join(' '), /asks to use subagents/);
  let response = await run.tool.execute('1', { action: 'list' }, undefined, undefined, run.ctx);
  assert.equal(response.details.ready, false);
  assert.match(response.content[0].text, /beliebers model/);
  response = await run.tool.execute('2', { action: 'run', tasks: ['inspect'] }, undefined, undefined, run.ctx);
  assert.equal(response.isError, true);
  run.state.config.beliebers.model = 'missing/model';
  response = await run.tool.execute('3', { action: 'list' }, undefined, undefined, run.ctx);
  assert.equal(response.details.ready, false);
  assert.equal(response.details.model, 'missing/model');
  response = await run.tool.execute('4', { action: 'run', tasks: ['  '] }, undefined, undefined, run.ctx);
  assert.equal(response.isError, true);
  const rendered = run.tool.renderResult(response, { expanded: false }, theme).render(70).join('\n');
  assert.match(rendered, /non-empty/);
  run.state.config.beliebers.model = modelId;
  run.state.inPlanMode = true;
  response = await run.tool.execute('5', { action: 'list' }, undefined, undefined, run.ctx);
  assert.equal(response.details.ready, true);
  assert.equal(response.details.plan, true);
});

test('child loadout is strictly read-only, isolated, exact-model, and trust-aware', () => {
  const args = childArgs(options('@file --model other/model', { plan: true }));
  assert.ok(args.includes('--no-session'));
  for (const flag of ['--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-approve']) {
    assert.ok(args.includes(flag));
  }
  assert.equal(args[args.indexOf('--provider') + 1], 'local');
  assert.equal(args[args.indexOf('--model') + 1], 'test-model');
  assert.equal(args[args.indexOf('--tools') + 1], 'read,grep,find,ls');
  assert.match(args[args.indexOf('--append-system-prompt') + 1], /PLAN MODE/);
  assert.ok(!args.includes('@file --model other/model'));
  assert.ok(childArgs(options('task', { trusted: true })).includes('--approve'));
});

test('runner streams activity, preserves literal tasks and Unicode, and aggregates usage', async () => {
  const task = '@file --model other/model ♥';
  const record = result(task);
  const updates = [];
  await runBelieber(options(task, { onUpdate: value => updates.push(value.activity) }), record);
  assert.equal(record.status, 'done');
  assert.ok(updates.includes('read'));
  assert.match(record.output, /\u2028Delegated task:/);
  assert.ok(record.output.endsWith(task));
  assert.equal(record.usage.input, 20);
  assert.equal(record.usage.cost.total, 0.066);
  const totals = sessionTotals([{ type: 'message', message: { role: 'toolResult', usage: record.usage } }]);
  assert.equal(totals.cost, 0.066);
});

test('runner reports child failures, malformed events, oversized records, and incomplete runs', async () => {
  for (const task of ['fail', 'model-error', 'malformed', 'invalid-event', 'oversized', 'unsettled']) {
    const record = result(task);
    await runBelieber(options(task), record);
    assert.equal(record.status, 'failed', task);
    assert.ok(record.error, task);
  }
});

test('runner cancellation escalates past ignored SIGTERM and cleans up', async () => {
  const controller = new AbortController();
  const record = result('hang');
  const started = Date.now();
  await runBelieber(options('hang', {
    signal: controller.signal, killAfterMs: 30,
    onUpdate(value) { if (value.activity === 'read') controller.abort(); },
  }), record);
  assert.equal(record.status, 'cancelled');
  assert.ok(Date.now() - started < 3000);
  const preAborted = result('task');
  await runBelieber(options('task', { signal: controller.signal }), preAborted);
  assert.equal(preAborted.status, 'cancelled');
});

test('runner times out unresponsive children', async () => {
  const record = result('hang');
  await runBelieber(options('hang', { timeoutMs: 200, killAfterMs: 30 }), record);
  assert.equal(record.status, 'failed');
  assert.match(record.error, /time limit/);
});

test('pool bounds concurrency, preserves order, and cancels queued tasks', async () => {
  let working = 0;
  let peak = 0;
  const runner = async (opts, record) => {
    working++;
    peak = Math.max(peak, working);
    await new Promise(resolve => setTimeout(resolve, 10));
    record.output = opts.task;
    record.status = 'done';
    working--;
  };
  const tasks = ['a', 'b', 'c', 'd', 'e'];
  const records = await runBeliebers(tasks, 2, options(''), runner);
  assert.equal(peak, 2);
  assert.deepEqual(records.map(record => record.output), tasks);
  const controller = new AbortController();
  let dispatched = 0;
  const aborted = await runBeliebers(tasks, 1, options('', { signal: controller.signal }), async (_opts, record) => {
    dispatched++;
    record.status = 'cancelled';
    controller.abort();
  });
  assert.equal(dispatched, 1);
  assert.ok(aborted.every(record => record.status === 'cancelled'));
});

test('session shutdown cancels active delegation and waits for child cleanup', async () => {
  const run = harness();
  run.state.config.beliebers = { model: modelId, parallelism: 1 };
  let shutdown;
  const response = await run.tool.execute('shutdown', { action: 'run', tasks: ['one', 'two'] },
    undefined, partial => {
      if (!shutdown && partial.details.results.some(item => item.status === 'working')) {
        shutdown = run.handlers.get('session_shutdown')();
      }
    }, run.ctx);
  await shutdown;
  assert.equal(response.isError, true);
  assert.ok(response.details.results.every(item => item.status === 'cancelled'));
  await run.handlers.get('session_shutdown')(); // idempotent
});

test('output is UTF-8 bounded, and tool rendering fits narrow terminals', () => {
  const capped = cappedText('♥'.repeat(100), 10);
  assert.ok(!capped.includes('\ufffd'));
  assert.match(capped, /truncated/);
  const run = harness();
  const response = {
    details: { model: modelId, parallelism: 2, readOnly: true, ready: true, plan: false,
      results: [{ ...result('Inspect authentication '.repeat(10)), status: 'working', activity: 'read',
        output: '\u001b]9;injected\u0007safe output' }] },
    content: [],
  };
  for (const width of [20, 40, 80]) {
    for (const expanded of [true, false]) {
      const lines = run.tool.renderResult(response, { expanded }, theme).render(width);
      assert.ok(lines.every(line => visibleWidth(line) <= width));
      assert.ok(lines.every(line => !line.includes('injected')));
    }
  }
});

test('real pinned CLI delegation works with a local mock provider, no credentials or network services', async () => {
  const home = mkdtempSync(join(tmpdir(), 'beliebers-cli-'));
  const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_OFFLINE: process.env.PI_OFFLINE };
  const requests = [];
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    requests.push(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null, usage) => res.write(`data: ${JSON.stringify({
      id: 'mock', object: 'chat.completion.chunk', created: 1, model: 'test-model',
      choices: [{ index: 0, delta, finish_reason }], usage,
    })}\n\n`);
    chunk({ role: 'assistant', content: 'Read-only investigation complete.' });
    chunk({}, 'stop', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    process.env.PI_CODING_AGENT_DIR = home;
    process.env.PI_OFFLINE = '1';
    writeFileSync(join(home, 'models.json'), JSON.stringify({ providers: { local: {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'mock-only',
      models: [{ id: 'test-model', name: 'Test model', reasoning: false, input: ['text'],
        contextWindow: 32000, maxTokens: 1000, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    const run = harness({ cwd: home });
    run.state.config.beliebers.model = modelId;
    run.state.inPlanMode = true;
    const updates = [];
    const response = await run.tool.execute('real', { action: 'run', tasks: ['Review auth', 'Review tests'] },
      undefined, partial => updates.push(partial), run.ctx);
    assert.equal(response.isError, false, response.content[0].text);
    assert.equal(response.details.results.length, 2);
    assert.ok(response.details.results.every(item => item.status === 'done'));
    assert.equal(requests.length, 2);
    assert.ok(requests.every(body => body.model === 'test-model'));
    assert.ok(requests.every(body => body.tools.map(tool => tool.function.name).sort().join(',') === 'find,grep,ls,read'));
    assert.ok(requests.every(body => JSON.stringify(body.messages).includes('PLAN MODE')));
    assert.ok(updates.length > 2);
    assert.ok(response.usage.cost.total > 0);
    assert.equal(updates[0].details.results[0].status, 'working'); // snapshots are not mutated later
    assert.equal(updates[0].details.results[1].status, 'queued');

    // Pi's CLI would fuzzy-match local/test to local/test-model; the internal
    // guard must refuse this before making a request to the wrong model.
    const mismatch = result('review');
    await runBelieber(options('review', { cwd: home, model: 'local/test', cliPath: undefined }), mismatch);
    assert.equal(mismatch.status, 'failed');
    assert.match(mismatch.error, /expected local\/test, resolved local\/test-model/);
    assert.equal(requests.length, 2);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await new Promise(resolve => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }
});
