import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const source = process.argv[2] || new URL('../public/assets/status-lease.js', import.meta.url).pathname;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcw-native-timers-'));
const browserSession = `mcw-native-timers-${process.pid}`;
fs.copyFileSync(source, path.join(root, 'status-lease.js'));
fs.writeFileSync(path.join(root, 'index.html'), `<!doctype html><html><body><script type="module">
import { StatusLease } from './status-lease.js';
const changes = [];
try {
  const lease = new StatusLease({ onChange: (sessions) => changes.push(sessions.demo.state) });
  const accepted = lease.apply({ session_status: { demo: { state: 'idle' } }, session_status_meta: { connection_epoch: 1, revision: 1, lease_ms: 25 } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  document.body.textContent = JSON.stringify({ accepted, changes, state: lease.sessions.demo.state });
} catch (error) { document.body.textContent = JSON.stringify({ error: String(error) }); }
</script></body></html>`);
const server = http.createServer((request, response) => {
  const file = request.url === '/status-lease.js' ? 'status-lease.js' : 'index.html';
  response.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : 'text/html');
  response.end(fs.readFileSync(path.join(root, file)));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
try {
  await run('agent-browser', ['--session', browserSession, 'open', url], { timeout: 30000 });
  await run('agent-browser', ['--session', browserSession, 'wait', '100'], { timeout: 30000 });
  const { stdout } = await run('agent-browser', ['--session', browserSession, 'eval', 'JSON.parse(document.body.textContent)'], { timeout: 30000 });
  const result = JSON.parse(stdout);
  assert.deepEqual(result, { accepted: true, changes: ['idle', 'unknown'], state: 'unknown' });
  console.log('native browser timers apply and expire status: PASS');
} finally {
  try { await run('agent-browser', ['--session', browserSession, 'close'], { timeout: 10000 }); } catch { /* cleanup */ }
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
