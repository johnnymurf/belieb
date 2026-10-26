import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { Check } from 'typebox/value';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync,
  symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareTasks, scopedFile, approvedWrite } from '../dist/belieber-policy.js';
import { childArgs, runBeliebers } from '../dist/belieber-runner.js';
import { beliebersConfig, loadConfig } from '../dist/config.js';
import { registerBeliebers } from '../dist/beliebers.js';
import guard from '../dist/belieber-guard.js';

const model = { provider: 'local', id: 'test-model' };
const modelId = 'local/test-model';
const workspace = () => realpathSync(mkdtempSync(join(tmpdir(), 'belieber-workers-')));
function harness(cwd) {
  const commands = new Map(), tools = new Map(), notifications = [];
  const state = { config: { mood: 'purpose', plain: false, notify: false,
    beliebers: { model: modelId, parallelism: 2, access: 'read' } }, inPlanMode: false };
  const ctx = { cwd, hasUI: true, mode: 'tui', isProjectTrusted: () => false,
    modelRegistry: { getAvailable: () => [model] },
    ui: { notify: (message, type) => notifications.push({ message, type }),
      select: async () => undefined, confirm: async () => false } };
  registerBeliebers({ on() {}, registerCommand: (name, c) => commands.set(name, c),
    registerTool: t => tools.set(t.name, t) }, state);
  return { ctx, state, notifications, command: commands.get('beliebers'), tool: tools.get('beliebers') };
}
function env(values) {
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  return () => { for (const [key, value] of Object.entries(before)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } };
}

test('worker access is user-confirmed, persisted, reversible, and defaults to read', async () => {
  const root = workspace(), restore = env({ BELIEB_DIR: root });
  try {
    const h = harness(root); let confirmations = 0;
    h.ctx.ui.confirm = async () => { confirmations++; return false; };
    await h.command.handler('access write', h.ctx);
    assert.equal(confirmations, 1); assert.equal(h.state.config.beliebers.access, 'read');
    assert.equal(existsSync(join(root, 'config.json')), false);
    h.ctx.ui.confirm = async () => { confirmations++; return true; };
    await h.command.handler('access write', h.ctx);
    assert.equal(loadConfig().beliebers.access, 'write');
    assert.equal(h.state.config.beliebers.model, modelId);
    await h.command.handler('access read', h.ctx);
    assert.equal(confirmations, 2); assert.equal(loadConfig().beliebers.access, 'read');
    await h.command.handler('access all', h.ctx);
    assert.equal(loadConfig().beliebers.access, 'read');
    await h.command.handler('access write', { hasUI: false, get ui() { throw Error('headless'); } });
    assert.equal(loadConfig().beliebers.access, 'read');
    assert.equal(beliebersConfig({ access: true }).access, 'read');
    assert.equal(h.command.getArgumentCompletions('access w')[0].value, 'access write');
    assert.match(h.tool.promptGuidelines.join(' '), /delegate bulk code/);
    assert.match(h.tool.promptGuidelines.join(' '), /reviews actual file changes/);
    assert.match(h.tool.promptGuidelines.join(' '), /Do not ask them for large code blocks/);
    h.ctx.ui.select = async (_title, choices) => choices.includes('Set access') ? 'Set access' : 'read';
    await h.command.handler('', h.ctx);
    assert.equal(h.state.config.beliebers.access, 'read');
  } finally { restore(); rmSync(root, { recursive: true, force: true }); }
});

