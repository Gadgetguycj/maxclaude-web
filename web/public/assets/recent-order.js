// The Recent order. The hub's /api/state and the browser's live re-sort both import this module,
// so a reload shows the same order as the open page.
import { stateForSession } from './status-lease.js';

// Rows group by their light: green (busy or background), then idle, then sleeping, then no
// Claude process or unknown. A waking session is a sleeping one that this browser is opening.
const GROUP = { busy: 0, background: 0, idle: 1, sleeping: 2, waking: 2 };

export function recentGroup(state) {
  return Object.prototype.hasOwnProperty.call(GROUP, state) ? GROUP[state] : 3;
}

// The retained status snapshot is canonical for a session it lists. The session list's own value
// is the fallback before the first snapshot.
export function recentActivityAt(session, sessionStatus) {
  const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const status = sessionStatus[session.name] || {};
  const statusActivity = has(status, 'lastActivityAt')
    ? Number(status.lastActivityAt) || 0
    : (Number(status.updatedAt) || Number(status.lastResponseAt) || 0);
  const sessionActivity = has(session, 'lastActivityAt')
    ? Number(session.lastActivityAt) || 0
    : (Number(session.activityUpdatedAt) || Number(session.lastResponseAt) || 0);
  return Math.max(0, has(sessionStatus, session.name) ? statusActivity : sessionActivity);
}

// Inside the green group the order is by name. A working session's only time is its last event,
// which moves on every tool call, so ordering green rows by time would reorder them all the time.
// A row therefore moves only when it changes group, or when a session appears or goes. Every other
// group is newest first, ties by name. The count controls viewport height; only Off removes rows.
export function compareActivity(left, right) {
  return right.last_activity_at - left.last_activity_at
    || left.session_name.localeCompare(right.session_name);
}

export function compareRecents(left, right) {
  const group = recentGroup(left.state) - recentGroup(right.state);
  if (group) return group;
  if (recentGroup(left.state) === 0) return left.session_name.localeCompare(right.session_name);
  return compareActivity(left, right);
}

export function orderRecents(sessions, sessionStatus, limit, { waking = null, authoritative = true } = {}) {
  if (!limit) return [];
  const status = sessionStatus || {};
  return (Array.isArray(sessions) ? sessions : [])
    .filter((session) => session && session.name && !session.exited)
    .map((session) => ({
      session_name: session.name,
      last_activity_at: recentActivityAt(session, status),
      state: stateForSession(session, status, Boolean(waking && waking.has(session.name)), authoritative),
    }))
    .sort(compareRecents);
}
