// Switching back to a warm terminal must attach without the zellij reconnect dialog.
//
// The fake server copies the zellij 0.44.3 web server rules that caused the v22 popup:
// - POST /session issues a web client id.
// - Closing a terminal socket removes its id (websocket_handlers.rs, Message::Close).
// - A terminal socket with an unknown id is dropped after the upgrade. The hub has already
//   accepted the browser socket, so the browser sees open and then close 1011.
import assert from 'node:assert/strict';
import test from 'node:test';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 5; i += 1) await tick(); };

const server = {
  owned: new Set(),
  issued: [],
  refused: [],
  down: false,
  hold: null,
  issue() {
    const id = `client-${this.issued.length + 1}`;
    this.owned.add(id);
    this.issued.push(id);
    return id;
  },
};
const sockets = [];
const modals = [];

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.kind = url.includes('/ws/control') ? 'control' : 'terminal';
    this.id = new URL(url).searchParams.get('web_client_id');
    this.readyState = 0;
    this.sent = [];
    this.received = [];
    sockets.push(this);
    setTimeout(() => this.accept(), 0);
  }

  accept() {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.onopen?.({});
    if (this.kind !== 'terminal') return;
    if (!server.owned.has(this.id)) {
      server.refused.push(this.id);
      this.serverClose(1011);
      return;
    }
    this.received.push('redraw');
    this.onmessage?.({ data: `redraw for ${this.id}` });
  }

  serverClose(code) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.kind === 'terminal') server.owned.delete(this.id);
    this.onclose?.({ code, reason: '', wasClean: false });
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.kind === 'terminal') server.owned.delete(this.id);
    // Browsers also fire close on the side that called close().
    setTimeout(() => this.onclose?.({ code: 1005, reason: '', wasClean: true }), 0);
  }

  send(data) { this.sent.push(data); }
}

let suspended = false;
const resumeHandlers = new Set();
const suspendHandlers = new Set();
globalThis.WebSocket = FakeWebSocket;
globalThis.window = {
  location: { origin: 'http://terminal.test', protocol: 'http:' },
  innerWidth: 1440,
  innerHeight: 900,
  __mcwWarm: {
    isSuspended: () => suspended,
    onResume(callback) { resumeHandlers.add(callback); return () => resumeHandlers.delete(callback); },
    onSuspend(callback) { suspendHandlers.add(callback); return () => suspendHandlers.delete(callback); },
  },
};
globalThis.document = {
  location: globalThis.window.location,
  querySelector: () => null,
  documentElement: { style: { setProperty() {} } },
};
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };
globalThis.fetch = async (url, init = {}) => {
  assert.equal(url, 'http://terminal.test/session');
  assert.equal(init.method, 'POST');
  if (server.hold) await server.hold;
  if (server.down) return { ok: false, status: 503, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => ({ web_client_id: server.issue() }) };
};
globalThis.showReconnectionModal = async (attempt, delay) => {
  modals.push({ kind: 'reconnect', attempt, delay });
  return { action: 'cancel' };
};
globalThis.showErrorModal = async (title, message) => {
  modals.push({ kind: 'error', title, message });
};

const { initWebSockets } = await import('../public/assets/websockets.js');

function hide() {
  suspended = true;
  for (const callback of suspendHandlers) callback();
}

function show() {
  suspended = false;
  for (const callback of [...resumeHandlers]) callback();
}

function terminals() {
  return sockets.filter((socket) => socket.kind === 'terminal');
}

function newClient() {
  suspended = false;
  modals.length = 0;
  server.refused.length = 0;
  const term = { rows: 48, cols: 126, options: {}, write() {}, resize() {} };
  const fitAddon = { proposeDimensions: () => ({ rows: 48, cols: 126 }) };
  return initWebSockets(server.issue(), 'operator-session', term, fitAddon, () => {});
}

test('switching back to a warm terminal attaches with a new id and shows no reconnect dialog', async () => {
  const client = newClient();
  await settle();
  assert.equal(terminals().length, 1);
  assert.deepEqual(terminals()[0].received, ['redraw']);

  for (let round = 1; round <= 6; round += 1) {
    hide();
    await settle();
    show();
    await settle();
    assert.deepEqual(modals, [], `round ${round} showed no dialog`);
    assert.deepEqual(server.refused, [], `round ${round} never presented a spent web client id`);
    const current = terminals().at(-1);
    assert.equal(current, client.wsTerminal, `round ${round} has one current terminal socket`);
    assert.equal(current.readyState, 1, `round ${round} terminal socket is open`);
    assert.deepEqual(current.received, ['redraw'], `round ${round} received the full redraw`);
  }

  const ids = terminals().map((socket) => socket.id);
  assert.equal(new Set(ids).size, ids.length, 'every attach used its own web client id');
  client.cleanup();
  await settle();
  assert.deepEqual(modals, []);
});

test('keys typed while the new id is on its way reach the new terminal in order', async () => {
  const client = newClient();
  await settle();
  hide();
  await settle();
  let release;
  server.hold = new Promise((resolve) => { release = resolve; });
  show();
  client.sendAnsiKey('a');
  client.sendAnsiKey('b');
  server.hold = null;
  release();
  await settle();
  assert.deepEqual(client.wsTerminal.sent, ['a', 'b']);
  assert.deepEqual(modals, []);
  client.cleanup();
  await settle();
});

test('evicting a frame while its new id is pending opens nothing and shows nothing', async () => {
  const client = newClient();
  await settle();
  hide();
  await settle();
  let release;
  server.hold = new Promise((resolve) => { release = resolve; });
  show();
  const before = sockets.length;
  hide();
  client.cleanup();
  server.hold = null;
  release();
  await settle();
  assert.equal(sockets.length, before, 'no socket opened after cleanup');
  assert.deepEqual(modals, []);
});

test('a real connection loss still shows the reconnect dialog', async () => {
  const client = newClient();
  await settle();
  client.wsTerminal.serverClose(1011);
  await settle();
  assert.deepEqual(modals.map((modal) => modal.kind), ['reconnect']);
  modals.length = 0;
  client.cleanup();
  await settle();
});

test('a server that cannot issue a new id is a lost connection', async () => {
  const client = newClient();
  await settle();
  hide();
  await settle();
  server.down = true;
  show();
  await settle();
  server.down = false;
  assert.deepEqual(modals.map((modal) => modal.kind), ['reconnect']);
  modals.length = 0;
  client.cleanup();
  await settle();
});
