export async function resolve(specifier, context, nextResolve) {
  const stubs = {
    './config.js': `export const config={maxagentCfg:process.env.MCW_TEST_MAXAGENT_CFG,maxclaudeCfg:process.env.MCW_TEST_MAXCLAUDE_CFG,claudeConfigDir:process.env.MCW_TEST_CLAUDE_CFG,zellijBin:'zellij',maxclaudeBin:'maxclaude',createWaitMs:20,autoHibernateHours:0,statusSourceLeaseMs:5000,statusWatchMs:1000};`,
    './exec.js': `const pending=process.env.MCW_TEST_RESUMABLE_PENDING==='1'; export async function run(command){if(command==='systemctl'&&pending){globalThis.__mcwResumabilityPending=true;globalThis.__mcwResumabilityStarted?.();return new Promise(()=>{})} return {code:0,stdout:command==='zellij'?'demo [Created 0s ago]\\nmetadata [Created 0s ago]\\n':command==='systemctl'?'loaded\\nactive\\n':'',stderr:''}} export async function runOrThrow(command,args){return {code:0,stdout:command==='systemd-escape'?'metadata\\n':'',stderr:''}} export function stripAnsi(v){return v}`,
    './errors.js': `export class RpcError extends Error { constructor(code,message,detail){super(message);this.code=code;this.detail=detail} }`,
    './log.js': `export const log={info(){},warn(){}}`,
    './status.js': `const panes=new Map([['metadata\\0'+'0',{session:'metadata',pane:'0',pids:[42]}]]); export function collectSessionActivity(){return {}} export function hiddenSessionActivity(){return {lastActivityAt:0,lastResponseAt:0}} export function readLiveClaudePanes(){return panes} export function readSessionProcessSnapshot(){return {claudePanes:panes}}`,
    './viewers.js': `export function viewerCount(){return 0} export function reserveViewer(){return 'lease'} export function releaseViewerLease(){return true}`,
    './zellijconfig.js': `export function readWebSharing(){return 'on'}`,
    './zellijweb.js': `export async function webStatus(){return {online:true}}`,
  };
  if (Object.hasOwn(stubs, specifier)) return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
  return nextResolve(specifier, context);
}
