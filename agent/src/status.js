import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { config } from './config.js';

const STATUS_VALUES = new Set(['busy', 'idle', 'interrupt']);
export const CLAIM_MAX_AGE_MS = 90000;
export const TRANSCRIPT_READ_CHUNK_BYTES = 65536;
export const HOOK_LEDGER_TAIL_BYTES = 131072;
export const MAX_FUTURE_EVENT_MS = 0;
export const EXECUTION_PRE_HOOK_SKEW_MS = 1000;
const MAX_CACHE_ENTRIES = 512;
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
// Each native pane inventory starts one Zellij client per session, and each
// request makes that server spawn threads and run ps over every process. Reuse
// the last inventory while the sockets, servers, and live Claude pane
// identities are unchanged. An unlisted live Claude pane is rechecked with
// backoff, and any inventory is refreshed after 30 seconds.
export const NATIVE_INVENTORY_MAX_AGE_MS = 30000;
const NATIVE_INVENTORY_RETRY_MS = 1000;
// The helper gets PEERS_BUDGET_S to ask the sessions and is killed at PEERS_TIMEOUT_MS.
const PEERS_BUDGET_S = 9;
const PEERS_TIMEOUT_MS = 12000;
// After a failed helper run the last inventory stands in for this long before the next run.
const FAILED_INVENTORY_RETRY_MS = 5000;
const nativeInventory = new Map();
// The last inventory a helper run produced, and each zellij server's last pane list, by
// inventory key. A server whose panes could not be read keeps its last list, and a helper run
// that fails falls back to the last inventory, so a slow zellij never empties the lights.
const lastInventory = new Map();
const lastServerPanes = new Map();
// One helper run at a time, whoever asks for it.
let nativeInventoryQueue = Promise.resolve();
const execFileAsync = promisify(execFile);
const transcriptCache = new Map();
let transcriptCacheBytes = 0;
let clockTicks = null;
const peerProbe = fileURLToPath(new URL('../bin/mcw-zellij-peers', import.meta.url));

function cacheGet(key) {
  const value = transcriptCache.get(key);
  if (value) {
    transcriptCache.delete(key);
    transcriptCache.set(key, value);
  }
  return value;
}

function cacheSet(key, value) {
  const previous = transcriptCache.get(key);
  if (previous) transcriptCacheBytes -= previous.cacheBytes || 0;
  const cacheBytes = Buffer.byteLength(JSON.stringify(value));
  const cached = { ...value, cacheBytes };
  transcriptCache.delete(key);
  transcriptCache.set(key, cached);
  transcriptCacheBytes += cacheBytes;
  while (transcriptCache.size > MAX_CACHE_ENTRIES || transcriptCacheBytes > MAX_CACHE_BYTES) {
    const oldest = [...transcriptCache.keys()].find((candidate) => {
      const entry = transcriptCache.get(candidate);
      return !candidate.startsWith('growth:') || !entry?.leaseUntilMono || entry.leaseUntilMono <= performance.now();
    }) || transcriptCache.keys().next().value;
    transcriptCacheBytes -= transcriptCache.get(oldest)?.cacheBytes || 0;
    transcriptCache.delete(oldest);
  }
}

function currentTimestamp(value, observedAt) {
  return Number.isFinite(value) && value > 0 && value <= observedAt + MAX_FUTURE_EVENT_MS
    ? Math.floor(value) : 0;
}

// One status read per process per snapshot. Ancestry walks revisit the same
// parents for every descendant, so they share these parsed values.
function processStatusReader() {
  const cache = new Map();
  return (proc) => {
    if (cache.has(proc)) return cache.get(proc);
    let value = null;
    try {
      const text = fs.readFileSync(path.join(proc, 'status'), 'utf8');
      value = { ppid: Number(text.match(/^PPid:\s+(\d+)/m)?.[1] || 0), zombie: /^State:\s+Z\b/m.test(text) };
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ESRCH') throw error;
    }
    cache.set(proc, value);
    return value;
  };
}

function controllerForProcess(pid, procRoot = '/proc', readStatus = processStatusReader()) {
  let current = Number(pid);
  for (let depth = 0; current > 1 && depth < 64; depth += 1) {
    const proc = path.join(procRoot, String(current));
    const command = readNulFile(path.join(proc, 'cmdline'));
    if (path.basename(command[0] || '') === 'zellij' && command.includes('--server') && !processIsZombie(proc, readStatus)) {
      const startTicks = processStartTicks(proc); if (startTicks) return { pid: current, startTicks };
    }
    const status = readStatus(proc);
    if (!status) return null;
    current = status.ppid;
  }
  return null;
}

