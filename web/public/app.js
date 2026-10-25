'use strict';
import { StatusLease } from './assets/status-lease.js';
import { sessionFromPath, sessionPath } from './assets/session-url.js';
import { html, render as renderInto, Component } from './assets/view/html.js';
import { fmtSecs, fmtAge, fmtBytes } from './assets/view/format.js';
import {
  createState, createStore, applyServerState, applyStateError, applyStatus,
  startRename, confirmRename, abortRename, renamePair, pushModal, removeModal,
} from './assets/view/store.js';
import * as M from './assets/view/model.js';
import { TreeView, MenuLayer, ModalLayer, NoticeView, TermTitle, rowGeometry } from './assets/view/views.js';
import { installSharedBlink } from './assets/view/blink.js';
import { UsageMeters } from './assets/view/usage.js';
(function () {

/* ---------- dom helpers ---------- */

function $(sel, root) { return (root || document).querySelector(sel); }

function add(node, kid) {
  if (kid === null || kid === undefined || kid === false) return;
  if (Array.isArray(kid)) { for (var i = 0; i < kid.length; i++) add(node, kid[i]); return; }
  node.append(kid && kid.nodeType ? kid : document.createTextNode(String(kid)));
}

// Imperative elements outside the views: toasts, terminal frames, file links and the files drawer.
function h(tag, props) {
  const n = document.createElement(tag);
  if (props) {
    for (const k in props) {
      const v = props[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'dataset') { for (const d in v) if (v[d] !== null && v[d] !== undefined) n.dataset[d] = v[d]; }
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (v === true) n.setAttribute(k, '');
      else n.setAttribute(k, v);
    }
  }
  for (let i = 2; i < arguments.length; i++) add(n, arguments[i]);
  return n;
}

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

const LS = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
    catch (e) { return fallback; }
  },
  set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* storage off */ } }
};

/* ---------- api ---------- */

class ApiError extends Error {
  constructor(status, body) {
    super((body && (body.message || body.error)) || ('HTTP ' + status));
    this.status = status;
    this.code = (body && body.error) || null;
    this.body = body || {};
  }
}

const CODE_TEXT = {
  invalid_credentials: 'Incorrect password.',
  agent_disconnected: 'The agent on the session machine is disconnected.',
  network_error: 'Cannot reach the server.',
  unauthorized: 'Not logged in.',
  not_found: 'Not found.',
  conflict: 'That name is already taken.',
  bad_request: 'The server rejected that request.',
  bad_session_name: 'Session names use letters, numbers, dot, dash and underscore, up to 64 characters.',
  upstream_unavailable: 'zellij on the session machine is not answering.',
  internal: 'The server hit an internal error.',
  timeout: 'The host took too long to answer.'
};

// Codes whose server message is a rule written for developers. The page says it in words.
const PLAIN_CODES = new Set(['bad_session_name']);

function errText(e) {
  if (!(e instanceof ApiError)) return String((e && e.message) || e);
  if (PLAIN_CODES.has(e.code)) return CODE_TEXT[e.code];
  if (e.body && e.body.message) return e.body.message;
  if (e.code === 'locked_out') return 'Locked out. Try again in ' + fmtSecs(e.body.retry_after_s) + '.';
  if (e.code === 'rate_limited') return 'Too many attempts. Try again in ' + fmtSecs(e.body.retry_after_s) + '.';
  return CODE_TEXT[e.code] || e.code || ('HTTP ' + e.status);
}

