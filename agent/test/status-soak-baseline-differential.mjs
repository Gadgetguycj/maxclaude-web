import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { evaluateSample } from './status-soak-oracle.mjs';

const mode = process.argv[2] || 'final';
const baseline = process.argv[3] || '/tmp/mcw-astra-current-ty6yi7/agent/test/status-soak.sh';
const now = Date.parse('2026-09-30T12:00:00.000Z');

function evidence({ claude = true, hidden = false } = {}) {
  return {
    healthy: true,
    full: true,
    processes: claude ? [{ session: 'stable', pane: '0', pid: '1', start_ticks: '100', is_claude: true }] : [],
    screens: claude ? [{ session: 'stable', pane: '0', marker: 'prompt', viewport_captured: true, exited: false }] : [],
    transcripts: [],
    zellij_sessions: claude ? ['stable'] : [],
    hidden_sessions: hidden ? ['nap'] : [],
  };
}

function finalCases() {
  const stable = evidence();
  const body = (session_status) => ({ agent: { connected: true, error: null }, sessions: [], session_status });
  const oneSided = evaluateSample({ sampled_at_ms: now,
    endpoints: { start: { transport_ok: true, body: body({ stable: { state: 'idle' } }) }, end: { transport_ok: true, body: body({ stable: { state: 'busy' } }) } },
    evidence: { pre: stable, middle: stable, post: stable } });
  assert.deepEqual(oneSided.raw_disagreements.map((row) => [row.endpoint, row.kind]), [['end', 'false_green']]);
  const absent = evidence({ claude: false });
  const forgedSleeping = evaluateSample({ sampled_at_ms: now,
    endpoints: { start: { transport_ok: true, body: body({ nap: { state: 'sleeping' } }) }, end: { transport_ok: true, body: body({ nap: { state: 'sleeping' } }) } },
    evidence: { pre: absent, middle: absent, post: absent } });
  assert.equal(forgedSleeping.raw_disagreements.length, 2);
  assert.ok(forgedSleeping.raw_disagreements.every((row) => row.expected.state === 'no_claude'));
}

function oldDecoderCases() {
  const source = fs.readFileSync(baseline, 'utf8');
  const match = source.match(/--rawfile previous "\$previous_file" '\n([\s\S]*?)\n    ' >"\$result_file"/);
  assert.ok(match, 'the frozen v20 decoder filter must be extractable');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcw-v20-decoder-'));
  const write = (name, text) => { const file = path.join(temp, name); fs.writeFileSync(file, text); return file; };
  const filter = write('decoder.jq', match[1]);
  const api = (state) => write(`api-${state}.json`, JSON.stringify({ session_status: { stable: { state } }, sessions: [] }));
  const processes = write('processes.tsv', '1\t0\t100\tS\tstable\t0\tid\t1\t1\t0\tclaude\n');
  const screens = write('screens.tsv', 'stable\t0\tfull\tviewport\tprompt\tfalse\t\ttrue\ttrue\thash\n');
  const empty = write('empty.tsv', '');
  const previous = write('previous.json', '{}\n');
  const run = (start, end, proc = processes, screen = screens) => {
    const result = spawnSync('jq', ['-cn', '--arg', 'sampled_at', '2026-09-30T12:00:00.000Z', '--arg', 'process_start_at', '2026-09-30T12:00:00.000Z', '--arg', 'process_end_at', '2026-09-30T12:00:00.000Z', '--argjson', 'sampled_at_ms', String(now), '--argjson', 'transcript_claim_max_age_ms', '90000', '--arg', 'finished_at', '2026-09-30T12:00:01.000Z', '--argjson', 'scheduled_at_ms', String(now), '--argjson', 'finished_at_ms', String(now + 1000), '--arg', 'raw_dir', temp, '--slurpfile', 'api_start', api(start), '--slurpfile', 'api_end', api(end), '--rawfile', 'processes', proc, '--rawfile', 'processes_start', proc, '--rawfile', 'processes_end', proc, '--rawfile', 'transcripts', empty, '--rawfile', 'screens', screen, '--rawfile', 'previous', previous, '-f', filter], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const oneSided = run('idle', 'busy');
  const absentProcesses = write('absent.tsv', '');
  const absentScreens = write('absent-screens.tsv', '');
  const sleeping = run('sleeping', 'sleeping', absentProcesses, absentScreens);
  // These are the requirements. The v20 decoder suppresses both, so this function
  // intentionally fails when executed against the frozen source.
  assert.deepEqual({
    one_sided_busy_end_recorded: oneSided.mismatches.some((row) => row.name === 'stable' && row.reported_end_state === 'busy'),
    forged_sleeping_recorded_as_no_claude: sleeping.mismatches.some((row) => row.name === 'stable' && row.ground_truth_state === 'no_claude'),
  }, {
    one_sided_busy_end_recorded: true,
    forged_sleeping_recorded_as_no_claude: true,
  }, 'the frozen decoder suppresses both required disagreements');
}

if (mode === 'baseline') oldDecoderCases();
else if (mode === 'final') finalCases();
else assert.fail('usage: status-soak-baseline-differential.mjs baseline [sampler] | final');
console.log(`status soak differential ${mode}: passed`);