function socketDirectorySignature(directory) {
  const sockets = [];
  for (const name of fs.readdirSync(directory)) {
    try {
      const stat = fs.lstatSync(path.join(directory, name));
      if (stat.isSocket()) sockets.push(`${name}:${stat.ino}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return `${directory}\0${sockets.sort().join('\0')}`;
}

async function observeControllerSessions(procRoot, processes, claudes) {
  const directories = new Set();
  const servers = [];
  const socketRoot = path.resolve(process.env.ZELLIJ_SOCKET_DIR || path.join(config.runtimeDir, 'zellij'));
  for (const { pid, startTicks, command } of processes) {
    const server = command.indexOf('--server');
    if (path.basename(command[0] || '') !== 'zellij' || server < 0 || !path.isAbsolute(command[server + 1] || '')) continue;
    const directory = path.dirname(command[server + 1]);
    if (directory === socketRoot || directory.startsWith(`${socketRoot}${path.sep}`)) {
      directories.add(directory);
      servers.push(`${pid}:${startTicks}`);
    }
  }
  if (!directories.size) return [];
  const sortedDirectories = [...directories].sort();
  const serverSet = new Set(servers);
  const panes = claudes.filter((claude) => claude.pane && claude.controller
    && serverSet.has(`${claude.controller.pid}:${claude.controller.startTicks}`));
  const key = `${procRoot}\0${sortedDirectories.join('\0')}`;
  // A closed pane hangs up its terminal, which clears the controlling tty of
  // a surviving Claude. That change also forces a fresh inventory.
  const signature = [
    ...sortedDirectories.map(socketDirectorySignature),
    servers.sort().join(','),
    panes.map((claude) => [claude.pid, claude.startTicks, claude.ttyNr, claude.pane,
      claude.controller.pid, claude.controller.startTicks].join(':')).sort().join(','),
  ].join('\n');
  const reusable = (entry) => entry && entry.signature === signature && performance.now() < entry.validUntil;
  if (reusable(nativeInventory.get(key))) return nativeInventory.get(key).rows;
  const turn = nativeInventoryQueue.then(() => refreshControllerSessions(key, signature, sortedDirectories, panes, reusable));
  nativeInventoryQueue = turn.catch(() => {});
  return turn;
}

function serverKey(key, row) {
  return `${key}\0${row?.pid}:${row?.startTicks}`;
}

// Rows whose panes the helper could not read take the last panes read from the same server.
// Each such row is marked stale. A row without earlier panes keeps panes null and stays unknown.
function withRememberedPanes(key, rows) {
  const servers = new Set();
  const merged = rows.map((row) => {
    const server = serverKey(key, row);
    servers.add(server);
    if (Array.isArray(row?.panes)) {
      lastServerPanes.set(server, row.panes);
      return row;
    }
    const panes = lastServerPanes.get(server);
    return panes ? { ...row, panes, stale: row?.unknown || 'pane inventory unavailable' } : row;
  });
  for (const server of lastServerPanes.keys()) {
    if (server.startsWith(`${key}\0`) && !servers.has(server)) lastServerPanes.delete(server);
  }
  return merged;
}

function helperFailure(error) {
  if (error?.killed || error?.signal) return `killed after ${PEERS_TIMEOUT_MS} ms`;
  const line = `${error?.stderr || ''}`.trim().split('\n').filter(Boolean).at(-1);
  return line || String(error?.message || error);
}

async function refreshControllerSessions(key, signature, sortedDirectories, panes, reusable) {
  // A caller that waited behind another run reuses its result if nothing
  // changed in between.
  const cached = nativeInventory.get(key);
  if (reusable(cached)) return cached.rows;
  const now = performance.now();
  const args = [peerProbe, '--zellij', config.zellijBin, '--budget', String(PEERS_BUDGET_S),
    ...sortedDirectories.flatMap((directory) => ['--dir', directory])];
  // The helper runs for seconds, so it must not block the event loop that
  // also carries terminal traffic. Its stderr still goes to the journal.
  let rows;
  try {
    const result = await execFileAsync('python3', args, { encoding: 'utf8', timeout: PEERS_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
    if (result.stderr) process.stderr.write(result.stderr);
    rows = JSON.parse(result.stdout);
    if (!Array.isArray(rows)) throw new Error('the pane inventory helper did not print a list');
  } catch (error) {
    if (error.stderr) process.stderr.write(error.stderr);
    const previous = lastInventory.get(key);
    if (!previous) throw error;
    const reason = helperFailure(error);
    process.stderr.write(`pane inventory failed (${reason}); using the inventory from ${Math.round((now - previous.at) / 1000)} s ago\n`);
    const fallback = previous.rows.map((row) => ({ ...row, stale: reason }));
    nativeInventory.set(key, { signature, rows: fallback, retryMs: 0, validUntil: now + FAILED_INVENTORY_RETRY_MS });
    return fallback;
  }
  rows = withRememberedPanes(key, rows);
  lastInventory.set(key, { rows: rows.map(({ stale, ...row }) => row), at: now });
  // Zellij can expose a new pane's process before it lists the pane.
  const listed = new Set();
  const observed = new Set();
  for (const row of rows) {
    observed.add(`${row?.pid}:${row?.startTicks}`);
    for (const pane of Array.isArray(row?.panes) ? row.panes : []) listed.add(`${row.pid}:${row.startTicks}:${pane}`);
  }
  const unlisted = panes.some((claude) => observed.has(`${claude.controller.pid}:${claude.controller.startTicks}`)
    && !listed.has(`${claude.controller.pid}:${claude.controller.startTicks}:${claude.pane}`));
  // A session whose panes were not read this run is asked again soon, with the same backoff.
  const incomplete = rows.some((row) => row?.unknown);
  const retryMs = unlisted || incomplete
    ? Math.min(NATIVE_INVENTORY_MAX_AGE_MS, cached?.signature === signature && cached.retryMs ? cached.retryMs * 2 : NATIVE_INVENTORY_RETRY_MS)
    : 0;
  nativeInventory.set(key, { signature, rows, retryMs, validUntil: now + (retryMs || NATIVE_INVENTORY_MAX_AGE_MS) });
  return rows;
}

function readNulFile(file) {
  try {
    return fs.readFileSync(file).toString('utf8').split('\0');
  } catch (error) {
    // A process may exit between readdir and this read.  Other failures mean
    // the inventory is incomplete and must not become an absence claim.
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return [];
    throw error;
  }
}

function envValue(values, name) {
  const prefix = `${name}=`;
  return values.find((value) => value.startsWith(prefix))?.slice(prefix.length) || null;
}

function isClaudeCommand(values) {
  const executable = path.basename(values[0] || '');
  if (!/^claude(?:\.exe)?$/.test(executable)) return false;
  const args = values.slice(1).join(' ');
  return !/(?:^|\s)(?:bg-pty-host|bg-spare)(?:\s|$)|daemon run|--fork-session/.test(args);
}

function shellSnapshotCommandHash(values) {
  if (!/^(?:ba|z)?sh$/.test(path.basename(values[0] || '')) || values[1] !== '-c') return null;
  const script = values[2] || '';
  // Claude's Bash wrapper places the exact tool command in a single-quoted
  // eval argument.  Decode only Bash's standard single-quote splice form.
  // Most wrappers redirect stdin after eval. Heredoc commands deliberately do
  // not, then continue to the fixed cwd marker. Both forms preserve the same
  // single-quote splice encoding of the original Bash input.
  const match = /(?:^|&&\s*)eval '((?:[^']|'"'"')*)'\s*(?=<|&&\s+pwd\b|$)/.exec(script);
  if (!match) return null;
  const command = match[1].replaceAll("'\"'\"'", "'");
  return createHash('sha256').update(command).digest('hex');
}

function descendsFrom(pid, ancestors, procRoot) {
  let current = Number(pid);
  for (let depth = 0; current > 1 && depth < 64; depth += 1) {
    let parent = 0;
    try {
      const match = fs.readFileSync(path.join(procRoot, String(current), 'status'), 'utf8').match(/^PPid:\s+(\d+)/m);
      parent = Number(match?.[1] || 0);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return false;
      throw error;
    }
    if (ancestors.has(parent)) {
      // A PID reached through PPid is only an ancestor if it is still the
      // exact process sampled as the root.  This closes the PID-reuse window
      // between the initial /proc pass and this ancestry walk.
      if (!(ancestors instanceof Map)) return true;
      const expectedTicks = ancestors.get(parent);
      return expectedTicks > 0 && processStartTicks(path.join(procRoot, String(parent))) === expectedTicks;
    }
    current = parent;
  }
  return false;
}

function ownerForDescendant(pid, owners, procRoot, readStatus = processStatusReader()) {
  let current = Number(pid);
  for (let depth = 0; current > 1 && depth < 64; depth += 1) {
    const status = readStatus(path.join(procRoot, String(current)));
    if (!status) return null;
    const parent = status.ppid;
    if (owners.has(parent) && processStartTicks(path.join(procRoot, String(parent))) === owners.get(parent)) return { pid: parent, startTicks: owners.get(parent) };
    current = parent;
  }
  return null;
}

function processStartTicks(proc) {
  try {
    const value = fs.readFileSync(path.join(proc, 'stat'), 'utf8');
    const close = value.lastIndexOf(')');
    if (close < 0) return 0;
    const ticks = Number(value.slice(close + 2).trim().split(/\s+/)[19]);
    return Number.isInteger(ticks) && ticks > 0 ? ticks : 0;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return 0;
    throw error;
  }
}

function processStartedAt(procRoot, ticks, bootSeconds = null) {
  try {
    if (!clockTicks) clockTicks = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
    const btime = bootSeconds ?? Number(fs.readFileSync(path.join(procRoot, 'stat'), 'utf8').match(/^btime\s+(\d+)$/m)?.[1]);
    return Number.isFinite(btime) && Number.isFinite(clockTicks) && clockTicks > 0 ? (btime * 1000) + Math.floor((ticks * 1000) / clockTicks) : 0;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return 0;
    throw error;
  }
}

function processBootTicks(procRoot) {
  try {
    if (!clockTicks) clockTicks = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
    const uptime = Number(fs.readFileSync(path.join(procRoot, 'uptime'), 'utf8').trim().split(/\s+/)[0]);
    return Number.isFinite(uptime) && Number.isFinite(clockTicks) && clockTicks > 0 ? Math.floor(uptime * clockTicks) : 0;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return 0;
    throw error;
  }
}

function processIsZombie(proc, readStatus = processStatusReader()) {
  const status = readStatus(proc);
  return !status || status.zombie;
}

function processTerminal(proc) {
  try {
    const value = fs.readFileSync(path.join(proc, 'stat'), 'utf8');
    const close = value.lastIndexOf(')');
    return close < 0 ? 0 : Number(value.slice(close + 2).trim().split(/\s+/)[4]) || 0;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return 0;
    throw error;
  }
}

export function processDescendsFrom(pid, roots, procRoot = '/proc') {
  return descendsFrom(pid, roots, procRoot);
}

async function readProcessSnapshot(procRoot = '/proc', controllerSessions = null) {
  const claudePanes = new Map();
  const backgroundPanes = new Map();
  // Asking readdir for Dirent metadata makes Node lstat every DT_UNKNOWN
  // procfs entry. A PID can exit between getdents and that lstat, turning a
  // normal exit race into an inventory failure. Names plus semantic proc reads
  // distinguish that exit from permission failures in the helpers below.
  const entries = fs.readdirSync(procRoot).filter((name) => /^\d+$/.test(name));
  const bootSeconds = Number(fs.readFileSync(path.join(procRoot, 'stat'), 'utf8').match(/^btime\s+(\d+)$/m)?.[1]);
  const readStatus = processStatusReader();
  const processes = [];
  const claudes = [];
  for (const name of entries) {
    const proc = path.join(procRoot, name);
    if (processIsZombie(proc, readStatus)) continue;
    const command = readNulFile(path.join(proc, 'cmdline'));
    if (!command[0]) continue;
    const claude = isClaudeCommand(command);
    // A live Claude process with an unreadable identity invalidates the whole
    // inventory. It must not become an absence claim.
    const env = claude ? readNulFile(path.join(proc, 'environ')) : null;
    const startTicks = processStartTicks(proc);
    if (!startTicks) continue;
    const startedAt = claude ? processStartedAt(procRoot, startTicks, bootSeconds) : 0;
    const pid = Number(name);
    processes.push({ pid, startTicks, startedAt, command });
    if (claude) {
      claudes.push({ pid, proc, startTicks, startedAt, command, env, pane: envValue(env, 'ZELLIJ_PANE_ID'),
        ttyNr: processTerminal(proc), controller: controllerForProcess(pid, procRoot, readStatus) });
    }
  }
  const controllers = new Map();
  // Sessions whose panes come from an earlier inventory, and the subset with no panes at all.
  const incompleteSessions = new Set();
  const unknownSessions = new Set();
  for (const row of controllerSessions ?? await observeControllerSessions(procRoot, processes, claudes)) {
    const unknown = row.panes === null && typeof row.unknown === 'string';
    if (typeof row.session !== 'string' || !Number.isInteger(row.pid) || !Number.isInteger(row.startTicks)
      || row.pid <= 0 || row.startTicks <= 0 || !(Array.isArray(row.panes) || unknown)) throw new Error('invalid zellij controller observation');
    if (processStartTicks(path.join(procRoot, String(row.pid))) !== row.startTicks) continue;
    const key = `${row.pid}\0${row.startTicks}`;
    if (controllers.has(key) && controllers.get(key).session !== row.session) throw new Error('ambiguous zellij controller namespace');
    controllers.set(key, { ...row, panes: new Set((row.panes || []).map(String)) });
    if (unknown) unknownSessions.add(row.session);
    if (unknown || row.stale) incompleteSessions.add(row.session);
  }
  for (const { pid, proc, startTicks, startedAt, command, env, pane, controller } of claudes) {
    const observed = controller && controllers.get(`${controller.pid}\0${controller.startTicks}`);
    if (!observed || !pane || !observed.panes.has(pane)
      || processStartTicks(proc) !== startTicks) continue;
    const session = observed.session;
    const key = `${session}\0${pane}`;
    const previous = claudePanes.get(key);
    const started = previous?.startedAt && startedAt
      ? Math.min(previous.startedAt, startedAt)
      : (previous?.startedAt || startedAt);
    claudePanes.set(key, {
      session,
      pane,
      hookSession: envValue(env, 'ZELLIJ_SESSION_NAME') || session,
      controller,
      startedAt: started,
      pids: [...(previous?.pids || []), pid],
      processes: [...(previous?.processes || []), { pid, startTicks }],
      commands: [...(previous?.commands || []), command],
      cwd: previous?.cwd || (() => {
        try { return fs.readlinkSync(path.join(proc, 'cwd')); } catch (error) {
          if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return null;
          throw error;
        }
      })(),
    });
  }
  const roots = new Map();
  const rootPanes = new Map();
  for (const [key, pane] of claudePanes) for (const root of pane.processes) {
    roots.set(root.pid, root.startTicks);
    rootPanes.set(root.pid, { key, pane });
  }
  for (const process of processes) {
    const { pid, startTicks, command } = process;
    const owner = ownerForDescendant(pid, roots, procRoot, readStatus);
    if (!owner || processStartTicks(path.join(procRoot, String(pid))) !== startTicks) continue;
    const startedAt = processStartedAt(procRoot, startTicks, bootSeconds);
    const { key, pane } = rootPanes.get(owner.pid);
    const shell = /^(?:ba|z)?sh$/.test(path.basename(command[0])) && command.join(' ').includes('/.claude/shell-snapshots/');
    if (shell) {
      let outputAt = 0;
      for (const fd of ['1', '2']) try {
        const stat = fs.statSync(path.join(procRoot, String(pid), 'fd', fd));
        if (stat.isFile()) outputAt = Math.max(outputAt, Math.floor(stat.mtimeMs));
      } catch { /* exited or non-file output */ }
      const prior = backgroundPanes.get(key);
      const env = readNulFile(path.join(procRoot, String(pid), 'environ'));
      if (processStartTicks(path.join(procRoot, String(pid))) !== startTicks) continue;
      const sid = envValue(env, 'CLAUDE_CODE_SESSION_ID');
      backgroundPanes.set(key, {
        session: pane.session, pane: pane.pane,
        startedAt: Math.min(prior?.startedAt || startedAt, startedAt),
        activityAt: Math.max(prior?.activityAt || 0, startedAt, outputAt),
        pids: [...(prior?.pids || []), pid],
        processes: [...(prior?.processes || []), { pid, startTicks, startedAt, owner, commandHash: shellSnapshotCommandHash(command) }],
        sessionIds: [...new Set([...(prior?.sessionIds || []), ...(sid ? [sid] : [])])],
      });
    }
  }
  return { claudePanes, backgroundPanes, observedBootTicks: processBootTicks(procRoot), processes, incompleteSessions, unknownSessions };
}

export async function readSessionProcessSnapshot(procRoot = '/proc', controllerSessions = null) {
  return readProcessSnapshot(procRoot, controllerSessions);
}

export async function readLiveClaudePanes(procRoot = '/proc', controllerSessions = null) {
  return (await readProcessSnapshot(procRoot, controllerSessions)).claudePanes;
}

export async function readLiveBackgroundPanes(procRoot = '/proc', controllerSessions = null) {
  return (await readProcessSnapshot(procRoot, controllerSessions)).backgroundPanes;
}


function readPaneStatus(session, pane, statusDir) {
  const file = path.join(statusDir, session, `${pane}.json`);
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!STATUS_VALUES.has(value.state) || !Number.isFinite(value.updatedAt)) return null;
    const pid = Number(value.pid);
    const pidStartTicks = Number(value.pidStartTicks);
    return {
      state: value.state,
      updatedAt: Math.floor(value.updatedAt),
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
      pidStartTicks: Number.isInteger(pidStartTicks) && pidStartTicks > 0 ? pidStartTicks : null,
      transcriptPath: typeof value.transcriptPath === 'string' ? value.transcriptPath : null,
    };
  } catch {
    return null;
  }
}

function readPaneEvents(session, pane, statusDir) {
  const file = path.join(statusDir, session, `${pane}.events.jsonl`);
  const checkpointFile = path.join(statusDir, session, `${pane}.events.state.json`);
  let stat;
  try { stat = fs.statSync(file); } catch { return []; }
  let checkpointMtimeMs = 0;
  try { checkpointMtimeMs = fs.statSync(checkpointFile).mtimeMs; } catch { /* no checkpoint */ }
  const cacheKey = `ledger:${file}`;
  const cached = cacheGet(cacheKey);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && cached.checkpointMtimeMs === checkpointMtimeMs) return cached.events;
  const events = [];
  // The hook checkpoints the active turn before bounded history is rotated.
  // It contains observations, never a claimed state, and the reducer still
  // requires the matching live Claude process below.
  try {
    const checkpoint = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'));
    for (const event of checkpoint.events || []) events.push(event);
    // Completed ids are checkpointed compactly, one owner and one current
    // prompt at a time.  Recreate causal PostToolUse observations for the
    // reducer without retaining every historical event in the checkpoint.
    for (const completed of checkpoint.completedTools || []) {
      if (!Number.isInteger(completed?.pid) || !Number.isInteger(completed?.pidStartTicks)) continue;
      for (const toolUseId of completed.tools || []) {
        if (typeof toolUseId !== 'string' || !toolUseId) continue;
        events.push({ eventName: 'PostToolUse', sequence: completed.sequence || 0, updatedAt: completed.updatedAt || 0,
          pid: completed.pid, pidStartTicks: completed.pidStartTicks, toolUseId, accepted: true });
      }
    }
  } catch (error) {
    if (!['ENOENT', 'ESRCH'].includes(error?.code)) { /* invalid checkpoint is ignored, ledger remains evidence */ }
  }
  try {
    const bytes = Math.min(stat.size, HOOK_LEDGER_TAIL_BYTES);
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.allocUnsafe(bytes);
    fs.readSync(fd, buffer, 0, bytes, stat.size - bytes);
    fs.closeSync(fd);
    const lines = buffer.toString('utf8').split('\n');
    for (const line of (bytes < stat.size ? lines.slice(1) : lines)) {
      try {
        const value = JSON.parse(line);
        if (!['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Notification', 'Interrupt'].includes(value.eventName)) continue;
        if (!Number.isFinite(value.updatedAt) || !Number.isInteger(value.pid) || value.pid <= 0
          || !Number.isInteger(value.pidStartTicks) || value.pidStartTicks <= 0) continue;
        const sequence = Number.isInteger(value.sequence) && value.sequence > 0 ? value.sequence : 0;
        const bootTicks = Number(value.bootTicks);
        events.push({ eventName: value.eventName, updatedAt: Math.floor(value.updatedAt), sequence, pid: value.pid, pidStartTicks: value.pidStartTicks,
          bootTicks: Number.isInteger(bootTicks) && bootTicks > 0 ? bootTicks : 0,
          toolUseId: typeof value.toolUseId === 'string' ? value.toolUseId : null,
          accepted: value.accepted !== false,
          toolName: typeof value.toolName === 'string' ? value.toolName : null,
          toolCommandHash: typeof value.toolCommandHash === 'string' && /^[a-f0-9]{64}$/.test(value.toolCommandHash) ? value.toolCommandHash : null });
      } catch { /* incomplete concurrent append */ }
    }
  } catch { /* ledger is optional history */ }
  const unique = new Map();
  for (const event of events) {
    if (!['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Notification', 'Interrupt'].includes(event?.eventName)) continue;
    if (!Number.isFinite(event.updatedAt) || !Number.isInteger(event.pid) || event.pid <= 0
      || !Number.isInteger(event.pidStartTicks) || event.pidStartTicks <= 0) continue;
    const sequence = Number.isInteger(event.sequence) && event.sequence > 0 ? event.sequence : 0;
    const bootTicks = Number(event.bootTicks);
    const normalized = { eventName: event.eventName, updatedAt: Math.floor(event.updatedAt), sequence, pid: event.pid, pidStartTicks: event.pidStartTicks,
      bootTicks: Number.isInteger(bootTicks) && bootTicks > 0 ? bootTicks : 0,
      toolUseId: typeof event.toolUseId === 'string' ? event.toolUseId : null,
      accepted: event.accepted !== false,
      toolName: typeof event.toolName === 'string' ? event.toolName : null,
      toolCommandHash: typeof event.toolCommandHash === 'string' && /^[a-f0-9]{64}$/.test(event.toolCommandHash) ? event.toolCommandHash : null };
    unique.set(`${normalized.pid}:${normalized.pidStartTicks}:${normalized.sequence}:${normalized.eventName}:${normalized.toolUseId || ''}`, normalized);
  }
  const normalizedEvents = [...unique.values()];
  cacheSet(cacheKey, { size: stat.size, mtimeMs: stat.mtimeMs, checkpointMtimeMs, events: normalizedEvents });
  return normalizedEvents;
}

function hookTurnEvidence(events, pane, observedAt, observedBootTicks = 0) {
  const owner = new Set((pane.processes || []).map((process) => `${process.pid}\0${process.startTicks}`));
  // Wall time is ranking data.  Hook sequence and Linux boot ticks are causal
  // data.  After a wall-clock rollback a newly written prompt can have a wall
  // timestamp in the future, yet it still belongs to the live owner.  Admit
  // only a fresh monotonic *start* this way.  A future terminal must never
  // close a current turn.
  const monotonicStart = (event) => {
    if (!['UserPromptSubmit', 'PreToolUse'].includes(event.eventName)
      || !Number.isInteger(event.bootTicks) || event.bootTicks <= 0
      || !Number.isInteger(observedBootTicks) || observedBootTicks < event.bootTicks) return false;
    if (!clockTicks) {
      try { clockTicks = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()); } catch { return false; }
    }
    return Number.isFinite(clockTicks) && clockTicks > 0
      && ((observedBootTicks - event.bootTicks) * 1000) / clockTicks <= CLAIM_MAX_AGE_MS;
  };
  const matched = events.filter((event) => event.accepted !== false
    && owner.has(`${event.pid}\0${event.pidStartTicks}`)
    && (currentTimestamp(event.updatedAt, observedAt) || monotonicStart(event)));
  const compare = (left, right) => {
    // The serialized sequence is the causal order.  Legacy unsequenced rows
    // are ordered by wall time only among themselves.
    if (left.sequence && right.sequence) return left.sequence - right.sequence;
    if (left.sequence !== right.sequence) return left.sequence ? -1 : 1;
    return left.updatedAt - right.updatedAt;
  };
  const byOwner = new Map();
  for (const event of matched) {
    const key = `${event.pid}\0${event.pidStartTicks}`;
    if (!byOwner.has(key)) byOwner.set(key, []);
    byOwner.get(key).push(event);
  }
  const summaries = [...byOwner.entries()].map(([ownerKey, items]) => {
    items.sort(compare);
    let userStart = null; const pre = new Map(); const completed = new Set(); let stop = null; let last = null;
    for (const event of items) {
      last = event;
      if (['Stop', 'Notification', 'Interrupt'].includes(event.eventName)) { stop = event; pre.clear(); continue; }
      if (event.eventName === 'UserPromptSubmit') { userStart = event; pre.clear(); completed.clear(); }
      if (event.eventName === 'PreToolUse') {
        const tool = event.toolUseId || `unknown:${event.sequence || event.updatedAt}`;
        if (!completed.has(tool)) pre.set(tool, event);
      }
      if (event.eventName === 'PostToolUse' && event.toolUseId) { pre.delete(event.toolUseId); completed.add(event.toolUseId); }
    }
    const latestPre = [...pre.values()].sort(compare).at(-1) || null;
    const latestStart = [userStart, latestPre].filter(Boolean).sort(compare).at(-1) || null;
    const unclosed = Boolean(latestStart) && (!stop || compare(latestStart, stop) > 0);
    const [pid, startTicks] = ownerKey.split('\0').map(Number);
    const liveTools = [...pre.values()]
      .filter((event) => event.toolName === 'Bash' && event.toolCommandHash && (!stop || compare(event, stop) > 0))
      .map((event) => ({ toolUseId: event.toolUseId, bootTicks: event.bootTicks, commandHash: event.toolCommandHash }));
    // Never publish a future wall time.  The causal event above may be valid
    // by boot ticks while its wall clock is ahead of this observer.
    return { pid, startTicks, lastStart: currentTimestamp(latestStart?.updatedAt, observedAt), lastStartBootTicks: latestStart?.bootTicks || 0, lastStop: currentTimestamp(stop?.updatedAt, observedAt), lastEvent: currentTimestamp(last?.updatedAt, observedAt),
      unclosed, activityAt: currentTimestamp(latestStart?.updatedAt, observedAt),
      liveTools: unclosed ? liveTools : [] };
  });
  const aggregate = summaries.reduce((out, value) => ({
    lastStart: Math.max(out.lastStart, value.lastStart), lastStartBootTicks: Math.max(out.lastStartBootTicks, value.lastStartBootTicks), lastStop: Math.max(out.lastStop, value.lastStop), lastEvent: Math.max(out.lastEvent, value.lastEvent),
    unclosed: out.unclosed || value.unclosed, activityAt: Math.max(out.activityAt, value.activityAt),
  }), { lastStart: 0, lastStartBootTicks: 0, lastStop: 0, lastEvent: 0, unclosed: false, activityAt: 0 });
  return { ...aggregate, owners: summaries };
}

function readResponseStatus(session, pane, statusDir) {
  const file = path.join(statusDir, session, `${pane}.response.json`);
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Number.isFinite(value.lastResponseAt) || value.lastResponseAt <= 0) return null;
    return {
      lastResponseAt: Math.floor(value.lastResponseAt),
      pid: Number.isInteger(value.pid) && value.pid > 0 ? value.pid : null,
      pidStartTicks: Number.isInteger(value.pidStartTicks) && value.pidStartTicks > 0 ? value.pidStartTicks : null,
      transcriptPath: typeof value.transcriptPath === 'string' ? value.transcriptPath : null,
    };
  } catch {
    return null;
  }
}

function readBackgroundStatus(session, pane, statusDir) {
  const file = path.join(statusDir, session, `${pane}.background.json`);
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Number.isFinite(value.updatedAt) || !Array.isArray(value.candidates)) return null;
    return {
      updatedAt: Math.floor(value.updatedAt),
      candidates: value.candidates.filter((candidate) => Number.isInteger(candidate?.pid) && candidate.pid > 0 && Number.isInteger(candidate?.startTicks) && candidate.startTicks > 0),
      transcriptPath: typeof value.transcriptPath === 'string' ? value.transcriptPath : null,
    };
  } catch {
    return null;
  }
}

function executionBindingFile(session, pane, statusDir) {
  return path.join(statusDir, session, `${pane}.executions.json`);
}

function readExecutionBindings(session, pane, statusDir) {
  try {
    const value = JSON.parse(fs.readFileSync(executionBindingFile(session, pane, statusDir), 'utf8'));
    if (!Array.isArray(value.bindings)) return [];
    return value.bindings.filter((binding) => typeof binding?.toolUseId === 'string'
      && /^[a-f0-9]{64}$/.test(binding.commandHash || '')
      && Number.isInteger(binding.pid) && binding.pid > 0 && Number.isInteger(binding.startTicks) && binding.startTicks > 0
      && Number.isInteger(binding.ownerPid) && binding.ownerPid > 0 && Number.isInteger(binding.ownerStartTicks) && binding.ownerStartTicks > 0);
  } catch { return []; }
}

function writeExecutionBindings(session, pane, statusDir, bindings) {
  const file = executionBindingFile(session, pane, statusDir);
  const temporary = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify({ bindings }), { mode: 0o600 }); fs.renameSync(temporary, file); }
  catch { try { fs.unlinkSync(temporary); } catch { /* no temporary file */ } }
}

function pruneExecutionBindings(session, pane, statusDir, owner, liveTools) {
  const liveIds = new Set(liveTools.map((tool) => tool.toolUseId).filter(Boolean));
  const bindings = readExecutionBindings(session, pane, statusDir);
  const current = bindings.filter((binding) => binding.ownerPid !== owner.pid || binding.ownerStartTicks !== owner.startTicks || liveIds.has(binding.toolUseId));
  if (current.length !== bindings.length) writeExecutionBindings(session, pane, statusDir, current);
}

function executionBindingForTool(session, pane, statusDir, owner, tool, executions, mayBind) {
  if (!tool.toolUseId || !tool.commandHash) return false;
  const bindings = readExecutionBindings(session, pane, statusDir);
  const existing = bindings.find((binding) => binding.toolUseId === tool.toolUseId && binding.commandHash === tool.commandHash
    && binding.ownerPid === owner.pid && binding.ownerStartTicks === owner.startTicks);
  if (existing) return executions.some((execution) => execution.pid === existing.pid && execution.startTicks === existing.startTicks
    && execution.owner?.pid === owner.pid && execution.owner?.startTicks === owner.startTicks && execution.commandHash === tool.commandHash);
  if (!mayBind) return false;
  // Claude starts its shell-snapshot wrapper just before it emits PreToolUse.
  // Permit one second of dispatch skew, but never bind an old same-command
  // wrapper from an earlier turn.
  // A first binding still requires one live execution with the exact command
  // digest under this Claude PID/start identity. Future ticks only accept the
  // pinned PID/start pair above.
  let lowerBound = tool.bootTicks;
  if (lowerBound > 0) {
    if (!clockTicks) {
      try { clockTicks = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()); } catch { clockTicks = 0; }
    }
    if (clockTicks > 0) lowerBound = Math.max(0, lowerBound - Math.ceil((EXECUTION_PRE_HOOK_SKEW_MS * clockTicks) / 1000));
  }
  const candidates = executions.filter((execution) => execution.owner?.pid === owner.pid && execution.owner?.startTicks === owner.startTicks
    && execution.commandHash === tool.commandHash && (!lowerBound || execution.startTicks >= lowerBound));
  if (candidates.length !== 1) return false;
  writeExecutionBindings(session, pane, statusDir, [...bindings.filter((binding) => binding.toolUseId !== tool.toolUseId), {
    toolUseId: tool.toolUseId, commandHash: tool.commandHash, pid: candidates[0].pid, startTicks: candidates[0].startTicks,
    ownerPid: owner.pid, ownerStartTicks: owner.startTicks,
  }]);
  return true;
}

function projectKey(cwd) {
  return String(cwd || '').replaceAll('/', '-');
}

function resumeSid(command) {
  for (let index = 0; index < command.length - 1; index += 1) {
    if (command[index] === '--resume' || command[index] === '--session-id') return command[index + 1];
  }
  return null;
}

function transcriptForPane(pane, status, options) {
  if (status?.transcriptPath && fs.existsSync(status.transcriptPath)) return status.transcriptPath;
  const projectsDir = options.projectsDir || config.projectsDir;
  const cwd = pane.cwd;
  const commands = pane.commands || (pane.command ? [pane.command] : []);
  for (let index = commands.length - 1; index >= 0; index -= 1) {
    const explicit = resumeSid(commands[index]);
    if (!explicit) continue;
    if (path.isAbsolute(explicit) && explicit.endsWith('.jsonl') && fs.existsSync(explicit)) return explicit;
    if (cwd) {
      const file = path.join(projectsDir, projectKey(cwd), `${explicit}.jsonl`);
      if (fs.existsSync(file)) return file;
    }
  }
  if (!cwd) return null;
  const nativeDir = path.join(options.claudeConfigDir || config.claudeConfigDir, 'sessions');
  for (const process of pane.processes || []) {
    try {
      const native = JSON.parse(fs.readFileSync(path.join(nativeDir, `${process.pid}.json`), 'utf8'));
      if (native.pid !== process.pid || String(native.procStart) !== String(process.startTicks)
        || native.cwd !== cwd || typeof native.sessionId !== 'string') continue;
      const file = path.join(projectsDir, projectKey(cwd), `${native.sessionId}.jsonl`);
      if (fs.existsSync(file)) return file;
    } catch { /* no matching native session record */ }
  }
  return null;
}

function transcriptTimestamps(file, observedAt = Date.now()) {
  let stat;
  try { stat = fs.statSync(file); } catch { return { assistantAt: 0, activityAt: 0, activitySignature: '', activityKind: '', turnStartAt: 0, terminalAt: 0, terminalAfterTurnStart: false }; }
  const cached = cacheGet(file);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return validatedTranscriptTimestamps(cached, observedAt);

  let assistantAt = 0;
  let activityAt = 0;
  let activitySignature = '';
  let activityKind = '';
  let turnStartAt = 0;
  let terminalAt = 0;
  let terminalAfterTurnStart = false;
  let fd;
  const consume = (line) => {
    try {
      const record = JSON.parse(line);
      const at = currentTimestamp(Date.parse(record.timestamp), observedAt);
      if (!at) return;
      if (isTerminalTranscriptRecord(record) && !terminalAt) terminalAt = at;
      if (record.type !== 'assistant' && record.type !== 'user') return;
      if (record.type === 'user' && record.isMeta) return;
      if (record.type === 'assistant' && record.message?.model === '<synthetic>') return;
      const toolStart = record.type === 'assistant' && Array.isArray(record.message?.content)
        && record.message.content.some((block) => block?.type === 'tool_use');
      const humanStart = isHumanUserRecord(record);
      if (humanStart || toolStart) {
        if (!turnStartAt) { turnStartAt = at; terminalAfterTurnStart = Boolean(terminalAt); }
      }
      if (!activityAt) {
        activityAt = at;
        // Retaining full JSONL rows made the process cache unbounded.  This
        // compact signature is only used to detect a changed semantic record.
        activitySignature = createHash('sha256').update(line).digest('base64url');
        activityKind = record.type === 'user' ? (humanStart ? 'user' : 'toolResult') : (toolStart ? 'toolStart' : 'assistant');
      }
      if (!assistantAt && record.type === 'assistant') assistantAt = at;
    } catch { /* incomplete concurrent record */ }
  };
  try {
    fd = fs.openSync(file, 'r');
    let position = stat.size;
    // Reverse scan without repeatedly concatenating a long JSONL row.  The
    // unfinished row is a list of chunks and is joined exactly once when its
    // newline arrives, so an oversized valid row remains linear work.
    let carryChunks = [];
    const chunkSize = TRANSCRIPT_READ_CHUNK_BYTES;
    while (position > 0 && (!assistantAt || !activityAt || !turnStartAt)) {
      const size = Math.min(chunkSize, position);
      position -= size;
      const buffer = Buffer.allocUnsafe(size);
      fs.readSync(fd, buffer, 0, size, position);
      const breaks = [];
      for (let offset = 0; offset < buffer.length; offset += 1) if (buffer[offset] === 10) breaks.push(offset);
      if (!breaks.length) { carryChunks.unshift(buffer); continue; }
      const last = breaks.at(-1);
      consume(Buffer.concat([buffer.subarray(last + 1), ...carryChunks]).toString('utf8'));
      for (let index = breaks.length - 1; index > 0; index -= 1) {
        consume(buffer.subarray(breaks[index - 1] + 1, breaks[index]).toString('utf8'));
      }
      carryChunks = [buffer.subarray(0, breaks[0])];
    }
    if (position === 0 && carryChunks.length) consume(Buffer.concat(carryChunks).toString('utf8'));
  } catch {
    assistantAt = 0;
    activityAt = 0;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already closed */ }
  }
  const value = { size: stat.size, mtimeMs: stat.mtimeMs, assistantAt, activityAt, activitySignature, activityKind, turnStartAt, terminalAt, terminalAfterTurnStart };
  cacheSet(file, value);
  return validatedTranscriptTimestamps(value, observedAt);
}

function validatedTranscriptTimestamps(value, observedAt) {
  const assistantAt = currentTimestamp(value.assistantAt, observedAt);
  const activityAt = currentTimestamp(value.activityAt, observedAt);
  const turnStartAt = currentTimestamp(value.turnStartAt, observedAt);
  const terminalAt = currentTimestamp(value.terminalAt, observedAt);
  return {
    ...value,
    assistantAt,
    activityAt,
    turnStartAt,
    terminalAt,
    terminalAfterTurnStart: Boolean(value.terminalAfterTurnStart && terminalAt && turnStartAt),
  };
}

// Growth is an observation, rather than a file timestamp claim.  Keeping the
// lease per pane means one session cannot borrow another session's transcript
// activity, even during the short interval between two polling ticks.
function transcriptGrowthLease(paneKey, evidence, now) {
  const cacheKey = `growth:${paneKey}`;
  const previous = transcriptCache.get(cacheKey);
  const monotonicNow = performance.now();
  const freshSemanticEvent = evidence.activityAt > 0 && evidence.activityAt <= now
    && now - evidence.activityAt <= CLAIM_MAX_AGE_MS;
  const semanticChanged = previous && (previous.activityAt !== evidence.activityAt
    || previous.activitySignature !== evidence.activitySignature);
  const leaseUntilMono = semanticChanged && freshSemanticEvent ? monotonicNow + CLAIM_MAX_AGE_MS : (previous?.leaseUntilMono || 0);
  cacheSet(cacheKey, { activityAt: evidence.activityAt, activitySignature: evidence.activitySignature, leaseUntilMono });
  return freshSemanticEvent && leaseUntilMono > monotonicNow;
}

const INTERRUPT_MARKERS = new Set([
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
]);

function isUserRecord(record) {
  return record?.type === 'user' && record?.message?.role === 'user';
}

function isHumanUserRecord(record) {
  if (!isUserRecord(record) || record.isMeta) return false;
  const content = record.message.content;
  return typeof content === 'string' || (Array.isArray(content) && !content.some((block) => block?.type === 'tool_result'));
}

function canonicalUserInterrupt(record) {
  if (!isUserRecord(record)) return false;
  const content = record.message.content;
  if (typeof content === 'string') return INTERRUPT_MARKERS.has(content.trim());
  return Array.isArray(content) && content.some((block) => (
    block?.type === 'text' && typeof block.text === 'string' && INTERRUPT_MARKERS.has(block.text.trim())
  ));
}

function structuredAssistantRefusal(record) {
  return record?.type === 'assistant' && record?.message?.role === 'assistant'
    && Array.isArray(record.message.content)
    && record.message.content.some((block) => block?.type === 'refusal');
}

function transcriptTerminalMarker(file, observedAt) {
  const evidence = transcriptTimestamps(file, observedAt);
  return evidence.terminalAfterTurnStart ? (evidence.terminalAt || 0) : 0;
}

function isTerminalTranscriptRecord(record) {
  return record?.toolUseResult?.interrupted === true
    || record?.message?.error === 'invalid_request'
    || record?.error === 'invalid_request'
    || canonicalUserInterrupt(record)
    || record?.type === 'system' && (record?.subtype === 'stop_hook_summary' || record?.subtype === 'turn_duration')
    || record?.type === 'assistant' && record?.message?.role === 'assistant'
      && (record.message.stop_reason === 'end_turn' || record.message.stop_reason === 'refusal')
    || structuredAssistantRefusal(record);
}

export function hiddenSessionActivity({ workdir, resumeSid, projectsDir = config.projectsDir }) {
  if (!workdir || !resumeSid) return { lastResponseAt: 0, lastActivityAt: 0 };
  const timestamps = transcriptTimestamps(path.join(projectsDir, projectKey(workdir), `${resumeSid}.jsonl`));
  return { lastResponseAt: timestamps.assistantAt, lastActivityAt: timestamps.activityAt };
}

function lastResponseForPane(session, pane, status, transcriptPath, allowTranscript, options) {
  const response = readResponseStatus(session, pane.pane, options.statusDir || config.statusDir);
  if (response && response.lastResponseAt <= options.observedAt) {
    const ownerMatches = response.pid && response.pidStartTicks
      && pane.processes?.some((process) => process.pid === response.pid && process.startTicks === response.pidStartTicks);
    if (ownerMatches && allowTranscript && response.transcriptPath && transcriptPath && response.transcriptPath === transcriptPath) return response.lastResponseAt;
    // Old response files lacked an owner nonce.  They remain ranking evidence
    // only when a uniquely owned resolved transcript proves the same source.
    if (!response.pid && !response.pidStartTicks && allowTranscript
      && response.transcriptPath && transcriptPath && response.transcriptPath === transcriptPath) return response.lastResponseAt;
  }
  return allowTranscript && transcriptPath ? currentTimestamp(transcriptTimestamps(transcriptPath, options.observedAt).assistantAt, options.observedAt) : 0;
}

export function aggregateSessionActivity(sessionNames, livePanes, options = {}) {
  const statusDir = options.statusDir || config.statusDir;
  const backgroundPanes = options.backgroundPanes || new Map();
  const observedAt = Number(options.now) || Date.now();
  const result = {};
  const statesBySession = new Map();
  const transcriptSessions = new Map();
  const currentEventAt = (value) => Number.isFinite(value) && value > 0 && value <= observedAt ? Math.floor(value) : 0;
  for (const name of sessionNames) {
    const panes = [...livePanes.values()].filter((pane) => pane.session === name);
    if (!panes.length) {
      result[name] = { state: 'absent', updatedAt: 0, lastResponseAt: 0, lastActivityAt: 0 };
      Object.defineProperty(result[name], 'descendantTaskCount', { value: 0 });
      continue;
    }
    const states = panes.map((pane) => {
      const hookSession = pane.hookSession || name;
      const raw = readPaneStatus(hookSession, pane.pane, statusDir);
      const rawMatches = raw && raw.pidStartTicks && pane.processes?.some((process) => process.pid === raw.pid && process.startTicks === raw.pidStartTicks);
      // A matching hook remains a real historical event after its 90-second
      // claim lease expires.  Recent ordering uses that event timestamp.  Its
      // freshness is considered separately when assigning the light.
      const status = raw
        && raw.pidStartTicks
        && observedAt >= raw.updatedAt
        && rawMatches
        ? raw
        : null;
      const transcriptPath = transcriptForPane(pane, status, options);
      const processBackground = backgroundPanes.get(`${name}\0${pane.pane}`);
      if (transcriptPath) {
        if (!transcriptSessions.has(transcriptPath)) transcriptSessions.set(transcriptPath, new Set());
        transcriptSessions.get(transcriptPath).add(`${name}\0${pane.pane}\0${(pane.processes || []).map((process) => `${process.pid}:${process.startTicks}`).sort().join(',')}`);
      }
      const transcriptId = transcriptPath ? path.basename(transcriptPath, '.jsonl') : null;
      const hasBackgroundProcess = Boolean(processBackground)
        && (!transcriptId || processBackground.sessionIds?.includes(transcriptId));
      const recorded = readBackgroundStatus(hookSession, pane.pane, statusDir);
      const recordedCandidate = hasBackgroundProcess && recorded?.candidates.some((candidate) => processBackground.processes?.some((process) => process.pid === candidate.pid && process.startTicks === candidate.startTicks));
      const hook = hookTurnEvidence(readPaneEvents(hookSession, pane.pane, statusDir), pane, observedAt, options.observedBootTicks || 0);
      for (const owner of hook.owners) pruneExecutionBindings(hookSession, pane.pane, statusDir, owner, owner.liveTools);
      return { pane, status, transcriptPath, processBackground, hasBackgroundProcess, recordedCandidate, recorded, hook };
    });
    statesBySession.set(name, states);
  }

  for (const [name, states] of statesBySession) {
    const descendantTaskCount = states.reduce((count, state) => count + Math.max(
      state.processBackground?.pids?.length || 0
    ), 0);
    const lastResponseAt = Math.max(0, ...states.map(({ pane, status, transcriptPath }) => {
      const uniqueTranscript = Boolean(transcriptPath) && pane.processes?.length === 1 && transcriptSessions.get(transcriptPath)?.size === 1;
      return lastResponseForPane(pane.hookSession || name, pane, status, transcriptPath, uniqueTranscript, { ...options, statusDir, observedAt });
    }));
    const lastActivityAt = Math.max(lastResponseAt, ...states.map(({ pane, status, transcriptPath, processBackground, hasBackgroundProcess, hook }) => {
      const hookAt = Math.max(status?.updatedAt || 0, hook.lastEvent || 0);
      const transcriptAt = transcriptPath && pane.processes?.length === 1 && transcriptSessions.get(transcriptPath)?.size === 1
        ? currentEventAt(transcriptTimestamps(transcriptPath, observedAt).activityAt)
        : 0;
      const backgroundAt = hasBackgroundProcess
        ? Math.max(currentEventAt(processBackground?.activityAt), currentEventAt(processBackground?.startedAt))
        : 0;
      return Math.max(hookAt, transcriptAt, backgroundAt);
    }));
    const busy = states.filter(({ pane, status, transcriptPath, hook, processBackground }) => {
      const uniqueTranscript = Boolean(transcriptPath) && pane.processes?.length === 1 && transcriptSessions.get(transcriptPath)?.size === 1;
      const transcriptMarkerAt = uniqueTranscript ? transcriptTerminalMarker(transcriptPath, observedAt) : 0;
      const markerAt = transcriptMarkerAt;
      const transcriptEvidence = uniqueTranscript ? transcriptTimestamps(transcriptPath, observedAt) : null;
      const terminalAt = transcriptEvidence?.terminalAt || 0;
      const transcriptAt = transcriptEvidence?.activityAt || 0;
      const ownerBusy = hook.owners.some((owner) => {
        // A hook can establish the prompt while its transcript has only the
        // later interrupt or API-error row.  That terminal is still current
        // when its validated timestamp follows the hook's causal start.
        const ownerMarkerAt = markerAt || (!transcriptEvidence?.turnStartAt && terminalAt && owner.lastStart <= terminalAt ? terminalAt : 0);
        if (!owner.unclosed || (ownerMarkerAt && owner.lastStart <= ownerMarkerAt)) return false;
        const monotonicAge = options.observedBootTicks > 0 && owner.lastStartBootTicks > 0 && clockTicks > 0
          ? ((options.observedBootTicks - owner.lastStartBootTicks) * 1000) / clockTicks
          : null;
        const fresh = (monotonicAge !== null && monotonicAge >= 0 && monotonicAge <= CLAIM_MAX_AGE_MS)
          || (monotonicAge === null && observedAt - owner.activityAt <= CLAIM_MAX_AGE_MS);
        if (fresh) {
          for (const tool of owner.liveTools) executionBindingForTool(
            pane.hookSession || name, pane.pane, statusDir, owner, tool,
            processBackground?.processes || [], true
          );
          return true;
        }
        // A shell-snapshot process is the actual Bash execution wrapper.  Its
        // own lifetime is evidence for one outstanding PreToolUse.  A generic
        // child or a persistent broker cannot renew this claim.
        return owner.liveTools.some((tool) => executionBindingForTool(
          pane.hookSession || name, pane.pane, statusDir, owner, tool,
          processBackground?.processes || [], false
        ));
      });
      // Sample growth on every tick, including while a busy hook wins.  A later
      // expired hook can then fall back to a correctly established lease.
      const paneIdentity = (pane.processes || []).map((process) => `${process.pid}:${process.startTicks}`).sort().join(',');
      const growing = uniqueTranscript && transcriptGrowthLease(`${paneIdentity}\0${transcriptPath}`, transcriptEvidence, observedAt);
      if (ownerBusy) return true;
      // A typed Stop or Notification closes this owner. Transcript writes from
      // delayed PostToolUse or another shared owner cannot reopen it.
      const turnBoundary = Math.max(hook.lastStop, markerAt);
      const semanticStart = growing && hook.owners.length <= 1 && transcriptEvidence?.turnStartAt > turnBoundary
        && transcriptAt >= transcriptEvidence.turnStartAt;
      if (hook.lastStop && !hook.unclosed) return semanticStart;
      // The first observation establishes a baseline.  A later changed file
      // earns a bounded lease.  Terminal markers and Stop records win unless a
      // later prompt or tool record re-arms the pane.
      return growing && transcriptEvidence?.turnStartAt > markerAt;
    });
    if (busy.length) {
      result[name] = {
        state: 'busy',
        updatedAt: Math.max(...busy.map(({ pane, status, transcriptPath, hook }) => Math.max(
          status?.updatedAt || 0, hook.activityAt || 0,
          transcriptPath && pane.processes?.length === 1 && transcriptSessions.get(transcriptPath)?.size === 1 ? currentEventAt(transcriptTimestamps(transcriptPath, observedAt).activityAt) : 0,
        ))),
        lastResponseAt,
        lastActivityAt,
      };
      Object.defineProperty(result[name], 'descendantTaskCount', { value: descendantTaskCount });
      continue;
    }
    // A running shell snapshot with the matching Claude conversation identity
    // is current evidence in its own right.  Candidate files strengthen that
    // identity but never create the state when the process is gone.
    const background = states.filter(({ hasBackgroundProcess }) => hasBackgroundProcess);
    if (background.length) {
      const backgroundActivityAt = Math.max(...background.map(({ processBackground, recorded, recordedCandidate, pane }) => {
        const processAt = Math.max(currentEventAt(processBackground?.activityAt), currentEventAt(processBackground?.startedAt));
        const candidateAt = recordedCandidate && recorded.updatedAt >= (pane.startedAt || 0)
          ? currentEventAt(recorded.updatedAt)
          : 0;
        return Math.max(processAt, candidateAt);
      }));
      result[name] = {
        state: 'background',
        updatedAt: backgroundActivityAt,
        lastResponseAt,
        lastActivityAt: Math.max(lastActivityAt, backgroundActivityAt),
      };
      Object.defineProperty(result[name], 'descendantTaskCount', { value: descendantTaskCount });
      continue;
    }
    result[name] = {
      state: 'idle',
      updatedAt: Math.max(...states.map(({ pane, status, hook }) => Math.max(status?.updatedAt || 0, hook.lastEvent || 0, pane.startedAt || 0))),
      lastResponseAt,
      lastActivityAt,
    };
    Object.defineProperty(result[name], 'descendantTaskCount', { value: descendantTaskCount });
  }
  return result;
}

export async function collectSessionActivity(sessionNames, options = {}) {
  const snapshot = options.snapshot || await readProcessSnapshot(options.procRoot || '/proc', options.controllerSessions ?? null);
  return aggregateSessionActivity(sessionNames, snapshot.claudePanes, {
    ...options,
    backgroundPanes: snapshot.backgroundPanes,
    observedBootTicks: snapshot.observedBootTicks,
  });
}
