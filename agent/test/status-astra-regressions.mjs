import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const modulePath = process.env.STATUS_MODULE || new URL('../src/status.js', import.meta.url).href;
const { aggregateSessionActivity, readSessionProcessSnapshot, CLAIM_MAX_AGE_MS, HOOK_LEDGER_TAIL_BYTES } = await import(modulePath);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcw-astra-status-'));
const now = Date.now();
const selected = process.env.ASTRA_CASE || '';
const enabled = (name) => !selected || selected === name;
const panes = (name, pid = 10) => new Map([[`${name}\0` + '0', {
  session: name, pane: '0', startedAt: 1, pids: [pid], processes: [{ pid, startTicks: 1 }], commands: [], cwd: null,
}]]);
function ledger(name, events) {
  const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '0.events.jsonl'), events.map(JSON.stringify).join('\n') + '\n');
}
function state(name, at = now - 1) {
  const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '0.json'), JSON.stringify({ state: 'busy', updatedAt: at, pid: 10, pidStartTicks: 1 }));
}
function activity(name, extra = {}) {
  return aggregateSessionActivity([name], panes(name), { statusDir: root, now, ...extra })[name];
}

// Finding 1.  A helper that outlives an interrupted execution is not evidence
// of a current tool after the bounded hook lease.
if (enabled('helper')) {
  state('helper', now - CLAIM_MAX_AGE_MS - 1);
  ledger('helper', [{ eventName: 'PreToolUse', toolUseId: 't', sequence: 1, updatedAt: now - CLAIM_MAX_AGE_MS - 1, bootTicks: 10, pid: 10, pidStartTicks: 1 }]);
  assert.equal(activity('helper', { toolPanes: new Map([['helper\0' + '0', [{ pid: 11, startTicks: 11, startedAt: now - CLAIM_MAX_AGE_MS, owner: { pid: 10, startTicks: 1 } }]]]) }).state, 'idle');
}

// Finding 1.  After the normal claim window, only the exact live Bash command
// recorded by PreToolUse can extend the turn. A parallel shell wrapper from
// the same Claude owner must not borrow that authority.
if (enabled('bound-bash')) {
  const hash = 'a'.repeat(64);
  const old = now - CLAIM_MAX_AGE_MS - 1;
  state('bound-bash', old);
  ledger('bound-bash', [{ eventName: 'PreToolUse', toolUseId: 'quiet', toolName: 'Bash', toolCommandHash: hash, sequence: 1, updatedAt: old, bootTicks: 10, pid: 10, pidStartTicks: 1 }]);
  const matching = new Map([['bound-bash\0' + '0', {
    session: 'bound-bash', pane: '0', startedAt: old, activityAt: old, pids: [11], sessionIds: [],
    processes: [{ pid: 11, startTicks: 11, startedAt: old, owner: { pid: 10, startTicks: 1 }, commandHash: hash }],
  }]]);
  assert.equal(aggregateSessionActivity(['bound-bash'], panes('bound-bash'), { statusDir: root, now: old + 1, backgroundPanes: matching })['bound-bash'].state, 'busy');
  assert.equal(activity('bound-bash', { backgroundPanes: matching }).state, 'busy', 'the matching quiet Bash execution remains current');
  const unrelated = new Map([['bound-bash\0' + '0', {
    ...matching.get('bound-bash\0' + '0'),
    processes: [{ pid: 12, startTicks: 12, startedAt: old, owner: { pid: 10, startTicks: 1 }, commandHash: 'b'.repeat(64) }],
  }]]);
  assert.equal(activity('bound-bash', { backgroundPanes: unrelated }).state, 'background', 'a parallel shell wrapper cannot extend another Bash tool');
  const replacement = new Map([['bound-bash\0' + '0', {
    ...matching.get('bound-bash\0' + '0'),
    processes: [{ pid: 13, startTicks: 13, startedAt: old, owner: { pid: 10, startTicks: 1 }, commandHash: hash }],
  }]]);
  assert.equal(activity('bound-bash', { backgroundPanes: replacement }).state, 'background', 'a replacement PID with the same command cannot replace the bound execution');
}

