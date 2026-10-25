// View polish from the 2026-10-06 QA run, real browser.
//   finding 12: the disconnected banner may show only after the first state read says so;
//   finding 15: at 390 px the page does not scroll sideways and Log out is on screen;
//   finding 16: the terminal's buttons sit in a header bar and cover no part of the terminal;
//   finding 21: screen readers get a tree with levels and groups;
//   finding 25: an address with an invalid name explains the rule in words.
//
//   node test/view-polish.browser.mjs
import assert from 'node:assert/strict';
import { ScriptedAgent, startHub, hubSession, launchBrowser, login, wait, report } from './view-harness.mjs';

const PORT = 18415;
const SECRET = 'view-polish-secret';
const PASSWORD = 'view-polish-password';
const NAMES = ['alpha', 'beta', 'gamma'];

const hub = await startHub({ port: PORT, secret: SECRET, password: PASSWORD });
let agent = new ScriptedAgent(SECRET, NAMES);
let browser;
const passed = [];
const pass = report(passed);

// Every time the banner is visible, with whether the page had a state answer by then.
const BANNER_LOG = () => {
  window.__banner = [];
  window.__stateAnswered = false;
  const origFetch = window.fetch;
  window.fetch = async (...args) => {
    const res = await origFetch(...args);
    if (String(args[0]).includes('/api/state')) window.__stateAnswered = true;
    return res;
  };
  const check = () => {
    const banner = document.getElementById('banner');
    if (banner && !banner.hidden) window.__banner.push({ answered: window.__stateAnswered, text: banner.textContent });
  };
  new MutationObserver(check).observe(document, { childList: true, subtree: true, attributes: true });
};

