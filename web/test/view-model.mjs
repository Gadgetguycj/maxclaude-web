// Unit test for the sidebar's data model and store. These are pure functions, so this runs in
// Node with no browser. It checks the properties the keyed views rely on: every row has a
// unique key, a status change never changes a key, the tree carries levels and set positions,
// and a rename this browser started is one session under two names until it settles.
import assert from 'node:assert/strict';
import {
  createState, applyServerState, applyStatus, startRename, confirmRename, abortRename,
} from '../public/assets/view/store.js';
import { sidebarModel, flatRows, liveState, listedNames, hostName } from '../public/assets/view/model.js';

const NOW = 1_800_000_000_000;

function serverState(names, tree, recentLimit = 15) {
  return {
    agent: { connected: true },
    tree,
    sessions: names.map((name, index) => ({ name, createdAt: NOW - 100000 + index, exited: false })),
    recents: [],
    recent_limit: recentLimit,
  };
}

function lights(map) {
  return Object.fromEntries(Object.entries(map).map(([name, state], index) => [name, { state, lastActivityAt: NOW - index * 1000 }]));
}

const tree = [
  { id: 'f1', kind: 'folder', name: 'Work', parent_id: null, position: 1000 },
  { id: 'f2', kind: 'folder', name: 'Inner', parent_id: 'f1', position: 2000 },
  { id: 'l1', kind: 'session', name: 'beta', session_name: 'beta', parent_id: 'f1', position: 1000 },
  { id: 'l2', kind: 'session', name: 'gamma', session_name: 'gamma', parent_id: 'f2', position: 1000 },
];
const names = ['alpha', 'beta', 'gamma', 'delta'];

const state = createState({ now: NOW });
applyServerState(state, serverState(names, tree));
applyStatus(state, lights({ alpha: 'idle', beta: 'idle', gamma: 'idle', delta: 'idle' }), true);

/* Keys are unique and the tree carries levels, groups and positions. */
const first = flatRows(sidebarModel(state));
const keys = first.map((row) => row.key);
assert.equal(new Set(keys).size, keys.length, 'every row key is unique');
const byKey = Object.fromEntries(first.map((row) => [row.key, row]));
assert.equal(byKey['section:__folders__'].level, 1);
assert.equal(byKey['folder:f1'].level, 2);
assert.equal(byKey['leaf:l1'].level, 3);
assert.equal(byKey['folder:f2'].level, 3);
assert.equal(byKey['leaf:l2'].level, 4);
assert.deepEqual([byKey['leaf:l1'].posinset, byKey['leaf:l1'].setsize], [1, 2], 'beta is the first of Work\'s two children');
assert.equal(byKey['leaf:l2'].ariaLabel, 'gamma, waiting for input');
assert.ok(first.filter((row) => row.kind === 'unfiled').map((row) => row.name).sort().join() === 'alpha,delta');
console.log('rows have unique keys, levels, set positions and labels with state: PASS');

/* A status change changes lights and labels, never keys, and never the order outside Recent. */
for (const round of [
  { alpha: 'busy', beta: 'background', gamma: 'idle', delta: 'busy' },
  { alpha: 'idle', beta: 'busy', gamma: 'busy', delta: 'background' },
  { alpha: 'absent', beta: 'idle', gamma: 'unknown', delta: 'sleeping' },
]) {
  applyStatus(state, lights(round), true);
  const rows = flatRows(sidebarModel(state));
  assert.deepEqual(rows.map((row) => row.key).sort(), [...keys].sort(), 'a status change keeps every key');
  assert.deepEqual(rows.filter((row) => row.kind !== 'recent').map((row) => row.key),
    first.filter((row) => row.kind !== 'recent').map((row) => row.key), 'folders and Unfiled keep their order');
  for (const row of rows.filter((item) => item.name && round[item.name])) assert.equal(row.state, round[row.name]);
}
console.log('status changes keep every key and the order outside Recent: PASS');

/* A rename this browser started: one session under two names. */
applyStatus(state, lights({ alpha: 'idle', beta: 'idle', gamma: 'idle', delta: 'idle' }), true);
state.active = 'beta';
const before = flatRows(sidebarModel(state));
startRename(state, 'beta', 'beta-r');
// The host renamed. The hub's leaf still names beta until the rename answer.
applyServerState(state, serverState(['alpha', 'beta-r', 'gamma', 'delta'], tree));
applyStatus(state, lights({ alpha: 'idle', 'beta-r': 'idle', gamma: 'idle', delta: 'idle' }), true);
let rows = flatRows(sidebarModel(state));
assert.deepEqual(rows.map((row) => row.key), before.map((row) => row.key), 'the same rows, keyed the same, mid-rename');
const leaf = rows.find((row) => row.key === 'leaf:l1');
assert.deepEqual([leaf.name, leaf.label, leaf.state, leaf.create, leaf.selected], ['beta-r', 'beta-r', 'idle', false, true],
  'the leaf shows the new name, its light, no Create, and stays selected');
assert.equal(rows.filter((row) => row.kind === 'unfiled' && row.name.startsWith('beta')).length, 0, 'beta-r is not unfiled');
assert.equal(liveState(state, 'beta'), 'idle', 'the old name is not missing');
assert.ok(listedNames(state).has('beta') && listedNames(state).has('beta-r'));
assert.equal(hostName(state, 'beta'), 'beta-r');

