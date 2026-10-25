# Zellij client id race

Zellij 0.44.3 can drop a request from a client to a live session when another
client connects to the same session server at about the same moment. The
dropped client sees either a "not found" reply for a session that is running,
or an empty reply with exit status 0. The same code is in 0.45.1.

This note records the mechanism and the reproduction so it can be reported
upstream if the operator approves. Nothing has been filed.

## Mechanism

Line numbers are for the v0.44.3 tag.

1. `zellij -s NAME action ...` resolves NAME by listing the socket directory
   and sending a `ConnStatus` probe to every session server. A session counts
   only if its server answers `Connected` (`zellij-utils/src/sessions.rs`
   `get_sessions` line 17, `assert_socket` line 146). The command does this
   twice, once in `get_active_session` and once more before it attaches
   (`src/commands.rs` `send_action_to_session` line 407).
2. The server gives every accepted connection the lowest client id that is
   not in use (`zellij-server/src/lib.rs` `new_client` line 589, called at
   line 902).
3. For a `ConnStatus` probe, the router thread queues
   `ServerInstruction::ConnStatus(id)` and leaves its loop
   (`zellij-server/src/route.rs` line 2544). On the way out it queues
   `ServerInstruction::RemoveClient(id)` as well (line 2663).
4. The main loop handles `ConnStatus(id)` by sending `Connected` and removing
   the client at once, which frees the id (`lib.rs` line 1573).
5. A connection accepted between steps 4 and the stale `RemoveClient(id)` is
   given the freed id. The stale instruction then removes the new client.
   If the new client was a probe, it never gets `Connected` and the CLI
   prints "Session 'NAME' not found" with NAME in the list of active
   sessions. If it was the CLI client carrying the action, its reply has no
   receiver and the CLI prints nothing.

A likely upstream fix is to remove the client in only one of the two places,
or to stop reusing client ids while a removal for them is still queued.

## Reproduction

All runs used a separate socket directory (`ZELLIJ_SOCKET_DIR`) and cache
directory (`XDG_CACHE_HOME`), six static sessions, and
`zellij -s NAME action list-panes --json` as the request.

| Run | Directory churn during the run | Parallel requests | Failed replies |
|---|---|---|---|
| 1 | none | 8 | 7 of 600 (4 not found, 3 empty) |
| 2 | none | 1 | 0 of 300 |
| 3 | about 350,000 dummy socket create, rename and delete cycles | 1 | 0 of 300 |
| 4 | 45 real zellij create, rename and delete cycles | 1 | 0 of 300 |

Concurrent requests are enough to trigger it. Directory changes alone are not.
In run 1 one reply read "Session 'mcw-test-iso-s4' not found" while listing
mcw-test-iso-s4 as active, which matches the production failures.

## A second hazard: any client during startup

A new server panics when any client disconnects before the first real client
has set up the session. The `RemoveClient` handler unwraps session data that
does not exist yet (`zellij-server/src/lib.rs` line 1403, "called
`Option::unwrap()` on a `None` value"). A `ConnStatus` probe from
`zellij list-sessions` or `-s NAME` reaches the same handler, and so does a
bare connect such as the `SO_PEERCRED` check the poller used to make. The
client that was creating the session then waits forever.

In the isolated directory this happened twice: once when a harness polled a
new socket with bare connects every 5 ms, and once with no harness connects,
while the poll loop was running. No production case is known. The poller no
longer connects to any socket, as the next section describes.

## The poller reads socket owners from the kernel

The poller used to find each socket's server by connecting and reading
`SO_PEERCRED`. Each bare connect makes zellij 0.44.3 read the closed
connection as more than 1000 unknown messages and log two errors,
"Received unknown message from client" and "Client sent over 1000
consecutive unknown messages". A burst of 100 connects to one isolated idle
server also logged 378 "failed to send message to client" errors and used
1.48 s of server CPU.

The helper now reads the same answer from the kernel. The `sock_diag` table,
which `ss -xl` reads, maps the device and inode of each listening socket file
to its socket inode. A rename keeps the file inode. The process that holds
that socket inode in `/proc/<pid>/fd` is the server. A socket file whose
inode has no listener belongs to a server that is gone, so the session is
left out. A child the server forks holds the socket until it calls exec, so
the holder whose parent does not also hold it is the server. If no single
holder remains while the listener still exists, the poll fails.

## Production impact and the poller change

The agent's `mcw-zellij-peers` helper queried eight sessions at once, and
every query probes every session server twice. Six status polls failed this
way between 2026-10-04 and 2026-10-06, each on a session that stayed alive.

The helper now queries one session at a time, so it no longer collides with
itself. The agent used to run it with `execFileSync`, which froze the agent,
terminal traffic included, for the whole run. It now awaits the helper, so a
slower serial run only delays a status light.

A bad reply or a query that hangs past 3 s triggers a check of the session's
socket, read from the kernel as above. If the socket file is gone or has no
listener, the session has closed and is left out. If the same server still owns it, a bad reply is retried
after 0.25 s, 0.5 s and 1 s. A query that hangs, or a session whose every
attempt fails, is reported with `"panes": null` and an `"unknown"` reason, and
the helper goes on to the next session. A live session is never reported
absent, and one slow session no longer fails the whole run.

Every command resolves its session by asking every session server first, so one
slow server slows every query. The helper therefore has a time budget, 9 s by
default with `--budget`. No query starts once it could end after the budget, so
the run ends before the agent's 12 s limit. Sessions are asked in a random order,
so the same sessions are not left out each time. The agent gives an unknown
session the panes it last read from the same server, and falls back to the whole
last inventory when a run fails.
