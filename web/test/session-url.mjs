// Unit test for the session address mapping that the hub and the browser both import.
//
//   node test/session-url.mjs
import assert from 'node:assert/strict';
import { SESSION_PREFIX, SESSION_ROUTE, sessionFromPath, sessionPath } from '../public/assets/session-url.js';

// The browser hands the app location.pathname, which is the path after URL parsing. Node's URL
// class implements the same WHATWG parser.
function browserPath(path, base = 'https://your-host.example.com/s/elsewhere') {
  return new URL(path, base).pathname;
}

function roundTrip(name) {
  const path = sessionPath(name);
  assert.ok(path, `${JSON.stringify(name)} has an address`);
  assert.ok(path.startsWith(SESSION_PREFIX), `${path} is under ${SESSION_PREFIX}`);
  const parsed = browserPath(path);
  assert.deepEqual(sessionFromPath(parsed), { name }, `${JSON.stringify(name)} comes back from ${parsed}`);
  return path;
}

const examples = [
  ['alpha', '/s/alpha'],
  ['beta.dev', '/s/beta.dev'],
  ['gamma-2', '/s/gamma-2'],
  ['under_score', '/s/under_score'],
  ['session-c', '/s/session-c'],
  ['...', '/s/...'],
  ['.hidden', '/s/.hidden'],
  ['a b', '/s/a%20b'],
  [' leading and trailing ', '/s/%20leading%20and%20trailing%20'],
  ['café', '/s/caf%C3%A9'],
  ['日本語', '/s/%E6%97%A5%E6%9C%AC%E8%AA%9E'],
  ['🙂', '/s/%F0%9F%99%82'],
  ['100%', '/s/100%25'],
  ['%41', '/s/%2541'],
  ['a/b', '/s/a%2Fb'],
  ['q?x#y', '/s/q%3Fx%23y'],
  ['a+b&c=d', '/s/a%2Bb%26c%3Dd'],
  ['s', '/s/s'],
  ['t', '/s/t'],
  ['api', '/s/api'],
  ['assets', '/s/assets'],
  ['agent', '/s/agent'],
];
for (const [name, path] of examples) assert.equal(roundTrip(name), path);

// A seeded generator covers mixes the table does not.
let seed = 0x5eed;
function random(n) {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
}
const alphabet = [
  ...'abcXYZ019', '.', '-', '_', ' ', '%', '/', '?', '#', '&', '+', ':', '@', '=', ';', ',', '~', '!', '*', "'", '(', ')',
  '\\', '"', '<', '>', '`', '\t', 'é', 'ß', 'ж', '中', '‍', ' ', '🙂', '𝄞',
];
let generated = 0;
for (let i = 0; i < 5000; i += 1) {
  const length = 1 + random(12);
  let name = '';
  for (let j = 0; j < length; j += 1) name += alphabet[random(alphabet.length)];
  if (name === '.' || name === '..') continue;
  roundTrip(name);
  generated += 1;
}
assert.ok(generated > 4900);

// Addresses are root-relative, so they resolve against whatever host serves the hub.
assert.equal(new URL(sessionPath('alpha'), 'http://127.0.0.1:8080/s/other').href, 'http://127.0.0.1:8080/s/alpha');
assert.equal(new URL(sessionPath('alpha'), 'https://hub.example/').href, 'https://hub.example/s/alpha');

// Names no single path segment can carry have no address.
for (const name of ['', '.', '..', '\uD800', 'a\uDC00', null, undefined, 42]) {
  assert.equal(sessionPath(name), null, `${JSON.stringify(name)} has no address`);
}

// Paths outside the prefix are not session addresses. /s alone is zellij's path for a session
// named s, so it stays a terminal path.
for (const path of ['/', '/index.html', '/s', '/sx', '/S/alpha', '/t/alpha', '/alpha', '/api/state', '/assets/session-url.js', '/agent']) {
  assert.equal(sessionFromPath(path), null, `${path} is not a session address`);
}

// Every other path under the prefix is an invalid address, never a guess.
for (const path of ['/s/', '/s/a/b', '/s/alpha/', '/s/%E0%A4%A', '/s/%', '/s/%ZZ', '/s/.', '/s/..', '/s/%2e%2e', '/s/%2E', '/s/%ED%A0%80']) {
  assert.deepEqual(sessionFromPath(path), { invalid: true }, `${path} is invalid`);
}

// Forms a person can paste or a browser can produce still name the session.
assert.deepEqual(sessionFromPath('/s/a:b'), { name: 'a:b' });
assert.deepEqual(sessionFromPath('/s/caf%c3%a9'), { name: 'café' });
assert.deepEqual(sessionFromPath(browserPath('/s/a b')), { name: 'a b' });
assert.deepEqual(sessionFromPath(browserPath('/s/café')), { name: 'café' });
assert.deepEqual(sessionFromPath(browserPath('/s/alpha?x=1#frag')), { name: 'alpha' });
assert.deepEqual(sessionFromPath(browserPath('/s/x/../alpha')), { name: 'alpha' });

// The hub route owns exactly the prefix.
for (const path of ['/s/', '/s/alpha', '/s/a/b', '/s/%E0%A4%A']) assert.ok(SESSION_ROUTE.test(path), `${path} is a hub route`);
for (const path of ['/s', '/S/alpha', '/sx/alpha', '/assets/s/x', '/t/s/x', '/api/s/x', '/', '/alpha']) {
  assert.ok(!SESSION_ROUTE.test(path), `${path} is not a hub route`);
}

console.log(`session addresses: ${examples.length} examples and ${generated} generated names round-trip, invalid and foreign paths refused: PASS`);
