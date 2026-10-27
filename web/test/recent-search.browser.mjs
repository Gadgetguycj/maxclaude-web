import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ScriptedAgent, startHub, launchBrowser, login, hubSession, waitFor } from './view-harness.mjs';

const secret = 'recent-search-test', password = 'recent-search-test';
const names = Array.from({ length: 40 }, (_, i) => 'scroll-' + String(i).padStart(2, '0'));
const matches = names.slice(10, 20);
const hub = await startHub({ port: 18449, secret, password });
const agent = new ScriptedAgent(secret, names);
let browser;
try {
  await agent.connect(hub.origin.replace('http', 'ws') + '/agent');
  const api = await hubSession(hub.origin, password);
  await api('PUT', '/api/preferences/recent-limit', { recent_limit: 3 });
  browser = await launchBrowser();
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 3 });
    const page = await context.newPage();
    await login(page, hub.origin, password);
    const showSidebar = async () => {
      if (await page.locator('body').evaluate((el) => el.classList.contains('sidebar-collapsed'))) {
        await page.click('#bar-sidebar');
      }
    };
    if (width === 390) await showSidebar();
    const input = page.locator('.recent-search');
    const clear = page.locator('.recent-search-clear');
    const header = page.locator('.row.section[data-id="__recents__"]');
    const group = page.locator('.recent-scroll');
    const rows = group.locator('.recent');
    const rowNames = () => rows.evaluateAll((els) => els.map((el) => el.dataset.name));
    const filtered = async (query) => {
      await input.fill(query);
      await waitFor(async () => (await rows.count()) === 10, 3000, 'filtered rows');
      assert.deepEqual((await rowNames()).sort(), matches);
    };
    await input.waitFor();
    assert.equal(await input.inputValue(), '');
    assert.equal(await clear.count(), 0);
    assert.equal(await rows.count(), 40);
    const originalOrder = await rowNames();
    await input.click();
    assert.equal(await header.getAttribute('aria-expanded'), 'true');
    await filtered('scroll-1');
    assert.deepEqual(await rowNames(), originalOrder.filter((name) => name.includes('scroll-1')));
    const geometry = await group.evaluate((el) => ({ height: el.clientHeight, full: el.scrollHeight, row: el.firstElementChild.clientHeight }));
    assert.equal(geometry.height, geometry.row * 3);
    assert.ok(geometry.full > geometry.height);
    await group.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    assert.ok(await group.evaluate((el) => el.scrollTop > 0));
    await page.evaluate(() => { window.__keptRecent = document.querySelector('.recent[data-name="scroll-15"]'); });
    await filtered('SCROLL-1');
    assert.equal(await page.evaluate(() => window.__keptRecent === document.querySelector('.recent[data-name="scroll-15"]')), true);
    await input.focus();
    await page.evaluate(() => {
      window.__searchTreeKeys = [];
      document.querySelector('#tree').addEventListener('keydown', (ev) => window.__searchTreeKeys.push(ev.key));
    });
    const focusedRow = await page.evaluate(() => document.querySelector('#tree .row:focus')?.dataset.key || null);
    for (const key of ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End']) {
      await input.press(key);
      assert.equal(await input.evaluate((el) => document.activeElement === el), true, key + ' keeps input focus');
      assert.equal(await page.locator('#tree .row:focus').count(), 0, key + ' does not focus a tree row');
    }
    await input.pressSequentially('x');
    await waitFor(async () => (await rows.count()) === 0, 3000, 'typed query');
    await input.press('Backspace');
    await waitFor(async () => (await rows.count()) === 10, 3000, 'restored query');
    assert.deepEqual(await page.evaluate(() => window.__searchTreeKeys), [], 'input keys never reach the tree');
    assert.equal(focusedRow, null);
    assert.equal(await clear.count(), 1);
    await clear.click();
    assert.equal(await rows.count(), 40);
    assert.equal(await clear.count(), 0);
    assert.equal(await input.inputValue(), '');
    assert.equal(await input.evaluate((el) => document.activeElement === el), true);
    await filtered('scroll-1');
    const first = (await rowNames())[0];
    await input.press('Enter');
    await page.waitForFunction((name) => document.querySelector('#term-title .term-name')?.textContent === name, first);
    await showSidebar();
    assert.equal(await input.inputValue(), 'scroll-1');
    assert.equal(await rows.count(), 10);
    const other = (await rowNames()).find((name) => name !== first);
    await group.locator(`[data-name="${other}"]`).click();
    await page.waitForFunction((name) => document.querySelector('#term-title .term-name')?.textContent === name, other);
    await showSidebar();
    assert.equal(await input.inputValue(), 'scroll-1');
    assert.equal(await rows.count(), 10);
    await input.press('Escape');
    assert.equal(await input.inputValue(), '');
    assert.equal(await input.evaluate((el) => document.activeElement === el), true);
    assert.equal(await rows.count(), 40);
    await input.fill('nothing-here');
    assert.equal(await rows.count(), 0);
    assert.equal(await group.locator('.recent-empty').textContent(), 'No session matches nothing-here');
    await filtered('scroll-1');
    const boxes = await page.evaluate(() => {
      const rect = (selector) => {
        const el = document.querySelector(selector), r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height,
          clipped: el.scrollWidth > el.clientWidth };
      };
      return { sidebar: rect('.sidebar'), label: rect('.section-main .name'), input: rect('.recent-search'),
        select: rect('.recent-limit'), controls: rect('.recent-controls') };
    });
    if (width === 1440) assert.equal(boxes.sidebar.width, 300);
    for (const box of [boxes.label, boxes.input, boxes.select]) {
      assert.ok(box.left >= boxes.sidebar.left && box.right <= boxes.sidebar.right, JSON.stringify(boxes));
      assert.ok(Math.abs((box.top + box.bottom) / 2 - (boxes.input.top + boxes.input.bottom) / 2) <= 1, 'controls share one row');
    }
    assert.equal(boxes.label.clipped, false, 'Recent label is complete');
    assert.ok(boxes.label.right < boxes.input.left && boxes.input.right < boxes.controls.left, 'controls do not overlap');
    assert.equal(boxes.input.top, boxes.select.top);
    assert.equal(boxes.input.height, width === 1440 ? 18 : 30);
    assert.equal(boxes.select.width, width === 1440 ? 45 : 50);
    await header.locator('.section-main').click();
    assert.equal(await header.getAttribute('aria-expanded'), 'false');
    assert.equal(await input.isVisible(), true);
    assert.equal(await input.inputValue(), 'scroll-1');
    await input.click();
    assert.equal(await header.getAttribute('aria-expanded'), 'false');
    await header.locator('.section-main').click();
    assert.equal(await rows.count(), 10);
    if (process.env.MCW_SHOT_DIR) {
      await fs.mkdir(process.env.MCW_SHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.MCW_SHOT_DIR, `recent-search-${width}-full.png`), fullPage: true });
      await page.screenshot({ path: path.join(process.env.MCW_SHOT_DIR, `recent-search-${width}-sidebar.png`),
        clip: await page.locator('.sidebar').boundingBox() });
    }
    await page.reload();
    await showSidebar();
    await input.waitFor();
    assert.equal(await input.inputValue(), '', 'reload clears the query');
    assert.equal(await rows.count(), 40);
    console.log(`Recent search filtering, identity, keys, navigation, persistence and geometry at ${width}px: PASS`);
    await context.close();
  }
} finally {
  await browser?.close();
  agent.close();
  hub.stop();
}