async function api(method, path, body, opts) {
  const init = { method: method, credentials: 'same-origin', headers: { accept: 'application/json' } };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try { res = await fetch(path, init); }
  catch (e) { throw new ApiError(0, { error: 'network_error' }); }

  let data = null;
  if ((res.headers.get('content-type') || '').indexOf('json') >= 0) {
    try { data = await res.json(); } catch (e) { data = null; }
  }
  if (res.status === 401 && !(opts && opts.rawAuth)) {
    toLogin('Session expired. Log in again.');
    throw new ApiError(401, data || { error: 'unauthorized' });
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

/* ---------- state ---------- */

// S is the store's state. The views read only S, and every change ends in render().
const store = createStore(createState({ collapsed: LS.get('mcw.collapsed', []) || [] }));
const S = store.state;
S.sidebarWidth = 300;
S.sidebarCollapsed = false;
S.pollTimer = null;
S.fetching = false;
// { name, user } for the session whose terminal takes keyboard focus once it is on screen.
S.focusTerminal = null;

const { UNFILED_KEY, RECENTS_KEY, FOLDERS_KEY } = M;
const nodeById = (id) => M.nodeById(S.nodes, id);
const childrenOf = (pid) => M.childrenOf(S.nodes, pid);
const descendantIds = (id) => M.descendantIds(S.nodes, id);
const pathOf = (pid) => M.pathOf(S.nodes, pid);
const endPosition = (pid) => M.endPosition(S.nodes, pid);
const positionAt = M.positionAt;
const leafBySession = (name) => M.leafBySession(S, name);
const sessionByName = (name) => M.sessionByName(S, name);
const liveState = (name) => M.liveState(S, name);

let eventSource = null;
const statusLease = new StatusLease({
  onChange: function (sessions) {
    applyStatus(S, sessions, statusLease.hasSnapshot);
    render();
  }
});

function applyStatusSnapshot(snapshot) {
  return statusLease.apply(snapshot);
}

function startEvents() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource('/api/events');
  const update = function (ev) {
    try {
      const payload = JSON.parse(ev.data);
      applyStatusSnapshot(payload);
    } catch (e) { /* malformed server event is ignored */ }
  };
  eventSource.addEventListener('state', update);
  eventSource.addEventListener('sessions.status', update);
  eventSource.addEventListener('agent', function () { refreshState(true); });
  eventSource.addEventListener('usage', function (ev) {
    try {
      const usage = JSON.parse(ev.data);
      if (usage && Array.isArray(usage.meters)) { S.usage = usage; renderViews(); }
    } catch (e) { /* malformed server event is ignored */ }
  });
}

function canMutate() { return S.agent.connected === true; }

function persistView() {
  LS.set('mcw.collapsed', Array.from(S.collapsed));
  LS.set('mcw.active', S.active);
}

/* ---------- toasts ---------- */

function toast(msg, bad) {
  const t = h('div', { class: 'toast' + (bad ? ' bad' : '') }, msg);
  $('#toasts').append(t);
  setTimeout(function () { t.remove(); }, bad ? 7000 : 3500);
}

/* ---------- auth ---------- */

function loginError(msg) {
  const el = $('#login-error');
  el.textContent = msg || '';
  el.hidden = !msg;
}

let lockTimer = null;

function startLockout(prefix, secs) {
  let left = Math.round(Number(secs) || 0);
  if (left <= 0) return;
  const btn = $('#login-submit');
  clearInterval(lockTimer);
  btn.disabled = true;
  const tick = function () {
    if (left <= 0) { clearInterval(lockTimer); lockTimer = null; btn.disabled = false; loginError(''); return; }
    loginError(prefix + ' Try again in ' + fmtSecs(left) + '.');
    left -= 1;
  };
  tick();
  lockTimer = setInterval(tick, 1000);
}

function showLogin(msg) {
  $('#boot').hidden = true;
  $('#app').hidden = true;
  $('#login').hidden = false;
  loginError(msg || '');
  const pw = $('#login-password');
  pw.value = '';
  setTimeout(function () { try { pw.focus(); } catch (e) { /* not focusable yet */ } }, 20);
}

function toLogin(msg) {
  S.authed = false;
  stopPoll();
  if (eventSource) { eventSource.close(); eventSource = null; }
  S.menu = null;
  S.modals = [];
  for (const frame of $('#frames').querySelectorAll('.term-frame')) disposeFrame(frame);
  document.body.classList.remove('sidebar-collapsed');
  // The address bar keeps naming the session, so logging in again reopens it.
  navigation += 1;
  S.active = null;
  S.notice = null;
  S.loaded = false;
  render();
  showLogin(msg);
}

function enterApp() {
  S.authed = true;
  clearInterval(lockTimer);
  lockTimer = null;
  $('#login').hidden = true;
  $('#boot').hidden = true;
  $('#app').hidden = false;
  loadSidebarState();
  render();
  refreshState(true).then(function () { followUrl(true); });
  startPoll();
  startEvents();
}

$('#login-form').addEventListener('submit', async function (ev) {
  ev.preventDefault();
  const pw = $('#login-password').value;
  const btn = $('#login-submit');
  if (!pw) { loginError('Enter the password.'); return; }
  btn.disabled = true;
  try {
    await api('POST', '/api/login', { password: pw }, { rawAuth: true });
    $('#login-password').value = '';
    loginError('');
    btn.disabled = false;
    enterApp();
  } catch (e) {
    btn.disabled = false;
    if (e.code === 'locked_out') startLockout('Locked out.', e.body.retry_after_s);
    else if (e.code === 'rate_limited') startLockout('Too many attempts.', e.body.retry_after_s);
    else loginError(errText(e));
  }
});

$('#logout').addEventListener('click', async function () {
  try { await api('POST', '/api/logout', {}); } catch (e) { /* the cookie is gone either way */ }
  toLogin('');
});

/* ---------- polling ---------- */

function startPoll() {
  stopPoll();
  S.pollTimer = setTimeout(pollTick, 4000);
}

function stopPoll() {
  if (S.pollTimer) clearTimeout(S.pollTimer);
  S.pollTimer = null;
}

async function pollTick() {
  S.pollTimer = null;
  if (!S.authed) return;
  if (!document.hidden) await refreshState(false);
  if (S.authed && !S.pollTimer) S.pollTimer = setTimeout(pollTick, 4000);
}

async function refreshState(force) {
  if (!S.authed) return;
  if (S.fetching && !force) return;
  S.fetching = true;
  let fileChecksRecovered = false;
  try {
    const d = await api('GET', '/api/state');
    const wasUp = canMutate();
    applyServerState(S, d);
    applyStatusSnapshot(d);
    if (!wasUp && canMutate()) {
      resumeFileChecks();
      fileChecksRecovered = true;
    }
    // A session deleted or renamed from another browser closes here too. Its terminal would only
    // retry a socket the agent refuses, because the name no longer exists on the host. A rename
    // this browser started is one session under two names until it settles, never a missing one.
    if (S.active && hasCompleteSessionList() && !sessionByName(S.active) && !renamePair(S, S.active)) {
      S.notice = { name: S.active, kind: 'missing' };
      S.active = null;
      persistView();
    }
  } catch (e) {
    if (e.status === 401) { S.fetching = false; return; }
    applyStateError(S, errText(e));
  }
  S.fetching = false;
  render();
  if (fileChecksRecovered) document.querySelector('#frames iframe.active')?._mcwRefreshLinks?.();
  if (S.notice?.retry && S.agent.connected) followUrl(false);
}

function hasCompleteSessionList() {
  return S.agent.connected && !S.sessionsDegraded && !S.stateError && Array.isArray(S.sessions);
}

document.addEventListener('visibilitychange', function () {
  document.body.classList.toggle('document-hidden', document.hidden);
  if (!document.hidden && S.authed) { statusLease.expireNow(); refreshState(true); startPoll(); }
});
document.body.classList.toggle('document-hidden', document.hidden);

/* ---------- render ----------
 * Every view is a function of S. render() draws them all and is safe to call at any moment: a
 * row, menu or dialog that stands for the same thing keeps its DOM node, so focus, selections,
 * open menus and running animations are never disturbed. */

const treeEl = $('#tree');
const menuRoot = $('#menu-root');
const modalRoot = $('#modal-root');

installSharedBlink(document);

function onRecentLimit(value, select) {
  api('PUT', '/api/preferences/recent-limit', { recent_limit: value }).then(function (result) {
    S.recentLimit = result.recent_limit;
    // While the session list is unknown the hub has no Recent to send, and Recent keeps its rows.
    if (Array.isArray(S.sessions)) S.recents = result.recents || [];
    select.blur();
    render();
  }).catch(function (e) {
    toast(errText(e), true);
    render();
  });
}

function renderViews() {
  updateChrome();
  const ctx = {
    geo: rowGeometry(isPhone()), drag: S.drag, canMutate: canMutate(),
    recentLimit: S.recentLimit, onRecentLimit: onRecentLimit,
  };
  renderInto(html`<${TreeView} model=${M.sidebarModel(S)} ctx=${ctx} />`, treeEl);
  renderInto(html`<${MenuLayer} menu=${S.menu} onClose=${closeMenu} />`, menuRoot);
  renderInto(html`<${ModalLayer} modals=${S.modals} onClose=${closeModal} errText=${errText} />`, modalRoot);
  // Behind an open dialog the page cannot be clicked or tabbed to.
  const blocked = S.modals.length > 0;
  $('#app').inert = blocked;
  $('#files-drawer').inert = blocked;
  const empty = $('#no-session');
  if (empty) {
    empty.hidden = !!S.active;
    renderInto(html`<${NoticeView} notice=${S.notice} onHome=${goHome} />`, empty);
  }
  const shown = S.active ? M.hostName(S, S.active) : null;
  const state = shown ? liveState(shown) : null;
  renderInto(html`<${TermTitle} name=${shown} state=${state} stateText=${state ? (M.STATE_TEXT[state] || state) : ''} />`, $('#term-title'));
  renderInto(html`<${UsageMeters} usage=${S.usage} now=${S.now} open=${S.usageOpen} onToggle=${toggleUsage} />`, $('#usage'));
}

// The usage panel lists every window with its reset time. A tap is how a phone gets there.
function toggleUsage(ev) {
  ev.stopPropagation();
  S.usageOpen = !S.usageOpen;
  S.now = Date.now();
  renderViews();
}

function closeUsage() {
  if (!S.usageOpen) return;
  S.usageOpen = false;
  renderViews();
}

document.addEventListener('click', function (ev) {
  if (S.usageOpen && !ev.target.closest('#usage')) closeUsage();
});
document.addEventListener('keydown', function (ev) {
  if (ev.key === 'Escape' && S.usageOpen) { closeUsage(); $('#usage-button')?.focus(); }
});
// A click in the terminal frame never reaches this document, but it takes focus from the window.
window.addEventListener('blur', closeUsage);

function render() {
  renderViews();
  syncFrames();
}

// Ages in the tree count up while nothing else changes.
setInterval(function () {
  if (document.hidden || !S.authed) return;
  S.now = Date.now();
  renderViews();
}, 1000);

function updateChrome() {
  const down = !canMutate();
  document.body.classList.toggle('agent-down', S.loaded && down);

  const dot = $('#agent-dot');
  dot.className = 'dot ' + (!S.loaded ? 'st-unknown' : (S.agent.connected ? 'st-running' : 'st-missing'));
  dot.title = !S.loaded ? 'Agent state unknown' : (S.agent.connected
    ? ('Agent connected ' + fmtAge(S.agent.since, S.now)).trim()
    : 'Agent disconnected');

  // Before the first state read nothing is known, so nothing is reported as down.
  const banner = $('#banner');
  if (S.loaded && S.stateError) {
    banner.className = 'banner error';
    banner.textContent = 'Cannot read the state from the server. ' + S.stateError + ' The tree is read-only and live session state is unknown.';
    banner.hidden = false;
  } else if (S.loaded && !S.agent.connected) {
    banner.className = 'banner';
    banner.textContent = 'The agent on the session machine is disconnected. The tree is read-only and live session state is unknown.';
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }

  // The agent is connected and the tree works. Only its list of sessions is behind.
  const listNotice = $('#list-notice');
  const slow = S.loaded && !S.stateError && S.agent.connected ? S.sessionsDegraded : null;
  if (slow) {
    const age = slow.last_good_at ? fmtAge(slow.last_good_at, S.now) : '';
    listNotice.textContent = 'Session list is slow. ' + (age ? 'Showing the list from ' + age + '.' : 'No list has arrived yet.');
    listNotice.title = slow.message || '';
    listNotice.hidden = false;
  } else {
    listNotice.hidden = true;
  }

  $('#new-folder-root').disabled = down;
  $('#new-session-root').disabled = down;
  $('#hibernate-idle').disabled = down;
  $('#upload-button').disabled = down || !S.active;
  $('#files-button').disabled = !S.active;
}

/* ---------- tree interaction ---------- */

function toggleCollapse(key) {
  if (S.collapsed.has(key)) S.collapsed.delete(key); else S.collapsed.add(key);
  persistView();
  render();
}

// A click with a modifier key opens a link the browser's way, in a new tab or window.
function plainClick(ev) {
  return ev.button === 0 && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey && !ev.altKey;
}

treeEl.addEventListener('click', function (ev) {
  if (drag.suppressClick) { drag.suppressClick = false; ev.preventDefault(); return; }
  const row = ev.target.closest('.row');
  if (!row) return;
  const btn = ev.target.closest('button.act');
  if (btn) { ev.preventDefault(); rowAction(btn.dataset.act, row, btn); return; }
  if (row.matches('a[href]') && !plainClick(ev)) return;
  ev.preventDefault();

  const kind = row.dataset.kind;
  if (kind === 'folder' || kind === 'section') toggleCollapse(row.dataset.id);
  else if (kind === 'leaf') activateLeaf(row);
  else if (kind === 'unfiled' || kind === 'recent') openSession(row.dataset.name);
});

// Arrow keys move through the rows the tree shows, and left and right close and open a folder or
// section, as in any tree. Tab still visits every row.
function moveInTree(row, key) {
  const rows = Array.from(treeEl.querySelectorAll('.row'));
  const at = rows.indexOf(row);
  const expandable = row.dataset.kind === 'folder' || row.dataset.kind === 'section';
  const open = row.getAttribute('aria-expanded') === 'true';
  let target = null;
  if (key === 'ArrowDown') target = rows[at + 1];
  else if (key === 'ArrowUp') target = rows[at - 1];
  else if (key === 'Home') target = rows[0];
  else if (key === 'End') target = rows[rows.length - 1];
  else if (key === 'ArrowRight') {
    if (expandable && !open) { toggleCollapse(row.dataset.id); return true; }
    if (expandable) target = rows[at + 1];
  } else if (key === 'ArrowLeft') {
    if (expandable && open) { toggleCollapse(row.dataset.id); return true; }
    const group = row.closest('[role="group"]');
    target = group ? group.previousElementSibling : null;
  } else return false;
  if (target) target.focus();
  return true;
}

treeEl.addEventListener('keydown', function (ev) {
  const row = ev.target.closest ? ev.target.closest('.row') : null;
  if (!row) return;
  if ((ev.key === 'ContextMenu' || (ev.shiftKey && ev.key === 'F10')) && ev.target === row) {
    ev.preventDefault();
    openRowMenu(row, row);
    return;
  }
  if (ev.target === row && !ev.altKey && !ev.ctrlKey && !ev.metaKey && moveInTree(row, ev.key)) {
    ev.preventDefault();
    return;
  }
  if ((ev.key !== 'Enter' && ev.key !== ' ') || ev.target !== row) return;
  // Enter on a link is the browser's own click, which keeps Ctrl or Cmd for a new tab.
  if (ev.key === 'Enter' && row.matches('a[href]')) return;
  ev.preventDefault();
  row.click();
});

treeEl.addEventListener('contextmenu', function (ev) {
  const row = ev.target.closest ? ev.target.closest('.row') : null;
  if (!row || row.dataset.kind === 'section') return;
  // A mouse right-click on a session keeps the browser's link menu, with open in new tab and
  // copy link address. Touch, the menu key and Shift+F10 open the row menu.
  if (row.matches('a[href]') && ev.pointerType === 'mouse' && !menuOpen()) return;
  ev.preventDefault();
  openRowMenu(row, row);
});

function activateLeaf(row) {
  const n = nodeById(row.dataset.id);
  if (!n) return;
  const st = liveState(n.session_name);
  if (st === 'missing') {
    if (canMutate()) dlgRecreate(n);
    else toast('Session ' + n.session_name + ' is not created on the host.', true);
    return;
  }
  openSession(row.dataset.name || n.session_name);
}

function rowAction(act, row, btn) {
  if (act === 'create') { const n = nodeById(row.dataset.id); if (n) dlgRecreate(n); return; }
  if (act !== 'menu') return;
  openRowMenu(row, btn);
}

function openRowMenu(row, anchor) {
  const kind = row.dataset.kind;
  if (kind === 'folder') menuFolder(anchor, nodeById(row.dataset.id));
  else if (kind === 'leaf') menuLeaf(anchor, nodeById(row.dataset.id));
  else if (kind === 'unfiled') menuUnfiled(anchor, row.dataset.name);
  else if (kind === 'recent') {
    const leaf = leafBySession(row.dataset.name);
    if (leaf) menuLeaf(anchor, leaf); else menuUnfiled(anchor, row.dataset.name);
  }
}

/* ---------- session addresses ----------
 * The address bar names what the terminal area shows. /s/<name> is an open session, or a notice
 * about that address when it cannot open. / is no session. A user's open adds a history entry,
 * a rename or close replaces it, and back, forward, reload and a pasted address all go through
 * followUrl. session-url.js is the only place a name becomes a path or a path a name. */

// Each navigation takes a number. An open that finishes after a newer navigation is not shown.
let navigation = 0;

function setUrl(name, how) {
  if (how !== 'push' && how !== 'replace') return;
  const here = sessionFromPath(location.pathname);
  if (name ? here?.name === name : location.pathname === '/') return;
  const path = name ? sessionPath(name) : '/';
  if (!path) return;
  if (how === 'push') history.pushState(null, '', path);
  else history.replaceState(null, '', path);
}

// At boot, / reopens the session this browser last had open and names it in the address bar.
function followUrl(atBoot) {
  if (!S.authed) return;
  const route = sessionFromPath(location.pathname);
  if (route?.name && route.name === S.active) return;
  navigation += 1;
  if (route?.invalid) { showNotice(null, 'invalid'); return; }
  if (route) { openSession(route.name, 'none'); return; }
  const remembered = atBoot ? LS.get('mcw.active', null) : null;
  if (remembered && sessionByName(remembered)) openSession(remembered, 'replace');
  else showNothing();
}

window.addEventListener('popstate', function () { followUrl(false); });

function goHome(ev) {
  if (!plainClick(ev)) return;
  ev.preventDefault();
  navigation += 1;
  setUrl(null, 'push');
  showNothing();
  if (isPhone()) setSidebarCollapsed(false);
}

// A retry notice comes from a hub or agent outage. The next state read with the agent connected
// follows the address again.
function showNotice(name, kind, detail, retry) {
  $('#files-drawer').hidden = true;
  S.active = null;
  S.notice = { name: name, kind: kind, detail: detail || '', retry: !!retry };
  render();
}

function showNothing() {
  S.active = null;
  S.notice = null;
  render();
}

/* ---------- terminal frame ---------- */

// how is 'push' for a user's open, 'replace' to rename the current history entry, and 'none'
// when the address already names the session.
async function openSession(name, how) {
  if (!name) return;
  how = how || 'push';
  const mine = ++navigation;
  const target = sessionByName(name);
  if (target && !target.sleeping && !target.exited) {
    // An awake session needs nothing from the hub before its frame is shown. The open call
    // still reserves the viewer and records the visit.
    showSession(target.name, how);
    try {
      await api('POST', '/api/sessions/' + encodeURIComponent(target.name) + '/open', {});
    } catch (e) {
      toast(errText(e), true);
    }
    await refreshState(true);
    return;
  }
  // A user's open keeps the current terminal until this one can show. An address names this
  // session already, so the terminal area says so while the hub answers.
  if (how !== 'push') showNotice(name, 'opening');
  if (target?.sleeping) {
    S.waking.add(name);
    render();
  }
  let result;
  try {
    result = await api('POST', '/api/sessions/' + encodeURIComponent(name) + '/open', {});
  } catch (e) {
    S.waking.delete(name);
    if (mine !== navigation) render();
    else if (how === 'push') { toast(errText(e), true); render(); }
    else if (e.code === 'not_found') showNotice(name, 'missing');
    else if (e.code === 'bad_session_name') showNotice(name, 'badname');
    else showNotice(name, 'error', errText(e), e.status === 0 || e.status >= 500);
    return;
  }
  S.waking.delete(name);
  if (result?.wake?.wakeMs) toast('Woke ' + name + ' in ' + fmtSecs(result.wake.wakeMs / 1000) + '.');
  if (mine !== navigation) { render(); return; }
  showSession(name, how);
  await refreshState(true);
}

function showSession(name, how) {
  $('#files-drawer').hidden = true;
  freezeFrame(S.active);
  S.active = name;
  S.notice = null;
  // The terminal takes keyboard focus once it shows: after a user's open, or after an address,
  // back or reload when nothing else on the page has focus. A frame that reloads by itself does
  // not move focus.
  S.focusTerminal = { name: name, user: (how || 'push') === 'push' };
  touchWarm(name);
  persistView();
  setUrl(name, how || 'push');
  render();
  if (isPhone()) setSidebarCollapsed(true);
}

function closeSession(name) {
  if (S.active !== name && S.notice?.name !== name) return;
  S.active = null;
  persistView();
  setUrl(null, 'replace');
  showNothing();
}

// A rename this browser made, once the hub confirmed it. The open terminal is the same zellij
// session under its new name, so its frame stays and takes the new name. zellij moves the
// frame's own client to the new address. A hidden warm frame has no live client to follow the
// rename, so it is dropped and opens cold under the new name.
function renameOpenSession(oldName, newName) {
  const open = S.active === oldName;
  if (open) {
    S.active = newName;
    persistView();
    setUrl(newName, 'replace');
  }
  if (S.notice?.name === oldName) S.notice = null;
  if (S.focusTerminal?.name === oldName) S.focusTerminal = { ...S.focusTerminal, name: newName };
  for (const frame of $('#frames').querySelectorAll('.term-frame')) {
    if (frame.dataset.name !== oldName) continue;
    if (!open) { disposeFrame(frame); continue; }
    disposeTerminalLinks(frame);
    frame.dataset.name = newName;
    frame.title = 'Terminal for ' + newName;
    installTerminalLinks(frame, newName);
  }
  const index = warmOrder.indexOf(oldName);
  if (index >= 0) {
    if (open) warmOrder[index] = newName;
    else warmOrder.splice(index, 1);
  }
}

let refitFrame = 0;
function refitTerminals() {
  cancelAnimationFrame(refitFrame);
  refitFrame = requestAnimationFrame(function () {
    const frame = document.querySelector('.term-frame.active');
    if (frame) try { frame.contentWindow.dispatchEvent(new Event('resize')); } catch (e) { /* frame may still be loading */ }
  });
}

const warmOrder = [];

function warmLimit() {
  return 3;
}

function touchWarm(name) {
  const old = warmOrder.indexOf(name);
  if (old >= 0) warmOrder.splice(old, 1);
  warmOrder.push(name);
}

function freezeFrame(name) {
  if (!name) return;
  const frame = Array.from(document.querySelectorAll('.term-frame')).find(function (item) { return item.dataset.name === name; });
  if (!frame || frame.classList.contains('warm-hidden')) return;
  disposeTerminalLinks(frame);
  try { frame.contentWindow.__mcwWarm?.suspend(); } catch (e) { /* client may still be loading */ }
  const rect = frame.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    frame.style.width = Math.round(rect.width) + 'px';
    frame.style.height = Math.round(rect.height) + 'px';
  }
  frame.classList.remove('active');
  frame.classList.add('warm-hidden');
  frame.setAttribute('aria-hidden', 'true');
}

