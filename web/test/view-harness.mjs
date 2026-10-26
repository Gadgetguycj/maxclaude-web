// Shared harness for the view layer's browser tests. It runs the real hub (src/server.js) with a
// scripted agent on the agent side of the wire, and drives the real app.js in headless Chromium.
// The scripted agent answers the RPCs the sidebar uses and serves a stand-in page for terminal
// frames. It holds no product logic: lights and lists are whatever a test sets.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { chromium } from '/usr/lib/node_modules/playwright-chromium/index.mjs';

export const CHROME = process.env.MCW_CHROME || '/usr/bin/chromium';
export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(predicate, timeoutMs, label) {
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

export class ScriptedAgent {
  constructor(secret, names) {
    this.secret = secret;
    this.ws = null;
    this.timer = null;
    this.rows = new Map();
    this.renameDelayMs = 0;
    this.httpPaths = [];
    // When set, sessions.list fails with this { code, message }, as a slow zellij makes it.
    this.listError = null;
    // When set, sessions.list answers this many milliseconds late, as a loaded zellij makes it.
    this.listDelayMs = 0;
    this.fastListDelayMs = null;
    const base = Date.now() - 3600000;
    names.forEach((name, index) => this.rows.set(name, {
      name, created: 'Created 1h ago', createdAt: base + index * 1000, exited: false, current: false,
      sleeping: false, resumable: true, state: 'idle', lastActivityAt: base + index * 1000,
    }));
  }

  set(name, patch) {
    Object.assign(this.rows.get(name), patch);
  }

  sessions() {
    return [...this.rows.values()].map((row) => ({
      name: row.name, created: row.created, createdAt: row.createdAt, exited: row.exited, current: false,
      sleeping: row.sleeping, resumable: row.resumable, activity: row.state,
      activityUpdatedAt: row.lastActivityAt, lastActivityAt: row.lastActivityAt, lastResponseAt: 0,
    }));
  }

  status() {
    return Object.fromEntries([...this.rows.values()].map((row) => [row.name, {
      state: row.state, updatedAt: row.lastActivityAt, lastResponseAt: 0, lastActivityAt: row.lastActivityAt,
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
          const proof = crypto.createHmac('sha256', this.secret).update(msg.nonce, 'ascii').digest('hex');
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
    if (msg.method === 'sessions.list' || msg.method === 'sessions.listFast') {
      if (this.listError) return this.refuse(msg, this.listError.code, this.listError.message);
      const delay = msg.method === 'sessions.listFast' ? this.fastListDelayMs ?? this.listDelayMs : this.listDelayMs;
      if (delay) return setTimeout(() => this.reply(msg, { sessions: this.sessions() }), delay);
      return this.reply(msg, { sessions: this.sessions() });
    }
    if (msg.method === 'sessions.reserveViewer') return this.reply(msg, { name: params.name, leaseId: `lease-${msg.id}` });
    if (msg.method === 'sessions.releaseViewer') return this.reply(msg, { released: true });
    if (msg.method === 'sessions.rename') {
      const row = this.rows.get(params.oldName);
      if (!row) return this.refuse(msg, 'not_found', `session ${params.oldName} does not exist`);
      // The host renames at once. The answer comes after the Claude /rename and unit steps, so
      // for renameDelayMs the host lists the new name while the hub's tree still has the old one.
      this.rows.delete(params.oldName);
      this.rows.set(params.newName, { ...row, name: params.newName });
      this.push();
      return setTimeout(() => this.reply(msg, {
        oldName: params.oldName, newName: params.newName, renamed: true,
        oldUnit: 'old.service', newUnit: 'new.service', claudeReports: [`Session renamed to ${params.newName}`],
      }), this.renameDelayMs);
    }
    if (msg.method === 'sessions.create') {
      this.pendingCreate = () => {
        if (this.createError) return this.refuse(msg, 'internal', this.createError);
        this.rows.set(params.name, { name: params.name, createdAt: Date.now(), lastActivityAt: Date.now(), state: 'idle' });
        this.push();
        this.reply(msg, { name: params.name });
      };
      return;
    }
    if (msg.method === 'transcripts.list') return this.reply(msg, { transcripts: [] });
    if (msg.method === 'sessions.delete') {
      this.rows.delete(params.name);
      this.push();
      return this.reply(msg, { name: params.name, deleted: true });
    }
    return this.refuse(msg, 'unsupported', msg.method);
  }

  // The terminal frame's document: a stand-in that records the path it was loaded from.
  onHttp(msg) {
    this.httpPaths.push(msg.path);
    // window.term stands in for the client's xterm, which the page focuses after a user's open.
    const body = Buffer.from(`<!doctype html><html><body data-path="${msg.path}"><textarea id="t"></textarea>terminal stand-in for ${msg.path}`
      + '<script>window.term = { focus() { document.getElementById("t").focus(); } };</script></body></html>');
    this.send({ t: 'http.res', id: msg.id, status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    this.ws.send(makeFrame(0x02, msg.id, 0, body));
    this.ws.send(makeFrame(0x02, msg.id, 0x01, Buffer.alloc(0)));
  }

  push() {
    this.send({ t: 'event', event: 'sessions.status', data: { sessions: this.status() } });
  }

  sendUsage(snapshot) {
    this.send({ t: 'event', event: 'usage', data: snapshot });
  }

  send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  close() {
    clearInterval(this.timer);
    this.ws?.close();
  }
}

export async function startHub({ port, secret, password }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcw-view-'));
  const hub = spawn('node', ['src/server.js'], {
    cwd: path.join(import.meta.dirname, '..'),
    env: {
      ...process.env, PORT: String(port), DATA_DIR: dataDir, COOKIE_SECURE: 'false',
      OPERATOR_PASSWORD: password, AGENT_SECRET: secret, STATUS_LEASE_MS: '5000',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  hub.stderr.on('data', (chunk) => process.stderr.write(chunk));
  const origin = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    try { return (await fetch(`${origin}/healthz`)).ok; } catch { return false; }
  }, 15000, 'hub to listen');
  return {
    origin,
    stop() {
      hub.kill('SIGTERM');
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// The hub API as a second browser would use it.
export async function hubSession(origin, password) {
  const res = await fetch(`${origin}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }),
  });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, urlPath, body) => {
    const r = await fetch(`${origin}${urlPath}`, {
      method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`${method} ${urlPath} returned ${r.status} ${JSON.stringify(json)}`);
    return json;
  };
}

export async function launchBrowser() {
  return chromium.launch({ executablePath: CHROME, headless: true });
}

export async function login(page, origin, password, urlPath = '/') {
  await page.goto(`${origin}${urlPath}`, { waitUntil: 'domcontentloaded' });
  await page.locator('#login-password').fill(password);
  await page.locator('#login-submit').click();
  await page.waitForSelector('#app:not([hidden])');
}

// Gives every element under the tree a stable number, so a test can tell a node that was
// updated in place from one that was replaced.
export const TAG_TREE = () => {
  window.__tagSeq = window.__tagSeq || 1;
  window.__tags = window.__tags || new WeakMap();
  const out = {};
  for (const row of document.querySelectorAll('#tree .row')) {
    for (const el of [row, row.querySelector('.dot')].filter(Boolean)) {
      if (!window.__tags.has(el)) window.__tags.set(el, window.__tagSeq++);
    }
    const key = row.dataset.key || `${row.dataset.kind}:${row.dataset.name || row.dataset.id}`;
    out[key] = [window.__tags.get(row), window.__tags.get(row.querySelector('.dot')) || 0];
  }
  return out;
};

export function report(passed) {
  return (label) => {
    passed.push(label);
    console.log(`PASS ${label}`);
  };
}
