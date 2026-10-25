import assert from 'node:assert/strict';
import { evaluateSample, validateSoak } from './status-soak-oracle.mjs';

const now = Date.parse('2026-09-30T12:00:00.000Z');
const idleEvidence = () => ({ healthy: true, processes: [{ session: 'idle', pane: '0', is_claude: true, pid: '42', start_ticks: '100' }], screens: [{ session: 'idle', pane: '0', marker: 'prompt' }], transcripts: [], zellij_sessions: ['idle'], hidden_sessions: [] });
const noClaudeEvidence = () => ({ healthy: true, processes: [], screens: [], transcripts: [], zellij_sessions: [], hidden_sessions: [] });
const input = ({ start, end, pre = idleEvidence(), middle = idleEvidence(), post = idleEvidence() }) => ({
  sampled_at_ms: now,
  endpoints: { start: { transport_ok: true, body: { agent: { connected: true, error: null }, sessions: [], session_status: start } }, end: { transport_ok: true, body: { agent: { connected: true, error: null }, sessions: [], session_status: end } } },
  evidence: { pre, middle, post },
});

// A stable Claude identity does not prove activity. Different bracket evidence stays uncertain.
{
  const busy = { ...idleEvidence(), full: true, screens: [{ session: 'idle', marker: 'foreground', pane: '0' }] };
  const idle = { ...idleEvidence(), full: true, screens: [{ session: 'idle', marker: 'prompt', pane: '0' }] };
  const result = evaluateSample(input({ start: { idle: { state: 'idle' } }, end: { idle: { state: 'busy' } }, pre: idle, middle: busy, post: idle }));
  assert.equal(result.uncertain_audits.length, 2);
  assert.equal(result.raw_disagreements.length, 2);
  assert.ok(result.raw_disagreements.every((row) => row.kind === 'unresolved_transition_disagreement'));
}

// A response with an agent error or a missing live session inventory is incomplete.
{
  const bad = input({ start: { idle: { state: 'idle' } }, end: { idle: { state: 'idle' } } });
  bad.endpoints.start.body.agent.error = 'agent scan failed';
  bad.endpoints.end.body.sessions = null;
  assert.equal(evaluateSample(bad).api_complete, false);
}

// The review's one-sided failure: an idle start no longer hides an erroneous busy end.
{
  const result = evaluateSample(input({ start: { idle: { state: 'idle' } }, end: { idle: { state: 'busy' } } }));
  assert.deepEqual(result.raw_disagreements.map((row) => [row.endpoint, row.kind]), [['end', 'false_green']]);
  assert.equal(result.uncertain_audits.length, 0);
}

// Sleeping derives only from independently sampled maxagent metadata plus pane absence.
{
  const sleeping = { ...noClaudeEvidence(), hidden_sessions: ['nap'] };
  const result = evaluateSample(input({ start: { nap: { state: 'sleeping' } }, end: { nap: { state: 'sleeping' } }, pre: sleeping, middle: sleeping, post: sleeping }));
  assert.equal(result.raw_disagreements.length, 0);
  const forged = evaluateSample(input({ start: { nap: { state: 'sleeping' } }, end: { nap: { state: 'sleeping' } }, pre: noClaudeEvidence(), middle: noClaudeEvidence(), post: noClaudeEvidence() }));
  assert.equal(forged.raw_disagreements.length, 2);
  assert.ok(forged.raw_disagreements.every((row) => row.expected.state === 'no_claude'));
}

// A candidate Claude with inherited variables from a closed pane does not count as a live owner.
{
  const closedPane = { healthy: true, processes: [{ session: 'closed', pane: '9', is_claude: true }], screens: [{ session: 'closed', pane: '2', marker: 'prompt' }], transcripts: [], zellij_sessions: ['closed'], hidden_sessions: [] };
  const result = evaluateSample(input({ start: { closed: { state: 'busy' } }, end: { closed: { state: 'busy' } }, pre: closedPane, middle: closedPane, post: closedPane }));
  assert.deepEqual(result.raw_disagreements.map((row) => row.kind), ['false_green', 'false_green']);
}

// “Waiting for background” can remain painted after work ended. A viewport alone is not background proof.
{
  const stale = { ...idleEvidence(), screens: [{ session: 'idle', pane: '0', marker: 'background' }] };
  const result = evaluateSample(input({ start: { idle: { state: 'background' } }, end: { idle: { state: 'background' } }, pre: stale, middle: stale, post: stale }));
  assert.equal(result.uncertain_audits.length, 2);
  assert.equal(result.raw_disagreements.length, 0);
}

// A changed system bracket is an audit record. It is never accepted because one endpoint happened to agree.
{
  const busy = { ...idleEvidence(), screens: [{ session: 'idle', pane: '0', marker: 'foreground' }] };
  const result = evaluateSample(input({ start: { idle: { state: 'idle' } }, end: { idle: { state: 'busy' } }, pre: idleEvidence(), middle: busy, post: busy }));
  assert.equal(result.raw_disagreements.length, 1);
  assert.equal(result.raw_disagreements[0].kind, 'unresolved_transition_disagreement');
  assert.equal(result.uncertain_audits.length, 1);
  assert.equal(result.uncertain_audits[0].endpoint, 'start');
}

// Incomplete transport and a cadence gap fail a claimed complete soak.
{
  const good = evaluateSample({ ...input({ start: { idle: { state: 'idle' } }, end: { idle: { state: 'idle' } } }), sampled_at_ms: now, finished_at_ms: now + 100 });
  const late = { ...good, sampled_at_ms: now + 17_000, finished_at_ms: now + 17_100, api_complete: false };
  const result = validateSoak([good, late], { complete: true, requiredSamples: 2, intervalMs: 15_000 });
  assert.equal(result.ok, false);
  assert.ok(result.collection_failures.some((failure) => failure.includes('incomplete_api')));
  assert.ok(result.collection_failures.some((failure) => failure.includes('cadence_gap')));
}

// A completed collection stays reviewable when it found a state error. Collection and audit outcomes are separate.
{
  const badStatus = evaluateSample({ ...input({ start: { idle: { state: 'busy' } }, end: { idle: { state: 'busy' } } }), sampled_at_ms: now, finished_at_ms: now + 100 });
  const result = validateSoak([badStatus], { complete: false, requiredSamples: 1 });
  assert.equal(result.collection_ok, true);
  assert.equal(result.status_ok, false);
}

console.log('status-soak oracle tests: 9 passed');
