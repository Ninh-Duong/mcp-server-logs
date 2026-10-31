#!/usr/bin/env node
// Keep this entry stdlib-only: reject unsupported Node before loading the SDK.
if (Number(process.versions.node.split('.')[0]) < 22) {
  process.stderr.write(`[start] Node ${process.versions.node} is too old; install Node 22 or newer.\n`);
  process.exit(1);
}

try {
  const { main } = await import('./dist/index.js');
  await main();
} catch (err) {
  process.stderr.write(`[start] Fatal startup error: ${err.message}\n`);
  process.exit(1);
}
