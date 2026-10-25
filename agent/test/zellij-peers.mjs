import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync, spawn, spawnSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcw-zellij-peers-'));
const oldName = 'native-before';
const newName = 'native-after';
const oldSocket = path.join(root, oldName);
const newSocket = path.join(root, newName);
// The fake server counts the connections it accepts. A line on its stdin asks
// for the count. It first accepts every connection still queued, so the count
// includes every connect the helper made before it exited.
const serverCode = [
  'import os, selectors, socket, sys',
  'sel=selectors.DefaultSelector()',
  'listeners=[]',
  'for p in sys.argv[1:]:',
  ' s=socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)',
  ' s.bind(p); s.listen(); s.setblocking(False)',
  ' sel.register(s, selectors.EVENT_READ); listeners.append(s)',
  'sel.register(0, selectors.EVENT_READ)',
  'accepted=0',
  'def drain():',
  ' global accepted',
  ' for s in listeners:',
  '  while True:',
  '   try: c,_=s.accept()',
  '   except BlockingIOError: break',
  '   c.close(); accepted+=1',
  'print("READY", flush=True)',
  'while True:',
  ' for key,_ in sel.select():',
  '  if key.fileobj == 0:',
  '   if not os.read(0, 64): sys.exit()',
  '   drain(); print(f"ACCEPTS {accepted}", flush=True)',
  '  else: drain()',
].join('\n');

function startTicks(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return Number(stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]);
}