try {
  await agent.connect(`ws://127.0.0.1:${PORT}/agent`);
  const api = await hubSession(hub.origin, PASSWORD);
  const folder = (await api('POST', '/api/folders', { name: 'Work', parent_id: null })).node;
  await api('POST', '/api/adopt', { session_name: 'beta', parent_id: folder.id });
  const inner = (await api('POST', '/api/folders', { name: 'Inner', parent_id: folder.id })).node;
  await api('POST', '/api/adopt', { session_name: 'gamma', parent_id: inner.id });

  browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));

  /* finding 12: no banner before the first state read, agent connected. */
  await page.addInitScript(BANNER_LOG);
  await page.route('**/api/state', async (route) => { await wait(1500); await route.continue(); });
  await login(page, hub.origin, PASSWORD);
  await page.waitForFunction(() => document.querySelectorAll('#tree .row[data-kind="recent"] .dot.st-idle').length === 3);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('#tree .row[data-kind="recent"] .dot.st-idle').length === 3);
  assert.deepEqual(await page.evaluate(() => window.__banner), [], 'the banner never showed while the agent was connected');
  pass('login and reload with a 1.5 s state read: the disconnected banner never showed');

  /* finding 12: with the agent down, the banner shows only once the state read says so. */
  agent.close();
  await wait(300);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.getElementById('banner').hidden, null, { timeout: 10000 });
  const shown = await page.evaluate(() => window.__banner);
  assert.ok(shown.length > 0 && shown.every((entry) => entry.answered), `the banner showed only after the state answered: ${JSON.stringify(shown[0])}`);
  assert.match(shown[0].text, /disconnected/);
  pass('with the agent down, the banner showed after the first state answer and not before');
  await page.unroute('**/api/state');
  agent = new ScriptedAgent(SECRET, NAMES);
  await agent.connect(`ws://127.0.0.1:${PORT}/agent`);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('banner').hidden && document.querySelectorAll('#tree .row[data-kind="recent"] .dot.st-idle').length === 3);

  /* finding 21: the tree has levels and groups. */
  const aria = await page.locator('#tree').ariaSnapshot();
  for (const line of [
    'treeitem "Folders" [expanded] [level=1]',
    'group "Folders"',
    'treeitem "Folder Work, 2 sessions" [expanded] [level=2]',
    'group "Work"',
    'treeitem "beta, waiting for input" [level=3]',
    'treeitem "Folder Inner, 1 session" [expanded] [level=3]',
    'group "Inner"',
    'treeitem "gamma, waiting for input" [level=4]',
    'treeitem "alpha, waiting for input, unfiled" [level=2]',
  ]) assert.ok(aria.includes(line), `the accessibility tree has ${line}`);
  const indent = (text) => aria.split('\n').find((l) => l.includes(text)).search(/\S/);
  assert.ok(indent('treeitem "gamma, waiting for input" [level=4]') > indent('group "Inner"') && indent('group "Inner"') > indent('treeitem "Folder Inner'), 'gamma sits inside Inner\'s group');
  pass('screen readers get levels, nested groups and names with state');

  // Arrow keys move through the tree, and left closes a folder.
  await page.focus('#tree .row[data-kind="folder"][aria-label^="Folder Work"]');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.name), 'beta');
  await page.keyboard.press('ArrowLeft');
  assert.match(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), /^Folder Work/);
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.locator('#tree .row[data-kind="folder"][aria-label^="Folder Work"]').getAttribute('aria-expanded'), 'false');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#tree .row[data-kind="folder"][aria-label^="Folder Work"]').getAttribute('aria-expanded'), 'true');
  pass('arrow keys move between rows and close and open a folder');

  /* finding 16, desktop: the header bar holds the buttons above the terminal. */
  await page.click('#tree .row[data-kind="recent"][data-name="alpha"]');
  await page.waitForFunction(() => document.querySelector('.term-frame.active')?.dataset.name === 'alpha');
  const desk = await page.evaluate(() => {
    const frame = document.querySelector('.term-frame.active').getBoundingClientRect();
    const overlaps = [...document.querySelectorAll('.term-bar button')].filter((b) => {
      const r = b.getBoundingClientRect();
      return r.width && r.bottom > frame.top && r.top < frame.bottom && r.right > frame.left && r.left < frame.right;
    }).map((b) => b.id);
    return { overlaps, title: document.getElementById('term-title').textContent };
  });
  assert.deepEqual(desk, { overlaps: [], title: 'alpha' });
  pass('desktop: the Files button sits in the header bar, clear of the terminal, which names the session');

  /* finding 25: an invalid name in the address. */
  await page.goto(`${hub.origin}/s/a%2Fb`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#no-session .notice[data-kind="badname"]');
  const notice = await page.evaluate(() => document.querySelector('#no-session .notice').innerText.replace(/\s+/g, ' ').trim());
  assert.equal(notice, 'a/b is not a session name. Session names use letters, numbers, dot, dash and underscore, up to 64 characters. Back to sessions');
  assert.doesNotMatch(notice, /[[\]{}^$\\]/, 'no regular expression in the notice');
  pass(`an invalid address explains the rule in words: "${notice}"`);

  /* findings 15 and 16 on a 390 px phone. */
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const mobile = await phone.newPage();
  await login(mobile, hub.origin, PASSWORD);
  await mobile.waitForFunction(() => document.querySelectorAll('#tree .row[data-kind="recent"]').length === 3);
  const layout = () => mobile.evaluate(() => {
    const logout = document.getElementById('logout').getBoundingClientRect();
    const hit = document.elementFromPoint(logout.left + logout.width / 2, logout.top + logout.height / 2);
    return {
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      logoutRight: Math.round(logout.right),
      logoutVisible: logout.width > 0 && logout.right <= innerWidth && logout.bottom <= innerHeight && hit === document.getElementById('logout'),
    };
  });
  const start = await layout();
  assert.ok(start.scrollWidth <= 390 && start.bodyScrollWidth <= 390, `no sideways scroll after login: ${JSON.stringify(start)}`);
  assert.equal(start.logoutVisible, true, `Log out is on screen after login: ${JSON.stringify(start)}`);
  await mobile.tap('#bar-sidebar');
  await mobile.waitForFunction(() => !document.body.classList.contains('sidebar-collapsed'));
  const drawer = await layout();
  assert.ok(drawer.scrollWidth <= 390 && drawer.bodyScrollWidth <= 390, `no sideways scroll with the sidebar open: ${JSON.stringify(drawer)}`);
  await mobile.tap('#tree .row[data-kind="recent"][data-name="beta"]');
  await mobile.waitForFunction(() => document.querySelector('.term-frame.active')?.dataset.name === 'beta' && document.body.classList.contains('sidebar-collapsed'));
  const open = await layout();
  assert.ok(open.scrollWidth <= 390, `no sideways scroll with a session open: ${JSON.stringify(open)}`);
  assert.equal(open.logoutVisible, true, `Log out is on screen with a session open: ${JSON.stringify(open)}`);
  const bar = await mobile.evaluate(() => {
    const frame = document.querySelector('.term-frame.active').getBoundingClientRect();
    return {
      covering: [...document.querySelectorAll('button')].filter((b) => {
        const r = b.getBoundingClientRect();
        return r.width && getComputedStyle(b).visibility !== 'hidden' && r.bottom > frame.top + 1 && r.top < frame.bottom && r.right > frame.left && r.left < frame.right;
      }).map((b) => b.id || b.className),
      title: document.getElementById('term-title').textContent,
    };
  });
  assert.deepEqual(bar, { covering: [], title: 'beta' }, 'no button covers the terminal, and the bar names the session');
  await mobile.screenshot({ path: process.env.MCW_SHOT_DIR ? `${process.env.MCW_SHOT_DIR}/phone-390.png` : '/dev/null' }).catch(() => {});
  pass(`390 px phone: page ${open.scrollWidth} px wide, Log out right edge at ${open.logoutRight} px, no button over the terminal, bar names the session`);
  await phone.close();

  assert.deepEqual(errors, [], 'no page errors');
  console.log(`view polish: ${passed.length} checks PASS`);
} finally {
  await browser?.close();
  agent.close();
  hub.stop();
}
