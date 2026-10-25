// Plan usage for the header meters: parsing, fetching and the refresh schedule.
//
// The Claude answer below has the shape the OAuth usage endpoint returned on 2026-10-23, cut
// to the fields the agent reads plus neighbours it must ignore. Codex is driven through a real
// child process that speaks the app-server JSON-RPC lines.
//
//   node test/usage.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CLAUDE_USAGE_URL, RateLimited, Unavailable, UsageMonitor,
  fetchClaudeUsage, fetchCodexUsage, parseClaudeUsage, parseCodexLimits,
} from '../src/usage.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcw-usage-'));
const TOKEN = 'sk-test-oauth-token-that-must-never-leak';

const answer = {
  five_hour: { utilization: 36.0, resets_at: '2026-10-23T23:49:59.508060+00:00' },
  seven_day: { utilization: 20.0, resets_at: '2026-10-30T09:59:59.508084+00:00' },
  seven_day_opus: null,
  seven_day_sonnet: null,
  limits: [
    { kind: 'session', group: 'session', percent: 36, resets_at: '2026-10-23T23:49:59.508060+00:00', scope: null },
    { kind: 'weekly_all', group: 'weekly', percent: 20, resets_at: '2026-10-30T09:59:59.508084+00:00', scope: null },
    { kind: 'weekly_scoped', group: 'weekly', percent: 3, resets_at: '2026-10-30T09:59:59.508277+00:00', scope: { model: { id: null, display_name: 'Fable' }, surface: null } },
  ],
  weekly_scoped_shares: [{ limit_index: 2, used_percent_of_weekly: 2, allowance_percent_of_weekly: 50 }],
};

const results = [];
async function check(name, fn) {
  await fn();
  results.push(name);
  console.log(`ok    ${name}`);
}