test('task policy scopes file workers, rejects overlapping ownership, and forces reviewers in plan mode', () => {
  const root = workspace();
  try {
    const task = { task: 'Implement a module.', mode: 'worker', files: ['src/new.ts'] };
    assert.deepEqual(prepareTasks(['Review it'], root, 'write', false)[0],
      { task: 'Review it', mode: 'reviewer', files: [] });
    assert.throws(() => prepareTasks([task], root, 'read', false), /access write/);
    assert.throws(() => prepareTasks([{ ...task, files: [] }], root, 'write', false), /files/);
    assert.throws(() => prepareTasks([task, task], root, 'write', false), /Overlapping/);
    assert.throws(() => prepareTasks([task, { ...task, files: ['SRC/NEW.ts'] }], root, 'write', false), /Overlapping/);
    assert.throws(() => prepareTasks([{ ...task, files: ['new'] }, { ...task, files: ['new/file'] }], root, 'write', false), /Overlapping/);
    assert.deepEqual(prepareTasks([task], root, 'read', true)[0],
      { task: task.task, mode: 'reviewer', files: [] });
    const args = childArgs({ ...task, cwd: root, model: modelId, plan: false, trusted: false });
    assert.equal(args[args.indexOf('--tools') + 1], 'read,grep,find,ls,edit,write');
    assert.match(args[args.indexOf('--append-system-prompt') + 1], /DIRECTLY/);
    assert.ok(args.includes('--no-mcp')); assert.ok(args.includes('--no-extensions'));
    const plan = childArgs({ ...task, cwd: root, model: modelId, plan: true, trusted: false });
    assert.equal(plan[plan.indexOf('--tools') + 1], 'read,grep,find,ls');
    assert.match(plan[plan.indexOf('--append-system-prompt') + 1], /PLAN MODE/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('scope blocks traversal, protected paths, symlinks, hardlinks and late path replacement', () => {
  const root = workspace(), outside = workspace();
  try {
    mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/a.ts'), 'a');
    for (const p of ['../outside', 'src/../../a', root + '/a', 'src', '.git/config', '.pi/a',
      '.belieb/config.json', 'node_modules/a', 'src/*.ts', '~/a', '@a', 'src/a.ts/child']) {
      assert.throws(() => scopedFile(root, p), undefined, p);
    }
    assert.equal(scopedFile(root, 'new/deep/file.ts'), 'new/deep/file.ts');
    symlinkSync(outside, join(root, 'escape'));
    symlinkSync(join(root, 'src'), join(root, 'alias'));
    assert.throws(() => scopedFile(root, 'escape/new.ts'), /symlink/);
    assert.throws(() => scopedFile(root, 'alias/a.ts'), /symlink/);
    linkSync(join(root, 'src/a.ts'), join(root, 'hard.ts'));
    assert.throws(() => scopedFile(root, 'hard.ts'), /hardlink/);
    assert.throws(() => scopedFile(root, 'src/a.ts'), /hardlink/);
    const approved = new Set([join(root, 'later/new.ts')]);
    assert.equal(approvedWrite(root, approved, 'later/new.ts'), join(root, 'later/new.ts'));
    assert.throws(() => approvedWrite(root, approved, 'other.ts'), /not an assigned/);
    symlinkSync(outside, join(root, 'later'));
    assert.throws(() => approvedWrite(root, approved, 'later/new.ts'), /symlink/);
    assert.equal(existsSync(join(outside, 'new.ts')), false);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('child guard authorizes every mutation, rejects undeclared tools, and rechecks links', async () => {
  const root = workspace();
  const restore = env({ BELIEB_CHILD_MODE: 'worker', BELIEB_CHILD_CWD: root,
    BELIEB_CHILD_MODEL: modelId, BELIEB_CHILD_FILES: JSON.stringify(['owned.ts']) });
  try {
    const handlers = new Map();
    guard({ on: (name, fn) => handlers.set(name, fn),
      getActiveTools: () => ['read', 'grep', 'find', 'ls', 'edit', 'write'] });
    const ctx = { cwd: root, model };
    await handlers.get('session_start')({}, ctx);
    const call = { toolName: 'write', input: { path: 'owned.ts' } };
    assert.equal(handlers.get('tool_call')(call, ctx), undefined);
    assert.equal(call.input.path, join(root, 'owned.ts'));
    assert.equal(handlers.get('tool_call')({ toolName: 'write', input: { path: 'other.ts' } }, ctx).block, true);
    assert.equal(handlers.get('tool_call')({ toolName: 'bash', input: {} }, ctx).block, true);
    assert.equal(handlers.get('tool_call')({ toolName: 'mcp__x__write', input: {} }, ctx).block, true);
    symlinkSync(join(root, 'other.ts'), join(root, 'owned.ts'));
    assert.equal(handlers.get('tool_call')({ toolName: 'write', input: { path: 'owned.ts' } }, ctx).block, true);
  } finally { restore(); rmSync(root, { recursive: true, force: true }); }
});

test('legacy running parents still launch guarded read-only reviewers after rebuilding', async () => {
  const restore = env({ BELIEB_CHILD_MODEL: modelId, BELIEB_CHILD_MODE: undefined,
    BELIEB_CHILD_CWD: undefined, BELIEB_CHILD_FILES: undefined });
  try {
    const handlers = new Map();
    guard({ on: (name, fn) => handlers.set(name, fn), getActiveTools: () => ['read', 'grep', 'find', 'ls'] });
    const ctx = { cwd: process.cwd(), model };
    await handlers.get('session_start')({}, ctx);
    assert.equal(handlers.get('tool_call')({ toolName: 'write', input: { path: 'anything' } }, ctx).block, true);
  } finally { restore(); }
});

test('model-facing schema accepts workers and legacy strings and rejects invalid roles', () => {
  const schema = harness(process.cwd()).tool.parameters;
  assert.equal(Check(schema, { action: 'run', tasks: ['Review.'] }), true);
  assert.equal(Check(schema, { action: 'run', tasks: [
    { task: 'Implement.', mode: 'worker', files: ['src/a.ts'] },
    { task: 'Review.', mode: 'reviewer' },
  ] }), true);
  assert.equal(Check(schema, { action: 'run', tasks: [{ task: 'Escalate.', mode: 'root' }] }), false);
  assert.equal(Check(schema, { action: 'run', tasks: [{ task: 'Bad paths.', mode: 'worker', files: [42] }] }), false);
});

test('worker pool preserves ownership and effective modes in cancellation and failure results', async () => {
  const root = workspace();
  try {
    const tasks = prepareTasks([{ task: 'Implement.', mode: 'worker', files: ['a.ts'] }, 'Review.'], root, 'write', false);
    const controller = new AbortController();
    const result = await runBeliebers(tasks, 1, { cwd: root, model: modelId, plan: false,
      trusted: false, signal: controller.signal }, async (options, record) => {
      assert.equal(options.mode, 'worker'); assert.deepEqual(options.files, ['a.ts']);
      controller.abort(); throw Error('interrupted');
    });
    assert.equal(result[0].status, 'failed'); assert.deepEqual(result[0].files, ['a.ts']);
    assert.equal(result[1].status, 'cancelled'); assert.equal(result[1].mode, 'reviewer');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function sse(res, delta, finish_reason = null) {
  res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 1,
    model: 'test-model', choices: [{ index: 0, delta, finish_reason }],
    ...(finish_reason ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}) })}\n\n`);
}

test('real CLI workers write/edit assigned files; off-list, reviewer and plan writes cannot land', async () => {
  const root = workspace(); const requests = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (body.messages.some(m => m.role === 'tool')) {
      sse(res, { role: 'assistant', content: 'Completed; main agent should inspect files and run tests.' });
      sse(res, {}, 'stop');
    } else {
      const calls = [
        { name: 'edit', args: { path: 'assigned.ts', edits: [{ oldText: 'version = 1', newText: 'version = 2' }] } },
        { name: 'write', args: { path: 'docs/new.md', content: 'Produced by worker.\n' } },
        { name: 'write', args: { path: 'sentinel.ts', content: 'unauthorized' } },
      ];
      sse(res, { role: 'assistant', tool_calls: calls.map((c, index) => ({
        index, id: `call_${index}`, type: 'function', function: { name: c.name, arguments: '' },
      })) });
      for (const [index, c] of calls.entries()) {
        const text = JSON.stringify(c.args), cut = Math.floor(text.length / 2);
        for (const part of [text.slice(0, cut), text.slice(cut)]) {
          sse(res, { tool_calls: [{ index, function: { arguments: part } }] });
        }
      }
      sse(res, {}, 'tool_calls');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const restore = env({ PI_CODING_AGENT_DIR: root, PI_OFFLINE: '1' });
  try {
    writeFileSync(join(root, 'models.json'), JSON.stringify({ providers: { local: {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'mock-only',
      models: [{ id: 'test-model', name: 'Test', reasoning: false, input: ['text'], contextWindow: 32000,
        maxTokens: 1000, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    const h = harness(root);
    const worker = { task: 'Implement the version and docs.', mode: 'worker', files: ['assigned.ts', 'docs/new.md'] };
    // No model request is sent when the user has not enabled workers.
    let response = await h.tool.execute('denied', { action: 'run', tasks: [worker] }, undefined, undefined, h.ctx);
    assert.equal(response.isError, true); assert.equal(requests.length, 0);
    for (const scenario of [{ worker: true, plan: false }, { worker: false, plan: false }, { worker: true, plan: true }]) {
      h.state.config.beliebers.access = 'write'; h.state.inPlanMode = scenario.plan;
      writeFileSync(join(root, 'assigned.ts'), 'export const version = 1;\n');
      writeFileSync(join(root, 'sentinel.ts'), 'sentinel');
      rmSync(join(root, 'docs'), { recursive: true, force: true });
      const start = requests.length;
      response = await h.tool.execute('real', { action: 'run', tasks: [scenario.worker ? worker : 'Review only.'] },
        undefined, undefined, h.ctx);
      assert.equal(response.isError, false, response.content[0].text);
      const writes = scenario.worker && !scenario.plan;
      assert.equal(response.details.results[0].mode, writes ? 'worker' : 'reviewer');
      assert.equal(response.details.readOnly, scenario.plan); // configured ceiling, not per-task mode
      assert.equal(readFileSync(join(root, 'assigned.ts'), 'utf8'), `export const version = ${writes ? 2 : 1};\n`);
      assert.equal(existsSync(join(root, 'docs/new.md')), writes);
      if (writes) assert.equal(readFileSync(join(root, 'docs/new.md'), 'utf8'), 'Produced by worker.\n');
      assert.equal(readFileSync(join(root, 'sentinel.ts'), 'utf8'), 'sentinel');
      const declared = requests[start].tools.map(t => t.function.name).sort();
      assert.deepEqual(declared, writes ? ['edit', 'find', 'grep', 'ls', 'read', 'write'] : ['find', 'grep', 'ls', 'read']);
      assert.equal(requests.length - start, 2);
      if (writes) assert.match(JSON.stringify(requests.at(-1).messages), /not an assigned worker file/);
    }
  } finally {
    restore(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true });
  }
});
