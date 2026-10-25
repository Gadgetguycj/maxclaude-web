import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import cases from './fixtures/status-reliable.json' with { type: 'json' };
import { aggregateSessionActivity, TRANSCRIPT_READ_CHUNK_BYTES } from '../src/status.js';

const CLAIM_MAX_AGE_MS = 90_000;
assert.equal(TRANSCRIPT_READ_CHUNK_BYTES, 65536);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcw-reliable-status-'));
function paneMap(rows) {
  return new Map(rows.map(([session, pane, startedAt, pid]) => [`${session}\0${pane}`, {
    session, pane, startedAt, pids: [pid], processes: [{ pid, startTicks: 1 }], commands: [], cwd: null,
  }]));
}
function writeHooks(rows) {
  for (const [session, pane, state, updatedAt, pid, pidStartTicks, eventName] of rows || []) {
    const dir = path.join(root, session); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${pane}.json`), JSON.stringify({ state, updatedAt, pid, pidStartTicks }));
    if (eventName) fs.appendFileSync(path.join(dir, `${pane}.events.jsonl`), JSON.stringify({ eventName, updatedAt, pid, pidStartTicks }) + '\n');
  }
}
function backgrounds(rows) {
  return new Map((rows || []).map(([session, pane, activityAt, pid = 99]) => [`${session}\0${pane}`, { session, pane, activityAt, startedAt: activityAt, pids: [pid], processes: [{ pid, startTicks: 1 }] }]));
}
function writeStaleBackground(rows) {
  for (const [session, pane, updatedAt] of rows || []) {
    const dir = path.join(root, session); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${pane}.background.json`), JSON.stringify({ updatedAt, taskCount: 1 }));
  }
}
function detached(rows) { return new Map((rows || []).map(([session, pid]) => [session, { pids: [pid], startedAt: 1790706877000 }])); }
function writeCandidates(rows) {
  for (const [session, pane, updatedAt, pid = 99] of rows || []) {
    const dir = path.join(root, session); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${pane}.background.json`), JSON.stringify({ updatedAt, candidates: [{ pid, startTicks: 1 }] }));
  }
}
function writeLedger(session, pane, events) {
  const dir = path.join(root, session); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${pane}.events.jsonl`), events.map((event) => JSON.stringify(event)).join('\n') + '\n');
}
for (const fixture of cases) {
  fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root);
  writeHooks(fixture.hooks); writeStaleBackground(fixture.staleBackground); writeCandidates(fixture.background);
  if (fixture.transcript) {
    const transcriptPath = path.join(root, `${fixture.name}.jsonl`);
    fs.writeFileSync(transcriptPath, fixture.transcript.map(JSON.stringify).join('\n') + '\n');
    for (const [session, pane] of fixture.hooks || []) {
      const file = path.join(root, session, `${pane}.json`); const hook = JSON.parse(fs.readFileSync(file, 'utf8'));
      hook.transcriptPath = transcriptPath; fs.writeFileSync(file, JSON.stringify(hook));
    }
  }
  const actual = aggregateSessionActivity(fixture.sessions, paneMap(fixture.panes), { statusDir: root, backgroundPanes: backgrounds(fixture.background), detachedSessions: detached(fixture.detached), now: fixture.now });
  for (const session of fixture.sessions) assert.equal(actual[session].state, fixture.expected, fixture.name);
}

// A stale background task file is intentionally absent from inputs. It cannot turn a
// light green because the collector accepts only a process snapshot.
const stale = aggregateSessionActivity(['stale-file'], paneMap([['stale-file', '0', 1, 8]]), { statusDir: root, now: Date.now() });
assert.equal(stale['stale-file'].state, 'idle');

const transcript = path.join(os.tmpdir(), `mcw-shared-${process.pid}.jsonl`);
fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', timestamp: new Date(Date.now()).toISOString() }) + '\n');
fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root);
writeHooks([
  ['left', '0', 'idle', Date.now() - 1000, 81, 1],
  ['right', '0', 'idle', Date.now() - 1000, 82, 1],
]);
for (const name of ['left', 'right']) {
  const record = JSON.parse(fs.readFileSync(path.join(root, name, '0.json'), 'utf8')); record.transcriptPath = transcript;
  fs.writeFileSync(path.join(root, name, '0.json'), JSON.stringify(record));
}
const shared = aggregateSessionActivity(['left', 'right'], paneMap([['left', '0', 1, 81], ['right', '0', 1, 82]]), { statusDir: root, now: Date.now() });
assert.equal(shared.left.state, 'idle'); assert.equal(shared.right.state, 'idle');
fs.appendFileSync(transcript, JSON.stringify({ type: 'user', timestamp: new Date(Date.now() + 1).toISOString() }) + '\n');
const sharedGrowth = aggregateSessionActivity(['left', 'right'], paneMap([['left', '0', 1, 81], ['right', '0', 1, 82]]), { statusDir: root, now: Date.now() });
assert.equal(sharedGrowth.left.state, 'idle'); assert.equal(sharedGrowth.right.state, 'idle');
assert.equal(sharedGrowth.left.lastActivityAt, JSON.parse(fs.readFileSync(path.join(root, 'left', '0.json'), 'utf8')).updatedAt);
assert.equal(sharedGrowth.right.lastActivityAt, JSON.parse(fs.readFileSync(path.join(root, 'right', '0.json'), 'utf8')).updatedAt);

const recent = Date.now() - CLAIM_MAX_AGE_MS - 1;
fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root); writeHooks([['expired', '0', 'busy', recent, 91, 1]]);
const expiredActivity = aggregateSessionActivity(['expired'], paneMap([['expired', '0', 1, 91]]), { statusDir: root, now: Date.now() }).expired;
assert.equal(expiredActivity.state, 'idle');
assert.equal(expiredActivity.updatedAt, recent, 'the stale claim remains its own ranking event');

