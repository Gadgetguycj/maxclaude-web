// Real-browser regression test for the Recent order, from the 2026-10-02 report.
//
// It runs the real hub (src/server.js), speaks the agent side of the wire, and drives the real
// app.js in headless Chromium. Every green session, busy or background, must sit above every
// other light. The server's /api/state recents and the browser's live re-sort must agree, and
// a reload must show the live order.
//
//   node test/recent-green.browser.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { chromium } from '/usr/lib/node_modules/playwright-chromium/index.mjs';
import { ACTIVITY_20261002, EXPECTED_20261002, OBSERVED_20261002, greenFirst } from './recent-evidence.mjs';

const PORT = 18321;
const SECRET = 'recent-green-secret';
const PASSWORD = 'recent-green-password';
const CHROME = process.env.MCW_CHROME || '/usr/bin/chromium';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcw-recent-green-'));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await wait(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

class Agent {
  constructor() {
    this.ws = null;
    this.status = Object.fromEntries(OBSERVED_20261002.map(([name, state]) => [name, {
      state, updatedAt: ACTIVITY_20261002[name], lastResponseAt: 0, lastActivityAt: ACTIVITY_20261002[name],
    }]));
    this.timer = null;
  }

  sessions() {
    return OBSERVED_20261002.map(([name], index) => ({
      name, created: 'Created 1h ago', createdAt: 1000 + index,
      activity: this.status[name].state, activityUpdatedAt: this.status[name].lastActivityAt,
      lastActivityAt: this.status[name].lastActivityAt, lastResponseAt: 0, exited: false, current: false,
    }));
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
          // The real agent republishes its status snapshot every second.
          this.timer = setInterval(() => this.push(), 1000);
          resolve();
        } else if (msg.t === 'auth.err') {
          reject(new Error('agent auth refused'));
        } else if (msg.t === 'ping') {
          this.send({ t: 'pong', id: msg.id });
        } else if (msg.t === 'req' && (msg.method === 'sessions.list' || msg.method === 'sessions.listFast')) {
          this.send({ t: 'res', id: msg.id, ok: true, result: { sessions: this.sessions() } });
        } else if (msg.t === 'req') {
          this.send({ t: 'res', id: msg.id, ok: false, error: { code: 'unsupported', message: msg.method } });
        }
      });
      ws.on('error', reject);
    });
  }

  push() {
    this.send({ t: 'event', event: 'sessions.status', data: { sessions: this.status } });
  }

  send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  close() {
    clearInterval(this.timer);
    this.ws?.close();
  }
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

try {
  await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok; } catch { return false; }
  }, 15000, 'hub to listen');
  await agent.connect(`ws://127.0.0.1:${PORT}/agent`);

  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('#login-password').fill(PASSWORD);
  await page.locator('#login-submit').click();
  await page.waitForSelector('#tree .row[data-kind="recent"]');
  await page.evaluate(() => fetch('/api/preferences/recent-limit', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ recent_limit: 15 }),
  }));
  await page.reload({ waitUntil: 'domcontentloaded' });

  const live = () => page.evaluate(() => [...document.querySelectorAll('#tree .row[data-kind="recent"]')].map((row) => ({
    name: row.dataset.name,
    state: (row.querySelector('.dot')?.className.match(/\bst-(\S+)/) || [])[1],
  })));
  const server = () => page.evaluate(async () => {
    const state = await (await fetch('/api/state')).json();
    return state.recents.map((entry) => ({ name: entry.session_name, state: state.session_status[entry.session_name]?.state }));
  });
  // Every change to the tree is checked for a green row below another light, from load to finish.
  const watch = () => page.evaluate(() => {
    window.__violations = [];
    const check = () => {
      let other = false;
      for (const row of document.querySelectorAll('#tree .row[data-kind="recent"]')) {
        const green = /\bst-(busy|background)\b/.test(row.querySelector('.dot')?.className || '');
        if (!green) other = true;
        else if (other) {
          window.__violations.push(row.dataset.name);
          return;
        }
      }
    };
    new MutationObserver(check).observe(document.querySelector('#tree'), { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    check();
  });
  const violations = () => page.evaluate(() => window.__violations);
  const names = (rows) => rows.map((row) => row.name);

  await page.waitForFunction((count) => document.querySelectorAll('#tree .row[data-kind="recent"] .dot:not(.st-unknown)').length === count, OBSERVED_20261002.length);
  await watch();
  const first = await live();
  assert.deepEqual(names(first), EXPECTED_20261002, 'the live list puts the green rows first');
  assert.equal(greenFirst(first), true);
  assert.ok(names(first).indexOf('session-a') < first.findIndex((row) => row.state === 'idle'), 'session-a sits above every idle row');
  assert.deepEqual(await server(), first, '/api/state recents equal the live list');

  const move = async (name, state, expected) => {
    agent.status[name] = { ...agent.status[name], state };
    const pushed = Date.now();
    agent.push();
    await page.waitForFunction(([wanted, light]) => {
      const rows = [...document.querySelectorAll('#tree .row[data-kind="recent"]')];
      return rows.map((row) => row.dataset.name).join(',') === wanted
        && rows.find((row) => row.dataset.name === light[0])?.querySelector('.dot')?.classList.contains('st-' + light[1]);
    }, [expected.join(','), [name, state]], { timeout: 3000, polling: 10 });
    const ms = Date.now() - pushed;
    assert.ok(ms < 1000, `${name} reached its ${state} place in ${ms} ms`);
    const rows = await live();
    assert.equal(greenFirst(rows), true);
    assert.deepEqual(await server(), rows, `/api/state equals the live list after ${name} became ${state}`);
    return ms;
  };

  const latencies = [];
  // Green rows are ordered by name, so a row entering the green group takes its name's place.
  latencies.push(['session-a idle', await move('session-a', 'idle', [
    'session-b', 'session-c',
    'session-d', 'session-e', 'session-f', 'session-g', 'session-h', 'session-j', 'session-a',
    'session-k',
  ])]);
  latencies.push(['session-h busy', await move('session-h', 'busy', [
    'session-b', 'session-c', 'session-h',
    'session-d', 'session-e', 'session-f', 'session-g', 'session-j', 'session-a',
    'session-k',
  ])]);
  latencies.push(['session-a background', await move('session-a', 'background', [
    'session-a', 'session-b', 'session-c', 'session-h',
    'session-d', 'session-e', 'session-f', 'session-g', 'session-j',
    'session-k',
  ])]);
  latencies.push(['session-c idle', await move('session-c', 'idle', [
    'session-a', 'session-b', 'session-h',
    'session-c', 'session-d', 'session-e', 'session-f', 'session-g', 'session-j',
    'session-k',
  ])]);
  assert.deepEqual(await violations(), [], 'no green row was ever rendered below another light');

  const before = await live();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction((count) => document.querySelectorAll('#tree .row[data-kind="recent"] .dot:not(.st-unknown)').length === count, OBSERVED_20261002.length);
    await watch();
    assert.deepEqual(await live(), before, `reload ${attempt + 1} shows the live order`);
    assert.deepEqual(await server(), before, `reload ${attempt + 1} matches /api/state`);
  }
  await wait(1500);
  assert.deepEqual(await violations(), [], 'no green row was rendered below another light after reload');

  console.log(`move latencies: ${latencies.map(([label, ms]) => `${label} ${ms} ms`).join(', ')}`);
  console.log('green-first Recent order, live re-sort, /api/state agreement, and reload consistency: PASS');
} finally {
  await browser?.close();
  agent.close();
  hub.kill('SIGTERM');
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}
