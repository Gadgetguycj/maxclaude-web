// Focus survives status updates, real browser. QA finding 6 measured focus thrown to the page
// body on every status update. With keyed views, nothing replaces the focused element, so focus
// stays without any code that restores it. Each case runs 20 status updates that change lights
// and the Recent order:
//   a focused tree row, including a Recent row that moves because its own session changed group;
//   an open row menu with focus on its second item;
//   the rename dialog with text typed and a selection made.
// It also checks that a user's open puts keyboard focus in the terminal and that closing a menu
// or dialog puts focus back on the control that opened it.
//
//   node test/view-focus.browser.mjs
import assert from 'node:assert/strict';
import { ScriptedAgent, startHub, hubSession, launchBrowser, login, wait, report } from './view-harness.mjs';

const PORT = 18413;
const SECRET = 'view-focus-secret';
const PASSWORD = 'view-focus-password';
const NAMES = ['alpha', 'beta', 'gamma', 'delta'];
const CYCLE = ['busy', 'idle', 'background', 'busy', 'idle'];

const hub = await startHub({ port: PORT, secret: SECRET, password: PASSWORD });
const agent = new ScriptedAgent(SECRET, NAMES);
let browser;
const passed = [];
const pass = report(passed);

try {
  await agent.connect(`ws://127.0.0.1:${PORT}/agent`);
  const api = await hubSession(hub.origin, PASSWORD);
  const folder = (await api('POST', '/api/folders', { name: 'Work', parent_id: null })).node;
  await api('POST', '/api/adopt', { session_name: 'beta', parent_id: folder.id });
  await api('PUT', '/api/preferences/recent-limit', { recent_limit: 15 });

  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await login(page, hub.origin, PASSWORD);
  await page.waitForFunction((count) => document.querySelectorAll('#tree .row[data-kind="recent"] .dot.st-idle').length === count, NAMES.length);

  // Marks the focused element so the test can tell the same node from a replacement.
  const markFocus = () => page.evaluate(() => {
    window.__focused = document.activeElement;
    return document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent;
  });
  const sameFocus = () => page.evaluate(() => document.activeElement === window.__focused && window.__focused.isConnected);
  const focusName = () => page.evaluate(() => {
    const a = document.activeElement;
    return a ? `${a.tagName}${a.dataset?.key ? '[' + a.dataset.key + ']' : ''} ${a.getAttribute('aria-label') || a.textContent.trim()}` : null;
  });
  const recentOrder = () => page.evaluate(() => [...document.querySelectorAll('#tree .row[data-kind="recent"]')].map((row) => row.dataset.name).join(','));

  // Twenty updates. Every update changes a light, and the focused session's own light changes too.
  async function updates(own) {
    const orders = new Set([await recentOrder()]);
    for (let i = 0; i < 20; i += 1) {
      const name = i % 2 === 0 && own ? own : NAMES[i % NAMES.length];
      const state = CYCLE[i % CYCLE.length];
      agent.set(name, { state, lastActivityAt: Date.now() });
      agent.push();
      await page.waitForFunction(([n, s]) => [...document.querySelectorAll(`#tree .row[data-name="${n}"] .dot`)]
        .every((dot) => dot.classList.contains('st-' + s)), [name, state], { timeout: 5000, polling: 20 });
      orders.add(await recentOrder());
    }
    for (const name of NAMES) agent.set(name, { state: 'idle' });
    agent.push();
    await page.waitForFunction(() => [...document.querySelectorAll('#tree .row[data-name] .dot')].every((dot) => dot.classList.contains('st-idle')));
    return orders.size;
  }

  /* 1. A focused row keeps focus. */
  for (const [kind, name] of [['leaf', 'beta'], ['unfiled', 'gamma'], ['recent', 'alpha']]) {
    await page.focus(`#tree .row[data-kind="${kind}"][data-name="${name}"]`);
    const label = await markFocus();
    const orders = await updates(name);
    assert.equal(await sameFocus(), true, `${kind} row ${name} kept focus, now on ${await focusName()}`);
    pass(`focused ${kind} row ${name} kept focus across 20 status updates, ${orders} Recent orders seen (${label})`);
  }

  // Tab from a focused row continues from that row, not from the top of the tree.
  await page.focus('#tree .row[data-kind="unfiled"][data-name="gamma"]');
  await updates('gamma');
  await page.keyboard.press('Tab');
  assert.match(await focusName(), /Actions for gamma/, 'Tab moved to the focused row\'s own menu button');
  pass('Tab after the updates continues from the focused row');

  /* 2. An open menu stays open with focus on the same item. */
  const rowMenu = (kind, name) => page.locator(`#tree .row[data-kind="${kind}"][data-name="${name}"] button[data-act="menu"]`);
  await page.hover('#tree .row[data-kind="unfiled"][data-name="gamma"]');
  await rowMenu('unfiled', 'gamma').click();
  await page.waitForSelector('.menu .menu-item');
  await page.waitForFunction(() => document.activeElement?.classList.contains('menu-item'));
  await page.keyboard.press('ArrowDown');
  const item = await markFocus();
  await page.evaluate(() => { window.__menu = document.querySelector('.menu'); });
  await updates('gamma');
  assert.equal(await page.evaluate(() => document.querySelector('.menu') === window.__menu), true, 'the same menu element is open');
  assert.equal(await sameFocus(), true, `focus stayed on menu item ${item}, now on ${await focusName()}`);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.menu').count(), 0, 'Escape closed the menu');
  assert.match(await focusName(), /Actions for gamma/, 'closing the menu put focus back on its button');
  pass(`an open menu stayed open across 20 status updates with focus on "${item}", and Escape returned focus to its button`);

  /* 3. The rename dialog keeps focus, text and selection. */
  await rowMenu('unfiled', 'delta').click();
  await page.getByRole('menuitem', { name: 'Rename session' }).click();
  const input = page.locator('form.modal-card[aria-label="Rename session"] input.inp');
  await input.waitFor();
  await page.waitForFunction(() => document.activeElement?.matches('form.modal-card input.inp'));
  await page.keyboard.press('End');
  await page.keyboard.type('-renamed-x');
  await page.evaluate(() => document.activeElement.setSelectionRange(3, 9));
  await markFocus();
  await updates('delta');
  const dialog = await page.evaluate(() => ({
    same: document.activeElement === window.__focused,
    value: document.activeElement.value,
    selection: [document.activeElement.selectionStart, document.activeElement.selectionEnd],
  }));
  assert.deepEqual(dialog, { same: true, value: 'delta-renamed-x', selection: [3, 9] }, 'the rename input kept focus, text and selection');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('form.modal-card'));
  await wait(50);
  assert.match(await focusName(), /Actions for delta/, 'closing the dialog put focus back where it was opened');
  pass('the rename dialog kept focus, the typed text and the selection across 20 status updates');

  /* 4. A user's open puts the keyboard in the terminal. */
  await page.click('#tree .row[data-kind="unfiled"][data-name="gamma"]');
  await page.waitForFunction(() => {
    const frame = document.querySelector('.term-frame.active');
    return frame?.dataset.name === 'gamma' && frame.contentDocument?.activeElement?.id === 't';
  }, null, { timeout: 10000 });
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('term-frame')), true);
  pass('clicking a session puts keyboard focus in its terminal');

  assert.deepEqual(errors, [], 'no page errors');
  console.log(`focus across updates: ${passed.length} checks PASS`);
} finally {
  await browser?.close();
  agent.close();
  hub.stop();
}
