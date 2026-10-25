import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import cases from './fixtures/status-rename.json' with { type: 'json' };

const modulePath = process.env.MCW_STATUS_MODULE || path.join(import.meta.dirname, '..', 'src', 'status.js');
const status = await import(pathToFileURL(modulePath).href);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcw-status-rename-'));
const now = Date.now();

function procStat(pid, ticks, state = 'S') {
  return `${pid} (process with spaces) ${state} 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 ${ticks} 1\n`;
}

function processRecord(procRoot, { pid, ppid, ticks, command, session, pane = '0', extraEnv = [] }) {
  const dir = path.join(procRoot, String(pid));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'stat'), procStat(pid, ticks));
  fs.writeFileSync(path.join(dir, 'status'), `Name:\t${path.basename(command[0])}\nState:\tS (sleeping)\nPPid:\t${ppid}\n`);
  fs.writeFileSync(path.join(dir, 'cmdline'), Buffer.from([...command, ''].join('\0')));
  const env = [...extraEnv];
  if (session) env.push(`ZELLIJ_SESSION_NAME=${session}`);
  if (pane !== null) env.push(`ZELLIJ_PANE_ID=${pane}`);
  fs.writeFileSync(path.join(dir, 'environ'), Buffer.from([...env, ''].join('\0')));
}

function fixtureProc(records) {
  const proc = path.join(root, 'proc');
  fs.rmSync(proc, { recursive: true, force: true });
  fs.mkdirSync(proc, { recursive: true });
  fs.writeFileSync(path.join(proc, 'stat'), 'btime 1000\n');
  for (const record of records) processRecord(proc, record);
  return proc;
}

function hook(session, pid, ticks, eventName = 'UserPromptSubmit') {
  const dir = path.join(root, session);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '0.json'), JSON.stringify({ state: 'busy', updatedAt: now, pid, pidStartTicks: ticks }));
  fs.writeFileSync(path.join(dir, '0.events.jsonl'), JSON.stringify({ eventName, updatedAt: now, sequence: 1, pid, pidStartTicks: ticks }) + '\n');
}

function appendHook(session, pid, ticks, eventName) {
  fs.appendFileSync(path.join(root, session, '0.events.jsonl'), JSON.stringify({ eventName, updatedAt: now, sequence: 2, pid, pidStartTicks: ticks }) + '\n');
}

function activity(names, proc, controllerSessions) {
  return status.collectSessionActivity(names, { procRoot: proc, statusDir: root, now, controllerSessions });
}