// A status push can name the new name while the last session list still has the old one.
applyServerState(state, serverState(['alpha', 'beta', 'gamma', 'delta'], tree));
applyStatus(state, lights({ alpha: 'idle', 'beta-r': 'busy', gamma: 'idle', delta: 'idle' }), true);
rows = flatRows(sidebarModel(state));
assert.equal(rows.find((row) => row.key === 'leaf:l1').state, 'busy', 'the old name reads the new name\'s light');
assert.equal(rows.filter((row) => row.kind === 'recent')[0].name, 'beta', 'and Recent ranks it by that light');
applyServerState(state, serverState(['alpha', 'beta-r', 'gamma', 'delta'], tree));
applyStatus(state, lights({ alpha: 'idle', 'beta-r': 'idle', gamma: 'idle', delta: 'idle' }), true);

// The hub answered with the renamed leaf, and a later read agrees.
confirmRename(state, 'beta', 'beta-r', { ...tree[2], name: 'beta-r', session_name: 'beta-r' });
const renamedTree = tree.map((node) => (node.id === 'l1' ? { ...node, name: 'beta-r', session_name: 'beta-r' } : node));
applyServerState(state, serverState(['alpha', 'beta-r', 'gamma', 'delta'], renamedTree));
assert.deepEqual(state.renames, [], 'the rename settled');
rows = flatRows(sidebarModel(state));
assert.deepEqual(rows.map((row) => row.key), before.map((row) => row.key), 'the same keys after it settled');

// A new session under the old name is a different session with its own key.
applyServerState(state, serverState(['alpha', 'beta-r', 'gamma', 'delta', 'beta'], renamedTree));
rows = flatRows(sidebarModel(state));
const recentKeys = rows.filter((row) => row.kind === 'recent').map((row) => row.key);
assert.equal(new Set(recentKeys).size, recentKeys.length, 'the reused name does not share the renamed session\'s key');
assert.equal(rows.find((row) => row.kind === 'unfiled' && row.name === 'beta').state, 'unknown', 'the new beta has no light yet');
console.log('a rename keeps its rows and keys, never shows the session missing or unfiled, and settles: PASS');

/* A rename the hub refused leaves the old session as it was. */
const failed = createState({ now: NOW });
applyServerState(failed, serverState(names, tree));
applyStatus(failed, lights({ alpha: 'idle', beta: 'idle', gamma: 'idle', delta: 'idle' }), true);
const failedKeys = flatRows(sidebarModel(failed)).map((row) => row.key);
startRename(failed, 'delta', 'delta-x');
abortRename(failed, 'delta', 'delta-x');
assert.deepEqual(failed.renames, []);
assert.equal(failed.identities.has('delta-x'), false);
assert.deepEqual(flatRows(sidebarModel(failed)).map((row) => row.key), failedKeys);
console.log('a refused rename leaves the rows as they were: PASS');

/* Before the first state read nothing is known. */
const fresh = createState({ now: NOW });
assert.equal(fresh.loaded, false, 'the page starts with no state read');
assert.equal(liveState(fresh, 'alpha'), 'unknown');
console.log('before the first state read nothing is known: PASS');

const activity = createState({ now: NOW });
const fixtures = ['old-created', 'new-created', 'root-old', 'root-new', 'unknown'];
const fixtureTree = [{ id: 'folder', kind: 'folder', name: 'Activity', position: 1 },
  ...fixtures.map((name, i) => ({ id: name, kind: 'session', name, session_name: name,
    parent_id: i < 2 ? 'folder' : null, position: i, created_at: NOW - 1000 }))];
const data = serverState(fixtures, fixtureTree, 3);
data.sessions.forEach((session, i) => { session.lastActivityAt = i === 4 ? 0 : NOW - (i + 1) * 60000; });
applyServerState(activity, data);
applyStatus(activity, { 'new-created': { state: 'idle', lastActivityAt: NOW - 10000 },
  'root-new': { state: 'idle', lastActivityAt: NOW - 20000 } }, true);
let activityRows = flatRows(sidebarModel(activity));
assert.deepEqual(activityRows.filter((row) => row.kind === 'leaf' && row.depth > 0).map((row) => row.name), ['new-created', 'old-created']);
assert.deepEqual(activityRows.filter((row) => row.kind === 'leaf' && row.depth === 0).map((row) => row.name), ['root-new', 'root-old', 'unknown']);
for (const row of activityRows.filter((row) => row.name === 'new-created')) assert.equal(row.age, '<1m');
assert.equal(activityRows.find((row) => row.name === 'old-created').age, '1m');
assert.equal(activityRows.find((row) => row.name === 'unknown').age, '');
assert.equal(activityRows.filter((row) => row.kind === 'recent').length, 5, 'count limits height, never membership');
const stableKeys = activityRows.map((row) => row.key).sort();
applyStatus(activity, { 'old-created': { state: 'idle', lastActivityAt: NOW } }, true);
activityRows = flatRows(sidebarModel(activity));
assert.equal(activityRows.find((row) => row.kind === 'leaf').name, 'old-created');
assert.deepEqual(activityRows.map((row) => row.key).sort(), stableKeys);
console.log('folders and Unfiled use last activity, row ages exclude creation, live sorting keeps keys: PASS');
