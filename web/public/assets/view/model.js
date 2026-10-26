// The sidebar as data. Every function here is pure: it reads the store's state and returns what
// the views draw. Each row carries a key that stays the same while the row stands for the same
// thing, so a status change updates a row in place instead of replacing it.
import { stateForSession } from '../status-lease.js';
import { orderRecents, recentActivityAt, compareActivity } from '../recent-order.js';
import { sessionPath } from '../session-url.js';
import { fmtShortAge } from './format.js';
import { identityOf, renamePair } from './store.js';

export const UNFILED_KEY = '__unfiled__';
export const RECENTS_KEY = '__recents__';
export const FOLDERS_KEY = '__folders__';

export const STATE_TEXT = {
  creating: 'creating', failed: 'creation failed', busy: 'working', background: 'working in background', idle: 'waiting for input', sleeping: 'sleeping',
  waking: 'waking', absent: 'no Claude process', running: 'running', exited: 'exited', missing: 'not created',
  unknown: 'unknown',
};

/* ---------- the folder tree ---------- */

export function cmpNode(a, b) {
  const pa = Number(a.position), pb = Number(b.position);
  const da = isFinite(pa) ? pa : 0, db = isFinite(pb) ? pb : 0;
  if (da !== db) return da - db;
  return String(a.name || '').localeCompare(String(b.name || ''));
}

export function nodeById(nodes, id) {
  for (const n of nodes) if (n.id === id) return n;
  return null;
}

export function childrenOf(nodes, pid) {
  const want = pid || null;
  return nodes.filter((n) => (n.parent_id || null) === want).sort(cmpNode);
}

export function descendantIds(nodes, id) {
  const out = new Set();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    for (const n of nodes) {
      if ((n.parent_id || null) === cur && !out.has(n.id)) { out.add(n.id); stack.push(n.id); }
    }
  }
  return out;
}

export function pathOf(nodes, pid) {
  if (!pid) return 'Root';
  const parts = [];
  let cur = nodeById(nodes, pid);
  let guard = 0;
  while (cur && guard++ < 64) { parts.unshift(cur.name); cur = cur.parent_id ? nodeById(nodes, cur.parent_id) : null; }
  return parts.join(' / ') || 'Root';
}

export function endPosition(nodes, pid) {
  const kids = childrenOf(nodes, pid);
  if (!kids.length) return 1000;
  const last = Number(kids[kids.length - 1].position);
  return (isFinite(last) ? last : 0) + 1000;
}

export function positionAt(sibs, index) {
  const before = sibs[index - 1], after = sibs[index];
  if (!before && !after) return 1000;
  if (!before) return Number(after.position) - 1000;
  if (!after) return Number(before.position) + 1000;
  const a = Number(before.position), b = Number(after.position);
  const mid = (a + b) / 2;
  return (Math.abs(b - a) > 1) ? Math.round(mid) : mid;
}

function folderSessionCount(nodes, id) {
  let total = 0;
  const stack = [id];
  while (stack.length) {
    const parent = stack.pop();
    for (const n of childrenOf(nodes, parent)) {
      if (n.kind === 'session') total += 1;
      else stack.push(n.id);
    }
  }
  return total;
}

/* ---------- sessions, following a rename this browser started ---------- */

function listed(state, name) {
  return Array.isArray(state.sessions) && state.sessions.some((s) => s.name === name);
}

// The name the host lists for a session now. During a rename it is the new name once the host
// has it, and the old name before that.
export function hostName(state, name) {
  const rename = renamePair(state, name);
  if (!rename) return name;
  if (listed(state, rename.to)) return rename.to;
  if (listed(state, rename.from)) return rename.from;
  return rename.confirmed ? rename.to : rename.from;
}

export function sessionByName(state, name) {
  if (!Array.isArray(state.sessions)) return null;
  const host = hostName(state, name);
  for (const s of state.sessions) if (s.name === host) return s;
  return null;
}

// The sessions the rows are drawn from: the host's list, or while the agent or hub is away the
// last list the hub sent. Only the lights need the live list.
function knownSessions(state) {
  return Array.isArray(state.sessions) ? state.sessions : state.knownSessions;
}

function knownSession(state, name) {
  const host = hostName(state, name);
  for (const s of knownSessions(state)) if (s.name === host) return s;
  return null;
}

export function leafBySession(state, name) {
  const rename = renamePair(state, name);
  const names = rename ? [rename.from, rename.to] : [name];
  for (const n of state.nodes) if (n.kind === 'session' && names.includes(n.session_name)) return n;
  return null;
}

