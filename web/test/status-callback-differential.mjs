import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { StatusLease } from '../public/assets/status-lease.js';

const appPath = process.argv[2] || new URL('../public/app.js', import.meta.url);
const source = fs.readFileSync(appPath, 'utf8');
const match = source.match(/function startEvents\(\) \{[\s\S]*?\n\}\n\nfunction canMutate/);
assert.ok(match, 'the real startEvents callback must be extractable');

let listener;
const sessions = {};
const lease = new StatusLease({
  onChange(next) { Object.assign(sessions, next); },
  now: () => 1_000,
  schedule: () => 1,
  cancel: () => {},
});
const context = {
  S: { sessionStatus: {} },
  eventSource: null,
  EventSource: class {
    addEventListener(type, callback) { if (type === 'sessions.status') listener = callback; }
    close() {}
  },
  JSON,
  render() {},
  refreshState() {},
  applyStatusSnapshot(snapshot) { lease.apply(snapshot); context.S.sessionStatus = { ...sessions }; },
};
const startEventsSource = match[0].replace(/\n\nfunction canMutate$/, '');
vm.runInNewContext(`${startEventsSource}\nstartEvents();`, context, { filename: appPath.toString() });
assert.equal(typeof listener, 'function', 'the actual sessions.status event callback is installed');

listener({ data: JSON.stringify({
  session_status: { demo: { state: 'unknown', updatedAt: 11 } },
  session_status_meta: { connection_epoch: 7, revision: 11, lease_ms: 5_000 },
}) });
listener({ data: JSON.stringify({
  session_status: { demo: { state: 'busy', updatedAt: 10 } },
  session_status_meta: { connection_epoch: 7, revision: 10, lease_ms: 5_000 },
}) });

assert.equal(context.S.sessionStatus.demo.state, 'unknown', 'a delayed busy event cannot overwrite a newer unknown snapshot');
console.log('real browser event callback retains newer unknown status');
