# maxclaude-web agent protocol, version 1


`mcw-agent` is the AGENT. `maxclaude-web` is the HUB. The agent always dials out. The hub
never connects to session-host and session-host opens no inbound port. One WebSocket
carries everything: control RPC, proxied HTTP, and proxied WebSockets.

This document is the stable interface. Both halves are written against it. Any change that
is not additive bumps `v`.

## 1. Transport

The agent opens a WebSocket to `MCW_HUB_URL`, default `wss://your-host.example.com/agent`.

- The hub accepts at most one authenticated agent. A second one is closed with 4409.
- The agent reconnects forever with exponential backoff, 1s doubling to 60s, full jitter.
- Either side may send WebSocket ping frames. Application-level `ping`/`pong` is also defined
  below because intermediaries strip control frames.
- Max WebSocket message size is 4 MiB in both directions. Larger payloads must be chunked.

Two kinds of WebSocket message are used on this link.

- **Text frames** carry one JSON object each. This is the control channel.
- **Binary frames** carry multiplexed stream data with a 6 byte header. This is the data
  channel for proxied HTTP bodies and proxied WebSocket payloads.

## 2. Binary framing

Every binary frame is:

```
byte  0      kind
bytes 1..4   channel id, uint32 big endian
byte  5      flags
bytes 6..    payload
```

`kind` values:

| kind | meaning |
| --- | --- |
| `0x01` | `ws.data`, payload belongs to the proxied WebSocket channel `id` |
| `0x02` | `http.body`, payload is a body chunk of the HTTP exchange `id` |
| `0x03` | `file.upload`, payload is an upload chunk from the hub to the agent |
| `0x04` | `file.download`, payload is a download chunk from the agent to the hub |

`flags` for `kind 0x01`:

| bit | meaning |
| --- | --- |
| `0x01` | the payload was a WebSocket text frame |
| `0x02` | the payload was a WebSocket binary frame |

Exactly one of those two bits is set. The receiving side re-emits the payload with the same
opcode, so a terminal stream stays byte exact.

`flags` for `kind 0x02`:

| bit | meaning |
| --- | --- |
| `0x01` | final chunk of this body, the payload may be empty |

A body with no bytes is one frame with an empty payload and the final bit set.

Kinds `0x03` and `0x04` also use bit `0x01` as the final-chunk flag. File channels allow
one unacknowledged chunk at a time. This gives disk-to-browser backpressure across the
WebSocket instead of buffering a complete file at either endpoint.

Channel ids are uint32, allocated by the hub, monotonically increasing, wrapping to 1 after
0xFFFFFFFF. Zero is never a channel id. HTTP exchange ids and WebSocket channel ids live in
separate spaces and are told apart by `kind`. An id is reusable only after both sides have
seen its terminal message.

## 3. Message envelope

Every text frame is a JSON object with a `t` field naming the type.

```json
{"t": "req", "id": "r-17", "method": "sessions.list", "params": {}}
```

Unknown `t` values are ignored by the receiver, which allows additive changes. A malformed
JSON text frame is a protocol error and the receiver closes with 4400.

## 4. Auth handshake

The shared secret never crosses the wire. The agent proves possession with an HMAC over a
hub-chosen nonce.

1. On accept, the hub sends immediately:

```json
{"t": "hello", "v": 1, "nonce": "3f2a...64 hex chars...", "server": "maxclaude-web/1.0.0"}
```

2. The agent answers within 10 seconds:

```json
{"t": "auth", "v": 1, "agent": "session-host", "ts": 1758124800,
 "proof": "9c1b...64 hex chars...", "agentVersion": "mcw-agent/1.0.0"}
```

`proof` is lowercase hex of `HMAC-SHA256(key = secret bytes, message = nonce ASCII bytes)`.
The secret is the exact bytes of the secret file with trailing whitespace stripped. `ts` is
unix seconds and is informational only.

3. The hub compares in constant time and answers one of:

```json
{"t": "auth.ok", "conn": "c-8e2f", "serverTime": 1758124800}
```

```json
{"t": "auth.err", "error": {"code": "unauthorized", "message": "bad proof"}}
```

After `auth.err` the hub closes with 4401. After a handshake timeout it closes with 4408. If
`v` is not 1 the hub answers `auth.err` with code `unsupported` and closes with 4400.

4. Immediately after `auth.ok` the agent sends one event so the hub has state without asking:

```json
{"t": "event", "event": "agent.ready", "data": { ...the agent.info result... }}
```

No other message type is valid before `auth.ok`. Anything else closes the link with 4400.

Close codes:

