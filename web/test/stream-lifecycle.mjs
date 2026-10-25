import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('desktop keeps only the active terminal plus two recent streams', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function warmLimit\(\) \{\s*return 3;\s*\}/);
});

test('a detached terminal cannot create stale streams after suspend', async () => {
  const previous = {
    WebSocket: globalThis.WebSocket,
    window: globalThis.window,
    document: globalThis.document,
    addEventListener: globalThis.addEventListener,
    removeEventListener: globalThis.removeEventListener,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    fetch: globalThis.fetch,
  };
  const resumeHandlers = new Set();
  const suspendHandlers = new Set();
  class FakeWebSocket {
    static instances = [];
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      FakeWebSocket.instances.push(this);
    }
    close() { this.closed = true; this.readyState = 3; }
    send(data) { (this.sent ||= []).push(data); }
  }
  globalThis.WebSocket = FakeWebSocket;
  globalThis.window = {
    location: { origin: 'http://terminal.test', protocol: 'http:' },
    innerWidth: 1440,
    innerHeight: 900,
    __mcwWarm: {
      isSuspended: () => false,
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
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ web_client_id: 'renewed' }) });
  try {
    const { initWebSockets } = await import('../public/assets/websockets.js');
    const term = { rows: 24, cols: 80, options: {}, write() {}, resize() {} };
    const fitAddon = { proposeDimensions: () => ({ rows: 24, cols: 80 }) };
    const client = initWebSockets('client', 'throwaway', term, fitAddon, () => {});
    const oldTerminal = FakeWebSocket.instances[0];
    oldTerminal.onmessage({ data: 'first redraw' });
    const oldControl = FakeWebSocket.instances[1];

    for (const callback of suspendHandlers) callback();
    assert.equal(oldTerminal.closed, true);
    assert.equal(oldControl.closed, true);
    oldTerminal.onmessage({ data: 'queued repaint after close' });
    assert.equal(FakeWebSocket.instances.length, 2, 'a detached terminal cannot recreate control');

    for (const callback of resumeHandlers) callback();
    client.sendAnsiKey('typed during reconnect');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const newTerminal = FakeWebSocket.instances[2];
    assert.equal(newTerminal.url.endsWith('?web_client_id=renewed'), true, 'resume attaches with a newly issued id');
    assert.deepEqual(newTerminal.sent || [], [], 'input waits for the resumed terminal identity');
    newTerminal.onmessage({ data: 'fresh redraw' });
    assert.equal(FakeWebSocket.instances.length, 4, 'resume owns one terminal and one control stream');
    assert.equal(FakeWebSocket.instances[3].url.endsWith('/ws/control'), true);
    assert.deepEqual(newTerminal.sent, ['typed during reconnect'], 'queued input is sent in order after reconnect');
    client.cleanup();
  } finally {
    globalThis.WebSocket = previous.WebSocket;
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.addEventListener = previous.addEventListener;
    globalThis.removeEventListener = previous.removeEventListener;
    globalThis.requestAnimationFrame = previous.requestAnimationFrame;
    globalThis.fetch = previous.fetch;
  }
});
