// MCW_SESSION_UNIT picks the systemd template the agent starts, stops and checks.
// A second stack on the same box must never stop the first stack's units.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const here = path.dirname(self);

if (process.argv[2] === 'child') {
  const sessions = await import('../src/sessions.js');
  const unit = process.env.EXPECT_UNIT;
  const result = await sessions.deleteSession({ name: 'dev-1' });
  assert.equal(result.deleted, true);
  const calls = fs.readFileSync(process.env.CALLS, 'utf8').trim().split('\n');
  assert.ok(calls.includes(`systemctl --user stop ${unit}@dev\\x2d1.service`), calls.join('\n'));
  assert.ok(!calls.some((line) => line.startsWith('systemctl') && !line.includes(`${unit}@`)), calls.join('\n'));
  assert.equal(sessions.sessionUnitName('dev\\x2d1'), `${unit}@dev\\x2d1.service`);
  assert.deepEqual(
    sessions.wakeStartPlan('dev-1', { MAXAGENT_UNIT: `${unit}@dev\\x2d1.service` }, 'dev\\x2d1').args,
    ['--user', 'start', `${unit}@dev\\x2d1.service`],
  );
  const idle = { name: 'dev-1', activity: 'idle', conversationCount: 1, resumable: true };
  const eligibility = sessions.hibernateEligibility(idle);
  if (unit === 'maxclaude-named') assert.equal(eligibility.eligible, true);
  else assert.deepEqual(eligibility, { eligible: false, reason: `maxclaude hide stops maxclaude-named units and this agent starts ${unit} units` });
  console.log(`MCW_SESSION_UNIT=${process.env.MCW_SESSION_UNIT || '(unset)'}: delete stopped ${unit}@dev\\x2d1.service only`);
  process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcw-session-unit-'));
const bin = path.join(root, 'bin');
fs.mkdirSync(bin);
const calls = path.join(root, 'calls');
const recorder = (name, body = '') => {
  fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${calls}"\n${body}exit 0\n`, { mode: 0o755 });
};
recorder('systemctl');
recorder('zellij', 'case "$1" in list-sessions) echo "No active zellij sessions found."; exit 1;; esac\n');

function runChild(sessionUnit, expectUnit) {
  fs.writeFileSync(calls, '');
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: process.env.HOME || '/root',
    CALLS: calls,
    EXPECT_UNIT: expectUnit,
    MCW_ZELLIJ_BIN: path.join(bin, 'zellij'),
    MCW_STATE_DIR: path.join(root, 'state'),
    MCW_MAXCLAUDE_CFG: path.join(root, 'maxclaude'),
    MCW_MAXAGENT_CFG: path.join(root, 'maxagent'),
    ZELLIJ_SOCKET_DIR: path.join(root, 'sockets'),
  };
  if (sessionUnit !== undefined) env.MCW_SESSION_UNIT = sessionUnit;
  return spawnSync(process.execPath, [self, 'child'], { env, encoding: 'utf8', timeout: 60000 });
}

for (const [sessionUnit, expectUnit] of [['mcwdev-named', 'mcwdev-named'], [undefined, 'maxclaude-named']]) {
  const child = runChild(sessionUnit, expectUnit);
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  process.stdout.write(child.stdout);
}

const invalid = runChild('bad@name.service', 'bad');
assert.notEqual(invalid.status, 0);
assert.match(invalid.stderr, /MCW_SESSION_UNIT must be a systemd template name/);
console.log('invalid MCW_SESSION_UNIT is refused at start: PASS');

const source = fs.readFileSync(path.join(here, '..', 'src', 'sessions.js'), 'utf8');
assert.doesNotMatch(source, /`maxclaude-named@/, 'every unit name goes through sessionUnitName');
execFileSync('rm', ['-rf', root]);
console.log('session unit template option: PASS');
