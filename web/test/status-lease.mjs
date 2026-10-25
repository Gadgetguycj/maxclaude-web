import assert from 'node:assert/strict';
import test from 'node:test';
import { StatusLease, stateForSession } from '../public/assets/status-lease.js';

function clock() {
  let now = 0;
  const timers = [];
  return {
    now: () => now,
    advance(ms) { now += ms; },
    schedule(callback, delay) {
      const entry = { callback, at: now + delay, cancelled: false };
      timers.push(entry);
      return entry;
    },
    cancel(entry) { entry.cancelled = true; },
    runDue() {
      for (const entry of timers.filter((item) => !item.cancelled && item.at <= now)) {
        entry.cancelled = true;
        entry.callback();
      }
    }
  };
}

function snapshot(epoch, revision, state, lease = 40) {
  return {
    session_status: { demo: { state, updatedAt: revision } },
    session_status_meta: { connection_epoch: epoch, revision, lease_ms: lease }
  };
}

test('SSE busy cannot overwrite a newer HTTP unknown snapshot', () => {
  const time = clock();
  const lease = new StatusLease({ now: time.now, schedule: time.schedule, cancel: time.cancel });
  assert.equal(lease.apply(snapshot(7, 11, 'unknown')), true, 'the newer HTTP state is accepted');
  assert.equal(lease.apply(snapshot(7, 10, 'busy')), false, 'the delayed SSE state is rejected');
  assert.equal(lease.sessions.demo.state, 'unknown');
});

test('delayed HTTP busy cannot overwrite a newer SSE unknown snapshot', () => {
  const time = clock();
  const lease = new StatusLease({ now: time.now, schedule: time.schedule, cancel: time.cancel });
  assert.equal(lease.apply(snapshot(7, 11, 'unknown')), true, 'the newer SSE state is accepted');
  assert.equal(lease.apply(snapshot(7, 10, 'busy')), false, 'the delayed HTTP state is rejected');
  assert.equal(lease.sessions.demo.state, 'unknown');
});

test('a local monotonic lease expires a stalled busy status', () => {
  const time = clock();
  const lease = new StatusLease({ now: time.now, schedule: time.schedule, cancel: time.cancel });
  lease.apply(snapshot(3, 1, 'busy', 25));
  time.advance(25);
  time.runDue();
  assert.equal(lease.sessions.demo.state, 'unknown');
  assert.equal(lease.apply(snapshot(3, 1, 'busy', 25)), false, 'an old response cannot revive a locally expired claim');
});

test('a later connection epoch supersedes all snapshots from the disconnected agent', () => {
  const time = clock();
  const lease = new StatusLease({ now: time.now, schedule: time.schedule, cancel: time.cancel });
  assert.equal(lease.apply(snapshot(3, 99, 'busy')), true);
  assert.equal(lease.apply(snapshot(4, 0, 'unknown')), true);
  assert.equal(lease.apply(snapshot(3, 100, 'busy')), false);
  assert.equal(lease.sessions.demo.state, 'unknown');
});

test('an expired status entry prevents historical sleeping metadata from restoring a light', () => {
  assert.equal(stateForSession({ name: 'demo', sleeping: true, activity: 'sleeping' }, { demo: { state: 'unknown' } }, false), 'unknown');
  assert.equal(stateForSession({ name: 'demo', sleeping: true, activity: 'sleeping' }, {}, false), 'unknown');
  assert.equal(stateForSession({ name: 'demo', sleeping: true, activity: 'sleeping' }, {}, false, false), 'sleeping');
});
