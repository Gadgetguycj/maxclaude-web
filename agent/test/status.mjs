import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
const statusModule = process.env.STATUS_MODULE || new URL('../src/status.js', import.meta.url).href;
const { aggregateSessionActivity, collectSessionActivity, processDescendsFrom, readLiveBackgroundPanes, readLiveClaudePanes, readSessionProcessSnapshot } = await import(statusModule);
import { hibernateEligibility, isActiveMaxclaudeUnit, isZellijClientCommand, isZellijServerCommand, parseCreatedAt, parseZellijClientCommand, wakeCommandMatches, wakeStartPlan } from '../src/sessions.js';

const now = Date.UTC(2026, 8, 24, 12, 0, 0);

// `/proc` can list a PID whose directory disappears before metadata lookup.
// The inventory reads names only, then treats that ENOENT as an exited process.
// This guard fails if a future change asks Node for Dirent metadata, because
// Node then performs the racy lstat before status.js can classify the exit.
if (!process.env.STATUS_SKIP_PROC_ENUM) {
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'mcw-proc-enumeration-'));
  fs.writeFileSync(path.join(proc, 'stat'), 'btime 1\n');
  fs.writeFileSync(path.join(proc, 'uptime'), '100.00 0.00\n');
  fs.mkdirSync(path.join(proc, '293947'));
  const original = fs.readdirSync;
  fs.readdirSync = function guardedReaddir(target, options) {
    if (target === proc && options?.withFileTypes) {
      const error = new Error(`ENOENT lstat '${path.join(proc, '293947')}'`); error.code = 'ENOENT'; throw error;
    }
    return original.call(this, target, options);
  };
  try {
    assert.equal((await readSessionProcessSnapshot(proc, [])).claudePanes.size, 0);
  } finally {
    fs.readdirSync = original;
    fs.rmSync(proc, { recursive: true, force: true });
  }
}

assert.equal(parseCreatedAt('Created 1day 2h 3m 4s ago', now), now - 93784000);
assert.equal(parseCreatedAt('Created 10days 3h 2m 41s ago', now), now - 874961000);
assert.equal(parseCreatedAt('Created 0s ago', now), now);
assert.equal(parseCreatedAt('unparseable', now), 0);