// Names that stand for a running session, including both names of a rename in progress.
export function listedNames(state) {
  const out = new Set();
  if (!Array.isArray(state.sessions)) return out;
  for (const s of state.sessions) if (s && s.name && !s.exited) out.add(s.name);
  for (const rename of state.renames) {
    if (out.has(rename.from) || out.has(rename.to)) { out.add(rename.from); out.add(rename.to); }
  }
  return out;
}

export function sameSession(state, a, b) {
  if (!a || !b) return false;
  return a === b || identityOf(state, a) === identityOf(state, b);
}

// Status by name, with a rename in progress readable under both names. The status push can name
// the session by its new name while the last session list still names it by the old one.
function statusByName(state) {
  if (!state.renames.length) return state.sessionStatus;
  const out = { ...state.sessionStatus };
  const has = (name) => Object.prototype.hasOwnProperty.call(out, name);
  for (const { from, to } of state.renames) {
    if (!has(from) && has(to)) out[from] = out[to];
    else if (!has(to) && has(from)) out[to] = out[from];
  }
  return out;
}

export function liveState(state, name) {
  const leaf = leafBySession(state, name);
  const creation = state.creations.find((item) => item.node_id === leaf?.id);
  if (creation) return creation.state;
  if (!Array.isArray(state.sessions)) return 'unknown';
  const host = hostName(state, name);
  const session = state.sessions.find((s) => s.name === host);
  if (!session) return renamePair(state, name) ? 'unknown' : 'missing';
  const waking = state.waking.has(host) || state.waking.has(name);
  return stateForSession(session, statusByName(state), waking, state.statusAuthoritative);
}

function activityEntry(state, name) {
  const session = knownSession(state, name) || { name: hostName(state, name) };
  return { session_name: name, last_activity_at: recentActivityAt(session, statusByName(state)) };
}

function sessionAge(state, name) {
  return fmtShortAge(activityEntry(state, name).last_activity_at, state.now);
}

function orderedChildren(state, nodes) {
  const sessions = nodes.filter((n) => n.kind === 'session').sort((a, b) =>
    compareActivity(activityEntry(state, a.session_name), activityEntry(state, b.session_name)));
  let index = 0;
  return nodes.map((node) => node.kind === 'session' ? sessions[index++] : node);
}

function leafTitle(n) {
  const bits = [n.session_name];
  if (n.workdir) bits.push(n.workdir);
  bits.push(n.panes ? (n.panes + (Number(n.panes) === 1 ? ' pane' : ' panes')) : '');
  if (n.resume_sid) bits.push('resume ' + n.resume_sid);
  return bits.filter(Boolean).join('\n');
}

/* ---------- rows ---------- */

function stateLabel(st) {
  return STATE_TEXT[st] || st;
}

function sessionRow(state, { key, kind, name, depth, label, extraLabel, age, ageTitle, title, id, guides }) {
  const st = liveState(state, name);
  const shown = hostName(state, name);
  return {
    key, kind, id: id || null, name: shown, depth, level: depth + 2,
    label: label || shown, state: st, stateText: stateLabel(st),
    ariaLabel: (label || shown) + ', ' + stateLabel(st) + (extraLabel || ''),
    href: sessionPath(shown), selected: sameSession(state, state.active, name),
    age, ageTitle: ageTitle || '', title: title || shown, guides: guides || null,
    create: kind === 'leaf' && st === 'missing',
    pending: st === 'creating' || st === 'failed',
    error: st === 'failed' ? state.creations.find((item) => item.node_id === id)?.error : '',
    retry: st === 'failed',
  };
}

function recentPath(state, name) {
  const leaf = leafBySession(state, name);
  return leaf ? pathOf(state.nodes, leaf.parent_id) : 'Unfiled';
}

function recentItems(state) {
  const rows = Array.isArray(state.sessions)
    ? orderRecents(state.sessions, statusByName(state), state.recentLimit, { waking: state.waking, authoritative: state.statusAuthoritative })
    : (state.recentLimit ? state.recents : []).map((recent) => ({
      session_name: recent.session_name,
      last_activity_at: Number(recent.last_activity_at || recent.last_response_at) || 0,
    }));
  return rows.map((recent) => sessionRow(state, {
    key: 'recent:' + identityOf(state, recent.session_name), kind: 'recent', name: recent.session_name, depth: 0,
    extraLabel: ', recent',
    age: fmtShortAge(recent.last_activity_at, state.now),
    ageTitle: recentPath(state, recent.session_name)
      + (recent.last_activity_at ? ' · ' + new Date(recent.last_activity_at).toLocaleString() : ''),
  }));
}