try {
  await check('the Claude answer gives the weekly, 5-hour and Fable weekly windows', () => {
    const parsed = parseClaudeUsage(answer, ['Fable']);
    assert.deepEqual(parsed.week, { percent: 20, resetsAt: Date.parse('2026-10-30T09:59:59.508084+00:00') });
    assert.deepEqual(parsed.fiveHour, { percent: 36, resetsAt: Date.parse('2026-10-23T23:49:59.508060+00:00') });
    assert.deepEqual(parsed.models, { Fable: { percent: 3, resetsAt: Date.parse('2026-10-30T09:59:59.508277+00:00') } });
  });

  await check('a model without its own window is null, never a made-up number', () => {
    const parsed = parseClaudeUsage({ ...answer, limits: answer.limits.slice(0, 2) }, ['Fable', 'Other']);
    assert.deepEqual(parsed.models, { Fable: null, Other: null });
  });

  await check('the limits list stands in when the five_hour and seven_day objects are missing', () => {
    const parsed = parseClaudeUsage({ limits: answer.limits }, []);
    assert.equal(parsed.fiveHour.percent, 36);
    assert.equal(parsed.week.percent, 20);
    assert.deepEqual(parseClaudeUsage({}, ['Fable']), { fiveHour: null, week: null, models: { Fable: null } });
  });

  await check('Codex uses the 10080-minute window, primary or secondary', () => {
    assert.deepEqual(parseCodexLimits({ rateLimits: { primary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1793387702 }, secondary: null } }),
      { week: { percent: 0, resetsAt: 1793387702000 } });
    assert.deepEqual(parseCodexLimits({ rateLimits: { primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: 1 }, secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 2 } } }),
      { week: { percent: 12, resetsAt: 2000 } });
    assert.deepEqual(parseCodexLimits({ rateLimits: { primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: 1 } } }), { week: null });
  });

  const credentials = path.join(root, '.credentials.json');
  const writeLogin = (expiresAt) => fs.writeFileSync(credentials, JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, expiresAt } }));

  await check('the Claude request carries the token only in its Authorization header', async () => {
    writeLogin(Date.now() + 3600000);
    const seen = [];
    const parsed = await fetchClaudeUsage({
      credentialsFile: credentials, models: ['Fable'],
      get: async (url, headers) => { seen.push({ url, headers }); return { status: 200, headers: {}, body: JSON.stringify(answer) }; },
    });
    assert.equal(parsed.models.Fable.percent, 3);
    assert.equal(seen[0].url, CLAUDE_USAGE_URL);
    assert.equal(seen[0].headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(seen[0].headers['anthropic-beta'], 'oauth-2025-04-20');
  });

  await check('a 429 is RateLimited with its Retry-After, and no error names the token', async () => {
    writeLogin(Date.now() + 3600000);
    const limited = await fetchClaudeUsage({ credentialsFile: credentials, get: async () => ({ status: 429, headers: { 'retry-after': '120' }, body: '{}' }) })
      .then(() => null, (error) => error);
    assert.ok(limited instanceof RateLimited);
    assert.equal(limited.retryAfterMs, 120000);
    const failures = [
      await fetchClaudeUsage({ credentialsFile: credentials, get: async () => ({ status: 401, headers: {}, body: 'no' }) }).catch((e) => e),
      await fetchClaudeUsage({ credentialsFile: credentials, get: async () => ({ status: 200, headers: {}, body: 'not json' }) }).catch((e) => e),
      await fetchClaudeUsage({ credentialsFile: credentials, get: async () => { throw new Error('usage request failed: ECONNRESET'); } }).catch((e) => e),
    ];
    writeLogin(Date.now() - 1000);
    failures.push(await fetchClaudeUsage({ credentialsFile: credentials, get: async () => assert.fail('an expired token was sent') }).catch((e) => e));
    failures.push(await fetchClaudeUsage({ credentialsFile: path.join(root, 'missing.json') }).catch((e) => e));
    assert.match(failures[0].message, /HTTP 401/);
    assert.match(failures[3].message, /expired/);
    assert.ok(failures[4] instanceof Unavailable);
    for (const failure of [limited, ...failures]) assert.ok(!String(failure.message).includes(TOKEN) && !String(failure.stack).includes(TOKEN));
  });

  // A stand-in for `codex app-server`: newline-delimited JSON-RPC on stdin and stdout.
  const fakeCodex = (mode) => {
    const file = path.join(root, `codex-${mode}`);
    fs.writeFileSync(file, `#!/usr/bin/env node
const mode = ${JSON.stringify(mode)};
if (process.argv[2] !== 'app-server') process.exit(2);
let buffer = '';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
send({ jsonrpc: '2.0', method: 'remoteControl/status/changed', params: {} });
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let i; (i = buffer.indexOf('\\n')) >= 0;) {
    const message = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    if (mode === 'silent') continue;
    if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake' } });
    if (message.method === 'account/rateLimits/read') {
      if (mode === 'error') send({ id: message.id, error: { code: -32000, message: 'not logged in' } });
      else send({ id: message.id, result: { rateLimits: { primary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: 1793387702 }, secondary: null } } });
    }
  }
});
setInterval(() => {}, 1000);
`, { mode: 0o755 });
    return file;
  };

  await check('codex app-server answers account/rateLimits/read with the weekly window', async () => {
    assert.deepEqual(await fetchCodexUsage({ bin: fakeCodex('ok'), timeoutMs: 5000 }), { week: { percent: 7, resetsAt: 1793387702000 } });
  });

  await check('a silent, failing or missing codex is an error, and the child is stopped', async () => {
    const silent = await fetchCodexUsage({ bin: fakeCodex('silent'), timeoutMs: 500 }).catch((e) => e);
    assert.match(silent.message, /did not answer within 500 ms/);
    const refused = await fetchCodexUsage({ bin: fakeCodex('error'), timeoutMs: 5000 }).catch((e) => e);
    assert.match(refused.message, /not logged in/);
    const missing = await fetchCodexUsage({ bin: path.join(root, 'no-codex-here'), timeoutMs: 5000 }).catch((e) => e);
    assert.ok(missing instanceof Unavailable);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const leftovers = fs.readdirSync('/proc').filter((pid) => /^\d+$/.test(pid)).filter((pid) => {
      try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(path.join(root, 'codex-')); } catch { return false; }
    });
    assert.deepEqual(leftovers, [], 'a codex app-server child outlived its request');
  });

  // The schedule, with a clock and timers the test controls.
  function harness({ claude, codex }) {
    const clock = { now: 1_000_000 };
    const timers = [];
    const published = [];
    const monitor = new UsageMonitor({
      publish: (snapshot) => published.push(snapshot),
      fetchClaude: claude,
      fetchCodex: codex,
      models: ['Fable'],
      minIntervalMs: 60000,
      periodMs: 300000,
      now: () => clock.now,
      setTimer: (fn, ms) => { const timer = { fn, at: clock.now + ms, done: false }; timers.push(timer); return timer; },
      clearTimer: (timer) => { timer.done = true; },
    });
    const advance = async (ms) => {
      clock.now += ms;
      for (const timer of timers) if (!timer.done && timer.at <= clock.now) { timer.done = true; timer.fn(); }
      await new Promise((resolve) => setImmediate(resolve));
    };
    return { monitor, clock, timers, published, advance };
  }
  const meters = (snapshot) => Object.fromEntries(snapshot.meters.map((meter) => [meter.key, meter]));
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  await check('refreshes run at most once a minute, and a request inside the minute runs when it ends', async () => {
    let codexCalls = 0;
    const h = harness({
      claude: async () => parseClaudeUsage(answer, ['Fable']),
      codex: async () => { codexCalls += 1; return { week: { percent: 0, resetsAt: 1793387702000 } }; },
    });
    h.monitor.request('start');
    await settle();
    assert.equal(h.published.length, 1);
    assert.equal(codexCalls, 1);
    await h.advance(10000);
    h.monitor.request('session status changed');
    h.monitor.request('session status changed');
    await settle();
    assert.equal(h.published.length, 1, 'a request 10 s after a refresh ran at once');
    assert.equal(h.timers.filter((timer) => !timer.done).length, 1, 'two requests queued two refreshes');
    await h.advance(49000);
    assert.equal(h.published.length, 1, 'the queued refresh ran early');
    await h.advance(1000);
    await settle();
    assert.equal(h.published.length, 2, 'the queued refresh did not run when the minute ended');
    assert.equal(codexCalls, 2);
    await h.advance(60000);
    h.monitor.request('timer');
    await settle();
    assert.equal(h.published.length, 3, 'a request after the minute ran at once');
  });

  await check('Claude is asked at most every 2 minutes, Codex every minute, and a skipped ask is not stale', async () => {
    let claudeCalls = 0;
    let codexCalls = 0;
    const h = harness({
      claude: async () => { claudeCalls += 1; return parseClaudeUsage(answer, ['Fable']); },
      codex: async () => { codexCalls += 1; return { week: { percent: 0, resetsAt: 1793387702000 } }; },
    });
    for (let minute = 0; minute <= 4; minute += 1) {
      if (minute) await h.advance(60000);
      h.monitor.request('timer');
      await settle();
    }
    assert.equal(codexCalls, 5);
    assert.equal(claudeCalls, 3, 'Claude was asked more often than every 2 minutes');
    assert.equal(h.published.length, 5);
    assert.ok(h.published.every((snapshot) => snapshot.meters.every((meter) => !meter.stale)), 'a skipped ask marked values stale');
  });

  await check('a 429 keeps the last Claude values stale, doubles the wait each time up to 5 minutes, and honours Retry-After', async () => {
    let mode = 'ok';
    const asked = [];
    const h = harness({
      claude: async () => {
        asked.push(h.clock.now);
        if (mode === '429') throw new RateLimited(null);
        if (mode === '429-long') throw new RateLimited(600000);
        return parseClaudeUsage(answer, ['Fable']);
      },
      codex: async () => ({ week: { percent: 4, resetsAt: 1793387702000 } }),
    });
    const start = h.clock.now;
    const minute = async () => { await h.advance(60000); h.monitor.request('timer'); await settle(); };
    h.monitor.request('start');
    await settle();
    mode = '429';
    for (let i = 0; i < 12; i += 1) await minute();
    const gaps = asked.map((at) => (at - start) / 60000);
    // Asked at 0, then every 2 minutes until the 429 at 2, then after 4 more, then 5, then 5.
    assert.deepEqual(gaps, [0, 2, 6, 11], `asked at minutes ${gaps}`);
    let shown = meters(h.published.at(-1));
    assert.equal(shown['claude-week'].percent, 20);
    assert.equal(shown['claude-week'].stale, true);
    assert.equal(shown['model-fable'].percent, 3);
    assert.match(shown['claude-week'].error, /rate limiting/);
    assert.equal(shown['codex-week'].stale, false, 'Codex is not stale because Claude failed');
    mode = 'ok';
    for (let i = 0; i < 5; i += 1) await minute();
    shown = meters(h.published.at(-1));
    assert.equal(shown['claude-week'].stale, false);
    assert.equal(shown['claude-week'].error, null);
    assert.equal(asked.at(-1) - asked.at(-2), 300000, 'the wait after three 429s was not 5 minutes');
    // A success resets the wait to 2 minutes. A Retry-After longer than the backoff wins.
    const resetAt = asked.length;
    for (let i = 0; i < 2; i += 1) await minute();
    assert.equal(asked.length, resetAt + 1, 'after a success Claude was not asked again within 2 minutes');
    mode = '429-long';
    const beforeLong = asked.length;
    while (asked.length === beforeLong) await minute();
    const longAt = asked.at(-1);
    for (let i = 0; i < 9; i += 1) await minute();
    assert.equal(asked.length, beforeLong + 1, 'Claude was asked inside a 10-minute Retry-After');
    await minute();
    assert.equal(asked.length, beforeLong + 2);
    assert.equal(asked.at(-1) - longAt, 600000);
  });

  await check('a window the answer lacks is unavailable with the reason, and a source that never answered says why', async () => {
    const h = harness({
      claude: async () => parseClaudeUsage({ ...answer, limits: answer.limits.slice(0, 2) }, ['Fable']),
      codex: async () => { throw new Unavailable('codex is not installed on this host'); },
    });
    h.monitor.request('start');
    await settle();
    const shown = meters(h.published.at(-1));
    assert.deepEqual(Object.keys(shown), ['claude-week', 'claude-5h', 'model-fable', 'codex-week']);
    assert.equal(shown['model-fable'].available, false);
    assert.equal(shown['model-fable'].percent, null);
    assert.equal(shown['model-fable'].error, 'the usage answer has no weekly window for Fable');
    assert.equal(shown['codex-week'].available, false);
    assert.equal(shown['codex-week'].error, 'codex is not installed on this host');
    assert.equal(shown['claude-week'].available, true);
  });

  await check('before the first answer every meter is unavailable, never zero', () => {
    const h = harness({ claude: async () => assert.fail(), codex: async () => assert.fail() });
    for (const meter of h.monitor.snapshot().meters) {
      assert.equal(meter.percent, null);
      assert.equal(meter.available, false);
      assert.equal(meter.error, 'not fetched yet');
    }
  });

  console.log(`\n${results.length} checks passed`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
