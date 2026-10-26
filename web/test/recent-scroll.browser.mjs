import assert from 'node:assert/strict';
import { ScriptedAgent, startHub, launchBrowser, login, hubSession, waitFor, TAG_TREE } from './view-harness.mjs';

const secret = 'recent-scroll-test', password = 'recent-scroll-test';
const names = Array.from({ length: 40 }, (_, i) => 'scroll-' + String(i).padStart(2, '0'));
const hub = await startHub({ port: 18439, secret, password });
const agent = new ScriptedAgent(secret, names);
let browser;
try {
  await agent.connect(hub.origin.replace('http', 'ws') + '/agent');
  const api = await hubSession(hub.origin, password);
  await api('PUT', '/api/preferences/recent-limit', { recent_limit: 3 });
  const folder = (await api('POST', '/api/folders', { name: 'Activity' })).node;
  for (const name of names.slice(0, 3)) await api('POST', '/api/adopt', { session_name: name, parent_id: folder.id });
  browser = await launchBrowser();
  const page = await browser.newPage();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
    if (width === 1440) await login(page, hub.origin, password);
    else { await page.goto(hub.origin); await page.click('#bar-sidebar'); }
    await page.waitForSelector('.recent-scroll');
    const group = page.locator('.recent-scroll');
    assert.equal(await group.locator('.recent').count(), names.length);
    const geometry = await group.evaluate((el) => ({ height: el.clientHeight, full: el.scrollHeight, row: el.firstElementChild.clientHeight }));
    assert.equal(geometry.height, geometry.row * 3);
    assert.ok(geometry.full > geometry.height);
    await group.hover();
    const outerBefore = await page.locator('#tree').evaluate((el) => el.scrollTop);
    await page.mouse.wheel(0, 400);
    await waitFor(() => group.evaluate((el) => el.scrollTop > 0), 2000, 'Recent wheel scroll');
    assert.equal(await page.locator('#tree').evaluate((el) => el.scrollTop), outerBefore);
    await group.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await page.mouse.wheel(0, 400);
    assert.equal(await page.locator('#tree').evaluate((el) => el.scrollTop), outerBefore, 'wheel stays contained at the end');
    const before = await page.evaluate(TAG_TREE);
    const leaf = page.locator('.leaf[data-name="scroll-00"]');
    await leaf.focus();
    agent.set('scroll-00', { lastActivityAt: Date.now() });
    agent.push();
    await page.waitForFunction(() => document.querySelector('[aria-label="Activity"][role="group"] .leaf')?.dataset.name === 'scroll-00');
    assert.deepEqual(await page.evaluate(TAG_TREE), before, 'rows and dots retain DOM identity after re-sort');
    assert.equal(await leaf.evaluate((el) => document.activeElement === el), true);
    await page.locator('select.recent-limit').selectOption('5');
    await page.waitForFunction(() => document.querySelector('.recent-scroll').clientHeight === document.querySelector('.recent').clientHeight * 5);
    assert.equal(await group.locator('.recent').count(), names.length);
    await page.reload();
    await page.waitForSelector('.recent-scroll');
    assert.equal(await group.locator('.recent').count(), names.length);
    const last = page.locator('.unfiled').last();
    await last.scrollIntoViewIfNeeded();
    assert.ok(await page.locator('#tree').evaluate((el) => el.scrollTop > 0), 'the rest of the sidebar still scrolls');
    await api('PUT', '/api/preferences/recent-limit', { recent_limit: 3 });
  }
  console.log('Recent retains every session, wheel containment, visible row count, outer scrolling, folder re-sort identity and focus at desktop and phone: PASS');
} finally {
  await browser?.close();
  agent.close();
  hub.stop();
}
