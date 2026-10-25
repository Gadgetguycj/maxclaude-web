import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanupSessionStatusDirectory } from '../src/sessions.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcw-status-namespace-'));
const namespace = path.join(root, 'A');
fs.mkdirSync(namespace);
fs.writeFileSync(path.join(namespace, '0.events.jsonl'), 'old hook namespace\n');

const renamedOwner = {
  claudePanes: new Map([['B\0' + '0', {
    session: 'B', hookSession: 'A', pane: '0', pids: [42], processes: [{ pid: 42, startTicks: 99 }],
  }]]),
};
assert.deepEqual(cleanupSessionStatusDirectory('A', { snapshot: renamedOwner, statusDir: root }), { removed: false, preserved: true });
assert.equal(fs.existsSync(namespace), true, 'A status remains while renamed B owns A hook namespace');

assert.throws(
  () => cleanupSessionStatusDirectory('A', { snapshot: null, statusDir: root }),
  /inventory is unavailable/,
);
assert.equal(fs.existsSync(namespace), true, 'an unavailable native inventory fails closed and preserves status');

// A session whose panes zellij did not list in time may hold a Claude that writes here.
assert.deepEqual(
  cleanupSessionStatusDirectory('A', { snapshot: { claudePanes: new Map(), incompleteSessions: new Set(['B']) }, statusDir: root }),
  { removed: false, preserved: true },
);
assert.equal(fs.existsSync(namespace), true, 'an inventory with an unread session preserves status');

assert.deepEqual(
  cleanupSessionStatusDirectory('A', { snapshot: { claudePanes: new Map(), incompleteSessions: new Set() }, statusDir: root }),
  { removed: true, preserved: false, directory: namespace },
);
assert.equal(fs.existsSync(namespace), false, 'status is removed only after a fresh empty live-pane inventory');
console.log('renamed hook namespace cleanup regression: PASS');