// An interrupt transcript event must beat an earlier busy hook by event time.
// File mtime is deliberately unrelated to the JSONL timestamps here.
const markerTranscript = path.join(root, 'interrupt.jsonl');
const markerAt = Date.now() - 1000;
fs.writeFileSync(markerTranscript, `${JSON.stringify({ type: 'assistant', timestamp: new Date(markerAt - 1000).toISOString() })}\n${JSON.stringify({ type: 'tool_result', timestamp: new Date(markerAt).toISOString(), toolUseResult: { interrupted: true } })}\n`);
writeHooks([['marker', '0', 'busy', markerAt - 500, 101, 1, 'UserPromptSubmit']]);
assert.equal(aggregateSessionActivity(['marker'], paneMap([['marker', '0', 1, 101]]), { statusDir: root, now: Date.now() }).marker.state, 'busy');
let markerHook = JSON.parse(fs.readFileSync(path.join(root, 'marker', '0.json'), 'utf8')); markerHook.transcriptPath = markerTranscript;
fs.writeFileSync(path.join(root, 'marker', '0.json'), JSON.stringify(markerHook));
assert.equal(aggregateSessionActivity(['marker'], paneMap([['marker', '0', 1, 101]]), { statusDir: root, now: Date.now() }).marker.state, 'idle');

// Claude Code's Escape marker is a user record.  It ends an unmatched busy
// turn without needing a Stop hook.
const escapeTranscript = path.join(root, 'escape.jsonl');
const escapeAt = Date.now() - 500;
fs.writeFileSync(escapeTranscript, `${JSON.stringify({ type: 'user', timestamp: new Date(escapeAt - 100).toISOString(), message: { role: 'user', content: 'work' } })}\n${JSON.stringify({ type: 'user', timestamp: new Date(escapeAt).toISOString(), message: { role: 'user', content: '[Request interrupted by user for tool use]' } })}\n`);
writeHooks([['escape', '0', 'busy', escapeAt - 50, 102, 1, 'UserPromptSubmit']]);
assert.equal(aggregateSessionActivity(['escape'], paneMap([['escape', '0', 1, 102]]), { statusDir: root, now: Date.now() }).escape.state, 'busy');
let escapeHook = JSON.parse(fs.readFileSync(path.join(root, 'escape', '0.json'), 'utf8')); escapeHook.transcriptPath = escapeTranscript;
fs.writeFileSync(path.join(root, 'escape', '0.json'), JSON.stringify(escapeHook));
assert.equal(aggregateSessionActivity(['escape'], paneMap([['escape', '0', 1, 102]]), { statusDir: root, now: Date.now() }).escape.state, 'idle');

const arrayEscapeTranscript = path.join(root, 'escape-array.jsonl');
fs.writeFileSync(arrayEscapeTranscript, JSON.stringify({ type: 'user', timestamp: new Date(escapeAt + 1).toISOString(), message: { role: 'user', content: [{ type: 'text', text: ' [Request interrupted by user] ' }] } }) + '\n');
writeHooks([['escape-array', '0', 'busy', escapeAt, 104, 1, 'UserPromptSubmit']]);
assert.equal(aggregateSessionActivity(['escape-array'], paneMap([['escape-array', '0', 1, 104]]), { statusDir: root, now: Date.now() })['escape-array'].state, 'busy');
let arrayHook = JSON.parse(fs.readFileSync(path.join(root, 'escape-array', '0.json'), 'utf8')); arrayHook.transcriptPath = arrayEscapeTranscript;
fs.writeFileSync(path.join(root, 'escape-array', '0.json'), JSON.stringify(arrayHook));
assert.equal(aggregateSessionActivity(['escape-array'], paneMap([['escape-array', '0', 1, 104]]), { statusDir: root, now: Date.now() })['escape-array'].state, 'idle');

// Mentioning the marker in an assistant answer or tool result is discussion,
// not a user Escape event.  The matched busy hook must remain authoritative.
const quotedTranscript = path.join(root, 'quoted-marker.jsonl');
fs.writeFileSync(quotedTranscript, `${JSON.stringify({ type: 'assistant', timestamp: new Date(escapeAt + 2).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'The marker [Request interrupted by user] is documented.' }] } })}\n${JSON.stringify({ type: 'tool_result', timestamp: new Date(escapeAt + 3).toISOString(), output: '[Request interrupted by user for tool use]' })}\n`);
writeHooks([['quoted', '0', 'busy', escapeAt + 1, 105, 1, 'UserPromptSubmit']]);
let quotedHook = JSON.parse(fs.readFileSync(path.join(root, 'quoted', '0.json'), 'utf8')); quotedHook.transcriptPath = quotedTranscript;
fs.writeFileSync(path.join(root, 'quoted', '0.json'), JSON.stringify(quotedHook));
assert.equal(aggregateSessionActivity(['quoted'], paneMap([['quoted', '0', 1, 105]]), { statusDir: root, now: Date.now() }).quoted.state, 'busy');

// A marker beyond the first read chunk still ends the busy claim.
const largeTranscript = path.join(os.tmpdir(), `mcw-large-${process.pid}.jsonl`);
const largeAt = Date.now() - 300;
fs.writeFileSync(largeTranscript, `${'x'.repeat(TRANSCRIPT_READ_CHUNK_BYTES + 2048)}\n${JSON.stringify({ type: 'tool_result', timestamp: new Date(largeAt).toISOString(), toolUseResult: { interrupted: true } })}\n`);
writeHooks([['large-tail', '0', 'busy', largeAt - 1, 103, 1, 'UserPromptSubmit']]);
assert.equal(aggregateSessionActivity(['large-tail'], paneMap([['large-tail', '0', 1, 103]]), { statusDir: root, now: Date.now() })['large-tail'].state, 'busy');
let largeHook = JSON.parse(fs.readFileSync(path.join(root, 'large-tail', '0.json'), 'utf8')); largeHook.transcriptPath = largeTranscript;
fs.writeFileSync(path.join(root, 'large-tail', '0.json'), JSON.stringify(largeHook));
assert.equal(aggregateSessionActivity(['large-tail'], paneMap([['large-tail', '0', 1, 103]]), { statusDir: root, now: Date.now() })['large-tail'].state, 'idle');
fs.rmSync(largeTranscript, { force: true });

// A later user prompt re-arms the growth lease.  The first sample is a baseline.
fs.appendFileSync(markerTranscript, JSON.stringify({ type: 'user', timestamp: new Date(markerAt + 1).toISOString(), message: { role: 'user', content: 'new prompt' } }) + '\n');
const rearmed = aggregateSessionActivity(['marker'], paneMap([['marker', '0', 1, 101]]), { statusDir: root, now: Date.now() }).marker;
assert.equal(rearmed.state, 'busy');

