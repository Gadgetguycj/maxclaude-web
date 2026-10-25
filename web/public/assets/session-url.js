// The one mapping between a session and its address in the app. The hub serves the app shell
// for every path under SESSION_PREFIX, and the browser builds and reads session addresses only
// through this module. Paths are root-relative, so they follow whatever host serves the hub.

export const SESSION_PREFIX = '/s/';
export const SESSION_ROUTE = new RegExp(`^${SESSION_PREFIX}`);

// The address of a session, or null for a name that no path segment can carry. URL parsing
// removes "." and ".." as dot segments, and a lone UTF-16 surrogate has no UTF-8 encoding.
export function sessionPath(name) {
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..') return null;
  try {
    return SESSION_PREFIX + encodeURIComponent(name);
  } catch {
    return null;
  }
}

// What a path names. null is outside SESSION_PREFIX, { name } is a session address, and
// { invalid: true } is any other path under the prefix.
export function sessionFromPath(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith(SESSION_PREFIX)) return null;
  const segment = pathname.slice(SESSION_PREFIX.length);
  if (segment.includes('/')) return { invalid: true };
  let name;
  try {
    name = decodeURIComponent(segment);
  } catch {
    return { invalid: true };
  }
  return sessionPath(name) === null ? { invalid: true } : { name };
}
