// Unit test for the one Recent ordering function that the hub and the browser both import.
import assert from 'node:assert/strict';
import { orderRecents } from '../public/assets/recent-order.js';
import { ACTIVITY_20261002, EXPECTED_20261002, OBSERVED_20261002, greenFirst } from './recent-evidence.mjs';

const sessions = OBSERVED_20261002.map(([name]) => ({ name, exited: false }));
const status = Object.fromEntries(OBSERVED_20261002.map(([name, state]) => [name, {
  state, updatedAt: ACTIVITY_20261002[name], lastResponseAt: 0, lastActivityAt: ACTIVITY_20261002[name],
}]));

const evidence = orderRecents(sessions, status, 15);
assert.deepEqual(evidence.map((row) => row.session_name), EXPECTED_20261002);
assert.equal(greenFirst(evidence), true);
assert.ok(evidence.findIndex((row) => row.session_name === 'session-a') < evidence.findIndex((row) => row.state === 'idle'));
assert.deepEqual(evidence.map((row) => row.last_activity_at), EXPECTED_20261002.map((name) => ACTIVITY_20261002[name]));
assert.deepEqual(orderRecents(sessions, status, 3).map((row) => row.session_name), ['session-a', 'session-b', 'session-c']);
assert.deepEqual(orderRecents(sessions, status, 0), []);

const tiers = orderRecents(
  ['absent-new', 'sleeping-new', 'idle-b', 'idle-a', 'background-old', 'waking', 'unknown-new', 'busy-mid', 'idle-old', 'listed-only', 'gone']
    .map((name) => ({ name, exited: name === 'gone', lastActivityAt: name === 'listed-only' ? 99999 : 0 })),
  {
    'absent-new': { state: 'absent', lastActivityAt: 9000 },
    'sleeping-new': { state: 'sleeping', lastActivityAt: 8000 },
    'idle-b': { state: 'idle', lastActivityAt: 5000 },
    'idle-a': { state: 'idle', lastActivityAt: 5000 },
    'background-old': { state: 'background', lastActivityAt: 1000 },
    waking: { state: 'sleeping', lastActivityAt: 7000 },
    'unknown-new': { state: 'unknown', lastActivityAt: 9500 },
    'busy-mid': { state: 'busy', lastActivityAt: 4000 },
    'idle-old': { state: 'idle', lastActivityAt: 100 },
    gone: { state: 'busy', lastActivityAt: 99999 },
  },
  15,
  { waking: new Set(['waking']) },
);
assert.deepEqual(tiers.map((row) => [row.session_name, row.state]), [
  ['background-old', 'background'], ['busy-mid', 'busy'],
  ['idle-a', 'idle'], ['idle-b', 'idle'], ['idle-old', 'idle'],
  ['sleeping-new', 'sleeping'], ['waking', 'waking'],
  ['listed-only', 'unknown'], ['unknown-new', 'unknown'], ['absent-new', 'absent'],
]);

// Before the first status snapshot, the session list's own activity decides the light.
const early = orderRecents([
  { name: 'old-busy', activity: 'busy', lastActivityAt: 10 },
  { name: 'new-idle', activity: 'idle', lastActivityAt: 20 },
  { name: 'asleep', activity: 'idle', sleeping: true, lastActivityAt: 30 },
], {}, 5, { authoritative: false });
assert.deepEqual(early.map((row) => [row.session_name, row.state]), [['old-busy', 'busy'], ['new-idle', 'idle'], ['asleep', 'sleeping']]);

// Working sessions report a tool event every few seconds, and each one moves lastActivityAt.
// Generated runs of such events must never change the order. A row moves only when its group
// changes, and then no other row changes place relative to the rest.
function seeded(seed) {
  let x = seed >>> 0;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
}
const LIGHTS = ['busy', 'background', 'idle', 'sleeping', 'absent', 'unknown'];
for (let run = 0; run < 200; run += 1) {
  const random = seeded(run + 1);
  const count = 3 + Math.floor(random() * 10);
  const names = Array.from({ length: count }, (_, i) => `s${String.fromCharCode(97 + Math.floor(random() * 26))}${i}`);
  const list = names.map((name) => ({ name, exited: false }));
  const lights = Object.fromEntries(names.map((name) => [name, {
    state: LIGHTS[Math.floor(random() * LIGHTS.length)], lastActivityAt: 1000 + Math.floor(random() * 100000),
  }]));
  let order = orderRecents(list, lights, 15).map((row) => row.session_name);
  for (let step = 0; step < 40; step += 1) {
    const name = names[Math.floor(random() * names.length)];
    const before = lights[name].state;
    const green = before === 'busy' || before === 'background';
    // A tool event: new activity time, and sometimes busy <-> background, both green.
    const next = green && random() < 0.3 ? (before === 'busy' ? 'background' : 'busy') : before;
    if (green || random() < 0.5) {
      lights[name] = { state: next, lastActivityAt: lights[name].lastActivityAt + 1 + Math.floor(random() * 5000) };
      const now = orderRecents(list, lights, 15).map((row) => row.session_name);
      if (green) assert.deepEqual(now, order, `run ${run} step ${step}: a tool event on ${name} reordered Recent`);
      order = now;
      continue;
    }
    // A group change: only the changed row may move.
    lights[name] = { state: LIGHTS[Math.floor(random() * LIGHTS.length)], lastActivityAt: lights[name].lastActivityAt + 1 };
    const now = orderRecents(list, lights, 15).map((row) => row.session_name);
    assert.deepEqual(now.filter((n) => n !== name), order.filter((n) => n !== name), `run ${run} step ${step}: only ${name} moved`);
    order = now;
  }
  // The order is a function of the data, so a reload computes the same list.
  assert.deepEqual(orderRecents(list, structuredClone(lights), 15).map((row) => row.session_name), order);
}

console.log('Recent order puts green first by name, then idle, sleeping and the rest, newest first, ties by name; tool events never reorder it: PASS');