// A fresh prompt establishes busy. A generic descendant cannot renew it.
writeHooks([['tool', '0', 'busy', Date.now() - 10, 111, 1, 'UserPromptSubmit']]);
const toolActivity = aggregateSessionActivity(['tool'], paneMap([['tool', '0', 1, 111]]), {
  statusDir: root,
  now: Date.now(),
  toolPanes: new Map([['tool\0' + '0', [{ pid: 112, startTicks: 2, startedAt: Date.now(), owner: { pid: 111, startTicks: 1 } }]]]),
});
assert.equal(toolActivity.tool.state, 'busy');
assert.equal(aggregateSessionActivity(['tool'], paneMap([['tool', '0', 1, 111]]), {
  statusDir: root, now: Date.now() + CLAIM_MAX_AGE_MS + 1000,
  toolPanes: new Map([['tool\0' + '0', [{ pid: 112, startTicks: 2, startedAt: Date.now(), owner: { pid: 111, startTicks: 1 } }]]]),
}).tool.state, 'idle');

// A broker that predates the current turn merely inherited the pane environment.
// It cannot claim foreground work after the Stop event.
writeHooks([['broker', '0', 'idle', Date.now() - 10, 121, 1]]);
const brokerActivity = aggregateSessionActivity(['broker'], paneMap([['broker', '0', 1, 121]]), {
  statusDir: root,
  now: Date.now(),
  toolPanes: new Map([['broker\0' + '0', [{ pid: 122, startTicks: 2, startedAt: Date.now() - 60_000 }]]]),
});
assert.equal(brokerActivity.broker.state, 'idle');

// The actual shell-snapshot wrapper is a pending Bash execution.  It can keep
// a quiet long command busy after the hook lease.  A generic descendant cannot.
const longTurnAt = Date.now() - CLAIM_MAX_AGE_MS - 1000;
writeHooks([['long-tool', '0', 'busy', longTurnAt, 125, 1, 'UserPromptSubmit']]);
const longCommandHash = 'c'.repeat(64);
fs.appendFileSync(path.join(root, 'long-tool', '0.events.jsonl'), JSON.stringify({ eventName: 'PreToolUse', toolUseId: 'long-tool', toolName: 'Bash', toolCommandHash: longCommandHash, updatedAt: longTurnAt + 1, pid: 125, pidStartTicks: 1, bootTicks: 50_000 }) + '\n');
const longExecution = new Map([['long-tool\0' + '0', { processes: [{ pid: 126, startTicks: 50_001, startedAt: longTurnAt - 1, owner: { pid: 125, startTicks: 1 }, commandHash: longCommandHash }], pids: [126] }]]);
assert.equal(aggregateSessionActivity(['long-tool'], paneMap([['long-tool', '0', 1, 125]]), {
  statusDir: root, now: longTurnAt + 2, backgroundPanes: longExecution,
})['long-tool'].state, 'busy');
assert.equal(aggregateSessionActivity(['long-tool'], paneMap([['long-tool', '0', 1, 125]]), {
  statusDir: root, now: Date.now(),
  backgroundPanes: longExecution,
})['long-tool'].state, 'busy');

assert.equal(aggregateSessionActivity(['long-tool'], paneMap([['long-tool', '0', 1, 125]]), {
  statusDir: root, now: Date.now(),
  toolPanes: new Map([['long-tool\0' + '0', [{ pid: 127, startTicks: 50_002, startedAt: longTurnAt, owner: { pid: 125, startTicks: 1 } }]]]),
})['long-tool'].state, 'idle');

// A persistent broker born before the unmatched PreToolUse tick cannot renew
// a foreground claim after the hook lease expires.
assert.equal(aggregateSessionActivity(['long-tool'], paneMap([['long-tool', '0', 1, 125]]), {
  statusDir: root, now: Date.now(),
  toolPanes: new Map([['long-tool\0' + '0', [{ pid: 127, startTicks: 49_999, startedAt: Date.now(), owner: { pid: 125, startTicks: 1 } }]]]),
})['long-tool'].state, 'idle');

// A response file belongs to one live Claude identity.  A renamed pane with
// an unresolved transcript cannot borrow a previous or reused namespace's
// response ranking timestamp.
const responseNow = Date.now();
function writeResponse(session, value) {
  const dir = path.join(root, session); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '0.response.json'), JSON.stringify(value));
}
const responsePanes = new Map([
  ['renamed-response\0' + '0', { session: 'renamed-response', hookSession: 'old-response', pane: '0', startedAt: 1, pids: [131], processes: [{ pid: 131, startTicks: 31 }], commands: [], cwd: null }],
  ['other-response\0' + '0', { session: 'other-response', pane: '0', startedAt: 1, pids: [132], processes: [{ pid: 132, startTicks: 32 }], commands: [], cwd: null }],
  ['reused-pid-response\0' + '0', { session: 'reused-pid-response', pane: '0', startedAt: 1, pids: [133], processes: [{ pid: 133, startTicks: 33 }], commands: [], cwd: null }],
]);
writeResponse('old-response', { lastResponseAt: responseNow - 1, pid: 130, pidStartTicks: 30 });
writeResponse('other-response', { lastResponseAt: responseNow - 1, pid: 999, pidStartTicks: 32 });
writeResponse('reused-pid-response', { lastResponseAt: responseNow - 1, pid: 133, pidStartTicks: 3 });
const rejectedResponses = aggregateSessionActivity(['renamed-response', 'other-response', 'reused-pid-response'], responsePanes, { statusDir: root, now: responseNow });
assert.equal(rejectedResponses['renamed-response'].lastResponseAt, 0);
assert.equal(rejectedResponses['other-response'].lastResponseAt, 0);
assert.equal(rejectedResponses['reused-pid-response'].lastResponseAt, 0);
writeResponse('matched-response', { lastResponseAt: responseNow - 1, pid: 134, pidStartTicks: 34 });
const matchedResponsePane = paneMap([['matched-response', '0', 1, 134]]);
matchedResponsePane.get('matched-response\0' + '0').processes = [{ pid: 134, startTicks: 34 }];
const matchedTranscript = path.join(root, 'matched-response.jsonl');
fs.writeFileSync(matchedTranscript, JSON.stringify({ type: 'assistant', timestamp: new Date(responseNow - 2).toISOString() }) + '\n');
matchedResponsePane.get('matched-response\0' + '0').commands = [['claude', '--resume', matchedTranscript]];
const matchedResponseFile = JSON.parse(fs.readFileSync(path.join(root, 'matched-response', '0.response.json'), 'utf8'));
matchedResponseFile.transcriptPath = matchedTranscript;
fs.writeFileSync(path.join(root, 'matched-response', '0.response.json'), JSON.stringify(matchedResponseFile));
assert.equal(aggregateSessionActivity(['matched-response'], matchedResponsePane, { statusDir: root, now: responseNow })['matched-response'].lastResponseAt, responseNow - 1);

