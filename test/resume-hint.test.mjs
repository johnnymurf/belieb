import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installResumeHint } from '../dist/resume-hint.js';

function terminal(isTTY = true) {
  const calls = [];
  const stream = {
    isTTY,
    write(...args) {
      assert.equal(this, stream);
      calls.push(args);
      return false;
    },
  };
  installResumeHint(stream);
  return { stream, calls };
}

test('terminal resume hints use belieb and preserve session arguments and styling', () => {
  const { stream, calls } = terminal();
  stream.write('To resume this session: pi --session abc-123\n');
  stream.write("\x1b[2mTo resume this session:\x1b[22m pi --session-dir '/tmp/my sessions' --session abc-123\n");
  assert.deepEqual(calls.map(args => args[0]), [
    'To resume this session: belieb --session abc-123\n',
    "\x1b[2mTo resume this session:\x1b[22m belieb --session-dir '/tmp/my sessions' --session abc-123\n",
  ]);
});

test('other output, binary writes and write arguments are untouched', () => {
  const { stream, calls } = terminal();
  const callback = () => {};
  const buffer = Buffer.from('pi --session abc-123');
  assert.equal(stream.write('pi --session abc-123\n', 'utf8', callback), false);
  stream.write('Example: To resume this session: pi --session abc-123\n');
  stream.write(buffer, callback);
  assert.deepEqual(calls, [
    ['pi --session abc-123\n', 'utf8', callback],
    ['Example: To resume this session: pi --session abc-123\n'],
    [buffer, callback],
  ]);
});

test('redirected output is not intercepted', () => {
  const calls = [];
  const write = (...args) => { calls.push(args); return true; };
  const stream = { isTTY: false, write };
  installResumeHint(stream);
  assert.equal(stream.write, write);
  stream.write('To resume this session: pi --session abc-123\n');
  assert.equal(calls[0][0], 'To resume this session: pi --session abc-123\n');
});