if (enabled('multiple-bound-bash')) {
  const old = now - CLAIM_MAX_AGE_MS - 1;
  const firstHash = 'c'.repeat(64);
  const secondHash = 'd'.repeat(64);
  state('multiple-bound-bash', old);
  ledger('multiple-bound-bash', [
    { eventName: 'PreToolUse', toolUseId: 'one', toolName: 'Bash', toolCommandHash: firstHash, sequence: 1, updatedAt: old, bootTicks: 10, pid: 10, pidStartTicks: 1 },
    { eventName: 'PreToolUse', toolUseId: 'two', toolName: 'Bash', toolCommandHash: secondHash, sequence: 2, updatedAt: old + 1, bootTicks: 11, pid: 10, pidStartTicks: 1 },
  ]);
  const executions = new Map([['multiple-bound-bash\0' + '0', { pids: [21, 22], processes: [
    { pid: 21, startTicks: 21, startedAt: old, owner: { pid: 10, startTicks: 1 }, commandHash: firstHash },
    { pid: 22, startTicks: 22, startedAt: old, owner: { pid: 10, startTicks: 1 }, commandHash: secondHash },
  ] }]]);
  assert.equal(aggregateSessionActivity(['multiple-bound-bash'], panes('multiple-bound-bash'), { statusDir: root, now: old + 2, backgroundPanes: executions })['multiple-bound-bash'].state, 'busy');
  assert.equal(activity('multiple-bound-bash', { backgroundPanes: executions }).state, 'busy', 'each pending Bash tool has a separate lifetime binding');
}

// Synthetic dispatch skew. A Bash wrapper may start immediately before
// PreToolUse is recorded. It must receive an immutable PID/start binding.
if (enabled('predated-bash-wrapper')) {
  const hash = 'e'.repeat(64);
  const started = now - CLAIM_MAX_AGE_MS - 1;
  state('predated-bash-wrapper', started);
  ledger('predated-bash-wrapper', [{
    eventName: 'PreToolUse', toolUseId: 'native-long', toolName: 'Bash', toolCommandHash: hash,
    sequence: 1, updatedAt: started, bootTicks: 50_000, pid: 10, pidStartTicks: 1,
  }]);
  const live = new Map([['predated-bash-wrapper\0' + '0', { pids: [21], processes: [{
    pid: 21, startTicks: 49_998, startedAt: started - 20, owner: { pid: 10, startTicks: 1 }, commandHash: hash,
  }] }]]);
  assert.equal(aggregateSessionActivity(['predated-bash-wrapper'], panes('predated-bash-wrapper'), {
    statusDir: root, now: started + 1, backgroundPanes: live,
  })['predated-bash-wrapper'].state, 'busy');
  assert.equal(activity('predated-bash-wrapper', { backgroundPanes: live }).state, 'busy');
}

// The same command digest is not enough by itself. A wrapper from an earlier
// turn must fall outside the one-second PreToolUse dispatch window and cannot
// bind to keep a new interrupted turn busy.
if (enabled('old-exact-command-wrapper')) {
  const hash = 'f'.repeat(64);
  const started = now - CLAIM_MAX_AGE_MS - 1;
  state('old-exact-command-wrapper', started);
  ledger('old-exact-command-wrapper', [{
    eventName: 'PreToolUse', toolUseId: 'new-turn', toolName: 'Bash', toolCommandHash: hash,
    sequence: 1, updatedAt: started, bootTicks: 60_000, pid: 10, pidStartTicks: 1,
  }]);
  const old = new Map([['old-exact-command-wrapper\0' + '0', { pids: [22], processes: [{
    pid: 22, startTicks: 1, startedAt: started - (60 * 60 * 1000), owner: { pid: 10, startTicks: 1 }, commandHash: hash,
  }] }]]);
  assert.equal(aggregateSessionActivity(['old-exact-command-wrapper'], panes('old-exact-command-wrapper'), {
    statusDir: root, now: started + 1, backgroundPanes: old,
  })['old-exact-command-wrapper'].state, 'busy');
  assert.equal(activity('old-exact-command-wrapper', { backgroundPanes: old }).state, 'background');
}

// Finding 3.  Sequence is causal order despite a wall clock rollback.  A
// completed tool remains tombstoned when a delayed duplicate PreToolUse lands.
if (enabled('ordering')) {
state('ordering'); ledger('ordering', [
  { eventName: 'PreToolUse', toolUseId: 'x', sequence: 1, updatedAt: now, pid: 10, pidStartTicks: 1 },
  { eventName: 'PostToolUse', toolUseId: 'x', sequence: 2, updatedAt: now - 1000, pid: 10, pidStartTicks: 1 },
  { eventName: 'Stop', sequence: 3, updatedAt: now - 2000, pid: 10, pidStartTicks: 1 },
  { eventName: 'PreToolUse', toolUseId: 'x', sequence: 4, updatedAt: now - 3000, pid: 10, pidStartTicks: 1 },
]); assert.equal(activity('ordering').state, 'idle'); }

