// Root leaves and sessions without leaves share Unfiled, ordered by last activity.
import assert from 'node:assert/strict';
import { ScriptedAgent, startHub, launchBrowser, login, hubSession } from './view-harness.mjs';

const secret = 'unfiled-test', password = 'unfiled-test';
const names = ['unfiled-root-old', 'unfiled-loose', 'unfiled-root-new', 'filed'];
const hub = await startHub({ port: 18450, secret, password });
const agent = new ScriptedAgent(secret, names);
let browser;
try {
  await agent.connect(hub.origin.replace('http', 'ws') + '/agent');
  const api = await hubSession(hub.origin, password);
  const now = Date.now();
  names.forEach((name, i) => agent.set(name, {
    createdAt: now - (i + 1) * 100000,
    lastActivityAt: now - (names.length - i) * 1000,
  }));
  agent.push();
  const rootIds = [];
  for (const name of [names[0], names[2]]) {
    const result = await api('POST', '/api/adopt', { session_name: name, parent_id: null });
    assert.equal(result.node.parent_id, null);
    rootIds.push(result.node.id);
  }
  const folder = (await api('POST', '/api/folders', { name: 'Work' })).node;
  await api('POST', '/api/adopt', { session_name: 'filed', parent_id: folder.id });
  browser = await launchBrowser();
  const page = await browser.newPage();
  await login(page, hub.origin, password);
  const unfiled = page.locator('[role="group"][aria-label="Unfiled, newest first"]');
  await unfiled.waitFor();
  const readNames = () => unfiled.locator('.row').evaluateAll((els) => els.map((el) => el.dataset.name));
  const expected = [names[2], names[1], names[0]];
  assert.deepEqual(await readNames(), expected);
  assert.equal(await unfiled.locator('.leaf').count(), 2);
  assert.equal(await unfiled.locator('.unfiled').count(), 1);
  const folders = page.locator('[role="group"][aria-label="Folders"]');
  assert.equal(await folders.locator('.leaf').count(), 1);
  assert.equal(await folders.locator('.leaf').getAttribute('data-name'), 'filed');
  for (const id of rootIds) assert.equal(await folders.locator(`[data-id="${id}"]`).count(), 0);
  console.log('Root leaves and leafless sessions share Unfiled in last activity order, clear of Folders: PASS');
  await page.reload();
  await unfiled.waitFor();
  assert.deepEqual(await readNames(), expected);
  await unfiled.locator(`[data-name="${names[0]}"]`).focus();
  await page.evaluate((name) => { window.__unfiledRow = document.querySelector(`[aria-label="Unfiled, newest first"] [data-name="${name}"]`); }, names[0]);
  agent.set(names[0], { lastActivityAt: now });
  agent.push();
  await page.waitForFunction((name) => document.querySelector('[role="group"][aria-label="Unfiled, newest first"] .row')?.dataset.name === name, names[0]);
  assert.deepEqual(await readNames(), [names[0], names[2], names[1]]);
  assert.equal(await page.evaluate(() => window.__unfiledRow === document.activeElement), true);
  console.log('Unfiled order survives reload and updates by activity while retaining the focused row: PASS');
} finally {
  await browser?.close();
  agent.close();
  hub.stop();
}
