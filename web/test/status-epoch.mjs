import assert from 'node:assert/strict';
import { Tunnel } from '../src/tunnel.js';

const first = new Tunnel('status-epoch-one');
const second = new Tunnel('status-epoch-two');
try {
  assert.ok(second.connectionEpoch > first.connectionEpoch, 'a restarted hub instance must publish a connection epoch newer than cached browser state');
  process.stdout.write(`persistent status epochs ${first.connectionEpoch} then ${second.connectionEpoch}: PASS\n`);
} finally {
  clearInterval(first.pingTimer);
  clearInterval(second.pingTimer);
}