// Finding 6.  An unreadable process inventory is not a successful absence.
if (enabled('inventory')) await assert.rejects(() => readSessionProcessSnapshot(path.join(root, 'missing-proc')), /ENOENT/);

// Finding 8.  A future terminal row cannot close a current prompt or leak a
// future timestamp into Recent ordering.
if (enabled('future')) {
state('future', now - 10);
ledger('future', [{ eventName: 'UserPromptSubmit', sequence: 1, updatedAt: now - 10, pid: 10, pidStartTicks: 1 }]);
const transcript = path.join(root, 'future.jsonl');
fs.writeFileSync(transcript, [
  { type: 'user', timestamp: new Date(now - 10).toISOString(), message: { role: 'user', content: 'current prompt' } },
  { type: 'system', subtype: 'turn_duration', timestamp: new Date(now + 60_000).toISOString() },
  { type: 'assistant', timestamp: new Date(now + 60_000).toISOString(), message: { role: 'assistant', content: [] } },
].map(JSON.stringify).join('\n') + '\n');
const futurePane = panes('future'); futurePane.get('future\0' + '0').commands = [['claude', '--resume', transcript]];
const future = aggregateSessionActivity(['future'], futurePane, { statusDir: root, now }).future;
assert.equal(future.state, 'busy'); assert.ok(future.lastResponseAt <= now); }

// Finding 8.  Transcript append order wins over a clock-skewed timestamp.
// The terminal row precedes the later prompt in the file, so it cannot close it.
if (enabled('transcript-order')) {
  state('transcript-order', now - 10);
  ledger('transcript-order', [{ eventName: 'UserPromptSubmit', sequence: 2, updatedAt: now - 10, pid: 10, pidStartTicks: 1 }]);
  const ordered = path.join(root, 'ordered.jsonl');
  fs.writeFileSync(ordered, [
    { type: 'system', subtype: 'turn_duration', timestamp: new Date(now - 10).toISOString() },
    { type: 'user', timestamp: new Date(now - 20).toISOString(), message: { role: 'user', content: 'later in file' } },
  ].map(JSON.stringify).join('\n') + '\n');
  const orderedPane = panes('transcript-order'); orderedPane.get('transcript-order\0' + '0').commands = [['claude', '--resume', ordered]];
  assert.equal(aggregateSessionActivity(['transcript-order'], orderedPane, { statusDir: root, now })['transcript-order'].state, 'busy');
}

// Finding 8. A cached transcript must be revalidated against every scan's
// clock. A terminal valid before a backward wall-clock step becomes future
// data and cannot suppress the current prompt or rank Recent in the future.
if (enabled('cached-clock-rollback')) {
  const high = now;
  const low = now - 1000;
  state('cached-clock-rollback', low - 5);
  ledger('cached-clock-rollback', [{ eventName: 'UserPromptSubmit', sequence: 1, updatedAt: low - 5, pid: 10, pidStartTicks: 1 }]);
  const transcript = path.join(root, 'cached-clock-rollback.jsonl');
  fs.writeFileSync(transcript, [
    { type: 'user', timestamp: new Date(low - 10).toISOString(), message: { role: 'user', content: 'current prompt' } },
    { type: 'assistant', timestamp: new Date(high - 10).toISOString(), message: { role: 'assistant', stop_reason: 'end_turn', content: [] } },
  ].map(JSON.stringify).join('\n') + '\n');
  const cachedPane = panes('cached-clock-rollback'); cachedPane.get('cached-clock-rollback\0' + '0').commands = [['claude', '--resume', transcript]];
  aggregateSessionActivity(['cached-clock-rollback'], cachedPane, { statusDir: root, now: high });
  const rolledBack = aggregateSessionActivity(['cached-clock-rollback'], cachedPane, { statusDir: root, now: low })['cached-clock-rollback'];
  assert.equal(rolledBack.state, 'busy');
  assert.ok(rolledBack.lastResponseAt <= low);
}

// Finding 14.  A current valid transcript row may be larger than one megabyte.
// It remains semantic evidence rather than being discarded as malformed input.
if (enabled('large-row')) {
  state('large-row', now - 10);
  const huge = path.join(root, 'huge.jsonl');
  const first = JSON.stringify({ type: 'user', timestamp: new Date(now - 10).toISOString(), message: { role: 'user', content: `x${'a'.repeat(1024 * 1024)}x` } }) + '\n';
  const second = `${first.slice(0, Math.floor(first.length / 2))}b${first.slice(Math.floor(first.length / 2) + 1)}`;
  fs.writeFileSync(huge, first);
  const largePane = panes('large-row'); largePane.get('large-row\0' + '0').commands = [['claude', '--resume', huge]];
  assert.equal(aggregateSessionActivity(['large-row'], largePane, { statusDir: root, now })['large-row'].state, 'idle');
  fs.writeFileSync(huge, second);
  assert.equal(aggregateSessionActivity(['large-row'], largePane, { statusDir: root, now })['large-row'].state, 'busy');
}

