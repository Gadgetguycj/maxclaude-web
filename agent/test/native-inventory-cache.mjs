import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// The status poll runs every second. Each native pane inventory starts one
// Zellij client per session. With --command, every client also made its
// server run ps over the whole process table. This test drives the real peer
// helper against a real Unix socket and a recording zellij stand-in, then
// counts zellij invocations across repeated snapshots.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcw-native-cache-'));
const socketDir = path.join(root, 'sockets', 'contract_version_1');
const proc = path.join(root, 'proc');
const calls = path.join(root, 'zellij-calls.log');
const panesFile = path.join(root, 'panes.json');
const hangFile = path.join(root, 'hang');
const zellij = path.join(root, 'zellij');
fs.mkdirSync(socketDir, { recursive: true });
// While the hang file exists every query hangs past the helper's 3 s limit, as a slow zellij does.
fs.writeFileSync(zellij, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\n[ -e '${hangFile}' ] && sleep 5\ncat '${panesFile}'\n`, { mode: 0o755 });
fs.writeFileSync(panesFile, JSON.stringify([{ id: 0, is_plugin: false, exited: false }, { id: 0, is_plugin: true, exited: false }]));
process.env.MCW_ZELLIJ_BIN = zellij;
process.env.ZELLIJ_SOCKET_DIR = path.join(root, 'sockets');
const statusModule = process.env.STATUS_MODULE || new URL('../src/status.js', import.meta.url).href;
const { readSessionProcessSnapshot, NATIVE_INVENTORY_MAX_AGE_MS } = await import(statusModule);

const serverCode = [
  'import socket, sys', 's=socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)',
  's.bind(sys.argv[1]); s.listen()', 'print("READY", flush=True)',
  'while True:', ' c,_=s.accept()', ' c.close()',
].join('\n');

function realStartTicks(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return Number(stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]);
}

function writeProcess(pid, { ppid, ticks, tty = 34816, command, env = [] }) {
  const dir = path.join(proc, String(pid));
  fs.mkdirSync(dir, { recursive: true });
  const fields = ['S', ppid, pid, pid, tty, ...Array(14).fill(1), ticks, 1];
  fs.writeFileSync(path.join(dir, 'stat'), `${pid} (${path.basename(command[0])}) ${fields.join(' ')}\n`);
  fs.writeFileSync(path.join(dir, 'status'), `Name:\t${path.basename(command[0])}\nState:\tS (sleeping)\nPPid:\t${ppid}\n`);
  fs.writeFileSync(path.join(dir, 'cmdline'), Buffer.from([...command, ''].join('\0')));
  fs.writeFileSync(path.join(dir, 'environ'), Buffer.from([...env, ''].join('\0')));
}

async function listenOn(socket) {
  const listener = spawn('python3', ['-c', serverCode, socket], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Unix socket server did not start')), 5000);
    listener.stdout.on('data', (chunk) => { if (String(chunk).includes('READY')) { clearTimeout(timer); resolve(); } });
    listener.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Unix socket server exited ${code}`)); });
  });
  return listener;
}

const zellijCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : []);
const sessions = async () => [...(await readSessionProcessSnapshot(proc)).claudePanes.values()].map((pane) => `${pane.session}:${pane.pane}`).sort();

