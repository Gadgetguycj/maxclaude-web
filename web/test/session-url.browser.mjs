// Real-browser test for session addresses (hub v25).
//
// The operator asked for every session to have its own URL. This runs the real hub
// (src/server.js), speaks the agent side of the wire, and drives the real app.js in headless
// Chromium. Terminal frames load a small page from the agent instead of zellij.
//
// It covers a deep link while logged out, login, and landing on the session; in-page switches
// from Recent, Folders and Unfiled with back and forward; reload; a pasted address; links that
// open in a new tab and keep the browser's link menu; keyboard activation and accessible names;
// a deleted session's address; a rename that replaces the address; and a sleeping session's
// address waking it.
//
//   node test/session-url.browser.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { chromium } from '/usr/lib/node_modules/playwright-chromium/index.mjs';
import { sessionPath } from '../public/assets/session-url.js';

const PORT = 18331;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SECRET = 'session-url-secret';
const PASSWORD = 'session-url-password';
const CHROME = process.env.MCW_CHROME || '/usr/bin/chromium';
const SHOTS = process.env.MCW_SHOT_DIR || '';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcw-session-url-'));
const WAKE_MS = 700;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await wait(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function makeFrame(kind, id, flags, payload) {
  const head = Buffer.allocUnsafe(6);
  head[0] = kind;
  head.writeUInt32BE(id, 1);
  head[5] = flags;
  return Buffer.concat([head, payload]);
}

class Agent {
  constructor() {
    this.ws = null;
    this.timer = null;
    this.calls = [];
    this.rows = new Map();
    const names = ['alpha', 'beta.dev', 'gamma-2', 'renamable', 'doomed', 'victim', 'café', 'sleepy'];
    names.forEach((name, index) => this.rows.set(name, {
      name, created: 'Created 1h ago', createdAt: 1000 + index, exited: false, current: false,
      sleeping: name === 'sleepy', resumable: true, lastActivityAt: 5000 + index,
    }));
  }

  sessions() {
    return [...this.rows.values()].map((row) => ({
      ...row, activity: row.sleeping ? 'sleeping' : 'idle',
      activityUpdatedAt: row.lastActivityAt, lastResponseAt: 0,
    }));
  }

  status() {
    return Object.fromEntries([...this.rows.values()].map((row) => [row.name, {
      state: row.sleeping ? 'sleeping' : 'idle', updatedAt: row.lastActivityAt, lastResponseAt: 0, lastActivityAt: row.lastActivityAt,
    }]));
  }

  connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        const msg = JSON.parse(data.toString());
        if (msg.t === 'hello') {
          const proof = crypto.createHmac('sha256', SECRET).update(msg.nonce, 'ascii').digest('hex');
          ws.send(JSON.stringify({ t: 'auth', v: 1, agent: 'test', ts: 1, proof, agentVersion: 'test/1' }));
        } else if (msg.t === 'auth.ok') {
          this.send({ t: 'event', event: 'agent.ready', data: { host: 'session-host', webSharing: 'on' } });
          this.timer = setInterval(() => this.push(), 1000);
          resolve();
        } else if (msg.t === 'auth.err') {
          reject(new Error('agent auth refused'));
        } else if (msg.t === 'ping') {
          this.send({ t: 'pong', id: msg.id });
        } else if (msg.t === 'req') {
          this.onReq(msg);
        } else if (msg.t === 'http.req') {
          this.onHttp(msg);
        }
      });
      ws.on('error', reject);
    });
  }

  reply(msg, result) { this.send({ t: 'res', id: msg.id, ok: true, result }); }
  refuse(msg, code, message) { this.send({ t: 'res', id: msg.id, ok: false, error: { code, message } }); }

  onReq(msg) {
    const params = msg.params || {};
    this.calls.push([msg.method, params.name || params.oldName || null]);
    if (msg.method === 'sessions.list' || msg.method === 'sessions.listFast') return this.reply(msg, { sessions: this.sessions() });
    if (msg.method === 'sessions.reserveViewer') return this.reply(msg, { name: params.name, leaseId: `lease-${msg.id}` });
    if (msg.method === 'sessions.releaseViewer') return this.reply(msg, { released: true });
    if (msg.method === 'sessions.wake') {
      const row = this.rows.get(params.name);
      if (!row?.sleeping) return this.refuse(msg, 'conflict', `session ${params.name} is not sleeping`);
      return setTimeout(() => {
        row.sleeping = false;
        this.push();
        this.reply(msg, { name: params.name, waking: false, wakeMs: WAKE_MS });
      }, WAKE_MS);
    }
    if (msg.method === 'sessions.rename') {
      const row = this.rows.get(params.oldName);
      if (!row) return this.refuse(msg, 'not_found', `session ${params.oldName} does not exist`);
      this.rows.delete(params.oldName);
      this.rows.set(params.newName, { ...row, name: params.newName });
      this.push();
      return this.reply(msg, {
        oldName: params.oldName, newName: params.newName, renamed: true,
        oldUnit: 'old.service', newUnit: 'new.service', claudeReports: [`Session renamed to ${params.newName}`],
      });
    }
    if (msg.method === 'sessions.delete') {
      this.rows.delete(params.name);
      this.push();
      return this.reply(msg, { name: params.name, deleted: true });
    }
    return this.refuse(msg, 'unsupported', msg.method);
  }

  // The terminal frame's document. It records the path the frame asked for.
  onHttp(msg) {
    const body = Buffer.from(`<!doctype html><html><body data-path="${msg.path}">terminal stand-in for ${msg.path}</body></html>`);
    this.send({ t: 'http.res', id: msg.id, status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    this.ws.send(makeFrame(0x02, msg.id, 0, body));
    this.ws.send(makeFrame(0x02, msg.id, 0x01, Buffer.alloc(0)));
  }

  push() {
    this.send({ t: 'event', event: 'sessions.status', data: { sessions: this.status() } });
  }

  send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  close() {
    clearInterval(this.timer);
    this.ws?.close();
  }
}

// The hub API as a second browser would use it.
async function hubApi(method, urlPath, body, cookie) {
  const res = await fetch(`${ORIGIN}${urlPath}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${urlPath} returned ${res.status} ${JSON.stringify(json)}`);
  return { json, headers: res.headers };
}

const hub = spawn('node', ['src/server.js'], {
  cwd: path.join(import.meta.dirname, '..'),
  env: {
    ...process.env, PORT: String(PORT), DATA_DIR, COOKIE_SECURE: 'false',
    OPERATOR_PASSWORD: PASSWORD, AGENT_SECRET: SECRET, STATUS_LEASE_MS: '5000',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
hub.stderr.on('data', (chunk) => process.stderr.write(chunk));
const agent = new Agent();
let browser;
const passed = [];
function pass(label) {
  passed.push(label);
  console.log(`PASS ${label}`);
}

try {
  await waitFor(async () => {
    try { return (await fetch(`${ORIGIN}/healthz`)).ok; } catch { return false; }
  }, 15000, 'hub to listen');
  await agent.connect(`ws://127.0.0.1:${PORT}/agent`);

  // Another browser files beta.dev into a folder and shows every session in Recent.
  const login = await hubApi('POST', '/api/login', { password: PASSWORD });
  const other = login.headers.get('set-cookie').split(';')[0];
  const folder = (await hubApi('POST', '/api/folders', { name: 'Work', parent_id: null }, other)).json.node;
  await hubApi('POST', '/api/adopt', { session_name: 'beta.dev', parent_id: folder.id }, other);
  await hubApi('PUT', '/api/preferences/recent-limit', { recent_limit: 15 }, other);

  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));

  const pathname = () => page.evaluate(() => location.pathname);
  const historyLength = () => page.evaluate(() => history.length);
  // The session whose terminal frame is on screen, with the path its document loaded.
  const shown = () => page.evaluate(() => {
    const frame = document.querySelector('.term-frame.active:not(.warm-hidden)');
    if (!frame) return null;
    let loaded = null;
    try { loaded = frame.contentDocument?.body?.dataset.path || null; } catch { loaded = null; }
    return { name: frame.dataset.name, loaded };
  });
  const waitShown = (name) => page.waitForFunction((wanted) => {
    const frame = document.querySelector('.term-frame.active:not(.warm-hidden)');
    return frame?.dataset.name === wanted && frame.contentDocument?.body?.dataset.path === '/' + encodeURIComponent(wanted);
  }, name, { timeout: 10000 });
  const selected = () => page.evaluate(() => [...document.querySelectorAll('#tree .row.selected')].map((row) => [row.dataset.kind, row.dataset.name, row.getAttribute('aria-current')]));
  const notice = () => page.evaluate(() => {
    const empty = document.getElementById('no-session');
    return empty && !empty.hidden ? empty.innerText.replace(/\s+/g, ' ').trim() : null;
  });
  const row = (kind, name) => page.locator(`#tree a.row[data-kind="${kind}"][data-name="${name}"]`);
  const markPage = () => page.evaluate(() => { window.__samePage = 'yes'; });
  const samePage = () => page.evaluate(() => window.__samePage === 'yes');

  // 1. A deep link while logged out shows the login, keeps the address, then lands on the session.
  await page.goto(`${ORIGIN}/s/gamma-2`, { waitUntil: 'domcontentloaded' });
  await page.locator('#login-password').waitFor({ state: 'visible' });
  assert.equal(await pathname(), '/s/gamma-2');
  assert.equal(await page.locator('#app').isHidden(), true);
  const loginHistory = await historyLength();
  await page.locator('#login-password').fill(PASSWORD);
  await page.locator('#login-submit').click();
  await waitShown('gamma-2');
  assert.equal(await pathname(), '/s/gamma-2');
  assert.equal(await historyLength(), loginHistory, 'following the address adds no history entry');
  await page.waitForSelector('#tree a.row[data-kind="recent"][data-name="gamma-2"].selected');
  assert.ok((await selected()).every(([, name, current]) => name === 'gamma-2' && current === 'page'));
  pass('deep link while logged out, then login, lands on gamma-2');

  // 2. Every session row is a link to its address, focusable, and named with its state.
  await page.waitForFunction(() => document.querySelectorAll('#tree a.row[data-kind="recent"]').length === 8
    && !document.querySelector('#tree .row .dot.st-unknown'));
  const rows = await page.evaluate(() => [...document.querySelectorAll('#tree .row[data-name]')].map((el) => ({
    tag: el.tagName, kind: el.dataset.kind, name: el.dataset.name, href: el.getAttribute('href'),
    resolved: el.href, role: el.getAttribute('role'), tabindex: el.getAttribute('tabindex'),
    label: el.getAttribute('aria-label'), draggable: el.getAttribute('draggable'),
  })));
  const kinds = new Set(rows.map((r) => r.kind));
  assert.deepEqual([...kinds].sort(), ['leaf', 'recent', 'unfiled']);
  assert.equal(rows.filter((r) => r.kind === 'leaf').map((r) => r.name).join(), 'beta.dev');
  for (const r of rows) {
    assert.equal(r.tag, 'A', `${r.kind} ${r.name} is a link`);
    assert.equal(r.href, sessionPath(r.name), `${r.kind} ${r.name} href`);
    assert.equal(r.resolved, ORIGIN + sessionPath(r.name));
    assert.equal(r.role, 'treeitem');
    assert.equal(r.tabindex, '0');
    assert.equal(r.draggable, 'false');
    const state = r.name === 'sleepy' ? 'sleeping' : 'waiting for input';
    assert.ok(r.label.startsWith(`${r.name}, ${state}`), `${r.kind} ${r.name} label ${r.label}`);
  }
  assert.equal(rows.find((r) => r.name === 'café').href, '/s/caf%C3%A9');
  assert.equal(await page.getByRole('treeitem', { name: 'sleepy, sleeping, recent', exact: true }).count(), 1);
  assert.equal(await page.getByRole('treeitem', { name: 'beta.dev, waiting for input', exact: true }).count(), 1);
  pass('rows in Recent, Folders and Unfiled are links with the session address, role, focus and state');

  // 3. A plain left-click switches in-page, and back and forward move between the opened sessions.
  await markPage();
  const visits = [];
  for (const [kind, name] of [['unfiled', 'alpha'], ['leaf', 'beta.dev'], ['recent', 'alpha'], ['unfiled', 'gamma-2']]) {
    const before = await historyLength();
    await row(kind, name).click();
    await waitShown(name);
    assert.equal(await pathname(), sessionPath(name));
    assert.equal(await historyLength(), before + 1, `opening ${name} from ${kind} adds one history entry`);
    visits.push(name);
  }
  await row('recent', 'gamma-2').click();
  await page.waitForTimeout(100);
  assert.equal(await historyLength(), loginHistory + visits.length, 'opening the open session adds no entry');
  for (const name of ['alpha', 'beta.dev', 'alpha', 'gamma-2']) {
    await page.goBack();
    await waitShown(name);
    assert.equal(await pathname(), sessionPath(name));
  }
  for (const name of ['alpha', 'beta.dev', 'alpha', 'gamma-2']) {
    await page.goForward();
    await waitShown(name);
    assert.equal(await pathname(), sessionPath(name));
  }
  assert.equal(await samePage(), true, 'no click, back or forward reloaded the page');
  pass('plain clicks switch in-page, back and forward follow the opened sessions');

  // 4. Enter and Space on a focused link open it in-page.
  await row('unfiled', 'alpha').focus();
  await page.keyboard.press('Enter');
  await waitShown('alpha');
  assert.equal(await pathname(), '/s/alpha');
  await row('recent', 'beta.dev').focus();
  await page.keyboard.press(' ');
  await waitShown('beta.dev');
  assert.equal(await pathname(), '/s/beta.dev');
  assert.equal(await samePage(), true);
  pass('Enter and Space on a focused session link open it in-page');

  // 5. Middle-click and Ctrl-click open the session in a new tab and leave this tab alone.
  for (const [how, kind, expected] of [['middle', 'unfiled', 'gamma-2'], ['ctrl', 'leaf', 'beta.dev'], ['ctrl', 'recent', 'alpha']]) {
    const target = row(kind, expected);
    const opened = context.waitForEvent('page');
    if (how === 'middle') await target.click({ button: 'middle' });
    else await target.click({ modifiers: ['Control'] });
    const tab = await opened;
    await tab.waitForFunction((wanted) => {
      const frame = document.querySelector('.term-frame.active:not(.warm-hidden)');
      return frame?.dataset.name === wanted && frame.contentDocument?.body?.dataset.path === '/' + encodeURIComponent(wanted);
    }, expected, { timeout: 10000 });
    assert.equal(new URL(tab.url()).pathname, sessionPath(expected));
    await tab.close();
    assert.equal(await pathname(), '/s/beta.dev', `${how}-click left this tab on beta.dev`);
    assert.equal((await shown()).name, 'beta.dev');
  }
  pass('middle-click and Ctrl-click open the session in a new tab');

  // 6. A mouse right-click on a session link keeps the browser's link menu. The row menu stays
  // on the action button, Shift+F10, and right-click on folders.
  await page.evaluate(() => {
    window.__context = [];
    window.addEventListener('contextmenu', (ev) => window.__context.push({ prevented: ev.defaultPrevented, type: ev.pointerType }));
  });
  await row('unfiled', 'alpha').click({ button: 'right' });
  await page.waitForTimeout(100);
  assert.deepEqual(await page.evaluate(() => window.__context), [{ prevented: false, type: 'mouse' }]);
  assert.equal(await page.locator('.menu').count(), 0);
  await page.locator('#tree .row.folder').click({ button: 'right' });
  await page.locator('.menu .menu-head', { hasText: 'Work' }).waitFor();
  await page.keyboard.press('Escape');
  await row('unfiled', 'alpha').focus();
  await page.keyboard.press('Shift+F10');
  await page.getByRole('menuitem', { name: 'Open terminal' }).waitFor();
  await page.keyboard.press('Escape');
  await row('unfiled', 'alpha').hover();
  await row('unfiled', 'alpha').locator('button[data-act="menu"]').click();
  await page.getByRole('menuitem', { name: 'Open terminal' }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await pathname(), '/s/beta.dev', 'the action button did not follow the link');
  assert.equal(await samePage(), true);
  pass('right-click keeps the browser link menu, the row menu stays on its button, Shift+F10 and folders');

  // 7. Reload reopens the same session.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitShown('beta.dev');
  assert.equal(await pathname(), '/s/beta.dev');
  pass('reload reopens beta.dev');

  // 8. A pasted or bookmarked address opens that session directly.
  await page.goto(`${ORIGIN}/s/alpha`, { waitUntil: 'domcontentloaded' });
  await waitShown('alpha');
  assert.equal(await pathname(), '/s/alpha');
  pass('a pasted address opens alpha');

  // 9. Renaming the open session replaces its address.
  await markPage();
  await row('unfiled', 'renamable').click();
  await waitShown('renamable');
  await page.evaluate(() => { window.__renamedFrame = document.querySelector('.term-frame.active'); });
  const renameHistory = await historyLength();
  await row('unfiled', 'renamable').hover();
  await row('unfiled', 'renamable').locator('button[data-act="menu"]').click();
  await page.getByRole('menuitem', { name: 'Rename session' }).click();
  const dialog = page.locator('form.modal-card[aria-label="Rename session"]');
  await dialog.locator('input.inp').fill('renamed.v2');
  await dialog.locator('button[type="submit"]').click();
  await dialog.waitFor({ state: 'detached' });
  // The open terminal is the same session under a new name, so its frame stays. zellij then sends
  // its client SwitchedSession and the client replaces its own frame's address, as here.
  assert.equal(await page.evaluate(() => document.querySelector('.term-frame.active') === window.__renamedFrame
    && window.__renamedFrame.dataset.name === 'renamed.v2'), true, 'the open frame was kept under the new name');
  await page.evaluate(() => { window.__renamedFrame.contentWindow.location.replace('/renamed.v2'); });
  await waitShown('renamed.v2');
  assert.equal(await pathname(), '/s/renamed.v2');
  assert.equal(await historyLength(), renameHistory, 'the rename replaced the history entry');
  await page.waitForSelector('#tree a.row[data-kind="unfiled"][data-name="renamed.v2"].selected');
  assert.equal(await row('unfiled', 'renamed.v2').getAttribute('href'), '/s/renamed.v2');
  await page.goBack();
  await waitShown('alpha');
  assert.equal(await pathname(), '/s/alpha', 'back skips the old name');
  await page.goForward();
  await waitShown('renamed.v2');
  assert.equal(await samePage(), true);
  pass('a rename replaces the open session address, and back skips the old name');

  // 10. A sleeping session's address wakes it, as a click does.
  const wakesBefore = agent.calls.filter(([method]) => method === 'sessions.wake').length;
  await page.goto(`${ORIGIN}/s/sleepy`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('no-session')?.innerText.includes('Opening sleepy.'));
  assert.equal(await page.locator('#tree a.row[data-kind="recent"][data-name="sleepy"] .dot.st-waking').count(), 1);
  await waitShown('sleepy');
  assert.equal(await pathname(), '/s/sleepy');
  assert.deepEqual(agent.calls.filter(([method]) => method === 'sessions.wake').slice(wakesBefore), [['sessions.wake', 'sleepy']]);
  await page.locator('.toast', { hasText: 'Woke sleepy in' }).waitFor();
  pass('the sleeping session address woke sleepy and opened it');

  // 11. An address for a deleted session shows a notice with a link back, never a frame.
  const doomed = (await hubApi('POST', '/api/adopt', { session_name: 'doomed', parent_id: null }, other)).json.node;
  await hubApi('DELETE', `/api/sessions/${doomed.id}`, null, other);
  await page.goto(`${ORIGIN}/s/doomed`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#no-session .notice[data-kind="missing"]'));
  assert.equal(await notice(), 'There is no session named doomed. It may have been deleted or renamed. Back to sessions');
  assert.equal(await shown(), null);
  assert.equal(await page.locator('.term-frame').count(), 0, 'no terminal frame was created for doomed');
  assert.equal(await pathname(), '/s/doomed');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'desktop-deleted-notice.png') });
  await markPage();
  const noticeHistory = await historyLength();
  await page.getByRole('link', { name: 'Back to sessions' }).click();
  await page.waitForFunction(() => document.getElementById('no-session')?.innerText.trim() === 'No session open.');
  assert.equal(await pathname(), '/');
  assert.equal(await historyLength(), noticeHistory + 1);
  await page.goBack();
  await page.waitForFunction(() => document.querySelector('#no-session .notice[data-kind="missing"]'));
  assert.equal(await samePage(), true);
  pass('a deleted session address shows a notice, and its link goes back to the session list');

  // 12. The open session deleted from another browser turns into the same notice in place.
  await row('unfiled', 'victim').click();
  await waitShown('victim');
  const victim = (await hubApi('POST', '/api/adopt', { session_name: 'victim', parent_id: null }, other)).json.node;
  await hubApi('DELETE', `/api/sessions/${victim.id}`, null, other);
  await page.waitForFunction(() => document.querySelector('#no-session .notice[data-kind="missing"]'), null, { timeout: 10000 });
  assert.equal(await notice(), 'There is no session named victim. It may have been deleted or renamed. Back to sessions');
  assert.equal(await pathname(), '/s/victim');
  assert.equal(await shown(), null);
  pass('an open session deleted elsewhere shows the notice at its address');

  // 13. Addresses that cannot name a session, or a session the hub refuses, say so.
  for (const [address, expected] of [
    ['/s/never-existed', 'There is no session named never-existed. It may have been deleted or renamed. Back to sessions'],
    ['/s/a/b', 'This address does not name a session. Back to sessions'],
    ['/s/', 'This address does not name a session. Back to sessions'],
    ['/s/%E0%A4%A', 'This address does not name a session. Back to sessions'],
    ['/s/caf%C3%A9-gone', 'café-gone is not a session name. Session names use letters, numbers, dot, dash and underscore, up to 64 characters. Back to sessions'],
  ]) {
    await page.goto(ORIGIN + address, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#no-session .notice:not([data-kind="opening"])'));
    assert.equal(await notice(), expected, address);
    assert.equal(await page.locator('.term-frame').count(), 0, `${address} created no frame`);
  }
  pass('unknown, malformed and refused addresses show a notice and no frame');

  // 14. Phone width: the notice fits, and the link back opens the session list.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${ORIGIN}/s/doomed`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#no-session .notice[data-kind="missing"]'));
  // The legend footer already overflows 390 px on 2a87d94, so only the notice is measured.
  const fits = await page.evaluate(() => {
    const el = document.querySelector('#no-session .notice');
    const box = el.getBoundingClientRect();
    return box.left >= 0 && box.right <= window.innerWidth && el.scrollWidth <= el.clientWidth;
  });
  assert.equal(fits, true, 'the notice fits a phone screen');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'phone-deleted-notice.png') });
  await page.getByRole('link', { name: 'Back to sessions' }).click();
  await page.waitForFunction(() => !document.body.classList.contains('sidebar-collapsed'));
  assert.equal(await pathname(), '/');
  await page.setViewportSize({ width: 1440, height: 900 });
  pass('on a phone the notice fits and its link opens the session list');

  // Warm switches between two open sessions, measured in the page from click to frame shown.
  await page.goto(`${ORIGIN}/s/alpha`, { waitUntil: 'domcontentloaded' });
  await waitShown('alpha');
  await row('unfiled', 'gamma-2').click();
  await waitShown('gamma-2');
  const switches = [];
  for (let i = 0; i < 12; i += 1) {
    const name = i % 2 ? 'gamma-2' : 'alpha';
    switches.push(await page.evaluate(async (wanted) => {
      const target = document.querySelector(`#tree .row[data-kind="unfiled"][data-name="${wanted}"]`);
      const start = performance.now();
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      for (;;) {
        const frame = document.querySelector('.term-frame.active:not(.warm-hidden)');
        if (frame?.dataset.name === wanted) return performance.now() - start;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    }, name));
  }
  switches.sort((a, b) => a - b);
  console.log(`warm switch, click to frame shown: median ${switches[6].toFixed(1)} ms, max ${switches[11].toFixed(1)} ms`);

  assert.deepEqual(errors, [], 'no page errors');
  assert.equal(passed.length, 14);
  console.log(`${passed.length}/14 session address checks passed`);
} finally {
  await browser?.close();
  agent.close();
  hub.kill('SIGTERM');
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}