async function listen(paths) {
  const listener = spawn('python3', ['-c', serverCode, ...paths], { stdio: ['pipe', 'pipe', 'inherit'] });
  listener.lines = readline.createInterface({ input: listener.stdout })[Symbol.asyncIterator]();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Unix socket server did not start')), 5000);
    listener.lines.next().then(({ value }) => {
      clearTimeout(timer);
      if (value === 'READY') resolve(); else reject(new Error(`Unix socket server said ${value}`));
    });
    listener.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Unix socket server exited ${code}`)); });
  });
  return listener;
}

// A connect makes a real zellij server log "unknown message" errors and can
// crash a server that is still starting, so the helper must never connect.
async function assertNoConnections(listener, when) {
  listener.stdin.write('COUNT\n');
  const { value } = await listener.lines.next();
  const connections = Number(/^ACCEPTS (\d+)$/.exec(value)?.[1]);
  assert.equal(connections, 0, `the helper connected to a session socket ${connections} times ${when}`);
}

async function stop(listener) {
  const exited = new Promise((resolve) => listener.once('exit', resolve));
  listener.kill('SIGTERM');
  await exited;
}

// The fake replays the zellij CLI replies seen in production. A vanished
// session's socket is unlinked before its "not found" reply. A flaky live
// session drops its first two replies. A lost live session never answers.
// A hung session never replies at all, and a hung-vanished one also closes.
function writeFakeZellij() {
  const executable = path.join(root, 'zellij');
  fs.writeFileSync(executable, [
    '#!/usr/bin/env python3',
    'import os, sys, time',
    "session = sys.argv[sys.argv.index('-s') + 1]",
    "directory = os.environ['FAKE_ZELLIJ_DIR']",
    "counter = f'{directory}.calls-{session}'",
    'calls = (int(open(counter).read()) if os.path.exists(counter) else 0) + 1',
    'open(counter, "w").write(str(calls))',
    "gone = session.startswith(('vanished', 'hung-vanished'))",
    'socket_path = os.path.join(directory, session)',
    'if gone and os.path.lexists(socket_path): os.unlink(socket_path)',
    "if session.startswith('hung'): time.sleep(5)",
    "if gone or session.startswith('lost'):",
    ' print("\\x1b[32;1mother\\x1b[m [Created \\x1b[35;1m30s\\x1b[m ago]")',
    ' print(f"Session \'{session}\' not found. The following sessions are active:", file=sys.stderr)',
    "elif not (session.startswith('flaky') and calls <= 2):",
    ` print(${JSON.stringify(JSON.stringify([{ id: 9, is_plugin: false, exited: false }]))})`,
  ].join('\n'));
  fs.chmodSync(executable, 0o755);
  return executable;
}

const helper = new URL('../bin/mcw-zellij-peers', import.meta.url).pathname;

async function inventory(name, sessions, zellij, extra = []) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory);
  const listener = await listen(sessions.map((session) => path.join(directory, session)));
  const identity = { pid: listener.pid, uid: process.getuid(), gid: process.getgid(), startTicks: startTicks(listener.pid) };
  try {
    const started = performance.now();
    const result = spawnSync('python3', [helper, '--dir', directory, '--zellij', zellij, ...extra],
      { encoding: 'utf8', env: { ...process.env, FAKE_ZELLIJ_DIR: directory } });
    const seconds = (performance.now() - started) / 1000;
    await assertNoConnections(listener, `during the ${name} inventory`);
    return {
      result, seconds,
      row: (session) => ({ session, ...identity, panes: ['9'] }),
      unknown: (session) => ({ session, ...identity, panes: null }),
    };
  } finally {
    await stop(listener);
  }
}

let server;
try {
  server = await listen([oldSocket]);
  fs.renameSync(oldSocket, newSocket);
  const rows = JSON.parse(execFileSync('python3', [helper, '--dir', root, '--peers-only'], { encoding: 'utf8' }));
  assert.deepEqual(rows, [{
    session: newName,
    pid: server.pid,
    uid: process.getuid(),
    gid: process.getgid(),
    startTicks: startTicks(server.pid),
  }]);
  await assertNoConnections(server, 'after a rename');
  // A pane can close after readdir and before lstat. Repeatedly create and
  // remove a second socket while observing the directory. The helper must
  // treat that ENOENT race as an exited pane, while still producing valid JSON.
  const churnSocket = path.join(root, 'closing-pane');
  const churn = spawn('python3', ['-c', [
    'import os,socket,sys,time', 'p=sys.argv[1]',
    'for _ in range(10000):',
    ' s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)',
    ' try:', '  s.bind(p)', '  s.listen()', ' finally:', '  s.close()',
    ' try: os.unlink(p)', ' except FileNotFoundError: pass',
  ].join('\n'), churnSocket], { stdio: 'ignore' });
  for (let index = 0; index < 100; index += 1) {
    const observed = JSON.parse(execFileSync('python3', [helper, '--dir', root, '--peers-only'], { encoding: 'utf8' }));
    assert.ok(observed.every((row) => row.session === newName || row.session === 'closing-pane'));
  }
  churn.kill('SIGTERM');
  await new Promise((resolve) => churn.once('exit', resolve));
  await assertNoConnections(server, 'during the close race');
  server.kill('SIGTERM');
  await new Promise((resolve) => server.once('exit', resolve));
  server = null;
  process.stdout.write('native Unix socket peer identity after rename and close-race, without connecting: PASS\n');

  const zellij = writeFakeZellij();
  const vanished = await inventory('vanished', ['steady-session', 'vanished-session', 'hung-vanished-session'], zellij);
  assert.equal(vanished.result.status, 0, `vanished session failed the poll: ${vanished.result.stderr}`);
  assert.deepEqual(JSON.parse(vanished.result.stdout), [vanished.row('steady-session')]);
  const flaky = await inventory('flaky', ['flaky-session'], zellij);
  assert.equal(flaky.result.status, 0, `live session with two dropped replies failed the poll: ${flaky.result.stderr}`);
  assert.deepEqual(JSON.parse(flaky.result.stdout), [flaky.row('flaky-session')], 'live session with two dropped replies was not kept');
  // A live session that cannot be read is kept with unknown panes, and the run goes on.
  const withoutReason = (rows) => rows.map(({ unknown, ...row }) => row);
  const lost = await inventory('lost', ['lost-session'], zellij);
  assert.equal(lost.result.status, 0, `live session that never answered failed the poll: ${lost.result.stderr}`);
  const lostRows = JSON.parse(lost.result.stdout);
  assert.deepEqual(withoutReason(lostRows), [lost.unknown('lost-session')], 'live session that never answered was not kept as unknown');
  assert.match(lostRows[0].unknown, /invalid pane inventory for lost-session after 4 attempts/);
  const hung = await inventory('hung', ['hung-session'], zellij);
  assert.equal(hung.result.status, 0, `live session whose query hung failed the poll: ${hung.result.stderr}`);
  const hungRows = JSON.parse(hung.result.stdout);
  assert.deepEqual(withoutReason(hungRows), [hung.unknown('hung-session')], 'live session whose query hung was not kept as unknown');
  assert.match(hungRows[0].unknown, /pane inventory timed out for hung-session/);
  process.stdout.write('pane inventory omits a vanished session and never drops a live one, without connecting: PASS\n');

  // One slow session no longer fails the whole run. The next session is still read.
  const mixed = await inventory('mixed', ['hung-session', 'steady-session'], zellij);
  assert.equal(mixed.result.status, 0, `one slow session failed the poll: ${mixed.result.stderr}`);
  assert.deepEqual(withoutReason(JSON.parse(mixed.result.stdout)), [mixed.unknown('hung-session'), mixed.row('steady-session')]);
  process.stdout.write(`a timed-out session is unknown and the next one is still read, in ${mixed.seconds.toFixed(1)} s: PASS\n`);

  // Every query takes 3 s at most and none starts once it could end after the budget, so the
  // helper ends before the agent's 12 s kill however many sessions are slow.
  const budget = await inventory('budget', ['hung-a', 'hung-b', 'hung-c', 'hung-d'], zellij, ['--budget', '7']);
  assert.equal(budget.result.status, 0, budget.result.stderr);
  const budgetRows = JSON.parse(budget.result.stdout);
  assert.deepEqual(budgetRows.map((row) => row.session), ['hung-a', 'hung-b', 'hung-c', 'hung-d']);
  assert.ok(budgetRows.every((row) => row.panes === null && typeof row.unknown === 'string'));
  assert.equal(budgetRows.filter((row) => /no time left in the 7s budget/.test(row.unknown)).length, 2, JSON.stringify(budgetRows));
  assert.ok(budget.seconds < 8, `four slow sessions took ${budget.seconds.toFixed(1)} s with a 7 s budget`);
  process.stdout.write(`four slow sessions end within the 7 s budget, in ${budget.seconds.toFixed(1)} s: PASS\n`);
} finally {
  if (server && !server.killed) server.kill('SIGTERM');
  fs.rmSync(root, { recursive: true, force: true });
}
