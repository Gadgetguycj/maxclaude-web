// Status snapshots are a single ordered stream even though they arrive over SSE and HTTP.
export class StatusLease {
  constructor({ now = () => performance.now(), schedule = (callback, delay) => setTimeout(callback, delay), cancel = (timer) => clearTimeout(timer), onChange = () => {} } = {}) {
    this.now = now;
    this.schedule = schedule;
    this.cancel = cancel;
    this.onChange = onChange;
    this.sessions = {};
    this.hasSnapshot = false;
    this.epoch = null;
    this.revision = -1;
    this.expiresAt = 0;
    this.timer = null;
  }

  apply(snapshot) {
    const meta = snapshot?.session_status_meta;
    const epoch = Number(meta?.connection_epoch);
    const revision = Number(meta?.revision);
    const leaseMs = Number(meta?.lease_ms);
    if (!Number.isSafeInteger(epoch) || epoch < 0 || !Number.isSafeInteger(revision) || revision < 0 || !Number.isFinite(leaseMs) || leaseMs < 0) return false;
    if (this.epoch !== null && (epoch < this.epoch || (epoch === this.epoch && revision <= this.revision))) return false;
    const sessions = snapshot?.session_status;
    if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) return false;
    this.epoch = epoch;
    this.revision = revision;
    this.sessions = sessions;
    this.hasSnapshot = true;
    this.expiresAt = this.now() + leaseMs;
    this.reschedule();
    this.onChange(this.sessions);
    return true;
  }

  reschedule() {
    if (this.timer !== null) this.cancel(this.timer);
    const delay = Math.max(0, this.expiresAt - this.now());
    const revision = this.revision;
    this.timer = this.schedule(() => {
      if (revision === this.revision) this.expire();
    }, delay);
  }

  expire() {
    if (this.expiresAt && this.now() < this.expiresAt) {
      this.reschedule();
      return false;
    }
    this.timer = null;
    this.expiresAt = 0;
    const expired = {};
    for (const [name, value] of Object.entries(this.sessions)) expired[name] = { ...value, state: 'unknown' };
    if (!Object.keys(expired).length) return false;
    this.sessions = expired;
    this.onChange(this.sessions);
    return true;
  }

  expireNow() {
    return this.expire();
  }
}

export function stateForSession(session, sessionStatus, waking, authoritative = true) {
  if (waking) return 'waking';
  if (!session) return 'unknown';
  if (session.exited) return 'exited';
  if (Object.prototype.hasOwnProperty.call(sessionStatus || {}, session.name)) {
    const activity = sessionStatus[session.name]?.state;
    return ['busy', 'background', 'idle', 'sleeping', 'absent', 'unknown'].includes(activity) ? activity : 'unknown';
  }
  if (authoritative) return 'unknown';
  if (session.sleeping) return 'sleeping';
  return ['busy', 'background', 'idle', 'sleeping', 'absent', 'unknown'].includes(session.activity) ? session.activity : 'unknown';
}