function leafItem(state, n, depth, guides) {
  const shown = hostName(state, n.session_name);
  return sessionRow(state, {
    key: 'leaf:' + n.id, kind: 'leaf', id: n.id, name: n.session_name, depth,
    label: renamePair(state, n.session_name) ? shown : n.name,
    age: sessionAge(state, n.session_name), title: leafTitle({ ...n, session_name: shown }), guides,
  });
}

function folderItems(state, nodes, depth, continuations) {
  return nodes.map((n, index) => {
    const last = index === nodes.length - 1;
    if (n.kind !== 'folder') return leafItem(state, n, depth, { continuations, last, stem: false });
    const open = !state.collapsed.has(n.id);
    const kids = orderedChildren(state, childrenOf(state.nodes, n.id));
    const item = {
      key: 'folder:' + n.id, kind: 'folder', id: n.id, name: n.name, label: n.name, depth, level: depth + 2,
      ariaLabel: 'Folder ' + n.name, open, count: folderSessionCount(state.nodes, n.id),
      guides: { continuations, last, stem: open && kids.length > 0 }, children: [],
    };
    if (open && kids.length) {
      const next = depth > 0 ? continuations.concat(!last) : continuations;
      item.children = folderItems(state, kids, depth + 1, next);
    }
    return item;
  });
}

// Sessions outside every folder: root leaves and leafless sessions, newest first. The hub's
// leaves are always drawn. While the agent or hub is away the rows stay and their lights go
// unknown.
function unfiledItems(state) {
  const known = new Set();
  for (const n of state.nodes) {
    if (n.kind !== 'session' || !n.session_name) continue;
    known.add(n.session_name);
    const rename = renamePair(state, n.session_name);
    if (rename) { known.add(rename.from); known.add(rename.to); }
  }
  const entries = [];
  const seen = new Set();
  for (const s of knownSessions(state)) {
    if (!s || !s.name || known.has(s.name)) continue;
    const identity = identityOf(state, s.name);
    if (seen.has(identity)) continue;
    seen.add(identity);
    entries.push({ session: s, leaf: null });
  }
  for (const n of childrenOf(state.nodes, null)) {
    if (n.kind === 'folder') continue;
    const s = knownSession(state, n.session_name) || {};
    entries.push({ session: { name: n.session_name, originalCreatedAt: s.originalCreatedAt, createdAt: s.createdAt }, leaf: n });
  }
  entries.sort((a, b) => compareActivity(activityEntry(state, a.session.name), activityEntry(state, b.session.name)));
  return entries.map((entry, index) => {
    if (entry.leaf) return leafItem(state, entry.leaf, 0, { continuations: [], last: index === entries.length - 1, stem: false });
    const s = entry.session;
    return sessionRow(state, {
      key: 'unfiled:' + identityOf(state, s.name), kind: 'unfiled', name: s.name, depth: 0, extraLabel: ', unfiled',
      age: sessionAge(state, s.name),
    });
  });
}

function section(state, id, label, children, extra) {
  const open = !state.collapsed.has(id);
  return { key: 'section:' + id, kind: 'section', id, label, ariaLabel: label, level: 1, open, extra: extra || null, children: open ? children() : [] };
}

// The whole sidebar: three sections, each with its rows, nested as the tree is.
export function sidebarModel(state) {
  const roots = childrenOf(state.nodes, null);
  const sections = [
    section(state, RECENTS_KEY, 'Recent', () => recentItems(state), 'recent-limit'),
    section(state, FOLDERS_KEY, 'Folders', () => folderItems(state, roots.filter((n) => n.kind === 'folder'), 0, [])),
    section(state, UNFILED_KEY, 'Unfiled, newest first', () => unfiledItems(state)),
  ];
  numberSiblings(sections);
  return { sections };
}

// aria-setsize and aria-posinset for every row, so a screen reader can say "3 of 7".
function numberSiblings(items) {
  items.forEach((item, index) => {
    item.setsize = items.length;
    item.posinset = index + 1;
    if (item.children?.length) numberSiblings(item.children);
  });
}

// Every row in the order the tree shows them, for tests and keyboard movement.
export function flatRows(model) {
  const out = [];
  const walk = (items) => {
    for (const item of items) {
      out.push(item);
      if (item.children?.length) walk(item.children);
    }
  };
  walk(model.sections);
  return out;
}
