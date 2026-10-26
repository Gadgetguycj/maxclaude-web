import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from '/usr/lib/node_modules/playwright-chromium/index.mjs';
import { orderRecents } from '../public/assets/recent-order.js';

const PUBLIC = path.join(import.meta.dirname, '..', 'public');
const CHROME = process.env.MCW_CHROME || '/usr/bin/chromium';
const names = ['recent-a', 'recent-b', 'recent-c', 'recent-d'];
const clients = new Set();
let recentLimit = 5;
let revision = 0;
let status = Object.fromEntries(names.map((name, index) => [name, {
  state: 'idle', updatedAt: 1000 + index, lastResponseAt: 0, lastActivityAt: 1000 + index,
}]));

const sessions = names.map((name, index) => ({
  name, createdAt: 1000 + index, originalCreatedAt: 1000 + index,
  exited: false, current: false, activity: 'idle', activityUpdatedAt: 1000 + index,
  lastResponseAt: 0, lastActivityAt: 1000 + index,
}));
const tree = names.map((name, index) => ({
  id: `leaf-${index}`, kind: 'session', name, session_name: name,
  parent_id: null, position: (index + 1) * 1000, created_at: 1000 + index,
}));

function recents() {
  return orderRecents(sessions, status, recentLimit);
}

function snapshot() {
  return { session_status: status, session_status_meta: { connection_epoch: 1, revision, lease_ms: 60000 } };
}

function state() {
  return {
    agent: { connected: true, since: Date.now(), host: 'test' },
    tree, sessions, ...snapshot(), recents: recents(), recent_limit: recentLimit,
  };
}

function sendStatus() {
  revision += 1;
  const wire = `event: sessions.status\ndata: ${JSON.stringify(snapshot())}\n\n`;
  for (const response of clients) response.write(wire);
}

function json(response, code, body) {
  response.writeHead(code, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname === '/api/me') return json(response, 200, { authenticated: true });
  if (url.pathname === '/api/state') return json(response, 200, state());
  if (url.pathname === '/api/events') {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    response.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(response);
    request.on('close', () => clients.delete(response));
    return;
  }
  if (url.pathname === '/api/preferences/recent-limit' && request.method === 'PUT') {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      recentLimit = Number(JSON.parse(body).recent_limit);
      json(response, 200, { recent_limit: recentLimit, recents: recents() });
    });
    return;
  }
  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const page = ['index.html', 'app.js', 'styles.css', 'assets/status-lease.js', 'assets/recent-order.js', 'assets/session-url.js'].includes(file)
    || /^assets\/(view|vendor)\/[a-z.-]+\.js$/.test(file);
  if (!page) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
  response.end(fs.readFileSync(path.join(PUBLIC, file)));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#tree .row[data-kind="recent"]');
  assert.deepEqual(await page.locator('#tree .row[data-kind="recent"] .name').allTextContents(), names.slice().reverse());

  await page.evaluate(() => {
    for (const row of document.querySelectorAll('#tree .row[data-kind="recent"]')) row.__identity = row.dataset.name;
  });
  await page.locator('#tree .row[data-kind="recent"][data-name="recent-d"] button.act').click();
  await page.locator('.menu-item').first().focus();
  status['recent-a'] = { state: 'idle', updatedAt: 5000, lastResponseAt: 0, lastActivityAt: 5000 };
  sendStatus();
  await page.waitForFunction(() => document.querySelector('#tree .row[data-kind="recent"]')?.dataset.name === 'recent-a');
  assert.equal(await page.locator('.menu-head').textContent(), 'recent-d');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Open terminal');
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('#tree .row[data-kind="recent"]')].every((row) => row.__identity === row.dataset.name)), true);

  await page.keyboard.press('Escape');
  await page.locator('#tree .row[data-kind="recent"][data-name="recent-a"] button.act').click();
  await page.getByRole('menuitem', { name: 'Rename session' }).click();
  const rename = page.locator('form.modal-card[aria-label="Rename session"] input.inp');
  await rename.fill('typing-stays');
  await rename.press('ArrowLeft');
  const selection = await rename.evaluate((input) => [input.selectionStart, input.selectionEnd]);
  sessions.find((session) => session.name === 'recent-a').lastActivityAt = 9000;
  status['recent-b'] = { state: 'idle', updatedAt: 6000, lastResponseAt: 0, lastActivityAt: 6000 };
  sendStatus();
  await page.waitForFunction(() => document.querySelector('#tree .row[data-kind="recent"]')?.dataset.name === 'recent-b');
  assert.equal(await rename.inputValue(), 'typing-stays');
  assert.deepEqual(await rename.evaluate((input) => [input.selectionStart, input.selectionEnd]), selection);
  assert.equal(await rename.evaluate((input) => document.activeElement === input), true);
  await page.keyboard.press('Escape');

  status['recent-c'] = { state: 'background', updatedAt: 7000, lastResponseAt: 0, lastActivityAt: 7000 };
  status['recent-d'] = { state: 'busy', updatedAt: 6500, lastResponseAt: 0, lastActivityAt: 6500 };
  sendStatus();
  await page.waitForFunction(() => document.querySelector('#tree .row[data-kind="recent"]')?.dataset.name === 'recent-c');
  const backgroundRow = page.locator('#tree .row[data-kind="recent"][data-name="recent-c"]');
  assert.match(await backgroundRow.getAttribute('aria-label'), /working in background/);
  assert.equal(await backgroundRow.locator('.dot').evaluate((dot) => getComputedStyle(dot).animationDuration), '2.4s');

  const order = () => page.locator('#tree .row[data-kind="recent"] .name').allTextContents();
  const liveOrder = await order();
  assert.deepEqual(liveOrder, ['recent-c', 'recent-d', 'recent-b', 'recent-a']);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#tree .row[data-kind="recent"]');
    assert.deepEqual(await order(), liveOrder);
  }

  await page.locator('select.recent-limit').selectOption('3');
  await page.waitForFunction(() => document.querySelectorAll('#tree .row[data-kind="recent"]').length === 4);
  assert.equal(await page.locator('select.recent-limit').inputValue(), '3');

  const nearMinute = Date.now() - 59500;
  status['recent-a'] = { state: 'idle', updatedAt: nearMinute, lastResponseAt: 0, lastActivityAt: nearMinute };
  status['recent-b'] = { state: 'idle', updatedAt: nearMinute - 1000, lastResponseAt: 0, lastActivityAt: nearMinute - 1000 };
  sendStatus();
  const age = page.locator('#tree .row[data-kind="recent"][data-name="recent-a"] .age');
  await page.waitForFunction(() => document.querySelector('#tree .row[data-name="recent-a"] .age')?.textContent === '<1m');
  await page.waitForFunction(() => document.querySelector('#tree .row[data-name="recent-a"] .age')?.textContent === '1m', null, { timeout: 5000 });
  assert.equal(await age.textContent(), '1m');

  console.log('recent sorting, reload consistency, background state, stable rows, focus, count, and relative time: PASS');
} finally {
  await browser.close();
  server.close();
}
