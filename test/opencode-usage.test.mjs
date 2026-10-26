import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCodeAuthPaths, readOpenCodeUsageAuth } from '../dist/opencode-usage.js';

const now = 1000000;
const jwt = (accountId = 'test-account', exp = 2000) => `header.${Buffer.from(JSON.stringify({
  'https://api.openai.com/auth': { chatgpt_account_id: accountId }, exp,
})).toString('base64url')}.signature`;
const credential = (extra = {}) => ({ type: 'oauth', access: jwt(), accountId: 'test-account', expires: 2000000, ...extra });

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'belieb-opencode-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'auth.json');
  const save = (auth) => writeFile(path, JSON.stringify({ openai: auth }));
  const read = (paths = [path], signal = new AbortController().signal) => readOpenCodeUsageAuth(signal, paths, now);
  return { dir, path, save, read };
}

test('OpenCode auth paths honor XDG and Windows legacy locations', () => {
  assert.deepEqual(openCodeAuthPaths({}, '/home/test', 'darwin'), ['/home/test/.local/share/opencode/auth.json']);
  assert.deepEqual(openCodeAuthPaths({ XDG_DATA_HOME: '/custom' }, '/home/test', 'linux'), ['/custom/opencode/auth.json']);
  assert.deepEqual(openCodeAuthPaths({ APPDATA: '/roaming' }, '/home/test', 'win32'), [
    '/home/test/.local/share/opencode/auth.json', '/roaming/opencode/auth.json',
  ]);
});

test('OpenCode reader returns only matching usage credentials and leaves the file unchanged', async t => {
  const f = await fixture(t);
  await f.save(credential());
  const before = await readFile(f.path, 'utf8');
  assert.deepEqual(await f.read(), { access: jwt(), accountId: 'test-account' });
  assert.equal(await readFile(f.path, 'utf8'), before);
  // Reread on each poll: new OpenCode logins are not cached.
  await f.save(credential({ access: jwt('next'), accountId: 'next' }));
  assert.equal((await f.read()).accountId, 'next');
  assert.equal((await f.read([join(f.dir, 'missing'), f.path])).accountId, 'next');
});

test('missing, malformed, expired, mismatched and non-OAuth credentials fail without leaking secrets', async t => {
  const f = await fixture(t);
  await assert.rejects(f.read(), { reason: 'missing' });
  for (const auth of [null, {}, credential({ type: 'api_key' }), credential({ accountId: 'other' }),
    credential({ access: 'private-invalid-token' }), credential({ expires: 'bad' }),
    credential({ expires: now }), credential({ access: jwt('test-account', now / 1000) })]) {
    await f.save(auth);
    await assert.rejects(f.read(), error => {
      assert.match(error.reason, /invalid|expired/);
      assert.doesNotMatch(error.message, /test-account|private-invalid-token|signature/);
      return true;
    });
  }
  await writeFile(f.path, '{private-invalid-json');
  await assert.rejects(f.read(), { reason: 'invalid' });
  // An existing malformed primary path must not silently select another login.
  const other = join(f.dir, 'other.json');
  await writeFile(other, JSON.stringify({ openai: credential() }));
  await assert.rejects(f.read([f.path, other]), { reason: 'invalid' });
  await writeFile(f.path, 'x'.repeat(1024 * 1024 + 1));
  await assert.rejects(f.read(), { reason: 'invalid' });
});

test('OpenCode reader rejects symlinks and respects cancellation', async t => {
  const f = await fixture(t);
  const target = join(f.dir, 'target.json');
  await writeFile(target, JSON.stringify({ openai: credential() }));
  await symlink(target, f.path);
  await assert.rejects(f.read(), { reason: 'invalid' });
  await assert.rejects(f.read([target], AbortSignal.abort()), { name: 'AbortError' });
});
