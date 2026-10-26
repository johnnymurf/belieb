import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SubscriptionUsage, parseQuota, quotaSegments } from '../dist/subscription-usage.js';
import { OpenCodeUsageAuthError } from '../dist/opencode-usage.js';

const claude = { five_hour: { utilization: 28 }, seven_day: { utilization: 59 } };
const codex = { rate_limit: {
  primary_window: { used_percent: 28, limit_window_seconds: 18000, reset_at: 2000000000 },
  secondary_window: { used_percent: 59, limit_window_seconds: 604800, reset_at: 2000000000 },
} };
const jwt = `header.${Buffer.from(JSON.stringify({
  'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' },
})).toString('base64url')}.signature`;
const json = value => Response.json(value);

function context(provider = 'anthropic', extra = {}) {
  return {
    mode: 'tui',
    model: { provider, id: 'test', name: 'test' },
    modelRegistry: {
      isUsingOAuth: () => true,
      getProviderAuth: async () => ({ auth: { apiKey: provider === 'anthropic' ? 'test-token' : jwt } }),
    },
    ...extra,
  };
}

function setup(t, fetch, ctx = context(), options = {}) {
  let now = 1000000;
  let renders = 0;
  const requests = [];
  const usage = new SubscriptionUsage(() => renders++, async (...args) => {
    requests.push(args);
    return fetch(...args);
  }, () => now, options.openCodeAuth);
  t.after(() => usage.stop());
  usage.start(ctx, options.useOpenCode);
  return { usage, requests, advance: ms => { now += ms; }, renders: () => renders };
}

test('Claude and Codex report actual short-window and weekly percentages remaining', () => {
  for (const [provider, payload] of [['anthropic', claude], ['openai-codex', codex]]) {
    assert.deepEqual(quotaSegments(parseQuota(provider, payload), 1000000), [
      { text: '5h 72% left', low: false },
      { text: 'week 41% left', low: false },
    ]);
  }
  // A free account can put the weekly window in the primary slot.
  assert.equal(parseQuota('openai-codex', { rate_limit: {
    primary_window: { used_percent: 100, limit_window_seconds: 604800 },
  } })[0].label, 'week');
});

test('missing or malformed windows are unknown, not a fabricated 100% allowance', () => {
  for (const value of [null, [], {}, 'bad', { five_hour: null }, { five_hour: { utilization: '0' } },
    { five_hour: { utilization: Infinity } }]) {
    assert.deepEqual(parseQuota('anthropic', value), []);
  }
  assert.deepEqual(parseQuota('other', claude), []);
  assert.deepEqual(parseQuota('openai-codex', { rate_limit: { primary_window: { used_percent: 0 } } }), []);
  assert.deepEqual(quotaSegments(parseQuota('anthropic', { seven_day: { utilization: 100 } })), [
    { text: 'week 0% left', low: true },
  ]);
  assert.deepEqual(quotaSegments(parseQuota('anthropic', {
    five_hour: { utilization: -10 }, seven_day: { utilization: 120 },
  })), [{ text: '5h 100% left', low: false }, { text: 'week 0% left', low: true }]);
});

test('expired resets never imply a replenished allowance; tiny allowances remain explicit', () => {
  const windows = parseQuota('anthropic', {
    five_hour: { utilization: 100, resets_at: '2026-01-01T00:00:00Z' },
    seven_day: { utilization: 99.9, resets_at: 'bad date' },
  });
  assert.deepEqual(quotaSegments(windows, Date.parse('2026-01-02T00:00:00Z')), [
    { text: '5h —', low: false }, { text: 'week <1% left', low: true },
  ]);
});