const hibernateBase = {
  name: 'idle-session', sleeping: false, current: false, operatorActive: false,
  resumable: true, activity: 'idle', descendantTaskCount: 0, viewers: 0,
  lastActivityAt: now - (48 * 60 * 60 * 1000), conversationCount: 1,
};
assert.equal(hibernateEligibility(hibernateBase).eligible, true);
assert.equal(hibernateEligibility({ ...hibernateBase, conversationCount: 0 }).reason, 'no live Claude conversation id is available to preserve');
assert.equal(hibernateEligibility({ ...hibernateBase, viewers: 1 }).reason, 'browser client is viewing it');
assert.equal(hibernateEligibility({ ...hibernateBase, descendantTaskCount: 1 }).reason, 'live descendant task process');
assert.equal(hibernateEligibility({ ...hibernateBase, operatorActive: true }).reason, 'operator is working in this session');
assert.equal(hibernateEligibility({ ...hibernateBase, conversationCount: 2 }).reason, 'multiple live Claude conversations cannot be resumed safely');
assert.equal(wakeCommandMatches('wake-test', '11111111-1111-1111-1111-111111111111', new Map([
  ['wake-test\0' + '0', { session: 'wake-test', commands: [['claude', '--remote-control=wake-test', '--resume', '11111111-1111-1111-1111-111111111111']] }],
])), true);
assert.equal(wakeCommandMatches('wake-test', '11111111-1111-1111-1111-111111111111', new Map([
  ['wake-test\0' + '0', { session: 'wake-test', commands: [['claude', '--remote-control=wrong-name', '--resume', '11111111-1111-1111-1111-111111111111']] }],
])), false);
const knownSessions = ['first', 'second'];
assert.deepEqual(parseZellijClientCommand(['zellij', 'attach', 'first'], '', knownSessions), { names: ['first'], ambiguous: false });
assert.deepEqual(parseZellijClientCommand(['zellij', 'watch', 'second'], '', knownSessions), { names: ['second'], ambiguous: false });
assert.deepEqual(parseZellijClientCommand(['zellij', 'a', '--create', 'second'], '', knownSessions), { names: ['second'], ambiguous: false });
assert.deepEqual(parseZellijClientCommand(['zellij', 'attach', '--index', '1'], '', knownSessions), { names: [], ambiguous: true });
assert.deepEqual(parseZellijClientCommand(['zellij', 'w', '--token', 'secret'], '', knownSessions), { names: [], ambiguous: true });
assert.deepEqual(parseZellijClientCommand(['zellij', 'attach'], 'first', knownSessions), { names: ['first'], ambiguous: false });
assert.equal(isZellijServerCommand(['zellij', '--server', '/run/user/1000/zellij/contract/session']), true);
assert.equal(isZellijServerCommand(['zellij', 'attach', 'first']), false);
assert.equal(isZellijClientCommand(['zellij', 'web', '-d']), false);
assert.equal(isZellijClientCommand(['zellij', 'attach', 'first']), true);
assert.equal(isActiveMaxclaudeUnit('loaded\ninactive\n'), false);
assert.equal(isActiveMaxclaudeUnit('loaded\nactive\n'), true);
const wakePlan = wakeStartPlan('wake-test', { MAXAGENT_UNIT: 'maxclaude-named@wake\\x2dtest.service' }, 'wake\\x2dtest');
assert.deepEqual(wakePlan, { command: 'systemctl', args: ['--user', 'start', 'maxclaude-named@wake\\x2dtest.service'], unit: 'maxclaude-named@wake\\x2dtest.service' });
assert.equal(JSON.stringify(wakePlan).includes('unhide'), false);
assert.equal(JSON.stringify(wakePlan).includes('attach'), false);
assert.throws(() => wakeStartPlan('wake-test', {}, 'wake\\x2dtest'), /does not record the expected maxclaude unit/);
assert.throws(() => wakeStartPlan('wake-test', { MAXAGENT_UNIT: 'maxclaude-named@other.service' }, 'wake\\x2dtest'), /does not record the expected maxclaude unit/);
const detachedActivity = aggregateSessionActivity(['detached-test'], new Map([
  ['detached-test\0' + '0', { session: 'detached-test', pane: '0', startedAt: 1, pids: [1], processes: [{ pid: 1, startTicks: 1 }] }],
]), { statusDir: '/nonexistent', detachedSessions: new Map([['detached-test', { pids: [44], startedAt: 999 }]]) });
assert.equal(detachedActivity['detached-test'].state, 'idle');
assert.equal(detachedActivity['detached-test'].descendantTaskCount, 0);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcw-status-'));
try {
  fs.mkdirSync(path.join(root, 'alpha'), { recursive: true });
  fs.writeFileSync(path.join(root, 'alpha', '0.json'), '{"state":"busy","updatedAt":101,"pid":10,"pidStartTicks":1}\n');
  fs.writeFileSync(path.join(root, 'alpha', '0.events.jsonl'), '{"eventName":"UserPromptSubmit","updatedAt":101,"sequence":1,"pid":10,"pidStartTicks":1}\n');
  fs.writeFileSync(path.join(root, 'alpha', '1.json'), '{"state":"idle","updatedAt":102,"pid":11,"pidStartTicks":1}\n');
  fs.mkdirSync(path.join(root, 'beta'), { recursive: true });
  fs.writeFileSync(path.join(root, 'beta', '0.json'), '{"state":"idle","updatedAt":103,"pid":12,"pidStartTicks":1}\n');
  const panes = new Map([
    ['alpha\0' + '0', { session: 'alpha', pane: '0', startedAt: 10, pids: [10], processes: [{ pid: 10, startTicks: 1 }] }],
    ['alpha\0' + '1', { session: 'alpha', pane: '1', startedAt: 11, pids: [11], processes: [{ pid: 11, startTicks: 1 }] }],
    ['beta\0' + '0', { session: 'beta', pane: '0', startedAt: 12, pids: [12], processes: [{ pid: 12, startTicks: 1 }] }],
  ]);
  const options = { statusDir: root, sessionEnvDir: path.join(root, 'session-env'), projectsDir: path.join(root, 'projects'), now: 104 };
  assert.deepEqual(aggregateSessionActivity(['alpha', 'beta', 'gone'], panes, options), {
    alpha: { state: 'busy', updatedAt: 101, lastResponseAt: 0, lastActivityAt: 102 },
    beta: { state: 'idle', updatedAt: 103, lastResponseAt: 0, lastActivityAt: 103 },
    gone: { state: 'absent', updatedAt: 0, lastResponseAt: 0, lastActivityAt: 0 },
  });
  fs.mkdirSync(path.join(root, 'stale'), { recursive: true });
  fs.writeFileSync(path.join(root, 'stale', '0.json'), '{"state":"busy","updatedAt":9,"pid":99}\n');
  const stalePanes = new Map([
    ['stale\0' + '0', { session: 'stale', pane: '0', startedAt: 10, pids: [42] }],
  ]);
  assert.deepEqual(aggregateSessionActivity(['stale'], stalePanes, options), {
    stale: { state: 'idle', updatedAt: 10, lastResponseAt: 0, lastActivityAt: 0 },
  });
  fs.mkdirSync(path.join(root, 'same-second'), { recursive: true });
  fs.writeFileSync(path.join(root, 'same-second', '0.json'), '{"state":"idle","updatedAt":1000}\n');
  const sameSecondPane = new Map([
    ['same-second\0' + '0', { session: 'same-second', pane: '0', startedAt: 1001, pids: [44] }],
  ]);
  assert.deepEqual(aggregateSessionActivity(['same-second'], sameSecondPane, options), {
    'same-second': { state: 'idle', updatedAt: 1001, lastResponseAt: 0, lastActivityAt: 0 },
  });
  fs.writeFileSync(path.join(root, 'same-second', '0.json'), '{"state":"idle","updatedAt":1002}\n');
  assert.deepEqual(aggregateSessionActivity(['same-second'], sameSecondPane, options), {
    'same-second': { state: 'idle', updatedAt: 1001, lastResponseAt: 0, lastActivityAt: 0 },
  });
  const proc = path.join(root, 'proc');
  fs.mkdirSync(proc, { recursive: true });
  fs.writeFileSync(path.join(proc, 'stat'), 'btime 1000\n');
  fs.mkdirSync(path.join(proc, '42'), { recursive: true });
  fs.writeFileSync(path.join(proc, '42', 'stat'), '42 (claude) S 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 100 1');
  fs.writeFileSync(path.join(proc, '42', 'environ'), Buffer.from('ZELLIJ_SESSION_NAME=without-pane\0'));
  fs.writeFileSync(path.join(proc, '42', 'cmdline'), Buffer.from('claude\0--resume\0'));
  fs.mkdirSync(path.join(proc, '43'), { recursive: true });
  fs.writeFileSync(path.join(proc, '43', 'stat'), '43 (claude) S 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 101 1');
  fs.writeFileSync(path.join(proc, '43', 'environ'), Buffer.from('ZELLIJ_SESSION_NAME=without-pane\0'));
  fs.writeFileSync(path.join(proc, '43', 'cmdline'), Buffer.from('claude\0bg-pty-host\0--bg-spare\0'));
  const discovered = await readLiveClaudePanes(proc);
  assert.equal(discovered.has('without-pane\0pid-42'), false);
  assert.equal(discovered.has('without-pane\0pid-43'), false);
  fs.mkdirSync(path.join(proc, '40'), { recursive: true });
  fs.writeFileSync(path.join(proc, '40', 'stat'), '40 (zellij) S 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 99 1');
  fs.writeFileSync(path.join(proc, '40', 'environ'), Buffer.from('ZELLIJ_SESSION_NAME=background-probe\0'));
  fs.writeFileSync(path.join(proc, '40', 'cmdline'), Buffer.from('zellij\0--server\0'));
  fs.writeFileSync(path.join(proc, '40', 'status'), 'Name:\tzellij\nState:\tS (sleeping)\nPPid:\t1\n');
  fs.mkdirSync(path.join(proc, '44'), { recursive: true });
  fs.writeFileSync(path.join(proc, '44', 'stat'), '44 (bash) S 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 102 1');
  fs.writeFileSync(path.join(proc, '44', 'environ'), Buffer.from('ZELLIJ_SESSION_NAME=background-probe\0ZELLIJ_PANE_ID=0\0CLAUDE_CODE_SESSION_ID=bg-id\0'));
  // Captured C5 wrapper shape. A heredoc leaves no stdin redirect after eval.
  // The command hash must still bind this exact shell PID/start to PreToolUse.
  fs.writeFileSync(path.join(proc, '44', 'cmdline'), Buffer.from("bash\0-c\0source /home/user/.claude/shell-snapshots/snapshot-test.sh 2>/dev/null || true && eval 'python3 - <<'\"'\"'EOF'\"'\"'\nimport hashlib,time\nend=time.monotonic()+125; x=b\"x\"; n=0\nwhile time.monotonic()<end: x=hashlib.sha256(x).digest(); n+=1\nprint(n)\nEOF' && pwd -P >| /tmp/claude-c5-cwd\0"));
  fs.writeFileSync(path.join(proc, '44', 'status'), 'Name:\tbash\nPPid:\t45\n');
  fs.mkdirSync(path.join(proc, '45'), { recursive: true });
  fs.writeFileSync(path.join(proc, '45', 'stat'), '45 (claude) S 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 103 1');
  fs.writeFileSync(path.join(proc, '45', 'environ'), Buffer.from('ZELLIJ_SESSION_NAME=background-probe\0ZELLIJ_PANE_ID=0\0'));
  fs.writeFileSync(path.join(proc, '45', 'cmdline'), Buffer.from('claude\0--resume\0bg-id\0'));
  fs.writeFileSync(path.join(proc, '45', 'status'), 'Name:\tclaude\nPPid:\t40\n');
  fs.mkdirSync(path.join(proc, '44', 'fd'));
  const outputFile = path.join(root, 'background-output.log');
  const outputAt = Date.now() + 1000;
  fs.writeFileSync(outputFile, 'progress\n');
  fs.utimesSync(outputFile, new Date(outputAt), new Date(outputAt));
  fs.symlinkSync(outputFile, path.join(proc, '44', 'fd', '1'));
  const backgroundControllers = [{ session: 'background-probe', pid: 40, startTicks: 99, panes: ['0'] }];
  const backgroundDiscovered = await readLiveBackgroundPanes(proc, backgroundControllers);
  const observedSnapshot = await readSessionProcessSnapshot(proc, backgroundControllers);
  assert.equal(observedSnapshot.claudePanes.get('background-probe\0' + '0')?.processes[0]?.pid, 45);
  assert.equal(backgroundDiscovered.get('background-probe\0' + '0')?.sessionIds[0], 'bg-id');
  assert.deepEqual(backgroundDiscovered.get('background-probe\0' + '0')?.processes[0]?.owner, { pid: 45, startTicks: 103 });
  assert.ok(Math.abs(backgroundDiscovered.get('background-probe\0' + '0')?.activityAt - outputAt) <= 1);

  // A real procfs-shaped foreground shell has Claude -> shell snapshot ->
  // Python.  The live shell-snapshot wrapper is the actual pending Bash
  // execution, so it remains busy past the short hook lease.
  fs.writeFileSync(path.join(proc, 'stat'), `btime ${Math.floor(Date.now() / 1000) - 2}\n`);
  fs.mkdirSync(path.join(proc, '47'), { recursive: true });
  fs.writeFileSync(path.join(proc, '47', 'stat'), '47 (python3) S 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 104 1');
  fs.writeFileSync(path.join(proc, '47', 'environ'), Buffer.from('ZELLIJ_SESSION_NAME=background-probe\0ZELLIJ_PANE_ID=0\0CLAUDE_CODE_SESSION_ID=bg-id\0'));
  fs.writeFileSync(path.join(proc, '47', 'cmdline'), Buffer.from('python3\0-c\0import time; time.sleep(125)\0'));
  fs.writeFileSync(path.join(proc, '47', 'status'), 'Name:\tpython3\nState:\tS (sleeping)\nPPid:\t44\n');
  const typedNow = Date.now();
  fs.mkdirSync(path.join(root, 'background-probe'), { recursive: true });
  const typedLedger = path.join(root, 'background-probe', '0.events.jsonl');
  fs.writeFileSync(typedLedger, JSON.stringify({ eventName: 'PreToolUse', toolUseId: 'python-125', toolName: 'Bash', toolCommandHash: '6cb792b4dee6401147614cdad9fa6eb79aec3386ac21b4a276904e4fb720ad0c', updatedAt: typedNow - 91000, bootTicks: 101, sequence: 1, pid: 45, pidStartTicks: 103 }) + '\n');
  assert.equal((await collectSessionActivity(['background-probe'], { procRoot: proc, statusDir: root, now: typedNow - 1000, controllerSessions: backgroundControllers }))['background-probe'].state, 'busy');
  assert.equal((await collectSessionActivity(['background-probe'], { procRoot: proc, statusDir: root, now: typedNow, controllerSessions: backgroundControllers }))['background-probe'].state, 'busy');
  fs.appendFileSync(typedLedger, JSON.stringify({ eventName: 'PostToolUse', toolUseId: 'python-125', updatedAt: typedNow + 1, sequence: 2, pid: 45, pidStartTicks: 103 }) + '\n');
  assert.equal((await collectSessionActivity(['background-probe'], { procRoot: proc, statusDir: root, now: typedNow + 2, controllerSessions: backgroundControllers }))['background-probe'].state, 'background');
  fs.appendFileSync(typedLedger, JSON.stringify({ eventName: 'Stop', updatedAt: typedNow + 3, sequence: 3, pid: 45, pidStartTicks: 103 }) + '\n');
  assert.equal((await collectSessionActivity(['background-probe'], { procRoot: proc, statusDir: root, now: typedNow + 4, controllerSessions: backgroundControllers }))['background-probe'].state, 'background');

  // An orphan that merely carries the same session, pane, and Claude UUID must
  // not donate its fresh file-descriptor mtime to the valid shell root.
  fs.writeFileSync(path.join(proc, 'stat'), 'btime 1000\n');
  for (const pid of ['10', '11', '12', '13', '14']) fs.mkdirSync(path.join(proc, pid), { recursive: true });
  fs.writeFileSync(path.join(proc, '10', 'stat'), '10 (claude) S 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 110 1');
  fs.writeFileSync(path.join(proc, '10', 'environ'), Buffer.from('ZELLIJ_SESSION_NAME=orphan-probe\0ZELLIJ_PANE_ID=0\0'));
  fs.writeFileSync(path.join(proc, '10', 'cmdline'), Buffer.from('claude\0--resume\0sid-a\0'));
  fs.writeFileSync(path.join(proc, '10', 'status'), 'Name:\tclaude\nState:\tS (sleeping)\nPPid:\t9\n');
  fs.mkdirSync(path.join(proc, '9'), { recursive: true });
  fs.writeFileSync(path.join(proc, '9', 'stat'), '9 (zellij) S 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 109 1');
  fs.writeFileSync(path.join(proc, '9', 'environ'), Buffer.from('ZELLIJ_SESSION_NAME=orphan-probe\0'));
  fs.writeFileSync(path.join(proc, '9', 'cmdline'), Buffer.from('zellij\0--server\0'));
  fs.writeFileSync(path.join(proc, '9', 'status'), 'Name:\tzellij\nState:\tS (sleeping)\nPPid:\t1\n');
  for (const [pid, parent] of [['11', '10'], ['12', '1'], ['13', '10'], ['14', '10']]) {
    fs.writeFileSync(path.join(proc, pid, 'stat'), `${pid} (bash) S 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1${pid} 1`);
    fs.writeFileSync(path.join(proc, pid, 'environ'), Buffer.from('ZELLIJ_SESSION_NAME=orphan-probe\0ZELLIJ_PANE_ID=0\0CLAUDE_CODE_SESSION_ID=sid-a\0'));
    fs.writeFileSync(path.join(proc, pid, 'cmdline'), Buffer.from('bash\0-c\0source /home/user/.claude/shell-snapshots/snapshot.sh\0'));
    fs.writeFileSync(path.join(proc, pid, 'status'), `Name:\tbash\nState:\tS (sleeping)\nPPid:\t${parent}\n`);
  }
  fs.mkdirSync(path.join(proc, '12', 'fd'));
  const orphanOutput = path.join(root, 'orphan-output.log');
  fs.writeFileSync(orphanOutput, 'fresh\n');
  fs.utimesSync(orphanOutput, new Date(outputAt), new Date(outputAt));
  fs.symlinkSync(orphanOutput, path.join(proc, '12', 'fd', '1'));
  const orphanProbe = (await readLiveBackgroundPanes(proc, [{ session: 'orphan-probe', pid: 9, startTicks: 109, panes: ['0'] }])).get('orphan-probe\0' + '0');
  assert.deepEqual(orphanProbe?.pids, [11, 13, 14]);
  const hz = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
  assert.equal(orphanProbe?.activityAt, 1000000 + Math.floor((114 * 1000) / hz));
  assert.equal(orphanProbe?.startedAt, 1000000 + Math.floor((111 * 1000) / hz));

  // The ancestry walker re-reads the root identity.  A child whose PPid has
  // been reused by a new process cannot attach to the old Claude root.
  fs.mkdirSync(path.join(proc, '900'), { recursive: true });
  fs.mkdirSync(path.join(proc, '901'), { recursive: true });
  fs.writeFileSync(path.join(proc, '900', 'stat'), '900 (claude) S 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 222 1');
  fs.writeFileSync(path.join(proc, '900', 'status'), 'Name:\tclaude\nState:\tS (sleeping)\nPPid:\t1\n');
  fs.writeFileSync(path.join(proc, '901', 'status'), 'Name:\tbash\nState:\tS (sleeping)\nPPid:\t900\n');
  assert.equal(processDescendsFrom(901, new Map([[900, 111]]), proc), false);
  fs.mkdirSync(path.join(proc, '902'), { recursive: true });
  fs.writeFileSync(path.join(proc, '902', 'stat'), '902 (claude) Z 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 333 1');
  fs.writeFileSync(path.join(proc, '902', 'status'), 'Name:\tclaude\nState:\tZ (zombie)\nPPid:\t1\n');
  fs.writeFileSync(path.join(proc, '902', 'environ'), Buffer.from('ZELLIJ_SESSION_NAME=zombie\0ZELLIJ_PANE_ID=0\0'));
  fs.writeFileSync(path.join(proc, '902', 'cmdline'), Buffer.from('claude\0--resume\0'));
  assert.equal((await readLiveClaudePanes(proc)).has('zombie\0' + '0'), false);

  const hookRoot = path.join(root, 'hook-state');
  const beforeHook = Date.now();
  const hook = spawnSync(path.join(import.meta.dirname, '..', 'bin', 'mcw-session-status'), ['idle', 'stop'], {
    env: {
      ...process.env,
      MCW_STATE_DIR: hookRoot,
      ZELLIJ_SESSION_NAME: 'hook-test',
      ZELLIJ_PANE_ID: '0',
    },
    input: JSON.stringify({
      hook_event_name: 'Stop',
      transcript_path: path.join(os.homedir(), '.claude/projects/-home-user-projects/hook-test.jsonl'),
      background_tasks: [
        { id: 'task-1', type: 'shell', status: 'running' },
        { id: 'task-2', type: 'subagent', status: 'pending' },
      ],
    }),
  });
  assert.equal(hook.status, 0);
  const hookStatus = JSON.parse(fs.readFileSync(path.join(hookRoot, 'session-status', 'hook-test', '0.json'), 'utf8'));
  assert.equal(hookStatus.state, 'idle');
  assert.equal(hookStatus.transcriptPath, path.join(os.homedir(), '.claude/projects/-home-user-projects/hook-test.jsonl'));
  assert.ok(hookStatus.updatedAt >= beforeHook && hookStatus.updatedAt <= Date.now());
  const response = JSON.parse(fs.readFileSync(path.join(hookRoot, 'session-status', 'hook-test', '0.response.json'), 'utf8'));
  assert.equal(response.transcriptPath, hookStatus.transcriptPath);
  assert.ok(response.lastResponseAt >= beforeHook && response.lastResponseAt <= Date.now());
  const hookBackground = JSON.parse(fs.readFileSync(path.join(hookRoot, 'session-status', 'hook-test', '0.background.json'), 'utf8'));
  assert.equal(hookBackground.transcriptPath, hookStatus.transcriptPath);
  assert.deepEqual(hookBackground.candidates, []);
  const hookEvents = fs.readFileSync(path.join(hookRoot, 'session-status', 'hook-test', '0.events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(hookEvents[0].eventName, 'Stop');
  assert.ok(hookEvents[0].sequence > 0 && hookEvents[0].pidStartTicks > 0);

  // Exercise the installed hook itself against a procfs-shaped tree.  The hook
  // must find only descendants of its Claude parent, preserve start ticks, and
  // avoid a machine-wide process scan.
  const hookProc = path.join(root, 'hook-proc');
  const hookParent = String(process.pid);
  for (const pid of [hookParent, '701', '702']) fs.mkdirSync(path.join(hookProc, pid), { recursive: true });
  fs.writeFileSync(path.join(hookProc, hookParent, 'status'), 'Name:\tnode\nPPid:\t701\n');
  fs.writeFileSync(path.join(hookProc, hookParent, 'cmdline'), Buffer.from('node\0test\0'));
  fs.writeFileSync(path.join(hookProc, '701', 'status'), 'Name:\tclaude\nPPid:\t1\n');
  fs.writeFileSync(path.join(hookProc, '701', 'cmdline'), Buffer.from('claude\0--resume\0hook-id\0'));
  fs.writeFileSync(path.join(hookProc, '701', 'stat'), '701 (claude) S 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 7010 1');
  fs.mkdirSync(path.join(hookProc, '701', 'task', '701'), { recursive: true });
  fs.writeFileSync(path.join(hookProc, '701', 'task', '701', 'children'), '702\n');
  fs.writeFileSync(path.join(hookProc, '702', 'cmdline'), Buffer.from('bash\0-c\0source /home/user/.claude/shell-snapshots/hook.sh\0'));
  fs.writeFileSync(path.join(hookProc, '702', 'stat'), '702 (bash) S 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 7020 1');
  fs.mkdirSync(path.join(hookProc, '702', 'task', '702'), { recursive: true });
  fs.writeFileSync(path.join(hookProc, '702', 'task', '702', 'children'), '');
  const hookTree = spawnSync(path.join(import.meta.dirname, '..', 'bin', 'mcw-session-status'), ['idle', 'stop'], {
    env: { ...process.env, MCW_STATE_DIR: hookRoot, MCW_PROC_ROOT: hookProc, ZELLIJ_SESSION_NAME: 'hook-tree', ZELLIJ_PANE_ID: '0' },
    input: JSON.stringify({ background_tasks: [{ id: 'task-1', type: 'shell', status: 'running' }] }),
  });
  assert.equal(hookTree.status, 0);
  const treeStatus = JSON.parse(fs.readFileSync(path.join(hookRoot, 'session-status', 'hook-tree', '0.json'), 'utf8'));
  const treeBackground = JSON.parse(fs.readFileSync(path.join(hookRoot, 'session-status', 'hook-tree', '0.background.json'), 'utf8'));
  assert.deepEqual({ pid: treeStatus.pid, startTicks: treeStatus.pidStartTicks }, { pid: 701, startTicks: 7010 });
  assert.deepEqual(treeBackground.candidates, [{ pid: 702, startTicks: 7020 }]);
  const hookPane = new Map([
    ['hook-test\0' + '0', { session: 'hook-test', pane: '0', startedAt: beforeHook - 1, pids: [50], command: [], cwd: null }],
  ]);
  const hookedActivity = aggregateSessionActivity(['hook-test'], hookPane, {
    statusDir: path.join(hookRoot, 'session-status'),
    sessionEnvDir: path.join(root, 'session-env'),
    projectsDir: path.join(root, 'projects'),
    now: hookBackground.updatedAt + 1,
  });
  assert.equal(hookedActivity['hook-test'].state, 'idle');
  assert.equal(hookedActivity['hook-test'].lastActivityAt, 0, 'an unrelated response cannot supply this owner\'s ranking time');

  const clearBackground = spawnSync(path.join(import.meta.dirname, '..', 'bin', 'mcw-session-status'), ['idle', 'stop'], {
    env: {
      ...process.env,
      MCW_STATE_DIR: hookRoot,
      ZELLIJ_SESSION_NAME: 'hook-test',
      ZELLIJ_PANE_ID: '0',
    },
    input: JSON.stringify({
      transcript_path: path.join(os.homedir(), '.claude/projects/-home-user-projects/hook-test.jsonl'),
      background_tasks: [],
    }),
  });
  assert.equal(clearBackground.status, 0);
  const cleared = JSON.parse(fs.readFileSync(path.join(hookRoot, 'session-status', 'hook-test', '0.background.json'), 'utf8'));
  assert.deepEqual(cleared.candidates, []);
  assert.equal(aggregateSessionActivity(['hook-test'], hookPane, {
    statusDir: path.join(hookRoot, 'session-status'),
    sessionEnvDir: path.join(root, 'session-env'),
    projectsDir: path.join(root, 'projects'),
    now: cleared.updatedAt + 1,
  })['hook-test'].state, 'idle');

  fs.mkdirSync(path.join(root, 'background-probe'), { recursive: true });
  fs.writeFileSync(path.join(root, 'background-probe', '0.json'), '{"state":"idle","updatedAt":2000}\n');
  const backgroundPane = new Map([
    ['background-probe\0' + '0', { session: 'background-probe', pane: '0', startedAt: 1000, pids: [48], command: [], cwd: null }],
  ]);
  fs.writeFileSync(path.join(root, 'background-probe', '0.background.json'), '{"updatedAt":2500,"candidates":[{"pid":49,"startTicks":1}]}\n');
  assert.deepEqual(aggregateSessionActivity(['background-probe'], backgroundPane, {
    ...options,
    now: 5000,
    backgroundPanes: new Map([[
      'background-probe\0' + '0',
      { session: 'background-probe', pane: '0', startedAt: 2500, activityAt: 2500, pids: [49], processes: [{ pid: 49, startTicks: 1 }], sessionIds: ['bg-id'] },
    ]]),
  }), {
    'background-probe': { state: 'background', updatedAt: 2500, lastResponseAt: 0, lastActivityAt: 2500 },
  });

  const transcript = path.join(root, 'fallback.jsonl');
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'assistant', timestamp: '2026-09-24T11:58:00.000Z' }),
    JSON.stringify({ type: 'user', timestamp: '2026-09-24T11:59:00.000Z' }),
    '',
  ].join('\n'));
  fs.mkdirSync(path.join(root, 'fallback'), { recursive: true });
  fs.writeFileSync(path.join(root, 'fallback', '0.json'), JSON.stringify({
    state: 'idle', updatedAt: 2000, transcriptPath: transcript,
    pid: 45, pidStartTicks: 1,
  }));
  const fallbackPanes = new Map([
    ['fallback\0' + '0', { session: 'fallback', pane: '0', startedAt: 1000, pids: [45], processes: [{ pid: 45, startTicks: 1 }], command: [], cwd: null }],
  ]);
  assert.deepEqual(aggregateSessionActivity(['fallback'], fallbackPanes, { ...options, now: Date.parse('2026-09-24T12:00:00.000Z') }), {
    fallback: {
      state: 'idle',
      updatedAt: 2000,
      lastResponseAt: Date.parse('2026-09-24T11:58:00.000Z'),
      lastActivityAt: Date.parse('2026-09-24T11:59:00.000Z'),
    },
  });
  for (const name of ['shared-a', 'shared-b']) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, '0.json'), JSON.stringify({
      state: 'idle', updatedAt: name === 'shared-a' ? 3000 : 4000, transcriptPath: transcript,
      pid: name === 'shared-a' ? 46 : 47, pidStartTicks: 1,
    }));
  }
  const sharedPanes = new Map([
    ['shared-a\0' + '0', { session: 'shared-a', pane: '0', startedAt: 1000, pids: [46], processes: [{ pid: 46, startTicks: 1 }], command: [], cwd: null }],
    ['shared-b\0' + '0', { session: 'shared-b', pane: '0', startedAt: 1000, pids: [47], processes: [{ pid: 47, startTicks: 1 }], command: [], cwd: null }],
  ]);
  assert.deepEqual(aggregateSessionActivity(['shared-a', 'shared-b'], sharedPanes, { ...options, now: 4001 }), {
    'shared-a': {
      state: 'idle', updatedAt: 3000,
      lastResponseAt: 0, lastActivityAt: 3000,
    },
    'shared-b': {
      state: 'idle', updatedAt: 4000,
      lastResponseAt: 0, lastActivityAt: 4000,
    },
  });

  const exactTimes = {
    'web-terminal-2': Date.parse('2026-09-28T23:17:01.000Z'),
    'session-two': Date.parse('2026-09-28T23:16:59.000Z'),
    'github-transfer': Date.parse('2026-09-28T23:16:42.000Z'),
    'project-automation': Date.parse('2026-09-28T23:16:38.000Z'),
  };
  const exactPanes = new Map();
  for (const [name, updatedAt] of Object.entries(exactTimes)) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, '0.json'), JSON.stringify({
      state: name === 'web-terminal-2' || name === 'session-two' ? 'busy' : 'idle',
      updatedAt,
      pid: 60, pidStartTicks: 1,
    }));
    exactPanes.set(`${name}\0` + '0', { session: name, pane: '0', startedAt: updatedAt - 10000, pids: [60], processes: [{ pid: 60, startTicks: 1 }], command: [], cwd: null });
  }
  const exactActivity = aggregateSessionActivity(Object.keys(exactTimes), exactPanes, {
    ...options,
    now: Date.parse('2026-09-28T23:17:03.000Z'),
    backgroundPanes: new Map([[
      'project-automation\0' + '0',
      {
        session: 'project-automation', pane: '0',
        startedAt: exactTimes['project-automation'] - 1000,
        activityAt: exactTimes['project-automation'], pids: [61], sessionIds: ['home-session'],
      },
    ]]),
  });
  assert.deepEqual(Object.entries(exactActivity)
    .sort((left, right) => right[1].lastActivityAt - left[1].lastActivityAt)
    .map(([name, value]) => [name, value.lastActivityAt]), Object.entries(exactTimes));
  console.log('status aggregation and creation timestamp parsing: PASS');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