const backgroundTranscript = path.join(os.tmpdir(), `mcw-background-${process.pid}.jsonl`);
const backgroundAt = Date.now() - 100;
fs.writeFileSync(backgroundTranscript, `${JSON.stringify({ type: 'user', timestamp: new Date(backgroundAt - 10).toISOString() })}\n${JSON.stringify({ type: 'user', timestamp: new Date(backgroundAt).toISOString(), message: { role: 'user', content: '[Request interrupted by user]' } })}\n`);
writeHooks([['background-terminal', '0', 'busy', backgroundAt - 5, 127, 1, 'UserPromptSubmit']]);
assert.equal(aggregateSessionActivity(['background-terminal'], paneMap([['background-terminal', '0', 1, 127]]), { statusDir: root, now: Date.now() })['background-terminal'].state, 'busy');
let backgroundHook = JSON.parse(fs.readFileSync(path.join(root, 'background-terminal', '0.json'), 'utf8')); backgroundHook.transcriptPath = backgroundTranscript;
fs.writeFileSync(path.join(root, 'background-terminal', '0.json'), JSON.stringify(backgroundHook));
const liveBackground = new Map([['background-terminal\0' + '0', { session: 'background-terminal', pane: '0', startedAt: backgroundAt - 20, activityAt: backgroundAt - 20, pids: [128], processes: [{ pid: 128, startTicks: 2 }], sessionIds: [path.basename(backgroundTranscript, '.jsonl')] }]]);
assert.equal(aggregateSessionActivity(['background-terminal'], paneMap([['background-terminal', '0', 1, 127]]), { statusDir: root, now: Date.now(), backgroundPanes: liveBackground })['background-terminal'].state, 'background');

// Corrupt future candidate timestamps and mismatched transcript identities do
// not alter ranking or create a green background light.
writeCandidates([['background-terminal', '0', Date.now() + 60_000, 128]]);
const futureCandidate = aggregateSessionActivity(['background-terminal'], paneMap([['background-terminal', '0', 1, 127]]), { statusDir: root, now: Date.now(), backgroundPanes: liveBackground })['background-terminal'];
assert.equal(futureCandidate.updatedAt, backgroundAt - 20);
const mismatchedBackground = new Map([['mismatch\0' + '0', { session: 'mismatch', pane: '0', startedAt: 1, activityAt: 1, pids: [130], processes: [{ pid: 130, startTicks: 2 }], sessionIds: ['wrong-conversation'] }]]);
writeHooks([['mismatch', '0', 'idle', Date.now() - 1, 129, 1]]);
let mismatchHook = JSON.parse(fs.readFileSync(path.join(root, 'mismatch', '0.json'), 'utf8')); mismatchHook.transcriptPath = backgroundTranscript;
fs.writeFileSync(path.join(root, 'mismatch', '0.json'), JSON.stringify(mismatchHook));
assert.equal(aggregateSessionActivity(['mismatch'], paneMap([['mismatch', '0', 1, 129]]), { statusDir: root, now: Date.now(), backgroundPanes: mismatchedBackground }).mismatch.state, 'idle');
fs.rmSync(backgroundTranscript, { force: true });

// Filesystem metadata changes do not constitute Claude activity.  A stale
// transcript must remain background when its verified shell still runs, and
// idle when no task exists.  A new current user record is semantic activity.
const metadataNow = Date.now();
const staleSemanticAt = metadataNow - (13 * 60 * 60 * 1000);
const metadataTranscript = path.join(os.tmpdir(), `mcw-metadata-${process.pid}.jsonl`);
fs.writeFileSync(metadataTranscript, JSON.stringify({ type: 'user', timestamp: new Date(staleSemanticAt).toISOString(), message: { role: 'user', content: 'old prompt' } }) + '\n');
writeHooks([['metadata-bg', '0', 'busy', staleSemanticAt, 141, 1]]);
let metadataHook = JSON.parse(fs.readFileSync(path.join(root, 'metadata-bg', '0.json'), 'utf8')); metadataHook.transcriptPath = metadataTranscript;
fs.writeFileSync(path.join(root, 'metadata-bg', '0.json'), JSON.stringify(metadataHook));
const metadataBackground = new Map([['metadata-bg\0' + '0', { session: 'metadata-bg', pane: '0', startedAt: metadataNow - 1000, activityAt: metadataNow - 1000, pids: [143], processes: [{ pid: 143, startTicks: 2 }], sessionIds: [path.basename(metadataTranscript, '.jsonl')] }]]);
const metadataPanes = paneMap([['metadata-bg', '0', 1, 141]]);
assert.equal(aggregateSessionActivity(['metadata-bg'], metadataPanes, { statusDir: root, now: metadataNow, backgroundPanes: metadataBackground })['metadata-bg'].state, 'background');
fs.utimesSync(metadataTranscript, new Date(metadataNow + 1), new Date(metadataNow + 1));
const metadataChanged = aggregateSessionActivity(['metadata-bg'], metadataPanes, { statusDir: root, now: metadataNow + 2, backgroundPanes: metadataBackground });
assert.equal(metadataChanged['metadata-bg'].state, 'background');
const freshPromptAt = Date.now();
fs.appendFileSync(metadataTranscript, JSON.stringify({ type: 'user', timestamp: new Date(freshPromptAt).toISOString(), message: { role: 'user', content: 'current foreground prompt' } }) + '\n');
assert.equal(aggregateSessionActivity(['metadata-bg'], paneMap([['metadata-bg', '0', 1, 141]]), { statusDir: root, now: freshPromptAt + 1, backgroundPanes: metadataBackground })['metadata-bg'].state, 'busy');
fs.rmSync(metadataTranscript, { force: true });
const metadataIdleTranscript = path.join(os.tmpdir(), `mcw-metadata-idle-${process.pid}.jsonl`);
fs.writeFileSync(metadataIdleTranscript, JSON.stringify({ type: 'user', timestamp: new Date(staleSemanticAt).toISOString(), message: { role: 'user', content: 'old prompt' } }) + '\n');
writeHooks([['metadata-idle', '0', 'busy', staleSemanticAt, 142, 1]]);
let idleMetadataHook = JSON.parse(fs.readFileSync(path.join(root, 'metadata-idle', '0.json'), 'utf8')); idleMetadataHook.transcriptPath = metadataIdleTranscript;
fs.writeFileSync(path.join(root, 'metadata-idle', '0.json'), JSON.stringify(idleMetadataHook));
const metadataIdlePane = paneMap([['metadata-idle', '0', 1, 142]]);
assert.equal(aggregateSessionActivity(['metadata-idle'], metadataIdlePane, { statusDir: root, now: metadataNow })['metadata-idle'].state, 'idle');
fs.utimesSync(metadataIdleTranscript, new Date(metadataNow + 1), new Date(metadataNow + 1));
assert.equal(aggregateSessionActivity(['metadata-idle'], metadataIdlePane, { statusDir: root, now: metadataNow + 2 })['metadata-idle'].state, 'idle');
fs.rmSync(metadataIdleTranscript, { force: true });

