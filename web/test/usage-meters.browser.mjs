// Plan usage meters in the terminal header, real browser (hub 1.10.0).
//
// The agent pushes a usage snapshot. The hub keeps it, serves it in /api/state and pushes it to
// every page. This runs the real hub and app.js with a scripted agent and checks, at 1440 px and
// at 390 px:
//   - four meters show inline reset times, inside the header, with nothing cut off
//     and the session name still readable;
//   - each meter's bar width and percent match the snapshot, and its tooltip names the reset;
//   - a new snapshot updates the meters in place, without a reload;
//   - a click or tap opens a panel with every window's reset time, and Escape or a click outside
//     closes it;
//   - a window the agent reports unavailable says unavailable and why, and a stale one is dimmed.
//
//   node test/usage-meters.browser.mjs        MCW_SHOT_DIR=<dir> also saves screenshots
import assert from 'node:assert/strict';
import { ScriptedAgent, startHub, launchBrowser, login, report } from './view-harness.mjs';

const PORT = 18422;
const SECRET = 'usage-meters-secret';
const PASSWORD = 'usage-meters-password';
const NAMES = ['usage-session-with-a-long-name', 'usage-b'];
const SHOTS = process.env.MCW_SHOT_DIR || '';
const HOUR = 3600000;

function snapshot(now, { week = 21, fiveHour = 39, fable = 3, codex = 0, fableAvailable = true, claudeStale = false } = {}) {
  const meter = (key, label, title, percent, resetsAt, extra = {}) => ({
    key, label, title, percent, resetsAt, available: true, stale: false, fetchedAt: now, error: null, ...extra,
  });
  const stale = claudeStale ? { stale: true, error: 'the usage endpoint is rate limiting' } : {};
  return {
    updatedAt: now,
    meters: [
      meter('claude-week', 'Claude', 'Claude weekly, all models', week, now + 150 * HOUR, stale),
      meter('claude-5h', '5h', 'Claude 5-hour', fiveHour, now + 3 * HOUR, stale),
      fableAvailable
        ? meter('model-fable', 'Fable', 'Fable weekly', fable, now + 150 * HOUR, stale)
        : meter('model-fable', 'Fable', 'Fable weekly', null, null, { available: false, error: 'the usage answer has no weekly window for Fable' }),
      meter('codex-week', 'Codex', 'Codex weekly', codex, now + 160 * HOUR),
    ],
  };
}

const hub = await startHub({ port: PORT, secret: SECRET, password: PASSWORD });
const agent = new ScriptedAgent(SECRET, NAMES);
let browser;
const passed = [];
const pass = report(passed);

const READ = () => {
  const bar = document.querySelector('.term-bar').getBoundingClientRect();
  const name = document.querySelector('#term-title .term-name');
  const nameBox = name?.getBoundingClientRect();
  const actions = document.querySelector('.term-actions').getBoundingClientRect();
  const meters = [...document.querySelectorAll('#usage .meter')].map((el) => {
    const box = el.getBoundingClientRect();
    const track = el.querySelector('.meter-bar').getBoundingClientRect();
    const fill = el.querySelector('.meter-fill').getBoundingClientRect();
    return {
      key: el.dataset.key, cls: el.className, label: el.querySelector('.meter-label').textContent,
      pct: el.querySelector('.meter-pct').textContent, reset: el.querySelector('.meter-reset').textContent, title: el.title,
      left: box.left, right: box.right, top: box.top, bottom: box.bottom,
      fillRatio: track.width ? fill.width / track.width : 0,
      labelClipped: el.querySelector('.meter-label').scrollWidth > el.querySelector('.meter-label').clientWidth + 1,
      resetRight: el.querySelector('.meter-reset').getBoundingClientRect().right,
    };
  });
  return {
    viewport: window.innerWidth, pageScroll: document.documentElement.scrollWidth,
    bar: { left: bar.left, right: bar.right, top: bar.top, bottom: bar.bottom },
    name: name?.textContent, nameLeft: nameBox?.left, nameRight: nameBox?.right, nameWidth: nameBox?.width,
    actionsLeft: actions.left, meters,
  };
};

function checkLayout(view, label) {
  assert.equal(view.meters.length, 4, `${label}: four meters`);
  assert.deepEqual(view.meters.map((meter) => meter.key), ['claude-week', 'claude-5h', 'model-fable', 'codex-week']);
  for (const meter of view.meters) {
    assert.ok(meter.left >= view.bar.left - 0.5, `${label}: ${meter.key} starts left of the session name's end`);
    assert.ok(meter.right <= view.bar.right + 0.5, `${label}: ${meter.key} runs into the header buttons`);
    assert.ok(meter.top >= view.bar.top - 0.5 && meter.bottom <= view.bar.bottom + 0.5, `${label}: ${meter.key} leaves the header`);
    assert.equal(meter.labelClipped, false, `${label}: ${meter.key} label is clipped`);
    assert.ok(meter.resetRight <= view.bar.right + 0.5, `${label}: ${meter.key} reset is clipped`);
  }
  assert.ok(view.pageScroll <= view.viewport, `${label}: the page scrolls sideways`);
  assert.ok(view.nameWidth >= 60, `${label}: the session name has only ${view.nameWidth}px`);
}