| code | meaning |
| --- | --- |
| 4400 | protocol error |
| 4401 | unauthorized |
| 4408 | handshake timeout |
| 4409 | another agent is already connected |

## 5. Keepalive

Either side may send:

```json
{"t": "ping", "id": "p-3"}
```

The peer answers with the same id:

```json
{"t": "pong", "id": "p-3"}
```

The hub pings every 20 seconds. The agent drops the link and reconnects after 60 seconds
with no inbound message of any kind.

## 6. Control RPC

The hub calls, the agent answers. The agent never calls an RPC on the hub, it only sends
`event`.

Request:

```json
{"t": "req", "id": "r-17", "method": "sessions.create", "params": {"name": "demo", "panes": 1}}
```

Response, success:

```json
{"t": "res", "id": "r-17", "ok": true, "result": {"name": "demo"}}
```

Response, failure:

```json
{"t": "res", "id": "r-17", "ok": false,
 "error": {"code": "conflict", "message": "session demo already exists", "detail": {"name": "demo"}}}
```

`id` is a hub-allocated string, unique for the life of the connection. Every `req` gets
exactly one `res`. The agent answers within 60 seconds or returns `timeout` itself. If the
link drops with requests in flight the hub must treat them as failed, no response is
replayed after a reconnect.

### 6.1 Error shape

```json
{"code": "bad_request", "message": "human readable, one line", "detail": {}}
```

`detail` is optional and free form. `code` is one of:

| code | meaning |
| --- | --- |
| `bad_request` | params failed validation |
| `not_found` | named session, transcript or path does not exist |
| `conflict` | the name is already taken or the state forbids the change |
| `unauthorized` | the zellij web token was rejected and could not be renewed |
| `upstream_unavailable` | `zellij web` or the zellij server is not answering |
| `timeout` | the agent gave up waiting on a local command |
| `internal` | anything else, `detail.stderr` carries the real output |
| `unsupported` | unknown method or protocol version |

The agent never invents a result. When a local command fails, its exact stderr goes into
`detail.stderr` and the code is `internal`.

### 6.2 `agent.info`

Params: none.

```json
{"host": "session-host", "agentVersion": "mcw-agent/1.0.0", "zellijVersion": "zellij 0.44.3",
 "webServer": {"running": true, "url": "http://127.0.0.1:8082", "status": "Web server online with version: 0.44.3"},
 "webSharing": "on", "tokenName": "token_1", "startedAt": 1758124800}
```

`webSharing` is the value read back from `/home/user/.config/zellij/config.kdl`. A session created
while it is not `"on"` cannot be attached from a browser.

### 6.3 `sessions.list`

Params: none. Parses `zellij list-sessions`, ANSI stripped.

```json
{"sessions": [
  {"name": "project-one", "created": "Created 3days 12m 12s ago", "createdAt": 1758124800000,
   "exited": false, "current": false, "activity": "idle", "activityUpdatedAt": 1758124800000,
   "lastResponseAt": 1758124700000, "lastActivityAt": 1758124800000},
  {"name": "old-thing", "created": "Created 6days 1h 2s ago", "createdAt": 1757865600000,
   "exited": true, "current": false, "activity": "absent", "activityUpdatedAt": 0,
   "lastResponseAt": 0, "lastActivityAt": 0}
]}
```

`created` is the raw zellij text. `createdAt` is the agent's millisecond timestamp derived
from that age. `exited` is true when zellij marked the line EXITED. Order is the order
zellij printed.

`activity` is `busy`, `background`, `idle`, `absent`, or `unknown`. Busy means at least one
live Claude pane has a busy hook state. Background means the foreground turn is idle while
Claude reports an in-flight background task or a live process carries that pane's
`CLAUDE_CODE_SESSION_ID` on its live Bash task wrapper. Idle means a live Claude process exists with no foreground or
background work. Absent means no Claude process exists in the session. Unknown means a live
process has not yet written a valid hook state, or zellij did not list the session's panes in
time and no earlier list for that server exists. A session zellij is slow to answer for keeps
the panes last listed for its server. The agent reads real process environments
and hook files. It never infers activity from the zellij session alone.

`lastResponseAt` is the millisecond time of the latest Claude `Stop` hook for the session.
When no Stop record exists, the agent reads the timestamp of the final assistant entry in
the current transcript JSONL. The agent finds the current transcript from hook input,
Claude's process arguments, or its matching session environment directory.

`lastActivityAt` is the latest per-session hook time, live background task event, or latest
user or assistant message timestamp in the current transcript. The tracked hook events are
UserPromptSubmit, PreToolUse, PostToolUse, Stop, and Notification. A transcript used by more
than one live zellij session does not contribute to either session. Their per-session hook
times remain authoritative.