// A recreated pane has a new Linux identity.  It starts a fresh transcript
// observation and cannot inherit a growth lease from the old PID/start ticks.
const recreatedTranscript = path.join(os.tmpdir(), `mcw-recreated-${process.pid}.jsonl`);
const recreatedAt = Date.now();
fs.writeFileSync(recreatedTranscript, JSON.stringify({ type: 'user', timestamp: new Date(recreatedAt).toISOString(), message: { role: 'user', content: 'first prompt' } }) + '\n');
const oldPane = paneMap([['recreated', '0', 1, 151]]).get('recreated\0' + '0');
oldPane.commands = [['claude', '--resume', recreatedTranscript]];
assert.equal(aggregateSessionActivity(['recreated'], new Map([['recreated\0' + '0', oldPane]]), { statusDir: root, now: recreatedAt + 1 }).recreated.state, 'idle');
fs.appendFileSync(recreatedTranscript, JSON.stringify({ type: 'user', timestamp: new Date(recreatedAt + 2).toISOString(), message: { role: 'user', content: 'fresh prompt' } }) + '\n');
assert.equal(aggregateSessionActivity(['recreated'], new Map([['recreated\0' + '0', oldPane]]), { statusDir: root, now: recreatedAt + 3 }).recreated.state, 'busy');
const newPane = { ...oldPane, processes: [{ pid: 151, startTicks: 2 }] };
assert.equal(aggregateSessionActivity(['recreated'], new Map([['recreated\0' + '0', newPane]]), { statusDir: root, now: recreatedAt + 4 }).recreated.state, 'idle');
fs.rmSync(recreatedTranscript, { force: true });

// Ledger ordering is per owner. A late PostToolUse cannot reopen a stopped
// turn, including at the same millisecond. A later prompt does reopen it.
const ledgerNow = Date.now();
const ledgerPanes = paneMap([['ledger-bg', '0', 1, 161], ['ledger-idle', '0', 1, 162], ['ledger-reopen', '0', 1, 163], ['ledger-reset', '0', 1, 164]]);
for (const [name, pid] of [['ledger-bg', 161], ['ledger-idle', 162], ['ledger-reopen', 163]]) {
  writeLedger(name, '0', [
    { eventName: 'UserPromptSubmit', updatedAt: ledgerNow - 10, sequence: 1, pid, pidStartTicks: 1 },
    { eventName: 'Stop', updatedAt: ledgerNow, sequence: 2, pid, pidStartTicks: 1 },
    { eventName: 'PostToolUse', updatedAt: ledgerNow + 1, sequence: 3, pid, pidStartTicks: 1 },
  ]);
}
writeLedger('ledger-reopen', '0', [
  { eventName: 'UserPromptSubmit', updatedAt: ledgerNow - 10, sequence: 1, pid: 163, pidStartTicks: 1 },
  { eventName: 'Stop', updatedAt: ledgerNow, sequence: 2, pid: 163, pidStartTicks: 1 },
  { eventName: 'PostToolUse', updatedAt: ledgerNow + 1, sequence: 3, pid: 163, pidStartTicks: 1 },
  { eventName: 'PreToolUse', updatedAt: ledgerNow + 2, sequence: 4, pid: 163, pidStartTicks: 1, toolUseId: 'opaque-tool' },
]);
writeLedger('ledger-reset', '0', [{ eventName: 'UserPromptSubmit', updatedAt: ledgerNow, sequence: 1, pid: 164, pidStartTicks: 999 }]);
const ledgerBackground = new Map([['ledger-bg\0' + '0', { session: 'ledger-bg', pane: '0', startedAt: ledgerNow - 1000, activityAt: ledgerNow - 1000, pids: [165], processes: [{ pid: 165, startTicks: 2 }], sessionIds: [] }]]);
const ledgerStates = aggregateSessionActivity(['ledger-bg', 'ledger-idle', 'ledger-reopen', 'ledger-reset'], ledgerPanes, { statusDir: root, now: ledgerNow + 3, backgroundPanes: ledgerBackground });
assert.equal(ledgerStates['ledger-bg'].state, 'background');
assert.equal(ledgerStates['ledger-idle'].state, 'idle');
assert.equal(ledgerStates['ledger-reopen'].state, 'busy');
assert.equal(ledgerStates['ledger-reset'].state, 'idle');
writeLedger('ledger-equal', '0', [
  { eventName: 'PreToolUse', updatedAt: ledgerNow, sequence: 1, pid: 166, pidStartTicks: 1 },
  { eventName: 'Stop', updatedAt: ledgerNow, sequence: 2, pid: 166, pidStartTicks: 1 },
  { eventName: 'PostToolUse', updatedAt: ledgerNow, sequence: 3, pid: 166, pidStartTicks: 1 },
]);
assert.equal(aggregateSessionActivity(['ledger-equal'], paneMap([['ledger-equal', '0', 1, 166]]), { statusDir: root, now: ledgerNow + 1 })['ledger-equal'].state, 'idle');

