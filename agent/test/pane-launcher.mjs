// Test-only engines record the launcher contract and model delayed process exit.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcw-pane-'));
const cfg = path.join(root, 'config'), directory = path.join(cfg, 'sessions');
const home = path.join(root, 'home');
fs.mkdirSync(path.join(home, '.local/bin'), {recursive:true});
fs.mkdirSync(directory, {recursive:true});
const installed = path.join(root, 'maxclaude-pane');
fs.copyFileSync(new URL('../../bin/maxclaude-pane', import.meta.url), installed);
fs.chmodSync(installed, 0o755);
const record = path.join(root, 'events');
const fixture = `#!${process.execPath}
const fs=require('fs');
const event=(type)=>fs.appendFileSync(process.env.LAUNCHER_TEST_RECORD,JSON.stringify({type,pid:process.pid,engine:require('path').basename(process.argv[1]),args:process.argv.slice(2),cwd:process.cwd(),org:process.env.MAXCLAUDE_ORG,sandbox:process.env.IS_SANDBOX,path:process.env.PATH,nested:['CLAUDECODE','CLAUDE_CODE_CHILD_SESSION','CLAUDE_CODE_SESSION_ID','CLAUDE_CODE_ENTRYPOINT','CLAUDE_CODE_EXECPATH','CLAUDE_EFFORT'].filter(k=>k in process.env)})+'\\n');
event('start');
const timer=setInterval(()=>{},1000);
process.on('SIGTERM',()=>{event('term');setTimeout(()=>{event('exit');clearInterval(timer);process.exit(0)},100)});
`;
for (const engine of ['claude','codex']) fs.writeFileSync(path.join(home,'.local/bin',engine),fixture,{mode:0o755});
const events = () => {try{return fs.readFileSync(record,'utf8').trim().split('\n').map(JSON.parse)}catch{return []}};
const wait = async (condition) => { const end=Date.now()+10000;while(Date.now()<end){if(condition())return;await new Promise(r=>setTimeout(r,10));}throw Error('launcher condition timed out'); };
const env = {...process.env,HOME:home,PATH:'/usr/bin:/bin',MAXROUTER_CONFIG_HOME:cfg,MCW_DEFAULT_WORKDIR:root,ZELLIJ_SESSION_NAME:'classic',LAUNCHER_TEST_RECORD:record,CLAUDECODE:'1',CLAUDE_CODE_CHILD_SESSION:'1',CLAUDE_CODE_SESSION_ID:'1',CLAUDE_CODE_ENTRYPOINT:'1',CLAUDE_CODE_EXECPATH:'1',CLAUDE_EFFORT:'high'};
let child;
async function stop() {if(!child)return;if(child.exitCode!==null||child.signalCode!==null){child=null;return;}const exit=once(child,'exit');child.kill('SIGTERM');await exit;child=null;}
try {
  child=spawn(installed,[],{env,stdio:'ignore'});
  await wait(()=>events().some(e=>e.type==='start'));
  const classic=events()[0];
  assert.equal(classic.cwd,root);assert.equal(classic.sandbox,'1');assert.deepEqual(classic.nested,[]);
  assert.equal(classic.path,home+'/.local/bin:/usr/bin:/bin');
  assert.deepEqual(classic.args,['--dangerously-skip-permissions','--remote-control=classic']);
  assert(!fs.existsSync(path.join(directory,'classic.env')));
  await stop();assert(!fs.existsSync(path.join(directory,'classic.env')));
  fs.writeFileSync(record,'');
  const file=path.join(directory,'scoped.env');
  const values='CUSTOM=a=b c\nMAXCLAUDE_WORKDIR=/does-not-exist\nMAXCLAUDE_ORG=org=a b\nMAXCLAUDE_RESUME_SID=saved\nMAXCLAUDE_SETTINGS=/a b\nMAXCLAUDE_APPEND_PROMPT=prompt=a b\nMAXCLAUDE_EXTRA_ARGS=--model opus\nMAXCLAUDE_HANDOFF_PROMPT=take over once\n';
  fs.writeFileSync(file,values);
  child=spawn(installed,[],{env:{...env,ZELLIJ_SESSION_NAME:'scoped'},stdio:'ignore'});
  await wait(()=>events().some(e=>e.type==='start'));
  assert.equal(events()[0].org,'org=a b');
  assert.deepEqual(events()[0].args,['--dangerously-skip-permissions','--remote-control=scoped','--resume','saved','--settings','/a b','--append-system-prompt','prompt=a b','--model','opus','take over once']);
  assert.equal(fs.readFileSync(file,'utf8'),values.replace('MAXCLAUDE_HANDOFF_PROMPT=take over once\n',''));
  // Rename ownership, then reuse the old name. Switching must follow the moved owner.
  const renamed=path.join(directory,'renamed.env');
  fs.renameSync(file,renamed);
  fs.renameSync(path.join(directory,'scoped.launchers'),path.join(directory,'renamed.launchers'));
  fs.writeFileSync(file,'MAXCLAUDE_ENGINE=claude\n');
  fs.appendFileSync(renamed,'MAXCLAUDE_ENGINE=codex\nMAXCLAUDE_CODEX_SID=codex-saved\n');
  child.kill('SIGUSR1');
  await wait(()=>events().filter(e=>e.type==='start').length===2);
  assert.deepEqual(events().map(e=>e.type),['start','term','exit','start']);
  const codex=events().at(-1);
  assert.equal(codex.engine,'codex');assert.deepEqual(codex.args.slice(0,5),['resume','codex-saved','--dangerously-bypass-approvals-and-sandbox','--cd',root]);
  assert(codex.args.includes('--dangerously-bypass-hook-trust'));
  assert(!codex.args.includes('take over once'));
  assert(codex.args.some(a=>a.includes(installed)&&a.includes('--record-codex')));
  assert.equal(fs.readFileSync(file,'utf8'),'MAXCLAUDE_ENGINE=claude\n');
  await stop();
  assert(!fs.existsSync(`/proc/${codex.pid}`));
  assert(!fs.existsSync(path.join(directory,'renamed.launchers')));
  assert(!fs.readFileSync(renamed,'utf8').includes('MAXCLAUDE_LAUNCHER_PID'));
  console.log('Bash launcher flags, env absence, rename, signals and exit ordering passed');
} finally {await stop();fs.rmSync(root,{recursive:true,force:true});}
