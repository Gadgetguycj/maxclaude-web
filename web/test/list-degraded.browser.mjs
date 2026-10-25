// Regression test for the "agent is disconnected" banner, real browser (hub 1.10.0).
//
// The banner said the agent was disconnected and the tree read-only whenever one sessions.list
// read failed, because the hub folded that failure into agent.connected. A slow zellij fails
// that read now and then while the agent link is fine. This runs the real hub and app.js with a
// scripted agent whose sessions.list fails on demand, and checks:
//   - while the agent link is up and the list read fails, no disconnected banner, the agent dot
//     stays green, a small "Session list is slow" notice shows in the sidebar, the rows stay, the
//     tree's buttons stay enabled, and a session still opens from the last good list;
//   - the notice goes once the list answers again;
//   - a real disconnect still shows the banner.
//
//   node test/list-degraded.browser.mjs
import assert from 'node:assert/strict';
import { ScriptedAgent, startHub, launchBrowser, login, wait, report } from './view-harness.mjs';

const PORT = 18421;
const SECRET = 'list-degraded-secret';
const PASSWORD = 'list-degraded-password';
const NAMES = ['slow-a', 'slow-b', 'slow-c'];
const SHOTS = process.env.MCW_SHOT_DIR || '';

const hub = await startHub({ port: PORT, secret: SECRET, password: PASSWORD });
const agent = new ScriptedAgent(SECRET, NAMES);
let browser;
const passed = [];
const pass = report(passed);

try {
  await agent.connect(`${hub.origin.replace(/^http/, 'ws')}/agent`);
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await login(page, hub.origin, PASSWORD);
  await page.waitForFunction((count) => document.querySelectorAll('#tree .row[data-kind="unfiled"]').length === count, NAMES.length);

  const read = () => page.evaluate(() => ({
    banner: document.getElementById('banner').hidden ? null : document.getElementById('banner').textContent,
    notice: document.getElementById('list-notice')?.hidden === false ? document.getElementById('list-notice').textContent : null,
    dot: document.getElementById('agent-dot').className,
    agentDown: document.body.classList.contains('agent-down'),
    rows: [...document.querySelectorAll('#tree .row[data-kind="unfiled"]')].map((row) => row.dataset.name).sort(),
    newSession: document.getElementById('new-session-root').disabled,
    newFolder: document.getElementById('new-folder-root').disabled,
  }));

  const before = await read();
  assert.equal(before.banner, null);
  assert.equal(before.notice, null);
  pass('a healthy list shows neither the banner nor the slow notice');

  // The list read now fails the way a slow zellij makes it fail. The page polls every 4 s.
  agent.listError = { code: 'upstream_unavailable', message: 'zellij list-sessions failed' };
  const failedAt = Date.now();
  // Three or more polls fail. The banner must never appear.
  const samples = [];
  while (Date.now() - failedAt < 13000) {
    samples.push(await read());
    await wait(250);
  }
  const during = samples.at(-1);
  assert.ok(samples.every((sample) => sample.banner === null), `the disconnected banner appeared: ${JSON.stringify(samples.find((sample) => sample.banner))}`);
  assert.ok(samples.every((sample) => !sample.agentDown), 'the page marked the agent down');
  assert.match(during.notice, /^Session list is slow\. Showing the list from \d+s ago\.$/);
  assert.match(during.dot, /st-running/);
  assert.deepEqual(during.rows, [...NAMES].sort());
  assert.equal(during.newSession, false);
  assert.equal(during.newFolder, false);
  pass(`${samples.length} samples over ${Math.round((Date.now() - failedAt) / 1000)} s of failed list reads: no banner, dot green, notice "${during.notice}", rows kept, buttons enabled`);

  const state = await page.evaluate(async () => (await fetch('/api/state')).json());
  assert.equal(state.agent.connected, true);
  assert.equal(state.sessions_degraded.error, 'upstream_unavailable');
  assert.ok(state.sessions_degraded.last_good_at > 0);
  assert.deepEqual(state.sessions.map((session) => session.name).sort(), [...NAMES].sort());
  pass('the hub reports agent.connected true, sessions_degraded, and the last good list');

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/list-degraded-1440.png` });

  // A session opens from the last good list while the list read still fails.
  await page.click('#tree .row[data-kind="unfiled"][data-name="slow-b"]');
  await page.waitForFunction(() => document.querySelector('#term-title .term-name')?.textContent === 'slow-b', null, { timeout: 10000 });
  assert.equal(await page.evaluate(() => document.getElementById('banner').hidden), true);
  pass('a session opens from the last good list while the list is slow');

  agent.listError = null;
  await page.waitForFunction(() => document.getElementById('list-notice').hidden, null, { timeout: 15000 });
  pass('the slow notice goes once the list answers again');

  // A list that answers 9 s late, as under heavy load, shows the notice after 5 s, not a
  // banner, and the page keeps polling instead of waiting on the read.
  agent.listDelayMs = 9000;
  const lateAt = Date.now();
  await page.waitForFunction(() => !document.getElementById('list-notice').hidden, null, { timeout: 15000 });
  const lateNotice = Date.now() - lateAt;
  const late = await read();
  assert.equal(late.banner, null);
  assert.match(late.dot, /st-running/);
  assert.deepEqual(late.rows, [...NAMES].sort());
  agent.listDelayMs = 0;
  await page.waitForFunction(() => document.getElementById('list-notice').hidden, null, { timeout: 25000 });
  pass(`a list read 9 s late shows the slow notice after ${(lateNotice / 1000).toFixed(1)} s with no banner, and it clears when reads are fast again`);

  // A real disconnect is still a disconnect.
  agent.close();
  await page.waitForFunction(() => !document.getElementById('banner').hidden, null, { timeout: 15000 });
  const down = await read();
  assert.match(down.banner, /disconnected/);
  assert.equal(down.notice, null, 'the slow notice is not shown while the agent is away');
  pass('a dropped agent link still shows the disconnected banner, without the slow notice');

  assert.deepEqual(errors, []);
  pass('no page errors');
  console.log(`\n${passed.length} checks passed`);
} finally {
  await browser?.close();
  agent.close();
  hub.stop();
}
