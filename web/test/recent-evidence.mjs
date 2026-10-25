// Synthetic activity order. The last background session is older than six idle sessions.
export const OBSERVED_20261002 = [
  ['session-c', 'busy'],
  ['session-b', 'background'],
  ['session-d', 'idle'],
  ['session-e', 'idle'],
  ['session-f', 'idle'],
  ['session-g', 'idle'],
  ['session-h', 'idle'],
  ['session-j', 'idle'],
  ['session-a', 'background'],
  ['session-k', 'idle'],
];

const BASE = Date.parse('2026-10-02T19:33:00.000Z');
export const ACTIVITY_20261002 = Object.fromEntries(OBSERVED_20261002.map(([name], index) => [name, BASE - index * 60000]));

// Green rows come first, ordered by name so tool events cannot reorder them. The rest are newest first.
export const EXPECTED_20261002 = [
  'session-a', 'session-b', 'session-c',
  'session-d', 'session-e', 'session-f', 'session-g', 'session-h', 'session-j',
  'session-k',
];

export const GREEN = new Set(['busy', 'background']);

// True when no row with another light sits above a green row.
export function greenFirst(rows) {
  let seenOther = false;
  for (const row of rows) {
    if (!GREEN.has(row.state)) seenOther = true;
    else if (seenOther) return false;
  }
  return true;
}
