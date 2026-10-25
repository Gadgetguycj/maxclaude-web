import fs from 'node:fs';

const modulePath = process.argv[2];
if (!modulePath) throw new Error('sessions module path is required');
process.stdout.write(`sessions module ${modulePath}\n`);
const { wakeSession } = await import(modulePath);
let failed = false;
try { await wakeSession({ name: 'demo' }); } catch { failed = true; }
if (!failed) throw new Error('the no-pane wake scenario must fail');
const metadata = fs.readFileSync(`${process.env.MCW_TEST_MAXAGENT_CFG}/sessions/demo.env`, 'utf8');
if (!/^MAXAGENT_HIDDEN=1$/m.test(metadata)) throw new Error('failed wake erased MAXAGENT_HIDDEN');
if (/^MAXAGENT_WAKING=/m.test(metadata)) throw new Error('failed wake left MAXAGENT_WAKING');
process.stdout.write('failed wake retains sleeping metadata\n');