try {
  assert.equal(cases.length, 7);

  // The controller is the zellij ancestor. Claude retains its old inherited
  // environment after Zellij changes the session name.
  let proc = fixtureProc([
    { pid: 700, ppid: 1, ticks: 7000, command: ['zellij', '--server'], session: 'old' },
    { pid: 701, ppid: 700, ticks: 7010, command: ['claude', '--resume', 'same'], session: 'old' },
  ]);
  hook('old', 701, 7010);
  let result = await activity(['new'], proc, [{ session: 'new', pid: 700, startTicks: 7000, panes: ['0'] }]);
  assert.equal(result.new.state, 'busy', cases[0].name);
  assert.equal(result.new.updatedAt, now, `${cases[0].name}: retained owner's hook namespace`);

  // A newly-created old session cannot inherit the association merely because
  // its Claude environment and pane id match the pre-rename values.
  proc = fixtureProc([
    { pid: 700, ppid: 1, ticks: 7000, command: ['zellij', '--server'], session: 'new' },
    { pid: 701, ppid: 700, ticks: 7010, command: ['claude', '--resume', 'same'], session: 'old' },
    { pid: 800, ppid: 1, ticks: 8000, command: ['zellij', '--server'], session: 'old' },
    { pid: 801, ppid: 800, ticks: 8010, command: ['claude', '--resume', 'other'], session: 'old' },
  ]);
  appendHook('old', 801, 8010, 'Stop');
  result = await activity(['new', 'old'], proc, [
    { session: 'new', pid: 700, startTicks: 7000, panes: ['0'] },
    { session: 'old', pid: 800, startTicks: 8000, panes: ['0'] },
  ]);
  assert.equal(result.new.state, 'busy', cases[1].name);
  assert.equal(result.old.state, 'idle', `${cases[1].name}: old controller owns only its hook`);

  result = await activity(['last'], proc, [{ session: 'last', pid: 700, startTicks: 7000, panes: ['0'] }]);
  assert.equal(result.last.state, 'busy', cases[2].name);

  // PID alone is not identity. A controller that reused PID 700 has a new
  // start-tick value and must not receive the old controller registration.
  proc = fixtureProc([
    { pid: 700, ppid: 1, ticks: 9000, command: ['zellij', '--server'], session: 'old' },
    { pid: 701, ppid: 700, ticks: 9010, command: ['claude', '--resume', 'reused-controller'], session: 'old' },
  ]);
  result = await activity(['last'], proc, [{ session: 'last', pid: 700, startTicks: 7000, panes: ['0'] }]);
  assert.equal(result.last.state, 'absent', cases[3].name);

  // A Claude started after the rename already has the new inherited name. It
  // must remain new even when it shares the registered controller.
  proc = fixtureProc([
    { pid: 700, ppid: 1, ticks: 7000, command: ['zellij', '--server'], session: 'new' },
    { pid: 702, ppid: 700, ticks: 7020, command: ['claude', '--resume', 'fresh'], session: 'new' },
  ]);
  hook('new', 702, 7020);
  result = await activity(['new', 'old'], proc, [{ session: 'new', pid: 700, startTicks: 7000, panes: ['0'] }]);
  assert.equal(result.new.state, 'busy', cases[4].name);
  assert.equal(result.old.state, 'absent', `${cases[4].name}: no old-name borrowing`);

  // The background shell belongs to the retained controller. The foreground
  // Python tool belongs to a new old-name controller. Neither may cross the
  // current native controller observations.
  proc = fixtureProc([
    { pid: 700, ppid: 1, ticks: 7000, command: ['zellij', '--server'], session: 'new' },
    { pid: 701, ppid: 700, ticks: 7010, command: ['claude', '--resume', 'retained'], session: 'old' },
    { pid: 702, ppid: 701, ticks: 7020, command: ['bash', '-c', 'source /home/user/.claude/shell-snapshots/task.sh'], session: 'old', extraEnv: ['CLAUDE_CODE_SESSION_ID=retained'] },
    { pid: 800, ppid: 1, ticks: 8000, command: ['zellij', '--server'], session: 'old' },
    { pid: 801, ppid: 800, ticks: 8010, command: ['claude', '--resume', 'reused'], session: 'old' },
    { pid: 802, ppid: 801, ticks: 8020, command: ['python3', '-c', 'import time; time.sleep(60)'], session: 'old' },
  ]);
  hook('old', 701, 7010, 'Stop');
  appendHook('old', 801, 8010, 'UserPromptSubmit');
  result = await activity(['new', 'old'], proc, [
    { session: 'new', pid: 700, startTicks: 7000, panes: ['0'] },
    { session: 'old', pid: 800, startTicks: 8000, panes: ['0'] },
  ]);
  assert.equal(result.new.state, 'background', cases[5].name);
  assert.equal(result.old.state, 'busy', `${cases[5].name}: foreground tool remains with reused old controller`);

  // A current controller record without its active pane, and a stopped
  // controller with no record, cannot revive an inherited old environment.
  result = await activity(['new'], proc, [{ session: 'new', pid: 700, startTicks: 7000, panes: [] }]);
  assert.equal(result.new.state, 'absent', `${cases[6].name}: inactive pane`);
  result = await activity(['new'], proc, []);
  assert.equal(result.new.state, 'absent', `${cases[6].name}: stopped controller`);

  process.stdout.write(`PASS status rename cases: ${cases.map((item) => item.name).join('; ')}\n`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
