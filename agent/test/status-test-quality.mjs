import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcw-terminal-quality-'));
const now = Date.now();
function panes() { return new Map([['quality\0' + '0', { session: 'quality', pane: '0', startedAt: 1, pids: [7], processes: [{ pid: 7, startTicks: 1 }], commands: [], cwd: null }]]); }
function fixture(dir) {
  fs.mkdirSync(path.join(dir, 'quality'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'quality', '0.json'), JSON.stringify({ state: 'busy', updatedAt: now - 2, pid: 7, pidStartTicks: 1 }));
  fs.writeFileSync(path.join(dir, 'quality', '0.events.jsonl'), JSON.stringify({ eventName: 'UserPromptSubmit', sequence: 1, updatedAt: now - 2, pid: 7, pidStartTicks: 1 }) + '\n');
  const transcript = path.join(dir, 'terminal.jsonl');
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', timestamp: new Date(now - 2).toISOString(), message: { role: 'user', content: 'work' } })}\n${JSON.stringify({ type: 'user', timestamp: new Date(now - 1).toISOString(), message: { role: 'user', content: '[Request interrupted by user]' } })}\n`);
  return transcript;
}
async function state(moduleUrl, dir) {
  const { aggregateSessionActivity } = await import(moduleUrl);
  const transcript = fixture(dir); panes().get('quality\0' + '0').commands = [['claude', '--resume', transcript]];
  const pane = panes(); pane.get('quality\0' + '0').commands = [['claude', '--resume', transcript]];
  return aggregateSessionActivity(['quality'], pane, { statusDir: dir, now }).quality.state;
}
const source = new URL('../src/status.js', import.meta.url).href;
assert.equal(await state(source, root), 'idle');
const mutant = fs.mkdtempSync(path.join(os.tmpdir(), 'mcw-terminal-mutant-'));
fs.mkdirSync(path.join(mutant, 'src'));
for (const file of ['status.js', 'config.js']) fs.copyFileSync(new URL(`../src/${file}`, import.meta.url), path.join(mutant, 'src', file));
const mutantStatus = path.join(mutant, 'src', 'status.js');
fs.writeFileSync(mutantStatus, fs.readFileSync(mutantStatus, 'utf8').replace('function isTerminalTranscriptRecord(record) {', 'function isTerminalTranscriptRecord(record) { return false; /* mutant */'));
assert.equal(await state(`file://${mutantStatus}`, path.join(mutant, 'state')), 'busy');
console.log('terminal and interrupt quality mutant: green-red PASS');
