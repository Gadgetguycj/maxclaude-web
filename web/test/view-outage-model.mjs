// Unit test for the sidebar model while the agent or the hub is away (rc-v25 finding N1). The
// tree is drawn from the hub's leaves and the session list only decorates it. When the list is
// unknown every row stays where it was, keyed the same, with an unknown light.
import assert from 'node:assert/strict';
import { createState, applyServerState, applyStateError, applyStatus } from '../public/assets/view/store.js';
import { sidebarModel, flatRows } from '../public/assets/view/model.js';
import { orderRecents } from '../public/assets/recent-order.js';

const NOW = 1_800_000_000_000;

// fx-1 and fx-2 have root leaves, as New session at the top level makes. fx-3 is in a folder.
// fx-4 has no leaf at all, as a session made outside the web page.
const tree = [
  { id: 'f1', kind: 'folder', name: 'Work', parent_id: null, position: 1000 },
  { id: 'l1', kind: 'session', name: 'fx-1', session_name: 'fx-1', parent_id: null, position: 2000 },
  { id: 'l2', kind: 'session', name: 'fx-2', session_name: 'fx-2', parent_id: null, position: 3000 },
  { id: 'l3', kind: 'session', name: 'fx-3', session_name: 'fx-3', parent_id: 'f1', position: 1000 },
];
const sessions = [
  { name: 'fx-1', createdAt: NOW - 400000, originalCreatedAt: NOW - 400000, exited: false, lastActivityAt: NOW - 4000 },
  { name: 'fx-2', createdAt: NOW - 300000, originalCreatedAt: NOW - 300000, exited: false, lastActivityAt: NOW - 3000 },
  { name: 'fx-3', createdAt: NOW - 200000, originalCreatedAt: NOW - 200000, exited: false, lastActivityAt: NOW - 2000 },
  { name: 'fx-4', createdAt: NOW - 100000, originalCreatedAt: NOW - 100000, exited: false, lastActivityAt: NOW - 1000 },
];
const status = Object.fromEntries(sessions.map((s, i) => [s.name, { state: i % 2 ? 'busy' : 'idle', lastActivityAt: s.lastActivityAt }]));
// The hub orders Recent with the same module and the same status the page has.
const recents = orderRecents(sessions, status, 5);

const connected = { agent: { connected: true }, tree, sessions, recents, recent_limit: 5 };
// What the hub answers while its agent is away: the tree, and no session list or Recent.
const agentAway = { agent: { connected: false }, tree, sessions: null, recents: [], recent_limit: 5 };

const sessionRows = (state) => flatRows(sidebarModel(state)).filter((row) => ['leaf', 'unfiled', 'recent'].includes(row.kind));
const shape = (rows) => rows.map((row) => [row.key, row.name, row.age]);
const unfiled = (state) => {
  const rows = flatRows(sidebarModel(state));
  const at = rows.findIndex((row) => row.key === 'section:__unfiled__');
  return rows.slice(at + 1).map((row) => row.name);
};

const state = createState({ now: NOW });
applyServerState(state, connected);
applyStatus(state, status, true);
const before = sessionRows(state);
assert.deepEqual(unfiled(state), ['fx-4', 'fx-2', 'fx-1'], 'Unfiled is the leafless session and both root leaves, newest first');
assert.ok(before.every((row) => row.state !== 'unknown'), 'every light is known while the agent is connected');
console.log('connected: Unfiled holds the leafless session and both root leaves: PASS');

/* The agent drops. The hub still sends its leaves, with no session list. */
applyServerState(state, agentAway);
let rows = sessionRows(state);
assert.deepEqual(shape(rows), shape(before), 'agent away: every row stays, keyed, named, ordered and aged as before');
assert.ok(rows.every((row) => row.state === 'unknown'), 'agent away: every light is unknown');
assert.ok(rows.every((row) => !row.create), 'agent away: no row offers Create');
assert.deepEqual(unfiled(state), ['fx-4', 'fx-2', 'fx-1'], 'agent away: Unfiled keeps its members and order');
console.log('agent away: every row stays with an unknown light: PASS');

/* The hub drops too. No state read answers at all. */
applyStateError(state, 'Cannot reach the server.');
rows = sessionRows(state);
assert.deepEqual(shape(rows), shape(before), 'hub away: every row stays, keyed, named, ordered and aged as before');
assert.ok(rows.every((row) => row.state === 'unknown'), 'hub away: every light is unknown');
console.log('hub away: every row stays with an unknown light: PASS');

/* The hub comes back before its agent, then the agent. */
applyServerState(state, agentAway);
assert.deepEqual(shape(sessionRows(state)), shape(before), 'hub back, agent away: every row stays');
applyServerState(state, connected);
applyStatus(state, status, true);
rows = sessionRows(state);
assert.deepEqual(shape(rows), shape(before), 'both back: the same rows');
assert.deepEqual(rows.map((row) => row.state), before.map((row) => row.state), 'both back: the lights return');
console.log('both back: the same rows with their lights: PASS');

/* A session deleted while the agent was away goes when the list comes back. */
applyServerState(state, agentAway);
applyServerState(state, { ...connected, sessions: sessions.filter((s) => s.name !== 'fx-4'), recents: recents.filter((r) => r.session_name !== 'fx-4') });
assert.deepEqual(unfiled(state), ['fx-2', 'fx-1'], 'the next list decides membership again');
console.log('the next session list decides which leafless sessions remain: PASS');

/* A page loaded while the agent is away has never seen a session list. Root leaves still show. */
const cold = createState({ now: NOW });
applyServerState(cold, agentAway);
assert.deepEqual(unfiled(cold).sort(), ['fx-1', 'fx-2'], 'a cold page shows the root leaves');
assert.ok(sessionRows(cold).every((row) => row.state === 'unknown' && !row.create), 'with unknown lights and no Create');
console.log('a page loaded while the agent is away shows the root leaves: PASS');
