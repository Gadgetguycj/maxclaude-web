import assert from 'node:assert/strict';
import { ScriptedAgent, startHub, launchBrowser, login } from './view-harness.mjs';

const port = 18429;
const secret = 'async-open-secret';
const password = 'async-open-password';
const names = Array.from({ length: 25 }, (_, i) => `bench-${String(i + 1).padStart(2, '0')}`);
const hub = await startHub({ port, secret, password });
const agent = new ScriptedAgent(secret, names);
agent.listDelayMs = 7000;
agent.fastListDelayMs = 0;
let browser;
try {
  await agent.connect(`${hub.origin.replace(/^http/, 'ws')}/agent`);
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => {
    window.__longTasks = [];
    new PerformanceObserver((list) => {
      for (const task of list.getEntries()) window.__longTasks.push(task.duration);
    }).observe({ type: 'longtask', buffered: true });
  });
  const started = Date.now();
  await login(page, hub.origin, password);
  await page.waitForFunction(() => document.querySelectorAll('#tree .row[data-kind="unfiled"]').length === 25,
    null, { timeout: 2500 });
  const sidebarMs = Date.now() - started;
  assert.ok(sidebarMs < 2500, `25 sessions appeared after ${sidebarMs} ms`);
  const clicked = await page.evaluate(() => new Promise((resolve) => {
    const row = document.querySelector('#tree .row[data-kind="unfiled"][data-name="bench-01"]');
    const at = performance.now();
    row.click();
    requestAnimationFrame(() => resolve({ ms: performance.now() - at,
      title: document.querySelector('#term-title')?.textContent }));
  }));
  assert.ok(clicked.ms < 100, `sidebar response took ${clicked.ms} ms`);
  assert.match(clicked.title, /bench-01/);
  await page.locator('iframe.term-frame[data-name="bench-01"]').waitFor({ timeout: 3000 });
  const tasks = await page.evaluate(() => window.__longTasks);
  assert.ok(tasks.every((ms) => ms < 200), `long tasks: ${tasks.join(', ')}`);
  console.log(`async-open browser: 25 sessions in ${sidebarMs} ms, click ${clicked.ms.toFixed(1)} ms, max task ${Math.max(0, ...tasks).toFixed(1)} ms; 4 checks passed`);
} finally {
  await browser?.close();
  agent.close();
  hub.stop();
}
