// Renaming the open session, real browser, with status updates flowing. QA finding 5 recorded the
// release candidate flashing "There is no session named dev-5", showing the tree leaf as not
// created with a Create button, and building a second terminal frame. A rename is one session
// changing its name: the page must keep the open terminal's frame, replace the address, and
// never draw a missing state for either name.
//
// The scripted agent renames on the host at once and answers six seconds later, as the real
// Claude /rename and unit steps take seconds. During that window the host lists the new name
// while the hub's tree still names the old one, and at least one state poll and many status
// pushes land in it.
//
// Expected on the real stack until review step 8 replaces the iframe client: zellij reloads the open frame on a rename, so a white frame, about 1 s blank and a brief "No Claude process" still show (rc-v25 QA finding 5).
//
//   node test/rename-open.browser.mjs
import assert from 'node:assert/strict';
import { ScriptedAgent, startHub, hubSession, launchBrowser, login, waitFor, TAG_TREE, report } from './view-harness.mjs';

const PORT = 18414;
const SECRET = 'rename-open-secret';
const PASSWORD = 'rename-open-password';
const NAMES = ['alpha', 'beta', 'gamma', 'delta'];

const hub = await startHub({ port: PORT, secret: SECRET, password: PASSWORD });
const agent = new ScriptedAgent(SECRET, NAMES);
agent.renameDelayMs = 6000;
let browser;
let flow = null;
const passed = [];
const pass = report(passed);

