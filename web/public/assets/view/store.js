// The one store the page renders from. The hub's state read, the status lease and the user's
// actions change it only through the functions in this module or by setting a field and calling
// commit(). The views are functions of the state. Nothing here touches the DOM.

export function createState({ collapsed = [], now = Date.now() } = {}) {
  return {
    authed: false,
    // True once the first /api/state read has answered. Until then the agent's connection is not
    // known, so nothing may say it is down.
    loaded: false,
    agent: { connected: false },
    // Set while the agent is connected but its session list read fails: { since, last_good_at }.
    sessionsDegraded: null,
    // The agent's plan usage snapshot, and whether its panel is open.
    usage: null,
    usageOpen: false,
    stateError: null,
    nodes: [],
    // The host's session list, or null while the agent or hub is away.
    sessions: null,
    // The last session list the hub answered with. A session's creation time does not change
    // while the agent is away, so rows keep their order, age and leafless members from it.
    knownSessions: [],
    sessionStatus: {},
    statusAuthoritative: false,
    recents: [],
    recentLimit: 5,
    collapsed: new Set(collapsed),
    active: null,
    notice: null,
    waking: new Set(),
    // A view identity per session name. Rows outside a folder are keyed by it, and a rename this
    // browser starts carries it to the new name, so the row and its DOM node stay the same.
    identities: new Map(),
    nextIdentity: 1,
    // Renames this browser started: { from, to, confirmed }. Until the hub's tree and the host
    // agree on the new name, both names stand for one session.
    renames: [],
    menu: null,
    modals: [],
    nextModal: 1,
    // A tree drag: { source: row key, target: row key or null, mode: 'before' | 'after' | 'into' }.
    drag: null,
    now,
  };
}

export function createStore(state) {
  const listeners = new Set();
  return {
    state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    commit() {
      for (const listener of listeners) listener(state);
    },
  };
}

/* ---------- session identities ---------- */

function ensureIdentity(state, name) {
  if (typeof name !== 'string' || !name || state.identities.has(name)) return;
  state.identities.set(name, 's' + state.nextIdentity++);
}

export function identityOf(state, name) {
  return state.identities.get(name) || 'n:' + name;
}

function renameFor(state, name) {
  return state.renames.find((rename) => rename.from === name || rename.to === name) || null;
}

/* ---------- inputs ---------- */

// One /api/state answer.
export function applyServerState(state, data) {
  state.loaded = true;
  state.agent = data?.agent || { connected: false };
  state.sessionsDegraded = data?.sessions_degraded || null;
  if (data?.usage) state.usage = data.usage;
  state.nodes = Array.isArray(data?.tree) ? data.tree : [];
  state.sessions = Array.isArray(data?.sessions) ? data.sessions : null;
  // Without a session list the hub has no Recent to send. Recent keeps the rows it had, with
  // unknown lights, until the list is back.
  if (Array.isArray(state.sessions)) {
    state.knownSessions = state.sessions;
    state.recents = Array.isArray(data?.recents) ? data.recents : [];
  }
  state.recentLimit = [0, 3, 5, 10, 15].includes(Number(data?.recent_limit)) ? Number(data.recent_limit) : 5;
  state.stateError = null;
  for (const session of state.sessions || []) ensureIdentity(state, session?.name);
  for (const recent of state.recents) ensureIdentity(state, recent?.session_name);
  settleRenames(state);
  if (Array.isArray(state.sessions)) {
    const keep = new Set(state.sessions.map((session) => session?.name));
    for (const recent of state.recents) keep.add(recent?.session_name);
    for (const rename of state.renames) { keep.add(rename.from); keep.add(rename.to); }
    for (const name of [...state.identities.keys()]) if (!keep.has(name)) state.identities.delete(name);
  }
}

export function applyStateError(state, message) {
  state.loaded = true;
  state.stateError = message;
  state.agent = { connected: false };
  state.sessionsDegraded = null;
  state.sessions = null;
}

export function applyStatus(state, sessionStatus, authoritative) {
  state.sessionStatus = sessionStatus || {};
  state.statusAuthoritative = Boolean(authoritative);
}

/* ---------- a rename this browser started ---------- */

export function startRename(state, from, to) {
  ensureIdentity(state, from);
  state.renames = state.renames.filter((rename) => rename.from !== from && rename.to !== to);
  state.renames.push({ from, to, confirmed: false });
  state.identities.set(to, state.identities.get(from));
}

// The hub answered the rename. Its renamed leaf replaces the old one at once, so no read in
// between can show the old name as missing.
export function confirmRename(state, from, to, node) {
  const rename = state.renames.find((item) => item.from === from && item.to === to);
  if (rename) rename.confirmed = true;
  if (node?.id) state.nodes = state.nodes.map((item) => (item.id === node.id ? { ...item, ...node } : item));
  settleRenames(state);
}

export function abortRename(state, from, to) {
  state.renames = state.renames.filter((rename) => !(rename.from === from && rename.to === to));
  const listed = (state.sessions || []).some((session) => session?.name === to);
  if (!listed && state.identities.get(to) === state.identities.get(from)) state.identities.delete(to);
}

// A confirmed rename ends when nothing names the old session any more: no leaf and no session.
function settleRenames(state) {
  state.renames = state.renames.filter((rename) => {
    if (!rename.confirmed) return true;
    const leaf = state.nodes.some((node) => node.kind === 'session' && node.session_name === rename.from);
    const listed = !Array.isArray(state.sessions) || state.sessions.some((session) => session?.name === rename.from);
    if (leaf || listed) return true;
    if (state.identities.get(rename.from) === state.identities.get(rename.to)) state.identities.delete(rename.from);
    return false;
  });
}

export function renamePair(state, name) {
  return renameFor(state, name);
}

/* ---------- menus and dialogs ---------- */

export function openMenu(state, menu) {
  state.menu = menu;
}

export function closeMenu(state) {
  const menu = state.menu;
  state.menu = null;
  return menu;
}

export function pushModal(state, spec) {
  const modal = { id: state.nextModal++, spec };
  state.modals = state.modals.concat(modal);
  return modal.id;
}

export function removeModal(state, id) {
  state.modals = state.modals.filter((modal) => modal.id !== id);
}