test('polling uses only fixed official endpoints and Pi-resolved OAuth credentials', async t => {
  for (const provider of ['anthropic', 'openai-codex']) {
    const run = setup(t, () => json(provider === 'anthropic' ? claude : codex), context(provider));
    assert.deepEqual(run.usage.segments(), [{ text: 'limits …', low: false }]);
    await run.usage.refresh();
    const [url, options] = run.requests[0];
    assert.equal(url, provider === 'anthropic'
      ? 'https://api.anthropic.com/api/oauth/usage' : 'https://chatgpt.com/backend-api/wham/usage');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${provider === 'anthropic' ? 'test-token' : jwt}`);
    assert.equal(options.headers['anthropic-beta'], provider === 'anthropic' ? 'oauth-2025-04-20' : undefined);
    assert.equal(options.headers['ChatGPT-Account-Id'], provider === 'openai-codex' ? 'test-account' : undefined);
    assert.equal(options.signal.aborted, false);
    assert.equal(run.usage.segments()[0].text, '5h 72% left');
    assert.ok(run.renders() >= 2);
    await run.usage.refresh();
    run.usage.start(context(provider)); // Switching models on the same provider keeps the cache.
    await run.usage.refresh();
    assert.equal(run.requests.length, 1);
    run.advance(60000);
    await run.usage.refresh();
    assert.equal(run.requests.length, 2);
  }
});

test('headless, offline, unsupported providers and API-key accounts make no usage requests', async t => {
  for (const ctx of [context('other'), context('anthropic', { mode: 'print' }),
    context('anthropic', { mode: 'json' }), context('anthropic', { mode: 'rpc' }),
    context('anthropic', { modelRegistry: { isUsingOAuth: () => false } })]) {
    const run = setup(t, () => { throw new Error('must not fetch'); }, ctx);
    await run.usage.refresh();
    assert.deepEqual(run.usage.segments(), []);
    assert.equal(run.requests.length, 0);
  }
  const previous = process.env.PI_OFFLINE;
  try {
    for (const value of ['1', 'true', 'yes']) {
      process.env.PI_OFFLINE = value;
      const run = setup(t, () => { throw new Error('must not fetch'); });
      await run.usage.refresh();
      assert.equal(run.requests.length, 0);
      assert.deepEqual(run.usage.segments(), []);
    }
  } finally {
    if (previous === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previous;
  }
});

test('direct OpenAI OAuth and custom endpoints never send credentials to the wrong backend', async t => {
  for (const ctx of [context('openai'), context('anthropic', {
    model: { provider: 'anthropic', baseUrl: 'https://proxy.example/api' },
  }), context('openai-codex', { modelRegistry: {
    isUsingOAuth: () => true,
    getProviderAuth: async () => ({ auth: { apiKey: 'invalid-token' } }),
  } })]) {
    const run = setup(t, () => { throw new Error('must not fetch'); }, ctx);
    await run.usage.refresh();
    assert.equal(run.requests.length, 0);
    assert.deepEqual(run.usage.segments(), [{ text: 'limits unavailable', low: false }]);
  }
});

test('errors clear stale percentages and never expose credentials or provider response bodies', async t => {
  for (const failure of [() => new Response('private account details', { status: 403 }),
    () => { throw new Error('test-token'); }, () => new Response('not JSON'), () => json({})]) {
    let failing = false;
    const run = setup(t, () => failing ? failure() : json(claude));
    await run.usage.refresh();
    assert.equal(run.usage.segments()[0].text, '5h 72% left');
    failing = true;
    run.advance(60000);
    await run.usage.refresh();
    assert.deepEqual(run.usage.segments(), [{ text: 'limits unavailable', low: false }]);
  }
});

test('rate limiting respects Retry-After and backs off instead of repeatedly polling', async t => {
  const run = setup(t, () => new Response('', { status: 429, headers: { 'Retry-After': '900' } }));
  await run.usage.refresh();
  run.advance(300000);
  await run.usage.refresh();
  assert.equal(run.requests.length, 1);
  run.advance(600000);
  await run.usage.refresh();
  assert.equal(run.requests.length, 2);
});

test('OpenCode opt-in reads only the companion bearer, labels quotas, and rereads each poll', async t => {
  let reads = 0;
  let account = 'test-account';
  const run = setup(t, () => json(codex), context('openai'), {
    useOpenCode: true,
    openCodeAuth: async () => { reads++; return { access: jwt, accountId: account }; },
  });
  await run.usage.refresh();
  assert.equal(reads, 1);
  const [url, options] = run.requests[0];
  assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage');
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers.Authorization, `Bearer ${jwt}`);
  assert.equal(options.headers['ChatGPT-Account-Id'], 'test-account');
  assert.deepEqual(run.usage.segments(), [
    { text: 'OpenCode 5h 72% left', low: false }, { text: 'week 41% left', low: false },
  ]);
  account = 'next-account';
  run.advance(60000);
  await run.usage.refresh();
  assert.equal(reads, 2);
  assert.equal(run.requests[1][1].headers['ChatGPT-Account-Id'], account);
  run.usage.start(context('openai'), false);
  await run.usage.refresh();
  assert.equal(reads, 2);
  assert.deepEqual(run.usage.segments(), [{ text: 'limits unavailable', low: false }]);
});

test('OpenCode credentials are never read without opt-in, on API keys, headless, or on custom endpoints', async t => {
  let reads = 0;
  for (const [ctx, useOpenCode] of [
    [context('openai'), false],
    [context('openai', { mode: 'print' }), true],
    [context('openai', { mode: 'rpc' }), true],
    [context('other'), true],
    [context('openai', { modelRegistry: { isUsingOAuth: () => false } }), true],
    [context('openai', { model: { provider: 'openai', baseUrl: 'https://proxy.example' } }), true],
    [context('openai', { modelRegistry: {
      isUsingOAuth: () => true,
      getProviderAuth: async () => ({ auth: { apiKey: 'native-token', baseUrl: 'https://proxy.example' } }),
    } }), true],
  ]) {
    const run = setup(t, () => { throw new Error('must not fetch'); }, ctx, {
      useOpenCode, openCodeAuth: async () => { reads++; throw new Error('must not read'); },
    });
    await run.usage.refresh();
    assert.equal(run.requests.length, 0);
  }
  assert.equal(reads, 0);
});

test('missing or expired OpenCode logins clear quotas without falling back to native credentials', async t => {
  let fail;
  const run = setup(t, () => json(codex), context('openai', { modelRegistry: {
    isUsingOAuth: () => true,
    getProviderAuth: async () => ({ auth: { apiKey: 'native-secret-never-send' } }),
  } }), {
    useOpenCode: true,
    openCodeAuth: async () => {
      if (fail) throw new OpenCodeUsageAuthError(fail);
      return { access: jwt, accountId: 'test-account' };
    },
  });
  await run.usage.refresh();
  assert.equal(run.requests[0][1].headers.Authorization, `Bearer ${jwt}`);
  for (const reason of ['expired', 'missing', 'invalid']) {
    fail = reason;
    run.advance(60000);
    await run.usage.refresh();
    assert.deepEqual(run.usage.segments(), [{ text: `OpenCode login ${reason}`, low: false }]);
    assert.equal(run.requests.length, 1);
  }
});

test('revoking OpenCode opt-in ignores late credential resolution and makes no network request', async t => {
  let resolve;
  const run = setup(t, () => json(codex), context('openai'), {
    useOpenCode: true,
    openCodeAuth: () => new Promise(done => { resolve = done; }),
  });
  const pending = run.usage.refresh();
  await new Promise(done => setImmediate(done));
  run.usage.start(context('openai'), false);
  resolve({ access: jwt, accountId: 'test-account' });
  await pending;
  await run.usage.refresh();
  assert.equal(run.requests.length, 0);
  assert.deepEqual(run.usage.segments(), [{ text: 'limits unavailable', low: false }]);
});

test('shutdown and model switches abort in-flight requests and ignore late results', async t => {
  let resolve;
  const run = setup(t, () => new Promise(done => { resolve = done; }));
  const pending = run.usage.refresh();
  await new Promise(done => setImmediate(done));
  const signal = run.requests[0][1].signal;
  run.usage.start(context('other'));
  assert.equal(signal.aborted, true);
  resolve(json(claude));
  await pending;
  assert.deepEqual(run.usage.segments(), []);
  run.usage.start(context());
  const next = run.usage.refresh();
  await new Promise(done => setImmediate(done));
  run.usage.stop();
  assert.equal(run.requests[1][1].signal.aborted, true);
  resolve(json(claude));
  await next;
  assert.deepEqual(run.usage.segments(), []);
});
