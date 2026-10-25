import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = process.argv.indexOf('--module');
const modulePath = arg >= 0 ? process.argv[arg + 1] : process.env.STATUS_MODULE;
if (!modulePath) throw new Error('pass --module PATH or set STATUS_MODULE=PATH');

const { aggregateSessionActivity } = await import(pathToFileURL(path.resolve(modulePath)).href);
const fixtures = JSON.parse(fs.readFileSync(new URL('./fixtures/status-reliable.json', import.meta.url), 'utf8'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcw-status-differential-'));

function pathToFileURL(file) {
  return new URL(`file://${file}`);
}

function panes(rows) {
  return new Map(rows.map(([session, pane, startedAt, pid]) => [`${session}\0${pane}`, {
    session, pane, startedAt, pids: [pid], processes: [{ pid, startTicks: 1 }], commands: [], cwd: null,
  }]));
}

function writeFixture(fixture) {
  for (const [session, pane, state, updatedAt, pid, pidStartTicks, eventName] of fixture.hooks || []) {
    const dir = path.join(root, session); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${pane}.json`), JSON.stringify({ state, updatedAt, pid, pidStartTicks }));
    if (eventName) fs.appendFileSync(path.join(dir, `${pane}.events.jsonl`), JSON.stringify({ eventName, updatedAt, sequence: 1, pid, pidStartTicks }) + '\n');
  }
  for (const [session, pane, updatedAt] of fixture.staleBackground || []) {
    const dir = path.join(root, session); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${pane}.background.json`), JSON.stringify({ updatedAt, taskCount: 1 }));
  }
  for (const [session, pane, updatedAt, pid = 99] of fixture.background || []) {
    const dir = path.join(root, session); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${pane}.background.json`), JSON.stringify({ updatedAt, candidates: [{ pid, startTicks: 1 }] }));
  }
  if (fixture.transcript) {
    const transcriptPath = path.join(root, `${fixture.name}.jsonl`);
    fs.writeFileSync(transcriptPath, fixture.transcript.map(JSON.stringify).join('\n') + '\n');
    for (const [session, pane] of fixture.hooks || []) {
      const file = path.join(root, session, `${pane}.json`); const hook = JSON.parse(fs.readFileSync(file, 'utf8'));
      hook.transcriptPath = transcriptPath; fs.writeFileSync(file, JSON.stringify(hook));
    }
  }
}

let failures = 0;
try {
  for (const fixture of fixtures) {
    fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root);
    writeFixture(fixture);
    const backgroundPanes = new Map((fixture.background || []).map(([session, pane, activityAt, pid = 99]) => [`${session}\0${pane}`, {
      session, pane, startedAt: activityAt, activityAt, pids: [pid], processes: [{ pid, startTicks: 1 }], sessionIds: [],
    }]));
    const detachedSessions = new Map((fixture.detached || []).map(([session, pid]) => [session, { pids: [pid], startedAt: 1790706877000 }]));
    let activity;
    try {
      activity = aggregateSessionActivity(fixture.sessions, panes(fixture.panes), {
        statusDir: root, backgroundPanes, detachedSessions, now: fixture.now,
      });
    } catch (error) {
      failures += fixture.sessions.length;
      for (const session of fixture.sessions) console.log(`${fixture.name}\t${session}\texpected=${fixture.expected}\tactual=ERROR:${error.message}\tFAIL`);
      continue;
    }
    for (const session of fixture.sessions) {
      const actual = activity[session]?.state || 'missing';
      const expectedActivityAt = fixture.expectedActivityAt?.[session];
      const activityPass = expectedActivityAt === undefined || activity[session]?.lastActivityAt === expectedActivityAt;
      const pass = actual === fixture.expected && activityPass;
      if (!pass) failures += 1;
      console.log(`${fixture.name}\t${session}\texpected=${fixture.expected}\tactual=${actual}\texpectedActivity=${expectedActivityAt ?? '-'}\tactualActivity=${activity[session]?.lastActivityAt ?? 0}\t${pass ? 'PASS' : 'FAIL'}`);
    }
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`cases=${fixtures.length} failures=${failures} skipped=0`);
if (failures) process.exitCode = 1;
