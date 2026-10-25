import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { wakeMetadataTransition } from '../src/sessions.js';

const hidden = {
  MAXAGENT_HIDDEN: '1',
  MAXAGENT_UNIT: 'maxclaude-named@demo.service',
  MCW_LAST_ACTIVITY_AT: '1234',
};

const waking = wakeMetadataTransition(hidden, 'begin');
assert.equal(waking.MAXAGENT_HIDDEN, '1', 'starting a unit must retain the sleeping record until ownership is verified');
assert.equal(waking.MAXAGENT_WAKING, '1');
assert.deepEqual(wakeMetadataTransition(waking, 'rollback'), hidden, 'a failed post-start check restores the same sleeping record');
assert.equal(wakeMetadataTransition(waking, 'verified').MAXAGENT_HIDDEN, undefined, 'only the verified owner clears sleeping metadata');
assert.throws(() => wakeMetadataTransition(hidden, 'verified'), /wake marker is missing/);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcw-wake-lifecycle-'));
const maxagent = path.join(root, 'maxagent');
const maxclaude = path.join(root, 'maxclaude');
const claude = path.join(root, 'claude');
fs.mkdirSync(path.join(maxagent, 'sessions'), { recursive: true });
fs.mkdirSync(path.join(maxclaude, 'sessions'), { recursive: true });
fs.mkdirSync(path.join(claude, 'sessions'), { recursive: true });
fs.writeFileSync(path.join(maxagent, 'sessions', 'demo.env'), 'MAXAGENT_HIDDEN=1\nMAXAGENT_UNIT=maxclaude-named@demo.service\n');
fs.writeFileSync(path.join(maxclaude, 'sessions', 'demo.env'), 'MAXCLAUDE_WORKDIR=/tmp/demo\nMAXCLAUDE_RESUME_SID=11111111-1111-1111-1111-111111111111\n');
fs.writeFileSync(path.join(maxclaude, 'sessions', 'demo.panes'), '0\n');
fs.writeFileSync(path.join(maxclaude, 'sessions', 'metadata.env'), 'MAXCLAUDE_WORKDIR=/tmp/metadata\nMAXCLAUDE_RESUME_SID=22222222-2222-2222-2222-222222222222\n');
fs.writeFileSync(path.join(maxclaude, 'metadata.panes'), '1\n');
fs.writeFileSync(path.join(claude, 'sessions', '42.json'), JSON.stringify({ sessionId: '22222222-2222-2222-2222-222222222222' }));
const env = { ...process.env, MCW_TEST_MAXAGENT_CFG: maxagent, MCW_TEST_MAXCLAUDE_CFG: maxclaude, MCW_TEST_CLAUDE_CFG: claude };
const sessionsModule = process.env.MCW_SESSIONS_MODULE || new URL('../src/sessions.js', import.meta.url).pathname;
if (process.env.MCW_SKIP_WAKE !== '1') {
  const child = spawnSync(process.execPath, ['--experimental-loader', new URL('./session-lifecycle-loader.mjs', import.meta.url).pathname, new URL('./session-lifecycle-child.mjs', import.meta.url).pathname, sessionsModule], { env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.match(child.stdout, /retains sleeping metadata/);
  process.stdout.write(child.stdout);
}
const metadataChild = spawnSync(process.execPath, ['--experimental-loader', new URL('./session-lifecycle-loader.mjs', import.meta.url).pathname, new URL('./session-metadata-child.mjs', import.meta.url).pathname, sessionsModule], {
  env: { ...env, MCW_TEST_RESUMABLE_PENDING: '1' }, encoding: 'utf8', timeout: 5000
});
assert.equal(metadataChild.status, 0, metadataChild.stderr || metadataChild.stdout);
assert.match(metadataChild.stdout, /while resumability metadata remained pending/);
process.stdout.write(metadataChild.stdout);
process.stdout.write('session lifecycle regression checks passed\n');
