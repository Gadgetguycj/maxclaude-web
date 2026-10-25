#!/usr/bin/env python3
"""Atomic, evidence-only Claude hook journal writer."""
import fcntl, hashlib, json, os, pathlib, sys, tempfile, time
VALID={"UserPromptSubmit","PreToolUse","PostToolUse","Stop","Notification","Interrupt"}; LIMIT=262144; KEEP=131072
def raw(p):
 try:
  with open(p,"rb") as f:return f.read()
 except OSError:return b""
def load(p,d):
 try:
  with open(p) as f:return json.load(f)
 except (OSError,ValueError,TypeError):return d
def atomic(p,v):
 fd,t=tempfile.mkstemp(prefix=".",dir=os.path.dirname(p))
 try:
  with os.fdopen(fd,"w") as f: json.dump(v,f,separators=(",",":"));f.write("\n")
  os.replace(t,p)
 except BaseException:
  try:os.unlink(t)
  except OSError:pass
  raise
def ticks(root,pid):
 try:
  s=pathlib.Path(root,str(pid),"stat").read_text();n=int(s[s.rfind(")")+2:].split()[19]);return n if n>0 else 0
 except (OSError,ValueError,IndexError):return 0
def parent(root,pid):
 try:
  for line in pathlib.Path(root,str(pid),"status").read_text().splitlines():
   if line.startswith("PPid:"):return int(line.split()[1])
 except (OSError,ValueError,IndexError):pass
 return 0
def argv(root,pid):return raw(pathlib.Path(root,str(pid),"cmdline")).split(b"\0")
def owner(root):
 p=os.getppid()
 for _ in range(8):
  a=argv(root,p)
  if a and os.path.basename(a[0]) in (b"claude",b"claude.exe"):return p
  p=parent(root,p)
  if p<=1:break
 return os.getppid()
def live(root,pid,born):
 proc=pathlib.Path(root,str(pid))
 if not proc.exists():return False
 if not os.access(proc/"stat",os.R_OK):return None
 value=ticks(root,pid);return value==born if value else None
def compact(events):
 groups={}
 for e in events:
  if isinstance(e,dict) and isinstance(e.get("pid"),int) and isinstance(e.get("pidStartTicks"),int):groups.setdefault((e["pid"],e["pidStartTicks"]),[]).append(e)
 out=[]
 for rows in groups.values():
  rows.sort(key=lambda e:e.get("sequence",0));prompt=max((e for e in rows if e.get("eventName")=="UserPromptSubmit"),key=lambda e:e.get("sequence",0),default=None);floor=prompt.get("sequence",0) if prompt else 0;cur=[e for e in rows if e.get("sequence",0)>=floor]
  done={e.get("toolUseId") for e in cur if e.get("eventName")=="PostToolUse" and e.get("toolUseId")};pre={}
  for e in cur:
   if e.get("eventName")=="PreToolUse" and e.get("toolUseId") not in done:pre[e.get("toolUseId")]=e
  term=max((e for e in cur if e.get("eventName") in {"Stop","Notification","Interrupt"}),key=lambda e:e.get("sequence",0),default=None)
  if prompt:out.append(prompt)
  out.extend(e for e in cur if e.get("eventName")=="PostToolUse");out.extend(pre.values())
  if term:out.append(term)
 return out
def descendants(root,pid):
 queue=[pid];seen=set();out=[]
 while queue and len(seen)<128:
  p=queue.pop(0)
  if p in seen:continue
  seen.add(p)
  try:kids=[int(x) for x in pathlib.Path(root,str(p),"task",str(p),"children").read_text().split()]
  except (OSError,ValueError):kids=[]
  queue.extend(kids)
  for child in kids:
   if b"/.claude/shell-snapshots/" in b" ".join(argv(root,child)):
    born=ticks(root,child)
    if born:out.append({"pid":child,"startTicks":born})
 return out
