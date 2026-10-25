import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.argv[2] === '--child') {
  const { readSessionProcessSnapshot } = await import(process.argv[4]);
  try {
    const snapshot = await readSessionProcessSnapshot(process.argv[3], null, 2000, []);
    process.stdout.write(JSON.stringify({ owners: snapshot.claudePanes.size }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ health_error: error.code }));
  }
} else {
  const source = process.env.STATUS_MODULE || new URL('../src/status.js', import.meta.url).href;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcw-inventory-health-'));
  fs.chmodSync(root, 0o755);
  fs.mkdirSync(path.join(root, '42'), { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'stat'), 'btime 1\n', { mode: 0o644 });
  fs.writeFileSync(path.join(root, 'uptime'), '100.00 0.00\n', { mode: 0o644 });
  fs.writeFileSync(path.join(root, '42/status'), 'Name:\tclaude\nState:\tS (sleeping)\nPPid:\t1\n', { mode: 0o644 });
  fs.writeFileSync(path.join(root, '42/stat'), `42 (claude) S ${Array(19).fill('0').join(' ')} 77 0\n`, { mode: 0o644 });
  fs.writeFileSync(path.join(root, '42/cmdline'), 'claude\0', { mode: 0o644 });
  fs.writeFileSync(path.join(root, '42/environ'), 'ZELLIJ_SESSION_NAME=unreadable\0ZELLIJ_PANE_ID=0\0', { mode: 0o000 });
  const result = spawnSync('runuser', ['-u', 'nobody', '--', process.execPath, path.resolve(process.argv[1]), '--child', root, source], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).health_error, 'EACCES', 'an unreadable live process must invalidate the inventory, not establish absence');
  console.log('actual per-process permission failure invalidates inventory: PASS');
}
