#!/usr/bin/env node
// This oracle deliberately has no dependency on the agent or hub status implementation.
// Its input is a capture made from procfs, Zellij, transcripts, screens, and maxagent metadata.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const ACTIVE = new Set(['busy', 'background']);

function rowsFromEndpoint(endpoint = {}) {
  const body = endpoint.body || {};
  const direct = body.session_status && typeof body.session_status === 'object' ? body.session_status : {};
  const rows = new Map(Object.entries(direct).map(([name, row]) => [name, row && typeof row === 'object' ? row : { state: row }]));
  for (const session of Array.isArray(body.sessions) ? body.sessions : []) {
    if (!session?.name || rows.has(session.name)) continue;
    rows.set(session.name, { state: session.activity ?? session.state ?? 'unknown' });
  }
  return rows;
}

function stateOfEvidence(evidence, name, sampledAtMs, previous) {
  if (!evidence?.healthy) return { state: 'uncertain', reason: 'collection_failed' };
  const screens = (evidence.screens || []).filter((row) => row.session === name && !row.exited);
  const activePaneIds = new Set(screens.map((row) => String(row.pane)));
  // The environment identifies a candidate pane. The current native Zellij inventory
  // confirms it. A detached process from a closed pane cannot establish a live Claude.
  const candidateClaudes = (evidence.processes || []).filter((row) => row.session === name && row.is_claude);
  const claudes = evidence.full === false ? candidateClaudes : candidateClaudes.filter((row) => activePaneIds.has(String(row.pane)));
  const hidden = (evidence.hidden_sessions || []).includes(name);
  const liveSession = (evidence.zellij_sessions || []).includes(name);
  if (!claudes.length) {
    return hidden && !liveSession
      ? { state: 'sleeping', reason: 'hidden_metadata_without_live_zellij_session' }
      : { state: 'no_claude', reason: 'no_live_claude_process' };
  }
  if (screens.some((row) => row.viewport_captured === false)) return { state: 'uncertain', reason: 'active_pane_screen_capture_failed' };
  if (screens.some((row) => row.marker === 'foreground')) return { state: 'busy', reason: 'visible_foreground_screen' };
  if ((evidence.processes || []).some((row) => row.session === name && row.is_background_shell)) return { state: 'background', reason: 'live_shell_snapshot_process' };
  // A Zellij viewport can retain “Waiting for background” after an interrupt or
  // an API failure. Only a current, root-owned shell execution proves background.
  if (screens.some((row) => row.marker === 'background')) return { state: 'uncertain', reason: 'background_screen_without_live_owned_task' };
  if (screens.some((row) => row.marker === 'interrupted' || row.marker === 'prompt')) return { state: 'idle', reason: 'visible_prompt_or_interrupt' };
  const old = new Map((previous?.transcripts || []).map((row) => [`${row.session}\0${row.pane}\0${row.pid}\0${row.start_ticks}`, row]));
  const freshTurn = (evidence.transcripts || []).some((row) => {
    if (row.session !== name || !['prompt', 'tool'].includes(row.turn_kind)) return false;
    const then = Date.parse(row.turn_at || '');
    const key = `${row.session}\0${row.pane}\0${row.pid}\0${row.start_ticks}`;
    const before = old.get(key);
    return Number.isFinite(then) && then >= sampledAtMs - 90_000 && (!before || before.size !== row.size || before.fingerprint !== row.fingerprint);
  });
  if (freshTurn) return { state: 'busy', reason: 'fresh_owned_transcript_turn' };
  return { state: 'uncertain', reason: 'no_current_screen_or_growth_evidence' };
}

function bracketState(left, right, name, sampledAtMs, oldLeft, oldRight) {
  const before = stateOfEvidence(left, name, sampledAtMs, oldLeft);
  const after = stateOfEvidence(right, name, sampledAtMs, oldRight);
  if (before.state === after.state && before.state !== 'uncertain') return { state: before.state, before, after };
  return { state: 'uncertain', before, after, reason: before.state === after.state ? before.reason : 'system_evidence_changed_inside_endpoint_bracket' };
}

function normalize(state) {
  return state === 'absent' ? 'no_claude' : (typeof state === 'string' ? state : 'unknown');
}