def main():
 state=sys.argv[1]; stop=sys.argv[2] if len(sys.argv)>2 else "";session=os.getenv("ZELLIJ_SESSION_NAME","");pane=os.getenv("ZELLIJ_PANE_ID","")
 if not session or session in (".","..") or not all(c.isalnum() or c in "._-" for c in session) or not pane.isdigit():return
 root=os.getenv("MCW_PROC_ROOT","/proc");base=os.path.join(os.getenv("MCW_STATE_DIR",os.path.join(os.path.expanduser("~"),".config","maxclaude-web")),"session-status",session);os.makedirs(base,mode=0o700,exist_ok=True);prefix=os.path.join(base,pane)
 try:payload=json.loads(sys.stdin.read() or "{}")
 except ValueError:payload={}
 pid=owner(root);born=ticks(root,pid);now=int(time.time()*1000)
 try:boot=int(float(pathlib.Path(root,"uptime").read_text().split()[0])*os.sysconf("SC_CLK_TCK"))
 except (OSError,ValueError):boot=0
 event="Interrupt" if state=="interrupt" else payload.get("hook_event_name","");event=event if event in VALID else ""
 transcript=payload.get("transcript_path","");transcript=transcript if isinstance(transcript,str) and transcript.startswith(os.path.join(os.getenv("CLAUDE_CONFIG_DIR",os.path.join(os.path.expanduser("~"),".claude")),"projects")+os.sep) and transcript.endswith(".jsonl") else ""
 if event and born:
  with open(prefix+".events.lock","a+") as lock:
   fcntl.flock(lock,fcntl.LOCK_EX);checkpoint=load(prefix+".events.state.json",{"version":1,"sequence":0,"events":[]});prior=checkpoint.get("events",[]) if isinstance(checkpoint,dict) else [];prior=[e for e in prior if live(root,e.get("pid",0),e.get("pidStartTicks",0)) is not False]
   seq=[checkpoint.get("sequence",0),load(prefix+".events.sequence",0)]
   for line in raw(prefix+".events.jsonl").splitlines():
    try:seq.append(json.loads(line).get("sequence",0))
    except (ValueError,TypeError):pass
   sequence=max(x for x in seq if isinstance(x,int))+1;tool=payload.get("tool_use_id") or (payload.get("tool_use") or {}).get("id") or "";name=payload.get("tool_name") or "";command=(payload.get("tool_input") or {}).get("command");digest=hashlib.sha256(command.encode()).hexdigest() if name=="Bash" and isinstance(command,str) else ""
   seen={e.get("toolUseId") for e in prior if e.get("pid")==pid and e.get("pidStartTicks")==born and e.get("eventName") in {"PreToolUse","PostToolUse"}};record={"eventName":event,"sequence":sequence,"updatedAt":now,"pid":pid,"pidStartTicks":born,"accepted":not(event=="PreToolUse" and tool and tool in seen)}
   if boot:record["bootTicks"]=boot
   if tool:record["toolUseId"]=tool
   if name:record["toolName"]=name
   if digest:record["toolCommandHash"]=digest
   if transcript:record["transcriptPath"]=transcript
   with open(prefix+".events.jsonl","a") as f:f.write(json.dumps(record,separators=(",",":"))+"\n")
   if event=="UserPromptSubmit":prior=[e for e in prior if not(e.get("pid")==pid and e.get("pidStartTicks")==born)]
   elif event=="PostToolUse":prior=[e for e in prior if not(e.get("pid")==pid and e.get("pidStartTicks")==born and e.get("eventName")=="PreToolUse" and e.get("toolUseId")==tool)]
   prior.append(record);atomic(prefix+".events.state.json",{"version":1,"sequence":sequence,"events":compact(prior)});atomic(prefix+".events.sequence",sequence)
   ledger=prefix+".events.jsonl"
   if os.path.getsize(ledger)>LIMIT:
    tail=raw(ledger)[-KEEP:];cut=tail.find(b"\n");open(ledger,"wb").write(tail[cut+1:] if cut>=0 else b"")
 rawstate={"state":state,"updatedAt":now,"pid":pid,"pidStartTicks":born}
 if event:rawstate["eventName"]=event
 if transcript:rawstate["transcriptPath"]=transcript
 atomic(prefix+".json",rawstate)
 if stop=="stop":
  response={"lastResponseAt":now,"pid":pid,"pidStartTicks":born};
  if transcript:response["transcriptPath"]=transcript
  atomic(prefix+".response.json",response);atomic(prefix+".background.json",{"updatedAt":now,"transcriptPath":transcript,"candidates":descendants(root,pid) if payload.get("background_tasks") else []})
if __name__=="__main__":main()