try {
  await agent.connect(`ws://127.0.0.1:${PORT}/agent`);
  const api = await hubSession(hub.origin, PASSWORD);
  const folder = (await api('POST', '/api/folders', { name: 'Work', parent_id: null })).node;
  await api('POST', '/api/adopt', { session_name: 'gamma', parent_id: folder.id });
  await api('PUT', '/api/preferences/recent-limit', { recent_limit: 15 });

  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await login(page, hub.origin, PASSWORD);
  await page.waitForFunction((count) => document.querySelectorAll('#tree .row[data-kind="recent"] .dot.st-idle').length === count, NAMES.length);

  // Status keeps flowing: the other two sessions change lights five times a second and stay green.
  let tick = 0;
  flow = setInterval(() => {
    tick += 1;
    agent.set('alpha', { state: tick % 3 === 0 ? 'background' : 'busy', lastActivityAt: Date.now() });
    agent.set('beta', { state: tick % 4 === 0 ? 'background' : 'busy', lastActivityAt: Date.now() });
    agent.push();
  }, 200);

  // Records, on every DOM change and every frame, anything a rename must never show.
  const watch = (oldName, newName) => page.evaluate(([from, to]) => {
    const seen = window.__renameSeen = { notices: [], missing: [], create: [], unknown: [], recentPlaces: [], framesAdded: 0, framesRemoved: 0, unfiledNew: 0, rowsPerName: 0 };
    const check = () => {
      const notice = document.querySelector('#no-session:not([hidden]) .notice');
      if (notice && !seen.notices.includes(notice.textContent)) seen.notices.push(notice.textContent);
      for (const row of document.querySelectorAll('#tree .row[data-name]')) {
        if (row.dataset.name !== from && row.dataset.name !== to) continue;
        if (row.querySelector('.dot.st-missing')) seen.missing.push(row.dataset.key + ' ' + row.dataset.name);
        if (row.querySelector('button[data-act="create"]')) seen.create.push(row.dataset.key);
        const light = (row.querySelector('.dot')?.className.match(/\bst-(\S+)/) || [])[1];
        if (light !== 'idle' && !seen.unknown.includes(light)) seen.unknown.push(light);
      }
      // The session stays idle throughout, so its Recent row keeps its place among the idle rows.
      const recentNames = [...document.querySelectorAll('#tree .row[data-kind="recent"]')].map((row) => row.dataset.name);
      const place = recentNames.findIndex((name) => name === from || name === to);
      if (!seen.recentPlaces.includes(place)) seen.recentPlaces.push(place);
      const order = [...document.querySelectorAll('#tree .row[data-kind="recent"]')].map((row) => row.dataset.name + ':' + (row.querySelector('.dot').className.match(/st-(\S+)/) || [])[1]).join(' ');
      if ((seen.orders = seen.orders || []).at(-1) !== order) seen.orders.push(order);
      // gamma is filed, so neither name may appear in Unfiled; delta is unfiled, so one row only.
      const unfiled = [...document.querySelectorAll('#tree .row[data-kind="unfiled"]')].filter((row) => row.dataset.name === from || row.dataset.name === to);
      seen.unfiledNew = Math.max(seen.unfiledNew, unfiled.length);
      const recent = [...document.querySelectorAll('#tree .row[data-kind="recent"]')].filter((row) => row.dataset.name === from || row.dataset.name === to);
      seen.rowsPerName = Math.max(seen.rowsPerName, recent.length);
    };
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) if (node.nodeName === 'IFRAME') seen.framesAdded += 1;
        for (const node of record.removedNodes) if (node.nodeName === 'IFRAME') seen.framesRemoved += 1;
      }
      check();
    }).observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    const loop = () => { check(); window.__renameLoop = requestAnimationFrame(loop); };
    loop();
  }, [oldName, newName]);

  async function renameOpen(oldName, newName, kind) {
    await page.click(`#tree .row[data-kind="${kind}"][data-name="${oldName}"]`);
    await page.waitForFunction((n) => {
      const frame = document.querySelector('.term-frame.active');
      return frame?.dataset.name === n && frame.contentDocument?.body?.dataset.path === '/' + n;
    }, oldName, { timeout: 10000 });
    await page.waitForFunction(() => ['alpha', 'beta'].every((n) => /st-(busy|background)/.test(document.querySelector(`#tree .row[data-kind="recent"][data-name="${n}"] .dot`)?.className)));
    await page.evaluate(() => { window.__frame = document.querySelector('.term-frame.active'); });
    const history = await page.evaluate(() => history.length);
    const targetKey = await page.locator(`#tree .row[data-kind="${kind}"][data-name="${oldName}"]`).getAttribute("data-key");
    const before = await page.evaluate(TAG_TREE);
    const keys = Object.keys(before).filter((key) => key.startsWith('recent:') || key.startsWith(kind + ':'));
    await watch(oldName, newName);

    await page.hover(`#tree .row[data-kind="${kind}"][data-name="${oldName}"]`);
    await page.click(`#tree .row[data-kind="${kind}"][data-name="${oldName}"] button[data-act="menu"]`);
    await page.getByRole('menuitem', { name: 'Rename session' }).click();
    const dialog = page.locator('form.modal-card[aria-label="Rename session"]');
    await dialog.locator('input.inp').fill(newName);
    const started = Date.now();
    await dialog.locator('button[type="submit"]').click();
    // The host has the new name long before the hub answers.
    await waitFor(async () => (await api('GET', '/api/state')).sessions.some((s) => s.name === newName), 3000, 'host rename');
    await page.waitForFunction((n) => location.pathname === '/s/' + n && !document.querySelector('form.modal-card'), newName, { timeout: 15000 });
    const took = Date.now() - started;
    await page.waitForFunction((n) => document.querySelector(`#tree .row[data-name="${n}"]`), newName);
    await new Promise((resolve) => setTimeout(resolve, 4500));

    const seen = await page.evaluate(() => { cancelAnimationFrame(window.__renameLoop); return window.__renameSeen; });
    const after = await page.evaluate(TAG_TREE);
    // Frames of other sessions, such as the previous rename's warm frame, are not counted.
    const frame = await page.evaluate(([from, to]) => ({
      same: document.querySelector('.term-frame.active') === window.__frame,
      frames: [...document.querySelectorAll('.term-frame')].filter((f) => f.dataset.name === from || f.dataset.name === to).length,
      name: document.querySelector('.term-frame.active')?.dataset.name,
    }), [oldName, newName]);
    assert.deepEqual(seen.notices, [], 'no notice was shown');
    assert.deepEqual(seen.missing, [], 'no row showed the session as missing');
    assert.deepEqual(seen.create, [], 'no row offered Create');
    assert.deepEqual(seen.unknown, [], 'the session\'s light stayed idle under both names');
    assert.equal(seen.recentPlaces.length, 1, `the Recent row kept its place: ${JSON.stringify(seen.recentPlaces)} ${JSON.stringify(seen.orders, null, 1)}`);
    assert.equal(seen.framesAdded, 0, 'no terminal frame was added');
    assert.equal(seen.framesRemoved, 0, 'no terminal frame was removed');
    assert.deepEqual(frame, { same: true, frames: 1, name: newName }, 'the open terminal frame is the same element, under the new name');
    assert.equal(seen.rowsPerName, 1, 'Recent showed the session once throughout');
    assert.equal(seen.unfiledNew, kind === 'unfiled' ? 1 : 0, 'Unfiled never showed the session twice or as a stray');
    assert.equal(await page.evaluate(() => history.length), history, 'the address was replaced, not pushed');
    for (const key of keys) assert.equal(after[key]?.[0], before[key][0], `row ${key} is the same element`);
    const names = await page.evaluate((key) => [...document.querySelectorAll('#tree .row')].filter((row) => row.dataset.key === key).map((row) => row.dataset.name), targetKey);
    assert.deepEqual(names, [newName], 'the row shows the new name');
    pass(`renaming the open ${kind} session ${oldName} to ${newName} (${took} ms, under status flow): no notice, no missing row, no Create, same frame, same rows, address replaced`);
  }

  await renameOpen('gamma', 'gamma-r', 'leaf');
  await renameOpen('delta', 'delta-r', 'unfiled');

  assert.deepEqual(errors, [], 'no page errors');
  console.log(`rename of the open session: ${passed.length} checks PASS`);
} finally {
  clearInterval(flow);
  await browser?.close();
  agent.close();
  hub.stop();
}