let server;
let second;
try {
  const socket = path.join(socketDir, 'before');
  server = spawn('python3', ['-c', serverCode, socket], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Unix socket server did not start')), 5000);
    server.stdout.on('data', (chunk) => { if (String(chunk).includes('READY')) { clearTimeout(timer); resolve(); } });
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Unix socket server exited ${code}`)); });
  });
  fs.mkdirSync(proc, { recursive: true });
  fs.writeFileSync(path.join(proc, 'stat'), 'btime 1000\n');
  fs.writeFileSync(path.join(proc, 'uptime'), '100.00 0.00\n');
  writeProcess(server.pid, { ppid: 1, ticks: realStartTicks(server.pid), command: ['zellij', '--server', socket] });
  const claude = { ppid: server.pid, ticks: 5000, command: ['claude'], env: ['ZELLIJ_SESSION_NAME=before', 'ZELLIJ_PANE_ID=0'] };
  writeProcess(990001, claude);

  assert.deepEqual(await sessions(), ['before:0']);
  assert.deepEqual(zellijCalls(), ['-s before action list-panes --json'], 'pane inventory must not request --command or --state');
  for (let index = 0; index < 20; index += 1) assert.deepEqual(await sessions(), ['before:0']);
  assert.equal(zellijCalls().length, 1, 'unchanged sockets, servers, and Claude panes reuse the native inventory');
  process.stdout.write('unchanged native inventory is reused across 20 snapshots: PASS\n');

  // Closing a pane hangs up its terminal. A Claude that survives the hangup
  // loses its controlling tty, which forces a fresh native inventory.
  fs.writeFileSync(panesFile, JSON.stringify([{ id: 0, is_plugin: true, exited: false }]));
  writeProcess(990001, { ...claude, tty: 0 });
  assert.deepEqual(await sessions(), [], 'a closed pane removes the surviving Claude on the next snapshot');
  assert.equal(zellijCalls().length, 2);
  process.stdout.write('closed pane is observed on the next snapshot: PASS\n');

  // Zellij may expose a new pane process before listing the pane. An unlisted
  // live Claude is rechecked after one second, then with backoff.
  writeProcess(990002, { ppid: server.pid, ticks: 6000, command: ['claude'], env: ['ZELLIJ_SESSION_NAME=before', 'ZELLIJ_PANE_ID=4'] });
  assert.deepEqual(await sessions(), []);
  assert.equal(zellijCalls().length, 3);
  assert.deepEqual(await sessions(), []);
  assert.equal(zellijCalls().length, 3, 'an unlisted pane is not rechecked on every snapshot');
  fs.writeFileSync(panesFile, JSON.stringify([{ id: 4, is_plugin: false, exited: false }]));
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.deepEqual(await sessions(), ['before:4']);
  assert.equal(zellijCalls().length, 4);
  assert.deepEqual(await sessions(), ['before:4']);
  assert.equal(zellijCalls().length, 4);
  process.stdout.write('late pane listing is rechecked after one second: PASS\n');

  // A rename moves the socket. The session name changes on the next snapshot.
  fs.renameSync(socket, path.join(socketDir, 'after'));
  assert.deepEqual(await sessions(), ['after:4']);
  assert.deepEqual(zellijCalls().at(-1), '-s after action list-panes --json');
  process.stdout.write('renamed socket is observed on the next snapshot: PASS\n');

  // A replaced Claude process in the same pane is a new identity.
  fs.rmSync(path.join(proc, '990002'), { recursive: true });
  writeProcess(990003, { ppid: server.pid, ticks: 7000, command: ['claude'], env: ['ZELLIJ_SESSION_NAME=before', 'ZELLIJ_PANE_ID=4'] });
  const before = zellijCalls().length;
  assert.deepEqual(await sessions(), ['after:4']);
  assert.equal(zellijCalls().length, before + 1);
  process.stdout.write('new Claude identity refreshes the native inventory: PASS\n');

  // A session zellij is slow to answer for keeps the panes last listed for its server. Its
  // Claude stays in the inventory, and the snapshot says the session's panes are not fresh.
  fs.writeFileSync(hangFile, '');
  writeProcess(990003, { ppid: server.pid, ticks: 7000, tty: 34817, command: ['claude'], env: ['ZELLIJ_SESSION_NAME=before', 'ZELLIJ_PANE_ID=4'] });
  let snapshot = await readSessionProcessSnapshot(proc);
  assert.deepEqual([...snapshot.claudePanes.values()].map((pane) => `${pane.session}:${pane.pane}`), ['after:4'], 'a slow session lost its Claude');
  assert.deepEqual([...snapshot.incompleteSessions], ['after']);
  assert.deepEqual([...snapshot.unknownSessions], []);
  process.stdout.write('a session whose pane query timed out keeps its last panes: PASS\n');

  // A helper run that fails outright falls back to the last inventory. A pane without an id
  // makes the helper itself fail, the way any unexpected error would.
  fs.rmSync(hangFile);
  fs.writeFileSync(panesFile, JSON.stringify([{ is_plugin: false, exited: false }]));
  writeProcess(990003, { ppid: server.pid, ticks: 7000, tty: 34818, command: ['claude'], env: ['ZELLIJ_SESSION_NAME=before', 'ZELLIJ_PANE_ID=4'] });
  const failedCalls = zellijCalls().length;
  snapshot = await readSessionProcessSnapshot(proc);
  assert.equal(zellijCalls().length, failedCalls + 1, 'the helper ran');
  assert.deepEqual([...snapshot.claudePanes.values()].map((pane) => `${pane.session}:${pane.pane}`), ['after:4'], 'a failed helper run emptied the inventory');
  assert.deepEqual([...snapshot.incompleteSessions], ['after']);
  process.stdout.write('a failed helper run falls back to the last inventory: PASS\n');

  // A new session that is slow on its first query has no earlier panes. It is unknown, and the
  // session that was read before keeps its panes.
  fs.writeFileSync(panesFile, JSON.stringify([{ id: 4, is_plugin: false, exited: false }]));
  fs.writeFileSync(hangFile, '');
  const freshSocket = path.join(socketDir, 'fresh');
  second = await listenOn(freshSocket);
  writeProcess(second.pid, { ppid: 1, ticks: realStartTicks(second.pid), command: ['zellij', '--server', freshSocket] });
  writeProcess(990004, { ppid: second.pid, ticks: 8000, command: ['claude'], env: ['ZELLIJ_SESSION_NAME=fresh', 'ZELLIJ_PANE_ID=0'] });
  snapshot = await readSessionProcessSnapshot(proc);
  assert.deepEqual([...snapshot.claudePanes.values()].map((pane) => `${pane.session}:${pane.pane}`), ['after:4']);
  assert.deepEqual([...snapshot.unknownSessions], ['fresh']);
  assert.deepEqual([...snapshot.incompleteSessions].sort(), ['after', 'fresh']);
  fs.rmSync(hangFile);
  process.stdout.write('a new session that is slow on its first query is unknown: PASS\n');

  assert.equal(NATIVE_INVENTORY_MAX_AGE_MS, 30000);
  process.stdout.write('native inventory cache regression checks passed\n');
} finally {
  if (server && server.exitCode === null) server.kill('SIGTERM');
  if (second && second.exitCode === null) second.kill('SIGTERM');
  fs.rmSync(root, { recursive: true, force: true });
}