const stopTranscript = path.join(os.tmpdir(), `mcw-stop-semantic-${process.pid}.jsonl`);
fs.writeFileSync(stopTranscript, JSON.stringify({ type: 'user', timestamp: new Date(ledgerNow - 20).toISOString(), message: { role: 'user', content: 'initial' } }) + '\n');
writeHooks([['stop-semantic', '0', 'idle', ledgerNow, 167, 1]]);
let stopHook = JSON.parse(fs.readFileSync(path.join(root, 'stop-semantic', '0.json'), 'utf8')); stopHook.transcriptPath = stopTranscript;
fs.writeFileSync(path.join(root, 'stop-semantic', '0.json'), JSON.stringify(stopHook));
writeLedger('stop-semantic', '0', [
  { eventName: 'UserPromptSubmit', updatedAt: ledgerNow - 10, sequence: 1, pid: 167, pidStartTicks: 1 },
  { eventName: 'Stop', updatedAt: ledgerNow, sequence: 2, pid: 167, pidStartTicks: 1 },
]);
const stopPane = paneMap([['stop-semantic', '0', 1, 167]]);
assert.equal(aggregateSessionActivity(['stop-semantic'], stopPane, { statusDir: root, now: ledgerNow + 1 })['stop-semantic'].state, 'idle');
fs.appendFileSync(stopTranscript, JSON.stringify({ type: 'tool_result', timestamp: new Date(ledgerNow + 2).toISOString(), output: 'late result' }) + '\n');
assert.equal(aggregateSessionActivity(['stop-semantic'], stopPane, { statusDir: root, now: ledgerNow + 3 })['stop-semantic'].state, 'idle');
fs.appendFileSync(stopTranscript, JSON.stringify({ type: 'user', timestamp: new Date(ledgerNow + 3).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'late', content: 'late native result' }] } }) + '\n');
assert.equal(aggregateSessionActivity(['stop-semantic'], stopPane, { statusDir: root, now: ledgerNow + 4 })['stop-semantic'].state, 'idle');
fs.appendFileSync(stopTranscript, JSON.stringify({ type: 'user', timestamp: new Date(ledgerNow + 4).toISOString(), message: { role: 'user', content: 'new human prompt' } }) + '\n');
assert.equal(aggregateSessionActivity(['stop-semantic'], stopPane, { statusDir: root, now: ledgerNow + 5 })['stop-semantic'].state, 'busy');
fs.appendFileSync(stopTranscript, JSON.stringify({ type: 'user', timestamp: new Date(ledgerNow + 6).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'open-turn', content: 'progress' }] } }) + '\n');
assert.equal(aggregateSessionActivity(['stop-semantic'], stopPane, { statusDir: root, now: ledgerNow + 7 })['stop-semantic'].state, 'busy');
fs.appendFileSync(stopTranscript, JSON.stringify({ type: 'assistant', timestamp: new Date(ledgerNow + 6).toISOString(), message: { role: 'assistant', stop_reason: null, content: [{ type: 'text', text: 'still working' }] } }) + '\n');
assert.equal(aggregateSessionActivity(['stop-semantic'], stopPane, { statusDir: root, now: ledgerNow + 8 })['stop-semantic'].state, 'busy');
fs.appendFileSync(stopTranscript, JSON.stringify({ type: 'user', timestamp: new Date(ledgerNow + 8).toISOString(), message: { role: 'user', content: '[Request interrupted by user]' } }) + '\n');
assert.equal(aggregateSessionActivity(['stop-semantic'], stopPane, { statusDir: root, now: ledgerNow + 9 })['stop-semantic'].state, 'idle');
fs.rmSync(stopTranscript, { force: true });

for (const [name, stopReason] of [['stop-end', 'end_turn'], ['stop-refusal', 'refusal']]) {
  const completedTranscript = path.join(os.tmpdir(), `mcw-${name}-${process.pid}.jsonl`);
  fs.writeFileSync(completedTranscript, `${JSON.stringify({ type: 'user', timestamp: new Date(ledgerNow + 20).toISOString(), message: { role: 'user', content: 'fresh human prompt' } })}\n${JSON.stringify({ type: 'assistant', timestamp: new Date(ledgerNow + 21).toISOString(), message: { role: 'assistant', stop_reason: stopReason, content: [{ type: 'text', text: 'completed' }] } })}\n`);
  writeHooks([[name, '0', 'idle', ledgerNow, 168, 1]]);
  const completedHook = JSON.parse(fs.readFileSync(path.join(root, name, '0.json'), 'utf8')); completedHook.transcriptPath = completedTranscript;
  fs.writeFileSync(path.join(root, name, '0.json'), JSON.stringify(completedHook));
  writeLedger(name, '0', [{ eventName: 'Stop', updatedAt: ledgerNow, sequence: 1, pid: 168, pidStartTicks: 1 }]);
  assert.equal(aggregateSessionActivity([name], paneMap([[name, '0', 1, 168]]), { statusDir: root, now: ledgerNow + 22 })[name].state, 'idle');
  fs.rmSync(completedTranscript, { force: true });
}

