// Plan usage for the page header: Claude's weekly and 5-hour windows, a weekly window per
// configured model, and Codex's weekly window. Claude's numbers come from the OAuth usage
// endpoint with the login Claude Code stores. Codex's come from `codex app-server`. Neither
// call spends a model request. The OAuth token is sent only in the request header. It is never
// put on a command line or in a log line or an error.
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { log } from './log.js';

export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const WEEK_MINUTES = 7 * 24 * 60;
const REQUEST_TIMEOUT_MS = 10000;
const MAX_BODY_BYTES = 1024 * 1024;

export class Unavailable extends Error {}

function finite(value) {
  const number = Number(value);
  return value !== null && value !== undefined && value !== '' && Number.isFinite(number) ? number : null;
}

function timeOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function windowOf(percent, resetsAt) {
  const value = finite(percent);
  return value === null ? null : { percent: value, resetsAt: timeOf(resetsAt) };
}

// The usage answer names windows two ways: five_hour and seven_day objects with a utilization,
// and a limits list with a kind and a percent. A model's own weekly window is only in the list.
export function parseClaudeUsage(body, models = config.usageModels) {
  const limits = Array.isArray(body?.limits) ? body.limits : [];
  const limit = (kind) => limits.find((entry) => entry?.kind === kind) || null;
  const fromLimit = (entry) => (entry ? windowOf(entry.percent, entry.resets_at) : null);
  const fiveHour = windowOf(body?.five_hour?.utilization, body?.five_hour?.resets_at) || fromLimit(limit('session'));
  const week = windowOf(body?.seven_day?.utilization, body?.seven_day?.resets_at) || fromLimit(limit('weekly_all'));
  const byModel = {};
  for (const name of models) {
    const wanted = name.toLowerCase();
    const entry = limits.find((candidate) => candidate?.kind === 'weekly_scoped'
      && `${candidate?.scope?.model?.display_name || ''}`.toLowerCase() === wanted);
    byModel[name] = fromLimit(entry);
  }
  return { fiveHour, week, models: byModel };
}

// account/rateLimits/read answers with a primary and a secondary window. The weekly one is the
// window whose length is 10080 minutes. Its reset time is in seconds.
export function parseCodexLimits(result) {
  const limits = result?.rateLimits;
  for (const key of ['primary', 'secondary']) {
    const window = limits?.[key];
    if (window && Number(window.windowDurationMins) === WEEK_MINUTES) {
      const resetsAt = finite(window.resetsAt);
      return { week: windowOf(window.usedPercent, resetsAt === null ? null : resetsAt * 1000) };
    }
  }
  return { week: null };
}

function readClaudeToken(file) {
  let oauth;
  try {
    oauth = JSON.parse(fs.readFileSync(file, 'utf8'))?.claudeAiOauth;
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Unavailable('Claude Code is not logged in on this host');
    throw new Error('the Claude login file could not be read');
  }
  if (typeof oauth?.accessToken !== 'string' || !oauth.accessToken) throw new Unavailable('Claude Code is not logged in on this host');
  if (Number(oauth.expiresAt) && Number(oauth.expiresAt) < Date.now()) throw new Error('the Claude login token has expired');
  return oauth.accessToken;
}

export function httpsGetJson(url, headers, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers, timeout: timeoutMs }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) request.destroy(new Error('the usage answer is too large'));
        else chunks.push(chunk);
      });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', (error) => reject(new Error(`the usage answer broke off: ${error.code || error.message}`)));
    });
    request.on('timeout', () => request.destroy(new Error(`no usage answer within ${timeoutMs} ms`)));
    request.on('error', (error) => reject(new Error(error.code ? `usage request failed: ${error.code}` : error.message)));
  });
}

export class RateLimited extends Error {
  constructor(retryAfterMs) {
    super('the usage endpoint is rate limiting');
    this.retryAfterMs = retryAfterMs;
  }
}

export async function fetchClaudeUsage({
  credentialsFile = path.join(config.claudeConfigDir, '.credentials.json'),
  get = httpsGetJson,
  models = config.usageModels,
} = {}) {
  const token = readClaudeToken(credentialsFile);
  const answer = await get(CLAUDE_USAGE_URL, {
    Authorization: `Bearer ${token}`,
    'anthropic-beta': 'oauth-2025-04-20',
    'user-agent': config.version,
    accept: 'application/json',
  });
  if (answer.status === 429) {
    const seconds = finite(answer.headers?.['retry-after']);
    throw new RateLimited(seconds === null ? null : seconds * 1000);
  }
  if (answer.status !== 200) throw new Error(`the usage endpoint answered HTTP ${answer.status}`);
  let body;
  try { body = JSON.parse(answer.body); } catch { throw new Error('the usage endpoint answered with something other than JSON'); }
  return parseClaudeUsage(body, models);
}

export function fetchCodexUsage({ bin = config.codexBin, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let buffer = '';
    const stop = () => {
      if (!child?.pid) return;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      }, 2000).unref();
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`codex app-server did not answer within ${timeoutMs} ms`)), timeoutMs);
    const send = (message) => {
      if (child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    try {
      child = spawn(bin, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'], detached: true });
    } catch (error) {
      finish(error);
      return;
    }
    child.on('error', (error) => finish(error.code === 'ENOENT' ? new Unavailable('codex is not installed on this host') : error));
    child.on('exit', (code, signal) => finish(new Error(`codex app-server exited (${signal || code}) before it answered`)));
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_BODY_BYTES) return finish(new Error('codex app-server sent too much output'));
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message?.id === 1) {
          if (message.error) return finish(new Error('codex app-server refused to start a session'));
          send({ jsonrpc: '2.0', method: 'initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } });
        } else if (message?.id === 2) {
          if (message.error) return finish(new Error(`codex rate limits: ${message.error.message || 'error'}`));
          return finish(null, parseCodexLimits(message.result));
        }
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'mcw-agent', version: config.version } } });
  });
}

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'model';
}

