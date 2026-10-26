// Credential-free stand-in for the pinned Pi CLI: records argv, never touches the network.
const args = process.argv.slice(2);
if (args.includes('slow')) {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else if (args.includes('explode')) {
  process.stderr.write('registry says no\n');
  process.exitCode = 3;
} else {
  process.stdout.write(`${JSON.stringify({ args })}\n`);
}
