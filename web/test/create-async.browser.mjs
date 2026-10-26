import assert from 'node:assert/strict';
import { ScriptedAgent, startHub, launchBrowser, login, waitFor } from './view-harness.mjs';
const secret = 'async-create-test', password = 'async-create-test';
const hub = await startHub({ port: 18440, secret, password });
const agent = new ScriptedAgent(secret, ['existing']);
let browser;
try {
  await agent.connect(hub.origin.replace('http', 'ws') + '/agent');
  browser = await launchBrowser();
  const page = await browser.newPage();
  await login(page, hub.origin, password);
  await page.click('#new-session-root');
  await page.locator('.modal-card input[type="text"]').first().fill('new-async');
  const accepted = page.waitForResponse((res) => res.url().endsWith('/api/sessions') && res.request().method() === 'POST');
  // Measure in the page to exclude browser driver's round trips and click stability waits.
  const elapsed = await page.evaluate(async () => {
    const started = performance.now();
    document.querySelector('.modal-card button.primary').click();
    while (document.querySelector('.modal-card')) await new Promise(requestAnimationFrame);
    const row = document.querySelector('.unfiled[data-name="existing"]');
    row.click();
    return performance.now() - started;
  });
  assert.ok(elapsed < 300, `dialog close and another row click took ${elapsed}ms`);
  assert.equal((await accepted).status(), 202);
  await waitFor(() => Boolean(agent.pendingCreate), 3000, 'agent creation pending');
  assert.equal(await page.locator('.leaf[data-name="new-async"] .creation-state').textContent(), 'creating');
  assert.equal(await page.locator('.leaf[data-name="new-async"]').getAttribute('href'), null);
  await page.waitForFunction(() => document.querySelector('#term-title .term-name')?.textContent === 'existing');
  await page.reload();
  await page.waitForSelector('.leaf[data-name="new-async"] .st-creating');
  agent.createError = 'The working directory could not be opened';
  agent.pendingCreate();
  const retry = page.locator('.leaf[data-name="new-async"] [data-act="retry"]');
  await retry.waitFor();
  assert.match(await page.locator('.leaf[data-name="new-async"] .creation-state').textContent(), /working directory/);
  agent.createError = null;
  const priorCreate = agent.pendingCreate;
  await retry.click();
  await waitFor(() => agent.pendingCreate !== priorCreate, 3000, 'retry reached agent');
  agent.pendingCreate();
  await page.waitForSelector('.leaf[data-name="new-async"][href]');
  await page.locator('.leaf[data-name="new-async"]').click();
  await page.waitForFunction(() => document.querySelector('#term-title .term-name')?.textContent === 'new-async');
  console.log(`Async creation closes dialog and clicks another session in ${Math.round(elapsed)}ms, returns 202 before readiness, survives reload, shows failure, retries and opens on agent readiness: PASS`);
} finally {
  await browser?.close();
  agent.close();
  hub.stop();
}
