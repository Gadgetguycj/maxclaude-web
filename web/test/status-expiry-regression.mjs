import assert from 'node:assert/strict';

const modulePath = process.argv[2] || '../src/tunnel.js';
const { Tunnel } = await import(modulePath);
const originalNow = Date.now;
const tunnel = new Tunnel('status-expiry-regression-secret');
try {
  tunnel.setSessionStatus({ sessions: { demo: { state: 'busy', updatedAt: 1 } } });
  // The expiry basis is monotonic.  Put its lease in the past without waiting
  // for the production lease interval, then move only the wall clock back.
  tunnel.sessionStatusExpiresAt = performance.now() - 1;
  Date.now = () => originalNow() - 60 * 60 * 1000;
  tunnel.expireSessionStatus();
  assert.equal(tunnel.sessionStatus.demo.state, 'unknown');
  process.stdout.write('backward-clock status expiry regression passed\n');
} finally {
  Date.now = originalNow;
  clearInterval(tunnel.pingTimer);
}