// Keyboard focus into the shown terminal. It waits for the client's terminal, and gives up if the
// person has moved on to a dialog, a menu or a field in the meantime. Without a user's open it
// only takes focus that nothing else holds.
function focusShownTerminal(frame) {
  const want = S.focusTerminal;
  if (!want || want.name !== frame.dataset.name || frame._mcwFocusWait) return;
  let attempts = 0;
  const attempt = function () {
    frame._mcwFocusWait = false;
    if (S.focusTerminal !== want || frame.dataset.name !== S.active || !frame.isConnected) return;
    const active = document.activeElement;
    const free = !active || active === document.body || active === frame;
    const busy = S.modals.length || S.menu || active?.matches?.('input, select, textarea, [contenteditable="true"]');
    if (busy || (!want.user && !free)) { S.focusTerminal = null; return; }
    let term = null;
    try { term = frame.contentWindow.term || null; } catch (e) { term = null; }
    if (!term) {
      attempts += 1;
      if (attempts < 100) { frame._mcwFocusWait = true; setTimeout(attempt, 50); }
      return;
    }
    S.focusTerminal = null;
    term.focus();
  };
  attempt();
}

function showFrame(frame) {
  frame.removeAttribute('aria-hidden');
  if (frame.classList.contains('active') && !frame.classList.contains('warm-hidden')) {
    installTerminalLinks(frame, frame.dataset.name);
    focusShownTerminal(frame);
    return;
  }
  if (frame._mcwShowPromise) return;
  let resume;
  try { resume = frame.contentWindow.__mcwWarm?.resume(); } catch (e) { resume = null; }
  frame._mcwShowPromise = Promise.resolve(resume).catch(function () {
    // xterm retains its canvas renderer if WebGL recreation fails.
  }).then(function () {
    if (!frame.isConnected || frame.dataset.name !== S.active) {
      try { frame.contentWindow.__mcwWarm?.suspend(); } catch (e) { /* client may already be gone */ }
      return;
    }
    frame.classList.remove('warm-hidden');
    frame.classList.add('active');
    frame.style.width = '';
    frame.style.height = '';
    installTerminalLinks(frame, frame.dataset.name);
    refitTerminals();
    focusShownTerminal(frame);
  }).finally(function () {
    frame._mcwShowPromise = null;
    if (frame.isConnected && frame.dataset.name === S.active && frame.classList.contains('warm-hidden')) showFrame(frame);
  });
}

function disposeTerminalLinks(frame) {
  if (!frame || !frame._mcwLinkDisposer) return;
  // After the frame's document is replaced, the old terminal may already be torn down.
  try { frame._mcwLinkDisposer(); } catch (e) { /* the old document is gone */ }
  frame._mcwLinkDisposer = null;
}

function disposeFrame(frame) {
  disposeTerminalLinks(frame);
  try { frame.contentWindow.__mcwWarm?.suspend(); } catch (e) { /* client may already be gone */ }
  frame.remove();
}

function syncFrames() {
  const box = $('#frames');
  const existing = new Map();
  for (const f of box.querySelectorAll('iframe')) existing.set(f.dataset.name, f);

  if (!S.authed) {
    for (const f of existing.values()) disposeFrame(f);
    return;
  }
  const live = M.listedNames(S);
  for (let index = warmOrder.length - 1; index >= 0; index -= 1) {
    if (hasCompleteSessionList() && !live.has(warmOrder[index])) warmOrder.splice(index, 1);
  }
  if (S.active && !warmOrder.includes(S.active)) touchWarm(S.active);
  while (warmOrder.length > warmLimit()) {
    const evicted = warmOrder.shift();
    const frame = existing.get(evicted);
    if (frame) { disposeFrame(frame); existing.delete(evicted); }
  }
  for (const [name, frame] of existing) {
    if (!warmOrder.includes(name)) { disposeFrame(frame); existing.delete(name); continue; }
    if (name === S.active) showFrame(frame); else freezeFrame(name);
  }

  if (S.active && !existing.has(S.active)) {
    const sessionName = S.active;
    const f = h('iframe', {
      class: 'term-frame warm-hidden',
      title: 'Terminal for ' + sessionName,
      src: '/t/' + encodeURIComponent(sessionName),
      allow: 'clipboard-read; clipboard-write',
      dataset: { name: sessionName }
    });
    // A frame can load more than once: zellij moves its client to a renamed session's address.
    f.addEventListener('load', function () {
      watchFrameDrags(f);
      disposeTerminalLinks(f);
      if (f.dataset.name === S.active) showFrame(f);
    });
    box.append(f);
    existing.set(S.active, f);
  }

  const activeFrame = S.active ? existing.get(S.active) : null;
  if (activeFrame) showFrame(activeFrame);
}

/* ---------- file transfer ---------- */

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const HTTP_UPLOAD_CHUNK = 8 * 1024 * 1024;
const pathCache = new Map();

function quotePath(filePath) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(filePath)) return filePath;
  return "'" + filePath.replace(/'/g, "'\\''") + "'";
}

function activeTerminal() {
  const frame = document.querySelector('.term-frame.active');
  if (!frame || frame.dataset.name !== S.active) return null;
  try { return frame.contentWindow.term || null; } catch (e) { return null; }
}

function insertUploadedPaths(paths) {
  const term = activeTerminal();
  if (!term || typeof term.input !== 'function') {
    throw new Error('The terminal is not ready for inserted paths.');
  }
  let prefix = '';
  try {
    const buffer = term.buffer.active;
    const line = buffer.getLine(buffer.baseY + buffer.cursorY);
    const previous = buffer.cursorX > 0 ? line?.getCell(buffer.cursorX - 1)?.getChars() : '';
    if (previous && !/\s/.test(previous)) prefix = ' ';
  } catch (e) { /* xterm buffer may be replacing the active line */ }
  term.input(prefix + paths.map(quotePath).join(' '), true);
  term.focus();
}