### 6.4 `sessions.create`

```json
{"name": "demo", "panes": 1, "workdir": "/home/user/projects",
 "resumeSid": "4f727bc5-b3bb-4551-97c2-03555cd90986", "org": null,
 "settings": null, "appendPrompt": null, "extraArgs": null}
```

| param | rule |
| --- | --- |
| `name` | required, matches `^[A-Za-z0-9._-]{1,64}$`, and is neither `.` nor `..` |
| `panes` | optional integer 1 to 4, default 1 |
| `workdir` | optional absolute path; an empty value uses the agent's configured default, which must exist |
| `resumeSid` | optional, matches `^[0-9a-fA-F-]{36}$`, the transcript must exist on disk |
| `org` | optional string, written as `MAXCLAUDE_ORG` |
| `settings`, `appendPrompt`, `extraArgs` | optional strings, written verbatim to the env file |

The agent performs exactly the maxclaude creation sequence and nothing else:

1. Verify `/home/user/.claude/projects/-home-user-projects/<resumeSid>.jsonl` exists when `resumeSid` is
   given. If it does not, fail with `not_found` and write nothing.
2. Write `/home/user/.config/maxclaude/sessions/<name>.env`, one `KEY=VALUE` per line.
3. Write `/home/user/.config/maxclaude/<name>.panes` containing the pane count.
4. `loginctl enable-linger root`.
5. `systemctl --user start maxclaude-named@$(systemd-escape <name>).service`.
6. Poll `zellij list-sessions` until the name appears live, up to 20 seconds.

A name that is already live fails with `conflict` and nothing is written. A name that exists
only as an EXITED session is allowed, zellij resurrects it.

```json
{"name": "demo", "panes": 1, "workdir": "/home/user/projects", "resumeSid": "4f72...",
 "unit": "maxclaude-named@demo.service", "envFile": "/home/user/.config/maxclaude/sessions/demo.env"}
```

### 6.5 `sessions.rename`

```json
{"oldName": "demo", "newName": "renamed-demo"}
```

Both names follow the `sessions.create` name rule. The old session must be live. The new
name must not exist as a zellij session or as a maxclaude env or panes file.

The agent performs these steps against the real running session:

1. Send `/rename <newName>` through zellij input to every Claude pane and wait for Claude
   Code to report the new session name.
2. Run `zellij -s <oldName> action rename-session <newName>`.
3. Rename the maxclaude env and panes files when they exist.
4. Stop the old escaped systemd unit, start the new escaped unit, and verify it is active.
5. Verify zellij lists the new name and no longer lists the old name.

The operation rolls the Claude name, zellij name, files, and unit mapping back when a later
step fails. The response includes the systemd units and the Claude output used as proof.

```json
{"oldName": "demo", "newName": "renamed-demo", "renamed": true,
 "oldUnit": "maxclaude-named@demo.service",
 "newUnit": "maxclaude-named@renamed\\x2ddemo.service",
 "claudeReports": ["Session renamed to renamed-demo"]}
```

### 6.6 `sessions.delete`

```json
{"name": "demo"}
```

1. `systemctl --user stop maxclaude-named@$(systemd-escape <name>).service`.
2. `zellij delete-session --force <name>`.
3. Confirm the name is gone from `zellij list-sessions`.
4. Remove `/home/user/.config/maxclaude/sessions/<name>.env`.
5. Remove `/home/user/.config/maxclaude/<name>.panes`.
6. Remove `/home/user/.config/maxclaude-web/session-status/<name>/`.

Result `{"name": "demo", "deleted": true}`. A name that is not listed at all still returns
`deleted: true`, delete is idempotent. Failure to actually remove a listed session is
`internal` with the command output in `detail`.

Delete is permanent. No maxclaude restore or activity state remains for that name.

### 6.7 `transcripts.list`

```json
{"limit": 100}
```

Enumerates `/home/user/.claude/projects/-home-user-projects/*.jsonl`, newest mtime first, default limit
100, maximum 500.

```json
{"transcripts": [
  {"uuid": "4f727bc5-b3bb-4551-97c2-03555cd90986",
   "title": "So I'm trying to find an AI harness that solves the following problems.",
   "mtime": 1758124800, "size": 48213121}
]}
```

`title` is the transcript summary line when the file has one, otherwise the first real user
message truncated to 200 characters, otherwise the uuid. Slash commands, command stdout and
caveat blocks are skipped when picking it. `mtime` is unix seconds.

### 6.8 `files.stat`

```json
{"session":"demo","paths":["/home/user/report.txt","/home/user/missing.txt"]}
```