const ownersNow = Date.now();
const twoOwners = new Map([['two-owners\0' + '0', { session: 'two-owners', pane: '0', startedAt: 1, pids: [171, 172], processes: [{ pid: 171, startTicks: 1 }, { pid: 172, startTicks: 2 }], commands: [], cwd: null }]]);
writeHooks([['two-owners', '0', 'idle', ownersNow, 172, 2]]);
writeLedger('two-owners', '0', [
  { eventName: 'PreToolUse', toolUseId: 'a', updatedAt: ownersNow - 1, sequence: 1, pid: 171, pidStartTicks: 1 },
  { eventName: 'Stop', updatedAt: ownersNow, sequence: 2, pid: 172, pidStartTicks: 2 },
]);
const twoOwnerTranscript = path.join(os.tmpdir(), `mcw-two-owner-${process.pid}.jsonl`);
fs.writeFileSync(twoOwnerTranscript, JSON.stringify({ type: 'system', subtype: 'turn_duration', timestamp: new Date(ownersNow).toISOString() }) + '\n');
const twoOwnerHook = JSON.parse(fs.readFileSync(path.join(root, 'two-owners', '0.json'), 'utf8')); twoOwnerHook.transcriptPath = twoOwnerTranscript;
fs.writeFileSync(path.join(root, 'two-owners', '0.json'), JSON.stringify(twoOwnerHook));
assert.equal(aggregateSessionActivity(['two-owners'], twoOwners, { statusDir: root, now: ownersNow + 1 })['two-owners'].state, 'busy');
fs.appendFileSync(path.join(root, 'two-owners', '0.events.jsonl'), JSON.stringify({ eventName: 'Stop', updatedAt: ownersNow + 2, sequence: 3, pid: 171, pidStartTicks: 1 }) + '\n');
fs.appendFileSync(path.join(root, 'two-owners', '0.events.jsonl'), JSON.stringify({ eventName: 'PreToolUse', toolUseId: 'b', updatedAt: ownersNow + 3, sequence: 4, pid: 172, pidStartTicks: 2 }) + '\n');
assert.equal(aggregateSessionActivity(['two-owners'], twoOwners, { statusDir: root, now: ownersNow + 4 })['two-owners'].state, 'busy');
fs.rmSync(twoOwnerTranscript, { force: true });

const closedTranscript = path.join(os.tmpdir(), `mcw-closed-${process.pid}.jsonl`);
const closedAt = Date.now();
fs.writeFileSync(closedTranscript, `${JSON.stringify({ type: 'user', timestamp: new Date(closedAt).toISOString(), message: { role: 'user', content: 'work' } })}\n${JSON.stringify({ type: 'system', subtype: 'turn_duration', timestamp: new Date(closedAt + 1).toISOString() })}\n`);
writeHooks([['closed-turn', '0', 'busy', closedAt, 173, 1]]);
const closedHook = JSON.parse(fs.readFileSync(path.join(root, 'closed-turn', '0.json'), 'utf8')); closedHook.transcriptPath = closedTranscript;
fs.writeFileSync(path.join(root, 'closed-turn', '0.json'), JSON.stringify(closedHook));
const closedPane = paneMap([['closed-turn', '0', 1, 173]]);
assert.equal(aggregateSessionActivity(['closed-turn'], closedPane, { statusDir: root, now: closedAt + 2 })['closed-turn'].state, 'idle');
fs.appendFileSync(closedTranscript, JSON.stringify({ type: 'user', timestamp: new Date(closedAt + 3).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'late', content: 'x'.repeat(200000) }] } }) + '\n');
assert.equal(aggregateSessionActivity(['closed-turn'], closedPane, { statusDir: root, now: closedAt + 4 })['closed-turn'].state, 'idle');
fs.rmSync(closedTranscript, { force: true });

// One uniquely owned transcript has a baseline, a later growth sample, and an
// expired lease.  The state returns idle while the user event stays the stable
// ranking time instead of being replaced by the sampling clock.
const ownedTranscript = path.join(os.tmpdir(), `mcw-owned-${process.pid}.jsonl`);
const baseAt = Date.now() - 20_000;
fs.writeFileSync(ownedTranscript, JSON.stringify({ type: 'user', timestamp: new Date(baseAt).toISOString(), message: { role: 'user', content: 'baseline' } }) + '\n');
writeHooks([['owned', '0', 'idle', baseAt, 131, 1]]);
let ownedHook = JSON.parse(fs.readFileSync(path.join(root, 'owned', '0.json'), 'utf8')); ownedHook.transcriptPath = ownedTranscript;
fs.writeFileSync(path.join(root, 'owned', '0.json'), JSON.stringify(ownedHook));
const ownedPanes = paneMap([['owned', '0', 1, 131]]);
assert.equal(aggregateSessionActivity(['owned'], ownedPanes, { statusDir: root, now: baseAt + 1 }).owned.state, 'idle');
const growthAt = baseAt + 2;
fs.appendFileSync(ownedTranscript, JSON.stringify({ type: 'user', timestamp: new Date(growthAt).toISOString(), message: { role: 'user', content: 'growth' } }) + '\n');
assert.equal(aggregateSessionActivity(['owned'], ownedPanes, { statusDir: root, now: growthAt + 1 }).owned.state, 'busy');
const expiredLease = aggregateSessionActivity(['owned'], ownedPanes, { statusDir: root, now: growthAt + CLAIM_MAX_AGE_MS + 2 }).owned;
assert.equal(expiredLease.state, 'idle');
assert.equal(expiredLease.lastActivityAt, growthAt);

const twoLineTranscript = path.join(os.tmpdir(), `mcw-two-line-${process.pid}.jsonl`);
const twoLineAt = Date.now();
fs.writeFileSync(twoLineTranscript, JSON.stringify({ type: 'user', timestamp: new Date(twoLineAt).toISOString(), message: { role: 'user', content: 'human anchor' } }) + '\n');
writeHooks([['two-line', '0', 'idle', twoLineAt - 1, 181, 1]]);
const twoLineHook = JSON.parse(fs.readFileSync(path.join(root, 'two-line', '0.json'), 'utf8')); twoLineHook.transcriptPath = twoLineTranscript;
fs.writeFileSync(path.join(root, 'two-line', '0.json'), JSON.stringify(twoLineHook));
const twoLinePane = paneMap([['two-line', '0', 1, 181]]);
assert.equal(aggregateSessionActivity(['two-line'], twoLinePane, { statusDir: root, now: twoLineAt + 1 })['two-line'].state, 'idle');
fs.appendFileSync(twoLineTranscript, JSON.stringify({ type: 'assistant', timestamp: new Date(twoLineAt + 2).toISOString(), message: { role: 'assistant', stop_reason: null, content: [{ type: 'text', text: 'progress' }] } }) + '\n');
assert.equal(aggregateSessionActivity(['two-line'], twoLinePane, { statusDir: root, now: twoLineAt + 3 })['two-line'].state, 'busy');
fs.rmSync(twoLineTranscript, { force: true });