function uploadChunk(session, batch, uploadId, item, offset, blob, final, progress) {
  return new Promise(function (resolve, reject) {
    const query = new URLSearchParams({
      batch: batch,
      upload_id: uploadId,
      path: item.relativePath,
      size: String(item.file.size),
      chunk_size: String(blob.size),
      offset: String(offset),
      final: final ? '1' : '0'
    });
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/sessions/' + encodeURIComponent(session) + '/uploads?' + query.toString());
    xhr.responseType = 'json';
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = function (ev) { progress(offset + ev.loaded); };
    xhr.onerror = function () { reject(new ApiError(0, { error: 'network_error' })); };
    xhr.onload = function () {
      if (xhr.status === 401) toLogin('Session expired. Log in again.');
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new ApiError(xhr.status, xhr.response || { error: 'upload_failed' }));
        return;
      }
      resolve(xhr.response);
    };
    xhr.send(blob);
  });
}

async function uploadRequest(session, batch, uploadId, item, progress) {
  let offset = 0;
  let result = null;
  do {
    const end = Math.min(item.file.size, offset + HTTP_UPLOAD_CHUNK);
    const final = end === item.file.size;
    const blob = item.file.slice(offset, end);
    result = await uploadChunk(session, batch, uploadId, item, offset, blob, final, progress);
    offset = end;
  } while (offset < item.file.size);
  return result;
}

function showUploadOverlay(title, detail, progress) {
  $('#upload-title').textContent = title;
  $('#upload-detail').textContent = detail || '';
  const bar = $('#upload-progress');
  bar.hidden = progress === null;
  if (progress !== null) bar.value = Math.max(0, Math.min(1, progress));
  $('#upload-overlay').hidden = false;
}

function hideUploadOverlay() {
  $('#upload-overlay').hidden = true;
  $('#upload-progress').hidden = true;
}

async function uploadItems(items) {
  if (!S.active) throw new Error('Open a session before uploading.');
  if (!canMutate()) throw new Error('The agent on the session machine is disconnected.');
  if (!items.length) return;
  for (const item of items) {
    if (item.file.size > MAX_UPLOAD_BYTES) throw new Error(item.file.name + ' exceeds the 2 GB upload limit.');
  }
  const session = S.active;
  const batch = crypto.randomUUID().replace(/-/g, '');
  const total = items.reduce(function (sum, item) { return sum + item.file.size; }, 0);
  let completed = 0;
  const results = [];
  showUploadOverlay('Uploading to ' + session, 'Preparing ' + items.length + (items.length === 1 ? ' item' : ' items'), 0);
  try {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const result = await uploadRequest(session, batch, batch + '_' + index, item, function (loaded) {
        const sent = completed + loaded;
        showUploadOverlay(
          'Uploading ' + item.relativePath,
          fmtBytes(sent) + ' of ' + fmtBytes(total),
          total ? sent / total : (index + 1) / items.length
        );
      });
      completed += item.file.size;
      results.push({ item: item, result: result });
    }
    const inserted = [];
    for (const entry of results) {
      const requested = entry.item.insertRelative
        ? entry.result.batch_root + '/' + entry.item.insertRelative
        : entry.result.path;
      if (!inserted.includes(requested)) inserted.push(requested);
    }
    insertUploadedPaths(inserted);
    toast((items.length === 1 ? 'Uploaded 1 item.' : 'Uploaded ' + items.length + ' items.') + ' Paths inserted without submitting.');
    if (!$('#files-drawer').hidden) await openFilesDrawer();
  } finally {
    hideUploadOverlay();
  }
}

function readDirectoryEntries(reader) {
  return new Promise(function (resolve, reject) {
    const all = [];
    const next = function () {
      reader.readEntries(function (entries) {
        if (!entries.length) { resolve(all); return; }
        all.push.apply(all, entries);
        next();
      }, reject);
    };
    next();
  });
}

async function walkEntry(entry, prefix, insertRelative, out) {
  const relative = prefix ? prefix + '/' + entry.name : entry.name;
  if (entry.isFile) {
    const file = await new Promise(function (resolve, reject) { entry.file(resolve, reject); });
    out.push({ file: file, relativePath: relative, insertRelative: insertRelative });
    return;
  }
  if (!entry.isDirectory) return;
  const children = await readDirectoryEntries(entry.createReader());
  for (const child of children) await walkEntry(child, relative, insertRelative || entry.name, out);
}