The session must be live. `paths` contains 1 to 64 absolute paths. The agent caches each
filesystem check for five seconds and returns existence, type, file size, and modification
time. The browser uses this call from its xterm link provider, so nonexistent paths never
become links.

```json
{"paths":[
  {"path":"/home/user/report.txt","exists":true,"type":"file","size":41,"mtime":1758124800000},
  {"path":"/home/user/missing.txt","exists":false,"type":null,"size":null,"mtime":null}
]}
```

## 7. Proxied HTTP

The hub forwards a browser request to `http://127.0.0.1:8082` through the agent. The agent is
path agnostic. It sends `path` verbatim to the zellij web server, so the hub strips its own
prefix before asking.

Hub to agent:

```json
{"t": "http.req", "id": 41, "method": "GET", "path": "/assets/index.js",
 "headers": {"accept": "*/*"}, "hasBody": false}
```

If `hasBody` is true the hub follows with `kind 0x02` binary frames on id 41 until one has
the final bit set.

Agent to hub:

```json
{"t": "http.res", "id": 41, "status": 200,
 "headers": {"content-type": "text/javascript"}}
```

then `kind 0x02` binary body frames on id 41, the last one with the final bit set.

```json
{"t": "http.cancel", "id": 41}
```

may be sent by either side. The agent aborts the upstream request. No further frames for
that id are valid.

An upstream failure before any `http.res` is reported as:

```json
{"t": "http.err", "id": 41, "error": {"code": "upstream_unavailable", "message": "ECONNREFUSED 127.0.0.1:8082"}}
```

Header rules, enforced by the agent:

- The agent strips `cookie`, `authorization`, `host`, `connection`, `upgrade`,
  `keep-alive`, `proxy-authorization`, `proxy-connection`, `transfer-encoding`, `te`,
  `trailer`, `content-length` and `upgrade-insecure-requests` from the request. It sets
  `content-length` itself from the body the hub sent.
- The agent injects `Cookie: session_token=<zellij session cookie>` and `Host: 127.0.0.1:8082`.
- The agent strips `set-cookie` and `transfer-encoding` from the response, so the zellij
  session cookie and the zellij token never reach the browser.
- On a 401 or 403 the agent logs in again with the stored zellij token and retries the
  request once before answering.

## 8. Proxied WebSocket

Hub to agent:

```json
{"t": "ws.open", "id": 7, "path": "/ws/terminal/demo?web_client_id=1f3c...",
 "protocols": [], "headers": {}}
```

The agent opens `ws://127.0.0.1:8082<path>` with the zellij session cookie injected and the
same header rules as section 7.

```json
{"t": "ws.opened", "id": 7, "protocol": null}
```

```json
{"t": "ws.err", "id": 7, "error": {"code": "upstream_unavailable", "message": "..."}}
```

After `ws.opened`, payloads flow in both directions as `kind 0x01` binary frames on id 7.
Nothing is transformed. The bytes zellij writes are the bytes the browser receives.

Either side closes with:

```json
{"t": "ws.close", "id": 7, "code": 1000, "reason": ""}
```

The receiver closes its end and answers with its own `ws.close` for that id. A `ws.close`
for an unknown id is ignored. When the tunnel drops, every open channel is closed locally on
both sides.

A zellij session that did not opt into web sharing still opens the socket and then sends
`Web Clients are not allowed to attach to this session.` before closing. That passes through
unchanged. The agent does not interpret it and the hub shows it as-is.

## 9. Events

Agent to hub, no response:

```json
{"t": "event", "event": "agent.ready", "data": {}}
```

| event | data | when |
| --- | --- | --- |
| `agent.ready` | the `agent.info` result | right after `auth.ok` |
| `agent.degraded` | `{"reason": "...", "detail": {}}` | `zellij web` died and could not be restarted |
| `sessions.status` | `{"sessions":{"name":{"state":"busy","updatedAt":1758124800000}}}` | activity changed, and once after each reconnect |
| `usage` | `{"updatedAt":1758124800000,"meters":[{"key":"claude-5h","label":"5h","title":"Claude 5-hour","percent":36,"resetsAt":1758130000000,"available":true,"stale":false,"fetchedAt":1758124800000,"error":null}]}` | after each usage refresh, and once after each reconnect |

`usage` has one meter per window: `claude-week`, `claude-5h`, `model-<name>` for each model in
`MCW_USAGE_MODELS`, and `codex-week`. `percent` and `resetsAt` are null when the window is not
`available`, and `error` says why. `stale` is true when the values come from an earlier answer
because the latest fetch failed.

Events are advisory. The hub must still poll `sessions.list` for truth.

## 10. Zellij credentials, agent side only

