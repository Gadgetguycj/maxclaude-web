const modulePath = process.argv[2];
const { listSessions } = await import(modulePath);
let markStarted;
const checkStarted = new Promise((resolve) => { markStarted = resolve; });
globalThis.__mcwResumabilityStarted = markStarted;
const result = await listSessions({ fresh: true });
if (!result.observedAt) throw new Error('status inventory omitted observedAt');
await Promise.race([
  checkStarted,
  new Promise((_, reject) => setImmediate(() => reject(new Error('resumability metadata check did not start')))),
]);
if (globalThis.__mcwResumabilityPending !== true) throw new Error('resumability metadata check did not start');
if (result.sessions.find((session) => session.name === 'metadata')?.resumable !== false) {
  throw new Error('pending resumability metadata changed the published status');
}
process.stdout.write('status inventory returned while resumability metadata remained pending\n');