// A DataTransfer is readable only while its drop event is dispatched. Every item's file and entry
// are taken synchronously here; directories are walked afterwards through their entries.
function captureDrop(dataTransfer) {
  const captured = [];
  for (const item of Array.from(dataTransfer.items || [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile ? item.getAsFile() : null;
    const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
    captured.push({ file: file, entry: entry });
  }
  return { captured: captured, files: Array.from(dataTransfer.files || []) };
}

async function droppedItems(drop) {
  const out = [];
  let usedEntries = false;
  for (const item of drop.captured) {
    const directFile = item.file;
    if (directFile?.webkitRelativePath) {
      const relative = directFile.webkitRelativePath;
      const slash = relative.indexOf('/');
      out.push({ file: directFile, relativePath: relative, insertRelative: slash > 0 ? relative.slice(0, slash) : null });
      usedEntries = true;
      continue;
    }
    const entry = item.entry;
    if (!entry) continue;
    usedEntries = true;
    await walkEntry(entry, '', entry.isDirectory ? entry.name : null, out);
  }
  if (usedEntries) return out;
  for (const file of drop.files) {
    const relative = file.webkitRelativePath || file.name;
    const slash = relative.indexOf('/');
    out.push({ file: file, relativePath: relative, insertRelative: slash > 0 ? relative.slice(0, slash) : null });
  }
  return out;
}

function pickedItems(files) {
  return Array.from(files || []).map(function (file) {
    const relative = file.webkitRelativePath || file.name;
    const slash = relative.indexOf('/');
    return { file: file, relativePath: relative, insertRelative: slash > 0 ? relative.slice(0, slash) : null };
  });
}

/* ---------- file drags from the desktop ----------
 * A real drag over the terminal is hit tested into the terminal iframe's own document, so the
 * parent page never sees it. Both documents listen. The first file dragenter in either one shows
 * a full-page overlay in this document, and from then on the browser hit tests every dragover and
 * the drop onto that overlay. A file drag is always accepted here, so Chrome never opens the file
 * in a tab; a drop that cannot upload says why. */

const fileDrag = { shown: false, lastDoc: null };

function hasFiles(ev) {
  return Array.from(ev.dataTransfer?.types || []).includes('Files');
}

function dropBlocker() {
  if (!S.authed) return { title: 'Log in to upload', detail: 'Files can be dropped after you log in.' };
  if (!S.active) return { title: 'No session is open', detail: 'Open a session in the sidebar, then drop the files on the page.' };
  if (!canMutate()) return { title: 'The agent on the session machine is disconnected', detail: 'Uploads need the agent. Drop the files again when it reconnects.' };
  return null;
}

function showDropOverlay() {
  const blocked = dropBlocker();
  const el = $('#drop-overlay');
  el.dataset.state = blocked ? 'blocked' : 'ready';
  $('#drop-title').textContent = blocked ? blocked.title : 'Drop to upload to ' + S.active;
  $('#drop-detail').textContent = blocked
    ? blocked.detail
    : 'Files and folders go to the configured file directory on the session machine. Their paths are typed at the prompt without Enter.';
  el.hidden = false;
  document.body.classList.add('file-dragging');
  fileDrag.shown = true;
}

function hideDropOverlay() {
  fileDrag.shown = false;
  fileDrag.lastDoc = null;
  $('#drop-overlay').hidden = true;
  document.body.classList.remove('file-dragging');
}

// dragenter and dragover in either document. Accepting them is what stops Chrome opening the file.
function acceptFileDrag(doc) {
  return function (ev) {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
    fileDrag.lastDoc = doc;
    if (!fileDrag.shown) showDropOverlay();
  };
}

async function onFileDrop(ev) {
  if (!hasFiles(ev)) return;
  ev.preventDefault();
  const drop = captureDrop(ev.dataTransfer);
  hideDropOverlay();
  const blocked = dropBlocker();
  if (blocked) { toast(blocked.title + '. Nothing was uploaded. ' + blocked.detail, true); return; }
  try { await uploadItems(await droppedItems(drop)); }
  catch (e) { hideUploadOverlay(); toast(errText(e), true); }
}

// Top document. Once the overlay is up it is the only element a drag can enter, and it leaves
// it for no other element, so a dragleave from the overlay with no related target means the drag
// left the window.
window.addEventListener('dragenter', acceptFileDrag('top'));
window.addEventListener('dragover', acceptFileDrag('top'));
window.addEventListener('dragleave', function (ev) {
  if (!hasFiles(ev)) return;
  if (ev.target === $('#drop-overlay') && !ev.relatedTarget) hideDropOverlay();
});
window.addEventListener('drop', onFileDrop);

// No mouse event is dispatched while a drag is in progress, so one means the drag is over.
for (const type of ['mousemove', 'mousedown']) {
  window.addEventListener(type, function () { if (fileDrag.shown) hideDropOverlay(); }, true);
}

// Terminal iframe document. Its drag events never reach this document.
function watchFrameDrags(frame) {
  let win = null;
  try { win = frame.contentWindow; } catch (e) { return; }
  if (!win || win.__mcwFileDrags) return;
  win.__mcwFileDrags = true;
  win.addEventListener('dragenter', acceptFileDrag('frame'), true);
  win.addEventListener('dragover', acceptFileDrag('frame'), true);
  // Chrome fires dragenter on the overlay before the frame hears anything more, so a frame
  // dragleave with no related target after that is not a window exit. Without it, it is.
  win.addEventListener('dragleave', function (ev) {
    if (!hasFiles(ev)) return;
    if (!ev.relatedTarget && fileDrag.lastDoc === 'frame') hideDropOverlay();
  }, true);
  win.addEventListener('drop', onFileDrop, true);
}

function chooseUpload(anchor) {
  openMenu(anchor, 'Upload to ' + S.active, [
    { label: 'Choose files', run: function () { $('#upload-files').click(); } },
    { label: 'Choose a folder', run: function () { $('#upload-folder').click(); } }
  ]);
}

$('#upload-button').addEventListener('click', function () { if (S.active) chooseUpload($('#upload-button')); });
$('#files-choose').addEventListener('click', function () { if (S.active) chooseUpload($('#files-choose')); });
for (const input of [$('#upload-files'), $('#upload-folder')]) {
  input.addEventListener('change', async function () {
    try { await uploadItems(pickedItems(input.files)); }
    catch (e) { hideUploadOverlay(); toast(errText(e), true); }
    input.value = '';
  });
}

function startDownload(session, filePath) {
  let sink = $('#mcw-download-sink');
  if (!sink) {
    sink = h('iframe', { id: 'mcw-download-sink', title: 'File download', hidden: true });
    document.body.append(sink);
  }
  sink.src = '/api/files/download?' + new URLSearchParams({ session: session, path: filePath }).toString();
}

function pathCandidates(text) {
  const found = [];
  const quoted = /(['"])(\/[^\r\n]*?)\1/g;
  let match;
  while ((match = quoted.exec(text)) !== null) {
    if (!match[2] || /\x1b/.test(match[2])) continue;
    found.push({ path: match[2], start: match.index + 1, length: match[2].length });
  }
  const plain = /(^|[\s(=\[])(\/[A-Za-z0-9._~!$&+,%:@;=-]+(?:\/[A-Za-z0-9._~!$&+,%:@;=-]+)*)/g;
  while ((match = plain.exec(text)) !== null) {
    const value = match[2].replace(/[.,;:!?]+$/, '');
    if (!value || found.some(function (entry) { return entry.start === match.index + match[1].length; })) continue;
    found.push({ path: value, start: match.index + match[1].length, length: value.length });
  }
  return found;
}

// A file link check needs the hub and its agent, and the terminal asks again on every repaint.
// While the state read says the agent or hub is away no check is sent. A check that cannot
// reach them pauses the next for 2 s, doubling to 60 s, until a state read finds them back.
const fileChecks = { until: 0, delay: 0 };

function resumeFileChecks() {
  fileChecks.until = 0;
  fileChecks.delay = 0;
}

async function existingPaths(session, paths) {
  const now = Date.now();
  const missing = paths.filter(function (filePath) {
    const cached = pathCache.get(filePath);
    return !cached || now - cached.at > 5000;
  });
  if (missing.length) {
    if (!canMutate() || now < fileChecks.until) throw new Error('File checks wait for the hub and agent.');
    let result;
    try {
      result = await api('POST', '/api/files/stat', { session: session, paths: missing });
    } catch (e) {
      if (e instanceof ApiError && (e.status === 0 || e.status >= 500)) {
        fileChecks.delay = Math.min(60000, Math.max(2000, fileChecks.delay * 2));
        fileChecks.until = Date.now() + fileChecks.delay;
      }
      throw e;
    }
    resumeFileChecks();
    for (const item of (result.paths || [])) pathCache.set(item.path, { at: now, value: item });
  }
  return paths.map(function (filePath) { return pathCache.get(filePath)?.value; });
}

function installTerminalLinks(frame, session) {
  if (!frame || frame.dataset.name !== S.active || frame._mcwLinkDisposer) return;
  let disposed = false;
  let retryTimer = 0;
  let teardown = null;
  frame._mcwLinkDisposer = function () {
    if (disposed) return;
    disposed = true;
    clearTimeout(retryTimer);
    if (teardown) teardown();
    frame._mcwLinkDisposer = null;
    frame._mcwRefreshLinks = null;
  };
  let attempts = 0;
  const attach = function () {
    if (disposed || frame.dataset.name !== S.active) return;
    let term;
    try { term = frame.contentWindow.term; } catch (e) { return; }
    if (!term || typeof term.registerLinkProvider !== 'function') {
      attempts += 1;
      if (attempts < 100 && frame.isConnected) retryTimer = setTimeout(attach, 50);
      return;
    }
    const knownLinks = new Map();
    const linksLive = function () {
      return !disposed && frame.isConnected && frame.dataset.name === S.active && session === S.active;
    };
    let lastDownload = { path: '', at: 0 };
    const activateDownload = function (filePath) {
      if (lastDownload.path === filePath && Date.now() - lastDownload.at < 1000) return;
      lastDownload = { path: filePath, at: Date.now() };
      startDownload(session, filePath);
    };
    const syncLinkOverlay = function (lineNumber, links) {
      const screen = term.element?.querySelector('.xterm-screen');
      const cell = term._core?._renderService?.dimensions?.css?.cell;
      if (!screen || !cell?.width || !cell?.height) return;
      for (const old of screen.querySelectorAll('.mcw-file-link[data-line="' + lineNumber + '"]')) old.remove();
      const visibleLine = lineNumber - term.buffer.active.viewportY;
      if (visibleLine < 1 || visibleLine > term.rows) return;
      for (const link of links) {
        const anchor = h('a', {
          class: 'mcw-file-link',
          href: '/api/files/download?' + new URLSearchParams({ session: session, path: link.text }).toString(),
          download: '',
          'aria-label': 'Download ' + link.text,
          title: 'Download ' + link.text
        });
        anchor.dataset.line = String(lineNumber);
        anchor.style.position = 'absolute';
        anchor.style.zIndex = '10';
        anchor.style.left = ((link.range.start.x - 1) * cell.width) + 'px';
        anchor.style.top = ((visibleLine - 1) * cell.height) + 'px';
        anchor.style.width = ((link.range.end.x - link.range.start.x + 1) * cell.width) + 'px';
        anchor.style.height = cell.height + 'px';
        anchor.style.cursor = 'pointer';
        anchor.style.background = 'transparent';
        anchor.addEventListener('click', function (event) { event.stopPropagation(); });
        screen.append(anchor);
      }
    };
    const linkProvider = term.registerLinkProvider({
      provideLinks: function (lineNumber, callback) {
        const line = term.buffer.active.getLine(lineNumber - 1);
        if (!line) { callback(undefined); return; }
        const text = line.translateToString(true);
        const candidates = pathCandidates(text);
        if (!candidates.length) { callback(undefined); return; }
        existingPaths(session, candidates.map(function (candidate) { return candidate.path; }))
          .then(function (stats) {
            if (!linksLive()) return;
            const links = [];
            for (let index = 0; index < candidates.length; index += 1) {
              if (!stats[index]?.exists) continue;
              const candidate = candidates[index];
              links.push({
                range: {
                  start: { x: candidate.start + 1, y: lineNumber },
                  end: { x: candidate.start + candidate.length, y: lineNumber }
                },
                text: candidate.path,
                activate: function (event, textValue) {
                  event.preventDefault();
                  activateDownload(textValue);
                }
              });
            }
            knownLinks.set(lineNumber, links);
            syncLinkOverlay(lineNumber, links);
            callback(links.length ? links : undefined);
          })
          .catch(function () {
            if (!linksLive()) return;
            knownLinks.delete(lineNumber);
            syncLinkOverlay(lineNumber, []);
            callback(undefined);
          });
      }
    });
    let overlayTimer = 0;
    let overlayGeneration = 0;
    const refreshVisibleLinks = async function () {
      const generation = ++overlayGeneration;
      const start = term.buffer.active.viewportY;
      const candidates = [];
      for (let row = 0; row < term.rows; row += 1) {
        const text = term.buffer.active.getLine(start + row)?.translateToString(true) || '';
        for (const candidate of pathCandidates(text)) {
          if (candidates.length >= 64) break;
          candidates.push({ ...candidate, lineNumber: start + row + 1 });
        }
        if (candidates.length >= 64) break;
      }
      const screen = term.element?.querySelector('.xterm-screen');
      if (!candidates.length) {
        if (screen) for (const old of screen.querySelectorAll('.mcw-file-link')) old.remove();
        return;
      }
      try {
        const stats = await existingPaths(session, candidates.map(function (candidate) { return candidate.path; }));
        if (!linksLive() || generation !== overlayGeneration) return;
        if (screen) for (const old of screen.querySelectorAll('.mcw-file-link')) old.remove();
        const byLine = new Map();
        for (let index = 0; index < candidates.length; index += 1) {
          if (!stats[index]?.exists) continue;
          const candidate = candidates[index];
          const links = byLine.get(candidate.lineNumber) || [];
          links.push({
            text: candidate.path,
            range: {
              start: { x: candidate.start + 1, y: candidate.lineNumber },
              end: { x: candidate.start + candidate.length, y: candidate.lineNumber }
            }
          });
          byLine.set(candidate.lineNumber, links);
        }
        for (const [lineNumber, links] of byLine) {
          knownLinks.set(lineNumber, links);
          syncLinkOverlay(lineNumber, links);
        }
      } catch (e) { /* an existence check failure produces no file links */ }
    };
    frame._mcwRefreshLinks = refreshVisibleLinks;
    const scheduleOverlayRefresh = function () {
      clearTimeout(overlayTimer);
      overlayTimer = setTimeout(refreshVisibleLinks, 250);
    };
    const renderSubscription = term.onRender(scheduleOverlayRefresh);
    const scrollSubscription = term.onScroll(scheduleOverlayRefresh);
    scheduleOverlayRefresh();
    const linkAtEvent = function (event) {
      const screen = term.element?.querySelector('.xterm-screen');
      const cell = term._core?._renderService?.dimensions?.css?.cell;
      if (!screen || !cell?.width || !cell?.height) return null;
      const rect = screen.getBoundingClientRect();
      const x = Math.floor((event.clientX - rect.left) / cell.width) + 1;
      const y = Math.floor((event.clientY - rect.top) / cell.height) + 1;
      const lineNumber = term.buffer.active.viewportY + y;
      const known = (knownLinks.get(lineNumber) || []).find(function (link) {
        return x >= link.range.start.x && x <= link.range.end.x;
      });
      if (known) return known;
      const text = term.buffer.active.getLine(lineNumber - 1)?.translateToString(true) || '';
      const candidate = pathCandidates(text).find(function (item) {
        return x >= item.start + 1 && x <= item.start + item.length;
      });
      const cached = candidate && pathCache.get(candidate.path)?.value;
      if (!candidate || cached?.exists === false) return null;
      return {
        text: candidate.path,
        unchecked: !cached,
        range: { start: { x: candidate.start + 1, y: lineNumber }, end: { x: candidate.start + candidate.length, y: lineNumber } }
      };
    };
    const activateEventLink = function (link) {
      if (!link.unchecked) { activateDownload(link.text); return; }
      existingPaths(session, [link.text]).then(function (stats) {
        if (linksLive() && stats[0]?.exists) activateDownload(link.text);
      }).catch(function () { /* an existence check failure is not a link */ });
    };
    const onMouseDown = function (event) {
      if (!linkAtEvent(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onMouseUp = function (event) {
      const link = linkAtEvent(event);
      if (!link) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      activateEventLink(link);
    };
    const onDocumentClick = function (event) {
      const link = linkAtEvent(event);
      if (!link) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      activateEventLink(link);
    };
    term.element.addEventListener('mousedown', onMouseDown, true);
    term.element.addEventListener('mouseup', onMouseUp, true);
    frame.contentDocument.addEventListener('click', onDocumentClick, true);
    teardown = function () {
      clearTimeout(overlayTimer);
      overlayGeneration += 1;
      linkProvider.dispose();
      renderSubscription.dispose();
      scrollSubscription.dispose();
      term.element.removeEventListener('mousedown', onMouseDown, true);
      term.element.removeEventListener('mouseup', onMouseUp, true);
      frame.contentDocument?.removeEventListener('click', onDocumentClick, true);
      const screen = term.element?.querySelector('.xterm-screen');
      if (screen) for (const old of screen.querySelectorAll('.mcw-file-link')) old.remove();
      knownLinks.clear();
    };
  };
  attach();
}

async function openFilesDrawer() {
  if (!S.active) return;
  const session = S.active;
  $('#files-session').textContent = session;
  $('#files-drop-session').textContent = session;
  $('#files-choose').disabled = !canMutate();
  const list = $('#files-list');
  clear(list);
  list.append(h('p', { class: 'empty small' }, 'Loading files.'));
  $('#files-drawer').hidden = false;
  try {
    const result = await api('GET', '/api/sessions/' + encodeURIComponent(session) + '/files');
    if (S.active !== session) return;
    clear(list);
    if (!(result.transfers || []).length) {
      list.append(h('p', { class: 'empty small' }, 'No transfers for this session.'));
      return;
    }
    for (const transfer of result.transfers) {
      list.append(h('div', { class: 'file-row' },
        h('div', { class: 'file-path', title: transfer.path }, transfer.path),
        h('div', { class: 'file-meta' }, (transfer.direction === 'upload' ? 'Uploaded' : 'Downloaded') + ' · ' + fmtBytes(transfer.size) + ' · ' + fmtAge(transfer.created_at)),
        h('button', {
          class: 'file-download', type: 'button', disabled: !canMutate(),
          'aria-label': 'Download ' + transfer.path,
          onclick: function () { startDownload(session, transfer.path); }
        }, 'Download')
      ));
    }
  } catch (e) {
    clear(list);
    list.append(h('p', { class: 'form-error' }, errText(e)));
  }
}

$('#files-button').addEventListener('click', openFilesDrawer);
$('#files-close').addEventListener('click', function () { $('#files-drawer').hidden = true; });

/* ---------- sidebar ---------- */

const PHONE_QUERY = window.matchMedia('(max-width: 760px)');
const SIDEBAR_DEFAULT = 300;

function isPhone() { return PHONE_QUERY.matches; }
function sidebarDevice() { return isPhone() ? 'phone' : 'desktop'; }
function sidebarKey(suffix) { return 'mcw.sidebar.' + sidebarDevice() + '.' + suffix; }

// The phone layout has its own row geometry, so the tree is drawn again when the layout changes.
function pruneWarmFrames() {
  if (S.authed) render();
}

window.addEventListener('resize', pruneWarmFrames);
for (const query of [PHONE_QUERY]) {
  if (query.addEventListener) query.addEventListener('change', pruneWarmFrames);
  else query.addListener(pruneWarmFrames);
}
function clampSidebarWidth(value) {
  return Math.max(220, Math.min(520, Math.min(window.innerWidth * .55, Number(value) || SIDEBAR_DEFAULT)));
}

function loadSidebarState() {
  S.sidebarWidth = clampSidebarWidth(LS.get(sidebarKey('width'), SIDEBAR_DEFAULT));
  S.sidebarCollapsed = !!LS.get(sidebarKey('collapsed'), isPhone());
  applySidebarState(false);
}

function applySidebarState(save) {
  document.documentElement.style.setProperty('--sidebar-width', Math.round(S.sidebarWidth) + 'px');
  document.body.classList.toggle('sidebar-collapsed', S.sidebarCollapsed);
  $('#show-sidebar').setAttribute('aria-expanded', S.sidebarCollapsed ? 'false' : 'true');
  $('#bar-sidebar').setAttribute('aria-expanded', S.sidebarCollapsed ? 'false' : 'true');
  $('#scrim').hidden = !isPhone() || S.sidebarCollapsed;
  $('#sidebar-resizer').setAttribute('aria-valuenow', String(Math.round(S.sidebarWidth)));
  if (save) {
    LS.set(sidebarKey('width'), Math.round(S.sidebarWidth));
    LS.set(sidebarKey('collapsed'), S.sidebarCollapsed);
  }
  requestAnimationFrame(function () { refitTerminals(); requestAnimationFrame(refitTerminals); });
}

function setSidebarCollapsed(collapsed) {
  S.sidebarCollapsed = !!collapsed;
  applySidebarState(true);
}

$('#hide-sidebar').addEventListener('click', function () { setSidebarCollapsed(true); });
$('#show-sidebar').addEventListener('click', function () { setSidebarCollapsed(false); });
$('#bar-sidebar').addEventListener('click', function () { setSidebarCollapsed(!S.sidebarCollapsed); });
$('#scrim').addEventListener('click', function () { setSidebarCollapsed(true); });
$('#collapse-folders').addEventListener('click', function () {
  S.collapsed.add(FOLDERS_KEY);
  for (const n of S.nodes) if (n.kind === 'folder') S.collapsed.add(n.id);
  persistView();
  render();
});

const sidebarResizer = $('#sidebar-resizer');
let resizingSidebar = false;

sidebarResizer.addEventListener('pointerdown', function (ev) {
  if (isPhone() || ev.button !== 0) return;
  resizingSidebar = true;
  sidebarResizer.classList.add('dragging');
  sidebarResizer.setPointerCapture(ev.pointerId);
  ev.preventDefault();
});

sidebarResizer.addEventListener('pointermove', function (ev) {
  if (!resizingSidebar) return;
  S.sidebarWidth = clampSidebarWidth(ev.clientX);
  applySidebarState(false);
});

function finishSidebarResize() {
  if (!resizingSidebar) return;
  resizingSidebar = false;
  sidebarResizer.classList.remove('dragging');
  applySidebarState(true);
}

sidebarResizer.addEventListener('pointerup', finishSidebarResize);
sidebarResizer.addEventListener('pointercancel', finishSidebarResize);
sidebarResizer.addEventListener('dblclick', function () {
  S.sidebarWidth = SIDEBAR_DEFAULT;
  applySidebarState(true);
});
sidebarResizer.addEventListener('keydown', function (ev) {
  if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
  ev.preventDefault();
  S.sidebarWidth = clampSidebarWidth(S.sidebarWidth + (ev.key === 'ArrowRight' ? 10 : -10));
  applySidebarState(true);
});

PHONE_QUERY.addEventListener('change', loadSidebarState);

/* ---------- context menus ----------
 * A menu is state: S.menu names its anchor and items, and the menu view draws it. Status updates
 * redraw it in place, so it stays open with focus on the same item. */

let menuSeq = 0;

function menuOpen() { return S.menu !== null; }

function openMenu(anchor, head, items) {
  S.menu = { id: ++menuSeq, anchor: anchor, head: head, items: items };
  renderViews();
}

// refocus puts focus back on the control that opened the menu, after Escape or a choice.
function closeMenu(refocus) {
  const menu = S.menu;
  if (!menu) return;
  S.menu = null;
  renderViews();
  if (refocus && menu.anchor && menu.anchor.isConnected) menu.anchor.focus();
}

function menuFolder(anchor, n) {
  if (!n) return;
  const ro = !canMutate();
  openMenu(anchor, n.name, [
    { label: 'New session here', disabled: ro, run: function () { dlgNewSession(n.id); } },
    { label: 'New folder here', disabled: ro, run: function () { dlgNewFolder(n.id); } },
    { label: 'Rename folder', disabled: ro, run: function () { dlgRename(n); } },
    { label: 'Move to folder', disabled: ro, run: function () { dlgMove(n); } },
    { label: 'Delete folder', danger: true, disabled: ro, run: function () { dlgDeleteFolder(n); } }
  ]);
}

function menuLeaf(anchor, n) {
  if (!n) return;
  const ro = !canMutate();
  const name = M.hostName(S, n.session_name);
  const st = liveState(name);
  openMenu(anchor, name, [
    { label: 'Open terminal', run: function () { openSession(name); } },
    st === 'idle' ? { label: 'Hibernate', disabled: ro, run: function () { dlgHibernateOne(name); } } : null,
    st === 'missing' ? { label: 'Create session', disabled: ro, run: function () { dlgRecreate(n); } } : null,
    st === 'idle' ? { label: 'Rename session', disabled: ro, run: function () { dlgRenameSession(name); } } : null,
    { label: 'Move to folder', disabled: ro, run: function () { dlgMove(n); } },
    { label: 'Delete session', danger: true, disabled: ro, run: function () { dlgDeleteLeaf(n); } }
  ]);
}

function menuUnfiled(anchor, name) {
  const ro = !canMutate();
  const st = liveState(name);
  openMenu(anchor, name, [
    { label: 'Open terminal', run: function () { openSession(name); } },
    st === 'idle' ? { label: 'Hibernate', disabled: ro, run: function () { dlgHibernateOne(name); } } : null,
    st === 'idle' ? { label: 'Rename session', disabled: ro, run: function () { dlgRenameSession(name); } } : null,
    { label: 'File into folder', disabled: ro, run: function () { dlgAdopt(name); } },
    { label: 'Delete session', danger: true, disabled: ro, run: function () { dlgDeleteUnfiled(name); } }
  ]);
}

/* ---------- dialogs ----------
 * A dialog is state too: S.modals lists the open ones and the dialog view draws them. Each spec
 * gives a title, initial field values, a body drawn from those values, and its actions. */

function modal(spec) {
  pushModal(S, spec);
  render();
}

function closeModal(id) {
  removeModal(S, id);
  render();
}

document.addEventListener('keydown', function (ev) {
  if (ev.key !== 'Escape') return;
  if (S.menu) { closeMenu(true); return; }
  if (S.modals.length) closeModal(S.modals[S.modals.length - 1].id);
});

function field(labelText, control, hint) {
  return html`<label class="field"><span class="field-label">${labelText}</span>${control}${hint ? html`<span class="hint">${hint}</span>` : null}</label>`;
}

function group(labelText, control, hint) {
  return html`<div class="field"><span class="field-label">${labelText}</span>${control}${hint ? html`<span class="hint">${hint}</span>` : null}</div>`;
}

function kv(k, v) {
  return html`<div class="kv"><span class="k">${k}</span><span class="v">${v}</span></div>`;
}

function textInput(values, set, key, extra) {
  return html`<input class="inp" type="text" maxlength=${(extra && extra.maxlength) || null}
      autocapitalize="off" autocorrect="off" spellcheck="false" data-autofocus=${(extra && extra.autofocus) || null}
      value=${values[key]} onInput=${(ev) => set({ [key]: ev.currentTarget.value })} />`;
}

function hint(text) { return html`<p class="hint">${text}</p>`; }
function text(value) { return html`<p class="modal-text">${value}</p>`; }

const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

/* ---------- folder dialogs ---------- */

function dlgNewFolder(parentId) {
  modal({
    title: 'New folder',
    initial: { name: '' },
    body: (v, set) => [field('Name', textInput(v, set, 'name', { maxlength: '64' })), hint('In ' + pathOf(parentId))],
    submitLabel: 'Create',
    onSubmit: async function (v) {
      const name = v.name.trim();
      if (!name) throw new Error('Enter a name.');
      await api('POST', '/api/folders', { name: name, parent_id: parentId || null });
      await refreshState(true);
    }
  });
}

function dlgRename(n) {
  modal({
    title: 'Rename folder',
    initial: { name: n.name },
    body: (v, set) => [field('Name', textInput(v, set, 'name', { maxlength: '64' }))],
    submitLabel: 'Rename',
    onSubmit: async function (v) {
      const name = v.name.trim();
      if (!name) throw new Error('Enter a name.');
      if (name === n.name) return;
      await api('PATCH', '/api/nodes/' + encodeURIComponent(n.id), { name: name });
      await refreshState(true);
    }
  });
}

function dlgDeleteFolder(n) {
  const ids = descendantIds(n.id);
  let folders = 0, sessions = 0;
  for (const id of ids) {
    const d = nodeById(id);
    if (!d) continue;
    if (d.kind === 'folder') folders++; else sessions++;
  }
  const empty = ids.size === 0;
  const counts = folders + (folders === 1 ? ' folder' : ' folders') + ' and ' + sessions + (sessions === 1 ? ' session' : ' sessions');
  const removeWith = function (mode) {
    return async function () {
      await api('DELETE', '/api/folders/' + encodeURIComponent(n.id) + '?mode=' + mode);
      await refreshState(true);
    };
  };
  modal({
    title: 'Delete folder ' + n.name,
    body: () => [
      text(empty ? 'This folder is empty.' : 'This folder contains ' + counts + '.'),
      empty ? null : hint('Move contents up keeps the sessions and puts everything in ' + pathOf(n.parent_id) + '. Delete contents destroys the real zellij sessions on the session machine.')
    ],
    extra: empty ? [
      { label: 'Delete folder', danger: true, run: removeWith('move_up') }
    ] : [
      { label: 'Move contents up', run: removeWith('move_up') },
      { label: 'Delete contents and sessions', danger: true, run: removeWith('delete_sessions') }
    ]
  });
}

/* ---------- move and adopt ---------- */

function FolderPicker({ selected, banned, onPick }) {
  const rows = [];
  const walk = function (pid, depth) {
    for (const n of childrenOf(pid)) {
      if (n.kind !== 'folder') continue;
      if (banned && banned.has(n.id)) continue;
      rows.push({ id: n.id, label: n.name, depth: depth });
      walk(n.id, depth + 1);
    }
  };
  rows.push({ id: null, label: 'Root', depth: 0 });
  walk(null, 1);
  return html`<div class="pick-list">${rows.map((row) => html`<button key=${row.id || '__root__'}
      class=${'pick' + (selected === row.id ? ' on' : '')} type="button" aria-pressed=${selected === row.id ? 'true' : 'false'}
      style=${{ paddingLeft: (10 + row.depth * 16) + 'px' }} onClick=${() => onPick(row.id)}>${row.label}</button>`)}</div>`;
}

function dlgMove(n) {
  const banned = descendantIds(n.id);
  banned.add(n.id);
  modal({
    title: 'Move ' + n.name,
    initial: { pid: n.parent_id || null },
    body: (v, set) => [group('Destination', html`<${FolderPicker} selected=${v.pid} banned=${banned} onPick=${(pid) => set({ pid: pid })} />`)],
    submitLabel: 'Move',
    onSubmit: async function (v) {
      if ((v.pid || null) === (n.parent_id || null)) return;
      await api('PATCH', '/api/nodes/' + encodeURIComponent(n.id), { parent_id: v.pid || null, position: endPosition(v.pid || null) });
      if (v.pid) S.collapsed.delete(v.pid);
      persistView();
      await refreshState(true);
    }
  });
}

function dlgAdopt(sessionName) {
  modal({
    title: 'File ' + sessionName,
    initial: { pid: null },
    body: (v, set) => [group('Destination', html`<${FolderPicker} selected=${v.pid} banned=${null} onPick=${(pid) => set({ pid: pid })} />`)],
    submitLabel: 'File',
    onSubmit: async function (v) {
      await api('POST', '/api/adopt', { session_name: sessionName, parent_id: v.pid || null });
      if (v.pid) S.collapsed.delete(v.pid);
      persistView();
      await refreshState(true);
    }
  });
}

/* ---------- session dialogs ---------- */

// A rename is one session changing its name. From the moment the request leaves, the old and new
// names stand for the same row, frame and address, so no read in between can show it as gone.
async function renameSession(oldName, newName) {
  startRename(S, oldName, newName);
  render();
  let result;
  try {
    result = await api('POST', '/api/sessions/rename', { old_name: oldName, new_name: newName });
  } catch (e) {
    abortRename(S, oldName, newName);
    render();
    throw e;
  }
  confirmRename(S, oldName, newName, result && result.node);
  renameOpenSession(oldName, newName);
  render();
  toast('Session renamed to ' + newName + '.');
  await refreshState(true);
  return result;
}

function dlgRenameSession(oldName) {
  modal({
    title: 'Rename session',
    initial: { name: oldName },
    body: (v, set) => [
      field('Name', textInput(v, set, 'name', { maxlength: '64', autofocus: 'true' }), 'This renames the zellij session and the Claude Remote Control session.'),
      hint('Claude must be waiting at its prompt so it can accept /rename.')
    ],
    submitLabel: 'Rename',
    onSubmit: async function (v) {
      const newName = v.name.trim();
      if (!NAME_RE.test(newName)) throw new Error('Use letters, numbers, dot, dash or underscore, 1 to 64 characters.');
      if (newName === oldName) return;
      await renameSession(oldName, newName);
    }
  });
}

function dlgDeleteLeaf(n) {
  modal({
    title: 'Delete session ' + n.session_name,
    body: () => [
      text('This destroys the zellij session ' + n.session_name + ' on the session machine and removes the leaf from the tree.'),
      hint('Anything running in its panes is stopped.')
    ],
    extra: [{ label: 'Delete session', danger: true, run: async function () {
      await api('DELETE', '/api/sessions/' + encodeURIComponent(n.id));
      closeSession(n.session_name);
      await refreshState(true);
    } }]
  });
}

function dlgDeleteUnfiled(name) {
  modal({
    title: 'Delete session ' + name,
    body: () => [
      text('This destroys the zellij session ' + name + ' on the session machine.'),
      hint('Anything running in its panes is stopped.')
    ],
    extra: [{ label: 'Delete session', danger: true, run: async function () {
      // DELETE /api/sessions takes a node id, and an unfiled session has no node yet,
      // so it is filed at the root first and the resulting leaf is deleted.
      const res = await api('POST', '/api/adopt', { session_name: name, parent_id: null });
      const id = res && res.node && res.node.id;
      if (!id) throw new Error('The server did not return a node for ' + name + '.');
      await api('DELETE', '/api/sessions/' + encodeURIComponent(id));
      closeSession(name);
      await refreshState(true);
    } }]
  });
}

function hibernatePreviewRows(rows) {
  if (!rows.length) return text('No sessions meet the hibernation conditions.');
  return html`<div class="pick-list" aria-label="Sessions to hibernate">${rows.map((row) => html`<div class="pick" key=${row.name}>
    <strong>${row.name}</strong>
    <div class="hint">${(row.lastActivityAt ? fmtAge(row.lastActivityAt) : 'No recorded activity') + '. ' + row.reason}</div>
  </div>`)}</div>`;
}

async function dlgHibernateOne(name) {
  let preview;
  try { preview = await api('GET', '/api/sessions/hibernate-preview'); }
  catch (e) { toast(errText(e), true); return; }
  const candidate = (preview.candidates || []).find(function (row) { return row.name === name; });
  if (!candidate) {
    const excluded = (preview.excluded || []).find(function (row) { return row.name === name; });
    toast(name + ' cannot hibernate: ' + (excluded?.reason || 'state changed') + '.', true);
    return;
  }
  modal({
    title: 'Hibernate ' + name,
    body: () => [text('This stops the session while preserving its Claude conversation for wake.'), hibernatePreviewRows([candidate])],
    extra: [{ label: 'Hibernate', run: async function () {
      await api('POST', '/api/sessions/' + encodeURIComponent(name) + '/hibernate', {});
      closeSession(name);
      await refreshState(true);
    } }]
  });
}

async function dlgHibernateIdle() {
  let preview;
  try { preview = await api('GET', '/api/sessions/hibernate-preview'); }
  catch (e) { toast(errText(e), true); return; }
  const candidates = preview.candidates || [];
  modal({
    title: 'Hibernate idle sessions',
    body: () => candidates.length
      ? [text('These sessions will be hibernated. Their conversations are preserved for wake.'), hibernatePreviewRows(candidates)]
      : [hibernatePreviewRows(candidates)],
    extra: candidates.length ? [{ label: 'Hibernate ' + candidates.length + (candidates.length === 1 ? ' session' : ' sessions'), run: async function () {
      const result = await api('POST', '/api/sessions/hibernate-idle', { names: candidates.map(function (row) { return row.name; }) });
      for (const item of result.hibernated || []) closeSession(item.name);
      await refreshState(true);
      if (result.skipped?.length) toast(result.skipped.length + ' session' + (result.skipped.length === 1 ? ' was' : 's were') + ' skipped because its state changed.');
    } }] : []
  });
}

function dlgRecreate(n) {
  modal({
    title: 'Create session ' + n.session_name,
    body: () => [
      text('This session is in the tree but is not running on the session machine. It will be created with its stored settings.'),
      kv('Name', n.session_name),
      kv('Panes', String(n.panes || 1)),
      kv('Directory', n.workdir || 'Agent default'),
      kv('Resume', n.resume_sid || 'none')
    ],
    submitLabel: 'Create session',
    onSubmit: async function () {
      await api('POST', '/api/sessions', {
        name: n.session_name,
        panes: Number(n.panes) || 1,
        workdir: n.workdir || '',
        resume_sid: n.resume_sid || null,
        parent_id: n.parent_id || null
      });
      await refreshState(true);
      openSession(n.session_name);
    }
  });
}

/* ---------- create session ---------- */

// The resume picker loads the host's transcripts once and filters them as the person types.
class TranscriptPicker extends Component {
  constructor(props) {
    super(props);
    this.state = { all: [], status: 'Loading transcripts.', query: '' };
  }

  componentDidMount() {
    api('GET', '/api/transcripts').then((d) => {
      const all = (d && Array.isArray(d.transcripts)) ? d.transcripts : [];
      this.setState({ all: all, status: all.length ? '' : 'No transcripts on the host.' });
    }).catch((e) => {
      this.setState({ status: 'Transcripts unavailable. ' + errText(e) });
    });
  }

  render({ selected, onPick }, { all, status, query }) {
    const q = query.trim().toLowerCase();
    const shown = all.filter((t) => {
      const title = String(t.title || t.sid || '');
      return !q || title.toLowerCase().indexOf(q) >= 0 || String(t.sid || '').toLowerCase().indexOf(q) >= 0;
    });
    const option = (sid, title, age) => html`<label key=${sid || '__none__'} class=${'tr' + (selected === sid ? ' sel' : '')}>
      <input type="radio" name="resume-sid" value=${sid || ''} checked=${selected === sid} onChange=${() => onPick(sid)} />
      <span class="tr-main"><span class="tr-title">${title}</span>${age ? html`<span class="tr-age">${age}</span>` : null}</span>
    </label>`;
    return html`<div class="stack">
      <input class="inp" type="search" placeholder="Search" aria-label="Search transcripts" value=${query}
          onInput=${(ev) => this.setState({ query: ev.currentTarget.value })} />
      <div class="tr-list">
        ${option(null, 'None', '')}
        ${shown.map((t) => option(t.sid, String(t.title || t.sid || ''), fmtAge(t.mtime)))}
      </div>
      <p class="hint" hidden=${!status}>${status}</p>
    </div>`;
  }
}

function PaneCount({ panes, onPick }) {
  return html`<div class="seg" role="group" aria-label="Pane count">${[1, 2, 3, 4].map((n) => html`<button key=${n}
      class=${'seg-btn' + (n === panes ? ' on' : '')} type="button" aria-pressed=${n === panes ? 'true' : 'false'}
      onClick=${() => onPick(n)}>${String(n)}</button>`)}</div>`;
}

function dlgNewSession(parentId) {
  modal({
    title: 'New session',
    initial: { name: '', workdir: '', panes: 1, sid: null },
    body: (v, set) => [
      field('Name', textInput(v, set, 'name', { maxlength: '64', autofocus: 'true' }), 'Letters, numbers, dot, dash and underscore. This is the zellij session name.'),
      group('Panes', html`<${PaneCount} panes=${v.panes} onPick=${(n) => set({ panes: n })} />`),
      field('Working directory', textInput(v, set, 'workdir'), 'Leave blank to use the agent default.'),
      group('Resume a Claude conversation', html`<${TranscriptPicker} selected=${v.sid} onPick=${(sid) => set({ sid: sid })} />`),
      hint('In ' + pathOf(parentId))
    ],
    submitLabel: 'Create session',
    onSubmit: async function (v) {
      const name = v.name.trim();
      if (!NAME_RE.test(name)) throw new Error('Use letters, numbers, dot, dash or underscore, 1 to 64 characters.');
      const workdir = v.workdir.trim();
      if (workdir && workdir.charAt(0) !== '/') throw new Error('The working directory must be an absolute path.');
      await api('POST', '/api/sessions', {
        name: name,
        panes: v.panes,
        workdir: workdir,
        resume_sid: v.sid || null,
        parent_id: parentId || null
      });
      if (parentId) { S.collapsed.delete(parentId); persistView(); }
      await refreshState(true);
      openSession(name);
    }
  });
}

/* ---------- drag and drop, pointer events so it works on touch ----------
 * The drag source and drop mark are state, so the rows draw them and a status update during a
 * drag keeps them. Hit testing reads the rows' data attributes. */

const drag = {
  pending: null, active: false, kind: null, id: null, name: '', key: '', label: '',
  row: null, ghost: null, pointerId: null, banned: null,
  lastX: 0, lastY: 0, target: null,
  holdTimer: null, scrollTimer: null, suppressClick: false
};

treeEl.addEventListener('pointerdown', function (ev) {
  if (ev.button !== 0) return;
  if (!canMutate()) return;
  if (ev.target.closest('button, select')) return;
  const row = ev.target.closest('.row');
  if (!row || row.dataset.drag !== '1') return;

  endDrag();
  drag.pending = { row: row, x: ev.clientX, y: ev.clientY, type: ev.pointerType, pointerId: ev.pointerId };
  drag.lastX = ev.clientX;
  drag.lastY = ev.clientY;
  if (ev.pointerType !== 'mouse') drag.holdTimer = setTimeout(startDrag, 320);
  document.addEventListener('pointermove', onDragMove, { passive: false });
  document.addEventListener('pointerup', onDragUp);
  document.addEventListener('pointercancel', onDragUp);
});

function onDragMove(ev) {
  drag.lastX = ev.clientX;
  drag.lastY = ev.clientY;

  if (!drag.active) {
    if (!drag.pending) return;
    const dx = Math.abs(ev.clientX - drag.pending.x), dy = Math.abs(ev.clientY - drag.pending.y);
    if (drag.pending.type === 'mouse') { if (dx + dy > 5) startDrag(); }
    else if (dx > 10 || dy > 10) endDrag();
    return;
  }
  if (ev.cancelable) ev.preventDefault();
  moveGhost(ev.clientX, ev.clientY);
  updateDropTarget(ev.clientX, ev.clientY);
}

function startDrag() {
  const p = drag.pending;
  if (!p || !p.row.isConnected) { endDrag(); return; }
  clearTimeout(drag.holdTimer);
  drag.holdTimer = null;

  const row = p.row;
  drag.active = true;
  drag.row = row;
  drag.kind = row.dataset.kind;
  drag.id = row.dataset.id || null;
  drag.name = row.dataset.name || '';
  drag.key = row.dataset.key || '';
  drag.pointerId = p.pointerId;
  drag.banned = drag.id ? descendantIds(drag.id) : new Set();
  const nameEl = row.querySelector('.name');
  drag.label = nameEl ? nameEl.textContent : (drag.name || 'item');

  try { row.setPointerCapture(p.pointerId); } catch (e) { /* capture is best effort */ }
  S.drag = { source: drag.key, target: null, mode: null };
  document.documentElement.classList.add('dragging');
  drag.ghost = h('div', { class: 'ghost' }, drag.label);
  document.body.append(drag.ghost);
  moveGhost(drag.lastX, drag.lastY);
  updateDropTarget(drag.lastX, drag.lastY);
  if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) { /* no haptics */ } }
  drag.scrollTimer = setInterval(autoScroll, 40);
}

function moveGhost(x, y) {
  if (!drag.ghost) return;
  const gx = Math.min(Math.max(8, x + 12), window.innerWidth - 16);
  const gy = Math.min(Math.max(8, y - 16), window.innerHeight - 40);
  drag.ghost.style.transform = 'translate(' + gx + 'px,' + gy + 'px)';
}

function markDrop(target, mode, root) {
  treeEl.classList.toggle('dz-root', !!root);
  const next = drag.active ? { source: drag.key, target: target, mode: mode } : null;
  const prev = S.drag;
  if (prev && next && prev.source === next.source && prev.target === next.target && prev.mode === next.mode) return;
  S.drag = next;
  renderViews();
}

function updateDropTarget(x, y) {
  drag.target = null;

  const box = treeEl.getBoundingClientRect();
  if (x < box.left || x > box.right || y < box.top - 6 || y > box.bottom + 6) { markDrop(null, null, false); return; }

  const under = document.elementFromPoint(x, y);
  const row = (under && under.closest) ? under.closest('.row') : null;

  if (!row || !treeEl.contains(row)) {
    if (dropAllowed({ mode: 'root' })) { drag.target = { mode: 'root' }; markDrop(null, null, true); }
    else markDrop(null, null, false);
    return;
  }
  const kind = row.dataset.kind;
  if (kind === 'unfiled' || kind === 'section' || kind === 'recent' || row === drag.row) { markDrop(null, null, false); return; }

  const r = row.getBoundingClientRect();
  const rel = (y - r.top) / Math.max(1, r.height);
  const mode = (kind === 'folder')
    ? (rel < 0.28 ? 'before' : (rel > 0.72 ? 'after' : 'into'))
    : (rel < 0.5 ? 'before' : 'after');

  const t = { mode: mode, row: row, id: row.dataset.id };
  if (!dropAllowed(t)) { markDrop(null, null, false); return; }

  drag.target = t;
  markDrop(row.dataset.key, mode, false);
}

function resolveDrop(t, selfId) {
  if (!t) return null;
  if (t.mode === 'root') return { parentId: null, position: endPosition(null) };
  if (t.mode === 'into') return { parentId: t.id, position: endPosition(t.id) };

  const target = nodeById(t.id);
  if (!target) return null;
  const parentId = target.parent_id || null;
  const sibs = childrenOf(parentId).filter(function (n) { return n.id !== selfId; });
  const idx = sibs.findIndex(function (n) { return n.id === t.id; });
  if (idx < 0) return { parentId: parentId, position: endPosition(parentId) };
  return { parentId: parentId, position: positionAt(sibs, t.mode === 'before' ? idx : idx + 1) };
}

function dropAllowed(t) {
  const d = resolveDrop(t, drag.id);
  if (!d) return false;
  if (drag.kind === 'unfiled') return true;
  if (!drag.id) return false;
  if (d.parentId === drag.id) return false;
  if (d.parentId && drag.banned && drag.banned.has(d.parentId)) return false;
  return true;
}

function autoScroll() {
  if (!drag.active) return;
  const box = treeEl.getBoundingClientRect();
  const margin = 46;
  let dy = 0;
  if (drag.lastY < box.top + margin) dy = -14;
  else if (drag.lastY > box.bottom - margin) dy = 14;
  if (!dy) return;
  const before = treeEl.scrollTop;
  treeEl.scrollTop += dy;
  if (treeEl.scrollTop !== before) updateDropTarget(drag.lastX, drag.lastY);
}

function onDragUp() {
  if (!drag.active) { endDrag(); return; }
  const snap = { kind: drag.kind, id: drag.id, name: drag.name, target: drag.target };
  endDrag();
  drag.suppressClick = true;
  setTimeout(function () { drag.suppressClick = false; }, 350);
  if (snap.target) applyDrop(snap);
}

async function applyDrop(snap) {
  const d = resolveDrop(snap.target, snap.id);
  if (!d) return;
  try {
    if (snap.kind === 'unfiled') {
      await api('POST', '/api/adopt', { session_name: snap.name, parent_id: d.parentId });
    } else {
      await api('PATCH', '/api/nodes/' + encodeURIComponent(snap.id), { parent_id: d.parentId, position: d.position });
    }
    if (d.parentId) { S.collapsed.delete(d.parentId); persistView(); }
  } catch (e) {
    if (e.status !== 401) toast(errText(e), true);
  }
  await refreshState(true);
}

function endDrag() {
  clearTimeout(drag.holdTimer);
  clearInterval(drag.scrollTimer);
  drag.holdTimer = null;
  drag.scrollTimer = null;

  if (drag.row && drag.pointerId !== null) {
    try { drag.row.releasePointerCapture(drag.pointerId); } catch (e) { /* already gone */ }
  }
  if (drag.ghost) drag.ghost.remove();
  document.documentElement.classList.remove('dragging');
  document.removeEventListener('pointermove', onDragMove, { passive: false });
  document.removeEventListener('pointerup', onDragUp);
  document.removeEventListener('pointercancel', onDragUp);

  const wasMarked = S.drag !== null;
  drag.pending = null;
  drag.active = false;
  drag.row = null;
  drag.ghost = null;
  drag.pointerId = null;
  drag.target = null;
  drag.banned = null;
  drag.kind = null;
  drag.id = null;
  drag.name = '';
  drag.key = '';
  treeEl.classList.remove('dz-root');
  S.drag = null;
  if (wasMarked) renderViews();
}

/* ---------- root actions and boot ---------- */

$('#new-folder-root').addEventListener('click', function () { dlgNewFolder(null); });
$('#new-session-root').addEventListener('click', function () { dlgNewSession(null); });
$('#hibernate-idle').addEventListener('click', dlgHibernateIdle);

(async function boot() {
  let authed = null;
  try {
    const res = await fetch('/api/me', { credentials: 'same-origin', headers: { accept: 'application/json' } });
    const d = await res.json().catch(function () { return null; });
    authed = !!(d && d.authenticated === true);
  } catch (e) {
    authed = null;
  }
  $('#boot').hidden = true;
  if (authed === true) enterApp();
  else showLogin(authed === null ? 'Cannot reach the server.' : '');
})();

})();