Held under `/home/user/.config/maxclaude-web/`, mode 0600, never sent over the link.

| file | content |
| --- | --- |
| `tunnel.secret` | the shared secret for section 4 |
| `zellij-token.json` | `{"name": "token_1", "token": "<uuid>", "createdAt": 0}` |

The agent mints the zellij token once with `zellij web --create-token` and logs in with
`POST /command/login {"auth_token": "<uuid>", "remember_me": true}`, keeping the returned
`session_token` cookie in memory. That cookie is what section 7 and section 8 inject.

## 11. Claude activity hook files

Claude Code hooks call `/home/user/.local/bin/mcw-session-status` with `busy` for
`UserPromptSubmit`, `PreToolUse`, and `PostToolUse`, and with `idle` for `Stop` and `Notification`.
The Stop hook passes a second `stop` argument.
The command always exits successfully so status reporting cannot fail a Claude turn.

Each pane writes one atomic JSON record below:

```text
/home/user/.config/maxclaude-web/session-status/<zellij-session>/<pane-id>.json
/home/user/.config/maxclaude-web/session-status/<zellij-session>/<pane-id>.response.json
/home/user/.config/maxclaude-web/session-status/<zellij-session>/<pane-id>.background.json
```

The agent scans real Claude processes under `/proc`, reads `ZELLIJ_SESSION_NAME` and
`ZELLIJ_PANE_ID`, ignores hook records older than the live process, and aggregates every
pane. One busy pane makes the whole session busy.
The response record stores the Stop time separately so later idle and busy events cannot
overwrite it. The status record also stores the transcript path supplied by Claude.
The agent uses every status record time as session activity, including prompt submission,
tool work, Stop, and Notification. A unique transcript can advance activity to its latest
user or assistant message. Shared transcripts cannot advance either session.

Claude Code 2.1.284 includes an exact `background_tasks` array in every Stop hook input.
The background record stores only its count, timestamp, and transcript path. It can establish
when background work started, but it never proves that work remains live. Background state
requires a live Bash task wrapper that descends from the session's current Claude process,
matches its zellij session and pane, and carries the matching `CLAUDE_CODE_SESSION_ID`.
The background activity time is the latest real task start, Stop snapshot, or regular output
file modification time. Process exit clears background state without waiting for another hook.

## 12. File transfer streams

Only authenticated browser API routes can start a transfer. The public agent hostname still
accepts only the exact `/agent` WebSocket path and never serves file content.

### 12.1 Upload

The hub opens a channel:

```json
{"t":"file.upload.open","id":9,"session":"demo","batch":"4fc1a9d0","path":"folder/photo.png","size":1234}
```

cannot terminate a slow large upload. Each request adds `uploadId`, `totalSize`, `offset`,
and `final` to `file.upload.open`. The agent keeps one temporary file open between those
requests and accepts only the exact next offset. The final request fsyncs and renames it.
The per-request tunnel channel still uses the acknowledgement flow below.

The agent validates the live session, rejects absolute paths, backslashes, empty components,
`.` and `..`, and rejects a declared size above 2 GB. It creates one batch directory below
`/home/user/session-files/<session>/in/<timestamp>/` and answers:

```json
{"t":"file.upload.ready","id":9,"path":"/home/user/session-files/demo/in/20260924T220000000Z/folder/photo.png","batchRoot":"/home/user/session-files/demo/in/20260924T220000000Z"}
```

The hub sends one kind `0x03` chunk. The agent writes it before sending
`{"t":"file.upload.ack","id":9}`. The hub sends the next chunk only after that ack. A final
frame closes and atomically renames the temporary file. Success is:

```json
{"t":"file.upload.done","id":9,"path":"/home/user/session-files/demo/in/20260924T220000000Z/folder/photo.png","batchRoot":"/home/user/session-files/demo/in/20260924T220000000Z","size":1234}
```

Either side cancels with `file.upload.cancel`. Failures use `file.upload.error` and the normal
wire error shape. The agent removes every partial file.

### 12.2 Download

The hub opens a channel with a live session name and an absolute path:

```json
{"t":"file.download.open","id":10,"session":"demo","path":"/home/user/report.txt"}
```

The agent checks the path and answers with `file.download.ready`. A directory is streamed
as a zip file. A regular file is streamed directly. The agent sends one kind `0x04` chunk
and waits for `file.download.ack`. The hub sends that ack only after the browser response
accepts the bytes or drains. The final frame is also acknowledged. Either side can send
`file.download.cancel`.

Both agent and hub log every completed transfer with session, absolute path, byte count, and
direction. The hub persists the same fields for the session Files drawer.