try {
  await agent.connect(`${hub.origin.replace(/^http/, 'ws')}/agent`);
  const t0 = Date.now();
  agent.sendUsage(snapshot(t0));
  browser = await launchBrowser();

  for (const [width, height, label] of [[1440, 900, 'desktop'], [390, 844, 'phone']]) {
    const page = await browser.newPage({ viewport: { width, height }, hasTouch: width < 760, isMobile: width < 760 });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await login(page, hub.origin, PASSWORD, `/s/${NAMES[0]}`);
    await page.waitForFunction((name) => document.querySelector('#term-title .term-name')?.textContent === name, NAMES[0], { timeout: 10000 });
    await page.waitForFunction(() => document.querySelectorAll('#usage .meter').length === 4, null, { timeout: 10000 });

    let view = await page.evaluate(READ);
    checkLayout(view, label);
    assert.deepEqual(view.meters.map((meter) => meter.pct), ['21%', '39%', '3%', '0%']);
    assert.ok(view.meters.every((meter) => meter.reset.startsWith('resets ')), 'reset times are inline without hover');
    assert.deepEqual(view.meters.map((meter) => Math.round(meter.fillRatio * 100)), [21, 39, 3, 0]);
    assert.deepEqual(view.meters.map((meter) => meter.reset), ['resets in 6d', 'resets in 3h', 'resets in 6d', 'resets in 6d']);
    assert.ok(view.meters.every((meter) => Math.abs(meter.top - view.meters[0].top) < 1), `${label}: the meters share one row`);
    assert.equal(view.meters[0].title, 'Claude weekly, all models: 21% used, resets in 6d');
    assert.equal(view.meters[1].title, 'Claude 5-hour: 39% used, resets in 3h');
    pass(`${label} ${width}px: four meters with inline resets (name ${Math.round(view.nameWidth)}px wide), bars and percents match, tooltips name the reset`);
    if (SHOTS) {
      await page.screenshot({ path: `${SHOTS}/usage-${width}.png` });
      const box = await page.locator('.term-bar').boundingBox();
      await page.screenshot({ path: `${SHOTS}/usage-${width}-header-zoom.png`, clip: { x: box.x, y: box.y, width: Math.min(box.width, 720), height: box.height } });
    }

    // A new snapshot updates the same meter elements in place.
    await page.evaluate(() => { window.__meter = document.querySelector('#usage .meter[data-key="claude-5h"]'); });
    agent.sendUsage(snapshot(Date.now(), { fiveHour: 92, week: 77 }));
    await page.waitForFunction(() => document.querySelector('#usage .meter[data-key="claude-5h"] .meter-pct').textContent === '92%', null, { timeout: 5000 });
    view = await page.evaluate(READ);
    assert.equal(await page.evaluate(() => window.__meter === document.querySelector('#usage .meter[data-key="claude-5h"]')), true);
    assert.match(view.meters[1].cls, /\bbad\b/);
    assert.match(view.meters[0].cls, /\bwarn\b/);
    pass(`${label}: a pushed snapshot updates the meters in place, 77% turns amber and 92% red`);

    // The panel lists every window with its reset time.
    if (width < 760) await page.tap('#usage-button'); else await page.click('#usage-button');
    await page.waitForSelector('#usage-panel');
    const panel = await page.evaluate(() => {
      const box = document.getElementById('usage-panel').getBoundingClientRect();
      return {
        rows: [...document.querySelectorAll('#usage-panel .usage-row')].map((row) => row.textContent.replace(/\s+/g, ' ').trim()),
        left: box.left, right: box.right, viewport: window.innerWidth,
      };
    });
    assert.equal(panel.rows.length, 4);
    assert.ok(panel.rows.every((row) => /resets /.test(row)), JSON.stringify(panel.rows));
    assert.ok(panel.left >= 0 && panel.right <= panel.viewport, `${label}: the panel leaves the screen`);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/usage-${width}-panel.png` });
    await page.keyboard.press('Escape');
    await page.waitForSelector('#usage-panel', { state: 'detached' });
    if (width < 760) await page.tap('#usage-button'); else await page.click('#usage-button');
    await page.waitForSelector('#usage-panel');
    await page.mouse.click(5, height - 40);
    await page.waitForSelector('#usage-panel', { state: 'detached' });
    pass(`${label}: ${width < 760 ? 'a tap' : 'a click'} opens the reset panel inside the screen, Escape and an outside click close it`);

    // Unavailable and stale.
    agent.sendUsage(snapshot(Date.now(), { fableAvailable: false, claudeStale: true }));
    await page.waitForFunction(() => document.querySelector('#usage .meter[data-key="model-fable"] .meter-pct').textContent === 'unavailable', null, { timeout: 5000 });
    view = await page.evaluate(READ);
    checkLayout(view, `${label} unavailable`);
    const fable = view.meters.find((meter) => meter.key === 'model-fable');
    assert.match(fable.cls, /\bna\b/);
    assert.match(fable.title, /^Fable weekly: unavailable: the usage answer has no weekly window for Fable, last known resets /);
    assert.match(fable.reset, /^last known resets /);
    assert.match(view.meters[0].cls, /\bstale\b/);
    assert.match(view.meters[0].title, /stale, the last refresh failed: the usage endpoint is rate limiting/);
    pass(`${label}: an unavailable window says unavailable and the reason, a stale one is dimmed and says why`);

    // A reload gets the hub's stored snapshot from /api/state.
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('#usage .meter').length === 4, null, { timeout: 10000 });
    assert.match(await page.locator('#usage .meter[data-key="model-fable"] .meter-reset').textContent(), /^last known resets /);
    pass(`${label}: a reload retains unavailable meters and their last known reset from the hub`);
    agent.sendUsage(snapshot(t0));
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(`\n${passed.length} checks passed`);
} finally {
  await browser?.close();
  agent.close();
  hub.stop();
}
