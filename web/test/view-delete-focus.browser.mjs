// Focus after deleting the open session, real browser (rc-v25 finding N8). The row and the menu
// that opened the delete dialog are gone when it closes. Focus goes to the row that took the
// deleted row's place, or the row above it when it was the last, and never to the page body.
//
//   node test/view-delete-focus.browser.mjs
import assert from 'node:assert/strict';
import { ScriptedAgent, startHub, hubSession, launchBrowser, login, wait, report } from './view-harness.mjs';

const PORT = 18417;
const SECRET = 'view-delete-focus-secret';
const PASSWORD = 'view-delete-focus-password';
// Unfiled is newest first: epsilon, delta, gamma, beta, alpha.
const NAMES = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];

const hub = await startHub({ port: PORT, secret: SECRET, password: PASSWORD });
const agent = new ScriptedAgent(SECRET, NAMES);
let browser;
const passed = [];
const pass = report(passed);

const FOCUSED = () => {
  const el = document.activeElement;
  return { tag: el?.tagName || null, inTree: !!el?.closest?.('#tree'), key: el?.dataset?.key || null, name: el?.dataset?.name || null };
};

try {
  await agent.connect(`ws://127.0.0.1:${PORT}/agent`);
  const api = await hubSession(hub.origin, PASSWORD);
  // gamma gets a root leaf, as New session at the top level makes.
  await api('POST', '/api/adopt', { session_name: 'gamma', parent_id: null });

  browser = await launchBrowser();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await login(page, hub.origin, PASSWORD);
  await page.waitForFunction((n) => document.querySelectorAll('#tree .row[data-kind="recent"] .dot.st-idle').length === n, NAMES.length);
  const unfiledNames = () => page.evaluate(() => {
    const rows = [...document.querySelectorAll('#tree .row')];
    const at = rows.findIndex((row) => row.dataset.key === 'section:__unfiled__');
    return rows.slice(at + 1).map((row) => row.dataset.name);
  });
  assert.deepEqual(await unfiledNames(), ['epsilon', 'delta', 'gamma', 'beta', 'alpha']);

  // Opens the session from its Unfiled row, then deletes it from that row's menu.
  async function deleteOpen(kind, name) {
    const row = `#tree .row[data-kind="${kind}"][data-name="${name}"]`;
    await page.click(row);
    await page.waitForFunction((n) => document.querySelector('.term-frame.active')?.dataset.name === n, name);
    await page.click(`${row} button[data-act="menu"]`);
    await page.click('.menu .menu-item:text-is("Delete session")');
    await page.waitForSelector('#modal-root .modal-card');
    await page.click('#modal-root .modal-foot .btn.danger');
    await page.waitForFunction((n) => !document.querySelector('#modal-root .modal-card')
      && !document.querySelector(`#tree .row[data-name="${n}"]`), name, { timeout: 10000 });
    await wait(300);
    return page.evaluate(FOCUSED);
  }

  let focused = await deleteOpen('unfiled', 'delta');
  assert.equal(focused.tag, 'A', `focus is on a row, not ${focused.tag}`);
  assert.deepEqual({ inTree: focused.inTree, name: focused.name }, { inTree: true, name: 'gamma' }, 'focus moved to the row that took delta\'s place');
  assert.deepEqual(await unfiledNames(), ['epsilon', 'gamma', 'beta', 'alpha']);
  pass('deleting the open unfiled session delta puts focus on gamma, the row that took its place');

  focused = await deleteOpen('leaf', 'gamma');
  assert.deepEqual({ tag: focused.tag, inTree: focused.inTree, name: focused.name }, { tag: 'A', inTree: true, name: 'beta' }, 'focus moved to beta');
  pass('deleting the open root leaf gamma puts focus on beta, the row that took its place');

  focused = await deleteOpen('unfiled', 'alpha');
  assert.deepEqual({ tag: focused.tag, inTree: focused.inTree, name: focused.name }, { tag: 'A', inTree: true, name: 'beta' }, 'focus moved up to beta');
  pass('deleting the open last row alpha puts focus on beta, the row above it');

  // Focus is usable: the arrow keys move on from it.
  await page.keyboard.press('ArrowUp');
  assert.equal((await page.evaluate(FOCUSED)).name, 'epsilon');
  pass('the arrow keys move on from the row that took focus');

  // A dialog whose opener is still on the page gives focus back to it, as before.
  await page.click('#tree .row[data-kind="unfiled"][data-name="beta"] button[data-act="menu"]');
  await page.click('.menu .menu-item:text-is("Delete session")');
  await page.waitForSelector('#modal-root .modal-card');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#modal-root .modal-card'));
  await wait(100);
  assert.deepEqual(await page.evaluate(() => [document.activeElement.dataset.act, document.activeElement.closest('.row')?.dataset.name]), ['menu', 'beta']);
  pass('a cancelled delete gives focus back to the menu button that opened it');

  assert.deepEqual(errors, [], 'no page errors');
  console.log(`view delete focus: ${passed.length} checks PASS`);
} finally {
  await browser?.close();
  agent.close();
  hub.stop();
}