export function evaluateSample(input) {
  const sampledAtMs = Number(input.sampled_at_ms) || Date.now();
  const evidence = input.evidence || {};
  const startRows = rowsFromEndpoint(input.endpoints?.start);
  const endRows = rowsFromEndpoint(input.endpoints?.end);
  const names = new Set([...startRows.keys(), ...endRows.keys()]);
  for (const capture of Object.values(evidence)) {
    for (const row of capture?.processes || []) if (row.session) names.add(row.session);
    for (const row of capture?.screens || []) if (row.session) names.add(row.session);
    for (const name of capture?.hidden_sessions || []) names.add(name);
  }
  const endpointAudits = [];
  const rawDisagreements = [];
  const uncertainAudits = [];
  for (const name of [...names].sort()) {
    const checks = [
      ['start', startRows.get(name), bracketState(evidence.pre, evidence.middle, name, sampledAtMs, input.previous?.pre, input.previous?.middle)],
      ['end', endRows.get(name), bracketState(evidence.middle, evidence.post, name, sampledAtMs, input.previous?.middle, input.previous?.post)],
    ];
    for (const [endpoint, row, expected] of checks) {
      const reportedRaw = row?.state ?? 'unknown';
      const reported = normalize(reportedRaw);
      const audit = { name, endpoint, reported_raw: reportedRaw, reported, expected, api_present: Boolean(row) };
      endpointAudits.push(audit);
      if (expected.state === 'uncertain') {
        const evidenceStates = [expected.before?.state, expected.after?.state].filter((state) => state && state !== 'uncertain');
        const differsFrom = evidenceStates.filter((state) => state !== reported);
        const unresolved = { ...audit, audit: 'unresolved_system_transition_or_collection', evidence_states: evidenceStates, differs_from_evidence_states: differsFrom };
        uncertainAudits.push(unresolved);
        // A transition is not a pass. Preserve every endpoint disagreement with either
        // directly observed side for the reviewer, while keeping its uncertain context.
        if (differsFrom.length) rawDisagreements.push({ ...unresolved, kind: 'unresolved_transition_disagreement' });
      } else if (reported !== expected.state) {
        const kind = ACTIVE.has(reported) && !ACTIVE.has(expected.state) ? 'false_green'
          : reported === 'idle' && ACTIVE.has(expected.state) ? 'false_idle' : 'state_mismatch';
        rawDisagreements.push({ ...audit, kind });
      }
    }
  }
  const apiComplete = ['start', 'end'].every((key) => {
    const endpoint = input.endpoints?.[key];
    return endpoint?.transport_ok === true && endpoint?.body && typeof endpoint.body === 'object' && !endpoint.body.error &&
      endpoint.body.session_status && typeof endpoint.body.session_status === 'object' && !Array.isArray(endpoint.body.session_status) &&
      Array.isArray(endpoint.body.sessions) && endpoint.body.agent && typeof endpoint.body.agent === 'object' &&
      endpoint.body.agent.connected === true && endpoint.body.agent.error == null;
  });
  const evidenceComplete = ['pre', 'middle', 'post'].every((key) => evidence[key]?.healthy === true);
  return { sampled_at: input.sampled_at, sampled_at_ms: sampledAtMs, scheduled_at_ms: input.scheduled_at_ms,
    finished_at_ms: input.finished_at_ms, api_complete: apiComplete, evidence_complete: evidenceComplete, collection_complete: apiComplete && evidenceComplete, endpoint_audits: endpointAudits,
    raw_disagreements: rawDisagreements, uncertain_audits: uncertainAudits, evidence: input.evidence, raw_dir: input.raw_dir };
}

export function validateSoak(samples, { intervalMs = 15_000, requiredSamples = 121, complete = false } = {}) {
  const collectionFailures = [];
  const auditFailures = [];
  if (complete && samples.length !== requiredSamples) collectionFailures.push(`sample_count=${samples.length}, required=${requiredSamples}`);
  if (complete && samples.length > 1 && samples.at(-1).sampled_at_ms - samples[0].sampled_at_ms < 1_800_000) collectionFailures.push('duration_below_1800_seconds');
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    if (!sample.api_complete) collectionFailures.push(`sample_${index + 1}_incomplete_api`);
    if (!sample.evidence_complete) collectionFailures.push(`sample_${index + 1}_incomplete_system_evidence`);
    if ((sample.uncertain_audits || []).length) auditFailures.push(`sample_${index + 1}_uncertain_evidence`);
    if ((sample.raw_disagreements || []).length) auditFailures.push(`sample_${index + 1}_raw_disagreements`);
    if (index && sample.sampled_at_ms - samples[index - 1].sampled_at_ms > intervalMs + 1_000) collectionFailures.push(`sample_${index + 1}_cadence_gap_ms=${sample.sampled_at_ms - samples[index - 1].sampled_at_ms}`);
    if (sample.finished_at_ms && sample.sampled_at_ms && sample.finished_at_ms - sample.sampled_at_ms > intervalMs) collectionFailures.push(`sample_${index + 1}_collection_overran_interval`);
  }
  const collectionOk = collectionFailures.length === 0;
  const statusOk = auditFailures.length === 0;
  return { complete, samples: samples.length, raw_disagreements: samples.reduce((n, s) => n + (s.raw_disagreements || []).length, 0), uncertain_audits: samples.reduce((n, s) => n + (s.uncertain_audits || []).length, 0), collection_failures: collectionFailures, audit_failures: auditFailures, collection_ok: collectionOk, status_ok: statusOk, ok: collectionOk && statusOk };
}

function main(args) {
  if (args[0] === '--input') {
    process.stdout.write(`${JSON.stringify(evaluateSample(JSON.parse(fs.readFileSync(args[1], 'utf8'))))}\n`);
    return;
  }
  if (args[0] === '--verify') {
    const samples = fs.readFileSync(args[1], 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const options = { intervalMs: Number(args[args.indexOf('--interval-ms') + 1] || 15_000), requiredSamples: Number(args[args.indexOf('--required-samples') + 1] || 121), complete: args.includes('--complete') };
    const result = validateSoak(samples, options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    // A complete collection remains an auditable result when status mismatches occur.
    // Transport, timing, and evidence-capture failures are the only CLI failure.
    if (!result.collection_ok) process.exitCode = 1;
    return;
  }
  assert.fail('usage: status-soak-oracle.mjs --input FILE | --verify SAMPLES [--complete]');
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
