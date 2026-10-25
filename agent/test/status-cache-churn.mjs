import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (typeof global.gc !== 'function') throw new Error('run with --expose-gc');
const modulePath = process.env.STATUS_MODULE || new URL('../src/status.js', import.meta.url).href;
const { aggregateSessionActivity } = await import(modulePath);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcw-cache-churn-'));
const now = Date.now();
global.gc(); const before = process.memoryUsage().heapUsed;
for (let index = 0; index < 256; index += 1) {
  const file = path.join(root, `${index}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: 'user', timestamp: new Date(now - 1).toISOString(), message: { role: 'user', content: 'x'.repeat(200 * 1024) } }) + '\n');
  const name = `owner-${index}`;
  const panes = new Map([[`${name}\0` + '0', { session: name, pane: '0', startedAt: 1, pids: [index + 10], processes: [{ pid: index + 10, startTicks: 1 }], commands: [['claude', '--resume', file]], cwd: null }]]);
  aggregateSessionActivity([name], panes, { statusDir: root, now });
}
global.gc(); const delta = process.memoryUsage().heapUsed - before;
assert.ok(delta < 20 * 1024 * 1024, `retained ${delta} bytes`);
console.log(`status cache owner churn retained ${delta} bytes: PASS`);