const crossingTranscript = path.join(os.tmpdir(), `mcw-crossing-${process.pid}.jsonl`);
const crossingAt = Date.now();
fs.writeFileSync(crossingTranscript, JSON.stringify({ type: 'user', timestamp: new Date(crossingAt).toISOString(), message: { role: 'user', content: 'human anchor before a large record' } }) + '\n');
writeHooks([['crossing', '0', 'idle', crossingAt - 1, 182, 1]]);
const crossingHook = JSON.parse(fs.readFileSync(path.join(root, 'crossing', '0.json'), 'utf8')); crossingHook.transcriptPath = crossingTranscript;
fs.writeFileSync(path.join(root, 'crossing', '0.json'), JSON.stringify(crossingHook));
const crossingPane = paneMap([['crossing', '0', 1, 182]]);
assert.equal(aggregateSessionActivity(['crossing'], crossingPane, { statusDir: root, now: crossingAt + 1 }).crossing.state, 'idle');
fs.appendFileSync(crossingTranscript, JSON.stringify({ type: 'assistant', timestamp: new Date(crossingAt + 2).toISOString(), message: { role: 'assistant', stop_reason: null, content: [{ type: 'text', text: '😀'.repeat(50000) }] } }) + '\n');
const crossing = aggregateSessionActivity(['crossing'], crossingPane, { statusDir: root, now: crossingAt + 3 }).crossing;
assert.equal(crossing.state, 'busy');
assert.equal(crossing.lastActivityAt, crossingAt + 2);
fs.appendFileSync(crossingTranscript, JSON.stringify({ type: 'assistant', timestamp: new Date(crossingAt + 4).toISOString(), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'x'.repeat(200000) }] } }) + '\n');
assert.equal(aggregateSessionActivity(['crossing'], crossingPane, { statusDir: root, now: crossingAt + 5 }).crossing.state, 'idle');
fs.rmSync(crossingTranscript, { force: true });
const unicodeMetadataTranscript = path.join(os.tmpdir(), `mcw-unicode-metadata-${process.pid}.jsonl`);
const unicodeAt = Date.now();
fs.writeFileSync(unicodeMetadataTranscript, `${JSON.stringify({ type: 'user', timestamp: new Date(unicodeAt).toISOString(), message: { role: 'user', content: 'anchor' } })}\n${JSON.stringify({ type: 'assistant', timestamp: new Date(unicodeAt + 1).toISOString(), message: { role: 'assistant', stop_reason: null, content: [{ type: 'text', text: '😀'.repeat(50000) }] } })}\n`);
writeHooks([['unicode-metadata', '0', 'idle', unicodeAt - 1, 183, 1]]);
const unicodeHook = JSON.parse(fs.readFileSync(path.join(root, 'unicode-metadata', '0.json'), 'utf8')); unicodeHook.transcriptPath = unicodeMetadataTranscript;
fs.writeFileSync(path.join(root, 'unicode-metadata', '0.json'), JSON.stringify(unicodeHook));
const unicodePane = paneMap([['unicode-metadata', '0', 1, 183]]);
assert.equal(aggregateSessionActivity(['unicode-metadata'], unicodePane, { statusDir: root, now: unicodeAt + 2 })['unicode-metadata'].state, 'idle');
fs.appendFileSync(unicodeMetadataTranscript, JSON.stringify({ type: 'system', subtype: 'local_command', timestamp: new Date(unicodeAt + 3).toISOString(), content: 'metadata only' }) + '\n');
const unicodeMetadata = aggregateSessionActivity(['unicode-metadata'], unicodePane, { statusDir: root, now: unicodeAt + 4 })['unicode-metadata'];
assert.equal(unicodeMetadata.state, 'idle');
assert.equal(unicodeMetadata.lastActivityAt, unicodeAt + 1);
fs.rmSync(unicodeMetadataTranscript, { force: true });

const firstToolTranscript = path.join(root, 'first-tool.jsonl');
fs.writeFileSync(firstToolTranscript, JSON.stringify({ type: 'assistant', timestamp: new Date(crossingAt).toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'first', name: 'Bash', input: {} }] } }) + '\n');
writeHooks([['first-tool', '0', 'idle', crossingAt - 1, 183, 1]]);
const firstToolHookPath = path.join(root, 'first-tool', '0.json');
fs.writeFileSync(firstToolHookPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(firstToolHookPath, 'utf8')), transcriptPath: firstToolTranscript }));
const firstToolPane = paneMap([['first-tool', '0', 1, 183]]);
assert.equal(aggregateSessionActivity(['first-tool'], firstToolPane, { statusDir: root, now: crossingAt + 1 })['first-tool'].state, 'idle');
fs.appendFileSync(firstToolTranscript, JSON.stringify({ type: 'user', timestamp: new Date(crossingAt + 2).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'first', content: 'progress' }] } }) + '\n');
assert.equal(aggregateSessionActivity(['first-tool'], firstToolPane, { statusDir: root, now: crossingAt + 3 })['first-tool'].state, 'busy');
fs.rmSync(transcript, { force: true }); fs.rmSync(ownedTranscript, { force: true });
const responseHookRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcw-response-hook-'));
const responseHook = spawnSync(path.join(import.meta.dirname, '..', 'bin', 'mcw-session-status'), ['idle', 'stop'], {
  env: { ...process.env, MCW_STATE_DIR: responseHookRoot, ZELLIJ_SESSION_NAME: 'response-writer', ZELLIJ_PANE_ID: '0' },
  input: JSON.stringify({ hook_event_name: 'Stop' }),
});
assert.equal(responseHook.status, 0);
const writtenResponse = JSON.parse(fs.readFileSync(path.join(responseHookRoot, 'session-status', 'response-writer', '0.response.json'), 'utf8'));
assert.ok(Number.isInteger(writtenResponse.pid) && writtenResponse.pid > 0);
assert.ok(Number.isInteger(writtenResponse.pidStartTicks) && writtenResponse.pidStartTicks > 0);
const writtenHookEvent = JSON.parse(fs.readFileSync(path.join(responseHookRoot, 'session-status', 'response-writer', '0.events.jsonl'), 'utf8'));
assert.ok(Number.isInteger(writtenHookEvent.bootTicks) && writtenHookEvent.bootTicks > writtenResponse.pidStartTicks);
fs.rmSync(responseHookRoot, { recursive: true, force: true });
fs.rmSync(root, { recursive: true, force: true });
console.log(`status reliability fixtures: ${cases.length} cases plus stale file, shared transcript growth, expiry, interrupt marker, large records, re-arm, live tool, broker, background terminal, future candidate, identity mismatch, and bounded owned growth: PASS`);