// Finding 10.  A checkpoint carries an active PreToolUse across rotated
// diagnostic history.  The checkpoint itself cannot assert state without the
// live owner supplied above.
if (enabled('checkpoint')) {
state('checkpoint');
const checkpointDir = path.join(root, 'checkpoint');
fs.writeFileSync(path.join(checkpointDir, '0.events.jsonl'), `${' '.repeat(HOOK_LEDGER_TAIL_BYTES + 10)}\n`);
fs.writeFileSync(path.join(checkpointDir, '0.events.state.json'), JSON.stringify({ version: 1, sequence: 1, events: [{ eventName: 'PreToolUse', toolUseId: 'live', sequence: 1, updatedAt: now - 1, pid: 10, pidStartTicks: 1 }] }));
assert.equal(activity('checkpoint').state, 'busy'); }

// Findings 3 and 15.  A wall-clock rollback cannot expire a new monotonic
// hook observation.  The fixture establishes busy from the actual ledger.
if (enabled('monotonic')) {
  const proc = path.join(root, 'mono-proc'); fs.mkdirSync(proc); fs.writeFileSync(path.join(proc, 'stat'), 'btime 1\n'); fs.writeFileSync(path.join(proc, 'uptime'), '100.00 0.00\n');
  await readSessionProcessSnapshot(proc, []);
  state('monotonic', now - (60 * 60 * 1000));
  ledger('monotonic', [{ eventName: 'UserPromptSubmit', sequence: 1, updatedAt: now - (60 * 60 * 1000), bootTicks: 9999, pid: 10, pidStartTicks: 1 }]);
  assert.equal(activity('monotonic', { observedBootTicks: 10000 }).state, 'busy');
}

// A wall-clock rollback can put a new hook row ahead of Date.now().  Its boot
// tick still proves a fresh prompt for the live Claude owner.  The timestamp
// must not leak into ranking output.
if (enabled('future-hook-monotonic')) {
  state('future-hook-monotonic', now - 1);
  ledger('future-hook-monotonic', [{
    eventName: 'UserPromptSubmit', sequence: 1, updatedAt: now + 60_000,
    bootTicks: 20_000, pid: 10, pidStartTicks: 1,
  }]);
  const result = activity('future-hook-monotonic', { observedBootTicks: 20_001 });
  assert.equal(result.state, 'busy');
  assert.ok(result.updatedAt <= now, 'future causal wall time never ranks Recent');
  assert.ok(result.lastActivityAt <= now, 'future causal wall time never publishes activity');
}

// Finding 3. A renamed controller can keep its original hook namespace while
// a new session reuses that name. Checkpoint events remain partitioned by the
// live Claude PID and start ticks, so new A activity cannot reset old B work.
if (enabled('shared-hook-namespace')) {
  const namespace = path.join(root, 'A'); fs.mkdirSync(namespace, { recursive: true });
  fs.writeFileSync(path.join(namespace, '0.events.jsonl'), `${' '.repeat(HOOK_LEDGER_TAIL_BYTES + 32)}\n`);
  const oldPre = { eventName: 'PreToolUse', toolUseId: 'old-b', sequence: 1, updatedAt: now - 1, pid: 10, pidStartTicks: 1 };
  const reused = [{ eventName: 'UserPromptSubmit', sequence: 2, updatedAt: now, pid: 20, pidStartTicks: 2 }];
  for (let index = 0; index < 250; index += 1) reused.push({ eventName: 'PostToolUse', toolUseId: `new-${index}`, sequence: index + 3, updatedAt: now, pid: 20, pidStartTicks: 2 });
  fs.writeFileSync(path.join(namespace, '0.events.state.json'), JSON.stringify({ events: [oldPre, ...reused] }));
  const oldPane = new Map([['B\0' + '0', { session: 'B', hookSession: 'A', pane: '0', startedAt: 1, pids: [10], processes: [{ pid: 10, startTicks: 1 }], commands: [], cwd: null }]]);
  assert.equal(aggregateSessionActivity(['B'], oldPane, { statusDir: root, now }).B.state, 'busy');
}

console.log('astra status regressions: helper expiry, causal ordering, inventory failure, future timestamps, checkpoint recovery: PASS');