// One source's last answer. A failed fetch keeps the last values and marks them stale.
function emptySource() {
  return { value: null, fetchedAt: null, error: null, notBefore: 0, backoffMs: 0 };
}

// A run inside this margin of a source's next allowed time still asks it, so timer jitter
// does not push the ask to the run after.
const SPACING_SLACK_MS = 1000;

export class UsageMonitor {
  constructor({
    publish,
    fetchClaude = () => fetchClaudeUsage(),
    fetchCodex = () => fetchCodexUsage(),
    models = config.usageModels,
    minIntervalMs = config.usageMinIntervalMs,
    claudeSpacingMs = config.usageClaudeSpacingMs,
    periodMs = config.usagePeriodMs,
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }) {
    this.publish = publish;
    this.fetchClaude = fetchClaude;
    this.fetchCodex = fetchCodex;
    this.models = models;
    this.minIntervalMs = minIntervalMs;
    this.claudeSpacingMs = claudeSpacingMs;
    this.periodMs = periodMs;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.claude = emptySource();
    this.codex = emptySource();
    this.lastStartedAt = null;
    this.running = null;
    this.trailing = null;
    this.periodic = null;
    this.updatedAt = null;
  }

  start() {
    this.request('start');
    this.periodic = setInterval(() => this.request('timer'), this.periodMs);
    this.periodic.unref?.();
  }

  stop() {
    clearInterval(this.periodic);
    if (this.trailing) this.clearTimer(this.trailing);
    this.trailing = null;
  }

  // Asks for a refresh. At most one runs per minIntervalMs. A request inside that window runs
  // once when the window ends, so a status change is never dropped, only delayed.
  request(reason) {
    if (this.running) {
      this.pendingReason = this.pendingReason || reason;
      return;
    }
    const wait = this.lastStartedAt === null ? 0 : this.lastStartedAt + this.minIntervalMs - this.now();
    if (wait <= 0) {
      this.run(reason);
      return;
    }
    if (!this.trailing) {
      this.trailing = this.setTimer(() => {
        this.trailing = null;
        this.request(reason);
      }, wait);
      this.trailing.unref?.();
    }
  }

  async run(reason) {
    this.lastStartedAt = this.now();
    this.pendingReason = null;
    this.running = Promise.all([
      this.#refresh(this.claude, this.fetchClaude, 'claude', this.claudeSpacingMs),
      this.#refresh(this.codex, this.fetchCodex, 'codex', this.minIntervalMs),
    ]);
    try {
      await this.running;
    } finally {
      this.running = null;
    }
    this.updatedAt = this.now();
    log.info('usage refreshed', { reason, ...this.summary() });
    this.publish?.(this.snapshot());
    if (this.pendingReason) this.request(this.pendingReason);
  }

  // A source is asked at most once per spacingMs. Before then it keeps its last answer, and
  // its last error, unchanged. Each 429 in a row doubles the wait, up to the slow timer's
  // period, because a 429 asked again a minute later is answered with another 429.
  async #refresh(source, fetcher, name, spacingMs) {
    const at = this.now();
    if (source.notBefore > at + SPACING_SLACK_MS) return;
    try {
      const value = await fetcher();
      source.value = value;
      source.fetchedAt = this.now();
      source.error = null;
      source.backoffMs = 0;
      source.notBefore = at + spacingMs;
    } catch (error) {
      source.error = String(error?.message || error);
      if (error instanceof RateLimited) {
        source.backoffMs = Math.min(this.periodMs, source.backoffMs ? source.backoffMs * 2 : spacingMs * 2);
        source.notBefore = at + Math.max(source.backoffMs, error.retryAfterMs || 0);
      } else {
        source.notBefore = at + spacingMs;
      }
      log.warn('usage fetch failed', { source: name, error: source.error, nextTryInMs: source.notBefore - at });
    }
  }

  summary() {
    const out = {};
    for (const meter of this.snapshot().meters) out[meter.key] = meter.percent === null ? (meter.available ? 'none' : 'unavailable') : `${meter.percent}${meter.stale ? ' stale' : ''}`;
    return out;
  }

  // A meter shows the window from the source's last good answer. When the latest fetch failed,
  // those values are stale. Without any answer, or with an answer that lacks the window, the
  // meter is unavailable and says why.
  meter(key, label, title, source, window, missing) {
    const answered = source.fetchedAt !== null;
    let error = source.error;
    if (!error && answered && !window) error = missing;
    if (!error && !answered) error = 'not fetched yet';
    return {
      key,
      label,
      title,
      percent: window ? window.percent : null,
      resetsAt: window ? window.resetsAt : null,
      available: Boolean(window),
      stale: Boolean(window) && source.error !== null,
      fetchedAt: source.fetchedAt,
      error,
    };
  }

  snapshot() {
    const claude = this.claude.value;
    const codex = this.codex.value;
    return {
      updatedAt: this.updatedAt,
      meters: [
        this.meter('claude-week', 'Claude', 'Claude weekly, all models', this.claude, claude?.week, 'the usage answer has no weekly window'),
        this.meter('claude-5h', '5h', 'Claude 5-hour', this.claude, claude?.fiveHour, 'the usage answer has no 5-hour window'),
        ...this.models.map((name) => this.meter(`model-${slug(name)}`, name, `${name} weekly`, this.claude, claude?.models?.[name],
          `the usage answer has no weekly window for ${name}`)),
        this.meter('codex-week', 'Codex', 'Codex weekly', this.codex, codex?.week, 'codex reports no weekly window'),
      ],
    };
  }
}
