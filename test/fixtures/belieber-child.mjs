// Credential-free stand-in for the pinned Pi JSON CLI, used only by runner tests.
let task = '';
for await (const chunk of process.stdin) task += chunk;
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const usage = {
  input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18,
  cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.033 },
};
if (task.endsWith('malformed')) {
  process.stdout.write('not json\n');
} else if (task.endsWith('invalid-event')) {
  emit({ type: 'message_end' });
} else if (task.endsWith('oversized')) {
  process.stdout.write('x'.repeat(3 * 1024 * 1024));
} else if (task.endsWith('fail')) {
  process.stderr.write('Model unavailable in child.');
  process.exitCode = 1;
} else if (task.endsWith('hang')) {
  process.on('SIGTERM', () => {});
  emit({ type: 'tool_execution_start', toolName: 'read' });
  setInterval(() => {}, 1000);
} else {
  emit({ type: 'session' });
  emit({ type: 'tool_execution_start', toolName: 'read' });
  emit({ type: 'message_end', message: {
    role: 'assistant', content: [{ type: 'text', text: `report ♥\u2028${task}` }], usage,
    stopReason: task.endsWith('model-error') ? 'error' : 'stop',
    errorMessage: task.endsWith('model-error') ? 'Provider rejected request.' : undefined,
  } });
  emit({ type: 'compaction_end', result: { usage } });
  if (!task.endsWith('unsettled')) emit({ type: 'agent_settled', aborted: false });
}
