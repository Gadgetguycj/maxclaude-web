// Keyed view layer, real browser. A status change must update a row in place: the row element
// and its light keep their DOM identity, the light's blink starts only when its color changes,
// every green light blinks in phase, and Recent does not reorder while working sessions only
// report tool events.
//
//   node test/view-keyed.browser.mjs
import assert from 'node:assert/strict';
import { ScriptedAgent, startHub, hubSession, launchBrowser, login, waitFor, wait, TAG_TREE, report } from './view-harness.mjs';

const PORT = 18412;
const SECRET = 'view-keyed-secret';
const PASSWORD = 'view-keyed-password';
const NAMES = ['alpha', 'beta', 'gamma', 'delta'];

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
  await page.addInitScript(() => {
    window.__starts = [];
    document.addEventListener('animationstart', (ev) => {
      if (!ev.target.classList?.contains('dot')) return;
      const row = ev.target.closest('.row');
      window.__starts.push({ key: row ? row.dataset.key : 'legend', name: ev.animationName, cls: ev.target.className });
    }, true);
  });
  await login(page, hub.origin, PASSWORD);
  await page.waitForFunction((count) => document.querySelectorAll('#tree .row[data-kind="recent"] .dot.st-idle').length === count, NAMES.length);

  // Every light that shows a session, by session name and light.
  const lights = () => page.evaluate(() => [...document.querySelectorAll('#tree .row[data-name]')].map((row) => [
    row.dataset.key, row.dataset.name, (row.querySelector('.dot').className.match(/\bst-(\S+)/) || [])[1],
  ]));
  const showState = (name, state) => page.waitForFunction(([n, s]) => {
    const rows = [...document.querySelectorAll(`#tree .row[data-name="${n}"]`)];
    return rows.length >= 2 && rows.every((row) => row.querySelector('.dot').classList.contains('st-' + s));
  }, [name, state], { timeout: 5000, polling: 20 });
  // animationstart is dispatched with the next rendered frames.
  const frames = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 20)))));
  const recentOrder = () => page.evaluate(() => [...document.querySelectorAll('#tree .row[data-kind="recent"]')].map((row) => row.dataset.name));

  /* 1. Twenty status changes keep every row and light element. */
  const before = await page.evaluate(TAG_TREE);
  await page.evaluate(() => { window.__starts = []; });
  const plan = [
    ['alpha', 'busy'], ['gamma', 'background'], ['beta', 'busy'], ['delta', 'busy'], ['alpha', 'idle'],
    ['beta', 'background'], ['gamma', 'busy'], ['alpha', 'busy'], ['delta', 'idle'], ['beta', 'idle'],
    ['gamma', 'idle'], ['delta', 'background'], ['alpha', 'background'], ['beta', 'busy'], ['delta', 'busy'],
    ['gamma', 'busy'], ['alpha', 'busy'], ['beta', 'idle'], ['delta', 'idle'], ['beta', 'busy'],
  ];
  let expectedStarts = 0;
  const current = Object.fromEntries(NAMES.map((name) => [name, 'idle']));
  for (const [name, state] of plan) {
    const animated = (s) => s === 'busy' || s === 'background';
    // Each session shows two lights, one in Recent and one in its folder or in Unfiled.
    if (animated(state) && state !== current[name]) expectedStarts += 2;
    current[name] = state;
    agent.set(name, { state, lastActivityAt: Date.now() });
    agent.push();
    await showState(name, state);
    await frames();
  }
  const after = await page.evaluate(TAG_TREE);
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), 'the same rows are shown');
  const replaced = Object.keys(before).filter((key) => before[key][0] !== after[key][0] || before[key][1] !== after[key][1]);
  assert.deepEqual(replaced, [], 'no row and no light element was replaced by a status change');
  const lit = await lights();
  for (const [, name, state] of lit) assert.equal(state, current[name], `${name} shows its last state`);
  pass('20 status changes update every row and light in place, zero elements replaced');

  const starts = await page.evaluate(() => window.__starts.splice(0));
  const rowStarts = starts.filter((start) => start.key !== 'legend');
  assert.equal(rowStarts.length, expectedStarts, `a light blinks anew only when it turns green or changes green kind, ${expectedStarts} times here`);
  assert.deepEqual(starts.filter((start) => start.key === 'legend'), [], 'the legend lights never restart');
  pass(`blink starts equal light color changes: ${rowStarts.length} starts for ${expectedStarts} changes`);

  /* 2. Every green light blinks in phase, the legend's too. */
  const phases = () => page.evaluate(() => {
    const t = document.timeline.currentTime;
    const out = {};
    for (const dot of document.querySelectorAll('.dot.st-busy, .dot.st-background')) {
      const anim = dot.getAnimations()[0];
      if (!anim || anim.startTime === null) continue;
      const duration = anim.effect.getTiming().duration;
      const kind = dot.classList.contains('st-busy') ? 'busy' : 'background';
      (out[kind] = out[kind] || []).push(((t - anim.startTime) % duration + duration) % duration);
    }
    return out;
  });
  const spread = (values, period) => {
    if (values.length < 2) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    let gap = 0;
    for (let i = 0; i < sorted.length; i += 1) gap = Math.max(gap, (i + 1 < sorted.length ? sorted[i + 1] : sorted[0] + period) - sorted[i]);
    return period - gap;
  };
  agent.set('alpha', { state: 'busy' });
  agent.set('beta', { state: 'busy' });
  agent.push();
  await showState('alpha', 'busy');
  await wait(400);
  agent.set('gamma', { state: 'busy' });
  agent.set('delta', { state: 'background' });
  agent.push();
  await showState('gamma', 'busy');
  await showState('delta', 'background');
  await wait(300);
  const phase = await phases();
  assert.ok(phase.busy.length >= 7, `busy lights in rows and legend: ${phase.busy.length}`);
  const busySpread = spread(phase.busy, 900);
  const backgroundSpread = spread(phase.background, 2400);
  assert.ok(busySpread < 50, `busy lights blink in phase, spread ${busySpread.toFixed(1)} ms`);
  assert.ok(backgroundSpread < 50, `background lights pulse in phase, spread ${backgroundSpread.toFixed(1)} ms`);
  pass(`green lights in phase across rows and legend: busy spread ${busySpread.toFixed(1)} ms over ${phase.busy.length} lights, background ${backgroundSpread.toFixed(1)} ms`);

  /* 3. Working sessions reporting tool events do not move in Recent, and nothing restarts. */
  const order = await recentOrder();
  const tags = await page.evaluate(TAG_TREE);
  await page.evaluate(() => { window.__starts = []; window.__orders = []; });
  await page.evaluate(() => {
    const tree = document.getElementById('tree');
    const key = () => [...tree.querySelectorAll('.row[data-kind="recent"]')].map((row) => row.dataset.name).join(',');
    let last = key();
    new MutationObserver(() => { const now = key(); if (now !== last) { window.__orders.push(now); last = now; } })
      .observe(tree, { childList: true, subtree: true });
  });
  for (let i = 0; i < 30; i += 1) {
    const name = ['alpha', 'beta', 'gamma'][i % 3];
    agent.set(name, { lastActivityAt: Date.now() });
    agent.push();
    await wait(60);
  }
  await wait(1500);
  assert.deepEqual(await recentOrder(), order, 'Recent kept its order');
  assert.deepEqual(await page.evaluate(() => window.__orders), [], 'Recent never reordered during tool events');
  assert.deepEqual(await page.evaluate(() => window.__starts), [], 'no light restarted during tool events');
  assert.deepEqual(await page.evaluate(TAG_TREE), tags, 'no row was replaced during tool events');
  pass('30 tool events across 3 working sessions: zero Recent reorders, zero blink restarts, zero replaced rows');

  /* 4. A group change moves only that row, by a keyed move. */
  await page.evaluate(() => { window.__starts = []; });
  agent.set('beta', { state: 'idle', lastActivityAt: Date.now() });
  agent.push();
  await showState('beta', 'idle');
  await frames();
  assert.deepEqual(await page.evaluate(() => window.__starts), [], 'the move restarted no light');
  const moved = await recentOrder();
  assert.deepEqual(moved.filter((name) => name !== 'beta'), order.filter((name) => name !== 'beta'), 'the other rows keep their order');
  const tagsAfterMove = await page.evaluate(TAG_TREE);
  assert.deepEqual(Object.keys(tags).filter((key) => tags[key][0] !== tagsAfterMove[key][0]), [], 'the moved row is the same element');
  pass(`a working session going idle moves only its own Recent row, keeping its element and every other light's blink: ${order.join(',')} -> ${moved.join(',')}`);

  assert.deepEqual(errors, [], 'no page errors');
  console.log(`keyed view layer: ${passed.length} checks PASS`);
} finally {
  await browser?.close();
  agent.close();
  hub.stop();
}
