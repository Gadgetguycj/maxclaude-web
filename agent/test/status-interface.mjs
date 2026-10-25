import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/status.js', import.meta.url), 'utf8');
assert.doesNotMatch(source, /readProcessSnapshot\(procRoot = '\/proc', now = Date\.now\(\), minBackgroundAgeMs/);
assert.doesNotMatch(source, /readLiveBackgroundPanes\(procRoot = '\/proc', now = Date\.now\(\), minAgeMs/);
assert.doesNotMatch(source, /fallbackSequence/);
assert.doesNotMatch(source, /return \{ pane, status, transcriptPath, processBackground, hasBackgroundProcess, recordedCandidate, recorded, tools, toolAt, hook \}/);
console.log('status interface has no dead inventory arguments or pane fields: PASS');
